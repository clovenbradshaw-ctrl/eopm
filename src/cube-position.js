/**
 * cube-position.js — the cube as a read-only projection over fold state
 *
 * Everything here reads state the fold already computes: `_hwm` (the
 * helix high-water mark — the highest operator order that has fired for an
 * entity), `_partition`, `_evaluations`, connections and frames touching an
 * anchor. Nothing here writes an event, changes the schema, or adds a
 * storage tier. It is pure computation, safe to call on demand and just as
 * safe to throw away — recomputing is cheap and there is nothing here worth
 * retaining across a render.
 *
 * Works against the plain state shape both folds in this repo produce
 * (`entities`, `connections`, `frames`, `partitions`) — src/fold.js's and
 * public/engine.js's — without importing either, so it has no opinion about
 * which one built the state it's handed.
 */

import { OP_ORDER, OP_CELLS, terrainOf, stanceOf } from './kernel/cube.js';

// Nothing below INS ever appears on a real entity: NUL and SIG are
// ephemeral and never stored (operators.js: `stored: false`), so an entity
// object — which only exists because an INS created it — always has
// _hwm >= INS.order.
const MIN_HWM = OP_ORDER.indexOf('ins');

function hasNonEmpty(obj) {
  return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

/**
 * Which of SEG/CON/SYN/DEF/EVA/REC has actually fired for this entity —
 * distinct from `_hwm`, which only records the highest order reached and so
 * says nothing about operators skipped along the way (INS → DEF → EVA never
 * touches SEG/CON/SYN, but hwm still lands on EVA).
 */
function firedFlags(entity, state) {
  const anchor = entity._anchor;
  const entities = state?.entities || {};
  const connections = state?.connections || [];
  const frames = state?.frames || [];

  const seg = entity._partition != null;
  const con = connections.some(c => c.source === anchor || c.target === anchor);
  const syn = entity._type === '_synthesis' ||
    Object.values(entities).some(e =>
      e._type === '_synthesis' && Array.isArray(e._inputs) && e._inputs.includes(anchor));
  // Per-path write bookkeeping is named differently between the two folds
  // in this repo (`_fieldTs` in src/fold.js, `_writes` in public/engine.js)
  // but both are only ever populated by a DEF, so either one's presence
  // means DEF fired at least once.
  const def = hasNonEmpty(entity._fieldTs) || hasNonEmpty(entity._writes);
  const eva = Array.isArray(entity._evaluations) && entity._evaluations.length > 0;
  // REC carries no anchor in its content (it's a workspace-level
  // reframe — `{ scope, before_frame, after_frame }`); a frame is "in
  // scope" for an entity when its `scope` names that entity's anchor.
  const rec = frames.some(f => f.scope === anchor);

  return { seg, con, syn, def, eva, rec };
}

/**
 * positionOf(entity, state) → the entity's current cube cell.
 *
 * `domain`/`grain`/`terrain`/`stance` describe the cell at `_hwm` — the
 * furthest the entity has reached. `occupied` is the fuller, possibly
 * sparse record of which operators actually fired, grouped by domain; it
 * can name fewer cells than `_hwm` alone would suggest, because dependency
 * order permits skipping a domain-mate on the way to the next domain.
 */
export function positionOf(entity, state = {}) {
  if (!entity) return null;
  const hwm = Number.isFinite(entity._hwm) ? entity._hwm : MIN_HWM;
  const clamped = Math.max(MIN_HWM, Math.min(hwm, OP_ORDER.length - 1));
  const opKey = OP_ORDER[clamped];
  const cell = OP_CELLS[opKey];
  const flags = firedFlags(entity, state);

  return {
    domain: cell.domain,
    grain: cell.grain,
    terrain: terrainOf(cell.domain, cell.grain),
    stance: stanceOf(cell.mode),
    hwm,
    occupied: {
      Existence: ['ins'],
      Structure: [
        ...(flags.seg ? ['seg'] : []),
        ...(flags.con ? ['con'] : []),
        ...(flags.syn ? ['syn'] : []),
      ],
      Interpretation: [
        ...(flags.def ? ['def'] : []),
        ...(flags.eva ? ['eva'] : []),
        ...(flags.rec ? ['rec'] : []),
      ],
    },
  };
}

// An operator is eligible once whatever it structurally depends on has
// actually fired — not merely once the raw fold would tolerate it (fold.js
// is flagged-never-blocked; this is stricter, on purpose). SEG/CON/DEF have
// no real dependency beyond the entity existing, so they're always
// eligible; SYN needs some structure to synthesize from; EVA needs a
// criterion (DEF) to judge against; REC needs a judgment (EVA) to reframe —
// this mirrors fold.js's own criterionless_judgment and blind_restructuring
// checks, just made per-entity and forward-looking.
function eligible(opKey, flags) {
  switch (opKey) {
    case 'seg': return true;
    case 'con': return true;
    case 'syn': return flags.seg || flags.con;
    case 'def': return true;
    case 'eva': return flags.def;
    case 'rec': return flags.eva;
    default: return false;
  }
}

/**
 * lawfulNext(entity, state) → the set of operators that make sense to do
 * next, given what's already fired. This is a list of options, not a
 * single suggestion — picking one is up to the user.
 *
 * Walks forward from `_hwm` in dependency order and stops at the first
 * operator that isn't yet eligible. A later operator is never offered
 * ahead of an earlier one it depends on, even when nothing downstream of
 * it would itself be blocked — an entity fresh off INS returns [SEG, CON],
 * not [SEG, CON, DEF]. DEF has no real precondition (the fold would let it
 * fire immediately), but jumping straight to "what does this mean" before
 * any structure exists isn't a sensible next step, so it's left out.
 */
export function lawfulNext(entity, state = {}) {
  if (!entity) return [];
  const hwm = Number.isFinite(entity._hwm) ? entity._hwm : MIN_HWM;
  const flags = firedFlags(entity, state);
  const next = [];
  for (let order = hwm + 1; order < OP_ORDER.length; order++) {
    const opKey = OP_ORDER[order];
    if (!eligible(opKey, flags)) break;
    const cell = OP_CELLS[opKey];
    next.push({ key: opKey, domain: cell.domain, grain: cell.grain, terrain: terrainOf(cell.domain, cell.grain) });
  }
  return next;
}

const GAP_OPS = ['seg', 'con', 'syn', 'def', 'eva', 'rec'];

/**
 * gapsOf(entity, state, rhythm) → un-fired cells as typed findings, never
 * as errors. `rhythm` (see src/unblock.js's computeRhythm) distinguishes a
 * gap that's simply early — younger than the workspace's own measured
 * return-of-attention — from one old enough to be worth surfacing. With no
 * rhythm measured yet, every gap defaults to `early`: a tool with no
 * evidence of the user's actual pace has no basis to call anything overdue.
 */
export function gapsOf(entity, state = {}, rhythm = null) {
  if (!entity) return [];
  const flags = firedFlags(entity, state);
  const age = Date.now() - (entity._updated || entity._created || Date.now());
  const status = (!rhythm || !Number.isFinite(rhythm.median) || age < rhythm.median)
    ? 'early' : 'open';

  const gaps = [];
  for (const opKey of GAP_OPS) {
    if (flags[opKey]) continue;
    const cell = OP_CELLS[opKey];
    gaps.push({ domain: cell.domain, grain: cell.grain, terrain: terrainOf(cell.domain, cell.grain), op: opKey, status });
  }
  return gaps;
}
