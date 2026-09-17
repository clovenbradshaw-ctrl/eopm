/**
 * store.js — event send + live fold for the collab canvas
 *
 * Deliberately bypasses operators.js's emit()/outbox.js: that path vault-
 * encrypts every record to IndexedDB and its OutboxFlusher refuses to send
 * anything into a room until crypto.isEncryptionEnabledInRoom() is true
 * (outbox.js's _send()). Collab rooms don't use Matrix's own room
 * encryption (m.room.encryption/Megolm) — see crypto.js for why and what
 * runs instead: every INS payload field and DEF value is encrypted with a
 * password-derived AES-GCM key before it leaves this module, so the
 * homeserver stores ciphertext for actual content either way, just without
 * Megolm's late-joiner key-sharing problem. ins()/def() here mirror
 * operators.js's exact content shapes (so src/fold.js's dispatch reads
 * `anchor`/`path`/`entity_type` identically — those stay in clear, only
 * the values are encrypted).
 *
 * Sends go through a raw authenticated PUT (the client's own token/baseUrl,
 * same endpoint client.sendEvent() would hit), not client.sendEvent()
 * itself. Measured directly against this homeserver: a bare PUT right
 * after join succeeds in under 200ms, every time, including against a
 * 1000+-event room — but client.sendEvent() on the exact same
 * join-then-send sequence could 403 "not in room" for 30+ seconds despite
 * the account being genuinely joined (confirmed independently via
 * /joined_members while the SDK path was still failing). Something in the
 * SDK's send pipeline — not the account, not the room, not the server —
 * was the slow part; going around it removes the delay. The cost is
 * losing the SDK's automatic local-echo, so a just-created object won't
 * render for its own author until the real event round-trips via /sync —
 * acceptable since /sync itself was never the slow part.
 */
import { getClient } from '../src/client.js';
import { onTimeline, onDecrypted, onLocalEchoUpdated, getTimeline, loadFullTimeline } from '../src/rooms.js';
import { fold, cyrb53 } from '../src/fold.js';
import { OP, eventType } from '../src/operators.js';
import { encryptField, decryptField } from './crypto.js';

function txnId() {
  return 'c' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now() + Math.random().toString(36).slice(2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Raw PUT, not client.sendEvent() — see the module doc comment for why.
// The retry is a much smaller safety net now (a handful of attempts, not
// the 40 the SDK path needed): a bare authenticated PUT right after join
// has measured at under 200ms consistently, so this only covers genuine
// brief hiccups, not a structural delay.
async function send(roomId, op, content, attempt = 0) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const url = `${client.getHomeserverUrl()}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType(op))}/${encodeURIComponent(txnId())}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.getAccessToken()}`,
    },
    body: JSON.stringify(content),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const notYetJoined = res.status === 403 && /not in room/i.test(data?.error || '');
  if (notYetJoined && attempt < 8) {
    console.warn(`[collab] not-in-room on attempt ${attempt}, retrying…`, data);
    await sleep(500);
    return send(roomId, op, content, attempt + 1);
  }
  const err = new Error(data?.error || `send failed [${res.status}]`);
  err.httpStatus = res.status;
  err.data = data;
  throw err;
}

/**
 * INS — mirrors operators.js's ins(): same content-addressed anchor scheme.
 * Each field of `payload` is encrypted individually (not the payload object
 * as one blob) so decryption on the way back out is field-by-field — the
 * exact same shape a DEF's single encrypted `value` already needs, so one
 * decrypt pass handles entities built from either.
 *
 * The anchor hash is computed over the PLAINTEXT payload, not the
 * ciphertext — AES-GCM's random IV means the same plaintext never
 * encrypts to the same bytes twice, which would break "same creation
 * intent -> same anchor" if the hash ran over encrypted bytes instead.
 */
export async function ins(roomId, entityType, payload = {}) {
  const client = getClient();
  const sender = client ? client.getUserId() : 'anon';
  const ts = Date.now();
  const input = `${entityType}\0${JSON.stringify(payload)}\0${sender}\0${ts}`;
  const anchor = `${entityType}_${cyrb53(input).toString(16)}`;
  const encPayload = {};
  for (const [k, v] of Object.entries(payload)) encPayload[k] = await encryptField(v);
  await send(roomId, OP.INS, { anchor, entity_type: entityType, payload: encPayload });
  return anchor;
}

/** DEF — set a value within the current frame. `value` travels encrypted. */
export async function def(roomId, anchor, path, value) {
  return send(roomId, OP.DEF, { anchor, path, value: await encryptField(value) });
}

/**
 * DEF targeting schema — no anchor, path auto-prefixed with _schema. Left
 * in clear deliberately: it's only ever used for the deck title (cosmetic,
 * browser tab / header text), and App.jsx sets document.title from it
 * before the async decrypt pipeline is worth the complexity for one label.
 */
export async function defSchema(roomId, path, value) {
  return send(roomId, OP.DEF, { anchor: null, path: '_schema.' + path, value });
}

// Every top-level entity field that isn't one of fold.js's own bookkeeping
// keys (_anchor, _type, _created, _sender, _eventId, _hwm) came from either
// an INS payload field or a DEF value — both now travel as {__enc} blobs
// (see ins()/def() above) — so decrypting is a uniform walk, not two cases.
async function decryptEntities(state) {
  const entries = await Promise.all(
    Object.entries(state.entities).map(async ([anchor, entity]) => {
      const out = { ...entity };
      await Promise.all(Object.keys(out).map(async (k) => {
        if (k.startsWith('_')) return;
        if (out[k] && typeof out[k] === 'object' && typeof out[k].__enc === 'string') {
          out[k] = await decryptField(out[k]);
        }
      }));
      return [anchor, out];
    })
  );
  return { ...state, entities: Object.fromEntries(entries) };
}

/**
 * Load full history once, fold, and keep re-folding on every timeline
 * change (new events, decrypts, local-echo lifecycle). Room event counts
 * here are small (a few hundred), so a full re-fold per tick is cheap and
 * sidesteps any incremental-fold/local-echo-reconciliation edge cases.
 * Decryption happens here, once, so nothing downstream (Canvas, ObjectBox,
 * ThumbnailRail, PresenterMode) ever has to know fields are encrypted at
 * rest — they just read plain x/y/text/etc like before.
 *
 * @returns {function} unsubscribe
 */
export async function watchRoom(roomId, onState) {
  await loadFullTimeline(roomId);
  const refold = async () => onState(await decryptEntities(fold(getTimeline(roomId))));
  await refold();
  const un1 = onTimeline(roomId, refold);
  const un2 = onDecrypted(roomId, refold);
  const un3 = onLocalEchoUpdated(roomId, refold);
  return () => { un1(); un2(); un3(); };
}
