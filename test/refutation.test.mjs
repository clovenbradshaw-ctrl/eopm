/* Tests for src/kernel/refutation.js — the CYCLE and UNIQUENESS structural
 * checks, plus a repo-wide guard against the one thing this module must
 * never license: reading `refuted: false` as "verified".
 *
 *   node test/refutation.test.mjs
 */
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const { findCycles, findUniquenessViolations, refute, withRefutationFindings } =
  await import('../src/kernel/refutation.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

const con = (source, target, type, ts) => ({ source, target, type, _ts: ts });

// ── CYCLE ────────────────────────────────────────────────────────────────

await test('a three-way blocks cycle is flagged', () => {
  const state = {
    connections: [con('draft', 'records', 'blocks', 1), con('records', 'review', 'blocks', 2), con('review', 'draft', 'blocks', 3)],
    schema: {}, _violations: [],
  };
  const findings = findCycles(state);
  eq(findings.length, 1);
  eq(findings[0].type, 'cycle');
  eq(findings[0].rule, 'blocks');
  eq(findings[0].giver, 'kernel');
  eq(findings[0].refuted, true);
  assert.ok(findings[0].path.includes('draft') && findings[0].path.includes('records') && findings[0].path.includes('review'));
});

await test('a straight chain with no loop is not flagged', () => {
  const state = {
    connections: [con('a', 'b', 'blocks', 1), con('b', 'c', 'blocks', 2)],
    schema: {}, _violations: [],
  };
  eq(findCycles(state), []);
});

await test('only the declared relation type is checked — other relations with the same shape are ignored', () => {
  const state = {
    connections: [con('a', 'b', 'depends_on', 1), con('b', 'a', 'depends_on', 2)],
    schema: {}, _violations: [],
  };
  eq(findCycles(state, { relation: 'blocks' }), []);
  eq(findCycles(state, { relation: 'depends_on' }).length, 1);
});

await test('a self-loop is a cycle of one', () => {
  const state = { connections: [con('a', 'a', 'blocks', 1)], schema: {}, _violations: [] };
  const findings = findCycles(state);
  eq(findings.length, 1);
  eq(findings[0].path, ['a', 'a']);
});

await test('the same cycle found from two different entry points is reported once', () => {
  // A separate node d -> a joins the cycle from outside; DFS can start
  // exploring from either 'a' or 'd' depending on Map iteration order.
  const state = {
    connections: [con('a', 'b', 'blocks', 1), con('b', 'c', 'blocks', 2), con('c', 'a', 'blocks', 3), con('d', 'a', 'blocks', 4)],
    schema: {}, _violations: [],
  };
  eq(findCycles(state).length, 1);
});

// ── UNIQUENESS ───────────────────────────────────────────────────────────

await test('a double assignment on a schema-declared 1:1 relation is flagged', () => {
  const state = {
    connections: [con('whitfield', 'metro_council', 'appointee_of', 1), con('whitfield', 'tn_ag_council', 'appointee_of', 2)],
    schema: { links: [{ from: 'person', to: 'council', rel: 'appointee_of', unique: true }] },
    _violations: [],
  };
  const findings = findUniquenessViolations(state);
  eq(findings.length, 1);
  eq(findings[0].type, 'uniqueness');
  eq(findings[0].relation, 'appointee_of');
  eq(findings[0].direction, 'source');
  eq(findings[0].holder, 'whitfield');
  eq(findings[0].refuted, true);
});

await test('the same conflict shows up from the target side too — two sources, one seat', () => {
  const state = {
    connections: [con('alice', 'chair', 'chairs', 1), con('bob', 'chair', 'chairs', 2)],
    schema: { links: [{ from: 'person', to: 'seat', rel: 'chairs', cardinality: '1:1' }] },
    _violations: [],
  };
  const findings = findUniquenessViolations(state);
  eq(findings.length, 1);
  eq(findings[0].direction, 'target');
  eq(findings[0].holder, 'chair');
  eq(findings[0].conflicting.sort(), ['alice', 'bob']);
});

await test('an undeclared relation with the identical shape is never flagged', () => {
  const state = {
    connections: [con('a', 'x', 'mentioned_in', 1), con('a', 'y', 'mentioned_in', 2)],
    schema: { links: [{ from: 'a', to: 'b', rel: 'appointee_of', unique: true }] }, // a different relation declared unique
    _violations: [],
  };
  eq(findUniquenessViolations(state), []);
});

await test('expectUnique lets a caller opt a relation in without a schema declaration, but nothing is unique by default', () => {
  const state = {
    connections: [con('a', 'x', 'owns', 1), con('a', 'y', 'owns', 2)],
    schema: {}, _violations: [],
  };
  eq(findUniquenessViolations(state), [], 'flagged a relation nobody declared unique');
  eq(findUniquenessViolations(state, { expectUnique: ['owns'] }).length, 1);
});

await test('a single assignment on a declared-unique relation is not a conflict', () => {
  const state = {
    connections: [con('whitfield', 'metro_council', 'appointee_of', 1)],
    schema: { links: [{ rel: 'appointee_of', unique: true }] },
    _violations: [],
  };
  eq(findUniquenessViolations(state), []);
});

await test('the giver is read from the event that declared the schema, when the log is supplied', () => {
  const state = {
    connections: [con('a', 'x', 'owns', 1), con('a', 'y', 'owns', 2)],
    schema: { links: [{ rel: 'owns', unique: true }] },
    _violations: [],
  };
  const events = [
    { type: 'io.matrix-events.def', content: { anchor: null, path: '_schema.links', value: [] }, sender: '@michael:hyphae.social', origin_server_ts: 1000 },
    { type: 'io.matrix-events.def', content: { anchor: null, path: '_schema.links', value: [{ rel: 'owns', unique: true }] }, sender: '@robin:hyphae.social', origin_server_ts: 2000 },
  ];
  const [finding] = findUniquenessViolations(state, { events });
  eq(finding.giver, '@robin:hyphae.social'); // the later of the two DEFs wins
  eq(finding.declaredAt, 2000);
});

await test('with no event log supplied, giver is null rather than a guess', () => {
  const state = {
    connections: [con('a', 'x', 'owns', 1), con('a', 'y', 'owns', 2)],
    schema: { links: [{ rel: 'owns', unique: true }] },
    _violations: [],
  };
  eq(findUniquenessViolations(state)[0].giver, null);
});

// ── refute() / withRefutationFindings() ─────────────────────────────────

await test('refute() runs both checks and withRefutationFindings() never mutates state', () => {
  const state = {
    connections: [con('a', 'b', 'blocks', 1), con('b', 'a', 'blocks', 2), con('x', 'y', 'owns', 3), con('x', 'z', 'owns', 4)],
    schema: { links: [{ rel: 'owns', unique: true }] },
    _violations: [{ type: 'missing_ins', _ts: 0 }],
  };
  const frozen = JSON.stringify(state);
  const findings = refute(state, { expectUnique: [] });
  eq(findings.length, 2); // one cycle, one uniqueness conflict
  const merged = withRefutationFindings(state, findings);
  eq(merged.length, 3); // the pre-existing violation plus both findings
  eq(JSON.stringify(state), frozen, 'refute()/withRefutationFindings() mutated the state it was given');
});

// ── the anti-pattern this module is built to prevent ────────────────────

await test('nothing in the repo branches on `!x.refuted` or bare `!refuted`', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'vendor']);
  const exts = new Set(['.js', '.mjs', '.cjs', '.jsx']);
  const offenders = [];

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!exts.has(extname(name))) continue;
      // This test file legitimately talks about the pattern in prose/strings
      // above — exclude it from the scan of its own source.
      if (p === fileURLToPath(import.meta.url)) continue;
      const text = readFileSync(p, 'utf8');
      const re = /!\s*[\w.]*\brefuted\b/g;
      let m;
      while ((m = re.exec(text))) {
        offenders.push(`${p}: ${m[0]}`);
      }
    }
  }
  walk(root);
  eq(offenders, []);
});

console.log(`\nall ${passed} refutation checks passed`);
