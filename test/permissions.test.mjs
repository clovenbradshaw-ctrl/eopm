/* Tests for src/permissions.js — the invite flow's power-level math.
 *
 * Runs on plain Node (no Matrix client, no browser). Covers the property
 * this exists to guarantee: a client never offers, and never *reports*,
 * a role the homeserver wouldn't actually let the inviter grant. The
 * headline case is the one that used to be a silent security bug in
 * invite-view.jsx — a plain editor (power level 0) cannot send
 * m.room.power_levels at all under this app's default room config
 * (state_default 50), so asking to invite someone as "viewer" (-1) must
 * come back ungrantable, not silently succeed at a higher level than
 * promised.
 *
 *   node test/permissions.test.mjs
 */
import assert from 'node:assert';
import { inviteCapabilityFromPowerLevels, canGrantLevel, VIEWER_PL, KEY_EXCHANGE_STATE_TYPES, keyExchangeTypesAbove } from '../src/permissions.js';

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const eq = (a, b) => assert.deepStrictEqual(a, b);

// This app's createRoom() always uses preset 'private_chat' and never
// overrides invite/state_default, so this is the shape every real room's
// power_levels has.
const DEFAULT_PL = {
  users: { '@owner:hs': 100 },
  users_default: 0,
  invite: 0,
  state_default: 50,
  events: {},
};

await test('room owner (PL 100) can invite and can grant both editor and viewer', async () => {
  const cap = inviteCapabilityFromPowerLevels(DEFAULT_PL, '@owner:hs');
  eq(cap.canInvite, true);
  eq(canGrantLevel(cap, 0), true);   // editor
  eq(canGrantLevel(cap, -1), true);  // viewer
});

await test('plain editor (PL 0, default) can invite and grant editor, but NOT viewer', async () => {
  const cap = inviteCapabilityFromPowerLevels(DEFAULT_PL, '@editor:hs');
  eq(cap.myLevel, 0);
  eq(cap.canInvite, true);
  eq(canGrantLevel(cap, 0), true);    // the room default — free, no power_levels send needed
  eq(canGrantLevel(cap, -1), false);  // would need to send m.room.power_levels at PL 0 < state_default 50
});

await test('a viewer (PL -1) cannot invite at all, so cannot grant anything', async () => {
  const plWithViewer = { ...DEFAULT_PL, users: { ...DEFAULT_PL.users, '@viewer:hs': -1 } };
  const cap = inviteCapabilityFromPowerLevels(plWithViewer, '@viewer:hs');
  eq(cap.canInvite, false);
  eq(canGrantLevel(cap, 0), false);
  eq(canGrantLevel(cap, -1), false);
});

await test('an elevated member (PL 60) can grant up to one below their own level', async () => {
  const plWithMod = { ...DEFAULT_PL, users: { ...DEFAULT_PL.users, '@mod:hs': 60 } };
  const cap = inviteCapabilityFromPowerLevels(plWithMod, '@mod:hs');
  eq(cap.canInvite, true);
  eq(cap.maxSettableLevel, 59);
  eq(canGrantLevel(cap, 59), true);
  eq(canGrantLevel(cap, 60), false); // can't hand out your own level or higher
  eq(canGrantLevel(cap, 0), true);   // still free as the room default
});

await test('an unlisted user falls back to users_default for their own level', async () => {
  const cap = inviteCapabilityFromPowerLevels(DEFAULT_PL, '@nobody:hs');
  eq(cap.myLevel, 0);
  eq(cap.canInvite, true);
});

await test('a per-event override for m.room.power_levels takes precedence over state_default', async () => {
  // A room that's locked down further: only PL 80+ may change power levels,
  // even though state_default is still the room's ordinary 50.
  const locked = { ...DEFAULT_PL, events: { 'm.room.power_levels': 80 }, users: { '@mod:hs': 60 } };
  const cap = inviteCapabilityFromPowerLevels(locked, '@mod:hs');
  eq(cap.canInvite, true);       // invite req is still 0
  eq(canGrantLevel(cap, -1), false); // but 60 < 80, so no power-level grants at all
});

await test('missing power_levels content (room state not yet synced) defaults safely', async () => {
  const cap = inviteCapabilityFromPowerLevels(null, '@anyone:hs');
  eq(cap.myLevel, 0);
  eq(cap.usersDefault, 0);
  eq(cap.canInvite, true); // spec default invite req is 0
  eq(canGrantLevel(cap, 0), true);
  eq(canGrantLevel(cap, -1), false); // spec default state_default (50) blocks it
});

await test('canGrantLevel is false for a null/undefined capability', async () => {
  eq(canGrantLevel(null, 0), false);
  eq(canGrantLevel(undefined, 0), false);
});


// ── key exchange must reach the lowest-powered member ──────────────────
//
// A viewer sits below events_default so the homeserver rejects their
// writes. But grantWorkspaceKey() only wraps the workspace key for members
// who have published a `member_key` — so if that state type requires more
// power than a viewer has, the viewer can never be granted the key and the
// room decrypts to nothing for them, permanently. "Read-only" has to mean
// read-only, not locked out.

const NS = 'io.matrix-events';
const withEvents = (level) => ({
  state_default: 50,
  events: Object.fromEntries(KEY_EXCHANGE_STATE_TYPES.map(t => [`${NS}.${t}`, level])),
});

await test('a room pinning key-exchange state at PL 0 strands every viewer', () => {
  const stale = keyExchangeTypesAbove(withEvents(0), NS, VIEWER_PL);
  eq(stale.length, KEY_EXCHANGE_STATE_TYPES.length);
  assert.ok(stale.includes(`${NS}.member_key`),
    'member_key is the one that decides whether anyone can grant them the key');
});

await test('a room opened down to the viewer level needs no repair', () => {
  eq(keyExchangeTypesAbove(withEvents(VIEWER_PL), NS, VIEWER_PL), []);
});

await test('a room with no override at all is stale — state_default (50) excludes everyone', () => {
  eq(keyExchangeTypesAbove({}, NS, VIEWER_PL).length, KEY_EXCHANGE_STATE_TYPES.length);
  eq(keyExchangeTypesAbove(null, NS, VIEWER_PL).length, KEY_EXCHANGE_STATE_TYPES.length);
});

await test('only the types actually above the level are reported', () => {
  const mixed = { state_default: 50, events: {
    [`${NS}.member_key`]: VIEWER_PL,
    [`${NS}.wkey`]: VIEWER_PL,
    [`${NS}.blocks`]: 0,
    [`${NS}.member_status`]: 0,
  } };
  const stale = keyExchangeTypesAbove(mixed, NS, VIEWER_PL);
  eq(stale.sort(), [`${NS}.blocks`, `${NS}.member_status`].sort());
});

await test('a viewer is below events_default, so the homeserver still rejects their writes', () => {
  // The whole point of VIEWER_PL is that read-only is enforced by the
  // server. Opening the sender-scoped state types must not disturb that.
  const pl = { ...withEvents(VIEWER_PL), events_default: 0 };
  assert.ok(VIEWER_PL < (pl.events_default ?? 0),
    'a viewer must sit below events_default or they can write operators');
});

await test('the repair is namespace-scoped — another app\'s state is never touched', () => {
  const stale = keyExchangeTypesAbove(withEvents(0), NS, VIEWER_PL);
  assert.ok(stale.every(t => t.startsWith(`${NS}.`)), stale.join(', '));
});

console.log(`\n${passed} passed`);
