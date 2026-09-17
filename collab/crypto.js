/**
 * crypto.js — password-derived field encryption.
 *
 * Not Matrix's own E2EE (m.room.encryption) — that's deliberately off for
 * collab rooms (see the plan's E2EE decision: a brand-new guest account
 * joining a room with existing Megolm history isn't guaranteed to decrypt
 * it, which would break "anyone with the link can read"). Instead: a
 * single AES-GCM key derived by hashing the same shared gate password
 * (`STR DECK`) everyone already has. No device-to-device key exchange, no
 * late-joiner problem — anyone who knows the password can derive the same
 * key independently. The homeserver still only ever sees ciphertext for
 * actual content; `anchor`/`path`/`entity_type` stay in clear because
 * src/fold.js's dispatch needs them to route events structurally.
 */
import { GATE_PASSWORD } from './constants.js';

let keyPromise = null;
function getKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(GATE_PASSWORD))
      .then((hash) => crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyPromise;
}

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encrypt any JSON-serializable value into a `{__enc}` wire blob. */
export async function encryptField(value) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return { __enc: b64encode(combined) };
}

/** Decrypt a `{__enc}` wire blob back to its value; passes non-blobs through unchanged. */
export async function decryptField(value) {
  if (!value || typeof value !== 'object' || typeof value.__enc !== 'string') return value;
  try {
    const key = await getKey();
    const bytes = b64decode(value.__enc);
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (e) {
    console.warn('[collab] field failed to decrypt (wrong password derivation?)', e);
    return '⚠ undecryptable';
  }
}
