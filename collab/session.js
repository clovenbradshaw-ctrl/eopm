/**
 * session.js — silent account bootstrap. No login/signup UI, ever.
 *
 * register()+login(...,{persist:true}) mints a throwaway account and
 * stashes its vault-unlock key to localStorage ("keep me signed in").
 * tryAutoUnlock() reads that stash back on any later visit — same device,
 * any tab — so a returning visitor never sees a form. This is exactly
 * eopm's own invite-link claim flow (src/client.js), reused as-is.
 */
import { register, login, tryAutoUnlock, hasLocalAccount, getClient } from '../src/client.js';
import { getLastUser } from '../src/vault.js';
import { setDisplayName } from '../src/rooms.js';
import { HOMESERVER } from './slug.js';

export async function ensureSession() {
  const last = getLastUser();
  if (last && hasLocalAccount(last)) {
    try {
      await tryAutoUnlock();
      if (getClient()) return getClient().getUserId();
    } catch {
      // fall through to a fresh registration below
    }
  }

  const acct = await register(HOMESERVER, {});
  // login()'s homeserver discovery does `new URL(rawHs)` unless `username`
  // is a full mxid (contains ':') — pass acct.mxid, not just the localpart,
  // so it takes that branch instead of choking on a bare domain string.
  await login(HOMESERVER, acct.mxid, acct.password, { persist: true });
  try { await setDisplayName('Guest'); } catch { /* cosmetic only */ }
  return getClient().getUserId();
}
