/* Tests for src/recurrence.js — finding what the user keeps circling,
 * without a hand-set similarity threshold.
 *
 *   node test/recurrence.test.mjs
 *
 * The load-bearing test in here is the negative one: a pile of unrelated
 * notes must produce ZERO clusters. A recurrence finder that always finds
 * something is worse than none at all, because the first week's fake
 * pattern is what teaches the user to stop trusting it.
 */
import assert from 'node:assert';

const {
  tokenize, buildIndex, similarity, nullThreshold, findRecurrence, textOf,
} = await import('../src/recurrence.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

// Deterministic RNG so the null — and therefore every assertion that
// depends on it — is reproducible. mulberry32.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idSeq = 0;
const note = (text, ts = 1_700_000_000_000 + (idSeq * 86_400_000)) =>
  ({ id: `held_${idSeq++}`, text, ts });

// ── tokenize ───────────────────────────────────────────────────────────

await test('tokenize drops stopwords, short words and bare numbers', () => {
  const t = tokenize('The handoff is 42 broken and ok');
  assert.ok(!t.includes('the'), 'stopword survived');
  assert.ok(!t.includes('and'), 'stopword survived');
  assert.ok(!t.includes('ok'), 'two-letter token survived');
  assert.ok(!t.includes('42'), 'bare number survived');
  assert.ok(t.includes('handoff'), 'content word missing');
});

await test('tokenize emits adjacent bigrams alongside unigrams', () => {
  const t = tokenize('change log broken');
  assert.ok(t.includes('change'), 'unigram missing');
  assert.ok(t.includes('change log'), 'bigram missing');
  assert.ok(t.includes('log broken'), 'bigram missing');
});

await test('textOf falls back to an attachment name when there is no text', () => {
  assert.strictEqual(textOf({ text: 'hello' }), 'hello');
  assert.strictEqual(textOf({ text: '', attachment: { name: 'memo.m4a' } }), 'memo.m4a');
  assert.strictEqual(textOf({ text: '' }), '');
  assert.strictEqual(textOf(null), '');
});

// ── weighting ──────────────────────────────────────────────────────────

await test('a term present in every entry carries no weight', () => {
  const docs = [['alpha', 'beta'], ['alpha', 'gamma'], ['alpha', 'delta']];
  const index = buildIndex(docs);
  for (const v of index.vectors) {
    assert.ok(!v.has('alpha'), 'ubiquitous term should self-cancel via idf, no stoplist needed');
  }
});

await test('similarity is 0 for disjoint vocabularies and high for shared ones', () => {
  const index = buildIndex([
    ['handoff', 'context'], ['handoff', 'context'], ['pricing', 'margin'], ['weather', 'rain'],
  ]);
  assert.ok(similarity(index.vectors[0], index.vectors[1]) > 0.9, 'identical docs should be near 1');
  assert.strictEqual(similarity(index.vectors[0], index.vectors[2]), 0, 'disjoint docs should be 0');
});

// ── the null ───────────────────────────────────────────────────────────

await test('nullThreshold is reproducible for a given seed', () => {
  const docs = [
    tokenize('the handoff problem keeps coming back'),
    tokenize('pricing is the thing I cannot figure out'),
    tokenize('nobody reads the changelog we ship'),
    tokenize('rain all week and the roof still leaks'),
  ];
  const a = nullThreshold(docs, { rounds: 10, rng: seeded(7) });
  const b = nullThreshold(docs, { rounds: 10, rng: seeded(7) });
  assert.strictEqual(a, b, 'same seed must give the same threshold');
});

await test('nullThreshold rises with a smaller, more collision-prone vocabulary', () => {
  // Four entries drawn from a two-word vocabulary collide constantly under
  // shuffling; four drawn from a wide one almost never do. The cutoff has
  // to move with that, which is the whole reason it is measured.
  const narrow = [['aa', 'bb'], ['aa', 'bb'], ['aa', 'bb'], ['aa', 'bb']];
  const wide = [
    ['alpha', 'beta'], ['gamma', 'delta'], ['epsilon', 'zeta'], ['eta', 'theta'],
  ];
  const nNarrow = nullThreshold(narrow, { rounds: 20, rng: seeded(3) });
  const nWide = nullThreshold(wide, { rounds: 20, rng: seeded(3) });
  assert.ok(nNarrow > nWide, `narrow vocab should raise the bar (${nNarrow} vs ${nWide})`);
});

// ── findRecurrence: the honest negatives ───────────────────────────────

await test('below four entries it reports unmeasured rather than an empty finding', () => {
  const r = findRecurrence([note('handoff'), note('handoff'), note('handoff')], { rng: seeded(1) });
  assert.strictEqual(r.measured, false);
  assert.strictEqual(r.reason, 'too-few');
  assert.strictEqual(r.needed, 4);
  assert.deepStrictEqual(r.clusters, []);
});

await test('entries with no usable text report unmeasured, not zero clusters', () => {
  const r = findRecurrence(
    [note(''), note(''), note(''), note('')],
    { rng: seeded(1) },
  );
  assert.strictEqual(r.measured, false);
  assert.strictEqual(r.reason, 'no-text');
});

await test('a pile of genuinely unrelated notes finds NOTHING', () => {
  const entries = [
    note('the roof is leaking again after that storm last night'),
    note('renew the passport before september or pay the rush fee'),
    note('that pasta place on eighth had a lamb special worth going back for'),
    note('bike chain skips under load in the third gear'),
    note('mom asked whether we are coming down for thanksgiving'),
    note('the tomato seedlings need hardening off before they go outside'),
  ];
  const r = findRecurrence(entries, { rounds: 30, rng: seeded(11) });
  assert.strictEqual(r.measured, true);
  assert.deepStrictEqual(r.clusters, [], `expected no clusters, got ${JSON.stringify(r.clusters.map(c => c.terms))}`);
  assert.strictEqual(r.clustered, 0);
});

// ── findRecurrence: the positive ───────────────────────────────────────

await test('a thread the user keeps returning to is found, and unrelated notes stay out', () => {
  const entries = [
    note('the real problem is nobody knows what changed between releases'),
    note('the roof is leaking again after that storm'),
    note('we tried a changelog and everyone ignored it, nobody knows what changed'),
    note('bike chain skips under load'),
    note('what if it summarized the changed files instead of a changelog nobody reads'),
    note('renew the passport before september'),
    note('every handoff someone asks what changed and nobody knows'),
  ];
  const r = findRecurrence(entries, { rounds: 30, rng: seeded(5) });
  assert.strictEqual(r.measured, true);
  assert.ok(r.clusters.length >= 1, 'the repeated thread should surface');

  const top = r.clusters[0];
  assert.ok(top.size >= 3, `expected the recurring thread to gather, got size ${top.size}`);

  const texts = top.entries.map(e => e.text).join(' ');
  assert.ok(!texts.includes('roof'), 'an unrelated note was swept into the cluster');
  assert.ok(!texts.includes('passport'), 'an unrelated note was swept into the cluster');
  assert.ok(!texts.includes('bike'), 'an unrelated note was swept into the cluster');
});

await test('cluster terms are words that actually appear in the notes', () => {
  const entries = [
    note('nobody knows what changed between releases'),
    note('a changelog nobody reads, nobody knows what changed'),
    note('every handoff someone asks what changed'),
    note('the tomato seedlings need hardening off'),
    note('bike chain skips under load'),
  ];
  const r = findRecurrence(entries, { rounds: 30, rng: seeded(9) });
  const top = r.clusters[0];
  assert.ok(top, 'expected a cluster');
  const corpus = entries.map(e => e.text.toLowerCase()).join(' ');
  for (const term of top.terms) {
    assert.ok(corpus.includes(term), `surfaced term "${term}" is not verbatim in the notes`);
  }
});

await test('a cluster reports the real span of dates it covers', () => {
  const day = 86_400_000;
  const t0 = 1_700_000_000_000;
  const entries = [
    { id: 'a', text: 'nobody knows what changed', ts: t0 },
    { id: 'b', text: 'the roof is leaking', ts: t0 + day },
    { id: 'c', text: 'nobody knows what changed at handoff', ts: t0 + 20 * day },
    { id: 'd', text: 'bike chain skips', ts: t0 + 3 * day },
    { id: 'e', text: 'what changed, nobody knows, again', ts: t0 + 40 * day },
  ];
  const r = findRecurrence(entries, { rounds: 30, rng: seeded(13) });
  const top = r.clusters[0];
  assert.ok(top, 'expected a cluster');
  assert.strictEqual(top.from, t0, 'span should start at the earliest member');
  assert.strictEqual(top.to, t0 + 40 * day, 'span should end at the latest member');
});

await test('findRecurrence is deterministic for a given seed', () => {
  const entries = [
    note('nobody knows what changed'), note('the roof is leaking'),
    note('what changed since the last release'), note('renew the passport'),
    note('handoff and nobody knows what changed'),
  ];
  const a = findRecurrence(entries, { rounds: 15, rng: seeded(21) });
  const b = findRecurrence(entries, { rounds: 15, rng: seeded(21) });
  assert.deepStrictEqual(a.clusters.map(c => c.ids), b.clusters.map(c => c.ids));
  assert.strictEqual(a.threshold, b.threshold);
});

console.log(`\nall ${passed} recurrence checks passed`);
