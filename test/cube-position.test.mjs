/* Tests for src/cube-position.js — the cube rendered as a read-only
 * projection over real fold state.
 *
 *   node test/cube-position.test.mjs
 */
import assert from 'node:assert';

// The real fold is what the app projects state with, so positions are
// checked against it rather than a hand-rolled reducer. fold.js reaches
// operators.js, which reaches the browser-only network/outbox modules at
// import time — stub the two globals their top level touches, then import
// for real (same pattern as test/drive.test.mjs).
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB ??= { open() { return { addEventListener() {} }; } };
const { fold } = await import('../src/fold.js');
const { positionOf, lawfulNext, gapsOf } = await import('../src/cube-position.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

const NS = 'io.matrix-events';
const base = 1_700_000_000_000;
let seq = 0;
const ev = (op, content, ts, sender = '@ada:example.org') =>
  ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender, event_id: `$e${seq++}` });

// ── positionOf ──────────────────────────────────────────────────────────

await test('a fresh INS sits at Existence · Pattern', () => {
  const anchor = 'task_a';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: { title: 'ship it' } }, base),
  ]);
  const pos = positionOf(state.entities[anchor], state);
  eq(pos.domain, 'Existence');
  eq(pos.grain, 'Pattern');
  eq(pos.terrain, 'Kind');
  eq(pos.occupied, { Existence: ['ins'], Structure: [], Interpretation: [] });
});

await test('SEG advances position into Structure · Ground', () => {
  const anchor = 'task_b';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('seg', { anchor, partition: 'backlog' }, base + 1),
  ]);
  const pos = positionOf(state.entities[anchor], state);
  eq(pos.domain, 'Structure');
  eq(pos.grain, 'Ground');
  eq(pos.terrain, 'Placement');
  eq(pos.occupied.Structure, ['seg']);
});

await test('occupied tracks what actually fired, not just how far _hwm reached', () => {
  // INS → DEF → EVA skips SEG/CON/SYN entirely. _hwm lands on EVA, but
  // Structure must report nothing fired.
  const anchor = 'task_c';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('def', { anchor, path: 'title', value: 'skip structure' }, base + 1),
    ev('eva', { anchor, criterion: 'ready', result: true }, base + 2),
  ]);
  const entity = state.entities[anchor];
  eq(entity._hwm, 7); // EVA.order
  const pos = positionOf(entity, state);
  eq(pos.domain, 'Interpretation');
  eq(pos.grain, 'Figure');
  eq(pos.occupied.Structure, []);
  eq(pos.occupied.Interpretation, ['def', 'eva']);
});

await test('CON registers on both endpoints even though _hwm alone cannot distinguish it from SYN', () => {
  const a = 'task_d', b = 'task_e';
  const state = fold([
    ev('ins', { anchor: a, entity_type: 'task', payload: {} }, base),
    ev('ins', { anchor: b, entity_type: 'task', payload: {} }, base + 1),
    ev('con', { source_anchor: a, target_anchor: b, relation_type: 'blocks' }, base + 2),
  ]);
  eq(positionOf(state.entities[a], state).occupied.Structure, ['con']);
  eq(positionOf(state.entities[b], state).occupied.Structure, ['con']);
});

await test('a REC in an entity\'s scope shows up in occupied even though REC never advances _hwm', () => {
  // REC carries no anchor (fold.js applies it workspace-wide, to
  // state.frames, not to any one entity's _hwm) — so the *position*
  // (domain/grain, read off _hwm) stays wherever EVA left it, while
  // *occupied* — which scans frames for this anchor independently —
  // correctly reports the REC as fired.
  const anchor = 'task_f';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('def', { anchor, path: 'title', value: 'x' }, base + 1),
    ev('eva', { anchor, criterion: 'ready', result: true }, base + 2),
    ev('rec', { scope: anchor, before_frame: { a: 1 }, after_frame: { a: 2 } }, base + 3),
  ]);
  const entity = state.entities[anchor];
  eq(entity._hwm, 7); // EVA.order — REC never bumps it
  const pos = positionOf(entity, state);
  eq(pos.domain, 'Interpretation');
  eq(pos.grain, 'Figure');
  eq(pos.occupied.Interpretation, ['def', 'eva', 'rec']);
});

