#!/usr/bin/env node
/**
 * seed-str-deck.mjs — one-time seed for the STR compliance deck collab canvas.
 *
 * Plain Node + fetch, no matrix-js-sdk. The collab app itself (collab/)
 * assumes a browser (WASM crypto, localStorage) — reusing it here would
 * mean running a crypto-initialized client under Node, untested and
 * unnecessary for a one-time script. This mirrors operators.js's INS/DEF
 * content shapes and anchor hash (cyrb53, kept in sync with
 * src/operators.js:38-50) and sends via plain REST, exactly like a real
 * visitor's browser would over the wire — including field-level
 * encryption, mirroring collab/crypto.js exactly (same SHA-256-derived
 * AES-GCM key from the shared gate password), via Node's built-in Web
 * Crypto (globalThis.crypto.subtle, Node 19+), so seeded content is
 * decryptable by the real app and isn't sitting there in plaintext.
 *
 * Mints its own throwaway guest account (open registration on
 * hyphae.social) rather than requiring an operator's own credentials —
 * consistent with "anyone can create a canvas" being the whole point of
 * this tool. Run once: `node scripts/seed-str-deck.mjs`.
 *
 * NOT idempotent: anchors hash in the send timestamp, so re-running this
 * against an already-seeded room duplicates every object. If a re-run is
 * needed, point SLUG at a fresh name.
 */

const HOMESERVER = 'hyphae.social';
const BASE = `https://${HOMESERVER}`;
const SLUG = process.env.SLUG || 'str-compliance';
const NS = 'io.matrix-events';
const SLIDE_W = 1280, SLIDE_H = 720;
const GATE_PASSWORD = 'STR DECK'; // must match collab/constants.js's GATE_PASSWORD

let encKeyPromise = null;
function getEncKey() {
  if (!encKeyPromise) {
    encKeyPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(GATE_PASSWORD))
      .then((hash) => crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt']));
  }
  return encKeyPromise;
}
async function encryptField(value) {
  const key = await getEncKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const combined = Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]);
  return { __enc: combined.toString('base64') };
}

const VIOLET = '#4C1D95';
const AMBER = '#F59E0B';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── cyrb53, copied from src/operators.js:38-50 / src/fold.js — must stay
// in sync with those; it's what makes an anchor content-addressed. ──
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

let accessToken = null;
let userId = null;
let txnCounter = 0;

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function hashid(len = 6) {
  const A = '23456789bcdfghjkmnpqrstvwxz';
  let out = '';
  for (let i = 0; i < len; i++) out += A[Math.floor(Math.random() * A.length)];
  return out;
}

async function registerGuest() {
  const username = 'seed-strdeck-' + hashid(5);
  const password = hashid(24);
  let body = { username, password, inhibit_login: true };
  let res = await api('POST', '/_matrix/client/v3/register', body);
  if (res.status === 401 && Array.isArray(res.data.flows)) {
    const session = res.data.session;
    const canDummy = res.data.flows.some((f) => (f.stages || []).every((s) => s === 'm.login.dummy'));
    if (!canDummy) throw new Error('Registration needs a flow this script cannot complete: ' + JSON.stringify(res.data.flows));
    res = await api('POST', '/_matrix/client/v3/register', { ...body, auth: { type: 'm.login.dummy', session } });
  }
  if (res.status !== 200) throw new Error('Registration failed: ' + JSON.stringify(res.data));
  console.log(`[seed] registered ${res.data.user_id || username}`);

  const loginRes = await api('POST', '/_matrix/client/v3/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: username },
    password,
    initial_device_display_name: 'str-deck seed script',
  });
  if (loginRes.status !== 200) throw new Error('Login failed: ' + JSON.stringify(loginRes.data));
  accessToken = loginRes.data.access_token;
  userId = loginRes.data.user_id;
  console.log(`[seed] logged in as ${userId}`);
}

