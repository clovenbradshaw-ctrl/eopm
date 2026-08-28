/**
 * kernel/cube.js — the cube vocabulary
 *
 * The nine operators (NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC)
 * are dependency-ordered in a straight line, but they also fall into a
 * 3×3×1 grid: three DOMAINS (the existing operators.js `triad` field,
 * relabeled for display — "significance" reads as Interpretation here)
 * crossed with three GRAINS (an operator's position within its own triad).
 * A third axis, MODE, names what *kind* of move an operator is: pulling
 * distinctness out of mush (Differentiate), connecting or comparing what
 * already exists (Relate), or composing a whole from parts (Generate).
 *
 * This file is dependency-free by design — no Matrix imports, nothing that
 * reaches a room or a client. It is pure vocabulary: constants and small
 * lookups over them. cube-position.js is the projection that reads actual
 * fold state through this vocabulary.
 *
 * Provenance: eoreader7's native/kernel/cube.js was the reference this spec
 * asked to vendor, but that repository was not reachable from this
 * environment. What follows is an original module authored to the same
 * contract (MODES, DOMAINS, GRAINS, TERRAIN_BY_DOMAIN, STANCE_BY_MODE,
 * cellOf) and cross-checked against every concrete example the spec gives
 * (Structure·Pattern = NETWORK/Composing for SYN, Interpretation·Ground for
 * DEF, Existence·Ground·Clearing for the Void). Domain/grain/mode
 * assignments below are the interpretation that satisfies all of them
 * simultaneously — treat it as a first cut, not a transcription.
 */

export const OP_ORDER = ['nul', 'sig', 'ins', 'seg', 'con', 'syn', 'def', 'eva', 'rec'];

export const DOMAINS = ['Existence', 'Structure', 'Interpretation'];
export const GRAINS = ['Ground', 'Figure', 'Pattern'];
export const MODES = ['Differentiate', 'Relate', 'Generate'];

export const TERRAIN_BY_DOMAIN = {
  Existence: { Ground: 'Clearing', Figure: 'Entity', Pattern: 'Kind' },
  Structure: { Ground: 'Placement', Figure: 'Link', Pattern: 'Network' },
  Interpretation: { Ground: 'Claim', Figure: 'Verdict', Pattern: 'Frame' },
};

export const STANCE_BY_MODE = {
  Differentiate: 'Distinguishing',
  Relate: 'Linking',
  Generate: 'Composing',
};

// Every operator's cube cell. Grain = order % 3 (its index within its own
// triad); domain = the triad itself. Mode is assigned by semantic role:
//   Differentiate — NUL, SIG, INS, SEG, DEF: naming, carving, defining.
//   Relate        — CON, EVA: connecting things, or judging one against another.
//   Generate      — SYN, REC: composing a whole from parts, or reframing one.
// This mode split is what makes Increment D's worked examples come out
// right: "no CON" prescribes Relate, "no SEG" prescribes Differentiate,
// "no SYN" prescribes Generate, "no EVA" prescribes Relate-within-
// Interpretation — each matches the operator's own mode below.
export const OP_CELLS = {
  nul: { domain: 'Existence', grain: 'Ground', mode: 'Differentiate', order: 0 },
  sig: { domain: 'Existence', grain: 'Figure', mode: 'Differentiate', order: 1 },
  ins: { domain: 'Existence', grain: 'Pattern', mode: 'Differentiate', order: 2 },
  seg: { domain: 'Structure', grain: 'Ground', mode: 'Differentiate', order: 3 },
  con: { domain: 'Structure', grain: 'Figure', mode: 'Relate', order: 4 },
  syn: { domain: 'Structure', grain: 'Pattern', mode: 'Generate', order: 5 },
  def: { domain: 'Interpretation', grain: 'Ground', mode: 'Differentiate', order: 6 },
  eva: { domain: 'Interpretation', grain: 'Figure', mode: 'Relate', order: 7 },
  rec: { domain: 'Interpretation', grain: 'Pattern', mode: 'Generate', order: 8 },
};

/** The operator key occupying a given (domain, grain) cell, or null. */
export function cellOf(domain, grain) {
  for (const [key, cell] of Object.entries(OP_CELLS)) {
    if (cell.domain === domain && cell.grain === grain) return key;
  }
  return null;
}

export function terrainOf(domain, grain) {
  return TERRAIN_BY_DOMAIN[domain]?.[grain] ?? null;
}

export function stanceOf(mode) {
  return STANCE_BY_MODE[mode] ?? null;
}
