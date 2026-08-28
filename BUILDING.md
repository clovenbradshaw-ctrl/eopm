# Building on this repo

Instructions for a human or AI coder who wants to use this codebase to ship an
encrypted, federated app that **interoperates with every other app built on the
same primitives**.

This is not a chat client. It is a Matrix-backed, end-to-end encrypted,
append-only event store with a closed nine-operator algebra and a deterministic
state projection. You write the UI. Everything below it — auth, encryption,
sync, room management, event taxonomy, state projection, offline outbox,
encrypted media — is already here.

---

## 1. Read the repo in this order

You will understand the whole stack in under an hour by reading these files,
in this sequence:

1. `README.md` — one-page architecture diagram and the operator table.
2. `src/operators.js` (~180 lines) — the nine operators, the `emit()` path,
   namespace handling, content-addressed anchors.
3. `src/fold.js` (~375 lines) — the integral fold. `state(t) = fold(events[0..t])`.
   Read `dispatch()` and the dependency-ordering `_hwm` logic carefully.
4. `src/rooms.js` (~420 lines) — `createRoom`, `discoverRooms`, `getTimeline`,
   `onTimeline`, `invite`, members and power levels. Rooms are tables; room
   membership is the access model.
5. `src/client.js` (~490 lines) — login, restore, unlock, Rust-crypto init,
   sync. Most of this you never touch — call `login()`, `unlock()`, or
   `restoreSession()` and forget about it.
6. `src/media.js` — encrypted blob storage with the `__media: 2` event-content
   reference format. Anything over ~16 KB gets hoisted; the homeserver only
   ever sees ciphertext.
7. `src/outbox.js`, `src/store.js`, `src/network.js` — offline emit, local
   event cache (OPFS / IndexedDB), online/offline transitions. These exist so
   the app keeps working with no network.
8. `src/main.js` — reference wiring. Shows how a UI subscribes to live state,
   emits operators, handles optimistic echoes, and threads it all together.
9. `public/app.jsx`, `public/table-view.jsx`, `public/graph-view.jsx`,
   `public/db-view.jsx` — a working reference UI. Replace these to ship your
   own app.

After step 3 you will already be able to reason about the system. Steps 4–7
are how it stays usable in the real world (encryption, offline, large blobs,
flaky networks).

---

## 2. The mental model in one paragraph

A **room** is a table. A room's **timeline** is an append-only log of typed
events. Each event is one of seven stored operators (`INS`, `SEG`, `CON`,
`SYN`, `DEF`, `EVA`, `REC`); two more (`NUL`, `SIG`) are ephemeral and never
hit the log. The room is Megolm-encrypted, so the homeserver stores
ciphertext only. Current state is **never stored** — it is always derived by
folding the timeline through `dispatch()` (`src/fold.js`). Same events in,
same state out, on every device, in every app that uses the same namespace.
That last sentence is what makes interop work.

---

## 3. The interop contract

Two apps interoperate iff they agree on **four things**:

1. **Namespace.** The event type is `${NAMESPACE}.${op.key}`, e.g.
   `io.matrix-events.ins`. `operators.parseEventType()` ignores everything
   outside its namespace. To read another app's events you either share its
   namespace or run a second fold under that namespace.

   - **Same-app interop** (recommended default): pick one namespace per app
     family and use it everywhere. Call `setNamespace('com.acme.tasks')` at
     boot. Every install of every client in that family reads and writes the
     same room shape.
   - **Cross-app interop**: agree on a *shared* namespace for the rooms
     you want to federate (e.g. `org.eo.shared.docs`). Each app sets that
     namespace when it opens a shared room. App-private rooms keep their own
     namespace.

2. **Entity-type taxonomy.** `INS` carries `{ anchor, entity_type, payload }`.
   `entity_type` is a string — `'task'`, `'note'`, `'observation'`,
   `'message'`. Apps that agree on entity-type strings see each other's
   entities as the same kind of thing. Disagree and they coexist invisibly.

3. **Field paths under DEF.** `DEF` carries `{ anchor, path, value }` and
   sets `path` on the entity via `setPath()` (dot-notation). Two apps writing
   `def(anchor, 'status', 'done')` are talking about the same field. Two apps
   writing `'status'` vs `'state'` are not. Document your field paths; treat
   them like a public schema.

