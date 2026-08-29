/**
 * fold.js — The integral fold
 *
 * State is never stored. It is always derived by folding the event stream.
 *
 *   state(t) = fold(dispatch, initial, events[0..t])
 *
 * The fold is a nine-case dispatch. Each event carries its operator type.
 * The fold applies each event to the accumulator and produces the current
 * state at any cursor position.
 *
 * Dependency ordering gives the fold three properties:
 *
 * 1. Helix high-water mark (_hwm) per entity — the highest operator
 *    order that has fired. The dispatcher uses this to detect violations
 *    structurally (EVA without prior DEF = criterionless judgment) without
 *    replaying the log.
 *
 * 2. Short-circuit potential — an entity at _hwm=2 (INS only) cannot
 *    have EVA or REC results. Queries skip what the helix says isn't there.
 *
 * 3. Concurrency map — entities with no CON between them have disjoint
 *    causal chains. Partition by anchor, fold in parallel, synchronize
 *    only at CON boundaries. The _hwm metadata enables this.
 *
 * The fold is permissive: it processes whatever the log contains.
 * Violations are flagged in state._violations, never blocked.
 * The linter diagnoses; the fold records.
 */

import { parseEventType, OP } from './operators.js';

/**
 * @typedef {Object} FoldState
 * @property {Object<string, Entity>} entities      - Anchor → entity
 * @property {Object<string, string>} partitions    - Anchor → partition name
 * @property {Array<Connection>}      connections   - Typed links between anchors
 * @property {Array<Frame>}           frames        - REC events (paradigm shifts)
 * @property {Object}                 schema        - DEF events targeting _schema.* paths
 * @property {number}                 cursor        - Timestamp of last processed event
 * @property {number}                 _undecryptable - Events still encrypted
 * @property {Array}                  _violations    - Dependency ordering violations
 * @property {string}                 _stateHash     - Content hash of entities for change detection
 */

/**
 * Create an empty initial state.
 */
export function initial() {
  return {
    entities: {},
    partitions: {},
    connections: [],
    frames: [],
    schema: {},
    cursor: 0,
    _undecryptable: 0,
    _violations: [],
    // anchor → events that arrived before the INS that creates it. See
    // `park` below: an out-of-order write is held, not dropped.
    _orphans: new Map(),
    // event_id → already applied. "Same events in, same state out" only
    // holds if applying an event twice is the same as applying it once, and
    // the same event really does arrive twice: the live timeline and the
    // durable block chain both carry it, and a backfill page can overlap
    // what's already held. Without this, a doubled log doubles every CON
    // edge and every EVA, and a repeated INS resets an entity — dropping
    // every DEF applied to it since.
    _applied: new Set(),
    // event_id of a CON → the retraction that arrived before it. See the
    // CON case: a withdrawal can be sorted ahead of the edge it withdraws.
    _pendingRetractions: new Map(),
  };
}

// ── Helpers ──

