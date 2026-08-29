/**
 * shred.js — breaking a long paste into observation-sized pieces
 *
 * A two-hour transcript or a forty-turn conversation with an AI is not one
 * observation. Held as a single block it can only ever match itself, and
 * recurrence (src/recurrence.js) — the one thing that makes the held pile
 * useful — never gets a chance to see the same idea arrive three times.
 *
 * So long pastes get offered a split. Two rules govern how:
 *
 *   Nothing is ever split silently. This module only ever *proposes* — it
 *   returns segments with a suggested keep/drop, and the caller is
 *   expected to show them before anything is held. Quietly shredding
 *   someone's material into 34 pieces they didn't ask for is worse than
 *   leaving it whole.
 *
 *   What gets dropped is decided by what can possibly matter later, not by
 *   a judgement about quality. A segment with no content words cannot ever
 *   participate in recurrence — there is nothing in it to recur — so
 *   holding it separately buys nothing. "Yes, exactly" is not filtered for
 *   being unimportant; it is filtered for being unmatchable.
 */

import { tokenize } from './recurrence.js';

// Labels that mark a turn in a pasted conversation. Matching is
// case-insensitive and tolerant of markdown bold/heading decoration around
// the name, which is how most chat exports come out.
const SPEAKER_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*([A-Za-z][A-Za-z0-9 ._-]{0,24}?)\s*(?:\*\*|__)?\s*:\s*(.*)$/;

// A label only counts as a speaker if it behaves like one: the same handful
// of names, over and over. Two distinct labels appearing at least twice
// each is the smallest pattern that can't be produced by ordinary prose
// containing a colon ("Note: this is important" gives one label, once).
const MIN_SPEAKERS = 2;
const MIN_TURNS_PER_SPEAKER = 2;

function looksLikeSentenceColon(label) {
  // "The real problem is this:" — a long multi-word phrase before a colon
  // is prose, not a speaker tag. Real speaker labels are short.
  return label.split(/\s+/).length > 3;
}

/**
 * Find the speaker labels in a body of text, and how often each speaks.
 * Returns an empty map when the text doesn't behave like a transcript.
 */
export function detectSpeakers(text) {
  const counts = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(SPEAKER_RE);
    if (!m) continue;
    const label = m[1].trim();
    if (!label || looksLikeSentenceColon(label)) continue;
    counts.set(label.toLowerCase(), (counts.get(label.toLowerCase()) || 0) + 1);
  }
  const speakers = new Map([...counts].filter(([, n]) => n >= MIN_TURNS_PER_SPEAKER));
  return speakers.size >= MIN_SPEAKERS ? speakers : new Map();
}

/** Split a transcript into turns, each tagged with who said it. */
function splitConversation(text, speakers) {
  const segments = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(SPEAKER_RE);
    const label = m && m[1].trim().toLowerCase();
    if (m && speakers.has(label)) {
      if (current) segments.push(current);
      current = { speaker: m[1].trim(), lines: [m[2]] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      // Preamble before the first labelled turn.
      current = { speaker: null, lines: [line] };
    }
  }
  if (current) segments.push(current);

  return segments
    .map(s => ({ speaker: s.speaker, text: s.lines.join('\n').trim() }))
    .filter(s => s.text);
}

/** Paragraphs, or — when there are none — sentences. */
function splitProse(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.map(p => ({ speaker: null, text: p }));

  const single = paragraphs[0] || '';
  const sentences = single
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map(s => s.trim())
    .filter(Boolean);
  return sentences.map(s => ({ speaker: null, text: s }));
}

/**
 * shred(text) → { kind, segments, keepCount, dropCount }
 *
 * `kind` is 'conversation' when the paste behaves like a transcript,
 * 'prose' when it split into more than one piece any other way, and
 * 'single' when there was nothing to split — in which case the caller
 * should just hold it as-is without offering anything.
 *
 * Every segment carries `keep`, the *suggestion*. Callers must let the
 * user overrule it.
 */
export function shred(text) {
  const body = String(text || '').trim();
  if (!body) return { kind: 'single', segments: [], keepCount: 0, dropCount: 0 };

  const speakers = detectSpeakers(body);
  const raw = speakers.size ? splitConversation(body, speakers) : splitProse(body);

  if (raw.length <= 1) {
    return {
      kind: 'single',
      segments: [{ index: 0, speaker: null, text: body, keep: true, matchable: tokenize(body).length > 0 }],
      keepCount: 1,
      dropCount: 0,
    };
  }

  const segments = raw.map((s, index) => {
    const matchable = tokenize(s.text).length > 0;
    return { index, speaker: s.speaker, text: s.text, matchable, keep: matchable };
  });

  return {
    kind: speakers.size ? 'conversation' : 'prose',
    segments,
    speakers: [...speakers.keys()],
    keepCount: segments.filter(s => s.keep).length,
    dropCount: segments.filter(s => !s.keep).length,
  };
}
