/* cube-compass.jsx — the cube position, made ambient.
 *
 * A persistent strip that shows where an entity sits in the making of
 * itself: three domain tracks (Existence / Structure / Interpretation),
 * each with three grain dots (Ground / Figure / Pattern). Filled dots are
 * operators that have actually fired for this entity; quiet dots haven't —
 * and an empty domain is never rendered as a warning. Un-entered is not
 * failure.
 *
 * Reads only window.CubePosition (positionOf / lawfulNext / gapsOf) — no
 * new state, no events, nothing written anywhere. If window.CubePosition
 * hasn't loaded yet (the ES-module bridge in index.html hasn't resolved),
 * the compass renders nothing rather than throwing.
 */

(function () {
const { useState, useMemo } = React;

const DOMAIN_VAR = {
  Existence: 'existence',
  Structure: 'structure',
  Interpretation: 'significance', // the CSS custom property this app already uses for DEF/EVA/REC
};

function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * CubeCompass — the compact form for board/table cards (a single row of
 * nine small dots, three per domain) and the full form for entity detail
 * (three labeled tracks plus a caption naming the current terrain).
 *
 * Props:
 *   entity   — a folded entity ({_anchor, _hwm, ...})
 *   state    — the fold state it came from
 *   compact  — true for card use; false/omitted for the full detail strip
 *   diagnosis — optional, from window.Unblock.diagnose(entity, state, rhythm);
 *               when present and `.stalled`, shows the quiet ⏸ marker that
 *               expands to the diagnosis on tap. Never a notification.
 */
function CubeCompass({ entity, state, compact = false, diagnosis = null }) {
  const CP = window.CubePosition;
  const [hoverCell, setHoverCell] = useState(null); // { domain, grain } | null
  const [pinnedCell, setPinnedCell] = useState(null);
  const [diagOpen, setDiagOpen] = useState(false);

  const pos = useMemo(() => (CP && entity ? CP.positionOf(entity, state) : null), [CP, entity, state]);
  const next = useMemo(() => (CP && entity ? CP.lawfulNext(entity, state) : []), [CP, entity, state]);

  if (!CP || !pos) return null;

  const Cube = window.Cube;
  const domains = Cube?.DOMAINS || ['Existence', 'Structure', 'Interpretation'];
  const grains = Cube?.GRAINS || ['Ground', 'Figure', 'Pattern'];
  const grainAbbrev = { Ground: 'Grd', Figure: 'Fig', Pattern: 'Pat' };

  const activeCell = pinnedCell || hoverCell;
  const activeInfo = activeCell && Cube
    ? {
        op: Cube.cellOf(activeCell.domain, activeCell.grain),
        terrain: Cube.terrainOf(activeCell.domain, activeCell.grain),
        stance: Cube.stanceOf(Cube.OP_CELLS[Cube.cellOf(activeCell.domain, activeCell.grain)]?.mode),
      }
    : null;

  function dotState(domain, grain) {
    const op = Cube ? Cube.cellOf(domain, grain) : null;
    const fired = op && pos.occupied[domain]?.includes(op);
    const isCurrent = pos.domain === domain && pos.grain === grain;
    return { op, fired, isCurrent };
  }

  function toggleCell(domain, grain) {
    setPinnedCell(prev => (prev && prev.domain === domain && prev.grain === grain) ? null : { domain, grain });
  }

  if (compact) {
    return (
      <div className="cube-compass compact" title={`${pos.domain} · ${pos.grain} — ${pos.terrain}`}>
        {domains.map(domain => (
          <span key={domain} className={`cc-track compact dom-${DOMAIN_VAR[domain]}`}>
            {grains.map(grain => {
              const d = dotState(domain, grain);
              return (
                <span
                  key={grain}
                  className={`cc-dot ${d.fired ? 'fired' : ''} ${d.isCurrent ? 'current' : ''}`}
                />
              );
            })}
          </span>
        ))}
        {diagnosis?.stalled && <span className="cc-pause" title="hasn't moved in a while — tap for detail on the full compass">⏸</span>}
      </div>
    );
  }

  return (
    <div className="cube-compass">
      <div className="cc-rows">
        {domains.map(domain => (
          <div key={domain} className={`cc-row dom-${DOMAIN_VAR[domain]}`}>
            <span className="cc-domain-label">{domain}</span>
            <span className="cc-track">
              {grains.map((grain, i) => {
                const d = dotState(domain, grain);
                return (
                  <React.Fragment key={grain}>
                    {i > 0 && <span className={`cc-line ${d.fired ? 'fired' : ''}`} />}
                    <button
                      type="button"
                      className={`cc-dot ${d.fired ? 'fired' : ''} ${d.isCurrent ? 'current' : ''}`}
                      onMouseEnter={() => setHoverCell({ domain, grain })}
                      onMouseLeave={() => setHoverCell(null)}
                      onClick={() => toggleCell(domain, grain)}
                      aria-label={`${domain} · ${grain}${d.fired ? ' — fired' : ' — not yet'}`}
                    />
                  </React.Fragment>
                );
              })}
            </span>
            <span className="cc-grain-labels">
              {grains.map(g => <span key={g}>{grainAbbrev[g]}</span>)}
            </span>
          </div>
        ))}
      </div>

      {activeInfo && (
        <div className="cc-pop">
          <div className="cc-pop-head">{activeCell.domain} · {activeCell.grain} = {activeInfo.terrain?.toUpperCase()}</div>
          <div className="cc-pop-row">stance: {activeInfo.stance}</div>
          <div className="cc-pop-row">fires with: {activeInfo.op?.toUpperCase()}</div>
        </div>
      )}

      {!activeInfo && (
        <div className="cc-caption">
          <span className="cc-caption-pos">{pos.domain} · {pos.grain}</span>
          <span className="cc-caption-sep">—</span>
          <span className="cc-caption-terrain">{pos.terrain?.toLowerCase()}</span>
          {entity?._created && <span className="cc-caption-age">{ageLabel(Date.now() - (entity._updated || entity._created))} old</span>}
        </div>
      )}

      {next.length > 0 && (
        <div className="cc-next">
          <span className="cc-next-label">lawful next:</span>
          {next.map(n => (
            <span key={n.key} className="cc-next-op">{n.key.toUpperCase()}</span>
          ))}
        </div>
      )}

      {diagnosis?.stalled && (
        <button type="button" className="cc-diag-toggle" onClick={() => setDiagOpen(o => !o)}>
          ⏸ {diagnosis.mode ? `worth a look — ${diagnosis.mode}` : 'hasn’t moved in a while'}
        </button>
      )}
      {diagnosis?.stalled && diagOpen && (
        <div className="cc-diag">
          <div className="cc-diag-why">{diagnosis.why}</div>
          {diagnosis.wouldSettle?.length > 0 && (
            <div className="cc-diag-settle">
              <div className="cc-diag-settle-label">what would settle it:</div>
              {diagnosis.wouldSettle.map((s, i) => <div key={i} className="cc-diag-settle-row">→ {s}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

window.CubeCompass = React.memo(CubeCompass);

})();
