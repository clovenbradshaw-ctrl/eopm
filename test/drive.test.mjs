/* Tests for public/drive.js — the document store as a projection of the log.
 *
 * The load-bearing claim this file pins down is the one the drive is built
 * around: a document is referenced by records, never contained by them. So
 * detaching a file from a record must write ONLY to that record, leaving the
 * document — its folder, its bytes, and every other record pointing at it —
 * untouched. Everything else here is the folder tree and the reverse index
 * that makes "attached to" answerable.
 *
 *   node test/drive.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// The real fold is what the app projects state with, so the drive is checked
// against it rather than a hand-rolled reducer. fold.js reaches operators.js,
// which reaches the browser-only network/outbox modules at import time — so
// stub the two globals their top level touches, then import for real.
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB ??= { open() { return { addEventListener() {} }; } };
const { fold } = await import('../src/fold.js');

// drive.js is a browser IIFE that assigns window.Drive; load the shipped file
// through a window shim so the file under test is the file that ships.
const here = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(join(here, '..', 'public', 'drive.js'), 'utf8'))(win);
const Drive = win.Drive;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

// ── A room that records what was emitted and folds it, like the app does ──

const NS = 'io.matrix-events';
const OP = {
  INS: { key: 'ins', order: 2 },
  SEG: { key: 'seg', order: 3 },
  DEF: { key: 'def', order: 6 },
};

function makeRoom() {
  const events = [];
  let ts = 1_700_000_000_000;
  const ME = {
    OP,
    // Deterministic stand-in for engine.js's content-addressed anchor: the
    // identity is a hash of the creation content, so two different payloads
    // must not collide.
    makeAnchor: (type, payload, sender, at) => `${type}_${createHash('sha256')
      .update(`${type}|${JSON.stringify(payload)}|${sender}|${at}`).digest('hex').slice(0, 10)}`,
  };
  const ctx = {
    ME,
    sender: '@ada:example.org',
    emit(op, content) {
      events.push({
        type: `${NS}.${op.key}`,
        content,
        origin_server_ts: ts++,
        sender: '@ada:example.org',
        event_id: `$e${events.length}`,
      });
    },
  };
  return {
    ctx,
    events,
    state: () => fold(events),
    /** Declare a table with an attachment field, the way the schema editor does. */
    declareTable(type, fields) {
      ctx.emit(OP.DEF, { anchor: null, path: `_schema.fields.${type}`, value: fields });
    },
    addRecord(type, payload) {
      const anchor = ME.makeAnchor(type, payload, ctx.sender, ts);
      ctx.emit(OP.INS, { anchor, entity_type: type, payload });
      return anchor;
    },
  };
}

const ref = (n) => ({ __media: 2, mxc: `mxc://x/${n}`, mime: 'application/pdf', size: 100, name: n });

// ── Folders ──────────────────────────────────────────────────────────────

await test('documents and folders never surface as user sets', async () => {
  // buildSets() filters `_`-prefixed types; the drive relies on that to stay
  // out of the sidebar, so the constants must keep the prefix.
  assert.ok(Drive.DOC_TYPE.startsWith('_'));
  assert.ok(Drive.FOLDER_TYPE.startsWith('_'));
});

await test('folders nest and the breadcrumb reads root-first', async () => {
  const room = makeRoom();
  const cases = await Drive.createFolder(room.ctx, { name: 'cases' });
  const acme = await Drive.createFolder(room.ctx, { name: 'acme', parent: cases });
  const deep = await Drive.createFolder(room.ctx, { name: 'exhibits', parent: acme });
  const state = room.state();
  eq(Drive.folderPath(state, deep).map(f => f.name), ['cases', 'acme', 'exhibits']);
  eq(Drive.foldersIn(state, cases).map(f => f.name), ['acme']);
  eq(Drive.foldersIn(state, null).map(f => f.name), ['cases']);
  eq(Drive.descendantFolders(state, cases).sort(), [acme, deep].sort());
});