// ── lawfulNext ──────────────────────────────────────────────────────────

await test('lawfulNext at _hwm = INS.order returns [SEG, CON] — the spec\'s worked example', () => {
  const anchor = 'task_g';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
  ]);
  const next = lawfulNext(state.entities[anchor], state).map(n => n.key);
  eq(next, ['seg', 'con']);
});

await test('lawfulNext with a Network and a DEF returns [EVA] — the spec\'s other worked example', () => {
  const a = 'n_a', b = 'n_b';
  const state = fold([
    ev('ins', { anchor: a, entity_type: 'task', payload: {} }, base),
    ev('ins', { anchor: b, entity_type: 'task', payload: {} }, base + 1),
    ev('con', { source_anchor: a, target_anchor: b, relation_type: 'relates' }, base + 2),
    ev('syn', { input_anchors: [a, b], output: { title: 'network' } }, base + 3),
    ev('def', { anchor: a, path: 'title', value: 'defined' }, base + 4),
  ]);
  const next = lawfulNext(state.entities[a], state).map(n => n.key);
  eq(next, ['eva']);
});

await test('lawfulNext never returns an operator whose dependency is unmet', () => {
  // SYN needs some structure to synthesize from; on a bare INS it must not
  // appear even though it comes right after CON in dependency order.
  const anchor = 'task_h';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
  ]);
  const keys = lawfulNext(state.entities[anchor], state).map(n => n.key);
  assert.ok(!keys.includes('syn'), 'SYN offered with no structure yet');
  assert.ok(!keys.includes('def'), 'DEF offered ahead of an unmet SYN gate');
  assert.ok(!keys.includes('eva'), 'EVA offered with no DEF fired');
  assert.ok(!keys.includes('rec'), 'REC offered with no EVA fired');
});

await test('lawfulNext offers SYN once some structure exists', () => {
  const anchor = 'task_i';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('seg', { anchor, partition: 'backlog' }, base + 1),
  ]);
  const keys = lawfulNext(state.entities[anchor], state).map(n => n.key);
  eq(keys, ['con', 'syn', 'def']);
});

await test('a synthesis-only entity (never DEF\'d, never EVA\'d) closes at REC-eligible only through EVA', () => {
  const anchor = 'task_j';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('def', { anchor, path: 'title', value: 'x' }, base + 1),
  ]);
  const keys = lawfulNext(state.entities[anchor], state).map(n => n.key);
  eq(keys, ['eva']);
});

// ── gapsOf ──────────────────────────────────────────────────────────────

await test('gapsOf on a fresh INS reports early, not stuck, with no rhythm supplied', () => {
  const anchor = 'task_k';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
  ]);
  const gaps = gapsOf(state.entities[anchor], state, null);
  eq(gaps.length, 6); // seg, con, syn, def, eva, rec all unfired
  assert.ok(gaps.every(g => g.status === 'early'), 'a gap was reported as anything but early with no rhythm');
  assert.ok(!gaps.some(g => g.status === 'stuck'), 'gapsOf must never say "stuck" — that is unblock.js\'s job');
});

await test('gapsOf omits cells that have actually fired', () => {
  const anchor = 'task_l';
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, base),
    ev('seg', { anchor, partition: 'backlog' }, base + 1),
  ]);
  const gaps = gapsOf(state.entities[anchor], state, null);
  const ops = gaps.map(g => g.op);
  assert.ok(!ops.includes('seg'), 'SEG reported as a gap after it fired');
  eq(ops.length, 5);
});

await test('gapsOf marks a gap "open" once it outlives a measured rhythm', () => {
  const anchor = 'task_m';
  const oldTs = base - 10_000_000; // far in the past relative to "now"
  const state = fold([
    ev('ins', { anchor, entity_type: 'task', payload: {} }, oldTs),
  ]);
  const rhythm = { median: 1000 }; // 1 second — trivially exceeded by a real clock gap
  const gaps = gapsOf(state.entities[anchor], state, rhythm);
  assert.ok(gaps.every(g => g.status === 'open'), 'an old entity against a tight rhythm was still called early');
});

console.log(`\nall ${passed} cube-position checks passed`);