4. **Schema-as-log convention.** Schema lives in the same timeline as data,
   via `def(anchor=null, path='_schema.<...>', value)` (use
   `defSchema(roomId, path, value)`). The fold materializes it under
   `state.schema`. To onboard a new client: read `state.schema`, render UI
   accordingly. If your app wants to expose a stable schema to other apps,
   write a DEF on `_schema.tables.<entityType>.fields.*` at room creation
   time. Every cooperating client then knows the field set.

If all four match, **two clients written by different people, in different
languages, on different homeservers, see the same database.** That is the
federation guarantee. The homeserver only stores ciphertext; the agreement
lives in the namespace + taxonomy + field paths + schema log.

### Computed fields are schema, not data

A `_schema.fields.<set>` entry can declare a field as **computed**:

```js
{ name: 'Label',   type: 'formula', formula: 'CONCATENATE({Name}, " — ", {Status})' }
{ name: 'Hours',   type: 'rollup',  rollup: { via: 'Tasks', field: 'Hours', fn: 'sum' } }
```

The **expression lives in the schema log; the value is never stored.**
`public/formula.js` derives it at render time from the current fold state
(`window.Formula.evaluate` / `evaluateRollup`). A formula cell ignores any
value stored under its key — replay the log to any cursor and the computed
column re-derives for that moment. So you never `DEF` a computed value; you
`DEF` the formula once and the fold does the rest. The dialect is
spreadsheet-flavoured and case-insensitive — `{Field}` refs, `&` concat, `=`
equality, and the published function set (`SUM`/`IF`/`SWITCH`/`CONCATENATE`/
`ARRAYJOIN`/`REGEX_*`/`DATETIME_*`/`WORKDAY*`, …); rollups aggregate a field
across `CON` edges of a named relation. Function coverage is pinned in
`test/formula.test.cjs`.

### The drive: documents, folders, attachments

Files are entities in the same log as rows, so they replay, time-travel and
sync like anything else. `public/drive.js` is the whole data model:

```
folder    INS _folder {name, parent}   DEF name / parent   SEG _trashed
document  INS _doc    {name, mime, size, folder}
                      DEF file → the `__media` ref   DEF name / folder   SEG _trashed
```

Both types are `_`-prefixed, so `buildSets()` keeps them out of the sidebar's
set list — the drive (sidebar → **Drive**) is a lens on the log, not a table.

**An attachment is a reference, not a container.** A field of type
`attachment` holds an *array of document anchors*, written with a plain `DEF`
like any other cell:

```
attach   DEF <record> <field> [...existing, docAnchor]
detach   DEF <record> <field> [...existing without docAnchor]
```

So detaching writes to the **record**, never to the document — which is why a
file removed from a record stays in the drive, and why a file uploaded from a
record's cell appears in the drive the moment it is `INS`'d. There is no second
copy to keep in step, and *"attached to N records"* is just the reverse index
of those `DEF`s (`Drive.usageIndex`). `test/drive.test.mjs` pins this down
against the real fold.

**Reading documents natively.** The bytes of a drive document are plaintext
only inside the tab that holds the room key — handing them to Google Docs
Viewer or an Office web preview would undo the property the whole app is built
to hold. So `public/docview.js` parses them in the browser: a small ZIP reader
(`DecompressionStream('deflate-raw')`) plus a pull XML tokenizer gets
`.docx` / `.xlsx` / `.pptx` / `.odt` / `.ods` / `.odp`, and hand-rolled readers
cover `.csv` / `.tsv` / `.md` / `.json` / `.rtf` and zip listings. Each yields a
list of blocks (`h`, `p`, `li`, `table`, `sheet`, `slide`, `code`, `files`) the
viewer draws. It is a *content* reader, not a layout engine: it recovers text,
structure, tables and sheets, and says so rather than pretending to be Word.
Images, PDF, audio and video render straight from the bytes; anything with no
reader offers a download. `test/docview.test.mjs` runs the parsers against real
ZIP containers built in the test, on both the stored and deflated paths.

**Large files are split, and stay one document.** A homeserver's media endpoint
has a hard per-file ceiling (25 MB is a common default), and exceeding it does
not come back as a clean 413 — the proxy in front usually cuts the connection
mid-body, which the SDK can only report as a bare `AbortError`. So `media.js`
asks the server for `m.upload.size` once, and a file over it is uploaded as
ordered parts, each with **its own AES key**, under a manifest ref:

```
{ __media: 3, mime, size, name, parts: [{ mxc, size, file }, …] }
```