await test('a folder cannot be moved inside itself or its own descendant', async () => {
  const room = makeRoom();
  const a = await Drive.createFolder(room.ctx, { name: 'a' });
  const b = await Drive.createFolder(room.ctx, { name: 'b', parent: a });
  const other = await Drive.createFolder(room.ctx, { name: 'other' });
  const state = room.state();
  eq(Drive.wouldCycle(state, a, a), true);
  eq(Drive.wouldCycle(state, a, b), true);      // a under its own child
  eq(Drive.wouldCycle(state, a, other), false);
  eq(Drive.wouldCycle(state, a, null), false);  // back to the root is fine
});

await test('folderPath survives a parent cycle instead of hanging', async () => {
  // Two people move folders past each other; the log can end up with a loop.
  // The breadcrumb has to terminate anyway.
  const room = makeRoom();
  const a = await Drive.createFolder(room.ctx, { name: 'a' });
  const b = await Drive.createFolder(room.ctx, { name: 'b', parent: a });
  Drive.moveFolder(room.ctx, a, b);
  const path = Drive.folderPath(room.state(), b);
  assert.ok(path.length <= 2, `expected a bounded path, got ${path.length}`);
});

await test('documents file into folders and move between them', async () => {
  const room = makeRoom();
  const inbox = await Drive.createFolder(room.ctx, { name: 'inbox' });
  const doc = await Drive.createDoc(room.ctx, { name: 'lease.pdf', ref: ref('a'), folder: null });
  eq(Drive.docsIn(room.state(), null).map(d => d.name), ['lease.pdf']);
  Drive.moveDoc(room.ctx, doc, inbox);
  eq(Drive.docsIn(room.state(), null), []);
  eq(Drive.docsIn(room.state(), inbox).map(d => d.name), ['lease.pdf']);
});

await test('the media ref rides in its own DEF, not the anchored payload', async () => {
  // The anchor is the hash of the INS payload. Keeping the per-upload file
  // envelope out of it is what makes re-adding the same file idempotent.
  const room = makeRoom();
  await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a'), folder: null });
  const ins = room.events.find(e => e.type.endsWith('.ins'));
  eq(Object.keys(ins.content.payload).sort(), ['folder', 'mime', 'name', 'size']);
  const fileDef = room.events.find(e => e.type.endsWith('.def') && e.content.path === 'file');
  eq(fileDef.content.value.mxc, 'mxc://x/a');
});

await test('trash hides a document; restore brings it back', async () => {
  const room = makeRoom();
  const doc = await Drive.createDoc(room.ctx, { name: 'draft.pdf', ref: ref('a') });
  Drive.trash(room.ctx, doc);
  eq(Drive.allDocs(room.state()), []);
  eq(Drive.allDocs(room.state(), { includeTrashed: true }).length, 1);
  Drive.restore(room.ctx, doc);
  eq(Drive.allDocs(room.state()).map(d => d.name), ['draft.pdf']);
});

await test('a same-millisecond INS + DEF burst folds in dependency order', async () => {
  // Creating a document emits INS _doc, DEF file, DEF uploaded_at back to
  // back — all three land on the same `Date.now()`. If the fold tie-breaks
  // those on event_id, the DEF can sort ahead of the INS that creates its
  // entity, and the document silently loses the media reference that makes
  // it readable. This reproduces that burst with event ids that sort BACKWARDS
  // against emit order, which is the half of the coin flip that used to break.
  const events = [];
  const ts = 1_700_000_000_000;                     // one millisecond, all three
  const anchor = '_doc_same_ms';
  const push = (op, content, id) =>
    events.push({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender: '@ada:x', event_id: id });
  push('ins', { anchor, entity_type: '_doc', payload: { name: 'call.m4a', size: 48997205 } }, '$zzz');
  push('def', { anchor, path: 'file', value: { __media: 3, parts: [{ mxc: 'mxc://a/1' }, { mxc: 'mxc://a/2' }] } }, '$aaa');
  push('def', { anchor, path: 'uploaded_at', value: '2026-08-27T00:00:00.000Z' }, '$bbb');

  const state = fold(events);
  const doc = state.entities[anchor];
  assert.ok(doc, 'the INS must be applied');
  assert.ok(doc.file, 'the file DEF must not be dropped as missing_ins');
  eq(doc.file.parts.length, 2);
  eq(state._violations, []);
  eq(Drive.allDocs(state).length, 1);
});

