/**
 * unblock.js — figuring out when an entity is stuck, and what kind of
 * stuck it is
 *
 * "Stuck" isn't one thing. Three different situations all look like
 * "nothing's happened here in a while," but they need three different
 * moves to get out of:
 *
 *   - a pile of loose, undifferentiated notes on one entity needs
 *     carving apart (Differentiate — the same move as SEG)
 *   - several disconnected entities that are probably related need
 *     linking together (Relate — the same move as CON or EVA)
 *   - a bunch of connected pieces that were never pulled into a
 *     conclusion need synthesizing (Generate — the same move as SYN or REC)
 *
 * This file has two independent parts:
 *
 *   computeRhythm(state) — how long does this workspace normally go
 *   between actions? Measured from the data, not a hardcoded number of
 *   days. A tool that calls a two-day-old task "overdue" against some
 *   fixed setting is annoying; one that learns "this workspace typically
 *   goes 14 hours between touches" and only speaks up well past that is
 *   more likely to be right.
 *
 *   diagnose(entity, state, rhythm) — given that rhythm, is this specific
 *   entity stalled, and if so, which of the three shapes above does its
 *   situation match? Only ever suggests a move that's grounded in what's
 *   actually sitting in the fold already — if nothing specific stands out,
 *   it says so instead of guessing.
 *
 * IMPORTANT — this file's mode-prediction is unproven. See
 * test/unblock.test.mjs for the honesty check this ships with: there was
 * no real usage history available to validate "does the predicted mode
 * actually match what the user does next" against, so it's checked
 * against a small set of hand-built, plausible scenarios instead of real
 * data. The measured hit rate from that check is written in the test
 * file's own output and comments — read it before trusting this in a real
 * product decision. If a future measurement against real usage comes back
 * at chance, the fix is to delete the mode-guessing half of this file and
 * keep only the plain gap list (gapsOf, in cube-position.js already
 * covers that half on its own).
 */

import { positionOf } from './cube-position.js';

// ── computeRhythm ──────────────────────────────────────────────────────

function collectMoveTimestamps(state, events) {
  if (Array.isArray(events) && events.length > 0) {
    return events
      .map(e => (typeof e?.getTs === 'function' ? e.getTs() : e?.origin_server_ts))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  }
  // No raw log handed in — approximate from the folded state alone. This
  // undercounts a bit (an entity edited five times only leaves one
  // `_updated` timestamp behind, not five), but it needs nothing beyond
  // what positionOf/gapsOf already read.
  const ts = [];
  for (const e of Object.values(state.entities || {})) {
    if (Number.isFinite(e._created)) ts.push(e._created);
    if (Number.isFinite(e._updated) && e._updated !== e._created) ts.push(e._updated);
    for (const ev of e._evaluations || []) if (Number.isFinite(ev._ts)) ts.push(ev._ts);
  }
  for (const c of state.connections || []) if (Number.isFinite(c._ts)) ts.push(c._ts);
  for (const f of state.frames || []) if (Number.isFinite(f._ts)) ts.push(f._ts);
  return ts.sort((a, b) => a - b);
}

/**
 * computeRhythm(state, opts) → how often this workspace normally sees a
 * move, measured as the median gap between consecutive moves. Below
 * `minMoves` (default 50) it reports `measured: false` rather than a
 * number built on too little to mean anything.
 */
export function computeRhythm(state, { events, minMoves = 50 } = {}) {
  const ts = collectMoveTimestamps(state, events);
  if (ts.length < minMoves) {
    return { measured: false, moves: ts.length, needed: minMoves, median: null };
  }
  const deltas = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) deltas.push(d); // same-instant bursts are one action, not a "return"
  }
  deltas.sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;
  return { measured: true, moves: ts.length, median };
}

// ── diagnose ────────────────────────────────────────────────────────────

// How far past the workspace's usual pace counts as "worth a look", not
// just "a bit slow". 3x is deliberately conservative — the mockup this
// was modeled on flags an entity at roughly 5x its workspace's median.
const STALL_MULTIPLIER = 3;

