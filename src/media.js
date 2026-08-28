/**
 * media.js — Encrypted attachments + offline media mirror
 *
 * All blobs uploaded to the homeserver media store are end-to-end
 * encrypted with the same trust boundary as the room itself:
 *
 *   - A fresh 256-bit key + 128-bit IV (8 random bytes ‖ 8 counter bytes)
 *     is generated per blob.
 *   - The plaintext is AES-CTR encrypted.
 *   - SHA-256 of the ciphertext is recorded for integrity.
 *   - The ciphertext goes to /_matrix/media (server sees opaque bytes).
 *   - The key + iv + hash live inside the room event content, which is
 *     itself Megolm-encrypted when the event is sent into an E2EE room.
 *
 * So: anyone with the room's Megolm session can decrypt the event and
 * thereby decrypt the blob. The homeserver and any non-member cannot.
 *
 * The reference format embedded in event content is:
 *
 *   { __media: 2, mxc, mime, size, name, file: { v:'v2', key, iv, hashes } }
 *
 * Legacy `__media: 1` references (plaintext on the media store, from
 * an earlier version) are still readable so old events keep working.
 *
 * Two layers of at-rest protection apply locally:
 *   - The plaintext bytes are mirrored to OPFS, vault-encrypted, so
 *     readers can resolve without contacting the server.
 *   - The mirror is keyed by mxc URL hash; on logout it is wiped along
 *     with the rest of the user's local data.
 */

import { getClient } from './client.js';
import { vault } from './vault.js';

const HOIST_THRESHOLD = 16 * 1024;       // hoist string fields >= 16KB
const CONTENT_SIZE_LIMIT = 24 * 1024;    // total target after hoist
const MAX_HOIST_PER_EVENT = 8;
const IV_BYTES = 16;
const KEY_BYTES = 32;
const CACHE_PREFIX = 'media_';
const CACHE_SUFFIX = '.bin';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Encoding helpers ──

function b64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Unpadded(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/, '');
}

function b64UnpaddedDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function byteLength(str) {
  return encoder.encode(str).length;
}

export function contentSize(content) {
  return byteLength(JSON.stringify(content));
}

// ── Matrix encrypted attachments (v2) ──

async function aesCtrEncrypt(keyBytes, iv, plaintext) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key, plaintext
  );
  return new Uint8Array(ct);
}

async function aesCtrDecrypt(keyBytes, iv, ciphertext) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key, ciphertext
  );
  return new Uint8Array(pt);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Encrypt `plaintext` with a fresh AES-CTR key. Returns the
 * ciphertext to upload and the file info envelope to embed in the
 * Megolm-encrypted event content.
 */
export async function encryptAttachment(plaintext) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = new Uint8Array(IV_BYTES);
  // Upper 8 bytes random, lower 8 zero — leaves the 64-bit block counter
  // free to count up through ciphertext blocks. Matches the spec.
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = await aesCtrEncrypt(keyBytes, iv, plaintext);
  const digest = await sha256(ciphertext);
  return {
    data: ciphertext,
    info: {
      v: 'v2',
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        ext: true,
        k: b64Url(keyBytes),
        key_ops: ['encrypt', 'decrypt'],
      },
      iv: b64Unpadded(iv),
      hashes: { sha256: b64Unpadded(digest) },
    },
  };
}

/**
 * Decrypt a file ciphertext blob using the `file` envelope from a
 * `__media: 2` reference. Verifies SHA-256 before returning plaintext.
 */
export async function decryptAttachment(ciphertext, info) {
  if (!info || !info.key || !info.key.k || !info.iv || !info.hashes?.sha256) {
    throw new Error('Missing attachment envelope fields');
  }
  const keyBytes = b64UrlDecode(info.key.k);
  const iv = b64UnpaddedDecode(info.iv);
  const expected = b64UnpaddedDecode(info.hashes.sha256);
  const actual = await sha256(ciphertext);
  if (expected.length !== actual.length) throw new Error('Hash length mismatch');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  if (diff !== 0) throw new Error('Hash mismatch — corrupt or tampered attachment');
  return aesCtrDecrypt(keyBytes, iv, ciphertext);
}