function setPath(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Fast content hash (cyrb53) ──
// Used for state change detection and content-addressed identity.
// 53-bit hash with excellent distribution. Not crypto — speed.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export { cyrb53 };

// ── Out-of-order writes ──
//
// `origin_server_ts` is assigned by the homeserver when it RECEIVES an event,
// not when the client emitted it. A burst from one action — `INS _doc` then
// `DEF file` then `DEF uploaded_at` — is three separate sends, and a slow or
// retried one can be stamped seconds after a sibling that left later. Sorting
// by timestamp then puts a DEF ahead of the very INS that creates its entity.
//
// Dropping that DEF is not an option: for a drive document it is the media
// reference, so the file becomes permanently unreadable while its bytes sit
// safely on the media store. So a write against an entity that doesn't exist
// YET is parked under its anchor and replayed the moment the INS lands, in
// arrival order. The violation is still recorded — the log really was
// malformed — but tagged `_recovered` once the entity turns up, so the linter
// can tell "arrived out of order" from "never had an INS at all".

function stampRetraction(connection, ts, sender, eventId) {
  connection._retracted = ts;
  connection._retractedBy = sender;
  connection._retractedEventId = eventId;
}

function park(state, anchor, event, violation) {
  if (!state._orphans) state._orphans = new Map();
  if (!state._orphans.has(anchor)) state._orphans.set(anchor, []);
  state._orphans.get(anchor).push({ event, violation });
}

function drainOrphans(state, anchor) {
  const held = state._orphans?.get(anchor);
  if (!held || !held.length) return;
  state._orphans.delete(anchor);          // delete first — no re-parking loop
  for (const { event, violation } of held) {
    if (violation) violation._recovered = true;
    // A parked event was already stamped into `_applied` on its first pass
    // (where it found no entity and was held). Clear that so the replay —
    // the pass that actually applies it — isn't swallowed as a duplicate.
    const id = typeof event?.getId === 'function' ? event.getId() : event?.event_id;
    if (id) state._applied?.delete(id);
    dispatch(state, event);
  }
}

// ── Dispatch ──

/**
 * Dispatch a single event into the accumulator.
 * Mutates state in place for performance. Returns state.
 *
 * Each operator case:
 *   1. Validates structural prerequisites
 *   2. Applies the transformation
 *   3. Updates the entity's helix high-water mark (_hwm)
 *   4. Flags dependency violations (permissive — never blocks)
 */
function dispatch(state, event) {
  const type = typeof event.getType === 'function' ? event.getType() : event.type;
  const content = typeof event.getContent === 'function' ? event.getContent() : event.content;
  const ts = typeof event.getTs === 'function' ? event.getTs() : event.origin_server_ts || 0;
  const sender = typeof event.getSender === 'function' ? event.getSender() : event.sender;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id || null;

  if (type === 'm.room.encrypted') {
    state._undecryptable++;
    return state;
  }

  if (!content || Object.keys(content).length === 0) return state;

  const op = parseEventType(type);
  if (!op) return state;

  // Exactly-once. Optimistic local events have no server id yet and are
  // reconciled by transaction id elsewhere, so they're exempt.
  if (eventId) {
    if (!state._applied) state._applied = new Set();
    if (state._applied.has(eventId)) return state;
    state._applied.add(eventId);
  }

  // Monotonic: replaying a parked event (see `park`) revisits an older
  // timestamp, and the cursor must not walk backwards when it does.
  if (ts > state.cursor) state.cursor = ts;

  switch (op) {
    case OP.INS: {
      const { anchor, entity_type, payload } = content;
      if (!anchor) break;
      const existing = state.entities[anchor];
      if (existing) {
        // Idempotent INS. The anchor is the hash of (type, payload, sender,
        // ts), so a repeat carries the same payload by construction — and
        // overwriting would discard every DEF, SEG and EVA applied since.
        // Fill in anything genuinely absent and leave the rest alone.
        for (const k of Object.keys(payload || {})) {
          if (!(k in existing)) existing[k] = payload[k];
        }
        drainOrphans(state, anchor);
        break;
      }
      state.entities[anchor] = {
        ...payload,
        _anchor: anchor,
        _type: entity_type,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.INS.order,
      };
      // Anything that arrived for this anchor before its INS now applies.
      drainOrphans(state, anchor);
      break;
    }

    case OP.SEG: {
      const { anchor, partition } = content;
      if (!anchor) break;
      const entity = state.entities[anchor];
      if (!entity) {
        // SEG before its INS — hold it for replay rather than losing the move.
        const violation = { type: 'missing_ins', op: 'SEG', anchor, _ts: ts };
        state._violations.push(violation);
        park(state, anchor, event, violation);
        break;
      }
      state.partitions[anchor] = partition;
      entity._partition = partition;
      entity._updated = ts;
      if (OP.SEG.order > entity._hwm) entity._hwm = OP.SEG.order;
      break;
    }

    case OP.CON: {
      const { source_anchor, target_anchor, relation_type, retracts } = content;

      // ── Withdrawing an edge ──
      //
      // The algebra is closed at nine operators, so there is no NOT-CON to
      // reach for, and the log is append-only, so nothing can be taken back
      // out of it. A CON carrying `retracts` is the third option: a new
      // event that names an earlier CON by event id and says the link it
      // made no longer holds. The original stays in the log and in
      // `state.connections` — that a link was once drawn is a fact about
      // the work, and a case file that quietly loses "we thought this
      // blocked that" is worth less than one that shows the correction. It
      // is stamped, not deleted, and `connectionsFor` skips it by default.
      //
      // A retraction can outrun the edge it retracts: `chronological` sorts
      // on timestamp and breaks operator ties on event_id, so two CONs in
      // the same millisecond land in server-assigned order about half the
      // time backwards. So an unmatched retraction is held and applied the
      // moment its edge shows up, the same bargain `park` makes for a DEF
      // that beats its INS.
      if (retracts) {
        const prior = state.connections.find(c => c._eventId === retracts);
        if (prior) stampRetraction(prior, ts, sender, eventId);
        else {
          if (!state._pendingRetractions) state._pendingRetractions = new Map();
          state._pendingRetractions.set(retracts, { ts, sender, eventId });
        }
        break;
      }

      // CON bridges two entities — this is the serialization boundary.
      // Flag if either endpoint doesn't exist (Cartesian product).
      const srcMissing = !state.entities[source_anchor];
      const tgtMissing = !state.entities[target_anchor];
      if (srcMissing || tgtMissing) {
        state._violations.push({
          type: 'cartesian_product', op: 'CON',
          source: source_anchor, target: target_anchor,
          missing: srcMissing && tgtMissing ? 'both' : srcMissing ? 'source' : 'target',
          _ts: ts,
        });
      }

      const connection = {
        source: source_anchor,
        target: target_anchor,
        type: relation_type,
        _ts: ts,
        _sender: sender,
        _eventId: eventId,
      };
      // A retraction that arrived first has been waiting for exactly this.
      const early = eventId && state._pendingRetractions?.get(eventId);
      if (early) {
        stampRetraction(connection, early.ts, early.sender, early.eventId);
        state._pendingRetractions.delete(eventId);
      }
      state.connections.push(connection);

      // Advance _hwm on both endpoints if they exist
      const src = state.entities[source_anchor];
      const tgt = state.entities[target_anchor];
      if (src && OP.CON.order > src._hwm) src._hwm = OP.CON.order;
      if (tgt && OP.CON.order > tgt._hwm) tgt._hwm = OP.CON.order;
      break;
    }

    case OP.SYN: {
      const { input_anchors, output } = content;
      const synAnchor = eventId ? `syn_${eventId}` : `syn_${ts}_${sender || 'anon'}`;

      // Flag missing inputs
      if (input_anchors) {
        for (const ia of input_anchors) {
          if (!state.entities[ia]) {
            state._violations.push({
              type: 'missing_ins', op: 'SYN', anchor: ia, _ts: ts,
            });
          }
        }
      }

      state.entities[synAnchor] = {
        ...output,
        _anchor: synAnchor,
        _type: '_synthesis',
        _inputs: input_anchors,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.SYN.order,
      };
      break;
    }

    case OP.DEF: {
      const { anchor, path, value } = content;

      // Schema DEF: no anchor, path starts with _schema
      if (!anchor && path?.startsWith('_schema.')) {
        setPath(state.schema, path.slice('_schema.'.length), value);
        break;
      }

      if (!anchor) break;
      const entity = state.entities[anchor];
      if (!entity) {
        // DEF before its INS — hold it. This is the one that loses data if
        // dropped: a drive document's `file` DEF is its media reference.
        const violation = { type: 'missing_ins', op: 'DEF', anchor, _ts: ts };
        state._violations.push(violation);
        park(state, anchor, event, violation);
        break;
      }
      if (path) {
        setPath(entity, path, value);
        entity._updated = ts;
        entity._updatedBy = sender;
        // Per-field write time so the grid can tint recently-changed cells.
        if (!entity._fieldTs) entity._fieldTs = {};
        entity._fieldTs[path] = ts;
      }
      if (OP.DEF.order > entity._hwm) entity._hwm = OP.DEF.order;
      break;
    }

    case OP.EVA: {
      const { anchor, criterion, result, note } = content;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({
          type: 'missing_ins', op: 'EVA', anchor, _ts: ts,
        });
        break;
      }

      // Criterionless judgment: EVA without prior DEF
      if (entity._hwm < OP.DEF.order) {
        state._violations.push({
          type: 'criterionless_judgment', op: 'EVA', anchor,
          hwm: entity._hwm, required: OP.DEF.order, _ts: ts,
        });
      }

      if (!entity._evaluations) entity._evaluations = [];
      entity._evaluations.push({ criterion, result, note, _ts: ts, _sender: sender });
      if (OP.EVA.order > entity._hwm) entity._hwm = OP.EVA.order;
      break;
    }

    case OP.REC: {
      // Blind restructuring: REC without prior EVA in the system
      const hasAnyEva = Object.values(state.entities).some(e => e._hwm >= OP.EVA.order);
      if (!hasAnyEva && state.frames.length === 0) {
        state._violations.push({
          type: 'blind_restructuring', op: 'REC', _ts: ts,
        });
      }

      state.frames.push({
        ...content,
        _ts: ts,
        _sender: sender,
      });
      break;
    }
  }

  return state;
}

