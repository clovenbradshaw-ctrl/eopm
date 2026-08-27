/**
 * emailWebhook.js — send email through a shared n8n webhook.
 *
 * The webhook (n8n.intelechia.com/webhook/send-email, backed by Gmail)
 * requires an `x-webhook-secret` header the sender proves knowledge of;
 * everything else in the body is plain routing (to/subject/html). The
 * secret is the only thing that has to stay private, so it's stored
 * vault-encrypted per device/user — same pattern as drivebackup.js's
 * config — and never written to the operator log or shared over Matrix.
 *
 * Mirrors drivebackup.js's configure/getConfig/loadConfig/saveConfig
 * shape on purpose, so main.js wires this in exactly the same way it
 * already wires in Drive backup.
 */

const SECRET_NAME = 'email_webhook_v1';
const DEFAULT_WEBHOOK_URL = 'https://n8n.intelechia.com/webhook/send-email';

let config = { webhookUrl: DEFAULT_WEBHOOK_URL, secret: '' };

function normalize(cfg = {}) {
  return {
    webhookUrl: (cfg.webhookUrl || DEFAULT_WEBHOOK_URL).trim(),
    secret: (cfg.secret || '').trim(),
  };
}

export function configure(cfg) {
  config = normalize(cfg);
  return getConfig();
}

/** Current config (a copy), with a derived `canSend`. */
export function getConfig() {
  return { ...config, canSend: !!(config.webhookUrl && config.secret) };
}

/** Load this user's config from the vault secret store into memory. */
export async function loadConfig(userId, loadSecret) {
  try {
    const raw = await loadSecret(userId, SECRET_NAME);
    configure(raw ? JSON.parse(raw) : {});
  } catch {
    configure({});
  }
  return getConfig();
}

/** Persist this user's config (vault-encrypted) and apply it in memory. */
export async function saveConfig(userId, cfg, { storeSecret, removeSecret }) {
  const next = normalize(cfg);
  configure(next);
  if (next.secret) {
    await storeSecret(userId, SECRET_NAME, JSON.stringify(next));
  } else if (removeSecret) {
    removeSecret(userId, SECRET_NAME);
  }
  return getConfig();
}

export function clearConfig() {
  config = { webhookUrl: DEFAULT_WEBHOOK_URL, secret: '' };
}

/**
 * Send one email through the webhook. Throws a plain-language error on
 * any failure (not configured, network error, non-2xx / {ok:false}
 * response) so callers can show `e.message` directly.
 */
export async function sendEmail({ to, subject, html, text, cc, bcc, replyTo }) {
  if (!config.secret) { const e = new Error('Email sending is not configured yet.'); e.code = 'not_configured'; throw e; }
  if (!to) throw new Error('Missing recipient.');

  let res;
  try {
    res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': config.secret },
      body: JSON.stringify({ to, subject, html, text, cc, bcc, replyTo }),
    });
  } catch (e) {
    throw new Error('Could not reach the email service — check your connection.');
  }

  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error body */ }

  if (res.status === 401) throw new Error('Email webhook rejected the secret — check it and try again.');
  if (!res.ok || data.ok === false) throw new Error(data.error || `Email send failed (${res.status})`);
  return data;
}