await test('a same-millisecond tie still keeps last-write-wins per path', async () => {
  // Operator order breaks the tie first; two DEFs to one path share an order,
  // so they must still resolve by event_id exactly as before.
  const ts = 1_700_000_000_000;
  const anchor = 'row_1';
  const ev = (op, content, id) =>
    ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender: '@ada:x', event_id: id });
  const state = fold([
    ev('def', { anchor, path: 'Name', value: 'second' }, '$b'),
    ev('ins', { anchor, entity_type: 'row', payload: {} }, '$c'),
    ev('def', { anchor, path: 'Name', value: 'first' }, '$a'),
  ]);
  eq(state.entities[anchor].Name, 'second');
});

await test('a DEF stamped SECONDS before its own INS still lands', async () => {
  // The failure this actually shipped as. `origin_server_ts` is assigned by
  // the homeserver on RECEIPT, so three sends from one action can come back
  // in any order — observed live: DEF file at t+0, DEF uploaded_at at t+1965,
  // INS at t+2148. Sorting by timestamp put both DEFs ahead of the INS that
  // creates their entity, and the document lost the media reference that
  // makes its bytes readable. The fold parks such a write and replays it.
  const anchor = '_doc_late_ins';
  const base = 1_700_000_000_000;
  const ev = (op, content, ts, id) =>
    ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender: '@ada:x', event_id: id });
  const state = fold([
    ev('def', { anchor, path: 'file', value: { __media: 3, parts: [{ mxc: 'mxc://a/1' }, { mxc: 'mxc://a/2' }] } }, base, '$d1'),
    ev('def', { anchor, path: 'uploaded_at', value: '2026-08-27T00:00:00.000Z' }, base + 1965, '$d2'),
    ev('ins', { anchor, entity_type: '_doc', payload: { name: 'call.m4a', size: 48997205 } }, base + 2148, '$i1'),
  ]);

  const doc = state.entities[anchor];
  assert.ok(doc?.file, 'the media reference must survive an out-of-order arrival');
  eq(doc.file.parts.length, 2);
  eq(doc.uploaded_at, '2026-08-27T00:00:00.000Z');
  eq(Drive.allDocs(state).length, 1);
  // The log really was malformed, so it is still reported — but marked
  // recovered, so a healthy workspace doesn't carry a standing warning.
  eq(state._violations.length, 2);
  assert.ok(state._violations.every(v => v._recovered), 'both violations should be marked recovered');
  // And the cursor still ends at the newest event, not the replayed one.
  eq(state.cursor, base + 2148);
});

await test('a SEG that beats its INS is replayed, not lost', async () => {
  const anchor = '_doc_seg_first';
  const base = 1_700_000_000_000;
  const ev = (op, content, ts, id) =>
    ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender: '@ada:x', event_id: id });
  const state = fold([
    ev('seg', { anchor, partition: Drive.TRASH_PARTITION }, base, '$s1'),
    ev('ins', { anchor, entity_type: '_doc', payload: { name: 'gone.pdf' } }, base + 500, '$i1'),
  ]);
  eq(state.partitions[anchor], Drive.TRASH_PARTITION);
  eq(Drive.allDocs(state), []);                                  // trashed, as intended
  eq(Drive.allDocs(state, { includeTrashed: true }).length, 1);
});

