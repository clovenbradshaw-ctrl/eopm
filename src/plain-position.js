/**
 * plain-position.js — saying where something stands, in English
 *
 * src/cube-position.js computes an entity's position exactly; this file is
 * the only thing allowed to *say* it. Nothing downstream of here should
 * ever render a domain, a grain, a terrain, a stance, or an operator name:
 * someone using this app to get a product out the door has no reason to
 * learn a vocabulary in order to read a status line. "Existence · Pattern
 * — KIND · Distinguishing" and "named, and nothing else yet" describe the
 * same state; only one of them is worth showing.
 *
 * Two things beyond translation happen here.
 *
 * Every description carries at most ONE action, and that action is the
 * status line's own remedy. "Nothing depends on this" and the way to fix
 * it are the same object in the UI, so nobody reads a diagnosis and then
 * goes hunting for the view that acts on it.
 *
 * And a state with nothing wrong gets no action at all. A tool that always
 * has a next step for you is a tool that will invent one.
 */

import { positionOf } from './cube-position.js';

/** The human-facing name of an entity, falling back to its anchor. */
export function titleOf(entity) {
  if (!entity) return 'this';
  return entity.Title || entity.Name || entity.title || entity.name ||
    entity.body || entity.claim || entity.what || entity._anchor || 'this';
}

/**
 * The ladder of things worth saying, in the order worth saying them.
 *
 * Order is by what unblocks the most: an entity nothing connects to is
 * stuck in a way that matters more than one that merely lacks a written
 * spec, because the spec can be written any time and the isolation is what
 * keeps it from being part of the work. Only the first matching rung is
 * shown — a status line that lists four deficiencies is a nag, not a
 * status line.
 */
const LADDER = [
  {
    id: 'fresh',
    when: f => !f.seg && !f.con && !f.syn && !f.def && !f.eva && !f.rec,
    chip: 'named, nothing else yet',
    headline: "Nothing depends on this, and it doesn't depend on anything.",
    action: { label: 'add something it needs', op: 'con' },
  },
  {
    id: 'isolated',
    when: f => !f.con,
    chip: 'not connected to anything',
    headline: "There's detail here, but nothing connects it to the rest of the work.",
    action: { label: 'add something it needs', op: 'con' },
  },
  {
    id: 'undefined',
    when: f => !f.def,
    chip: 'connected, but undescribed',
    headline: "It's wired up to other things, but nothing says what it actually is.",
    action: { label: 'say what it is', op: 'def' },
  },
  {
    id: 'scattered',
    when: f => f.con && !f.syn,
    chip: 'has pieces, never pulled together',
    headline: 'It has pieces, but they have never been pulled together into one thing.',
    action: { label: 'pull them together', op: 'syn' },
  },
  {
    id: 'untested',
    when: f => f.def && !f.eva,
    chip: "spec'd, never tried out",
    headline: 'You have written down what it should do, but never checked anything against that.',
    action: { label: 'check it against what you wrote', op: 'eva' },
  },
  {
    id: 'settled',
    when: f => f.eva && !f.rec,
    chip: 'tried out, works',
    headline: 'It has been checked and nothing has changed about it since.',
    action: null,
  },
  {
    id: 'reworked',
    when: f => f.eva && f.rec,
    chip: 'reworked after testing',
    headline: 'It was checked, and what it is has changed at least once since then.',
    action: null,
  },
];

/**
 * describeEntity(entity, state) → { chip, headline, action, id }
 *
 * `chip` is the short form for lists, `headline` the sentence for a detail
 * view, `action` the single remedy or null. `id` names the matched rung,
 * for tests and styling — never for display.
 */
export function describeEntity(entity, state = {}) {
  if (!entity) return null;
  const pos = positionOf(entity, state);
  if (!pos) return null;

  const occ = pos.occupied;
  const f = {
    seg: occ.Structure.includes('seg'),
    con: occ.Structure.includes('con'),
    syn: occ.Structure.includes('syn'),
    def: occ.Interpretation.includes('def'),
    eva: occ.Interpretation.includes('eva'),
    rec: occ.Interpretation.includes('rec'),
  };

  const rung = LADDER.find(r => r.when(f));
  if (!rung) return { id: 'unknown', chip: 'in progress', headline: 'This is somewhere in the middle of being worked out.', action: null };
  return { id: rung.id, chip: rung.chip, headline: rung.headline, action: rung.action };
}

// ── structural findings ────────────────────────────────────────────────

/**
 * describeFinding(finding, state) → a sentence, or null for a finding
 * shape this file has no plain rendering for.
 *
 * Findings are never phrased as errors. A loop in the dependencies is a
 * fact about the plan, not a mistake the user has to answer for, and the
 * wording says what is true rather than what they did wrong.
 */
export function describeFinding(finding, state = {}) {
  if (!finding) return null;
  const entities = state.entities || {};
  const name = anchor => titleOf(entities[anchor]) || anchor;

  if (finding.type === 'cycle') {
    const path = Array.isArray(finding.path) ? finding.path : [];
    const loop = path.slice(0, -1); // the closing repeat is implied
    if (loop.length === 2) {
      return `${name(loop[0])} is waiting on ${name(loop[1])}, and ${name(loop[1])} is waiting on ${name(loop[0])}. Neither can go first.`;
    }
    if (loop.length > 2) {
      return `${loop.map(name).join(' waits on ')} — which waits on ${name(loop[0])} again. Nothing in that ring can start.`;
    }
    return null;
  }

  if (finding.type === 'uniqueness') {
    const others = (finding.conflicting || []).map(name);
    const holder = name(finding.holder);
    if (others.length >= 2) {
      return `${holder} can only have one ${finding.relation}, but ${others.length} are claiming it: ${others.join(', ')}.`;
    }
    return null;
  }

  return null;
}

// ── workspace-level ────────────────────────────────────────────────────

/**
 * describeWorkspace(state, opts) → { line, named, working, held }
 *
 * The always-visible line about where the whole effort stands. It counts
 * and nothing else: no percentage, no progress bar, no stage name. Any of
 * those would be an invention, because there is no denominator — you do
 * not know how many things a product turns out to need until it is done.
 */
export function describeWorkspace(state = {}, { held = 0 } = {}) {
  const entities = Object.values(state.entities || {})
    .filter(e => e && !e._deleted && e._type !== '_synthesis');

  const named = entities.length;
  const working = entities.filter(e => {
    const d = describeEntity(e, state);
    return d && (d.id === 'settled' || d.id === 'reworked');
  }).length;

  const connected = entities.filter(e =>
    (state.connections || []).some(c => c.source === e._anchor || c.target === e._anchor)).length;

  const parts = [];
  if (held > 0) parts.push(`${held} held`);

  if (named === 0) {
    parts.push('nothing named yet');
  } else {
    parts.push(`${named} named`);
    if (working > 0) parts.push(`${working} working`);
    else if (connected === 0 && named > 1) parts.push('nothing connected');
  }

  return { line: parts.join(', '), named, working, connected, held };
}
