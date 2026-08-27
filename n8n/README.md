# send-email.workflow.json

Webhook-triggered n8n workflow that sends email through a **Gmail** node.
Same shape as the `n8n → Google Drive` mirror in [`BUILDING.md`](../BUILDING.md#optional-off-site-mirror-n8n--google-drive-srcdrivebackupjs):
a webhook, a shared-secret gate, then the actual work.

## Setup

1. Import `send-email.workflow.json` into n8n.
2. Add a **Gmail OAuth2** credential in n8n (Settings → Credentials), then
   open the `Gmail` node and select it — this replaces the
   `REPLACE_WITH_CREDENTIAL_ID` placeholder.
3. Set the `EMAIL_WEBHOOK_SECRET` environment variable on the n8n instance
   (any random string). Callers must send it back as a header, or the
   workflow returns 401.
4. Activate the workflow. Note the webhook's production URL
   (`.../webhook/send-email`).

## Calling it

```bash
curl -X POST https://<your-n8n-host>/webhook/send-email \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: <EMAIL_WEBHOOK_SECRET>" \
  -d '{
    "to": "someone@example.com",
    "subject": "Hello",
    "html": "<p>Hi there</p>"
  }'
```

Body fields: `to` (required), `subject`, `text` or `html` (one of them),
optional `cc`, `bcc`, `replyTo`.

Response is `{ ok, id, threadId }` on success (200), `{ ok: false, error }`
on a Gmail send failure (502) or bad/missing secret (401).

## Notes

- The secret is a shared string, not per-caller — fine for a single trusted
  client (e.g. eopm calling it server-side-ish from a webhook, the way
  `drivebackup.js` calls its own n8n webhooks). If multiple callers need
  distinct identities or revocable access, swap the `Authorized?` check for
  the same bearer-token-against-homeserver-allowlist pattern `drivebackup.js`
  uses instead of a static secret.
- `EMAIL_WEBHOOK_SECRET` never appears in the workflow JSON — it's read from
  the n8n process environment at execution time.