Reassembly is `media.js`'s business alone: `getMediaBytes` / `getMediaBlob`
stitch the parts back (each part mirrored to OPFS on its own, so an interrupted
download resumes from what already landed), and the drive shows one document —
one name, one size, one preview, one download. The chunk size is the server's
limit less some headroom, grown if a manifest would otherwise outgrow a single
64 KB event. `test/media-chunk.test.mjs` covers the split arithmetic and the
byte-exact round trip.

**Audio transcribes in the tab, and the text jumps back into the audio.**
There is no server to run Whisper on (this app has none — see the README's
whole pitch), so `src/transcribe.js` + `src/transcribe-worker.js` run it
client-side via `@huggingface/transformers`. The split matters: decoding the
file to mono 16kHz PCM (the Web Audio API's `decodeAudioData` +
`OfflineAudioContext` resampling — the browser equivalent of the media
chunking section's own `ffmpeg -ar 16000 -ac 1`) happens on the **main
thread**, because that decoder isn't reliably available inside a Worker; the
model download and the actual inference — the slow, blocking part — happen
**in the Worker**, so transcribing a long recording never freezes the tab.
Model weights come from Hugging Face's CDN on first use (the one network
dependency this adds, no different in kind from `data-chat.js`'s own lazy
load of the Cleo engine); the audio bytes themselves never leave the browser.

Deliberately full precision (`dtype: 'fp32'`), not left to the library's
per-model default — two reasons landed on the same setting. Forced 8-bit
quantization is a known cause of Whisper producing repeated garbage output
("we're going to say we're going to say…"), and separately, measured live
against `onnx-community/whisper-base`: leaving `dtype` unset resolves to a
mixed-precision decoder file missing a scale tensor ONNX Runtime needs, so it
refuses to create a session at all. `fp32` sidesteps both failure modes the
same way — no quantized weights, so neither bug's precondition exists.

The transcript is a `DEF <docAnchor> transcript {text, chunks, model,
transcribedAt}` — a log fact like any other field, so it replays,
time-travels, and shows up instantly on reopen with no re-transcription.
`chunks` is `[{text, start, end}]`, seconds into the audio; the drive's audio
preview renders each chunk as a clickable span that sets the `<audio>`
element's `currentTime` and highlights in step with playback via
`timeupdate` — read straight off the log fact, not local component state.

### Imported data is permanent: the media-store block chain

Where imported rows actually live, and why they survive anything short of
the homeserver losing its disk:

1. **Row bytes** — encrypted chunk blobs in the homeserver **media store**
   (the `ML.importFile` path above). Each blob has its own AES key.
2. **The pointer + key to every blob** — inside the import entity's
   op-events (`INS` + `DEF file`). Op-events ride the megolm timeline, and
   megolm is device-scoped: a browser wipe plus a failed key backup used to
   take the events — and with them the only copy of the blob keys — leaving
   the rows unreachable forever. That was the "imports don't persist" bug.
3. **The fix** — every committed op-event is *also* batched into a
   **hash-linked chain of encrypted blocks in the media store**
   (`src/blocks.js`). Each block is AES-GCM encrypted with the room's stable
   **Workspace Content Key** (ENCRYPTION-DESIGN.md), links the previous
   block's `{ mxc, sha256 }` git-style, and the chain head sits in room
   **state** (`<ns>.blocks`, one chain per member) — state events are never
   megolm-encrypted, so they always come back with the room.

Recovery after a total browser wipe needs only the login password:
`password → identity key (account_data "<ns>.identity") → workspace key
(room state "<ns>.wkey") → chain heads (room state "<ns>.blocks") → blocks
(media store) → replay`. No device identity, megolm session, cross-signing,
or key backup is involved. On every room open the bridge reconciles both
directions: events found in the chain but missing locally are replayed into
the store (this is what brings imports back), and committed events missing
from the chain are batched up (existing workspaces back-fill their full
history the first time they open after this feature).

The homeserver stays blind: it sees opaque blobs, opaque chain heads, and
wrapped keys it cannot open. Console diagnostics:

```js
window.MatrixLive.getBlockStats()          // per-room: headIdx, chainedEvents, queued, recovered
window.MatrixLive.forceBlockSync(roomId)   // tear down + re-run chain reconciliation
window.MatrixLive.hasEnvelopeIdentity()    // false ⇒ sign in with password once to mint it
```

Two operational notes. (a) The identity is created the first time you log
in **with a password** after this feature lands; cold-boot session restores
load it from the local vault cache. (b) In rooms created before this
feature, members below the state power level can't publish their chain
head; new rooms grant PL 0 for the three `<ns>.*` state types at creation.

