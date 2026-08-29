/**
 * emailWebhook.js — send email through an n8n webhook, as yourself.
 *
 * The webhook (n8n.intelechia.com/webhook/send-email, backed by Gmail)
 * authenticates the caller by their **Matrix access token**: it forwards
 * the token to a pinned homeserver's `/account/whoami`, and only sends if
 * the homeserver recognises it. The workflow then reads the sender's
 * display name from their Matrix profile and puts their verified Matrix ID
 * in the body — see n8n/send-email.workflow.json.
 *
 * This replaced a shared `x-webhook-secret`. That secret was one string
 * for everyone, so the workflow could not tell who was sending, every
 * device had to be handed it before it could send anything, and anyone
 * holding it could send as the project forever. A Matrix token is already
 * in hand the moment someone signs in, is scoped to one person, and stops
 * working when they sign out — so there is nothing left to set up, and
 * every message can honestly say who sent it.
 *
 * No credential is stored by this module. The token is read from the live
 * session at send time through an injected provider, so it is never copied
 * anywhere it would then have to be cleaned up.
 */

const DEFAULT_WEBHOOK_URL = 'https://n8n.intelechia.com/webhook/send-email';

let config = { webhookUrl: DEFAULT_WEBHOOK_URL };

// Supplied by main.js: () => ({ token, userId }) for the signed-in session,
// or null when nobody is signed in.
let authProvider = () => null;

/** Wire up where the Matrix access token comes from. */
export function setAuthProvider(fn) {
  authProvider = typeof fn === 'function' ? fn : () => null;
}

function normalize(cfg = {}) {
  return { webhookUrl: (cfg.webhookUrl || DEFAULT_WEBHOOK_URL).trim() };
}

export function configure(cfg) {
  config = normalize(cfg);
  return getConfig();
}

/**
 * Current config (a copy), with a derived `canSend`.
 *
 * Being signed in IS the configuration now, so `canSend` asks about the
 * session rather than about a stored secret. Nothing to paste, nothing to
 * forget on a new device.
 */
export function getConfig() {
  const auth = authProvider();
  return {
    ...config,
    canSend: !!(config.webhookUrl && auth?.token),
    sendingAs: auth?.userId || null,
  };
}

export function clearConfig() {
  config = { webhookUrl: DEFAULT_WEBHOOK_URL };
}

/**
 * Send one email through the webhook. Throws a plain-language error on
 * any failure (not configured, network error, non-2xx / {ok:false}
 * response) so callers can show `e.message` directly.
 */
export async function sendEmail({ to, subject, html, text, cc, bcc, replyTo }) {
  const auth = authProvider();
  if (!auth?.token) {
    const e = new Error('Sign in before sending email.');
    e.code = 'not_signed_in';
    throw e;
  }
  if (!to) throw new Error('Missing recipient.');

  let res;
  try {
    res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The workflow hands this straight to the homeserver's whoami and
        // sends as whoever comes back. Nothing here claims an identity —
        // the token is the claim, and the homeserver settles it.
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ to, subject, html, text, cc, bcc, replyTo }),
    });
  } catch (e) {
    throw new Error('Could not reach the email service — check your connection.');
  }

  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error body */ }

  if (res.status === 401) throw new Error('The email service did not recognise your sign-in. Signing out and back in should fix it.');
  if (!res.ok || data.ok === false) throw new Error(data.error || `Email send failed (${res.status})`);
  return data;
}
