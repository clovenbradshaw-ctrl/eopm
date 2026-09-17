/**
 * slug.js — resolve a URL slug to a room, creating it if it doesn't exist.
 *
 * Matrix aliases give this for free (client.joinRoom accepts an alias
 * string directly), so this calls matrix-js-sdk straight rather than going
 * through src/rooms.js's createRoom(), which hardcodes invite-only private
 * rooms and never sets a room_alias_name.
 */
import { getClient } from '../src/client.js';
import { ins, def } from './store.js';

export const HOMESERVER = 'hyphae.social';

export function normalizeSlug(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function seedBlankSlide(roomId) {
  const anchor = await ins(roomId, 'slide', {});
  await def(roomId, anchor, 'order', 0);
}

/**
 * Join the room aliased `slug` if it exists; otherwise create it (unlisted,
 * publicly joinable, unencrypted — see the plan's access-model decisions)
 * and seed one blank slide. Handles the race of two visitors hitting a
 * brand-new slug at once: Matrix enforces alias uniqueness atomically, so
 * the loser's createRoom fails with M_ROOM_IN_USE and an immediate join
 * after that is guaranteed to succeed.
 *
 * client.joinRoom() resolves with a matrix-js-sdk Room INSTANCE (`.roomId`),
 * not the `{room_id}` plain object client.createRoom() resolves with — an
 * easy trap since they read almost the same. Getting this wrong doesn't
 * throw; every join-path call silently carried `roomId: undefined`
 * afterward, which is a much nastier failure (every send target-ed
 * `/rooms/undefined/send/...` and 403'd "not in room undefined" forever,
 * which read exactly like a slow server-side race until traced).
 */
export async function joinOrCreate(slug) {
  const client = getClient();
  if (!client) throw new Error('Not connected');
  const alias = `#${slug}:${HOMESERVER}`;

  try {
    const room = await client.joinRoom(alias);
    return { roomId: room.roomId, created: false };
  } catch (e) {
    if (e?.errcode !== 'M_NOT_FOUND') throw e;
  }

  try {
    const { room_id } = await client.createRoom({
      room_alias_name: slug,
      name: slug,
      visibility: 'private', // unlisted — not invite-only, see join_rules below
      preset: 'private_chat',
      initial_state: [
        { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'public' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
      ],
    });
    try { await client.joinRoom(room_id); } catch { /* createRoom already joins the creator on most homeservers */ }
    await seedBlankSlide(room_id);
    return { roomId: room_id, created: true };
  } catch (e2) {
    if (e2?.errcode === 'M_ROOM_IN_USE') {
      const room = await client.joinRoom(alias);
      return { roomId: room.roomId, created: false };
    }
    throw e2;
  }
}