// ── OPFS-backed local mirror (vault-encrypted) ──

async function getOpfsRoot() {
  try { return await navigator.storage.getDirectory(); }
  catch { return null; }
}

async function mxcToFileName(mxc) {
  const digest = await sha256(encoder.encode(mxc));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
  return `${CACHE_PREFIX}${hex}${CACHE_SUFFIX}`;
}

/**
 * Stash `bytes` in OPFS keyed by `mxc`, encrypted with the vault key.
 * No-op if OPFS is unavailable or the vault is locked.
 */
export async function cacheMediaBytes(mxc, bytes) {
  if (!mxc || !bytes) return;
  if (!vault.isUnlocked()) return;
  const root = await getOpfsRoot();
  if (!root) return;
  try {
    const name = await mxcToFileName(mxc);
    const handle = await root.getFileHandle(name, { create: true });
    const blob = await vault.encryptBytes(bytes);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    console.warn('[media] cache write failed:', e?.message || e);
  }
}

/**
 * Read previously-cached bytes for `mxc`. Returns null if absent or
 * undecryptable. Pure-local — no network.
 */
export async function getCachedMediaBytes(mxc) {
  if (!mxc) return null;
  if (!vault.isUnlocked()) return null;
  const root = await getOpfsRoot();
  if (!root) return null;
  try {
    const name = await mxcToFileName(mxc);
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    const blob = new Uint8Array(await file.arrayBuffer());
    return await vault.decryptBytes(blob);
  } catch {
    return null;
  }
}

/**
 * Delete the locally-mirrored blobs for a specific set of mxc URIs.
 *
 * Unlike wipeMediaCache (logout — drops everything), this is the targeted
 * reclaim used by the sync page to drop blobs that are still on disk but no
 * longer referenced by the live workspace — the classic case being the source
 * blobs of *superseded* import generations (re-importing a source uploads
 * fresh blobs each time; the old generation's rows stop materializing but its
 * mirror lingers forever). Each entry is keyed by the same mxc→filename hash
 * the cache writer uses, so a caller that knows the dead mxcs can free exactly
 * their bytes. Returns `{ removed, bytes }`. Best-effort; a blob that was never
 * mirrored (or already gone) is skipped silently. Deleting a blob that turns
 * out to still be wanted is non-destructive: it simply re-downloads on next
 * read, exactly as on a fresh device.
 */
export async function purgeMediaByMxc(mxcList) {
  const result = { removed: 0, bytes: 0 };
  if (!Array.isArray(mxcList) || mxcList.length === 0) return result;
  const root = await getOpfsRoot();
  if (!root) return result;
  const seen = new Set();
  for (const mxc of mxcList) {
    if (!mxc || seen.has(mxc)) continue;
    seen.add(mxc);
    try {
      const name = await mxcToFileName(mxc);
      let size = 0;
      try { size = (await (await root.getFileHandle(name)).getFile()).size; }
      catch { continue; }   // not mirrored — nothing to reclaim
      await root.removeEntry(name);
      result.removed++;
      result.bytes += size;
    } catch (e) {
      console.warn('[media] purge failed for', mxc, e?.message || e);
    }
  }
  return result;
}

/**
 * Wipe every cached media blob from OPFS. Called on logout.
 */
export async function wipeMediaCache() {
  const root = await getOpfsRoot();
  if (!root) return;
  const toRemove = [];
  try {
    for await (const [name] of root) {
      if (name.startsWith(CACHE_PREFIX) && name.endsWith(CACHE_SUFFIX)) toRemove.push(name);
    }
    for (const n of toRemove) { try { await root.removeEntry(n); } catch {} }
  } catch (e) {
    console.warn('[media] cache wipe failed:', e?.message || e);
  }
}

// ── Upload (encrypted) ──

