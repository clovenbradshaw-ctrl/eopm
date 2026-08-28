/* Tests for the share-link mechanics: src/device.js (account naming) and
 * the #welcome=/#join= payload codec in src/client.js.
 *
 * The link codec is the security-carrying part, so the tests here are
 * mostly about what a malformed, stale, or hostile token must NOT do:
 * never yield a usable payload, never throw into the caller, and never
 * outlive its expiry.
 *
 *   node test/invite-link.test.mjs
 */
import assert from 'node:assert';
import {
  deviceLabel, browserLabel, deviceDisplayName,
  accountDisplayName, deviceFromDisplayName,
} from '../src/device.js';
import {
  encodeInviteToken, decodeInviteToken,
  encodeJoinToken, decodeJoinToken, INVITE_TTL_MS,
} from '../src/invitelink.js';

const UA = {
  iphone:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipad:    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  tablet:  'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  mac:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  linux:   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/121.0',
  cros:    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edge:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
};

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = assert.strictEqual;

// ── Device labelling ────────────────────────────────────────────────────

await test('device labels are coarse and human', () => {
  eq(deviceLabel(UA.iphone), 'iPhone');
  eq(deviceLabel(UA.ipad), 'iPad');
  eq(deviceLabel(UA.android), 'Android phone');
  eq(deviceLabel(UA.tablet), 'Android tablet');
  eq(deviceLabel(UA.mac), 'Mac');
  eq(deviceLabel(UA.windows), 'Windows PC');
  eq(deviceLabel(UA.linux), 'Linux PC');
  eq(deviceLabel(UA.cros), 'Chromebook');
});

await test('an unrecognisable UA degrades to a word that still reads', () => {
  eq(deviceLabel(''), 'device');
  eq(deviceLabel('some-headless-thing/1.0'), 'device');
  // "Your access lives on this device" — the fallback has to survive
  // being dropped into the sentences the UI builds.
  eq(accountDisplayName('Sam', ''), 'Sam');
});

await test('UA-CH hints are honoured when the UA string is uninformative', () => {
  eq(deviceLabel('Mozilla/5.0', { platform: 'Android', mobile: true }), 'Android phone');
  eq(deviceLabel('Mozilla/5.0', { platform: 'Android', mobile: false }), 'Android tablet');
  eq(deviceLabel('Mozilla/5.0', { platform: 'macOS' }), 'Mac');
});

await test('browser detection prefers the fork over what it was forked from', () => {
  // Edge and Chrome-on-iOS both carry Chrome/Safari markers.
  eq(browserLabel(UA.edge), 'Edge');
  eq(browserLabel(UA.mac), 'Chrome');
  eq(browserLabel(UA.iphone), 'Safari');
  eq(browserLabel(UA.linux), 'Firefox');
});

await test('the Matrix device name says what the device is', () => {
  eq(deviceDisplayName(UA.iphone), 'iPhone · Safari');
  eq(deviceDisplayName(UA.edge), 'Windows PC · Edge');
});

// ── Account naming: "what was typed" + "what it was typed on" ───────────

await test('account name combines the typed name and the device', () => {
  eq(accountDisplayName('Sam Rivera', UA.iphone), 'Sam Rivera (iPhone)');
  eq(accountDisplayName('  Sam Rivera  ', UA.mac), 'Sam Rivera (Mac)');
  eq(accountDisplayName('', UA.iphone), '');
});

await test('re-naming an already-suffixed name does not stack suffixes', () => {
  // This runs on every claim, and a returning user's existing display
  // name goes through it — "Sam (iPhone) (Mac)" would be the bug.
  const once = accountDisplayName('Sam Rivera', UA.iphone);
  eq(accountDisplayName(once, UA.mac), 'Sam Rivera (iPhone)');
});

await test('the device is recoverable from the display name', () => {
  eq(deviceFromDisplayName('Sam Rivera (iPhone)'), 'iPhone');
  eq(deviceFromDisplayName('Sam Rivera'), '');
});

// ── Link payload codec ──────────────────────────────────────────────────
//
// The real codec from src/invitelink.js. It only needs btoa/atob, which
// Node has had since 16 — no browser, no SDK.

const FULL = {
  hs: 'hyphae.social', u: 'sam-rivera-x3f9', p: 'one-time-secret',
  r: '!abc:hyphae.social', rt: 'Q3 Pipeline', n: 'Sam Rivera',
  role: 'editor', k: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
};
// Encode a payload verbatim (no `exp` stamped on), so tests can build
// the stale and half-formed tokens the encoder would never produce.
const rawEncode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

await test('a full payload round trips, workspace key included', () => {
  const out = decodeInviteToken(encodeInviteToken(FULL));
  for (const key of Object.keys(FULL)) assert.deepStrictEqual(out[key], FULL[key]);
  eq(out.v, 1);
  assert.ok(out.exp > Date.now(), 'a fresh link is not born expired');
  assert.ok(out.exp <= Date.now() + INVITE_TTL_MS);
});

await test('unicode names survive the codec', () => {
  eq(decodeInviteToken(encodeInviteToken({ ...FULL, n: 'Sofía Márquez 中文' })).n, 'Sofía Márquez 中文');
});

await test('the encoded token is URL-fragment safe', () => {
  // A '+' or '/' from plain base64 would be mangled by the address bar
  // and by every link-rewriting mail client in existence.
  const token = encodeInviteToken({ ...FULL, n: 'ÿÿÿ~~~???' });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

await test('an expired link is reported as expired, not as a login attempt', () => {
  const out = decodeInviteToken(rawEncode({ ...FULL, exp: Date.now() - 1 }));
  eq(out.expired, true);
  eq(out.rt, 'Q3 Pipeline');   // enough to name the room in the message
  eq(out.p, undefined);        // and NOT the credential
  eq(out.k, undefined);        // nor the workspace key
});

await test('a payload with no expiry still opens (links predating the TTL)', () => {
  eq(decodeInviteToken(rawEncode({ hs: FULL.hs, u: FULL.u, p: FULL.p, r: FULL.r })).u, FULL.u);
});

await test('garbage never yields a payload and never throws', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  for (const bad of ['', 'not base64 !!', b64('{'), b64('null'), b64('[]'),
                     b64('"a string"'), b64('123'), b64('[{"u":"x","p":"y","hs":"z"}]')]) {
    eq(decodeInviteToken(bad), null, JSON.stringify(bad));
  }
});

await test('a payload missing any credential field is refused', () => {
  // Half a payload must not reach claimInvite, which would otherwise
  // build "@undefined:undefined" and fire a doomed login at a homeserver.
  for (const drop of ['u', 'p', 'hs']) {
    const partial = { ...FULL };
    delete partial[drop];
    eq(decodeInviteToken(rawEncode(partial)), null, `missing ${drop}`);
  }
});

await test('the join link carries no secret at all', () => {
  // The #join= payload is the one shared casually, so its shape is the
  // guarantee: a room id and a title, and nothing that opens anything.
  const decoded = decodeJoinToken(encodeJoinToken({ r: '!abc:hyphae.social', rt: 'Q3 Pipeline' }));
  assert.deepStrictEqual(Object.keys(decoded).sort(), ['r', 'rt']);
  eq(decodeJoinToken(encodeJoinToken({ rt: 'no room id' })), null);
  eq(decodeJoinToken('nonsense!'), null);
});

console.log(`\n${passed} passed`);
