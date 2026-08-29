/* waiting-view.jsx — everything this workspace is stuck behind.
 *
 * The board tells you what is in each column. It cannot tell you that the
 * records request you filed seven weeks ago is holding up three pieces of
 * work, because that fact lives in the edges between things and the board
 * only draws the things. This is the view for the edges.
 *
 * Two rules it keeps, both from src/waiting.js:
 *
 * Nothing is late by the calendar. A wait is flagged when it has run
 * longer than every wait this workspace has actually finished, and the
 * odds of that happening anyway are printed next to the flag rather than
 * hidden behind it. Until two waits have finished, the view says it cannot
 * tell yet, which is duller and true.
 *
 * Every row can be acted on where it is read. "It arrived" moves the thing
 * you were waiting on to the last stage its type declares — the same move
 * the board would make, so the two never disagree. "Not actually blocked"
 * withdraws the link. Where a type declares no stages there is no honest
 * way to record an arrival, so that button is absent and the row says why.
 */

(function () {
const { useMemo, useState } = React;

const W = () => window.Waiting;
const PP = () => window.PlainPosition;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function humanSpan(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < DAY) return `${Math.max(1, Math.round(ms / HOUR))} hours`;
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? '' : 's'}`;
}

function odds(p) {
  if (!p) return '';
  return `about 1 in ${Math.round(1 / p)}`;
}

// ── one row ──────────────────────────────────────────────────────────────

function WaitRow({ row, state, onEmit, setSelection, busy, setBusy }) {
  const ME = window.MatrixEngine;
  const [confirmDrop, setConfirmDrop] = useState(false);
  const mine = busy === row.anchor;

  async function arrived() {
    if (busy || !row.terminal) return;
    setBusy(row.anchor);
    try { await onEmit(ME.OP.SEG, { anchor: row.anchor, partition: row.terminal }); }
    finally { setBusy(null); }
  }

  async function drop() {
    if (busy) return;
    setBusy(row.anchor);
    try {
      // One withdrawal per edge — several pieces of work can be stuck
      // behind the same thing, and each of those links is its own event.
      for (const e of row.edges) {
        await onEmit(ME.OP.CON, {
          source_anchor: e.edge.source,
          target_anchor: e.edge.target,
          relation_type: e.edge.type,
          retracts: e.edge._eventId,
        });
      }
      setConfirmDrop(false);
    } finally { setBusy(null); }
  }

  const holds = row.liveDependents.length;

  // One line, not a stack. Four things can be true of a row at once and a
  // status that lists all of them is a nag rather than a status — the same
  // rule src/plain-position.js keeps for a card. Ordered by what the reader
  // would act on first: a wait holding up nothing should go away whatever
  // its age, and a type with no stages cannot record an arrival at all, so
  // both of those outrank "this is taking a while". The ⚠ on the age is
  // still there when a row is running long, so nothing is hidden.
  const verdict =
    row.blocksNothingLive
      ? { soft: true, text: 'everything this was holding up is already finished — either the link was wrong or the wait is over' }
    : !row.terminal
      ? { soft: true, text: `“${row.entity?._type || 'this'}” declares no stages, so nothing here can be marked arrived — add stages on its schema, or drop the link` }
    : row.stalled
      ? { soft: false, text: `longer than any of the ${row.longerThan} waits this workspace has finished${row.oddsIfNothingChanged ? ` — ${odds(row.oddsIfNothingChanged)} if nothing has actually changed` : ''}` }
    : row.nudgeDue
      ? { soft: true, text: 'past the point half your waits had been answered by' }
    : null;

  return (
    <div className={`wv-row ${row.stalled ? 'stalled' : row.nudgeDue ? 'nudge' : ''}`}>
      <div className="wv-age" title={row.startedAt ? new Date(row.startedAt).toLocaleString() : ''}>
        {row.stalled ? <span className="wv-warn">⚠</span> : null}
        {humanAge(row.age)}
      </div>

      <div className="wv-main">
        <button
          className="wv-title"
          onClick={() => row.entity && setSelection && setSelection({
            kind: 'slice', sliceId: `${row.entity._type}.timeline.${row.anchor}`,
            sliceKind: 'timeline', tableId: row.entity._type, entityAnchor: row.anchor,
          })}
          disabled={row.missing}
        >
          {row.title}
        </button>

        <div className="wv-holds">
          {holds === 0
            ? <span className="wv-dead">holds up nothing that is still open</span>
            : <>holds up {holds} thing{holds === 1 ? '' : 's'}</>}
          {row.liveDependents.length > 0 && (
            <span className="wv-dependents">
              {row.liveDependents.slice(0, 3).map(d => (
                <button
                  key={d._anchor}
                  className="wv-dep"
                  onClick={() => setSelection && setSelection({
                    kind: 'slice', sliceId: `${d._type}.timeline.${d._anchor}`,
                    sliceKind: 'timeline', tableId: d._type, entityAnchor: d._anchor,
                  })}
                >{PP().titleOf(d)}</button>
              ))}
              {row.liveDependents.length > 3 && <span className="wv-more">+{row.liveDependents.length - 3}</span>}
            </span>
          )}
        </div>

        {verdict && <div className={`wv-verdict ${verdict.soft ? 'soft' : ''}`}>{verdict.text}</div>}
      </div>

      <div className="wv-actions">
        {row.terminal && (
          <button className="wv-act" disabled={!!busy} onClick={arrived}>
            {mine ? '…' : 'it arrived'}
          </button>
        )}
        {confirmDrop ? (
          <>
            <button className="wv-act danger" disabled={!!busy} onClick={drop}>drop {row.edges.length} link{row.edges.length === 1 ? '' : 's'}</button>
            <button className="wv-act ghost" onClick={() => setConfirmDrop(false)}>keep</button>
          </>
        ) : (
          <button className="wv-act ghost" disabled={!!busy} onClick={() => setConfirmDrop(true)}>
            not actually blocked
          </button>
        )}
      </div>
    </div>
  );
}

// ── the view ─────────────────────────────────────────────────────────────

function WaitingView({ room, state, onEmit, scrubber, setSelection, allEventsInRoom }) {
  const [busy, setBusy] = useState(null);

  // Every hook runs before the no-room bail-out: `room` goes from null to
  // set on the first sync, and a hook called on one render and not the
  // next is the classic way to blow up a view on load.
  const now = Date.now();
  const { rows, rhythm } = useMemo(
    () => (room ? W().waitingRows(state, { events: allEventsInRoom, now }) : { rows: [], rhythm: { measured: false, finished: 0 } }),
    [room, state, allEventsInRoom],
  );
  const freed = useMemo(
    () => (room ? W().unblockedSince(state, 0, { events: allEventsInRoom, now, onlyUntouched: true }) : []),
    [room, state, allEventsInRoom],
  );

  if (!room) return <div className="tv-empty">select a room</div>;

  const heldUp = new Set();
  for (const r of rows) for (const d of r.liveDependents) heldUp.add(d._anchor);
  const flagged = rows.filter(r => r.stalled).length;

  return (
    <div className="table-view waiting-view">
      {scrubber}
      <div className="tv-body single">
        <div className="wv-wrap">

          {freed.length > 0 && (
            <section className="wv-freed">
              <h2 className="wv-h">Free to start</h2>
              <p className="wv-sub">
                nothing is holding {freed.length === 1 ? 'this' : 'these'} up any more, and {freed.length === 1 ? 'it has' : 'they have'} not been touched since
              </p>
              {freed.map(f => (
                <div className="wv-freed-row" key={f.anchor}>
                  <button
                    className="wv-title"
                    onClick={() => setSelection && setSelection({
                      kind: 'slice', sliceId: `${f.entity._type}.timeline.${f.anchor}`,
                      sliceKind: 'timeline', tableId: f.entity._type, entityAnchor: f.anchor,
                    })}
                  >{f.title}</button>
                  <span className="wv-freed-why">
                    {f.withdrawn ? 'the link was dropped' : <>was waiting on <b>{f.by}</b></>}
                    {' · '}{humanAge(now - f.freedAt)} ago
                  </span>
                </div>
              ))}
            </section>
          )}

          <section className="wv-list">
            <h2 className="wv-h">Waiting</h2>
            {rows.length === 0 ? (
              <p className="wv-empty">
                Nothing here is waiting on anything else. Links of the kind this reads —
                “needs”, “blocked by”, “waiting on”, “blocks” — are drawn on a card’s status
                line or in the graph view.
              </p>
            ) : (
              <>
                <div className="wv-head">
                  <span className="wv-age">age</span>
                  <span className="wv-main">waiting on</span>
                  <span className="wv-actions"></span>
                </div>
                {rows.map(r => (
                  <WaitRow
                    key={r.anchor} row={r} state={state} onEmit={onEmit}
                    setSelection={setSelection} busy={busy} setBusy={setBusy}
                  />
                ))}
              </>
            )}
          </section>

          {rows.length > 0 && (
            <footer className="wv-foot">
              <div>
                {rows.length} waiting · {heldUp.size} thing{heldUp.size === 1 ? '' : 's'} held up
                {flagged > 0 && <> · {flagged} running long</>}
              </div>
              <div className="wv-bar">
                {rhythm.measured
                  ? (rhythm.median === rhythm.max
                      // With only a couple of finished waits the halfway point and
                      // the longest are the same number, and saying it twice reads
                      // as though the second were extra evidence.
                      ? <>Judged against this workspace’s own record: {rhythm.finished} waits have finished
                          here and the longest took {humanSpan(rhythm.max)}. Too few yet to warn earlier than
                          that — the halfway point and the longest are still the same wait.</>
                      : <>Judged against this workspace’s own record: {rhythm.finished} waits have finished here,
                          the longest took {humanSpan(rhythm.max)}, and half were answered
                          within {humanSpan(rhythm.median)}.</>)
                  : <>Only {rhythm.finished} wait{rhythm.finished === 1 ? ' has' : 's have'} finished here so far —
                      too few to say what long looks like, so nothing is being called late.</>}
              </div>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

window.WaitingView = WaitingView;
})();