// The homeserver's advertised `m.upload.size`, cached for the session. Asking
// costs one request; not asking costs a large upload that streams for a while
// and then dies as a bare connection reset (the SDK surfaces xhr.status 0 as
// an "AbortError", which tells the user nothing).
let uploadLimit;   // undefined = not asked yet, null = server didn't say

async function getUploadLimit() {
  if (uploadLimit !== undefined) return uploadLimit;
  const client = getClient();
  if (!client?.getMediaConfig) { uploadLimit = null; return uploadLimit; }
  try {
    const cfg = await client.getMediaConfig();
    const n = cfg && cfg['m.upload.size'];
    uploadLimit = typeof n === 'number' && n > 0 ? n : null;
  } catch {
    // Some homeservers 404 /media/config. Unknown limit is not a failure —
    // we just lose the pre-flight check and fall back to a clearer error.
    uploadLimit = null;
  }
  return uploadLimit;
}

function fmtMb(n) {
  if (n == null) return 'unknown';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Turn the SDK's upload failures into something a person can act on. An
 * aborted XHR (status 0) is indistinguishable at this layer from a reset
 * connection, a proxy body-size cap, and a dropped network — so the message
 * names all three rather than guessing, and leads with the size when the file
 * is large enough for that to be the likely cause.
 */
function uploadError(err, byteLength, limit, chunk) {
  const name = err?.name || '';
  const msg = err?.message || String(err || '');
  const where = chunk ? ` (part ${chunk.part} of ${chunk.of})` : '';
  if (err?.errcode === 'M_TOO_LARGE' || /too large/i.test(msg)) {
    return new Error(
      `too large for this homeserver${where} — ${fmtMb(byteLength)}` +
      (limit ? `, and the limit is ${fmtMb(limit)}` : '')
    );
  }
  if (name === 'AbortError' || /timeout/i.test(msg)) {
    return new Error(
      `the upload stopped partway${where}. ` +
      (chunk
        ? 'That is usually a dropped connection rather than a size problem — the file was already split to fit. Try again.'
        : 'The homeserver or a proxy in front of it cuts the connection when a file is over its size limit' +
          (limit ? ` — this one advertises ${fmtMb(limit)}` : '') +
          '; a dropped network does the same thing. Try again.')
    );
  }
  return new Error(msg || 'upload failed');
}

/**
 * Encrypt `plaintext`, upload the ciphertext to the homeserver media
 * store, and mirror the plaintext locally for offline reads. Returns
 * a `__media: 2` reference suitable for embedding in event content.
 *
 * `onProgress({loaded, total})` fires as the bytes go out, so a caller can
 * show real movement instead of a spinner that looks identical to a hang.
 */
export async function uploadEncrypted(plaintext, { mime = 'application/octet-stream', name = 'file', onProgress } = {}) {
  const client = getClient();
  if (!client) throw new Error('Not connected — cannot upload media');

  const bytes = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);

  // AES-CTR is a stream cipher: the ciphertext is exactly as long as the
  // plaintext, so the plaintext length is the number to check against the
  // server's limit.
  const limit = await getUploadLimit();
  if (limit && bytes.length > limit) {
    throw new Error(
      `too large for this homeserver — ${fmtMb(bytes.length)}, and the limit is ${fmtMb(limit)}`
    );
  }

  const { data, info } = await encryptAttachment(bytes);

  // The Matrix media endpoint accepts any MIME; we deliberately send
  // application/octet-stream for the ciphertext so the server can't
  // sniff structure.
  const blob = new Blob([data], { type: 'application/octet-stream' });
  let resp;
  try {
    resp = await client.uploadContent(blob, {
      type: 'application/octet-stream',
      name,
      progressHandler: onProgress,
    });
  } catch (e) {
    throw uploadError(e, bytes.length, limit);
  }
  const mxc = resp && resp.content_uri;
  if (!mxc) throw new Error('Upload returned no content_uri');

  await cacheMediaBytes(mxc, bytes);

  return {
    __media: 2,
    mxc,
    mime,
    size: bytes.length,
    name,
    file: info,
  };
}

