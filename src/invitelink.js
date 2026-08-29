/**
 * invitelink.js — the share-link payload codec.
 *
 * Split out from client.js so it can be tested without dragging in
 * matrix-js-sdk, `location`, or browser storage. It is pure: strings in,
 * strings and plain objects out.
 *
 * Everything a share link needs rides in the URL **fragment**, which
 * browsers never send to a server: not in the request line, not in access
 * logs, not in a Referer header.
 *
 * A #welcome= payload carries two secrets, doing different jobs:
 *
 *   p  a one-time account password. Spent on first open — the claiming
 *      device immediately rotates it to a random device secret, so a
 *      forwarded copy of the link can no longer sign in as that account.
 *   k  the room's workspace key: a READ capability for the workspace's
 *      history. Not spendable, because it is the same key every member
 *      holds; revoking it means rotating the epoch. It travels in the
 *      link because Matrix auth rules mean only the recipient can publish
 *      their own member_key, so nobody can pre-grant to an account that
 *      has not opened the app yet — see exportWorkspaceKeyB64().
 *
 * A #join= payload deliberately carries neither: it is the link for
 * someone who signs in as themselves, so it is only a room id and a name.
 */

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return decodeURIComponent(escape(atob(String(str).replace(/-/g, '+').replace(/_/g, '/'))));
}

/**
 * How long a fresh invite stays openable. Long enough to survive a
 * weekend and an email thread; short enough that a link left in a chat
 * log for a year is not a standing door. Re-share to issue a new one.
 */
export const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function encodeInviteToken(payload) {
  return b64urlEncode(JSON.stringify({ v: 1, exp: Date.now() + INVITE_TTL_MS, ...(payload || {}) }));
}

/**
 * Decode a #welcome= token.
 *
 * Returns the payload; a `{ expired: true, rt }` marker when it has aged
 * out, so the landing page can say "ask for a new one" instead of the
 * generic failure it would otherwise show after a doomed login; and null
 * for anything malformed or missing a credential field — a half-payload
 * must never reach the claim path, which would build "@undefined:undefined"
 * and fire a hopeless login at a homeserver.
 */
export function decodeInviteToken(token) {
  let p;
  try { p = JSON.parse(b64urlDecode(token)); } catch (e) { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!p.u || !p.p || !p.hs) return null;
  if (p.exp && Date.now() > p.exp) return { expired: true, rt: p.rt || null };
  return p;
}

export function encodeJoinToken(payload) {
  return b64urlEncode(JSON.stringify(payload || {}));
}

export function decodeJoinToken(token) {
  try {
    const p = JSON.parse(b64urlDecode(token));
    if (p && p.r) return p;
  } catch (e) {}
  return null;
}