await test('a write whose INS never arrives stays an open violation', async () => {
  const base = 1_700_000_000_000;
  const state = fold([{
    type: `${NS}.def`, content: { anchor: '_doc_orphan', path: 'file', value: {} },
    origin_server_ts: base, sender: '@ada:x', event_id: '$d1',
  }]);
  eq(state._violations.length, 1);
  eq(state._violations[0]._recovered, undefined);
  eq(state.entities['_doc_orphan'], undefined);
});

// ── Attachment: a reference, not a container ─────────────────────────────

await test('detaching a file from a record leaves it in the drive', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Name', type: 'text' }, { name: 'Files', type: 'attachment' }]);
  const folder = await Drive.createFolder(room.ctx, { name: 'exhibits' });
  const doc = await Drive.createDoc(room.ctx, { name: 'lease.pdf', ref: ref('a'), folder });
  const rec = room.addRecord('case', { Name: 'Acme v. Roe' });

  Drive.attach(room.ctx, room.state().entities[rec], 'Files', doc);
  eq(room.state().entities[rec].Files, [doc]);

  const beforeDoc = room.state().entities[doc];
  Drive.detach(room.ctx, room.state().entities[rec], 'Files', doc);

  const after = room.state();
  eq(after.entities[rec].Files, []);                         // the record let go
  eq(Drive.allDocs(after).map(d => d.name), ['lease.pdf']);  // …the file did not
  eq(after.entities[doc].folder, folder);                    // still in its folder
  eq(after.entities[doc].file, beforeDoc.file);              // bytes untouched
  eq(Drive.isTrashed(after, after.entities[doc]), false);
});

await test('detach writes only to the record — the document gets no event', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Files', type: 'attachment' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a') });
  const rec = room.addRecord('case', {});
  Drive.attach(room.ctx, room.state().entities[rec], 'Files', doc);

  const before = room.events.length;
  Drive.detach(room.ctx, room.state().entities[rec], 'Files', doc);
  const emitted = room.events.slice(before);
  eq(emitted.length, 1);
  eq(emitted[0].content.anchor, rec);
  assert.notStrictEqual(emitted[0].content.anchor, doc);
});

await test('detaching from one record leaves the other record attached', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Name', type: 'text' }, { name: 'Files', type: 'attachment' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'shared.pdf', ref: ref('a') });
  const a = room.addRecord('case', { Name: 'A' });
  const b = room.addRecord('case', { Name: 'B' });
  Drive.attach(room.ctx, room.state().entities[a], 'Files', doc);
  Drive.attach(room.ctx, room.state().entities[b], 'Files', doc);
  eq(Drive.usageIndex(room.state()).get(doc).length, 2);

  Drive.detach(room.ctx, room.state().entities[a], 'Files', doc);
  const uses = Drive.usageIndex(room.state()).get(doc);
  eq(uses.length, 1);
  eq(uses[0].label, 'B');
});

await test('attaching twice keeps one reference', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Files', type: 'attachment' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a') });
  const rec = room.addRecord('case', {});
  Drive.attach(room.ctx, room.state().entities[rec], 'Files', doc);
  const n = room.events.length;
  Drive.attach(room.ctx, room.state().entities[rec], 'Files', doc);
  eq(room.events.length, n);                     // nothing emitted the second time
  eq(room.state().entities[rec].Files, [doc]);
});

await test('detaching something that was never attached emits nothing', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Files', type: 'attachment' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a') });
  const rec = room.addRecord('case', {});
  const n = room.events.length;
  Drive.detach(room.ctx, room.state().entities[rec], 'Files', doc);
  eq(room.events.length, n);
});

await test('usageIndex names the record, its type, and the field', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Name', type: 'text' }, { name: 'Exhibits', type: 'attachment' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a') });
  const rec = room.addRecord('case', { Name: 'Acme v. Roe' });
  Drive.attach(room.ctx, room.state().entities[rec], 'Exhibits', doc);
  const [use] = Drive.usageIndex(room.state()).get(doc);
  eq(use, { anchor: rec, type: 'case', field: 'Exhibits', label: 'Acme v. Roe' });
});