### Optional off-site mirror: n8n → Google Drive (`src/drivebackup.js`)

The block chain lives on the homeserver's media store. If that store evicts
a blob under a retention policy — or a cold device pays a round-trip per
block — recovery degrades. `src/drivebackup.js` adds a **second copy of every
block in a place you control**: a Google Drive file reached through an n8n
webhook. It is **opt-in and purely additive** — the primary append/recovery
path is unchanged whether or not it is configured.

The encryption invariant holds. Each backed-up record is one block's
**WCK-encrypted ciphertext** — the same bytes already in the media store — so
n8n and Drive see opaque blobs they cannot decrypt. Every block read back is
verified against its `sha256` by `decodeBlock` before the fold trusts it, so a
malicious or buggy webhook can no more inject data than a tampered media blob
can. This is a **Drive-specific block cycle** layered beside the media-store
chain (which is left exactly as-is):

- **Backup (up).** `appendBlock` queues each committed block; `drivebackup`
  batches them and flushes **every ~100 events** (or after a short idle) as a
  length-prefixed **binary record stream**. Records accumulate into one
  **segment file** (genesis = segment 0) until it would exceed **25 MB**, then
  the client **rolls over** to a new segment. Best-effort and detached — a
  backup failure never affects the primary append.
- **Hydration (down).** `fetchBlock` replays each block from the **fastest
  source**: the local OPFS cache, else an already-pulled fresh Drive chain
  (sync, no network), else a **race** between the homeserver media store and
  Drive — first valid block wins. The whole Drive chain is pulled in **one
  GET** (every segment concatenated) and cached, so a hydration of N blocks
  costs one Drive request. *Latest* is guaranteed by the source of the block
  list: the room-state manifest/head is always current, and Drive can only
  ever serve a block whose `sha256` that manifest already names.
- **Genesis.** On sign-in, if Drive holds no segment yet, the client creates
  the empty genesis file (only on a *confirmed*-empty state, so a transient
  error never overwrites an existing chain).

Wire format — a self-delimiting binary record (segment boundaries are
irrelevant; a reader concatenates every segment and parses one flat stream):

```
[uint32 BE headerLen][header UTF-8 JSON {room,idx,sha256,mxc,ts,n}][ciphertext n bytes]
```

Auth uses your **live Matrix access token** (no app-managed secret): every
request carries `Authorization: Bearer <token>`, which the n8n flow replays to
the homeserver's `/account/whoami` and checks against an allowlist. The
contract is **three webhook nodes**:

```
GET  <stateUrl>    → JSON { index, bytes, exists } of the newest segment
POST <backupUrl>   headers X-Segment-Index:<n>, X-Segment-Mode:create|append
                   body  = the binary record stream (Content-Type octet-stream)
                   → upsert segment-<n> in Drive; respond { index, bytes }
GET  <hydrateUrl>  → application/octet-stream: every segment concatenated, oldest first
```

Config is per-user, **vault-encrypted at rest**, and set from the console:

```js
window.MatrixLive.setDriveBackup({
  stateUrl:   'https://n8n.intelechia.com/webhook/<state-id>',
  backupUrl:  'https://n8n.intelechia.com/webhook/731463c6-3200-4163-b497-7986bf5ad10d',
  hydrateUrl: 'https://n8n.intelechia.com/webhook/08ceaacf-326b-4c97-87b7-d5ec6b58f333',
});
window.MatrixLive.getDriveBackup()          // { stateUrl, backupUrl, hydrateUrl, canBackup, canHydrate }
await window.MatrixLive.testDriveBackup()    // hits hydrate → { ok, status, blocks }
```

---

## 4. Building a new app — the minimum viable path

You only need to do five things:

### a. Pick a namespace and entity taxonomy

```js
import { setNamespace } from './src/operators.js';
setNamespace('com.acme.fieldnotes');
// entity_type values you intend to use: 'observation', 'site', 'tag'
// field paths you intend to use:        'title', 'lat', 'lng', 'body', 'status'
```

Write these down. They are your wire format. Treat changes the same way you
treat database migrations — emit a `REC` event when the meaning of a field
changes; emit `DEF` on `_schema.*` when the shape changes.

### b. Authenticate

```js
import { login, unlock, restoreSession, hasLocalAccount } from './src/client.js';

if (await hasLocalAccount(userId)) await unlock(userId, password);
else                                await login(homeserver, mxid, password);
```

