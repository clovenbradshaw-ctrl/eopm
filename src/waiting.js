/**
 * waiting.js — what this workspace is stuck behind, and for how long
 *
 * Almost nothing here is new machinery. A dependency is already
 * expressible: CON carries a `relation_type`, and the fold has been
 * recording `blocked_by` / `depends_on` edges since the seed data was
 * written. What was missing was the reverse question. `state.connections`
 * is a flat list, so "what is this waiting on" was a scan nobody had
 * written, and "what would move if this arrived" — the one that tells you
 * which wait is worth chasing — had no answer at all.
 *
 * Three decisions shape the rest of the file.
 *
 * **The wait is an entity, not an edge attribute.** A records request has
 * a title, a date, a recipient and a life of its own; it is a thing in the
 * workspace, and `A blocked_by B` says B is what A is stuck behind. So
 * there are no new fields to fill in and no new operator: the date you
 * started waiting is the edge's own timestamp, and the wait ends when B
 * lands in the last stage its type declares. Whatever else you know about
 * B — who you sent it to, the reference number — lives on B, where the
 * table and the kanban can already see it.
 *
 * **Nothing here is stale by a fixed number of days.** A view that calls a
 * two-week wait "stalled" has decided in advance how fast records offices
 * answer. This measures instead: a wait is unusual when it has run longer
 * than every wait this workspace has actually finished, and the odds that
 * happens by chance alone are reported with it — exactly the rank test
 * unblock.js uses for silence, for the same reason. Below two finished
 * waits it says so rather than inventing a number.
 *
 * **Direction is normalized, not enforced.** `blocked_by`, `depends_on`,
 * `waiting_on` and `blocks` all already exist in real logs, drawn by hand
 * in the graph view where the relation is a free-text field. They are read
 * as the same relation pointing two ways rather than migrated, since the
 * log is append-only and rewriting history to suit a later vocabulary is
 * the one thing a fold is supposed to make unnecessary.
 */

import { titleOf } from './plain-position.js';

// ── The dependency vocabulary ──
//
// A fixed list of synonyms, deliberately: an unrecognized relation is not
// a dependency, and guessing that it might be would put edges into the
// Waiting view that nobody meant as blockers. `annotates`, `belongs_to`,
// `watches` and `sent_to` are all real relations in this app that must
// stay out of it.

const NEEDS_TARGET = new Set([
  'blocked_by', 'blockedby', 'depends_on', 'dependson', 'waiting_on',
  'waiting_for', 'awaiting', 'needs', 'requires',
]);

const NEEDS_SOURCE = new Set([
  'blocks', 'blocking',
]);

