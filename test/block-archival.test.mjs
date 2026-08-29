/* Tests for what goes INTO a member's block chain (queueBlockEvents in
 * src/main.js) and the dedup property that makes it safe.
 *
 *   node test/block-archival.test.mjs
 *
 * The rule under test: a member archives any op-event that is not in a
 * chain they could read, regardless of who wrote it.
 *
 * Why it matters, concretely. Every member writes only to their own chain,
 * so somebody else's work is durable only while THEIR chain stays
 * readable — and a chain written under a superseded workspace key never
 * becomes readable again. Those events still sit in the browser of whoever
 * was online when Megolm delivered them live. The result is an event one
 * person can see, no new member can, and that vanishes for the whole
 * workspace on a cache clear. Measured on a real workspace: the owner held
 * 98 events, only 45 were in readable chains, and a newly invited member
 * recovered exactly those 45 — every block decrypting, nothing failing,
 * just an archive that never contained the rest.
 *
 * queueBlockEvents itself lives in main.js, which reaches the browser at
 * import time and cannot run here. So this pins the two things that can
 * actually regress: the dedup-on-read property the rule leans on (tested
 * against the real codec), and the authorship filter itself (guarded
 * against the source).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mergeChainEvents } from '../src/crypto/blockcodec.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, '..', 'src', 'main.js'), 'utf8');

// The filter, mirrored from queueBlockEvents. Kept in step by the source
// guard at the bottom.
function wouldQueue(event, { me, chained }) {
  if (!event || event._pending) return false;
  if (!event.event_id || event.event_id.startsWith('~') || !event.event_id.startsWith('$')) return false;
  if (chained.has(event.event_id)) return false;
  return true;
}

const ev = (id, sender, extra = {}) => ({ event_id: id, sender, type: 'org.baremetalpm.def', content: {}, origin_server_ts: 1, ...extra });
const ME = '@me:hyphae.social';
const THEM = '@them:hyphae.social';

// ── what gets archived ─────────────────────────────────────────────────

await test("another member's event, held by nobody's readable chain, IS archived", () => {
  const chained = new Set();
  assert.strictEqual(wouldQueue(ev('$a', THEM), { me: ME, chained }), true,
    'this is the event a new member would otherwise never see');
});

await test('an event already in a readable chain is left alone, whoever wrote it', () => {
  const chained = new Set(['$a', '$b']);
  assert.strictEqual(wouldQueue(ev('$a', THEM), { me: ME, chained }), false);
  assert.strictEqual(wouldQueue(ev('$b', ME), { me: ME, chained }), false);
});

await test('a pending optimistic echo is never archived — it has no real id yet', () => {
  const chained = new Set();
  assert.strictEqual(wouldQueue(ev('$c', ME, { _pending: true }), { me: ME, chained }), false);
  assert.strictEqual(wouldQueue(ev('~local1', ME), { me: ME, chained }), false);
  assert.strictEqual(wouldQueue(ev('local1', ME), { me: ME, chained }), false);
});

await test('the real-workspace shape: 45 reachable, 53 orphaned, all 53 get archived', () => {
  const chained = new Set(Array.from({ length: 45 }, (_, i) => `$reach${i}`));
  const held = [
    ...Array.from({ length: 45 }, (_, i) => ev(`$reach${i}`, ME)),
    ...Array.from({ length: 53 }, (_, i) => ev(`$orphan${i}`, THEM)),
  ];
  const queued = held.filter(e => wouldQueue(e, { me: ME, chained }));
  assert.strictEqual(queued.length, 53);
  assert.ok(queued.every(e => e.sender === THEM));
});

// ── the property that makes it safe ────────────────────────────────────

await test('merging chains dedups by event_id, so re-archiving replays identically', () => {
  const shared = ev('$shared', THEM);
  // The same event archived by two different members, in two chains.
  const mine  = [[{ events: [ev('$mine', ME), shared] }]];   // one chain, one block
  const yours = [[{ events: [shared, ev('$yours', THEM)] }]]; // another member's chain
  const merged = mergeChainEvents([...mine, ...yours]);
  const ids = merged.map(e => e.event_id);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate survived the merge: ${ids.join(',')}`);
  assert.strictEqual(ids.filter(i => i === '$shared').length, 1);
});

await test('a re-archived event keeps its original sender — archiving is not authorship', () => {
  const original = ev('$x', THEM);
  const merged = mergeChainEvents([[{ events: [original] }]]);
  assert.strictEqual(merged[0].sender, THEM,
    're-archiving must never restate who wrote an event');
  assert.strictEqual(merged[0].event_id, '$x');
});

// ── the guard ──────────────────────────────────────────────────────────

await test('queueBlockEvents does NOT filter on authorship', () => {
  const start = mainSrc.indexOf('function queueBlockEvents');
  assert.ok(start > -1, 'queueBlockEvents not found — this guard needs updating');
  const body = mainSrc.slice(start, mainSrc.indexOf('\n}', start));

  // Reinstating an authorship SKIP silently re-breaks every future
  // member's view, and nothing else would fail. Referring to `sender` is
  // fine (the log line counts rescued events) — skipping on it is not.
  const skipsOnSender = body
    .split('\n')
    .some(line => /sender/.test(line) && /\bcontinue\b/.test(line));
  assert.ok(!skipsOnSender,
    'queueBlockEvents skips on sender again — others\' orphaned events would stop being archived, and new members would silently see less than everyone else');

  // It must still skip anything already reachable, or every member
  // re-archives the whole log on every load.
  assert.ok(/ctx\.chained\.has\(/.test(body),
    'the reachability check is gone — archiving would no longer be self-limiting');
});


// ── in-memory dedup ────────────────────────────────────────────────────
//
// The same event legitimately arrives from several sources: the OPFS store
// when a room opens, the megolm timeline, and the block chain during
// recovery. Concatenating each arrival kept every copy. The fold dedups by
// event_id so state was never wrong — but the room reported 98 events when
// it held 49, every event sat in memory twice, and anything reasoning about
// "how much is here" was misled. That inflated count is what made a
// complete archive look like it was missing half the workspace.

function appendRoomEvents(cur, plain) {
  const seen = new Set(cur.map(e => e?.event_id));
  const fresh = plain.filter(e => e?.event_id && !seen.has(e.event_id));
  return fresh.length === 0 ? cur : cur.concat(fresh);
}

await test('an event arriving twice is stored once', () => {
  const a = ev('$a', ME), b = ev('$b', THEM);
  let list = appendRoomEvents([], [a, b]);
  list = appendRoomEvents(list, [a, b]);        // store open, then chain recovery
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(e => e.event_id), ['$a', '$b']);
});

await test('a genuinely new event still lands', () => {
  let list = appendRoomEvents([], [ev('$a', ME)]);
  list = appendRoomEvents(list, [ev('$a', ME), ev('$b', ME)]);
  assert.deepStrictEqual(list.map(e => e.event_id), ['$a', '$b']);
});

await test('the real workspace shape: 49 unique events never report as 98', () => {
  const uniq = Array.from({ length: 49 }, (_, i) => ev(`$e${i}`, ME));
  let list = appendRoomEvents([], uniq);
  list = appendRoomEvents(list, uniq);   // the second source
  assert.strictEqual(list.length, 49, 'a doubled list is what made the archive look incomplete');
  assert.strictEqual(new Set(list.map(e => e.event_id)).size, 49);
});

await test('roomEvents is appended through the dedup helper, never by raw concat', () => {
  assert.ok(/function appendRoomEvents\(/.test(mainSrc),
    'the dedup helper is gone');
  assert.ok(!/roomEvents\.set\(roomId,\s*cur\.concat\(plain\)\)/.test(mainSrc),
    'a raw concat is back — duplicates would silently re-inflate every room\'s event count');
});

console.log(`\nall ${passed} block-archival checks passed`);
