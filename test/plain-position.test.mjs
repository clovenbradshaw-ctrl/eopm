/* Tests for src/plain-position.js — saying where something stands without
 * making anyone learn a vocabulary first.
 *
 *   node test/plain-position.test.mjs
 *
 * The load-bearing test is the last one: a repo-wide guard that no piece of
 * canon vocabulary can reach a user-facing string. Everything else here is
 * about picking the right sentence.
 */
import assert from 'node:assert';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB ??= { open() { return { addEventListener() {} }; } };
const { fold } = await import('../src/fold.js');
const { describeEntity, describeFinding, describeWorkspace, titleOf } = await import('../src/plain-position.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const NS = 'io.matrix-events';
const base = 1_700_000_000_000;
let seq = 0;
const ev = (op, content, ts = base, sender = '@ada:example.org') =>
  ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender, event_id: `$e${seq++}` });

const insOf = (anchor, payload = {}) => ev('ins', { anchor, entity_type: 'task', payload });

// ── the ladder ─────────────────────────────────────────────────────────

await test('a freshly named thing says so, and offers one way forward', () => {
  const state = fold([insOf('t1', { Title: 'Handoff Notes' })]);
  const d = describeEntity(state.entities.t1, state);
  assert.strictEqual(d.id, 'fresh');
  assert.strictEqual(d.chip, 'named, nothing else yet');
  assert.ok(d.headline.includes("doesn't depend on anything"));
  assert.strictEqual(d.action.op, 'con');
});

await test('something connected but never pulled together says so', () => {
  const state = fold([
    insOf('a'), insOf('b'),
    ev('con', { source_anchor: 'a', target_anchor: 'b', relation_type: 'needs' }),
    ev('def', { anchor: 'a', path: 'Title', value: 'Change log' }),
  ]);
  const d = describeEntity(state.entities.a, state);
  assert.strictEqual(d.id, 'scattered');
  assert.strictEqual(d.action.op, 'syn');
});

await test('written down but never checked says so', () => {
  const state = fold([
    insOf('a'), insOf('b'),
    ev('con', { source_anchor: 'a', target_anchor: 'b', relation_type: 'needs' }),
    ev('syn', { input_anchors: ['a', 'b'], output: { Title: 'together' } }),
    ev('def', { anchor: 'a', path: 'Title', value: 'Change log' }),
  ]);
  const d = describeEntity(state.entities.a, state);
  assert.strictEqual(d.id, 'untested');
  assert.strictEqual(d.action.op, 'eva');
});

await test('a checked thing offers NO action — a good state needs no next step', () => {
  const state = fold([
    insOf('a'), insOf('b'),
    ev('con', { source_anchor: 'a', target_anchor: 'b', relation_type: 'needs' }),
    ev('syn', { input_anchors: ['a', 'b'], output: { Title: 'together' } }),
    ev('def', { anchor: 'a', path: 'Title', value: 'Change log' }),
    ev('eva', { anchor: 'a', criterion: 'ships', result: 'pass' }),
  ]);
  const d = describeEntity(state.entities.a, state);
  assert.strictEqual(d.id, 'settled');
  assert.strictEqual(d.action, null, 'a tool that always has a next step will invent one');
});

await test('every rung offers at most one action', () => {
  const states = [
    fold([insOf('a')]),
    fold([insOf('a'), ev('def', { anchor: 'a', path: 'Title', value: 'x' })]),
  ];
  for (const state of states) {
    const d = describeEntity(state.entities.a, state);
    assert.ok(d.action === null || typeof d.action.label === 'string');
  }
});

// ── findings ───────────────────────────────────────────────────────────

await test('a two-way deadlock reads as a sentence, naming both things', () => {
  const state = fold([
    insOf('a', { Title: 'Change log' }),
    insOf('b', { Title: 'Auto-summary' }),
  ]);
  const line = describeFinding({ type: 'cycle', path: ['a', 'b', 'a'], relation: 'blocks' }, state);
  assert.ok(line.includes('Change log'), 'should use the human name, not the anchor');
  assert.ok(line.includes('Auto-summary'));
  assert.ok(line.includes('Neither can go first'));
  assert.ok(!/\bCON\b|\bcycle\b/i.test(line), `leaked machinery: ${line}`);
});

