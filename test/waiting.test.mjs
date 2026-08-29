/* Tests for src/waiting.js and the fold's edge retraction.
 *
 * Everything runs against the real fold (src/fold.js), same pattern as
 * test/unblock.test.mjs — the point of most of these is that the answers
 * come out of a log, not out of a fixture handed straight to the function.
 *
 *   node test/waiting.test.mjs
 */
import assert from 'node:assert';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.indexedDB ??= { open() { return { addEventListener() {} }; } };
const { fold, connectionsFor, activeConnections, stateHash } = await import('../src/fold.js');
const {
  dependencyEdges, isDependencyRelation, terminalPartition, isSettled,
  blockersOf, dependentsOf, waitRhythm, waitingRows, unblockedSince,
} = await import('../src/waiting.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

const NS = 'io.matrix-events';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1700000000000;
let seq = 0;
const ev = (op, content, ts, sender = '@ada:example.org') =>
  ({ type: `${NS}.${op}`, content, origin_server_ts: ts, sender, event_id: `$e${seq++}` });

const ins = (anchor, type, payload, ts) => ev('ins', { anchor, entity_type: type, payload }, ts);
const seg = (anchor, partition, ts) => ev('seg', { anchor, partition }, ts);
const con = (source, target, rel, ts) =>
  ev('con', { source_anchor: source, target_anchor: target, relation_type: rel }, ts);
const unCon = (c, ts) => ev('con', {
  source_anchor: c.source, target_anchor: c.target, relation_type: c.type, retracts: c._eventId,
}, ts);
const stages = (type, list, ts) =>
  ev('def', { anchor: null, path: `_schema.partitions.${type}`, value: list }, ts);

// ── Fold: withdrawing an edge ────────────────────────────────────────────

await test('a CON carrying `retracts` stamps the edge instead of adding one', () => {
  const link = con('a', 'b', 'blocked_by', T0 + 10);
  const state = fold([
    ins('a', 'task', {}, T0),
    ins('b', 'task', {}, T0 + 1),
    link,
    unCon({ source: 'a', target: 'b', type: 'blocked_by', _eventId: link.event_id }, T0 + 20),
  ]);
  eq(state.connections.length, 1);            // the withdrawal is not a second edge
  eq(state.connections[0]._retracted, T0 + 20);
  eq(activeConnections(state).length, 0);
});

await test('the original edge is kept, not deleted', () => {
  const link = con('a', 'b', 'blocked_by', T0 + 10);
  const state = fold([
    ins('a', 'task', {}, T0), ins('b', 'task', {}, T0 + 1), link,
    unCon({ source: 'a', target: 'b', type: 'blocked_by', _eventId: link.event_id }, T0 + 20),
  ]);
  eq(connectionsFor(state, 'a').length, 0);
  eq(connectionsFor(state, 'a', { includeRetracted: true }).length, 1);
  eq(connectionsFor(state, 'a', { includeRetracted: true })[0]._ts, T0 + 10);
});

await test('a retraction that arrives before its edge still lands', () => {
  // Two CONs in the same millisecond sort on event_id, so this really does
  // happen on backfill — the withdrawal must not be silently dropped.
  const link = con('a', 'b', 'blocked_by', T0 + 10);
  const undo = unCon({ source: 'a', target: 'b', type: 'blocked_by', _eventId: link.event_id }, T0 + 10);
  const state = fold([ins('a', 'task', {}, T0), ins('b', 'task', {}, T0 + 1), undo, link]);
  eq(state.connections.length, 1);
  eq(state.connections[0]._retracted, T0 + 10);
});

await test('withdrawing an edge changes the state hash', () => {
  const link = con('a', 'b', 'blocked_by', T0 + 10);
  const base = [ins('a', 'task', {}, T0), ins('b', 'task', {}, T0 + 1), link];
  const before = stateHash(fold(base));
  const after = stateHash(fold([...base,
    unCon({ source: 'a', target: 'b', type: 'blocked_by', _eventId: link.event_id }, T0 + 20)]));
  assert.notStrictEqual(before, after, 'an unlinked dependency must repaint');
});

await test('withdrawing the same edge twice is idempotent', () => {
  const link = con('a', 'b', 'blocked_by', T0 + 10);
  const undo = unCon({ source: 'a', target: 'b', type: 'blocked_by', _eventId: link.event_id }, T0 + 20);
  const state = fold([ins('a', 'task', {}, T0), ins('b', 'task', {}, T0 + 1), link, undo, undo]);
  eq(state.connections.length, 1);
  eq(state.connections[0]._retracted, T0 + 20);
});

// ── The dependency vocabulary ────────────────────────────────────────────

await test('only dependency relations count as dependencies', () => {
  eq(isDependencyRelation('blocked_by'), true);
  eq(isDependencyRelation('depends_on'), true);
  eq(isDependencyRelation('waiting_on'), true);
  eq(isDependencyRelation('blocks'), true);
  // Real relations this app already emits, which must stay out of Waiting.
  eq(isDependencyRelation('belongs_to'), false);
  eq(isDependencyRelation('annotates'), false);
  eq(isDependencyRelation('watches'), false);
  eq(isDependencyRelation('sent_to'), false);
  eq(isDependencyRelation('related_to'), false);
});

await test('`blocks` and `blocked_by` are the same relation pointed two ways', () => {
  const state = fold([
    ins('a', 'task', {}, T0), ins('b', 'task', {}, T0), ins('c', 'task', {}, T0),
    con('a', 'b', 'blocked_by', T0 + 1),   // a is stuck behind b
    con('c', 'a', 'blocks', T0 + 2),       // c blocks a → a is stuck behind c
  ]);
  const deps = dependencyEdges(state).map(d => `${d.blocked}<-${d.blocker}`).sort();
  eq(deps, ['a<-b', 'a<-c']);
});

await test('free-text spelling from the graph view normalizes', () => {
  const state = fold([
    ins('a', 'task', {}, T0), ins('b', 'task', {}, T0),
    con('a', 'b', 'Blocked By', T0 + 1),
  ]);
  eq(dependencyEdges(state).length, 1);
});

// ── Stages ───────────────────────────────────────────────────────────────

await test('a type with no declared stages has no terminal stage', () => {
  const state = fold([ins('a', 'task', {}, T0), seg('a', 'done', T0 + 1)]);
  eq(terminalPartition(state, 'task'), null);
  // "done" only looks final. Without a declared order it is a guess.
  eq(isSettled(state, state.entities.a), false);
});

await test('the last declared stage settles an entity', () => {
  const state = fold([
    stages('task', ['backlog', 'doing', 'done'], T0),
    ins('a', 'task', {}, T0 + 1), seg('a', 'doing', T0 + 2),
  ]);
  eq(terminalPartition(state, 'task'), 'done');
  eq(isSettled(state, state.entities.a), false);
  const later = fold([
    stages('task', ['backlog', 'doing', 'done'], T0),
    ins('a', 'task', {}, T0 + 1), seg('a', 'done', T0 + 2),
  ]);
  eq(isSettled(later, later.entities.a), true);
});

// ── Reverse dependencies ─────────────────────────────────────────────────

await test('dependentsOf answers what would move if this arrived', () => {
  const state = fold([
    ins('foia', 'request', {}, T0),
    ins('graf', 'task', {}, T0), ins('sidebar', 'task', {}, T0),
    con('graf', 'foia', 'blocked_by', T0 + 1),
    con('sidebar', 'foia', 'blocked_by', T0 + 2),
  ]);
  eq(dependentsOf(state, 'foia').length, 2);
  eq(blockersOf(state, 'graf').map(e => e.blocker), ['foia']);
  eq(dependentsOf(state, 'graf').length, 0);
});

await test('a withdrawn edge stops holding anything up', () => {
  const link = con('graf', 'foia', 'blocked_by', T0 + 1);
  const state = fold([
    ins('foia', 'request', {}, T0), ins('graf', 'task', {}, T0), link,
    unCon({ source: 'graf', target: 'foia', type: 'blocked_by', _eventId: link.event_id }, T0 + 2),
  ]);
  eq(dependentsOf(state, 'foia').length, 0);
  eq(dependentsOf(state, 'foia', { includeClosed: true }).length, 1);
});

// ── How long waits take here ─────────────────────────────────────────────

const withStages = (extra = []) => fold([
  stages('request', ['sent', 'arrived'], T0),
  stages('task', ['todo', 'done'], T0),
  ...extra,
]);

await test('one finished wait is not enough to measure by', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0 + 1), ins('t1', 'task', {}, T0 + 1),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 3 * DAY),
  ]);
  const r = waitRhythm(state);
  eq(r.measured, false);
  eq(r.finished, 1);
  eq(r.needed, 2);
});

