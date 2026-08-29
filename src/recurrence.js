/**
 * recurrence.js — what you keep coming back to
 *
 * The Void holds observations that haven't earned a name yet. This module
 * answers the only question that makes that pile useful: across everything
 * held, what keeps showing up?
 *
 * It is deliberately mechanical. No model is consulted, nothing is
 * summarized, and no claim is made about what a group of notes *means* —
 * the output is "these nine entries share distinctive language, and here
 * are the words." The interpreting is the user's job; the counting is
 * this file's.
 *
 * ── Why there is no similarity threshold in here ──────────────────────
 *
 * The obvious implementation picks a number ("cosine > 0.3 means related")
 * and ships it. That number is a lie in both directions: on a pile of
 * near-duplicate meeting notes everything clears it, and on a pile of
 * terse voice memos nothing does. So instead the cutoff is *measured from
 * the data itself*:
 *
 *   1. Compute real pairwise similarity over idf-weighted term vectors.
 *   2. Shuffle — redeal every term occurrence across the entries at
 *      random, preserving both each entry's length and each term's overall
 *      frequency, so only the *association* between term and entry is
 *      destroyed.
 *   3. Recompute similarity on the shuffled pile. Repeat.
 *   4. The cutoff is the highest similarity any pair reached under
 *      shuffling — i.e. the most two unrelated entries ever looked alike
 *      by luck alone, given this vocabulary and these lengths.
 *
 * A pair only counts as related if it beats that. On a pile with no real
 * structure, nothing does, and the honest answer — "nothing's repeated
 * yet" — comes out on its own rather than being a special case.
 *
 * Ubiquitous words need no stoplist for the same reason: idf weights a
 * term appearing in every entry at log(N/N) = 0, so it cancels itself. The
 * small stoplist below is insurance for tiny piles, where "the" might land
 * in 6 of 9 entries and pick up a spurious weight.
 */

// Vocabulary, not a tuning knob: words that carry no topic regardless of
// how they happen to be distributed in a small pile.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'was', 'were', 'are', 'but',
  'not', 'you', 'your', 'from', 'have', 'has', 'had', 'its', 'they', 'them',
  'their', 'what', 'when', 'which', 'who', 'why', 'how', 'all', 'can', 'could',
  'would', 'should', 'will', 'just', 'like', 'about', 'into', 'than', 'then',
  'there', 'here', 'been', 'being', 'some', 'more', 'most', 'other', 'out',
  'get', 'got', 'one', 'two', 'because', 'really', 'very', 'much', 'even',
  'also', 'still', 'want', 'need', 'think', 'thing', 'things', 'something',
  'anything', 'nothing', 'know', 'make', 'makes', 'made', 'does', 'did',
  'doing', 'going', 'gonna', 'kind', 'sort', 'maybe', 'probably', 'actually',
  'basically', 'literally', 'yeah', 'okay', 'right', 'well', 'now', 'back',
  // Acknowledgements. These carry no topic, but they are frequent enough in
  // pasted conversation that without them two unrelated turns can be joined
  // by nothing more than both saying "sure, thanks".
  'yes', 'yep', 'yup', 'nope', 'sure', 'thanks', 'thank', 'please', 'hmm',
  'huh', 'oops', 'wow', 'hey', 'hello', 'good', 'great', 'nice', 'cool',
]);

// A token has to be long enough to be a word rather than an artifact of
// splitting. Two characters admits "ok"/"id"; three is the shortest length
// at which English content words become common ("api", "log", "ship").
const MIN_TOKEN_LENGTH = 3;

/**
 * Text → content tokens (unigrams plus adjacent bigrams).
 *
 * Bigrams matter more than they look: "change log" and "log" are different
 * observations, and two notes that both say "change log" are far better
 * evidence of recurrence than two that merely both say "log".
 */
export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  // Bigrams are formed over the ORIGINAL adjacency, not over the filtered
  // list. Pairing up survivors of the filter would manufacture phrases the
  // user never wrote — "nobody knows what changed" would yield "knows
  // changed" — and every term in here is shown back to them verbatim as
  // evidence, so a term that isn't in the source is a lie about the source.
  const raw = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''));

  const isContent = w => w.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(w) && !/^\d+$/.test(w);

  const tokens = raw.filter(isContent);
  for (let i = 0; i + 1 < raw.length; i++) {
    if (isContent(raw[i]) && isContent(raw[i + 1])) tokens.push(`${raw[i]} ${raw[i + 1]}`);
  }
  return tokens;
}

