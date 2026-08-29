# send-email.workflow.json

Webhook-triggered n8n workflow that sends email through a **Gmail** node,
authenticated as the **Matrix user making the call** and sent under that
person's own display name.

The caller proves who they are with their Matrix access token. The workflow
replays that token to the homeserver's `/account/whoami`, and only sends if
the homeserver recognises it — the same
bearer-token-against-the-homeserver pattern
[`drivebackup.js`](../src/drivebackup.js) uses.

## Why not a shared secret

The previous version gated on one `x-webhook-secret` string. That meant the
workflow could not tell who was sending, every device had to be handed the
secret before it could send anything, and anyone who ever held it could keep
sending as the project indefinitely.

A Matrix access token is already in hand the moment somebody signs in, is
scoped to one person, and stops working when they sign out. So there is
nothing to configure on a new device, and every message can honestly say
who sent it.

## Setup

1. Import `send-email.workflow.json` into n8n.
2. Add a **Gmail OAuth2** credential (Settings → Credentials), then open the
   `Gmail` node and select it — this replaces the
   `REPLACE_WITH_CREDENTIAL_ID` placeholder.
3. Set these environment variables on the n8n instance:
   - `MATRIX_HOMESERVER` — the base URL of the homeserver whose users may
     send, e.g. `https://hyphae.social`. **Required.**
   - `WORKSPACE_NAME` — optional; appears in the signature as "via …".
4. Activate the workflow. Note the production URL
   (`.../webhook/send-email`).

## Calling it

```bash
curl -X POST https://<your-n8n-host>/webhook/send-email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <matrix access token>" \
  -d '{
    "to": "someone@example.com",
    "subject": "Hello",
    "html": "<p>Hi there</p>"
  }'
```

Body fields: `to` (required), `subject`, `text` or `html` (one of them),
optional `cc`, `bcc`, `replyTo`.

Responses:

| code | body | when |
|------|------|------|
| 200 | `{ ok: true, id, threadId, sentAs }` | sent; `sentAs` is the verified Matrix ID |
| 400 | `{ ok: false, error }` | no recipient |
| 401 | `{ ok: false, error }` | the homeserver did not accept the token |
| 502 | `{ ok: false, error }` | Gmail refused the send |

## How "as that user" actually works

Gmail will not let a workflow put someone else's address in `From`, and
faking it is how a domain gets flagged as a spoofer. So the identity is
carried the two ways that are both honest and verifiable:

- **The display name** on the message is the sender's Matrix display name,
  read from `/profile/{user}/displayname` on the homeserver — not from the
  request body, so nobody can send under a name they do not own.
- **The Matrix ID** is appended to the body by the workflow itself, from the
  `whoami` result. A sender cannot dress a message up as coming from
  somebody else, because they never supply either value.

The `From` address remains the connected Gmail account. `replyTo` is passed
through from the request when present, so replies reach the sender.

## Notes

- `MATRIX_HOMESERVER` is read from the environment and **never** from the
  request. If the caller could name the homeserver, they could point this at
  a server they control and have it vouch for any `user_id` they liked.
- Any account on that homeserver can send. If that is broader than you want,
  add a room-membership or allowlist check after `Who is calling?`.
- n8n retains execution data, which includes the incoming `Authorization`
  header. Set the workflow's data retention accordingly, or prune
  executions, if that token sitting in history matters to you.