/** The homeserver's per-file ceiling in bytes, or null when it won't say. */
export async function maxUploadBytes() {
  return await getUploadLimit();
}

// ── Chunked upload (`__media: 3`) ──
//
// A homeserver's media endpoint has a hard per-file ceiling — 25 MB is a
// common default, and going over it does not come back as a tidy 413: the
// proxy in front of the server usually cuts the connection mid-body, which
// the SDK can only report as a bare abort.
//
// So a file bigger than the ceiling is split. Each part is encrypted under
// its OWN key and uploaded as an independent blob; the event carries a small
// manifest listing them in order:
//
//   { __media: 3, mime, size, name, parts: [{ mxc, size, file }, …] }
//
// Reassembly is this module's business and nobody else's. The drive shows
// one document, with one name, one size, one preview — the parts never
// surface as separate files, and `getMediaBytes`/`getMediaBlob` hand back the
// whole thing. Each part is mirrored to OPFS on its own, so an interrupted
// download resumes from whatever parts already landed.

// Leave the server's stated ceiling a little room: the limit is usually
// enforced on the whole request, not just the body.
const CHUNK_HEADROOM = 256 * 1024;
const MIN_CHUNK = 1024 * 1024;
// Used when the server won't state a limit but the file is large enough that
// one POST is a bad bet anyway.
const DEFAULT_CHUNK = 16 * 1024 * 1024;
const CHUNK_UNKNOWN_LIMIT_THRESHOLD = 48 * 1024 * 1024;
// Each manifest part costs ~200 bytes of event content; the event itself has
// to stay well inside Matrix's 64KB ceiling. Past this many parts the chunk
// size grows instead of the manifest.
const MAX_PARTS = 128;

/** Chunk size for `size` bytes, or null when it should go in one piece. */
function planChunking(size, limit) {
  let chunk;
  if (limit) {
    if (size <= limit) return null;
    chunk = Math.max(MIN_CHUNK, limit - CHUNK_HEADROOM);
  } else {
    if (size <= CHUNK_UNKNOWN_LIMIT_THRESHOLD) return null;
    chunk = DEFAULT_CHUNK;
  }
  // Keep the manifest small enough to ride inside one event.
  if (Math.ceil(size / chunk) > MAX_PARTS) chunk = Math.ceil(size / MAX_PARTS);
  return chunk;
}

export { planChunking };

/**
 * Encrypt + upload one part. Split out so the single-shot and chunked paths
 * share exactly one code path to the server.
 */
async function uploadOnePart(client, bytes, name, onProgress) {
  const { data, info } = await encryptAttachment(bytes);
  const blob = new Blob([data], { type: 'application/octet-stream' });
  const resp = await client.uploadContent(blob, {
    type: 'application/octet-stream',
    name,
    progressHandler: onProgress,
  });
  const mxc = resp && resp.content_uri;
  if (!mxc) throw new Error('Upload returned no content_uri');
  await cacheMediaBytes(mxc, bytes);
  return { mxc, size: bytes.length, file: info };
}

/**
 * Upload a File/Blob that exceeds the server's ceiling as ordered parts.
 * Reads one chunk at a time (never the whole file into memory) and reports
 * progress against the ORIGINAL size, so the caller shows one file moving.
 */
async function uploadChunked(file, { mime, name, chunkSize, onProgress }) {
  const client = getClient();
  const total = file.size;
  const parts = [];
  let done = 0;
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(start + chunkSize, total);
    const slice = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const base = done;
    let part;
    try {
      part = await uploadOnePart(client, slice, `${name}.part${parts.length + 1}`,
        ({ loaded }) => onProgress && onProgress({ loaded: base + Math.min(loaded, slice.length), total }));
    } catch (e) {
      throw uploadError(e, slice.length, chunkSize, { part: parts.length + 1, of: Math.ceil(total / chunkSize) });
    }
    parts.push(part);
    done = end;
    onProgress && onProgress({ loaded: done, total });
  }
  return { __media: 3, mime, size: total, name, parts };
}

