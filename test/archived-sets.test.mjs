/* Tests for archiving a SET — the table-level twin of a row's `_archived` DEF.
 *
 * The promise in both cases is the same one the whole architecture rests on:
 * the log is append-only, so nothing is destroyed. Archiving writes a schema
 * fact (`_schema.archived`) that hides a set from the default listing; its
 * rows, its saved views and its history are all still there, and scrubbing the
 * time-travel cursor back to before the archive shows the set right where it
 * was.
 *
 * Two surfaces have to agree on what "hidden" means — the sidebar's set list
 * and the sets "Ask your data" will answer from — so both are checked here.
 *
 *   node test/archived-sets.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

// Both files are browser IIFEs assigning onto window; load the shipped files
// through a shared window shim, the way the page does — data-chat.js reads
// window.MatrixEngine for the archived list, so they must see each other.
const win = { console };
new Function('window', 'console', read('public/engine.js'))(win, console);
new Function('window', 'console', read('public/data-chat.js'))(win, console);
const ME = win.MatrixEngine;
const DC = win.DataChat;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

const NS = 'demo.tasks';
ME.setNamespace(NS);
let clock = 1_700_000_000_000;
const ev = (op, content) =>
  ({ type: `${NS}.${op}`, content, origin_server_ts: clock++, sender: '@ada:x', event_id: `$e${clock}` });

/** A workspace with two sets, each holding a row. */
function workspace() {
  return [
    ev('def', { anchor: null, path: '_schema.tables', value: ['case', 'note'] }),
    ev('def', { anchor: null, path: '_schema.fields.case', value: [{ name: 'Name', type: 'text' }] }),
    ev('def', { anchor: null, path: '_schema.fields.note', value: [{ name: 'Body', type: 'text' }] }),
    ev('ins', { anchor: 'case_1', entity_type: 'case', payload: { Name: 'Acme v. Roe' } }),
    ev('ins', { anchor: 'note_1', entity_type: 'note', payload: { Body: 'called back' } }),
  ];
}

// ── The schema fact ──────────────────────────────────────────────────────

await test('a fresh workspace has nothing archived', () => {
  eq(ME.archivedSets(ME.fold(workspace())), []);
  eq(ME.archivedSets({}), []);
  eq(ME.archivedSets(null), []);
});

await test('archiving is a schema DEF, and it round-trips through the fold', () => {
  const events = workspace();
  let state = ME.fold(events);
  events.push(ev('def', { anchor: null, path: '_schema.archived', value: ME.withArchivedSet(state, 'note', true) }));
  state = ME.fold(events);
  eq(ME.archivedSets(state), ['note']);
  eq(ME.isArchivedSet(state, 'note'), true);
  eq(ME.isArchivedSet(state, 'case'), false);
});

await test('archiving keeps every row, field and anchor', () => {
  const events = workspace();
  events.push(ev('def', { anchor: null, path: '_schema.archived', value: ['note'] }));
  const state = ME.fold(events);
  // The set is hidden, not emptied: this is the whole point of the design.
  eq(state.entities['note_1'].Body, 'called back');
  eq(state.schema.fields.note.length, 1);
  eq(state.schema.tables, ['case', 'note']);
});

await test('restoring removes the name and leaves the rest alone', () => {
  const events = workspace();
  events.push(ev('def', { anchor: null, path: '_schema.archived', value: ['case', 'note'] }));
  let state = ME.fold(events);
  events.push(ev('def', { anchor: null, path: '_schema.archived', value: ME.withArchivedSet(state, 'note', false) }));
  state = ME.fold(events);
  eq(ME.archivedSets(state), ['case']);
});

await test('archiving twice does not duplicate the name', () => {
  const state = ME.fold([...workspace(), ev('def', { anchor: null, path: '_schema.archived', value: ['note'] })]);
  eq(ME.withArchivedSet(state, 'note', true), ['note']);
});

await test('restoring something that was never archived is a no-op', () => {
  const state = ME.fold(workspace());
  eq(ME.withArchivedSet(state, 'note', false), []);
});

await test('a malformed archived value is read as nothing archived', () => {
  // The log is permissive — a bad DEF must not take the sidebar down with it.
  eq(ME.archivedSets({ schema: { archived: 'note' } }), []);
  eq(ME.archivedSets({ schema: { archived: ['note', 42, null] } }), ['note']);
});

await test('time-travel shows the set unarchived before the archive event', () => {
  const events = workspace();
  const beforeArchive = ME.fold(events);
  events.push(ev('def', { anchor: null, path: '_schema.archived', value: ['note'] }));
  eq(ME.isArchivedSet(beforeArchive, 'note'), false);
  eq(ME.isArchivedSet(ME.fold(events), 'note'), true);
});

// ── What "Ask your data" will answer from ────────────────────────────────

await test('Ask sees both sets while neither is archived', () => {
  const types = DC.knownTypes(ME.fold(workspace())).sort();
  eq(types, ['case', 'note']);
});

await test('Ask stops answering from an archived set', () => {
  // A set hidden from the rail turning up in an answer is the same surprise
  // as one that reappears in the rail.
  const events = [...workspace(), ev('def', { anchor: null, path: '_schema.archived', value: ['note'] })];
  eq(DC.knownTypes(ME.fold(events)), ['case']);
});

await test('Ask never sees the drive or other internal sets', () => {
  const events = [
    ...workspace(),
    ev('ins', { anchor: '_doc_1', entity_type: '_doc', payload: { name: 'lease.pdf' } }),
    ev('ins', { anchor: '_folder_1', entity_type: '_folder', payload: { name: 'exhibits' } }),
  ];
  const types = DC.knownTypes(ME.fold(events)).sort();
  eq(types, ['case', 'note']);
});

console.log(`\nall ${passed} archived-set checks passed`);
