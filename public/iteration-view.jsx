/* iteration-view.jsx — REC as the iteration surface.
 *
 * rec(roomId, scope, beforeFrame, afterFrame) already preserves the old
 * frame in the log — that's version history with reasoning attached, and
 * until now nothing in the UI showed it. This view lists every REC scoped
 * to one entity (`frame.scope === entity._anchor`) as before → after, lets
 * you replay the room as it stood before any one of them, and offers
 * "reframe" as the explicit new-iteration move.
 *
 * Completion is read off the cube, not off checkboxes: Paradigm-complete
 * means all three domains have been entered and the entity has been both
 * EVA'd and REC'd — not that nothing is left. Open gaps are shown alongside
 * a completion badge, never hidden by it.
 */

(function () {
const { useState, useMemo } = React;

function frameSide(frame) {
  if (!frame) return '';
  if (typeof frame === 'string') return frame;
  if (typeof frame.text === 'string') return frame.text;
  return JSON.stringify(frame);
}

function IterationView({
  room, state, entityType, entityAnchor, scrubber, allEventsInRoom, setSelection, onEmit, myUserId,
}) {
  const [reframing, setReframing] = useState(false);
  const [was, setWas] = useState('');
  const [now, setNow] = useState('');
  const [replayTs, setReplayTs] = useState(null);

  if (!room) return <div className="tv-empty">select a room</div>;
  const entity = state.entities[entityAnchor];
  if (!entity) {
    return (
      <div className="table-view">
        {scrubber}
        <div className="tv-body single"><div className="tv-empty">no such entity — it may have been renamed or its anchor changed</div></div>
      </div>
    );
  }

  const frames = useMemo(
    () => (state.frames || [])
      .filter(f => f.scope === entityAnchor)
      .slice()
      .sort((a, b) => a._ts - b._ts),
    [state.frames, entityAnchor]
  );

  const CP = window.CubePosition;
  const pos = CP ? CP.positionOf(entity, state) : null;
  const gaps = CP ? CP.gapsOf(entity, state, null) : [];
  const occ = pos?.occupied || { Existence: [], Structure: [], Interpretation: [] };
  const complete = occ.Existence.length > 0 && occ.Structure.length > 0 &&
    occ.Interpretation.includes('eva') && occ.Interpretation.includes('rec');

  const replayState = useMemo(() => {
    if (replayTs == null) return null;
    const ME = window.MatrixEngine;
    const events = (allEventsInRoom || []).filter(e => (e.origin_server_ts || 0) <= replayTs);
    return ME.fold(events);
  }, [replayTs, allEventsInRoom]);

  function submitReframe() {
    const ME = window.MatrixEngine;
    if (!was.trim() && !now.trim()) return;
    onEmit(ME.OP.REC, {
      scope: entityAnchor,
      before_frame: { text: was.trim() },
      after_frame: { text: now.trim() },
    });
    setWas(''); setNow(''); setReframing(false);
  }

  function backToTimeline() {
    setSelection && setSelection({
      kind: 'slice', sliceId: `${entityType}.timeline.${entityAnchor}`,
      sliceKind: 'timeline', tableId: entityType, entityAnchor,
    });
  }

  const title = entity.Title || entity.Name || entity.title || entity.body || entity.claim || entity.what || entity._anchor;

  return (
    <div className="table-view">
      {scrubber}
      <div className="tv-body single schema-body">
        <header className="page-hero entity-hero">
          <div className="page-hero-eyebrow">
            <span className="page-hero-kind"><span className="page-hero-glyph">⊛</span> iterations</span>
            <span className="page-hero-sep">·</span>
            <span className="page-hero-crumb">{room.title || 'workspace'}<span className="page-hero-slash">/</span>{entityType}<span className="page-hero-slash">/</span>{entityAnchor}</span>
            <button className="entity-back" onClick={backToTimeline} title="back to full timeline">← full timeline</button>
          </div>
          <h1 className="page-hero-title">{title}</h1>
          <div className="page-hero-sub">{frames.length} iteration{frames.length !== 1 ? 's' : ''} · every frame replayable</div>
        </header>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">completeness</h2>
            <span className="page-section-sub">read off the cube, not off checkboxes</span>
          </div>
          <div className={`it-complete ${complete ? 'is-complete' : ''}`}>
            <div className="it-complete-domains">
              {['Existence', 'Structure', 'Interpretation'].map(d => (
                <span key={d} className={`it-complete-dom ${occ[d]?.length > 0 ? 'entered' : ''}`}>{d}</span>
              ))}
            </div>
            <div className="it-complete-verdict">
              {complete
                ? 'PARADIGM — the core claim survived a full pass.'
                : 'not yet paradigm-complete — needs every domain entered, an EVA, and a REC.'}
            </div>
            {gaps.length > 0 && (
              <div className="it-complete-open">
                <div className="it-complete-open-label">still open (this is not a contradiction):</div>
                {gaps.map(g => (
                  <div key={g.op} className="it-complete-open-row">· {g.domain} · {g.grain} has no {g.op.toUpperCase()} yet</div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="page-section">
          <div className="page-section-head">
            <h2 className="page-section-label">iterations</h2>
            <button className="tv-tool-btn" onClick={() => setReframing(o => !o)}>{reframing ? 'cancel' : '+ reframe (new REC)'}</button>
          </div>

          {reframing && (
            <div className="op-form it-reframe-form">
              <div className="hint">What changed in meaning — not what changed in the data.</div>
              <div className="row">
                <label>was</label>
                <input value={was} onChange={e => setWas(e.target.value)} placeholder="the old frame" />
              </div>
              <div className="row">
                <label>now</label>
                <input value={now} onChange={e => setNow(e.target.value)} placeholder="the new frame" />
              </div>
              <div className="actions">
                <button onClick={submitReframe} disabled={!was.trim() && !now.trim()}>reframe →</button>
                <button className="ghost" onClick={() => setReframing(false)}>cancel</button>
              </div>
            </div>
          )}

          {replayState && (
            <div className="it-replay-banner">
              <span>⏪ viewing as of {new Date(replayTs).toLocaleString()}</span>
              <span className="it-replay-summary">
                {Object.keys(replayState.entities || {}).length} entities · {(replayState.connections || []).length} links ·{' '}
                {replayState.entities?.[entityAnchor]?._evaluations?.length ? `${replayState.entities[entityAnchor]._evaluations.length} eval(s)` : 'no EVA'}
              </span>
              <button className="tv-tool-reset" onClick={() => setReplayTs(null)}>back to now</button>
            </div>
          )}

          <div className="it-list">
            {frames.length === 0 && (
              <div className="tv-empty">no reframes yet — this entity hasn't been through a paradigm shift.</div>
            )}
            {frames.slice().reverse().map((f, i) => (
              <div key={f._eventId || i} className="it-frame">
                <div className="it-frame-num">{frames.length - i}</div>
                <div className="it-frame-body">
                  <div className="it-frame-head">
                    <span className="it-frame-sender">{f._sender}</span>
                    <span className="it-frame-ts">{new Date(f._ts).toLocaleString()}</span>
                  </div>
                  <div className="it-frame-row"><span className="it-frame-label">was</span> {frameSide(f.before_frame)}</div>
                  <div className="it-frame-row"><span className="it-frame-label">now</span> {frameSide(f.after_frame)}</div>
                  <button className="tv-inline-link" onClick={() => setReplayTs(f._ts)}>replay to here</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

window.IterationView = React.memo(IterationView);

})();
