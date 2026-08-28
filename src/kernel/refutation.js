/**
 * kernel/refutation.js — structural conflict checks over fold state
 *
 * Two checks, both read-only:
 *
 *   CYCLE       — a circular dependency among `blocks`-typed CON edges
 *                 (A blocks B blocks C blocks A, so none of them can ever
 *                 start). This check always runs; a cycle is a logical
 *                 contradiction no matter what the schema says.
 *
 *   UNIQUENESS  — two owners of a relation the schema says should be 1:1
 *                 (e.g. "a person can only be the appointee of one seat at
 *                 a time"). This only runs for a relation the schema (or
 *                 the caller, via `expectUnique`) actually marked as
 *                 unique — it's never guessed from the data. An
 *                 undeclared relation is never checked, so it never flags.
 *
 * Both functions return only the actual problems they find — there's no
 * "checked this and it was fine" entry for everything else. That's
 * intentional: this file should never produce a result that a caller
 * could misread as "verified" just because nothing was flagged. Every
 * finding this file returns has its `refuted` field set to true; this
 * module never hands back a finding where that field is false, so there
 * is nothing for a caller to negate into a false sense of security.
 * test/refutation.test.mjs greps the whole repo for that exact negation
 * and fails the build if it ever shows up.
 *
 * Matches the rest of the app's rule: violations are flagged, never used
 * to block anything. A user can still make the connection the checks
 * complain about — see how these findings get surfaced in the UI.
 *
 * This is a fresh implementation, not copied from anywhere — the eoreader7
 * project this was originally modeled on wasn't reachable from this
 * environment, so this file was written from the description of what it
 * should do rather than ported from existing code.
 *
 * No imports from the Matrix/client code, on purpose, so it stays easy to
 * test on its own. `events`, where it's accepted, is just a plain array of
 * event objects (or matrix-js-sdk MatrixEvent instances — both are
 * handled) used only to figure out who declared a schema rule and when.
 */

function eventType(e) {
  return typeof e?.getType === 'function' ? e.getType() : e?.type;
}
function eventContent(e) {
  return typeof e?.getContent === 'function' ? e.getContent() : e?.content;
}
function eventTs(e) {
  return typeof e?.getTs === 'function' ? e.getTs() : e?.origin_server_ts;
}
function eventSender(e) {
  return typeof e?.getSender === 'function' ? e.getSender() : e?.sender;
}

/**
 * Find whoever most recently set `_schema.links` (the whole array is
 * replaced in one DEF each time it's edited — see operators.js's
 * `defSchema`) and when. Returns null if `events` wasn't passed in, or
 * the declaring event isn't in it.
 */
function linksGiver(events) {
  if (!Array.isArray(events)) return null;
  let latest = null;
  for (const e of events) {
    const content = eventContent(e);
    if (!content || content.anchor || content.path !== '_schema.links') continue;
    const type = eventType(e);
    if (typeof type !== 'string' || !type.endsWith('.def')) continue;
    const ts = eventTs(e) || 0;
    if (!latest || ts > latest.ts) latest = { sender: eventSender(e), ts };
  }
  return latest;
}

/**
 * findCycles(state, opts) — find circular chains in one CON relation type
 * (default `blocks`). Each finding names the full loop.
 */
export function findCycles(state, { relation = 'blocks' } = {}) {
  const edges = (state.connections || []).filter(c => c.type === relation);
  if (edges.length === 0) return [];

  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e);
  }

  // Standard DFS cycle detection: WHITE = unvisited, GRAY = on the current
  // path, BLACK = fully explored. Hitting a GRAY node means we've looped
  // back onto our own path.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const stack = [];
  const seen = new Set();
  const findings = [];

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const edge of adj.get(node) || []) {
      const next = edge.target;
      const c = color.get(next) || WHITE;
      if (c === WHITE) {
        visit(next);
      } else if (c === GRAY) {
        const idx = stack.indexOf(next);
        const cyclePath = [...stack.slice(idx), next];
        // The same cycle can be reached from more than one starting node —
        // dedupe on the set of nodes involved, regardless of where the
        // walk happened to enter it.
        const key = cyclePath.slice(0, -1).slice().sort().join('\0');
        if (!seen.has(key)) {
          seen.add(key);
          const cycleEdges = edges.filter(e2 =>
            cyclePath.includes(e2.source) && cyclePath.includes(e2.target));
          const maxTs = cycleEdges.reduce((m, e2) => Math.max(m, e2._ts || 0), 0);
          findings.push({
            type: 'cycle',
            op: 'CON',
            relation,
            path: cyclePath,
            rule: relation,
            giver: 'kernel',
            reason: `these ${relation} edges form a loop, so none of them can ever be the first to start`,
            refuted: true,
            _ts: maxTs,
          });
        }
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if ((color.get(node) || WHITE) === WHITE) visit(node);
  }
  return findings;
}

function declaredUniqueRelations(state, expectUnique) {
  const declared = new Set(expectUnique || []);
  for (const link of state.schema?.links || []) {
    if (link && (link.unique === true || link.cardinality === '1:1')) declared.add(link.rel);
  }
  return declared;
}

/**
 * findUniquenessViolations(state, opts) — find broken 1:1 relations.
 * Only checks relations the schema actually declared unique, or that the
 * caller passed in via `expectUnique`. Never guesses uniqueness from the
 * data itself — a relation isn't 1:1 just because it happens to look that
 * way so far.
 *
 * Checked in both directions, because a real 1:1 relation has to hold up
 * both ways: one source can't point at two targets, and one target can't
 * be pointed at by two sources.
 */
export function findUniquenessViolations(state, { expectUnique = [], events } = {}) {
  const relations = declaredUniqueRelations(state, expectUnique);
  if (relations.size === 0) return [];

  const giver = linksGiver(events);
  const findings = [];

  for (const rel of relations) {
    const edges = (state.connections || []).filter(c => c.type === rel);
    if (edges.length === 0) continue;

    for (const [dir, keyOf, otherOf] of [
      ['source', c => c.source, c => c.target],
      ['target', c => c.target, c => c.source],
    ]) {
      const byKey = new Map();
      for (const e of edges) {
        const k = keyOf(e);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(e);
      }
      for (const [key, group] of byKey) {
        if (group.length <= 1) continue;
        findings.push({
          type: 'uniqueness',
          op: 'CON',
          relation: rel,
          direction: dir,
          holder: key,
          conflicting: group.map(otherOf),
          rule: rel,
          giver: giver ? giver.sender : null,
          declaredAt: giver ? giver.ts : null,
          refuted: true,
          _ts: group.reduce((m, e) => Math.max(m, e._ts || 0), 0),
        });
      }
    }
  }
  return findings;
}

/** Both checks together — the convenience most callers actually want. */
export function refute(state, { relation = 'blocks', expectUnique = [], events } = {}) {
  return [
    ...findCycles(state, { relation }),
    ...findUniquenessViolations(state, { expectUnique, events }),
  ];
}

/**
 * Returns a new array: `state._violations` plus these findings. Never
 * mutates `state` — like cube-position.js, this is cheap to recompute on
 * demand, so there's no reason to store it anywhere.
 */
export function withRefutationFindings(state, findings) {
  return [...(state._violations || []), ...findings];
}