/**
 * Convenience: encrypt + upload + cache a user-supplied File / Blob,
 * preserving its declared MIME type and filename. Splits into parts when the
 * file is over the homeserver's ceiling — the caller gets one ref either way.
 */
export async function uploadFile(file, opts = {}) {
  const mime = opts.mime || file.type || 'application/octet-stream';
  const name = opts.name || file.name || 'file';
  const limit = await getUploadLimit();
  const chunkSize = planChunking(file.size, limit);
  if (chunkSize) {
    return uploadChunked(file, { mime, name, chunkSize, onProgress: opts.onProgress });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return uploadEncrypted(bytes, { mime, name, onProgress: opts.onProgress });
}

// ── Hoist (sending side) ──

/**
 * For every string field above the hoist threshold, encrypt + upload
 * it as an attachment and replace the value with a `__media: 2` ref.
 * Largest fields first, capped at MAX_HOIST_PER_EVENT.
 */
export async function hoistLargeFields(content) {
  if (!content || typeof content !== 'object') return { content, hoisted: 0 };
  if (contentSize(content) <= CONTENT_SIZE_LIMIT) return { content, hoisted: 0 };

  const client = getClient();
  if (!client) return { content, hoisted: 0 };

  const out = structuredClone(content);
  let hoisted = 0;

  const candidates = [];
  collectCandidates(out, [], candidates);
  candidates.sort((a, b) => b.size - a.size);

  for (const cand of candidates) {
    if (hoisted >= MAX_HOIST_PER_EVENT) break;
    if (contentSize(out) <= CONTENT_SIZE_LIMIT) break;

    try {
      const bytes = encoder.encode(cand.value);
      const ref = await uploadEncrypted(bytes, {
        mime: 'text/plain;charset=utf-8',
        name: cand.path.join('.') || 'value',
      });
      setPath(out, cand.path, ref);
      hoisted++;
    } catch (e) {
      console.warn('[media] hoist failed for', cand.path, e?.message || e);
    }
  }

  return { content: out, hoisted };
}

// ── Read (receiving side) ──

/**
 * Build the ordered list of download attempts for an mxc URI.
 *
 * Synapse 1.100+ (enforced by default in recent releases) serves media
 * only from the *authenticated* endpoint — `/_matrix/client/v1/media/
 * download/...` — which requires the access token in an Authorization
 * header. A plain unauthenticated `fetch` of the legacy `/_matrix/media/
 * v3/download/...` URL gets a 401/404 there.
 *
 * This matters specifically after a cache wipe: during a normal session
 * blobs resolve from the local OPFS mirror and never hit the network, so
 * the unauthenticated path silently "worked". Once the mirror is gone the
 * re-download is the only source of truth, and on an authenticated-media
 * homeserver it must carry the token — otherwise imported rows (which are
 * materialised from the source blob, not stored as events) never come
 * back even though the schema does.
 *
 * We try the authenticated endpoint first (with the token) and fall back
 * to the legacy unauthenticated one for older servers. On an SDK build
 * that predates the `useAuthentication` argument the first entry collapses
 * to the legacy URL — harmless, the Bearer header is simply ignored.
 */
function mediaDownloadAttempts(client, mxc) {
  const attempts = [];
  const token = typeof client.getAccessToken === 'function' ? client.getAccessToken() : null;

  let authedUrl = null;
  try {
    // (mxc, width, height, resizeMethod, allowDirectLinks, allowRedirects, useAuthentication)
    authedUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, true, undefined, true);
  } catch { /* older SDK signature — fall through to the legacy URL */ }
  if (authedUrl && token) {
    attempts.push({ url: authedUrl, init: { headers: { Authorization: `Bearer ${token}` } } });
  }

  let legacyUrl = null;
  try {
    legacyUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, true);
  } catch { /* ignore */ }
  // Only add the legacy URL when it's actually different from the authed
  // one (older SDKs return the same string for both calls).
  if (legacyUrl && legacyUrl !== authedUrl) {
    attempts.push({ url: legacyUrl, init: {} });
  } else if (legacyUrl && !attempts.length) {
    attempts.push({ url: legacyUrl, init: {} });
  }

  return attempts;
}