function normalizeRelation(type) {
  return String(type || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Is this relation type a dependency at all, in either direction? */
export function isDependencyRelation(type) {
  const r = normalizeRelation(type);
  return NEEDS_TARGET.has(r) || NEEDS_SOURCE.has(r);
}

/**
 * Every dependency edge in the log, pointed the same way: `blocked` is
 * what cannot proceed, `blocker` is what it is stuck behind. Withdrawn
 * edges are carried too, flagged rather than dropped — a finished wait is
 * evidence about how long waits take here, and dropping it would leave the
 * stall test measuring only the waits that are still open.
 */
export function dependencyEdges(state) {
  const out = [];
  for (const c of state?.connections || []) {
    const r = normalizeRelation(c.type);
    if (NEEDS_TARGET.has(r)) out.push({ blocked: c.source, blocker: c.target, edge: c });
    else if (NEEDS_SOURCE.has(r)) out.push({ blocked: c.target, blocker: c.source, edge: c });
  }
  return out;
}

// ── When is the thing you are waiting on finished? ──

/**
 * The last stage a type declares — `_schema.partitions.<type>` is an
 * ordered list ("backlog, doing, done"), and the end of it is where work
 * of that type comes to rest.
 *
 * Returns null when the type declares no stages, and that null is load
 * bearing: without a declared order there is no way to tell a finished
 * stage from a middle one, and picking the word that looks most like
 * "done" would be a guess dressed as a fact. The view says so and offers
 * to unlink instead.
 */
export function terminalPartition(state, entityType) {
  const declared = state?.schema?.partitions?.[entityType];
  if (!Array.isArray(declared) || declared.length === 0) return null;
  return declared[declared.length - 1];
}

/** Has this entity reached the last stage its type declares? */
export function isSettled(state, entity) {
  if (!entity) return false;
  const terminal = terminalPartition(state, entity._type);
  if (!terminal) return false;
  return (state.partitions?.[entity._anchor] ?? entity._partition) === terminal;
}

/**
 * anchor → when it was last moved between stages, read from the raw log.
 *
 * `_updated` alone is not this: any later DEF moves it, so an entity that
 * was finished on Monday and had a note added on Friday would report a
 * four-day-longer wait than it had. When the caller has the room's events
 * — every view that renders this does — the SEG timestamps are exact.
 * Without them the fallback is `_updated`, and callers are told which they
 * got via `exact` on each row.
 */
export function buildSettleIndex(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const index = new Map();
  for (const e of events) {
    const type = typeof e?.getType === 'function' ? e.getType() : e?.type;
    if (typeof type !== 'string' || !type.endsWith('.seg')) continue;
    const content = typeof e?.getContent === 'function' ? e.getContent() : e?.content;
    const ts = typeof e?.getTs === 'function' ? e.getTs() : e?.origin_server_ts;
    if (!content?.anchor || !Number.isFinite(ts)) continue;
    const prev = index.get(content.anchor);
    if (prev === undefined || ts > prev) index.set(content.anchor, ts);
  }
  return index;
}

function settledAt(state, entity, settleIndex) {
  if (!isSettled(state, entity)) return null;
  const exact = settleIndex?.get(entity._anchor);
  if (Number.isFinite(exact)) return { ts: exact, exact: true };
  const fallback = Number.isFinite(entity._updated) ? entity._updated : entity._created;
  return Number.isFinite(fallback) ? { ts: fallback, exact: false } : null;
}

/**
 * One dependency edge, resolved into whether it still holds anyone up.
 * `endedAt` is when the wait stopped mattering: the blocker reaching its
 * last stage, or the edge being withdrawn, whichever the log shows.
 */
function readEdge(state, dep, settleIndex) {
  const blocker = state.entities?.[dep.blocker];
  const blocked = state.entities?.[dep.blocked];
  const withdrawn = Number.isFinite(dep.edge._retracted) ? dep.edge._retracted : null;
  const settle = blocker ? settledAt(state, blocker, settleIndex) : null;

  // A withdrawn edge stopped counting the moment it was withdrawn, even if
  // the thing it pointed at was finished later.
  const endedAt = withdrawn !== null ? withdrawn : settle?.ts ?? null;

  return {
    ...dep,
    blockerEntity: blocker,
    blockedEntity: blocked,
    open: endedAt === null,
    endedAt,
    withdrawn: withdrawn !== null,
    exact: withdrawn !== null ? true : settle ? settle.exact : true,
    startedAt: Number.isFinite(dep.edge._ts) ? dep.edge._ts : null,
  };
}

// ── How long do waits take here? ──

// Two finished waits is the smallest number for which "longer than all of
// them" compares rather than restates, the same floor unblock.js sets on
// gaps between actions and for the same reason.
const MIN_FINISHED = 2;

/**
 * waitRhythm(state, opts) → how long this workspace's finished waits took.
 *
 * `max` is what an open wait is judged against; `median` is the point by
 * which half of them had been answered, which is all "worth chasing" ever
 * means here. Reports `measured: false` below the floor instead of a
 * number resting on one observation.
 *
 * With exactly two finished waits the upper median IS the maximum, so the
 * nudge and the stall fire together and the earlier warning is worth
 * nothing. That is what two observations can support; it separates on its
 * own as more waits finish.
 */
export function waitRhythm(state, { events, settleIndex, minFinished = MIN_FINISHED } = {}) {
  const index = settleIndex !== undefined ? settleIndex : buildSettleIndex(events);
  const durations = [];
  for (const dep of dependencyEdges(state)) {
    const e = readEdge(state, dep, index);
    if (e.open || e.startedAt === null || e.endedAt === null) continue;
    const d = e.endedAt - e.startedAt;
    if (d > 0) durations.push(d);
  }
  durations.sort((a, b) => a - b);

  if (durations.length < minFinished) {
    return { measured: false, finished: durations.length, needed: minFinished, median: null, max: null };
  }
  return {
    measured: true,
    finished: durations.length,
    median: durations[Math.floor(durations.length / 2)],
    max: durations[durations.length - 1],
  };
}

// ── The two questions the flat connection list could not answer ──

/** What `anchor` is stuck behind, open edges only unless asked otherwise. */
export function blockersOf(state, anchor, { includeClosed = false, settleIndex } = {}) {
  return dependencyEdges(state)
    .filter(d => d.blocked === anchor)
    .map(d => readEdge(state, d, settleIndex))
    .filter(e => includeClosed || e.open);
}

/**
 * What would move if `anchor` arrived. This is the reverse scan the whole
 * view is for: the wait worth a phone call is the one holding up three
 * things, not the one that has been open longest.
 */
export function dependentsOf(state, anchor, { includeClosed = false, settleIndex } = {}) {
  return dependencyEdges(state)
    .filter(d => d.blocker === anchor)
    .map(d => readEdge(state, d, settleIndex))
    .filter(e => includeClosed || e.open);
}

// ── The Waiting view's model ──

/**
 * waitingRows(state, opts) → one row per thing being waited on, longest
 * first, each carrying what it holds up and what the measured tests say.
 *
 * Several edges can point at the same blocker; they collapse into one row,
 * because "the FOIA is late" is one fact however many pieces of work it
 * holds up. The row's age runs from the earliest of them — the day you
 * first recorded that you were stuck behind it.
 */
export function waitingRows(state, { events, now = Date.now(), rhythm } = {}) {
  const settleIndex = buildSettleIndex(events);
  const measured = rhythm || waitRhythm(state, { settleIndex });

  const byBlocker = new Map();
  for (const dep of dependencyEdges(state)) {
    const e = readEdge(state, dep, settleIndex);
    if (!e.open) continue;
    if (!byBlocker.has(e.blocker)) byBlocker.set(e.blocker, []);
    byBlocker.get(e.blocker).push(e);
  }

  const rows = [];
  for (const [anchor, edges] of byBlocker) {
    const blocker = state.entities?.[anchor];
    const startedAt = edges.reduce(
      (min, e) => (e.startedAt !== null && (min === null || e.startedAt < min) ? e.startedAt : min),
      null,
    );
    const age = startedAt === null ? null : now - startedAt;

    // Everything this wait holds up, settled or not. A wait whose every
    // dependent is already finished is holding up nothing that is still
    // moving — either the link was never right or the wait has outlived
    // its reason, and both are worth being asked about.
    const dependents = edges.map(e => e.blockedEntity).filter(Boolean);
    const liveDependents = dependents.filter(d => !isSettled(state, d));

    const stalled = measured.measured && age !== null && age > measured.max;
    const nudgeDue = measured.measured && age !== null && age > measured.median;

    rows.push({
      anchor,
      entity: blocker,
      title: blocker ? titleOf(blocker) : anchor,
      missing: !blocker,
      startedAt,
      age,
      edges,
      dependents,
      liveDependents,
      blocksNothingLive: dependents.length > 0 && liveDependents.length === 0,
      stalled,
      oddsIfNothingChanged: stalled ? 1 / (measured.finished + 1) : null,
      longerThan: stalled ? measured.finished : 0,
      nudgeDue,
      // Whether "it arrived" can be recorded by moving the blocker to its
      // last stage, or whether the only honest move is to unlink.
      terminal: blocker ? terminalPartition(state, blocker._type) : null,
      exact: edges.every(e => e.exact),
    });
  }

  rows.sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
  return { rows, rhythm: measured };
}

/**
 * What stopped being blocked since `since`.
 *
 * This is the payoff for recording dependencies at all. Without it,
 * finishing a blocker changes a field somewhere and the work it frees sits
 * untouched because nobody was told. An entity qualifies when it had
 * dependencies, has no open ones left, and the last of them closed inside
 * the window.
 *
 * Pass `onlyUntouched` for the standing version of the same question —
 * what has been freed and not picked up — which needs no window to be
 * chosen for it and clears itself as the work gets touched.
 */
export function unblockedSince(state, since, { events, now = Date.now(), onlyUntouched = false } = {}) {
  const settleIndex = buildSettleIndex(events);
  const byBlocked = new Map();
  for (const dep of dependencyEdges(state)) {
    const e = readEdge(state, dep, settleIndex);
    if (!byBlocked.has(e.blocked)) byBlocked.set(e.blocked, []);
    byBlocked.get(e.blocked).push(e);
  }

  const out = [];
  for (const [anchor, edges] of byBlocked) {
    if (edges.some(e => e.open)) continue;
    const freedAt = edges.reduce((max, e) => (e.endedAt !== null && e.endedAt > max ? e.endedAt : max), -Infinity);
    if (!Number.isFinite(freedAt) || freedAt < since || freedAt > now) continue;
    const entity = state.entities?.[anchor];
    if (!entity) continue;
    // Something already finished is not news that it can start.
    if (isSettled(state, entity)) continue;
    // `onlyUntouched` is what a standing "this is free now" band wants: not
    // everything freed in some arbitrary recent window, but everything
    // freed that nobody has picked up since. It needs no window at all,
    // and it empties itself the moment the work is touched.
    if (onlyUntouched) {
      const touched = Number.isFinite(entity._updated) ? entity._updated : entity._created;
      if (Number.isFinite(touched) && touched > freedAt) continue;
    }
    const last = edges.find(e => e.endedAt === freedAt);
    out.push({
      anchor,
      entity,
      title: titleOf(entity),
      freedAt,
      by: last?.blockerEntity ? titleOf(last.blockerEntity) : last?.blocker,
      withdrawn: !!last?.withdrawn,
    });
  }

  out.sort((a, b) => b.freedAt - a.freedAt);
  return out;
}