await test('usageIndex ignores lookalike values in non-attachment fields', async () => {
  const room = makeRoom();
  room.declareTable('case', [{ name: 'Notes', type: 'longtext' }]);
  const doc = await Drive.createDoc(room.ctx, { name: 'a.pdf', ref: ref('a') });
  const rec = room.addRecord('case', { Notes: doc });   // the anchor as plain text
  eq(Drive.usageIndex(room.state()).get(doc), undefined);
  assert.ok(room.state().entities[rec]);
});

await test('resolveCell drops references to trashed and missing documents', async () => {
  const room = makeRoom();
  const live = await Drive.createDoc(room.ctx, { name: 'live.pdf', ref: ref('a') });
  const gone = await Drive.createDoc(room.ctx, { name: 'gone.pdf', ref: ref('b') });
  Drive.trash(room.ctx, gone);
  const state = room.state();
  eq(Drive.resolveCell(state, [live, gone, '_doc_never_existed']).map(d => d.name), ['live.pdf']);
});

await test('a cell holding a bare anchor string is read as one attachment', async () => {
  eq(Drive.anchorsInCell('_doc_abc'), ['_doc_abc']);
  eq(Drive.anchorsInCell(['_doc_a', '', null, '_doc_b']), ['_doc_a', '_doc_b']);
  eq(Drive.anchorsInCell(null), []);
});

// ── Presentation ─────────────────────────────────────────────────────────

await test('uniqueName sidesteps a sibling collision, extension intact', async () => {
  eq(Drive.uniqueName('report.pdf', []), 'report.pdf');
  eq(Drive.uniqueName('report.pdf', ['report.pdf']), 'report (2).pdf');
  eq(Drive.uniqueName('report.pdf', ['report.pdf', 'report (2).pdf']), 'report (3).pdf');
  eq(Drive.uniqueName('report.pdf', ['REPORT.PDF']), 'report (2).pdf');  // case-insensitive
  eq(Drive.uniqueName('notes', ['notes']), 'notes (2)');
});

await test('kindOf reads the MIME first and the extension as backup', async () => {
  eq(Drive.kindOf({ mime: 'image/png' }), 'image');
  eq(Drive.kindOf({ name: 'a.png' }), 'image');
  eq(Drive.kindOf({ name: 'deck.pptx' }), 'slides');
  eq(Drive.kindOf({ name: 'notes.docx' }), 'doc');
  eq(Drive.kindOf({ name: 'x.unknown' }), 'file');
});

await test('viewerFor sends office formats to the native reader', async () => {
  // drive.js asks window.DocView; wire the real one up the same way the page
  // does so the two modules are checked together rather than in isolation.
  win.DocView = (() => {
    const w = {};
    new Function('window', readFileSync(join(here, '..', 'public', 'docview.js'), 'utf8'))(w);
    return w.DocView;
  })();
  try {
    eq(Drive.viewerFor({ name: 'a.docx' }), 'native');
    eq(Drive.viewerFor({ name: 'a.csv' }), 'native');
    eq(Drive.viewerFor({ name: 'a.md' }), 'native');
    eq(Drive.viewerFor({ name: 'a.png', mime: 'image/png' }), 'image');
    eq(Drive.viewerFor({ name: 'a.pdf', mime: 'application/pdf' }), 'pdf');
    eq(Drive.viewerFor({ name: 'a.txt', mime: 'text/plain' }), 'text');
    eq(Drive.viewerFor({ name: 'a.bin', mime: 'application/octet-stream' }), 'none');
    eq(Drive.isPreviewable({ name: 'a.docx' }), true);
    eq(Drive.isPreviewable({ name: 'a.bin', mime: 'application/octet-stream' }), false);
  } finally {
    delete win.DocView;
  }
});

console.log(`\nall ${passed} drive checks passed`);