await test('finished waits set the bar an open one is judged against', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('r2', 'request', {}, T0),
    ins('r3', 'request', {}, T0), ins('r4', 'request', {}, T0),
    ins('t1', 'task', {}, T0), ins('t2', 'task', {}, T0),
    ins('t3', 'task', {}, T0), ins('t4', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY), seg('r1', 'arrived', T0 + 3 * DAY),   // 2 days
    con('t2', 'r2', 'blocked_by', T0 + DAY), seg('r2', 'arrived', T0 + 5 * DAY),   // 4 days
    con('t3', 'r3', 'blocked_by', T0 + DAY), seg('r3', 'arrived', T0 + 7 * DAY),   // 6 days
    con('t4', 'r4', 'blocked_by', T0 + DAY),                                        // still open
  ]);
  const r = waitRhythm(state);
  eq(r.measured, true);
  eq(r.finished, 3);
  eq(r.median, 4 * DAY);
  eq(r.max, 6 * DAY);

  // Five days open: past the point half of them were answered by, but not
  // yet longer than every wait this workspace has finished.
  const early = waitingRows(state, { now: T0 + 6 * DAY }).rows.find(x => x.anchor === 'r4');
  eq(early.stalled, false);
  eq(early.nudgeDue, true);

  // Eight days open: longer than any of them.
  const late = waitingRows(state, { now: T0 + 9 * DAY }).rows.find(x => x.anchor === 'r4');
  eq(late.stalled, true);
  eq(late.longerThan, 3);
  eq(late.oddsIfNothingChanged, 1 / 4);
});

