/* Tests for the chunked-upload plan and reassembly in src/media.js.
 *
 * A homeserver's media endpoint has a hard per-file ceiling (25 MB is a
 * common default), and going over it does not come back as a clean 413 — the
 * proxy usually cuts the connection mid-body, which the SDK can only report
 * as a bare "AbortError". So a large file is split into independently
 * encrypted parts and stitched back together on read, while the drive keeps
 * showing ONE document. These checks pin down the arithmetic that decides the
 * split, and the round trip that has to survive it.
 *
 *   node test/media-chunk.test.mjs
 */
import assert from 'node:assert';
import { webcrypto } from 'node:crypto';

// media.js reaches client.js (matrix-js-sdk, IndexedDB) and vault.js at import
// time. Stub the browser surface those touch, then import for real so the
// functions under test are the shipped ones.
globalThis.crypto ??= webcrypto;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB ??= { open() { return { addEventListener() {} }; } };
globalThis.navigator ??= { storage: {} };

const media = await import('../src/media.js');
const { planChunking, encryptAttachment, decryptAttachment, getMultipartBytes, mxcsOf } = media;

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

const MB = 1024 * 1024;

// ── The split plan ───────────────────────────────────────────────────────

await test('a file inside the ceiling is not split', () => {
  eq(planChunking(5 * MB, 25 * MB), null);
  eq(planChunking(25 * MB, 25 * MB), null);   // exactly at the limit still fits
});

await test('a file over the ceiling is split below it, with headroom', () => {
  const chunk = planChunking(80 * MB, 25 * MB);
  assert.ok(chunk < 25 * MB, `chunk ${chunk} must leave room for request overhead`);
  assert.ok(chunk >= 24 * MB, `chunk ${chunk} should still be close to the limit`);
});

await test('with no advertised limit, only genuinely large files are split', () => {
  // Nothing is known about the server, so the current behaviour is preserved
  // for ordinary files and only a big single POST — the bet that fails — is
  // avoided.
  eq(planChunking(10 * MB, null), null);
  eq(planChunking(48 * MB, null), null);
  assert.ok(planChunking(200 * MB, null) > 0);
});

await test('the manifest stays small enough to ride inside one event', () => {
  // Each part costs ~200 bytes of event content and Matrix caps an event at
  // 64KB, so the chunk size grows rather than the part list.
  const huge = 40 * 1024 * MB;                       // 40 GB
  const chunk = planChunking(huge, 25 * MB);
  const parts = Math.ceil(huge / chunk);
  assert.ok(parts <= 128, `${parts} parts would overflow the event`);
});

await test('a tiny ceiling still yields a usable chunk size', () => {
  const chunk = planChunking(50 * MB, 100 * 1024);   // absurdly small limit
  assert.ok(chunk >= MB, `chunk ${chunk} must not collapse to nothing`);
});

// ── Round trip ───────────────────────────────────────────────────────────

/**
 * Stand in for the media store: encrypt each slice the way uploadChunked
 * does, and serve the parts back the way getMediaBytes would.
 */
async function makeParts(bytes, chunkSize) {
  const parts = [];
  const store = new Map();
  for (let at = 0; at < bytes.length; at += chunkSize) {
    const slice = bytes.subarray(at, Math.min(at + chunkSize, bytes.length));
    const { data, info } = await encryptAttachment(slice);
    const mxc = `mxc://test/${parts.length}`;
    store.set(mxc, data);
    parts.push({ mxc, size: slice.length, file: info });
  }
  return { parts, store };
}

/** Reassemble without the OPFS/network layer, but through the real codec. */
async function reassemble(ref, store) {
  const out = new Uint8Array(ref.size);
  let at = 0;
  for (const p of ref.parts) {
    const cipher = store.get(p.mxc);
    if (!cipher) return null;
    const plain = await decryptAttachment(cipher, p.file);
    out.set(plain, at);
    at += plain.length;
  }
  return at === out.length ? out : null;
}

await test('a split file decrypts back to the original bytes, in order', async () => {
  const bytes = new Uint8Array(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  const { parts, store } = await makeParts(bytes, 64_000);
  eq(parts.length, 5);
  const ref = { __media: 3, mime: 'application/pdf', size: bytes.length, name: 'big.pdf', parts };
  const back = await reassemble(ref, store);
  assert.ok(back && Buffer.from(back).equals(Buffer.from(bytes)), 'round trip must be byte-exact');
});

await test('each part carries its own key — one key never opens another', async () => {
  const bytes = new Uint8Array(200_000).fill(7);
  const { parts, store } = await makeParts(bytes, 64_000);
  const keys = new Set(parts.map(p => p.file.key.k));
  eq(keys.size, parts.length);
  // Each part records the SHA-256 of its own ciphertext, so pointing one
  // part's envelope at another's bytes is refused outright rather than
  // yielding plausible garbage.
  await assert.rejects(
    () => decryptAttachment(store.get(parts[1].mxc), parts[0].file),
    /Hash mismatch/,
  );
  const right = await decryptAttachment(store.get(parts[1].mxc), parts[1].file);
  eq(right.length, parts[1].size);
});

await test('a missing middle part yields nothing, not a truncated file', async () => {
  const bytes = new Uint8Array(150_000).fill(3);
  const { parts, store } = await makeParts(bytes, 64_000);
  store.delete(parts[1].mxc);
  const ref = { __media: 3, size: bytes.length, parts };
  eq(await reassemble(ref, store), null);
  // And through the real reader, whose fetch layer has nothing to serve:
  eq(await getMultipartBytes({ __media: 3, size: bytes.length, parts: [] }), null);
});

// ── Reclaim ──────────────────────────────────────────────────────────────

await test('mxcsOf lists every blob a ref points at', () => {
  eq(mxcsOf({ __media: 2, mxc: 'mxc://a/1' }), ['mxc://a/1']);
  eq(mxcsOf({ __media: 3, parts: [{ mxc: 'mxc://a/1' }, { mxc: 'mxc://a/2' }] }),
     ['mxc://a/1', 'mxc://a/2']);
  eq(mxcsOf(null), []);
  eq(mxcsOf({ __media: 3, parts: [] }), []);
});

console.log(`\nall ${passed} chunking checks passed`);