// ── Public API ──

/**
 * Stable, dependency-correct sort for a batch of events.
 *
 * Events reach the fold in *arrival* order, which is not chronological:
 * backfill pages, federation, and especially late `onDecrypted` events
 * (an `m.room.encrypted` event whose key arrives after later events were
 * already stored) land out of order. Operators carry hard dependency
 * ordering (INS before its DEFs), so folding out of order produces spurious
 * `missing_ins` violations and silently dropped DEFs. Sorting by
 * `origin_server_ts` fixes the across-time case.
 *
 * It does NOT fix the within-one-millisecond case, and that one is not
 * exotic — it is the common case. A single user action routinely emits a
 * burst: creating a drive document is `INS _doc` + `DEF file` + `DEF
 * uploaded_at`, all stamped with the same `Date.now()`. Tie-breaking those
 * on `event_id` orders them by an opaque server-assigned string, so roughly
 * half the time a `DEF` sorts ahead of the very `INS` that creates its
 * entity — the DEF is then dropped as `missing_ins`, and a document loses
 * the media reference that makes it readable.
 *
 * So a tie on timestamp breaks on OPERATOR ORDER first. The nine operators
 * are dependency-ordered by construction (NUL → SIG → INS → SEG → CON → SYN
 * → DEF → EVA → REC): each one's preconditions are satisfied by the ones
 * before it. Within a single millisecond that ordering is exactly the causal
 * one, and for events touching different anchors the relative order is
 * immaterial either way. Same-operator ties still fall through to event_id
 * and then input order, so repeated DEFs to one path keep last-write-wins.
 */
