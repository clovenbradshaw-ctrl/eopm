/* void-view.jsx — the front door.
 *
 * A stray thought shouldn't have to answer "which table? what type? what
 * partition?" before it's even allowed to exist. This view is one box.
 * Nothing typed here becomes a permanent record until it's promoted by
 * name; until then it's held locally (src/void-store.js).
 *
 * The held list has no triage affordance on purpose: no due dates, no
 * priority, no archive nag. Nothing here is overdue, because you are not
 * late to your own thinking.
 *
 * Three things happen on top of holding:
 *
 *   Recurrence (src/recurrence.js). A pile of notes is only useful if it
 *   can tell you what you keep circling. The panel reports a fact about
 *   the user's own behaviour — "you came back to this nine times" — and
 *   never a claim about what the notes mean. When there isn't enough held
 *   to run the test honestly, it says so instead of showing two notes as
 *   if they were a finding.
 *
 *   Shredding (src/shred.js). A long paste is offered a split, always with
 *   a preview, never automatically. Held whole, a forty-turn conversation
 *   can only ever match itself.
 *
 *   Durability. Recorded audio goes to Drive on capture, not to the held
 *   entry alone. Held entries are deleted on promotion and on discard, so
 *   audio that lived only here was destroyed by the act of naming it —
 *   and Drive already has the transcript viewer this needs, with chunks
 *   that seek the audio.
 */