You do not implement auth. You do not store credentials. There are no API
keys to leak. The user brings their own homeserver the way they bring their
own email.

### c. Create or discover a room

```js
import { createRoom, discoverRooms } from './src/rooms.js';

// First time: create a workspace
const roomId = await createRoom('Site 42 notes', 'fieldnotes.workspace');

// Returning users: enumerate
const rooms = discoverRooms('fieldnotes.workspace');
```

`discoverRooms` filters by the `${NAMESPACE}.meta` state event written at
creation time. Other apps' rooms (including DMs) are invisible. This is the
app-scoping boundary.

### d. Emit operators and listen for the fold

```js
import { ins, def, seg, con, eva } from './src/operators.js';
import { getTimeline, onTimeline, onDecrypted, loadTimelineSince } from './src/rooms.js';
import { fold, foldFrom, initial, stateHash } from './src/fold.js';

let state = initial();

// 1. Seed: paginate history, then fold
await loadTimelineSince(roomId, 0);
state = fold(getTimeline(roomId));
render(state);

// 2. Live: incremental fold on every new event (and on late decrypts)
let lastHash = stateHash(state);
const refold = () => {
  state = fold(getTimeline(roomId));   // or foldFrom for hot paths
  const h = stateHash(state);
  if (h !== lastHash) { lastHash = h; render(state); }
};
onTimeline(roomId, refold);
onDecrypted(roomId, refold);

// 3. Mutate: every UI action becomes an operator emission
async function createObservation(payload) {
  const anchor = await ins(roomId, 'observation', payload);
  return anchor;
}
async function setField(anchor, path, value) { return def(roomId, anchor, path, value); }
async function archive(anchor)               { return seg(roomId, anchor, 'archived'); }
async function link(a, b, kind)              { return con(roomId, a, b, kind); }
async function judge(anchor, criterion, ok)  { return eva(roomId, anchor, criterion, ok ? 'pass' : 'fail'); }
```

The render function only reads from `state`. It never reads the network. It
never holds a parallel cache. If you find yourself maintaining a second
source of truth alongside the fold, you have left the model.

### e. Attach large data via the media pointer pattern

```js
import { uploadFile } from './src/media.js';
const ref = await uploadFile(file);                  // encrypted, returns the __media:2 ref
await ins(roomId, 'document', { title: file.name, file: ref });
// later: getMediaBytes(ref) → decrypted Uint8Array
```

Events are small (≤ ~24 KB after hoisting). Large data is a pointer in the
event to an encrypted blob in the media repo. Both sides of the pointer are
E2EE; the key lives in the (Megolm-encrypted) event content.

That's the whole loop: **state = fold(timeline); UI = render(state); action =
emit(operator)**. There is nothing else.

---

## 5. The operators, when to use which

| Op | Glyph | Triad | Use it when |
|----|-------|-------|--------------|
| `NUL` | ∅ | existence | Observation — you're reading state, not changing it. Never emitted. |
| `SIG` | ○ | existence | Attention — typing indicator, cursor presence, read receipt. Ephemeral, no log entry. (Not exposed in `operators.js` because nothing in the fold consumes it; use Matrix typing/receipt APIs directly if you need it.) |
| `INS` | ● | existence | Creating a new entity with a permanent identity. Mints a content-addressed anchor. |
| `SEG` | ｜ | structure | Moving an entity across a partition boundary — archive, inbox, column, tag. Partition is a string. |
| `CON` | ⤫ | structure | Creating a *typed* relationship between two existing anchors. |
| `SYN` | △ | structure | Merging multiple anchors into a new synthesized one. The synthesis is a new entity, not a mutation. |
| `DEF` | ⊢ | significance | Setting a value on an existing entity within the current frame. This is the workhorse — ~80% of your emits. |
| `EVA` | ⊨ | significance | Recording a judgment: did this entity satisfy a criterion? Pass/fail/hold + a note. EVA without prior DEF is flagged as "criterionless judgment." |
| `REC` | ⊛ | significance | The frame itself changed. A schema reinterpretation. Rare. Every entity is now legible under a new context. |

**Dependency rule** (enforced as advisory `_violations` by the fold, not as
hard errors): an entity's high-water mark cannot retreat. `EVA` on an entity
that has never had `DEF` raises a `criterionless_judgment`. `CON` to a
non-existent anchor raises `cartesian_product`. `REC` with no prior `EVA`
anywhere raises `blind_restructuring`. The fold records; your linter
diagnoses.