function chronological(events) {
  const ts = (e) => (typeof e?.getTs === 'function' ? e.getTs() : e?.origin_server_ts) || 0;
  const id = (e) => (typeof e?.getId === 'function' ? e.getId() : e?.event_id) || '';
  const order = (e) => {
    const type = typeof e?.getType === 'function' ? e.getType() : e?.type;
    const op = parseEventType(type);
    // Anything we don't recognise (m.room.encrypted, foreign events) keeps
    // its place at the end of the millisecond rather than jumping the queue.
    return op ? op.order : Number.MAX_SAFE_INTEGER;
  };
  return events
    .map((e, i) => [e, i, ts(e), order(e)])
    .sort((a, b) => {
      const d = a[2] - b[2];
      if (d !== 0) return d;
      const o = a[3] - b[3];
      if (o !== 0) return o;
      const ia = id(a[0]), ib = id(b[0]);
      if (ia < ib) return -1;
      if (ia > ib) return 1;
      return a[1] - b[1]; // preserve input order for full ties
    })
    .map((pair) => pair[0]);
}

/**
 * Fold an array of events into state from scratch.
 * Events are sorted into chronological order first (see `chronological`).
 */
export function fold(events) {
  return chronological(events).reduce(dispatch, initial());
}

/**
 * Incremental fold: apply new events onto existing state.
 * O(1) per event — the dependency floor of the incoming operator
 * determines what prior state it reads, not the full history.
 *
 * @param {FoldState} state - Previous state (will be mutated)
 * @param {Array} newEvents - New events in chronological order
 * @returns {FoldState}
 */