await test('with only two finished waits the nudge and the stall coincide', () => {
  // The upper median of two values IS the maximum, so an early warning is
  // not something this workspace has the evidence to give yet. That is a
  // property of two observations, not a bug — and it separates on its own
  // as more waits finish.
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('r2', 'request', {}, T0), ins('r3', 'request', {}, T0),
    ins('t1', 'task', {}, T0), ins('t2', 'task', {}, T0), ins('t3', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY), seg('r1', 'arrived', T0 + 3 * DAY),
    con('t2', 'r2', 'blocked_by', T0 + DAY), seg('r2', 'arrived', T0 + 7 * DAY),
    con('t3', 'r3', 'blocked_by', T0 + DAY),
  ]);
  const r = waitRhythm(state);
  eq(r.median, r.max);
  const row = waitingRows(state, { now: T0 + 9 * DAY }).rows.find(x => x.anchor === 'r3');
  eq(row.nudgeDue, true);
  eq(row.stalled, true);
});

await test('nothing is called stalled before the bar can be measured', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
  ]);
  const { rows, rhythm } = waitingRows(state, { now: T0 + 400 * DAY });
  eq(rhythm.measured, false);
  eq(rows[0].stalled, false);
  eq(rows[0].nudgeDue, false);
  eq(rows[0].oddsIfNothingChanged, null);
});

// ── The view model ───────────────────────────────────────────────────────

await test('several edges on one blocker collapse to one row, aged from the first', () => {
  const state = withStages([
    ins('foia', 'request', { Title: 'Koniag FOIA' }, T0),
    ins('t1', 'task', {}, T0), ins('t2', 'task', {}, T0),
    con('t1', 'foia', 'blocked_by', T0 + 2 * DAY),
    con('t2', 'foia', 'blocked_by', T0 + 5 * DAY),
  ]);
  const { rows } = waitingRows(state, { now: T0 + 10 * DAY });
  eq(rows.length, 1);
  eq(rows[0].title, 'Koniag FOIA');
  eq(rows[0].age, 8 * DAY);
  eq(rows[0].liveDependents.length, 2);
  eq(rows[0].terminal, 'arrived');
});

await test('a wait whose every dependent is already finished is flagged', () => {
  const state = withStages([
    ins('foia', 'request', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'foia', 'blocked_by', T0 + DAY),
    seg('t1', 'done', T0 + 2 * DAY),
  ]);
  const row = waitingRows(state, { now: T0 + 3 * DAY }).rows[0];
  eq(row.blocksNothingLive, true);
  eq(row.liveDependents.length, 0);
});

