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
 * `minGaps` it reports `measured: false` rather than a number built on too
 * little to mean anything. `max` — the longest gap this workspace has
 * actually had — is what a silence gets judged against; see MIN_GAPS.
 */
export function computeRhythm(state, { events, minGaps = MIN_GAPS } = {}) {
  const ts = collectMoveTimestamps(state, events);
  const deltas = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) deltas.push(d); // same-instant bursts are one action, not a "return"
  }
  deltas.sort((a, b) => a - b);

  if (deltas.length < minGaps) {
    return { measured: false, moves: ts.length, gaps: deltas.length, needed: minGaps, median: null, max: null };
  }
  return {
    measured: true,
    moves: ts.length,
    gaps: deltas.length,
    median: deltas[Math.floor(deltas.length / 2)],
    max: deltas[deltas.length - 1],
  };
}

// ── diagnose ────────────────────────────────────────────────────────────

/**
 * A silence counts as unusual when it is longer than EVERY gap this
 * workspace has actually had — no multiplier, and no assumption about the
 * shape of the distribution.
 *
 * This is a rank test, and its strength is exact. If nothing has changed
 * about how this workspace works, the current silence is just another draw
 * from the same pot as the `n` gaps already observed, so the chance it
 * happens to be the longest of the `n + 1` is exactly `1/(n + 1)`. That
 * number is reported alongside the verdict rather than hidden behind a
 * threshold, and it tightens on its own as evidence accumulates: with four
 * gaps behind it a flag means little, with forty it means a good deal.
 *
 * The version this replaced needed 50 moves before it would say anything
 * and then compared against 3x the median. Both numbers were invented, and
 * between them they meant a workspace one person had been using for a
 * fortnight could never be told anything at all.
 */

// Two gaps is the smallest number for which "longer than all of them" is a
// comparison rather than a restatement of the only value there is. This is
// a floor on what the test can mean, not a judgement about when a
// workspace becomes interesting.
const MIN_GAPS = 2;

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

  const idle = { stalled: false, mode: null, domain: null, why: null, wouldSettle: [], oddsIfNothingChanged: null, longerThan: 0 };

  if (!rhythm || !rhythm.measured) {
    return {
      ...idle,
      why: `this workspace has only ${rhythm?.gaps ?? 0} gap${(rhythm?.gaps ?? 0) === 1 ? '' : 's'} between actions so far — too few to tell a pause from a habit`,
    };
  }

  // `|| ` would wrongly skip a legitimately-zero timestamp (epoch 0 is
  // falsy but a real value) — Number.isFinite is the honest check.
  const lastTouch = Number.isFinite(entity._updated) ? entity._updated
    : Number.isFinite(entity._created) ? entity._created
    : Date.now();
  const age = Date.now() - lastTouch;
  if (age <= rhythm.max) return idle;

  return {
    stalled: true,
    // Exact under exchangeability: the chance this silence is the longest
    // of the n + 1 draws when nothing has actually changed.
    oddsIfNothingChanged: 1 / (rhythm.gaps + 1),
    longerThan: rhythm.gaps,
    ...shapeOf(entity, state),
  };
}
