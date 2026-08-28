/* Tests for src/vault.js — the master-key indirection.
 *
 * The property under test is the one the guest-link flow depends on: a
 * password change must NOT orphan data already written to disk. Before
 * meta v2 the password-derived key WAS the data key, so changing the
 * password made every cached byte unreadable. Now the password only
 * wraps a random master key, so a change re-wraps 32 bytes.
 *
 * Also covers the v1 → v2 migration, which has to promote the existing
 * password-derived key to master (rather than mint a fresh one) or it
 * would orphan exactly the data it is supposed to rescue.
 *
 *   node test/vault-rekey.test.mjs
 */
import assert from 'node:assert';

// ── Minimal browser storage shims (vault.js only needs get/set/remove,
// length + key(i) for its sweeps, and JSON-able string values).
class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  key(i) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemStorage();
globalThis.sessionStorage = new MemStorage();

const { vault, storeSecret, loadSecret } = await import('../src/vault.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const USER = '@sam-rivera-x3f9:hyphae.social';
const enc = new TextEncoder();
const dec = new TextDecoder();

function reset() {
  localStorage.clear();
  sessionStorage.clear();
  vault.lock();
}

await test('initialize then unlock with the same password', async () => {
  reset();
  await vault.initialize(USER, 'device-secret', { persist: true });
  const blob = await vault.encryptString('the whole table');
  vault.lock();
  assert.strictEqual(vault.isUnlocked(), false);
  assert.strictEqual(await vault.unlock(USER, 'device-secret'), true);
  assert.strictEqual(await vault.decryptString(blob), 'the whole table');
});

await test('unlock rejects the wrong password without throwing', async () => {
  reset();
  await vault.initialize(USER, 'device-secret');
  vault.lock();
  assert.strictEqual(await vault.unlock(USER, 'not-it'), false);
  assert.strictEqual(vault.isUnlocked(), false);
});

await test('rekey keeps existing data readable — the headline property', async () => {
  reset();
  await vault.initialize(USER, 'device-secret', { persist: true });
  const before = await vault.encryptString('written under the old password');
  await storeSecret(USER, 'wck:!room', 'a workspace key');

  await vault.rekey(USER, 'the-password-sam-chose');

  // Still unlocked, same master, so the old ciphertext still opens.
  assert.strictEqual(await vault.decryptString(before), 'written under the old password');
  assert.strictEqual(await loadSecret(USER, 'wck:!room'), 'a workspace key');

  // And a cold unlock with the NEW password reaches the same data.
  vault.lock();
  assert.strictEqual(await vault.unlock(USER, 'the-password-sam-chose'), true);
  assert.strictEqual(await vault.decryptString(before), 'written under the old password');
  assert.strictEqual(await loadSecret(USER, 'wck:!room'), 'a workspace key');
});

await test('the old password stops working after a rekey', async () => {
  reset();
  await vault.initialize(USER, 'device-secret');
  await vault.rekey(USER, 'the-password-sam-chose');
  vault.lock();
  assert.strictEqual(await vault.unlock(USER, 'device-secret'), false);
});

await test('rekey refuses when locked or for a different user', async () => {
  reset();
  await vault.initialize(USER, 'device-secret');
  await assert.rejects(() => vault.rekey('@someone-else:hs', 'x'));
  vault.lock();
  await assert.rejects(() => vault.rekey(USER, 'x'));
});

await test('resume stash re-adopts the master key', async () => {
  reset();
  await vault.initialize(USER, 'device-secret', { persist: true });
  const blob = await vault.encryptString('resumed');
  // Simulate a cold boot: key gone from memory, stash still on disk.
  vault._key = null; vault._userId = null;
  assert.strictEqual(await vault.tryAdoptStashedKey(USER), true);
  assert.strictEqual(await vault.decryptString(blob), 'resumed');
  assert.strictEqual(vault.isPersistent(), true);
});

await test('a v1 vault migrates to v2 without orphaning its data', async () => {
  reset();

  // Hand-build a v1 vault: PBKDF2(password) IS the data key, and the
  // verifier is sealed under it. This is exactly what shipped before.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', enc.encode('old-password'), 'PBKDF2', false, ['deriveKey']);
  const legacyKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 250_000 },
    material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const b64 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
  const vIv = crypto.getRandomValues(new Uint8Array(12));
  const vCt = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: vIv }, legacyKey, enc.encode(`verify:${USER}`)));
  localStorage.setItem(`vault:${USER}`, JSON.stringify({
    v: 1, salt: b64(salt), verifierIv: b64(vIv), verifierCt: b64(vCt),
  }));

  // Data written by the old build, under the legacy key.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, legacyKey, enc.encode('legacy row')));
  const legacyBlob = new Uint8Array(iv.length + ct.length);
  legacyBlob.set(iv, 0); legacyBlob.set(ct, iv.length);

  // Unlocking with the old password migrates the meta in place…
  assert.strictEqual(await vault.unlock(USER, 'old-password'), true);
  assert.strictEqual(JSON.parse(localStorage.getItem(`vault:${USER}`)).v, 2);
  // …and the legacy bytes are still readable, which is the whole point.
  assert.strictEqual(dec.decode(await vault.decryptBytes(legacyBlob)), 'legacy row');

  // Now a password change is non-destructive, as it never was under v1.
  await vault.rekey(USER, 'new-password');
  assert.strictEqual(dec.decode(await vault.decryptBytes(legacyBlob)), 'legacy row');
  vault.lock();
  assert.strictEqual(await vault.unlock(USER, 'new-password'), true);
  assert.strictEqual(dec.decode(await vault.decryptBytes(legacyBlob)), 'legacy row');
});

console.log(`\n${passed} passed`);
