/* void-view.jsx — Existence · Ground · Clearing: the front door.
 *
 * A stray thought shouldn't have to answer "which table? what type? what
 * partition?" before it's even allowed to exist — that forces Structure and
 * Interpretation decisions onto a pure Existence·Ground act. This view is
 * one free-text box. Nothing typed here becomes a Matrix event until it's
 * promoted (INS); until then it's held in IndexedDB only (src/void-store.js),
 * ephemeral in the same sense NUL/SIG are ephemeral in operators.js.
 *
 * The held list has no triage affordance on purpose: no due dates, no
 * priority, no archive nag. An unpromoted observation is a finding, not a
 * backlog item.
 */

(function () {
const { useState, useEffect, useRef, useCallback } = React;

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
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// ── promotion modal — a name, and nothing else required ────────────────

function PromoteModal({ entry, onClose, onPromote }) {
  const [name, setName] = useState((entry.text || '').slice(0, 120));
  const [busy, setBusy] = useState(false);
  const canGo = name.trim().length > 0 && !busy;

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
          <div className="proj-modal-eyebrow">← the void</div>
          <div className="void-promote-source">{entry.text || (entry.attachment ? entry.attachment.name : '(untitled observation)')}</div>
        </div>
        <div className="proj-modal-body">
          <div className="void-promote-hint">Naming it makes it a thing. Everything before this point was held; this move is permanent.</div>
          <input
            autoFocus
            className="proj-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onClose(); }}
            placeholder="name it"
          />
        </div>
        <div className="proj-modal-foot">
          <button className="proj-modal-cancel" onClick={onClose}>cancel</button>
          <button className="proj-modal-create" onClick={go} disabled={!canGo}>{busy ? 'instantiating…' : 'instantiate →'}</button>
        </div>
      </div>
    </div>
  );
}

// ── post-INS confirmation — position, lawful next, and an explicit exit ─

function PostInsPanel({ anchor, entityType, state, onClose, setSelection }) {
  const entity = state.entities[anchor];
  const CP = window.CubePosition;
  const pos = entity && CP ? CP.positionOf(entity, state) : null;
  const next = entity && CP ? CP.lawfulNext(entity, state) : [];

  return (
    <div className="void-postins">
      <div className="void-postins-line">
        <span className="void-postins-check">✓</span> An Entity exists.
        {pos && <> You're at <b>{pos.domain} · {pos.grain}</b>.</>}
      </div>
      <div className="void-postins-sub">No Structure, no Interpretation yet — expected, not a gap.</div>
      {next.length > 0 && (
        <div className="cc-next">
          <span className="cc-next-label">lawful next:</span>
          {next.map(n => <span key={n.key} className="cc-next-op">{n.key.toUpperCase()}</span>)}
        </div>
      )}
      <div className="void-postins-actions">
        <button className="proj-modal-cancel" onClick={onClose}>[ leave it here ]</button>
        {setSelection && (
          <button
            className="proj-modal-create"
            onClick={() => setSelection({ kind: 'slice', sliceId: `${entityType}.timeline.${anchor}`, sliceKind: 'timeline', tableId: entityType, entityAnchor: anchor })}
          >open it →</button>
        )}
      </div>
    </div>
  );
}

// ── the view ─────────────────────────────────────────────────────────────

// Entities promoted out of the Void land in one generic, meaning-neutral
// set — the point of shipping promotion name-only (see spec) is that
// nothing here presumes a type. It arrives later as a real DEF, if at all.
const VOID_ENTITY_TYPE = 'observation';

function VoidView({ room, state, onEmit, scrubber, setSelection, myUserId }) {
  const roomId = room?.id;
  const VS = window.VoidStore;
  const [text, setText] = useState('');
  const [held, setHeld] = useState([]);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recError, setRecError] = useState(null);
  const [promoting, setPromoting] = useState(null);
  const [justPromoted, setJustPromoted] = useState(null);
  const [transcribing, setTranscribing] = useState(null); // held id in flight
  const fileInputRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);

  const refresh = useCallback(async () => {
    if (!roomId || !VS) return;
    const list = await VS.listHeld(roomId);
    setHeld(list);
    setReady(true);
  }, [roomId, VS]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!room) return <div className="tv-empty">select a room</div>;
  if (!VS) return <div className="tv-empty">the void's local store hasn't loaded yet</div>;

  async function clearIt() {
    const t = text.trim();
    if (!t) return;
    await VS.addHeld(roomId, { text: t });
    setText('');
    refresh();
  }

  async function attachFile(file) {
    await VS.addHeld(roomId, {
      text: '',
      attachment: { kind: 'file', name: file.name, mime: file.type, size: file.size, blob: file },
    });
    refresh();
  }

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setRecError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      const startedAt = Date.now();
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        await VS.addHeld(roomId, {
          text: '',
          attachment: { kind: 'audio', name: 'audio memo', mime: blob.type, size: blob.size, durationMs: Date.now() - startedAt, blob },
        });
        setRecording(false);
        refresh();
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setRecError(e?.message || 'could not access the microphone');
    }
  }

  async function transcribeEntry(entry) {
    if (!window.Transcribe?.isSupported?.()) {
      setRecError('this browser can\'t transcribe audio here');
      return;
    }
    setTranscribing(entry.id);
    try {
      const bytes = new Uint8Array(await entry.attachment.blob.arrayBuffer());
      const result = await window.Transcribe.transcribeAudio(bytes, entry.attachment.mime, {});
      await VS.removeHeld(roomId, entry.id);
      await VS.addHeld(roomId, { text: result.text || '', attachment: entry.attachment });
      refresh();
    } catch (e) {
      setRecError(e?.message || 'transcription failed');
    } finally {
      setTranscribing(null);
    }
  }

  async function discard(id) {
    await VS.removeHeld(roomId, id);
    refresh();
  }

  async function handlePromote(name) {
    const ME = window.MatrixEngine;
    const sender = myUserId || '@you:demo';
    const ts = Date.now();
    const payload = { Title: name };
    const anchor = ME.makeAnchor(VOID_ENTITY_TYPE, payload, sender, ts);
    onEmit(ME.OP.INS, { anchor, entity_type: VOID_ENTITY_TYPE, payload });
    await VS.removeHeld(roomId, promoting.id);
    setPromoting(null);
    setJustPromoted({ anchor });
    refresh();
  }

  return (
    <div className="void-view">
      {scrubber}
      <div className="void-body">
        <header className="void-hero">
          <div className="void-hero-eyebrow">Existence · Ground · Clearing</div>
          <div className="void-hero-sub">Nothing is named here yet. That's fine — this is the Void, and clearing it is the work.</div>
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
            <button
              type="button"
              className={`void-action-btn ${recording ? 'recording' : ''}`}
              onClick={toggleRecording}
            >{recording ? '⏹ stop' : '🎙 record'}</button>
            <button type="button" className="void-action-btn" onClick={() => fileInputRef.current?.click()}>📎 attach</button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) attachFile(f); e.target.value = ''; }}
            />
            <span className="spacer" />
            <button type="button" className="void-action-btn primary" onClick={clearIt} disabled={!text.trim()}>⏎ clear it</button>
          </div>
          {recError && <div className="void-error">{recError}</div>}
        </div>

        <div className="void-held-section">
          <div className="void-held-head">held — differentiated, not yet instantiated:</div>
          {!ready && <div className="void-held-empty">loading…</div>}
          {ready && held.length === 0 && (
            <div className="void-held-empty">Nobody's forcing you to decide what these are.</div>
          )}
          {held.map(h => (
            <div className="void-held-row" key={h.id}>
              <span className="void-held-dot">·</span>
              <span className="void-held-text">
                {h.text
                  ? `"${h.text.length > 90 ? h.text.slice(0, 90) + '…' : h.text}"`
                  : h.attachment?.kind === 'audio'
                    ? `audio memo, ${formatDuration(h.attachment.durationMs || 0)}, untranscribed`
                    : h.attachment
                      ? h.attachment.name
                      : '(empty)'}
              </span>
              {h.attachment?.kind === 'audio' && !h.text && (
                <button
                  type="button"
                  className="void-held-transcribe"
                  disabled={transcribing === h.id}
                  onClick={() => transcribeEntry(h)}
                >{transcribing === h.id ? 'transcribing…' : 'transcribe'}</button>
              )}
              <span className="void-held-age">{ageLabel(Date.now() - h.ts)}</span>
              <button type="button" className="void-held-promote" onClick={() => setPromoting(h)}>→ INS?</button>
              <button type="button" className="void-held-discard" onClick={() => discard(h.id)} title="discard — never became anything">×</button>
            </div>
          ))}
        </div>
      </div>

      {promoting && (
        <PromoteModal entry={promoting} onClose={() => setPromoting(null)} onPromote={handlePromote} />
      )}

      {justPromoted && (
        <div className="proj-modal-backdrop" onClick={() => setJustPromoted(null)}>
          <div className="proj-modal void-postins-modal" onClick={e => e.stopPropagation()}>
            <PostInsPanel
              anchor={justPromoted.anchor}
              entityType={VOID_ENTITY_TYPE}
              state={state}
              onClose={() => setJustPromoted(null)}
              setSelection={setSelection}
            />
          </div>
        </div>
      )}
    </div>
  );
}

window.VoidView = VoidView;

})();