function isDateLike(value) {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function dateFields(entity) {
  return Object.entries(entity)
    .filter(([k, v]) => !k.startsWith('_') && isDateLike(v))
    .map(([k, v]) => ({ field: k, value: v, ts: Date.parse(v) }));
}

function siblingsOf(entity, state) {
  return Object.values(state.entities || {}).filter(e =>
    e._anchor !== entity._anchor && e._type === entity._type && e._partition === entity._partition);
}

function hasConnection(anchor, state) {
  return (state.connections || []).some(c => c.source === anchor || c.target === anchor);
}

/**
 * Look at the shape of what's missing and decide which of the three moves
 * (Differentiate / Relate / Generate) would unstick this entity, plus a
 * plain-language reason and — when the fold actually has the material for
 * one — the specific thing that would settle it fastest. Returns
 * `{ mode: null, ... }` when nothing specific stands out; never invents a
 * reason to recommend one move over another.
 */
function shapeOf(entity, state) {
  const pos = positionOf(entity, state);
  const occ = pos.occupied;
  const hasSeg = occ.Structure.includes('seg');
  const hasCon = occ.Structure.includes('con');
  const hasSyn = occ.Structure.includes('syn');
  const hasDef = occ.Interpretation.includes('def');
  const hasEva = occ.Interpretation.includes('eva');
  const hasRec = occ.Interpretation.includes('rec');

  // 1. Mush: SEVERAL defined fields and zero structure at all — a jumble of
  //    facts nobody has carved apart yet. A single well-formed field with
  //    no structure isn't mush, it's a small claim waiting to be judged
  //    (see #4 below) — the field count is what tells them apart.
  const fieldCount = Object.keys(entity).filter(k => !k.startsWith('_')).length;
  const MUSH_FIELD_THRESHOLD = 3;
  if (hasDef && fieldCount >= MUSH_FIELD_THRESHOLD && !hasSeg && !hasCon && !hasSyn) {
    const partitions = state.schema?.partitions?.[entity._type];
    return {
      mode: 'Differentiate',
      domain: 'Structure',
      why: `${entity._type} ${entity._anchor} has defined content but has never been placed or linked — it's one undifferentiated block, not several distinguishable pieces yet.`,
      wouldSettle: partitions?.length
        ? [`this entity has never been segmented — ${entity._type} has declared partitions (${partitions.join(', ')}); placing it in one would be the fastest first cut`]
        : [],
    };
  }

  // 2. Isolated pieces: several siblings in the same partition, few linked
  //    to anything. The individual entity may be fine; the group isn't
  //    talking to itself yet.
  const siblings = siblingsOf(entity, state);
  if (entity._partition && siblings.length >= 2) {
    const group = [entity, ...siblings];
    const linked = group.filter(e => hasConnection(e._anchor, state));
    if (linked.length / group.length < (1 / 3)) {
      return {
        mode: 'Relate',
        domain: 'Structure',
        why: `${group.length} entities share the "${entity._partition}" partition and only ${linked.length} of them have any link at all — they may be part of one story that's never been connected.`,
        wouldSettle: [`${group.length - linked.length} of the ${group.length} entities in "${entity._partition}" have no CON at all — linking the two that look most related would be the fastest way to find out if they belong together`],
      };
    }
  }

  // 3. Parts without a whole: connected, but never pulled into a synthesis.
  if (hasCon && !hasSyn) {
    return {
      mode: 'Generate',
      domain: 'Structure',
      why: `${entity._anchor} is linked to other material, but nothing has synthesized those pieces into a single whole yet.`,
      wouldSettle: [],
    };
  }

  // 4. A claim with material but no judgment.
  if (hasDef && !hasEva) {
    const dates = dateFields(entity);
    const settle = [];
    if (dates.length >= 2) {
      const [a, b] = dates.sort((x, y) => x.ts - y.ts);
      settle.push(`\`${a.field}\` (${a.value}) and \`${b.field}\` (${b.value}) are both already on this entity and have never been compared`);
    }
    return {
      mode: 'Relate',
      domain: 'Interpretation',
      why: `${entity._anchor} has defined material and no judgment yet — there's something to evaluate, not a missing fact.`,
      wouldSettle: settle,
    };
  }

  // 5. Judged but never reframed — the same shape as #3, one domain over.
  if (hasEva && !hasRec) {
    return {
      mode: 'Generate',
      domain: 'Interpretation',
      why: `${entity._anchor} has been evaluated but the meaning of that judgment has never been written up as a frame.`,
      wouldSettle: [],
    };
  }

  return { mode: null, domain: null, why: null, wouldSettle: [] };
}

/**
 * diagnose(entity, state, rhythm) → whether this entity is stalled by this
 * workspace's own measured pace, and if so, which shape its stall has.
 *
 * `rhythm` should come from computeRhythm(state) — pass its result in
 * directly so a caller diagnosing many entities only measures the
 * workspace's pace once.
 */
export function diagnose(entity, state, rhythm) {
  if (!entity) return { stalled: false, mode: null, domain: null, why: null, wouldSettle: [] };

  if (!rhythm || !rhythm.measured) {
    return {
      stalled: false,
      mode: null,
      domain: null,
      why: `not enough data yet (${rhythm?.moves ?? 0} moves, need ~${rhythm?.needed ?? 50}) — not calling anything stalled until this workspace's actual pace is measurable`,
      wouldSettle: [],
    };
  }

  // `|| ` would wrongly skip a legitimately-zero timestamp (epoch 0 is
  // falsy but a real value) — Number.isFinite is the honest check.
  const lastTouch = Number.isFinite(entity._updated) ? entity._updated
    : Number.isFinite(entity._created) ? entity._created
    : Date.now();
  const age = Date.now() - lastTouch;
  const stalled = age > rhythm.median * STALL_MULTIPLIER;
  if (!stalled) return { stalled: false, mode: null, domain: null, why: null, wouldSettle: [] };

  const shape = shapeOf(entity, state);
  return { stalled: true, ...shape };
}