async function joinOrCreateRoom(slug) {
  const alias = `#${slug}:${HOMESERVER}`;
  const dir = await api('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`);
  if (dir.status === 200 && dir.data.room_id) {
    const join = await api('POST', `/_matrix/client/v3/join/${encodeURIComponent(alias)}`, {});
    if (join.status !== 200) throw new Error('Join existing room failed: ' + JSON.stringify(join.data));
    console.log(`[seed] joined existing room ${dir.data.room_id} — this room already exists; re-running will duplicate content, Ctrl+C now if that's not intended`);
    return dir.data.room_id;
  }

  const create = await api('POST', '/_matrix/client/v3/createRoom', {
    room_alias_name: slug,
    name: slug,
    visibility: 'private',
    preset: 'private_chat',
    initial_state: [
      { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'public' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
    ],
  });
  if (create.status !== 200) throw new Error('createRoom failed: ' + JSON.stringify(create.data));
  console.log(`[seed] created room ${create.data.room_id} aliased ${alias}`);
  return create.data.room_id;
}

// Right after room creation, the server's own send-auth check can lag a
// beat behind the creator's just-written join (observed directly against
// this homeserver while building the collab app — not specific to this
// script). Retry rather than guess a fixed delay.
async function send(roomId, opKey, content, attempt = 0) {
  // A steady small pace between sends, on top of retrying 429s — a seed
  // script's back-to-back bulk load is a different traffic shape than the
  // live app's human-paced drag/type commits, and the raised rc_message
  // burst (80) is sized for the latter, not ~800 sequential sends.
  await sleep(60);
  const txnId = 'seed' + Date.now() + '_' + (txnCounter++);
  const res = await api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${NS}.${opKey}/${txnId}`, content);
  if (res.status === 200) return res.data.event_id;
  const notYetJoined = res.status === 403 && /not in room/i.test(res.data?.error || '');
  const rateLimited = res.status === 429;
  if ((notYetJoined || rateLimited) && attempt < 30) {
    await sleep(rateLimited ? Math.max(200, (res.data?.retry_after_ms || 500) + 50) : 1000);
    return send(roomId, opKey, content, attempt + 1);
  }
  throw new Error(`send ${opKey} failed [${res.status}]: ${JSON.stringify(res.data)}`);
}

async function ins(roomId, entityType, payload = {}) {
  const ts = Date.now();
  // Hash the PLAINTEXT payload, not the (randomized-IV) ciphertext — the
  // anchor is a content-address of creation intent, and AES-GCM's random
  // IV means the same plaintext never encrypts to the same bytes twice.
  const input = `${entityType}\0${JSON.stringify(payload)}\0${userId}\0${ts}`;
  const anchor = `${entityType}_${cyrb53(input).toString(16)}`;
  const encPayload = {};
  for (const [k, v] of Object.entries(payload)) encPayload[k] = await encryptField(v);
  await send(roomId, 'ins', { anchor, entity_type: entityType, payload: encPayload });
  return anchor;
}

async function def(roomId, anchor, path, value) {
  await send(roomId, 'def', { anchor, path, value: await encryptField(value) });
}

let zCounter = 0;
async function addText(roomId, slideAnchor, { x, y, w, h, text, fontSize = 20, fontFamily = 'Inter, sans-serif', color = '#1a1a1a', bold = false, align = 'left', fill = 'transparent' }) {
  const anchor = await ins(roomId, 'object', { kind: 'text', slide: slideAnchor });
  await def(roomId, anchor, 'x', x);
  await def(roomId, anchor, 'y', y);
  await def(roomId, anchor, 'w', w);
  await def(roomId, anchor, 'h', h);
  await def(roomId, anchor, 'z', ++zCounter);
  await def(roomId, anchor, 'text', text);
  await def(roomId, anchor, 'fontSize', fontSize);
  await def(roomId, anchor, 'fontFamily', fontFamily);
  await def(roomId, anchor, 'color', color);
  await def(roomId, anchor, 'bold', bold);
  await def(roomId, anchor, 'align', align);
  await def(roomId, anchor, 'fill', fill);
  return anchor;
}

async function addShape(roomId, slideAnchor, { x, y, w, h, shapeType = 'rect', fill = 'none', stroke = 'none', strokeWidth = 0 }) {
  const anchor = await ins(roomId, 'object', { kind: 'shape', slide: slideAnchor });
  await def(roomId, anchor, 'x', x);
  await def(roomId, anchor, 'y', y);
  await def(roomId, anchor, 'w', w);
  await def(roomId, anchor, 'h', h);
  await def(roomId, anchor, 'z', ++zCounter);
  await def(roomId, anchor, 'shapeType', shapeType);
  await def(roomId, anchor, 'fill', fill);
  await def(roomId, anchor, 'stroke', stroke);
  await def(roomId, anchor, 'strokeWidth', strokeWidth);
  return anchor;
}

// House style's 3-ring orbital motif — 3 concentric ellipse outlines,
// decreasing violet opacity, + 1 filled dot on the outer ring. Ordinary
// seeded shape content; the app has no special case for it.
async function addMotif(roomId, slideAnchor) {
  const cx = 1200, cy = 60;
  const rings = [
    { r: 28, opacity: 0.6 },
    { r: 20, opacity: 0.4 },
    { r: 12, opacity: 0.25 },
  ];
  for (const ring of rings) {
    await addShape(roomId, slideAnchor, {
      x: cx - ring.r, y: cy - ring.r, w: ring.r * 2, h: ring.r * 2,
      shapeType: 'ellipse', fill: 'none', stroke: `rgba(76,29,149,${ring.opacity})`, strokeWidth: 2,
    });
  }
  await addShape(roomId, slideAnchor, { x: cx + rings[0].r - 4, y: cy - 4, w: 8, h: 8, shapeType: 'ellipse', fill: VIOLET });
}

function statusStyle(kind) {
  // violet solid = unblocked, violet outline = partial, amber = blocked/external
  if (kind === 'solid') return { fill: VIOLET, stroke: 'none' };
  if (kind === 'outline') return { fill: 'none', stroke: VIOLET, strokeWidth: 2 };
  return { fill: AMBER, stroke: 'none' }; // amber
}

async function addStatusBadge(roomId, slideAnchor, x, y, kind) {
  const style = statusStyle(kind);
  await addShape(roomId, slideAnchor, { x, y, w: 16, h: 16, shapeType: 'ellipse', ...style });
}

// ── Content, transcribed once from str-deck-content-export.md ──

const CONDITIONS = [
  { code: 'C01', text: 'An address must be queryable and evaluable before a registration exists.', status: 'PARTLY', jobs: '1, 2, 5, 8' },
  { code: 'C02', text: "What a host declares must become a fact about the property, not just the flow that collected it.", status: 'NOT YET', jobs: '1, 4, 5, 6, 7, 8' },
  { code: 'C03', text: 'The registered unit must be selectable at a level finer than the parcel.', status: 'ASK', jobs: '2, 8' },
  { code: 'C04', text: "A claim must carry what it's based on — not a score, the basis itself.", status: 'PARTLY', jobs: '1, 4, 6' },
  { code: 'C05', text: 'Occupancy or booking activity must be expressible as a dated interval.', status: 'ASK', jobs: '3, 9' },
];

const JOB_SLIDES = [
  {
    kicker: 'JOB 1', title: 'Registration Obligations & Amounts Owed', statusKind: 'outline',
    statusLine: 'PARTIALLY UNBLOCKS · Conditions: C01, C02, C04',
    outstanding: "3 of 5 cities keep the fee out of the ordinance, set in a separate instrument Slate's scripts already hold. Everything else is a retrieval problem.",
    ux: ['A host sees what’s owed, and why, in one place, not spread across the flow', 'Eligibility answered before time or money is spent, not after', 'A reviewer’s decision comes with the reason attached'],
    infra: ['Address queryable & evaluable before a registration exists (C01)', 'Declared data retrievable as a property fact, not just inside the flow (C02)', 'Every claim shown to a registrant carries what it’s based on (C04)', 'A stable per-city source of truth for the fee, where it isn’t in the ordinance'],
  },
  {
    kicker: 'JOB 2', title: 'Registration Fee Calculation', statusKind: 'amber',
    statusLine: 'BLOCKED — CONDITION 03 · Conditions: C01, C03',
    outstanding: 'Unit counts need asset granularity below the parcel. Unconfirmed whether the business-licensing precedent generalizes here.',
    ux: ['A host sees the fee broken down by what drove it, not just a total', 'The fee reflects actual property type and unit count, not a guess', 'Shown early enough to inform whether to register at all'],
    infra: ['Registrable unit selectable at a level finer than the parcel (C03)', 'Property type resolvable from zoning & occupancy before the fee step runs (C01)', 'Unconfirmed whether the business-licensing precedent for sub-parcel assets generalizes here'],
  },
  {
    kicker: 'JOB 3', title: 'Hotel & Occupancy Tax Estimation', statusKind: 'amber',
    statusLine: 'NOT ADDRESSED — EXTERNAL DATA · Condition: C05',
    outstanding: 'Weakest of the nine. Not solved by the projection. Azora says competitors overstate this figure.',
    ux: ['No actor in the current journeys touches this job, undefined until one does', 'Whoever owns it needs a confidence bar that can survive an appeal'],
    infra: ['Nights booked and revenue collected, both external to the system (C05)', 'Azora must confirm whether it supplies this at all', 'Revenue % is one route to "tax owed," not the job itself'],
  },
  {
    kicker: 'JOB 4', title: 'Listing Completeness Verification', statusKind: 'outline',
    statusLine: 'PARTIALLY UNBLOCKS · Conditions: C02, C04',
    outstanding: 'Declared side unblocks via projection. Vendor-side granularity is unconfirmed.',
    ux: ['A reviewer sees declared vs. observed side by side, not in two systems', 'A mismatch is flagged automatically, not found by hand'],
    infra: ['Declared and observed values sit on the same subject to compare (C02)', 'The comparison carries what it’s based on, once made (C04)', 'Azora must confirm whether listing attributes arrive at address level or only in aggregate'],
  },
  {
    kicker: 'JOB 5', title: 'Emergency Contact Distance Compliance', statusKind: 'solid',
    statusLine: 'UNBLOCKS VIA PROJECTION · Conditions: C01, C02',
    outstanding: 'Unblocks once the contact is asset-addressable. Watch the response-time cities.',
    ux: ['The check runs at the moment a contact is named, not after', 'Reflects how the city actually defines compliance, radius or response time'],
    infra: ['The declared contact is asset-addressable so distance can be computed (C01, C02)', 'The check supports response-time as an alternative to radius'],
  },
  {
    kicker: 'JOB 6', title: 'Registrant-to-Listing Match', statusKind: 'outline',
    statusLine: 'TECHNICAL CLEAR — POLICY OPEN · Conditions: C02, C04',
    outstanding: 'Technical path is the same as Job 4. The policy question is still open.',
    ux: ['A reviewer sees a mismatch with enough context to act on it', 'A wrongly flagged registrant has a way to dispute it'],
    infra: ['Same subject-matching requirement as Job 4 (C02, C04)', 'Someone decides what a staffer can act on from a mismatch alone'],
  },
  {
    kicker: 'JOB 7 & 8', title: 'Unregistered & Illegal STR Detection', statusKind: 'solid',
    statusLine: 'UNBLOCKS VIA PROJECTION · Conditions: C01, C02, C03',
    outstanding: 'Detection logic is reachable today. What’s missing for Job 7 is the screen. Job 8’s spatial sub-types resolve once assets are addressable.',
    ux: ['A staffer sees a map and filterable table of detected STRs, not a data dump', 'Sees which ones couldn’t be located, and how many', '"Detected" to "how hard to lean" has a visible gradient'],
    infra: ['Registrations asset-addressable for the three spatial sub-types (C01, C02, C03)', 'Per-owner concentration reuses asset-side identity resolution', 'Non-owner-occupied inherits Job 6’s declared-vs-observed dependency'],
  },
  {
    kicker: 'JOB 9', title: 'Upcoming Booking Dates for Inspection', statusKind: 'amber',
    statusLine: 'NOT ADDRESSED — EXTERNAL DATA · Condition: C05',
    outstanding: 'Not solved by the projection. Fully dependent on vendor data not yet confirmed.',
    ux: ['An inspector sees which addresses, in what order, and when each is next in use', 'A wasted trip is an acceptable cost here, unlike Job 3'],
    infra: ['Azora confirms whether it supplies forward-looking availability at all (C05)', 'Its own confidence bar, separate from Job 3'],
  },
];

async function seedCoverSlide(roomId, order) {
  const slideAnchor = await ins(roomId, 'slide', {});
  await def(roomId, slideAnchor, 'order', order);
  await addText(roomId, slideAnchor, { x: 80, y: 80, w: 1120, h: 30, text: 'INTERNAL ENGINEERING BRIEFING', fontSize: 14, color: VIOLET, bold: true });
  await addText(roomId, slideAnchor, { x: 80, y: 120, w: 1120, h: 140, text: 'STR Compliance & Data Model Gap Analysis', fontSize: 52, fontFamily: 'EB Garamond, serif', bold: true, color: VIOLET });
  await addText(roomId, slideAnchor, { x: 80, y: 280, w: 1120, h: 70, text: "Nine priority jobs, evaluated against Slate's workflow model and Building Blocks' asset model.", fontSize: 20, color: '#444' });
  await addText(roomId, slideAnchor, {
    x: 80, y: 400, w: 460, h: 140,
    text: '6 / 9 — priority jobs share one blocker: what a host declares in Slate never becomes a fact about the property.',
    fontSize: 26, bold: true, color: VIOLET,
  });
  await addText(roomId, slideAnchor, { x: 80, y: 600, w: 500, h: 36, text: 'Michael T. Lacy', fontSize: 20, fontFamily: 'EB Garamond, serif' });
  await addText(roomId, slideAnchor, { x: 80, y: 660, w: 700, h: 28, text: 'Slate x Building Blocks x Azora — September 2026', fontSize: 13, color: '#888' });
  await addMotif(roomId, slideAnchor);
  console.log('[seed] slide 1 (cover) done');
}

async function seedConditionsSlide(roomId, order) {
  const slideAnchor = await ins(roomId, 'slide', {});
  await def(roomId, slideAnchor, 'order', order);
  await addText(roomId, slideAnchor, { x: 80, y: 60, w: 1120, h: 26, text: 'FOUNDATION', fontSize: 13, color: VIOLET, bold: true });
  await addText(roomId, slideAnchor, { x: 80, y: 90, w: 1120, h: 60, text: 'Five Conditions, Nine Jobs', fontSize: 36, fontFamily: 'EB Garamond, serif', bold: true, color: VIOLET });
  await addText(roomId, slideAnchor, { x: 80, y: 155, w: 1120, h: 40, text: 'What has to be true for each job to close, and which jobs each condition serves.', fontSize: 16, color: '#444' });

  const colX = [80, 200, 680, 850]; // Condition / What must be true / Status / Jobs it serves
  const colW = [110, 460, 150, 250];
  const headers = ['Condition', 'What must be true', 'Status', 'Jobs it serves'];
  headers.forEach((h, i) => {
    addText(roomId, slideAnchor, { x: colX[i], y: 220, w: colW[i], h: 24, text: h, fontSize: 13, bold: true, color: '#888' });
  });
  for (let i = 0; i < CONDITIONS.length; i++) {
    const c = CONDITIONS[i];
    const y = 220 + 67 * (i + 1);
    await addText(roomId, slideAnchor, { x: colX[0], y, w: colW[0], h: 60, text: c.code, fontSize: 15, bold: true, color: VIOLET });
    await addText(roomId, slideAnchor, { x: colX[1], y, w: colW[1], h: 60, text: c.text, fontSize: 14, color: '#333' });
    await addText(roomId, slideAnchor, { x: colX[2], y, w: colW[2], h: 60, text: c.status, fontSize: 13, bold: true, color: c.status === 'NOT YET' ? AMBER : '#333' });
    await addText(roomId, slideAnchor, { x: colX[3], y, w: colW[3], h: 60, text: c.jobs, fontSize: 14, color: '#333' });
  }
  await addMotif(roomId, slideAnchor);
  console.log('[seed] slide 2 (conditions table) done');
}

async function seedJobSlide(roomId, order, job) {
  const slideAnchor = await ins(roomId, 'slide', {});
  await def(roomId, slideAnchor, 'order', order);
  await addText(roomId, slideAnchor, { x: 80, y: 60, w: 1120, h: 24, text: job.kicker, fontSize: 13, color: VIOLET, bold: true });
  await addText(roomId, slideAnchor, { x: 80, y: 88, w: 1000, h: 50, text: job.title, fontSize: 30, fontFamily: 'EB Garamond, serif', bold: true, color: VIOLET });
  await addStatusBadge(roomId, slideAnchor, 1080, 100, job.statusKind);
  await addText(roomId, slideAnchor, { x: 80, y: 145, w: 1120, h: 26, text: job.statusLine, fontSize: 14, bold: true, color: '#555' });
  await addText(roomId, slideAnchor, { x: 80, y: 190, w: 1120, h: 60, text: job.outstanding, fontSize: 15, color: '#444' });

  await addText(roomId, slideAnchor, { x: 80, y: 280, w: 520, h: 24, text: 'UX needed', fontSize: 14, bold: true, color: VIOLET });
  await addText(roomId, slideAnchor, { x: 80, y: 308, w: 520, h: 350, text: job.ux.map((l) => '• ' + l).join('\n\n'), fontSize: 14, color: '#333' });

  await addText(roomId, slideAnchor, { x: 680, y: 280, w: 520, h: 24, text: 'Infrastructure needed', fontSize: 14, bold: true, color: VIOLET });
  await addText(roomId, slideAnchor, { x: 680, y: 308, w: 520, h: 350, text: job.infra.map((l) => '• ' + l).join('\n\n'), fontSize: 14, color: '#333' });

  await addMotif(roomId, slideAnchor);
  console.log(`[seed] slide ${order + 1} (${job.kicker}) done`);
}

async function main() {
  await registerGuest();
  const roomId = await joinOrCreateRoom(SLUG);
  await def(roomId, null, '_schema.title', SLUG); // harmless if anchor:null path unsupported by a given fold version; title is cosmetic only
  await seedCoverSlide(roomId, 0);
  await seedConditionsSlide(roomId, 1);
  for (let i = 0; i < JOB_SLIDES.length; i++) {
    await seedJobSlide(roomId, 2 + i, JOB_SLIDES[i]);
  }
  console.log(`[seed] done — https://collab.hyphae.social/?${SLUG}`);
}

main().catch((e) => {
  console.error('[seed] failed:', e);
  process.exit(1);
});