await test('a longer ring reads as a ring', () => {
  const state = fold([insOf('a', { Title: 'A' }), insOf('b', { Title: 'B' }), insOf('c', { Title: 'C' })]);
  const line = describeFinding({ type: 'cycle', path: ['a', 'b', 'c', 'a'], relation: 'blocks' }, state);
  assert.ok(line.includes('A') && line.includes('B') && line.includes('C'));
  assert.ok(line.includes('Nothing in that ring can start'));
});

await test('an unrecognised finding shape yields null rather than a guess', () => {
  assert.strictEqual(describeFinding({ type: 'something-new' }, {}), null);
  assert.strictEqual(describeFinding(null, {}), null);
});

// ── workspace line ─────────────────────────────────────────────────────

await test('an empty workspace says nothing is named, and counts what is held', () => {
  const w = describeWorkspace(fold([]), { held: 7 });
  assert.strictEqual(w.named, 0);
  assert.ok(w.line.includes('7 held'));
  assert.ok(w.line.includes('nothing named yet'));
  assert.ok(!/%|\bstage\b|\bphase\b/i.test(w.line), 'no invented progress');
});

await test('several named but unconnected things say exactly that', () => {
  const state = fold([insOf('a'), insOf('b'), insOf('c')]);
  const w = describeWorkspace(state, { held: 12 });
  assert.strictEqual(w.named, 3);
  assert.strictEqual(w.connected, 0);
  assert.ok(w.line.includes('3 named'));
  assert.ok(w.line.includes('nothing connected'));
});

await test('titleOf prefers a human name and falls back to the anchor', () => {
  assert.strictEqual(titleOf({ Title: 'Handoff', _anchor: 'x' }), 'Handoff');
  assert.strictEqual(titleOf({ _anchor: 'task_9f' }), 'task_9f');
  assert.strictEqual(titleOf(null), 'this');
});

// ── the guard ──────────────────────────────────────────────────────────

await test('NO canon vocabulary can reach a user-facing string', () => {
  // Every word here is correct machinery and wrong interface. Someone
  // trying to ship a product should never have to meet any of it.
  const BANNED = [
    'existence', 'structure', 'interpretation', 'significance',
    'ground', 'figure', 'pattern', 'terrain', 'stance', 'grain', 'domain',
    'clearing', 'entity', 'kind', 'placement', 'link', 'network',
    'claim', 'verdict', 'frame', 'operator', 'anchor', 'fold', 'cube',
    'differentiate', 'relate', 'generate', 'distinguishing', 'linking', 'composing',
    'nul', 'sig', 'ins', 'seg', 'con', 'syn', 'def', 'eva', 'rec',
    'instantiate', 'segment', 'synthesize', 'recontextualize', 'hwm',
  ];

  const states = [
    fold([insOf('a')]),
    fold([insOf('a'), ev('def', { anchor: 'a', path: 'Title', value: 'x' })]),
    fold([insOf('a'), insOf('b'), ev('con', { source_anchor: 'a', target_anchor: 'b', relation_type: 'needs' })]),
    fold([insOf('a'), insOf('b'), ev('con', { source_anchor: 'a', target_anchor: 'b', relation_type: 'needs' }),
      ev('syn', { input_anchors: ['a', 'b'], output: { Title: 'together' } }),
      ev('def', { anchor: 'a', path: 'Title', value: 'x' }),
      ev('eva', { anchor: 'a', criterion: 'c', result: 'pass' })]),
  ];

  const strings = [];
  for (const state of states) {
    for (const e of Object.values(state.entities)) {
      const d = describeEntity(e, state);
      if (!d) continue;
      strings.push(d.chip, d.headline);
      if (d.action) strings.push(d.action.label);
    }
    strings.push(describeWorkspace(state, { held: 3 }).line);
  }
  strings.push(describeFinding({ type: 'cycle', path: ['a', 'b', 'a'], relation: 'blocks' }, states[2]));
  strings.push(describeFinding({ type: 'uniqueness', holder: 'a', conflicting: ['b', 'c'], relation: 'owner' }, states[2]));

  for (const s of strings.filter(Boolean)) {
    for (const word of BANNED) {
      const hit = new RegExp(`\\b${word}\\b`, 'i').test(s);
      assert.ok(!hit, `canon word "${word}" reached the interface in: "${s}"`);
    }
  }
});

console.log(`\nall ${passed} plain-position checks passed`);
