/* Tests for src/shred.js — proposing a split of a long paste.
 *
 *   node test/shred.test.mjs
 */
import assert from 'node:assert';

const { shred, detectSpeakers } = await import('../src/shred.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}

const CONVO = `Human: the real problem is nobody knows what changed
Assistant: That suggests the changelog isn't the artifact people need.
Human: we tried a changelog and everyone ignored it
Assistant: What if it summarized the diff instead?
Human: yes
Assistant: Then the unit of the summary matters a great deal.`;

// ── speaker detection ──────────────────────────────────────────────────

await test('a two-party transcript is recognised', () => {
  const s = detectSpeakers(CONVO);
  assert.strictEqual(s.size, 2);
  assert.ok(s.has('human') && s.has('assistant'));
});

await test('markdown-decorated speaker labels are recognised', () => {
  const s = detectSpeakers('**Me**: one thought\n**Claude**: a reply\n**Me**: another\n**Claude**: more');
  assert.strictEqual(s.size, 2, 'bold labels should still read as speakers');
});

await test('prose containing a colon is not a transcript', () => {
  const s = detectSpeakers('Note: this is important.\nThe real problem is this: nobody knows.\nAnother line entirely.');
  assert.strictEqual(s.size, 0, 'ordinary prose must not be shredded as a conversation');
});

await test('one speaker alone is not a transcript', () => {
  const s = detectSpeakers('Human: first\nHuman: second\nHuman: third');
  assert.strictEqual(s.size, 0, 'a transcript needs at least two parties');
});

// ── conversation shredding ─────────────────────────────────────────────

await test('a transcript splits into turns, each tagged with its speaker', () => {
  const r = shred(CONVO);
  assert.strictEqual(r.kind, 'conversation');
  assert.strictEqual(r.segments.length, 6);
  assert.strictEqual(r.segments[0].speaker, 'Human');
  assert.strictEqual(r.segments[1].speaker, 'Assistant');
  assert.ok(r.segments[0].text.includes('nobody knows what changed'));
  assert.ok(!r.segments[0].text.includes('Human:'), 'the label should not survive into the text');
});

await test('a turn with no content words is proposed for dropping, not deleted', () => {
  const r = shred(CONVO);
  const bare = r.segments.find(s => s.text === 'yes');
  assert.ok(bare, 'the filler turn should still be present in the proposal');
  assert.strictEqual(bare.keep, false, 'it cannot ever match anything, so it defaults to dropped');
  assert.strictEqual(bare.matchable, false);
  assert.ok(r.dropCount >= 1);
  assert.strictEqual(r.segments.length, r.keepCount + r.dropCount);
});

await test('multi-line turns keep their continuation lines', () => {
  const r = shred('Human: first line\nand a continuation\nAssistant: reply here\nHuman: second\nAssistant: another reply');
  assert.ok(r.segments[0].text.includes('continuation'), 'continuation lines belong to the turn above');
});

// ── prose shredding ────────────────────────────────────────────────────

await test('prose with blank lines splits into paragraphs', () => {
  const r = shred('First idea about handoffs.\n\nSecond idea about pricing.\n\nThird about onboarding.');
  assert.strictEqual(r.kind, 'prose');
  assert.strictEqual(r.segments.length, 3);
  assert.strictEqual(r.segments[1].text, 'Second idea about pricing.');
});

await test('a single unbroken paragraph splits into sentences', () => {
  const r = shred('Nobody knows what changed. We tried a changelog. Everyone ignored it.');
  assert.strictEqual(r.kind, 'prose');
  assert.strictEqual(r.segments.length, 3);
  assert.strictEqual(r.segments[0].text, 'Nobody knows what changed.');
});

await test('something with nothing to split is left whole', () => {
  const r = shred('one short thought');
  assert.strictEqual(r.kind, 'single');
  assert.strictEqual(r.segments.length, 1);
  assert.strictEqual(r.keepCount, 1);
});

await test('empty input proposes nothing at all', () => {
  const r = shred('   ');
  assert.strictEqual(r.kind, 'single');
  assert.deepStrictEqual(r.segments, []);
});

await test('every segment carries its own index so a caller can toggle one', () => {
  const r = shred(CONVO);
  assert.deepStrictEqual(r.segments.map(s => s.index), [0, 1, 2, 3, 4, 5]);
});

console.log(`\nall ${passed} shred checks passed`);