/**
 * Download the raw bytes behind an mxc URI from the homeserver media
 * store — no cache, no decryption. Used by callers that do their own
 * envelope handling (e.g. the WCK-encrypted block chain in blocks.js).
 * Returns null when offline or every endpoint attempt failed.
 */
export async function fetchMxcBytes(mxc) {
  const client = getClient();
  if (!client || !mxc) return null;

  const attempts = mediaDownloadAttempts(client, mxc);
  for (const { url, init } of attempts) {
    try {
      const resp = await fetch(url, init);
      if (!resp.ok) {
        console.warn(`[media] download ${resp.status} for ${mxc} via ${url}`);
        continue;
      }
      return new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.warn('[media] download failed:', e?.message || e);
      // Try the next endpoint before giving up.
    }
  }
  return null;
}

// In-flight downloads keyed by mxc. Imported tables materialize many chunks
// at once, and a single blob can be referenced by more than one caller; this
// coalesces concurrent reads of the same mxc onto one network round-trip +
// decrypt instead of N. It also closes the small race opened by the
// write-behind cache below (the OPFS mirror isn't populated synchronously, so
// without this a second reader arriving mid-download would miss the cache and
// re-fetch). Entries are cleared as soon as the bytes resolve.
const inFlightMedia = new Map();           // mxc -> Promise<Uint8Array|null>

/**
 * Fetch the plaintext bytes referenced by a `__media` envelope.
 * Tries the local mirror first; falls back to the homeserver media
 * store (authenticated endpoint first, then legacy), decrypting if the
 * envelope is v2.
 *
 * Returns null when the bytes cannot be obtained (offline + no cache,
 * or every download attempt failed).
 */
export async function getMediaBytes(ref) {
  if (!ref) return null;
  if (ref.__media === 3) return await getMultipartBytes(ref);
  if (!ref.mxc) return null;

  const cached = await getCachedMediaBytes(ref.mxc);
  if (cached) return cached;

  const existing = inFlightMedia.get(ref.mxc);
  if (existing) return existing;

  const job = (async () => {
    const downloaded = await fetchMxcBytes(ref.mxc);
    if (!downloaded) return null;

    let plaintext;
    if (ref.__media === 2 && ref.file) {
      plaintext = await decryptAttachment(downloaded, ref.file);
    } else {
      // Legacy plaintext upload.
      plaintext = downloaded;
    }
    // Write-behind the OPFS mirror. Caching means a second AES pass (vault
    // re-encrypt) plus a disk write over the whole blob; awaiting it here
    // would stall the caller — the import materializer waiting on these
    // bytes to parse rows — behind that work for every chunk. The plaintext
    // is already in hand, so hand it back immediately and let the mirror
    // populate in the background. Worst case (tab closes mid-write) the blob
    // simply re-downloads next session, exactly as if it were never cached.
    cacheMediaBytes(ref.mxc, plaintext).catch(() => {});
    return plaintext;
  })().catch(e => {
    console.warn('[media] decrypt failed:', e?.message || e);
    return null;
  }).finally(() => {
    inFlightMedia.delete(ref.mxc);
  });

  inFlightMedia.set(ref.mxc, job);
  return job;
}

/**
 * Fetch one part of a `__media: 3` file. Parts are ordinary v2 attachments
 * with their own key, so this is `getMediaBytes` for a single member of the
 * manifest — cache first, then the media store.
 */
function partRef(part, ref) {
  return { __media: 2, mxc: part.mxc, file: part.file, mime: ref.mime, size: part.size };
}

