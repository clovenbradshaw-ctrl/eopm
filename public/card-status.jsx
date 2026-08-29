/* card-status.jsx — where a thing stands, and the one move that changes it.
 *
 * This replaces the compact cube compass on cards. The compass was a
 * faithful readout of an entity's position and completely inert: nine dots
 * that look clickable, where clicking only pinned a tooltip. Reading it
 * required knowing the vocabulary, and acting on it required knowing which
 * of eight views to go open.
 *
 * So the status line and its remedy are now the same object. "Nothing
 * depends on this" is itself the button that adds a dependency — there is
 * no step between understanding the diagnosis and acting on it.
 *
 * Every sentence rendered here comes from src/plain-position.js, which is
 * guarded by test/plain-position.test.mjs against ever leaking machinery
 * vocabulary into the interface. Nothing in this file should ever
 * construct its own status text.
 */

(function () {
const { useState, useMemo } = React;

const PP = () => window.PlainPosition;

// ── the one-move modal ─────────────────────────────────────────────────

function pickerRows(entity, state) {
  return Object.values(state.entities || {})
    .filter(e => e && e._anchor !== entity._anchor && !e._deleted && e._type !== '_synthesis')
    .map(e => ({ anchor: e._anchor, label: PP().titleOf(e), type: e._type }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function NextStepModal({ entity, state, action, onEmit, onClose }) {
  const ME = window.MatrixEngine;
  const [target, setTarget] = useState('');
  const [relation, setRelation] = useState('needs');
  const [criterion, setCriterion] = useState('');
  const [result, setResult] = useState('pass');
  const [busy, setBusy] = useState(false);

  const others = useMemo(() => pickerRows(entity, state), [entity, state]);
  const connected = useMemo(
    () => (state.connections || [])
      .filter(c => c.source === entity._anchor || c.target === entity._anchor)
      .map(c => (c.source === entity._anchor ? c.target : c.source)),
    [entity, state]);

  const title = PP().titleOf(entity);

  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      if (action.op === 'con') {
        if (!target) return;
        await onEmit(ME.OP.CON, { source_anchor: entity._anchor, target_anchor: target, relation_type: relation });
      } else if (action.op === 'syn') {
        const inputs = [entity._anchor, ...connected];
        await onEmit(ME.OP.SYN, { input_anchors: inputs, output: { Title: `${title} — together` } });
      } else if (action.op === 'eva') {
        if (!criterion.trim()) return;
        await onEmit(ME.OP.EVA, { anchor: entity._anchor, criterion: criterion.trim(), result, note: '' });
      }
      onClose(true);
    } finally { setBusy(false); }
  }

  const canGo = action.op === 'con' ? !!target
    : action.op === 'eva' ? !!criterion.trim()
    : action.op === 'syn' ? connected.length > 0
    : false;

  return (
    <div className="proj-modal-backdrop" onClick={() => onClose(false)}>
      <div className="proj-modal cs-modal" onClick={e => e.stopPropagation()}>
        <div className="proj-modal-head">
          <div className="proj-modal-eyebrow">{title}</div>
          <div className="cs-modal-title">{action.label}</div>
        </div>

        <div className="proj-modal-body">
          {action.op === 'con' && (
            others.length === 0
              ? <div className="cs-modal-empty">There's nothing else here yet to point at. Make another thing first.</div>
              : <>
                  <label className="cs-label">what does <b>{title}</b> need?</label>
                  <select className="cs-select" value={target} onChange={e => setTarget(e.target.value)} autoFocus>
                    <option value="">pick one…</option>
                    {others.map(o => <option key={o.anchor} value={o.anchor}>{o.label}</option>)}
                  </select>
                  <label className="cs-label">how does it need it?</label>
                  <select className="cs-select" value={relation} onChange={e => setRelation(e.target.value)}>
                    <option value="needs">needs</option>
                    <option value="blocks">blocks</option>
                    <option value="part_of">is part of</option>
                    <option value="came_from">came from</option>
                  </select>
                </>
          )}

          {action.op === 'syn' && (
            connected.length === 0
              ? <div className="cs-modal-empty">Nothing is linked to this yet, so there's nothing to pull together.</div>
              : <>
                  <div className="cs-modal-hint">
                    This makes one thing out of {title} and everything currently linked to it. The pieces stay
                    where they are — nothing is replaced.
                  </div>
                  <ul className="cs-list">
                    <li>{title}</li>
                    {connected.map(a => <li key={a}>{PP().titleOf(state.entities[a]) || a}</li>)}
                  </ul>
                </>
          )}

          {action.op === 'eva' && (
            <>
              <div className="cs-modal-hint">What did you check, and did it hold up?</div>
              <label className="cs-label">what you checked</label>
              <input className="cs-input" value={criterion} autoFocus
                onChange={e => setCriterion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && canGo && go()}
                placeholder="e.g. someone new could pick this up cold" />
              <label className="cs-label">how it went</label>
              <div className="cs-radios">
                {['pass', 'fail'].map(r => (
                  <label key={r} className={`cs-radio ${result === r ? 'on' : ''}`}>
                    <input type="radio" name="cs-result" checked={result === r} onChange={() => setResult(r)} />
                    {r === 'pass' ? 'held up' : "didn't hold up"}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="cs-modal-foot">
          <button className="cs-btn" onClick={() => onClose(false)}>cancel</button>
          <button className="cs-btn primary" disabled={!canGo || busy} onClick={go}>
            {busy ? 'saving…' : action.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── the card line ──────────────────────────────────────────────────────

/**
 * CardStatus — one plain sentence and, when there is something worth
 * doing, one button that does it.
 *
 * `onDefine` is handed in by the host so "say what it is" opens whatever
 * editor that surface already has, rather than this file growing a second
 * field editor beside it.
 */
function CardStatus({ entity, state, onEmit, onDefine, compact = false }) {
  const [open, setOpen] = useState(null);
  if (!PP() || !entity) return null;

  const d = PP().describeEntity(entity, state);
  if (!d) return null;

  function act() {
    if (d.action.op === 'def') { onDefine && onDefine(entity._anchor); return; }
    setOpen(d.action);
  }

  return (
    <div className={`card-status ${compact ? 'compact' : ''} rung-${d.id}`}>
      <span className="card-status-text" title={d.headline}>{compact ? d.chip : d.headline}</span>
      {d.action && (
        <button type="button" className="card-status-act"
          onClick={e => { e.stopPropagation(); act(); }}>
          {d.action.label}
        </button>
      )}
      {open && (
        <div onClick={e => e.stopPropagation()}>
          <NextStepModal entity={entity} state={state} action={open} onEmit={onEmit}
            onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}

/** A structural finding, said plainly. Never styled as an error. */
function CardFinding({ finding, state }) {
  if (!PP() || !finding) return null;
  const line = PP().describeFinding(finding, state);
  if (!line) return null;
  return <div className="card-finding">{line}</div>;
}

window.CardStatus = React.memo(CardStatus);
window.CardFinding = React.memo(CardFinding);
})();
