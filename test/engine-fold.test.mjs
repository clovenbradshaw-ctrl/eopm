/* Tests for the fold in public/engine.js — the one the UI renders from.
 *
 * There are two folds in this repo and it matters which is which: `src/fold.js`
 * belongs to the Matrix bridge, and `public/engine.js` is what app.jsx calls
 * (`ME.fold`) to project the state every view draws. A fix applied to one and
 * not the other is invisible in the UI, so the out-of-order-write behaviour is
 * pinned down on BOTH (see test/drive.test.mjs for the bridge's copy).
 *
 * The failure these guard against was live, not theoretical: uploading a
 * 47 MB file emitted `INS _doc`, `DEF file`, `DEF uploaded_at` as three sends,
 * and the homeserver stamped `origin_server_ts` on receipt — returning the
 * DEFs seconds AHEAD of the INS that creates their entity. Both DEFs were
 * dropped as `missing_ins`, so the document lost the media reference that
 * makes its bytes readable while the bytes themselves sat safely on the
 * media store.
 *
 *   node test/engine-fold.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// engine.js is a browser IIFE assigning window.MatrixEngine; load the shipped
// file through a window shim so the file under test is the file that ships.
const here = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(join(here, '..', 'public', 'engine.js'), 'utf8'))(win);
const ME = win.MatrixEngine;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

// engine.js namespaces its event types; pin it so the fixtures line up.
const NS = 'demo.tasks';
ME.setNamespace(NS);
const base = 1_700_000_000_000;
const ev = (op, content, ts, id) =>
  ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender: '@ada:example.org', event_id: id });

await test('a DEF stamped seconds before its own INS still lands', () => {
  // The exact shape observed live: DEF file at t+0, DEF uploaded_at at t+1965,
  // INS at t+2148.
  const anchor = '_doc_late_ins';
  const state = ME.fold([
    ev('def', { anchor, path: 'file', value: { __media: 3, parts: [{ mxc: 'mxc://a/1' }, { mxc: 'mxc://a/2' }] } }, base, '$d1'),
    ev('def', { anchor, path: 'uploaded_at', value: '2026-08-27T00:00:00.000Z' }, base + 1965, '$d2'),
    ev('ins', { anchor, entity_type: '_doc', payload: { name: 'call.m4a', size: 48997205 } }, base + 2148, '$i1'),
  ]);
  const doc = state.entities[anchor];
  assert.ok(doc, 'the INS must be applied');
  assert.ok(doc.file, 'the media reference must survive an out-of-order arrival');
  eq(doc.file.parts.length, 2);
  eq(doc.uploaded_at, '2026-08-27T00:00:00.000Z');
  eq(doc.name, 'call.m4a');
});

await test('the recovered write is reported, but marked recovered', () => {
  const anchor = '_doc_x';
  const state = ME.fold([
    ev('def', { anchor, path: 'file', value: { mxc: 'mxc://a/1' } }, base, '$d1'),
    ev('ins', { anchor, entity_type: '_doc', payload: { name: 'a.pdf' } }, base + 10, '$i1'),
  ]);
  eq(state._violations.length, 1);
  eq(state._violations[0]._recovered, true);
});

await test('a write whose INS never arrives stays an open violation', () => {
  const state = ME.fold([
    ev('def', { anchor: '_doc_orphan', path: 'file', value: {} }, base, '$d1'),
  ]);
  eq(state._violations.length, 1);
  eq(state._violations[0]._recovered, undefined);
  eq(state.entities['_doc_orphan'], undefined);
});

await test('a SEG that beats its INS is replayed, not lost', () => {
  const anchor = 'row_seg';
  const state = ME.fold([
    ev('seg', { anchor, partition: 'done' }, base, '$s1'),
    ev('ins', { anchor, entity_type: 'task', payload: { title: 'ship it' } }, base + 500, '$i1'),
  ]);
  eq(state.partitions[anchor], 'done');
  eq(state.entities[anchor]._partition, 'done');
});

await test('parked writes replay in arrival order, so last write still wins', () => {
  const anchor = 'row_order';
  const state = ME.fold([
    ev('def', { anchor, path: 'Name', value: 'first' }, base, '$d1'),
    ev('def', { anchor, path: 'Name', value: 'second' }, base + 5, '$d2'),
    ev('ins', { anchor, entity_type: 'row', payload: {} }, base + 9, '$i1'),
  ]);
  eq(state.entities[anchor].Name, 'second');
});

await test('the cursor ends at the newest event, not the replayed one', () => {
  const anchor = 'row_cursor';
  const state = ME.fold([
    ev('def', { anchor, path: 'Name', value: 'x' }, base, '$d1'),
    ev('ins', { anchor, entity_type: 'row', payload: {} }, base + 4000, '$i1'),
  ]);
  eq(state.cursor, base + 4000);
});

await test('an in-order log behaves exactly as before', () => {
  const anchor = 'row_normal';
  const state = ME.fold([
    ev('ins', { anchor, entity_type: 'row', payload: { Name: 'a' } }, base, '$i1'),
    ev('def', { anchor, path: 'Name', value: 'b' }, base + 1, '$d1'),
    ev('seg', { anchor, partition: 'doing' }, base + 2, '$s1'),
  ]);
  eq(state.entities[anchor].Name, 'b');
  eq(state.partitions[anchor], 'doing');
  eq(state._violations, []);
});

await test('a bulk import drains writes parked against its rows', () => {
  // Imported rows get their entities from one bulk INS; a DEF that landed
  // against a row before that event must still apply.
  const rowAnchor = 'imp#r0';
  const state = ME.fold([
    ev('def', { anchor: rowAnchor, path: 'Status', value: 'checked' }, base, '$d1'),
    ev('ins', { anchor: 'imp', entity_type: 'case', rows: [{ _anchor: rowAnchor, Name: 'Acme' }] }, base + 10, '$i1'),
  ]);
  eq(state.entities[rowAnchor].Name, 'Acme');
  eq(state.entities[rowAnchor].Status, 'checked');
});

// ── Exactly-once ─────────────────────────────────────────────────────────

await test('the same event applied twice is the same as once', () => {
  // The live timeline and the durable block chain both carry an event, and a
  // backfill page can overlap what is already held — so a room's event list
  // really does contain duplicates. Replaying them must not change the state.
  const anchor = 'row_dup';
  const events = [
    ev('ins', { anchor, entity_type: 'row', payload: { Name: 'a' } }, base, '$i1'),
    ev('def', { anchor, path: 'Name', value: 'b' }, base + 1, '$d1'),
    ev('con', { source_anchor: anchor, target_anchor: anchor, relation_type: 'self' }, base + 2, '$c1'),
    ev('eva', { anchor, criterion: 'ok', result: true }, base + 3, '$e1'),
  ];
  const once = ME.fold(events);
  const twice = ME.fold([...events, ...events]);
  eq(twice.entities[anchor].Name, once.entities[anchor].Name);
  eq(twice.connections.length, once.connections.length);
  eq(twice.entities[anchor]._evaluations.length, once.entities[anchor]._evaluations.length);
});

await test('a repeated INS never resets an entity its DEFs already updated', () => {
  // The shape that shipped: the room held INS/DEF/DEF twice over. Folding the
  // second INS as a fresh entity wiped the media reference the DEFs had
  // applied, so a 47 MB upload became a document with no bytes behind it.
  const anchor = '_doc_repeat';
  const insEvent = ev('ins', { anchor, entity_type: '_doc', payload: { name: 'call.m4a' } }, base + 2739, '$i1');
  const state = ME.fold([
    ev('def', { anchor, path: 'file', value: { __media: 3, parts: [{ mxc: 'a' }, { mxc: 'b' }] } }, base, '$d1'),
    ev('def', { anchor, path: 'uploaded_at', value: 'T' }, base + 2556, '$d2'),
    insEvent,
    ev('def', { anchor, path: 'file', value: { __media: 3, parts: [{ mxc: 'a' }, { mxc: 'b' }] } }, base + 2559, '$d1'),
    ev('def', { anchor, path: 'uploaded_at', value: 'T' }, base + 2713, '$d2'),
    { ...insEvent, origin_server_ts: base + 2882 },
  ]);
  const doc = state.entities[anchor];
  assert.ok(doc.file, 'the second INS must not clobber the DEF that carries the media reference');
  eq(doc.file.parts.length, 2);
  eq(doc.uploaded_at, 'T');
});

await test('an INS after a DEF fills only what is genuinely absent', () => {
  const anchor = 'row_fill';
  const state = ME.fold([
    ev('ins', { anchor, entity_type: 'row', payload: { Name: 'a', Note: 'keep' } }, base, '$i1'),
    ev('def', { anchor, path: 'Name', value: 'edited' }, base + 1, '$d1'),
    ev('ins', { anchor, entity_type: 'row', payload: { Name: 'a', Note: 'keep', Extra: 'new' } }, base + 2, '$i2'),
  ]);
  eq(state.entities[anchor].Name, 'edited');   // the edit survives
  eq(state.entities[anchor].Note, 'keep');
  eq(state.entities[anchor].Extra, 'new');     // a genuinely new key lands
});

console.log(`\nall ${passed} engine-fold checks passed`);