/** The text a held entry contributes — its own words, or its filename. */
export function textOf(entry) {
  if (!entry) return '';
  if (entry.text) return entry.text;
  if (entry.attachment?.name) return entry.attachment.name;
  return '';
}

// ── term/document index ────────────────────────────────────────────────

/**
 * buildIndex(docs) → { n, df, idf, vectors, counts }
 *
 * `docs` is an array of token arrays. `vectors` are idf-weighted and
 * L2-normalised, so `similarity` is a plain dot product.
 */
export function buildIndex(docs) {
  const n = docs.length;
  const df = new Map();
  const counts = docs.map(tokens => {
    const c = new Map();
    for (const t of tokens) c.set(t, (c.get(t) || 0) + 1);
    for (const t of c.keys()) df.set(t, (df.get(t) || 0) + 1);
    return c;
  });

  const idf = new Map();
  for (const [term, d] of df) idf.set(term, Math.log(n / d));

  const vectors = counts.map(c => {
    const v = new Map();
    let sumSq = 0;
    for (const [term, tf] of c) {
      const w = (1 + Math.log(tf)) * (idf.get(term) || 0);
      if (w <= 0) continue; // a term in every doc weighs nothing — drop it
      v.set(term, w);
      sumSq += w * w;
    }
    if (sumSq > 0) {
      const norm = Math.sqrt(sumSq);
      for (const [term, w] of v) v.set(term, w / norm);
    }
    return v;
  });

  return { n, df, idf, vectors, counts };
}

/** Cosine similarity of two normalised sparse vectors. */
export function similarity(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other) dot += w * other;
  }
  return dot;
}

// ── the null ───────────────────────────────────────────────────────────

/**
 * A permutation of the token pool that preserves both marginals: every
 * entry keeps its own length, every term keeps its overall count, and only
 * the pairing between them is randomised.
 */
function reshuffle(docs, rng) {
  const pool = [];
  for (const tokens of docs) for (const t of tokens) pool.push(t);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = [];
  let cursor = 0;
  for (const tokens of docs) {
    out.push(pool.slice(cursor, cursor + tokens.length));
    cursor += tokens.length;
  }
  return out;
}

/**
 * nullThreshold(docs, opts) → the similarity a pair has to beat before it
 * counts as related.
 *
 * The level is set so that chance alone would be expected to produce
 * roughly ONE spurious link across the whole pile — not zero, which costs
 * far too much sensitivity, and not "whatever 0.3 feels like", which means
 * nothing. That level falls out of the arithmetic with no constant to
 * choose:
 *
 *   Shuffling yields `rounds x P` null similarities, where P is the number
 *   of pairs. A cutoff T admits a fraction f = (#null above T)/(rounds x P)
 *   of them. One expected false link in a real run of P pairs means
 *   P x f = 1, so #null above T = rounds. T is therefore just the
 *   `rounds`-th largest similarity the shuffles produced.
 *
 * Which is also why only the top `rounds` values are ever retained — the
 * rest of the null distribution has no bearing on the answer, and holding
 * it would cost `rounds x P` floats for nothing.
 */
export function nullThreshold(docs, { rounds = 25, rng = Math.random } = {}) {
  const top = []; // ascending, length <= rounds; top[0] is the running cutoff
  const offer = s => {
    if (top.length < rounds) {
      top.push(s);
      top.sort((a, b) => a - b);
    } else if (s > top[0]) {
      top[0] = s;
      top.sort((a, b) => a - b);
    }
  };

  for (let r = 0; r < rounds; r++) {
    const { vectors } = buildIndex(reshuffle(docs, rng));
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) offer(similarity(vectors[i], vectors[j]));
    }
  }
  return top.length ? top[0] : 0;
}

// ── clustering ─────────────────────────────────────────────────────────