(function () {
const { useState, useEffect, useRef, useCallback, useMemo } = React;

function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = ts => {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

/** "9 notes, over 6 weeks" — the span said the way a person would say it. */
function spanLabel(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
  const days = Math.round((to - from) / 86_400_000);
  if (days <= 0) return 'all today';
  if (days === 1) return 'over a day';
  if (days < 14) return `over ${days} days`;
  if (days < 60) return `over ${Math.round(days / 7)} weeks`;
  return `over ${Math.round(days / 30)} months`;
}

function previewOf(entry, max = 90) {
  const t = entry.text || '';
  if (t) return t.length > max ? t.slice(0, max) + '…' : t;
  if (entry.attachment?.kind === 'audio') {
    return `audio, ${formatDuration(entry.attachment.durationMs || 0)}${entry.attachment.docAnchor ? '' : ' (not filed)'}`;
  }
  return entry.attachment?.name || '(empty)';
}

// ── shred preview — never split anything without showing it first ──────

function ShredModal({ result, onCancel, onKeepWhole, onConfirm }) {
  const [picked, setPicked] = useState(() => new Set(
    result.segments.filter(s => s.keep).map(s => s.index)));
  const [busy, setBusy] = useState(false);

  const toggle = i => setPicked(prev => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });

  const dropped = result.segments.length - picked.size;
  const kindLabel = result.kind === 'conversation'
    ? `looks like a conversation, ${result.segments.length} back-and-forths`
    : `${result.segments.length} separate pieces`;

  return (
    <div className="proj-modal-backdrop" onClick={onCancel}>
      <div className="proj-modal void-shred-modal" onClick={e => e.stopPropagation()}>
        <div className="proj-modal-head">
          <div className="proj-modal-eyebrow">that's a long one</div>
          <div className="void-shred-kind">{kindLabel}</div>
        </div>
        <div className="proj-modal-body">
          <div className="void-shred-hint">
            Kept as one block it can only ever match itself. Split into the points you actually
            made, and things you keep coming back to start showing up on their own.
          </div>
          <div className="void-shred-list">
            {result.segments.map(s => (
              <label key={s.index} className={`void-shred-row ${picked.has(s.index) ? 'on' : ''}`}>
                <input type="checkbox" checked={picked.has(s.index)} onChange={() => toggle(s.index)} />
                {s.speaker && <span className="void-shred-speaker">{s.speaker}</span>}
                <span className="void-shred-text">{s.text.length > 140 ? s.text.slice(0, 140) + '…' : s.text}</span>
              </label>
            ))}
          </div>
          {dropped > 0 && (
            <div className="void-shred-dropped">
              {dropped} unticked — nothing in them to match on, so holding them separately buys nothing.
            </div>
          )}
        </div>
        <div className="void-shred-foot">
          <button className="cs-btn" onClick={onCancel}>cancel</button>
          <button className="cs-btn" onClick={onKeepWhole}>keep as one</button>
          <button className="cs-btn primary" disabled={!picked.size || busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(result.segments.filter(s => picked.has(s.index)));
              setBusy(false);
            }}>
            {busy ? 'holding…' : `split into ${picked.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── naming ─────────────────────────────────────────────────────────────

function PromoteModal({ source, onClose, onPromote }) {
  const entries = source.entries;
  const [name, setName] = useState(() =>
    source.kind === 'cluster' ? '' : (entries[0]?.text || '').slice(0, 120));
  const [busy, setBusy] = useState(false);
  const canGo = name.trim().length > 0 && !busy;

  const eyebrow = source.kind === 'cluster'
    ? `from ${entries.length} notes · first one ${shortDate(source.from)}`
    : 'from one note';

  async function go() {
    if (!canGo) return;
    setBusy(true);
    await onPromote(name.trim());
    setBusy(false);
  }

  return (
    <div className="proj-modal-backdrop" onClick={onClose}>
      <div className="proj-modal void-promote-modal" onClick={e => e.stopPropagation()}>
        <div className="proj-modal-head">
          <div className="proj-modal-eyebrow">{eyebrow}</div>
          {source.kind !== 'cluster' && (
            <div className="void-promote-source">{previewOf(entries[0], 160)}</div>
          )}
        </div>
        <div className="proj-modal-body">
          <div className="void-promote-hint">
            Naming it makes it a thing. Everything up to now was just held — this one sticks around,
            and it remembers the {entries.length === 1 ? 'note' : `${entries.length} notes`} it came from.
          </div>
          <input
            className="cs-input"
            value={name}
            autoFocus
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(); }}
            placeholder="name it"
          />
        </div>
        <div className="void-shred-foot">
          <button className="cs-btn" onClick={onClose}>cancel</button>
          <button className="cs-btn primary" disabled={!canGo} onClick={go}>
            {busy ? 'naming…' : 'name it'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReadAllModal({ entries, onClose }) {
  return (
    <div className="proj-modal-backdrop" onClick={onClose}>
      <div className="proj-modal void-read-modal" onClick={e => e.stopPropagation()}>
        <div className="proj-modal-head">
          <div className="proj-modal-eyebrow">{entries.length} notes</div>
        </div>
        <div className="proj-modal-body void-read-body">
          {entries.slice().sort((a, b) => a.ts - b.ts).map(e => (
            <div className="void-read-row" key={e.id}>
              <div className="void-read-when">{shortDate(e.ts)}</div>
              <div className="void-read-text">{e.text || previewOf(e, 400)}</div>
            </div>
          ))}
        </div>
        <div className="void-shred-foot">
          <button className="cs-btn" onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}

// ── the view ───────────────────────────────────────────────────────────

// Entities promoted out of the Void land in one generic, meaning-neutral
// set — promotion is name-only, so nothing here presumes a type. A type
// arrives later, if at all.
const VOID_ENTITY_TYPE = 'observation';

// Long enough that splitting is worth asking about. Below this a paste is
// almost always a single thought and the question would just be noise.
const SHRED_OFFER_CHARS = 400;

function VoidView({ room, state, onEmit, scrubber, setSelection, myUserId, live }) {
  const roomId = room?.id;
  const VS = window.VoidStore;
  const [text, setText] = useState('');
  const [held, setHeld] = useState([]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState(null);
  const [filing, setFiling] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [reading, setReading] = useState(null);
  const [shredding, setShredding] = useState(null);
  const [justPromoted, setJustPromoted] = useState(null);
  const [transcribing, setTranscribing] = useState(null);
  const fileInputRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);

  const refresh = useCallback(async () => {
    if (!roomId || !VS) return;
    setHeld(await VS.listHeld(roomId));
    setReady(true);
  }, [roomId, VS]);

  useEffect(() => { refresh(); }, [refresh]);

  // Recurrence is pure and cheap, but it is O(n^2) over the held pile with
  // a permutation null on top — recompute only when the pile changes.
  const recurrence = useMemo(() => {
    if (!window.Recurrence || !held.length) return null;
    try { return window.Recurrence.findRecurrence(held); }
    catch (e) { console.warn('[void] recurrence failed:', e); return null; }
  }, [held]);

  if (!room) return <div className="tv-empty">select a room</div>;
  if (!VS) return <div className="tv-empty">the void's local store hasn't loaded yet</div>;

  const ctx = () => ({ emit: onEmit, ME: window.MatrixEngine, sender: myUserId || '@you:demo' });

  /**
   * Put a captured file in Drive and hand back its document anchor. The
   * held entry references that document rather than owning the only copy,
   * so discarding or promoting the note never destroys the recording.
   */
  async function fileToDrive(file, label) {
    if (!window.Drive || !window.DriveBytes) return null;
    try {
      setFiling(label);
      const ref = await window.DriveBytes.upload(file, { live });
      return await window.Drive.createDoc(ctx(), {
        name: file.name || label, ref, folder: null,
        mime: file.type, size: file.size,
      });
    } catch (e) {
      console.warn('[void] could not file to drive:', e);
      setRecError(`Held it locally, but couldn't file it in Drive: ${e?.message || e}`);
      return null;
    } finally { setFiling(null); }
  }

  async function holdText(t) {
    await VS.addHeld(roomId, { text: t });
  }

  async function clearIt() {
    const t = text.trim();
    if (!t) return;
    if (t.length >= SHRED_OFFER_CHARS && window.Shred) {
      const result = window.Shred.shred(t);
      if (result.kind !== 'single' && result.segments.length > 1) {
        setShredding({ raw: t, result });
        return;
      }
    }
    await holdText(t);
    setText('');
    refresh();
  }

  async function attachFile(file) {
    const isAudio = (file.type || '').startsWith('audio/');
    const docAnchor = await fileToDrive(file, file.name || 'file');
    await VS.addHeld(roomId, {
      text: '',
      attachment: {
        kind: isAudio ? 'audio' : 'file', name: file.name, mime: file.type,
        size: file.size, blob: file, docAnchor,
      },
    });
    refresh();
  }

  async function toggleRecording() {
    if (recording) { recorderRef.current?.stop(); return; }
    setRecError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const startedAt = Date.now();
      chunksRef.current = [];
      rec.ondataavailable = e => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const durationMs = Date.now() - startedAt;
        const name = `voice note ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}.webm`;
        const file = new File([blob], name, { type: blob.type });
        const docAnchor = await fileToDrive(file, name);
        await VS.addHeld(roomId, {
          text: '',
          attachment: { kind: 'audio', name, mime: blob.type, size: blob.size, blob: file, durationMs, docAnchor },
        });
        setRecording(false);
        refresh();
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setRecError(e?.message || 'could not start recording');
    }
  }

  async function transcribeEntry(entry) {
    if (!window.Transcribe) { setRecError('transcription is not available in this build'); return; }
    setTranscribing(entry.id);
    try {
      const bytes = new Uint8Array(await entry.attachment.blob.arrayBuffer());
      const result = await window.Transcribe.transcribeAudio(bytes, entry.attachment.mime, {});
      // The transcript belongs to the Drive document, where the player and
      // its clickable chunks already live. The held copy only carries the
      // text, which is all recurrence needs to see.
      if (entry.attachment.docAnchor && window.Drive) {
        await window.Drive.attachTranscript(ctx(), entry.attachment.docAnchor, {
          text: result.text || '', chunks: result.chunks || [],
        });
      }
      await VS.updateHeld(roomId, entry.id, { text: result.text || '' });
      refresh();
    } catch (e) {
      setRecError(e?.message || 'transcription failed');
    } finally { setTranscribing(null); }
  }

  async function discard(id) { await VS.removeHeld(roomId, id); refresh(); }

  /**
   * Promotion carries its origin with it. The notes that formed a thing
   * are the reason it exists, and six weeks later they are the only record
   * of why it looked worth naming — so they are written onto the entity
   * rather than deleted along with the held entries.
   */
  async function handlePromote(name) {
    const ME = window.MatrixEngine;
    const entries = promoting.entries;
    const sender = myUserId || '@you:demo';
    const ts = Date.now();
    const payload = { Title: name };
    const anchor = ME.makeAnchor(VOID_ENTITY_TYPE, payload, sender, ts);

    await onEmit(ME.OP.INS, { anchor, entity_type: VOID_ENTITY_TYPE, payload });
    await onEmit(ME.OP.DEF, {
      anchor, path: 'came_from',
      value: {
        notes: entries.map(e => ({
          text: e.text || previewOf(e, 400),
          at: new Date(e.ts).toISOString(),
          ...(e.attachment?.docAnchor ? { file: e.attachment.docAnchor } : {}),
        })),
        first_seen: new Date(Math.min(...entries.map(e => e.ts))).toISOString(),
      },
    });

    for (const e of entries) await VS.removeHeld(roomId, e.id);
    setPromoting(null);
    setJustPromoted({ anchor, count: entries.length });
    refresh();
  }

  const clusters = recurrence?.measured ? recurrence.clusters : [];
  const clusteredIds = new Set(clusters.flatMap(c => c.ids));
  const loose = held.filter(h => !clusteredIds.has(h.id));

  return (
    <div className="void-view">
      {scrubber}
      <div className="void-body">
        <header className="void-hero">
          <div className="void-hero-sub">
            Dump things here. Don't organize yet — notes, voice memos, half-thoughts,
            conversations you had with an AI. None of it has to be about anything.
          </div>
        </header>

        <div className="void-capture">
          <textarea
            className="void-textarea"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) clearIt(); }}
            placeholder="what's on your mind"
            rows={3}
          />
          <div className="void-actions">
            <button type="button" className={`void-action-btn ${recording ? 'recording' : ''}`}
              onClick={toggleRecording}>{recording ? 'stop' : 'record'}</button>
            <button type="button" className="void-action-btn"
              onClick={() => fileInputRef.current?.click()}>add a file</button>
            <input ref={fileInputRef} type="file" hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) attachFile(f); e.target.value = ''; }} />
            <span className="spacer" />
            {filing && <span className="void-filing">filing {filing} in Drive…</span>}
            <button type="button" className="void-action-btn primary" onClick={clearIt}
              disabled={!text.trim()}>hold it</button>
          </div>
          {recError && <div className="void-error">{recError}</div>}
        </div>

        {/* What you keep coming back to. A fact about the user's own
            behaviour, never a claim about what the notes mean. */}
        {ready && held.length > 0 && (
          <div className="void-recur">
            {clusters.length > 0 && <div className="void-recur-head">You keep coming back to these.</div>}
            {clusters.map((c, i) => (
              <div className="void-cluster" key={i}>
                <div className="void-cluster-count">
                  {c.size} notes, {spanLabel(c.from, c.to)}
                </div>
                <div className="void-cluster-terms">
                  {c.terms.map((t, j) => <span className="void-term" key={j}>{t}</span>)}
                </div>
                <div className="void-cluster-span">
                  {shortDate(c.from)} — {shortDate(c.to)}
                </div>
                <div className="void-cluster-acts">
                  <button className="cs-btn" onClick={() => setReading(c.entries)}>read all {c.size}</button>
                  <button className="cs-btn primary"
                    onClick={() => setPromoting({ kind: 'cluster', entries: c.entries, from: c.from })}>
                    name this
                  </button>
                </div>
              </div>
            ))}
            {clusters.length === 0 && (
              <div className="void-recur-none">
                {recurrence?.measured
                  ? "Nothing's repeated yet — no group of these notes has more in common than chance explains."
                  : recurrence?.reason === 'too-few'
                    ? `Not enough held yet to tell repeats from coincidence (${recurrence.held} of ${recurrence.needed}). Keep dumping.`
                    : 'Nothing with words in it yet — transcribe an audio note and it joins in.'}
              </div>
            )}
          </div>
        )}

        <div className="void-held-section">
          <div className="void-held-head">
            held{clusters.length > 0 ? ' · everything else' : ''}
          </div>
          {!ready && <div className="void-held-empty">loading…</div>}
          {ready && held.length === 0 && (
            <div className="void-held-empty">Nobody's forcing you to decide what these are.</div>
          )}
          {loose.map(h => (
            <div className="void-held-row" key={h.id}>
              <span className="void-held-dot">·</span>
              <span className="void-held-text">{previewOf(h)}</span>
              {h.attachment?.docAnchor && (
                <button type="button" className="void-held-open"
                  title="open it in Drive, with the transcript"
                  onClick={() => setSelection({ kind: 'drive', anchor: h.attachment.docAnchor })}>
                  open
                </button>
              )}
              {h.attachment?.kind === 'audio' && !h.text && (
                <button type="button" className="void-held-transcribe" disabled={transcribing === h.id}
                  onClick={() => transcribeEntry(h)}>
                  {transcribing === h.id ? 'transcribing…' : 'transcribe'}
                </button>
              )}
              <span className="void-held-age">{ageLabel(Date.now() - h.ts)}</span>
              <button type="button" className="void-held-promote"
                onClick={() => setPromoting({ kind: 'entry', entries: [h], from: h.ts })}>name it</button>
              <button type="button" className="void-held-discard" onClick={() => discard(h.id)}
                title="discard — never became anything">×</button>
            </div>
          ))}
        </div>
      </div>

      {shredding && (
        <ShredModal
          result={shredding.result}
          onCancel={() => setShredding(null)}
          onKeepWhole={async () => { await holdText(shredding.raw); setShredding(null); setText(''); refresh(); }}
          onConfirm={async segments => {
            for (const s of segments) await holdText(s.text);
            setShredding(null); setText(''); refresh();
          }}
        />
      )}

      {reading && <ReadAllModal entries={reading} onClose={() => setReading(null)} />}

      {promoting && (
        <PromoteModal source={promoting} onClose={() => setPromoting(null)} onPromote={handlePromote} />
      )}

      {justPromoted && (
        <div className="proj-modal-backdrop" onClick={() => setJustPromoted(null)}>
          <div className="proj-modal void-postins-modal" onClick={e => e.stopPropagation()}>
            <div className="proj-modal-head">
              <div className="proj-modal-eyebrow">named</div>
            </div>
            <div className="proj-modal-body">
              <div className="void-promote-hint">
                It's a thing now, and it remembers the {justPromoted.count === 1 ? 'note' : `${justPromoted.count} notes`} it
                came from.
              </div>
            </div>
            <div className="void-shred-foot">
              <button className="cs-btn" onClick={() => setJustPromoted(null)}>keep dumping</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

window.VoidView = VoidView;
})();