export function foldFrom(state, newEvents) {
  return chronological(newEvents).reduce(dispatch, state);
}

// ── Query helpers ──

export function entitiesOfType(state, entityType) {
  return Object.values(state.entities).filter(e => e._type === entityType);
}

export function entitiesInPartition(state, partition) {
  return Object.values(state.entities).filter(e => state.partitions[e._anchor] === partition);
}

/**
 * Every edge touching `anchor`, in either direction.
 *
 * Withdrawn edges (see the CON case's `retracts`) are left out by default:
 * a caller asking what this thing is connected to wants what holds now, not
 * what was once asserted. Pass `{ includeRetracted: true }` for the full
 * record — the timeline and any audit surface want that one.
 */
export function connectionsFor(state, anchor, { includeRetracted = false } = {}) {
  return state.connections.filter(c =>
    (c.source === anchor || c.target === anchor) &&
    (includeRetracted || !c._retracted));
}

/** Every edge that still holds. */
export function activeConnections(state) {
  return (state.connections || []).filter(c => !c._retracted);
}

export function currentFrame(state) {
  return state.frames.length > 0 ? state.frames[state.frames.length - 1] : null;
}

/**
 * Entities reachable from a given anchor via CON.
 * Returns the set of anchors in the same causal partition.
 * Entities NOT in this set can be folded in parallel.
 */
export function causalPartition(state, anchor) {
  const visited = new Set();
  const queue = [anchor];
  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const c of state.connections) {
      if (c.source === current && !visited.has(c.target)) queue.push(c.target);
      if (c.target === current && !visited.has(c.source)) queue.push(c.source);
    }
  }
  return visited;
}

/**
 * Compute a content hash of the current entity state.
 * For change detection: "has anything changed since last render?"
 */
export function stateHash(state) {
  const keys = Object.keys(state.entities).sort();
  let input = '';
  for (const k of keys) {
    const e = state.entities[k];
    input += k + ':' + (e._hwm || 0) + ':' + (e._updated || e._created || 0) + ';';
  }
  // Retracting an edge changes neither the entity set nor the length of
  // the connection list, so counting withdrawals is what makes an
  // unlinked dependency actually repaint.
  const retracted = state.connections.reduce((n, c) => n + (c._retracted ? 1 : 0), 0);
  input += 'c:' + state.connections.length + '/' + retracted + ';f:' + state.frames.length;
  // Include schema and partitions so DEF-on-schema and SEG trigger re-render
  const pKeys = Object.keys(state.partitions).sort();
  for (const pk of pKeys) input += 'p:' + pk + '=' + state.partitions[pk] + ';';
  const sKeys = Object.keys(state.schema).sort();
  for (const sk of sKeys) input += 's:' + sk + ';';
  return cyrb53(input);
}