---

## 6. Federation, in practice

- **Inviting users.** `invite(roomId, '@kevin:matrix.org')`. The SDK shares
  Megolm keys with the new member automatically. They can be on any
  homeserver — federation handles the rest. No DNS for you to configure.
- **Cross-homeserver writes.** Identical to single-homeserver writes. The
  member's homeserver forwards events to every other homeserver in the room.
  Eventual consistency, milliseconds in practice.
- **Bots / AI agents.** A Matrix user (including a bot) joining the room is
  the agent-in-loop pattern. The bot sees the same E2EE event stream as
  humans; its emitted operators live in the same log. There is no separate
  AI backend to secure.
- **Provenance.** Every event is signed by its sender's device key.
  `state.entities[anchor]._sender` and `_eventId` are preserved by the fold.
  The room timeline is the audit trail; redaction (not deletion) is the only
  way to remove an event, and redactions are themselves events.

---

## 7. What to *not* do

- **Do not invent a backend.** No API server. No database. No edge function.
  No environment-variable secret. If you find yourself reaching for one,
  you've left the model — find the operator that fits instead.
- **Do not cache state outside the fold.** If a render needs derived data,
  derive it from `state` in a memoized selector. The fold result is the only
  source of truth; everything else is a projection of it.
- **Do not write to `_anchor`, `_type`, `_created`, `_hwm`, or any
  underscore-prefixed field** via `def()`. The fold owns those.
- **Do not delete events.** You cannot. The timeline is append-only.
  Redaction (`client.redactEvent`) tombstones an event but the position is
  retained. Model "deletion" as `seg(anchor, 'trash')` or as a `DEF`
  setting a `deleted_at` field.
- **Do not store secrets in event content.** The room is encrypted, but the
  contract here is "data the room's members may see," not "private to you."
  Per-user secrets belong in `vault.js` (vault-encrypted, never leaves the
  device).
- **Do not assume event size is unbounded.** ≥ ~16 KB string fields get
  hoisted to encrypted media automatically; oversized inline payloads will
  bounce off the homeserver's `max_event_size`. Use media refs for blobs.

---

## 8. Run it, deploy it

```bash
npm install
npm run dev          # http://localhost:5173, default homeserver matrix.org
npm run build        # produces ./dist
```

The `dist/` is plain static files. Drop them on GitHub Pages (the included
Action does this automatically on push to `main`), Netlify, Cloudflare Pages,
S3+CloudFront, a thumb drive, anywhere. There is no server side.

To target your own homeserver: change the homeserver URL in the login UI
(`public/matrix-auth.jsx`) or just type it into the field at runtime. To
host the homeserver too: install Synapse, Dendrite, or Conduit; nothing in
this codebase pins you to matrix.org.

---

## 9. Cross-app interoperability checklist

Before shipping, verify you've answered each of these — yes for an app
intended to interoperate, deliberately no for an isolated one:

- [ ] Namespace is documented and stable. (Versioning lives in the log via
      `DEF _schema.version`, not in the namespace.)
- [ ] Entity-type strings are documented (`'task'`, `'observation'`, etc.).
- [ ] Field paths are documented per entity type.
- [ ] The `_schema.tables.*` events are emitted on room creation so a fresh
      client can render without prior knowledge.
- [ ] Your UI degrades gracefully on unknown entity types and unknown field
      paths — never throws. Other apps in the room will emit operators you
      haven't seen.
- [ ] You preserve operator semantics. Do not overload `SEG` to mean
      "renaming" or `DEF` to mean "deleting." The whole interop guarantee
      depends on the operator algebra being shared vocabulary.
- [ ] If you redefine what a field means, emit `REC` with `before_frame` and
      `after_frame` so other clients can reproject.

When two apps respect this list, they can share rooms and each will see the
other's entities, edits, links, and judgments as first-class data — without
ever exchanging a line of code.

---

## 10. Where to put your code

- Replace `public/app.jsx` and its sibling views with your UI.
- Keep `src/*` intact. Treat it as a library. If you find you need to fork
  it, file an issue first — the goal is for every app to share this exact
  layer so the interop contract above actually holds.
- Custom entity types and field paths are app data, not library code: they
  belong in your UI's domain module, not in `operators.js`.

That is the entire job. Pick a namespace, pick a taxonomy, write a renderer
of `state`, emit operators on user input. The Matrix homeserver, the
encryption, the federation, the offline outbox, the encrypted media, and the
state projection are already done.
