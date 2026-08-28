/**
 * permissions.js — pure Matrix power-level math for the invite flow.
 *
 * Deliberately free of client.js/matrix-js-sdk imports (unlike rooms.js) so
 * this runs in plain Node and is unit-testable without a live Matrix client
 * or browser globals. rooms.js's getInviteCapability() is the thin wrapper
 * that reads a room's actual m.room.power_levels content and calls into
 * this module.
 *
 * Why this exists: a room's power_levels content is the homeserver's own
 * enforcement of who can invite and who can grant what access — it isn't a
 * convention the client is free to interpret. A client that offers "invite
 * as viewer" without checking whether the inviter can actually set another
 * member's power level either fails with a raw server error, or — if that
 * failure isn't checked — silently leaves the invitee at the room's default
 * access instead, which for this app means full read-write instead of the
 * promised read-only. This module is the one place that answers "what can
 * this user actually grant?" so the UI and the emit path agree.
 */

/**
 * Derive what a user can do re: inviting + granting access in a room, from
 * the room's actual m.room.power_levels content (not assumed defaults).
 *
 * @param {object} plContent - m.room.power_levels event content, or
 *   null/{} if the room has none yet.
 * @param {string} userId - The user to compute capability for.
 * @returns {{ myLevel: number, usersDefault: number, canInvite: boolean, maxSettableLevel: number }}
 */
export function inviteCapabilityFromPowerLevels(plContent, userId) {
  const c = plContent || {};
  const users = c.users || {};
  const usersDefault = typeof c.users_default === 'number' ? c.users_default : 0;
  const myLevel = typeof users[userId] === 'number' ? users[userId] : usersDefault;

  const inviteReq = typeof c.invite === 'number' ? c.invite : 0;
  const canInvite = myLevel >= inviteReq;

  const eventsMap = c.events || {};
  const stateDefault = typeof c.state_default === 'number' ? c.state_default : 50;
  const plChangeReq = typeof eventsMap['m.room.power_levels'] === 'number'
    ? eventsMap['m.room.power_levels']
    : stateDefault;
  const canSetPowerLevels = myLevel >= plChangeReq;

  return {
    myLevel,
    usersDefault,
    canInvite,
    // Highest level this user could explicitly grant someone else via a
    // power_levels change. Homeservers reject granting a level >= your own,
    // so this is myLevel - 1 — or -Infinity if they can't send power_levels
    // changes at all. The room's default level is always reachable
    // regardless of this (see canGrantLevel): it needs no explicit grant.
    maxSettableLevel: canSetPowerLevels ? myLevel - 1 : -Infinity,
  };
}

/**
 * Can this capability actually deliver `level` to a new invitee? True
 * either because it's the room's no-override default (any inviter can
 * hand that out for free) or because the user has enough power to
 * explicitly set it.
 *
 * @param {ReturnType<typeof inviteCapabilityFromPowerLevels>} cap
 * @param {number} level
 */
export function canGrantLevel(cap, level) {
  return !!cap && cap.canInvite && (level === cap.usersDefault || level <= cap.maxSettableLevel);
}