/**
 * Reassemble a chunked file into one buffer. `onProgress({loaded,total})`
 * reports against the whole file, not the current part, so a caller shows a
 * single file downloading. Returns null if any part is unavailable — a file
 * missing a middle chunk is not a shorter file, it is an unreadable one.
 */
export async function getMultipartBytes(ref, onProgress) {
  if (!Array.isArray(ref?.parts) || !ref.parts.length) return null;
  const total = ref.size || ref.parts.reduce((n, p) => n + (p.size || 0), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of ref.parts) {
    const bytes = await getMediaBytes(partRef(part, ref));
    if (!bytes) return null;
    if (at + bytes.length > out.length) return null;   // manifest disagrees with the blobs
    out.set(bytes, at);
    at += bytes.length;
    onProgress && onProgress({ loaded: at, total });
  }
  return at === out.length ? out : out.subarray(0, at);
}

/**
 * The same bytes as a Blob. Preferred for previews and downloads of large
 * files: the parts are held as separate Blobs and stitched by reference, so
 * a multi-gigabyte document never needs one contiguous allocation the way
 * `getMediaBytes` does.
 */
export async function getMediaBlob(ref, onProgress) {
  if (!ref) return null;
  const type = ref.mime || 'application/octet-stream';
  if (ref.__media !== 3) {
    const bytes = await getMediaBytes(ref);
    return bytes ? new Blob([bytes], { type }) : null;
  }
  if (!Array.isArray(ref.parts) || !ref.parts.length) return null;
  const total = ref.size || ref.parts.reduce((n, p) => n + (p.size || 0), 0);
  const chunks = [];
  let loaded = 0;
  for (const part of ref.parts) {
    const bytes = await getMediaBytes(partRef(part, ref));
    if (!bytes) return null;
    chunks.push(bytes);
    loaded += bytes.length;
    onProgress && onProgress({ loaded, total });
  }
  return new Blob(chunks, { type });
}

/** Every mxc a ref points at — one for a plain blob, N for a chunked one. */
export function mxcsOf(ref) {
  if (!ref) return [];
  if (ref.__media === 3) return (ref.parts || []).map(p => p.mxc).filter(Boolean);
  return ref.mxc ? [ref.mxc] : [];
}

/**
 * Walk `content`, replacing every `__media` ref with the dereferenced
 * value. v2 refs are interpreted as text by default (matches the
 * hoist source). Callers that need raw bytes for a specific ref
 * should use `getMediaBytes` directly.
 */
export async function resolveMediaReferences(content) {
  if (!content || typeof content !== 'object') return content;
  const out = structuredClone(content);
  const refs = [];
  collectMediaRefs(out, [], refs);
  if (refs.length === 0) return content;

  for (const r of refs) {
    try {
      const bytes = await getMediaBytes(r.ref);
      if (!bytes) continue;
      setPath(out, r.path, decoder.decode(bytes));
    } catch (e) {
      console.warn('[media] resolve failed for', r.path, e?.message || e);
    }
  }
  return out;
}

function collectCandidates(node, path, out) {
  if (typeof node === 'string') {
    const sz = byteLength(node);
    if (sz >= HOIST_THRESHOLD) out.push({ path: [...path], value: node, size: sz });
    return;
  }
  if (node && typeof node === 'object') {
    // Don't descend into existing media refs — they're already hoisted.
    if (node.__media) return;
    for (const k of Object.keys(node)) collectCandidates(node[k], [...path, k], out);
  }
}

function collectMediaRefs(node, path, out) {
  if (node && typeof node === 'object') {
    if (((node.__media === 1 || node.__media === 2) && typeof node.mxc === 'string') ||
        (node.__media === 3 && Array.isArray(node.parts))) {
      out.push({ path: [...path], ref: node });
      return;
    }
    for (const k of Object.keys(node)) collectMediaRefs(node[k], [...path, k], out);
  }
}

function setPath(root, path, value) {
  if (path.length === 0) return;
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

export { HOIST_THRESHOLD, CONTENT_SIZE_LIMIT };