await test('a blocker with no declared stages reports no terminal stage', () => {
  const state = fold([
    stages('task', ['todo', 'done'], T0),
    ins('note', 'scrap', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'note', 'blocked_by', T0 + DAY),
  ]);
  const row = waitingRows(state, { now: T0 + 2 * DAY }).rows[0];
  eq(row.terminal, null);   // the view offers unlink instead of "it arrived"
});

await test('rows are longest-waiting first', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('r2', 'request', {}, T0),
    ins('t1', 'task', {}, T0), ins('t2', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + 5 * DAY),
    con('t2', 'r2', 'blocked_by', T0 + DAY),
  ]);
  eq(waitingRows(state, { now: T0 + 10 * DAY }).rows.map(r => r.anchor), ['r2', 'r1']);
});

// ── Unblocked since ──────────────────────────────────────────────────────

await test('finishing a blocker surfaces what it freed', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('t1', 'task', { Title: 'Write sidebar' }, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 4 * DAY),
  ]);
  const freed = unblockedSince(state, T0 + 3 * DAY, { now: T0 + 5 * DAY });
  eq(freed.length, 1);
  eq(freed[0].title, 'Write sidebar');
  eq(freed[0].freedAt, T0 + 4 * DAY);
  eq(freed[0].withdrawn, false);
});

await test('still-blocked work is not reported as freed', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('r2', 'request', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    con('t1', 'r2', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 4 * DAY),
  ]);
  eq(unblockedSince(state, T0 + 3 * DAY, { now: T0 + 5 * DAY }).length, 0);
});

await test('work that is itself already finished is not news', () => {
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 4 * DAY),
    seg('t1', 'done', T0 + 4 * DAY),
  ]);
  eq(unblockedSince(state, T0 + 3 * DAY, { now: T0 + 5 * DAY }).length, 0);
});

await test('unlinking frees work too, and says that is what happened', () => {
  const link = con('t1', 'r1', 'blocked_by', T0 + DAY);
  const state = withStages([
    ins('r1', 'request', {}, T0), ins('t1', 'task', {}, T0), link,
    unCon({ source: 't1', target: 'r1', type: 'blocked_by', _eventId: link.event_id }, T0 + 4 * DAY),
  ]);
  const freed = unblockedSince(state, T0 + 3 * DAY, { now: T0 + 5 * DAY });
  eq(freed.length, 1);
  eq(freed[0].withdrawn, true);
});

// ── Reading settle times from the log ────────────────────────────────────

await test('a later edit does not lengthen a wait that already ended', () => {
  // `_updated` moves on any DEF. Without the SEG timestamps from the log,
  // the note added on day 9 would report a nine-day wait instead of four.
  const events = [
    stages('request', ['sent', 'arrived'], T0),
    stages('task', ['todo', 'done'], T0),
    ins('r1', 'request', {}, T0), ins('r2', 'request', {}, T0),
    ins('t1', 'task', {}, T0), ins('t2', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 4 * DAY),
    ev('def', { anchor: 'r1', path: 'Note', value: 'thin response' }, T0 + 9 * DAY),
    con('t2', 'r2', 'blocked_by', T0 + DAY),
    seg('r2', 'arrived', T0 + 4 * DAY),
  ];
  const state = fold(events);
  eq(waitRhythm(state, { events }).max, 3 * DAY);          // exact, from the SEGs
  eq(waitRhythm(state).max, 8 * DAY);                       // the documented fallback
  eq(waitingRows(state, { events, now: T0 + 10 * DAY }).rows.length, 0);
});

await test('onlyUntouched keeps freed work until somebody picks it up', () => {
  const base = [
    stages('request', ['sent', 'arrived'], T0),
    stages('task', ['todo', 'done'], T0),
    ins('r1', 'request', {}, T0), ins('t1', 'task', {}, T0),
    con('t1', 'r1', 'blocked_by', T0 + DAY),
    seg('r1', 'arrived', T0 + 4 * DAY),
  ];
  const freed = fold(base);
  eq(unblockedSince(freed, 0, { now: T0 + 90 * DAY, onlyUntouched: true }).length, 1);

  // Someone edits the freed task — it has been picked up, so it drops off.
  const acted = fold([...base, ev('def', { anchor: 't1', path: 'Note', value: 'started' }, T0 + 5 * DAY)]);
  eq(unblockedSince(acted, 0, { now: T0 + 90 * DAY, onlyUntouched: true }).length, 0);
  eq(unblockedSince(acted, 0, { now: T0 + 90 * DAY }).length, 1);
});

console.log(`\n  ${passed} passed`);
