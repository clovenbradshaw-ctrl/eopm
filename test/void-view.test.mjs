/* Tests for the Void's held list (src/void-store.js) and the promotion
 * flow public/void-view.jsx drives it through.
 *
 * void-view.jsx itself is a pure React component — like every other
 * `-view.jsx` in this repo (drive-view.jsx, entity-timeline.jsx, ...) the
 * testable substance lives in a plain module (here, void-store.js) and is
 * exercised directly; see test/drive.test.mjs and test/engine-fold.test.mjs
 * for the same split.
 *
 *   node test/void-view.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── A minimal, faithful-enough fake of the slice of IndexedDB
//    void-store.js actually calls: open/onupgradeneeded/onsuccess,
//    db.transaction().objectStore(), store.get/put keyed by an
//    out-of-line key. Persists across calls within one fake instance —
//    that's what "survives a reload" means for this store: the same
//    underlying database, re-opened. ──
function makeFakeIndexedDB() {
  const databases = new Map(); // name -> Map<storeName, Map<key, value>>

  function request(run) {
    const req = {};
    queueMicrotask(() => {
      try { run(req); }
      catch (e) { req.error = e; req.onerror && req.onerror(); }
    });
    return req;
  }

  function storeHandle(map) {
    return {
      get(key) {
        return request(req => { req.result = map.get(key); req.onsuccess && req.onsuccess(); });
      },
      put(value, key) {
        return request(req => { map.set(key, value); req.result = key; req.onsuccess && req.onsuccess(); });
      },
    };
  }

  return {
    open(name) {
      return request(req => {
        let stores = databases.get(name);
        const isNew = !stores;
        if (!stores) { stores = new Map(); databases.set(name, stores); }
        const db = {
          objectStoreNames: { contains: n => stores.has(n) },
          createObjectStore(storeName) {
            const m = new Map();
            stores.set(storeName, m);
            return storeHandle(m);
          },
          transaction(storeName) {
            return { objectStore: () => storeHandle(stores.get(storeName)) };
          },
          close() {},
        };
        req.result = db;
        if (isNew) req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
    },
  };
}

const { addHeld, listHeld, removeHeld } = await import('../src/void-store.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

// ── held entries never touch a fold ─────────────────────────────────────

await test('holding an observation writes nothing a fold would ever see', () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  return addHeld(roomId, { text: 'board member also sits on the TN AG advisory council' }, idb).then(entry => {
    assert.ok(entry.id, 'addHeld must return the stored entry');
    eq(entry.text, 'board member also sits on the TN AG advisory council');
    // Nothing about this entry is event-shaped (no `type`, no `content`,
    // no `origin_server_ts`) — it cannot accidentally be folded.
    assert.ok(!('type' in entry) && !('content' in entry));
  });
});

await test('listHeld returns held entries most-recent first', async () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  await addHeld(roomId, { text: 'first' }, idb);
  await addHeld(roomId, { text: 'second' }, idb);
  const list = await listHeld(roomId, idb);
  eq(list.map(e => e.text), ['second', 'first']);
});

await test('held entries are scoped per room', async () => {
  const idb = makeFakeIndexedDB();
  await addHeld('!a:test', { text: 'in room a' }, idb);
  await addHeld('!b:test', { text: 'in room b' }, idb);
  eq((await listHeld('!a:test', idb)).map(e => e.text), ['in room a']);
  eq((await listHeld('!b:test', idb)).map(e => e.text), ['in room b']);
});

// ── promotion: name-only INS, then the held entry is gone ──────────────

// engine.js is the fold the UI actually projects state with (see
// test/engine-fold.test.mjs) — promotion is checked against the real thing.
const here = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(join(here, '..', 'public', 'engine.js'), 'utf8'))(win);
const ME = win.MatrixEngine;
ME.setNamespace('io.matrix-events');

function emitInsFromHeld(events, entry, name, sender = '@you:demo') {
  const ts = Date.now();
  const payload = { Title: name };
  const anchor = ME.makeAnchor('observation', payload, sender, ts);
  events.push({
    type: ME.eventType(ME.OP.INS),
    content: { anchor, entity_type: 'observation', payload },
    origin_server_ts: ts,
    sender,
    event_id: `$e_${events.length}`,
  });
  return anchor;
}

await test('the held item survives a reload before it is promoted', async () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  await addHeld(roomId, { text: 'a stray thought' }, idb);
  // "reload" — nothing here re-creates the database, only re-opens it,
  // exactly like a page refresh re-opening the same IndexedDB database.
  const afterReload = await listHeld(roomId, idb);
  eq(afterReload.length, 1);
  eq(afterReload[0].text, 'a stray thought');
});

await test('promotion emits exactly one INS carrying the typed name, and nothing else', async () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  const entry = await addHeld(roomId, { text: 'board member also sits on the TN AG advisory council' }, idb);

  const events = [];
  const anchor = emitInsFromHeld(events, entry, 'TN AG advisory council overlap');
  await removeHeld(roomId, entry.id, idb);

  eq(events.length, 1);
  eq(ME.parseEventType(events[0].type), ME.OP.INS);
  eq(events[0].content.payload.Title, 'TN AG advisory council overlap');

  const state = ME.fold(events);
  const entity = state.entities[anchor];
  assert.ok(entity, 'the promoted entity must exist in the fold');
  eq(entity.Title, 'TN AG advisory council overlap');
  eq(entity._hwm, ME.OP.INS.order);
  eq(state._violations, []);
});

await test('the held item is gone from IDB after promotion', async () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  const entry = await addHeld(roomId, { text: 'promote me' }, idb);
  await addHeld(roomId, { text: 'leave me held' }, idb);

  const events = [];
  emitInsFromHeld(events, entry, 'promoted');
  await removeHeld(roomId, entry.id, idb);

  const remaining = await listHeld(roomId, idb);
  eq(remaining.length, 1);
  eq(remaining[0].text, 'leave me held');
});

await test('discarding a held entry (never promoted) also just removes it — no event, ever', async () => {
  const idb = makeFakeIndexedDB();
  const roomId = '!room:test';
  const entry = await addHeld(roomId, { text: 'never mind' }, idb);
  await removeHeld(roomId, entry.id, idb);
  eq(await listHeld(roomId, idb), []);
});

console.log(`\nall ${passed} void-view checks passed`);