// Two entries sharing exactly one word are a coincidence of vocabulary,
// not a thread of attention — "renew the passport BEFORE september" and
// "harden the seedlings off BEFORE they go outside" have nothing to do
// with each other, and no similarity cutoff can tell them apart from a
// real pair, because on that one shared term they genuinely are alike.
// What separates a thread from a collision is that a thread recurs in
// more than one word. Like MIN_ENTRIES_FOR_NULL this is a floor on what
// the method can mean rather than a dial: at one shared term there is no
// evidence of a topic, only of a word.
const MIN_SHARED_TERMS = 2;

function sharedUnigrams(va, vb) {
  let n = 0;
  const [small, large] = va.size <= vb.size ? [va, vb] : [vb, va];
  for (const term of small.keys()) {
    if (!term.includes(' ') && large.has(term)) n++;
  }
  return n;
}

/**
 * Connected components over the pairs that beat the threshold. Single
 * linkage on purpose: a chain of notes drifting from "handoff" to "context
 * loss" to "re-explaining" is one thread of attention, and splitting it
 * into tight blobs would hide exactly the drift worth seeing.
 */
function components(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const [a, b] of edges) union(a, b);

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

/**
 * The terms that actually hold a cluster together: shared by at least two
 * of its members, ranked by how much total weight they carry. These are
 * shown to the user verbatim, so they must come from the notes rather than
 * from any paraphrase.
 */
function clusterTerms(members, index, limit = 6) {
  const shared = new Map();
  for (const term of new Set(members.flatMap(i => [...index.vectors[i].keys()]))) {
    const holders = members.filter(i => index.vectors[i].has(term));
    if (holders.length < 2) continue;
    shared.set(term, holders.reduce((sum, i) => sum + index.vectors[i].get(term), 0));
  }
  const ranked = [...shared.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

  // Prefer a bigram over either of its halves — "change log" says more than
  // "change" and "log" listed separately.
  const kept = [];
  for (const term of ranked) {
    if (kept.length >= limit) break;
    const parts = term.split(' ');
    if (parts.length === 1 && kept.some(k => k.split(' ').includes(term))) continue;
    kept.push(term);
  }
  return kept.filter(t => !(t.split(' ').length === 1 && kept.some(k => k !== t && k.split(' ').includes(t))));
}

// A permutation null needs enough pairs for shuffling to have any spread at
// all; below four entries there are three pairs or fewer and the "highest
// coincidence" is whatever single arrangement exists. This is a structural
// floor on the method, not an opinion about when a pile is interesting.
const MIN_ENTRIES_FOR_NULL = 4;

/**
 * findRecurrence(entries, opts) → the groups of held entries that share
 * more language than chance explains.
 *
 * Returns `measured: false` when there isn't enough held material to run
 * the null at all — the caller should say so plainly rather than showing
 * an empty result as if it were a finding.
 */
export function findRecurrence(entries, { rounds = 25, rng = Math.random, minSize = 2 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const docs = list.map(e => tokenize(textOf(e)));

  if (list.length < MIN_ENTRIES_FOR_NULL) {
    return { measured: false, reason: 'too-few', held: list.length, needed: MIN_ENTRIES_FOR_NULL, threshold: null, clusters: [], clustered: 0 };
  }
  if (docs.every(d => d.length === 0)) {
    return { measured: false, reason: 'no-text', held: list.length, threshold: null, clusters: [], clustered: 0 };
  }

  const index = buildIndex(docs);
  const threshold = nullThreshold(docs, { rounds, rng });

  const edges = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const va = index.vectors[i], vb = index.vectors[j];
      if (similarity(va, vb) > threshold && sharedUnigrams(va, vb) >= MIN_SHARED_TERMS) edges.push([i, j]);
    }
  }

  const clusters = components(list.length, edges)
    .filter(members => members.length >= minSize)
    .map(members => {
      const times = members.map(i => list[i].ts).filter(Number.isFinite);
      return {
        ids: members.map(i => list[i].id),
        entries: members.map(i => list[i]),
        terms: clusterTerms(members, index),
        size: members.length,
        from: times.length ? Math.min(...times) : null,
        to: times.length ? Math.max(...times) : null,
      };
    })
    .sort((a, b) => b.size - a.size || (a.from ?? 0) - (b.from ?? 0));

  return {
    measured: true,
    threshold,
    clusters,
    held: list.length,
    clustered: clusters.reduce((n, c) => n + c.size, 0),
  };
}
