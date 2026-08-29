/**
 * void-store.js — the Void's held list: observations that haven't earned
 * a name yet.
 *
 * NUL is ephemeral and unstored, per operators.js (`stored: false`) — a
 * bare observation never becomes a Matrix event. It lives here, in
 * IndexedDB, until promotion (INS) turns it into a real entity — at which
 * point it is deleted from here and appended to the timeline instead.
 * Nothing in this file writes an event, or imports anything Matrix-shaped:
 * it is a plain local scratch store, gone the moment a promotion (or an
 * explicit discard) removes an entry.
 *
 * One object store, keyed by roomId, holding that room's array of held
 * entries — deliberately the simplest schema that does the job, not a
 * general-purpose database. The db name deliberately does NOT start with
 * "matrix-js-sdk", so idbScope.js's origin-collision patch (which only
 * rewrites names in that family) leaves it untouched — this store already
 * can't collide with another matrix-js-sdk app at the same origin.
 */

const DB_NAME = 'eomx-void';
const DB_VERSION = 1;
const STORE = 'held';

function defaultIdb() {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

function openDb(idb) {
  const factory = idb || defaultIdb();
  if (!factory) return Promise.reject(new Error('no IndexedDB available'));
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// A same-millisecond burst (two entries held back to back) still needs a
// stable order — ts alone can tie, so a monotonic counter breaks it.
let seqCounter = 0;

function makeId() {
  return `held_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** All held entries for a room, most recent first. */
export async function listHeld(roomId, idb) {
  const db = await openDb(idb);
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const arr = await reqToPromise(store.get(roomId));
  db.close?.();
  return (arr || []).slice().sort((a, b) => (b.ts - a.ts) || (b.seq - a.seq));
}

/**
 * Hold a new observation — text and/or an attachment reference. Returns
 * the stored entry. Never touches the timeline, never needs a name.
 */
export async function addHeld(roomId, { text = '', attachment = null } = {}, idb) {
  const db = await openDb(idb);
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const cur = (await reqToPromise(store.get(roomId))) || [];
  const entry = { id: makeId(), text, attachment, ts: Date.now(), seq: seqCounter++ };
  await reqToPromise(store.put([...cur, entry], roomId));
  db.close?.();
  return entry;
}

/** Remove one held entry — called the moment it's promoted or discarded. */
export async function removeHeld(roomId, id, idb) {
  const db = await openDb(idb);
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const cur = (await reqToPromise(store.get(roomId))) || [];
  await reqToPromise(store.put(cur.filter(e => e.id !== id), roomId));
  db.close?.();
}

/**
 * Merge fields into one held entry, keeping its id, timestamp and place in
 * the order. Transcription uses this: the entry is the same observation
 * afterwards, now with words in it, and remove-then-add would give it a
 * fresh id and jump it to the top of a list the user is reading.
 * Returns the updated entry, or null if it is already gone.
 */
export async function updateHeld(roomId, id, patch, idb) {
  const db = await openDb(idb);
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const cur = (await reqToPromise(store.get(roomId))) || [];
  let updated = null;
  const next = cur.map(e => {
    if (e.id !== id) return e;
    updated = { ...e, ...patch, id: e.id, ts: e.ts, seq: e.seq };
    return updated;
  });
  if (updated) await reqToPromise(store.put(next, roomId));
  db.close?.();
  return updated;
}
