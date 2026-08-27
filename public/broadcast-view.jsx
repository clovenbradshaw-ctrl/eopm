/* broadcast-view.jsx — compose one update, send it to several people at
 * once as individual emails (not one thread CC'ing everyone — recipients
 * never see each other's addresses).
 *
 * Recipients are room members (src/rooms.js's getMembers, exposed as
 * window.MatrixLive.membersOf) cross-referenced against people.jsx's
 * mxid -> email directory. A member with no email on file can't be
 * selected until one is added inline, right there in the row — which
 * also registers it in the directory for next time.
 *
 * Every send leaves an audit trail: one 'broadcast' entity (subject +
 * body) and a CON 'sent_to' edge to each recipient who actually got it,
 * so entity-timeline.jsx shows "who got this" for the broadcast and
 * "what updates did I get" for each person, for free.
 */
(function () {
const { useState, useEffect, useMemo } = React;

const fieldStyle = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', padding: '7px 9px', fontSize: 12.5, fontFamily: 'var(--mono)', outline: 'none' };
const btnStyle = (primary) => ({
  fontSize: 12, padding: '6px 12px', border: '1px solid var(--border-strong)', cursor: 'pointer',
  background: primary ? 'var(--text)' : 'transparent', color: primary ? 'var(--surface)' : 'var(--text)',
  display: 'inline-flex', alignItems: 'center', gap: 6,
});
function Spinner() {
  return <span style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', verticalAlign: '-2px' }} />;
}

function BroadcastPanel({ roomId, roomTitle, session, state, onEmit, onClose }) {
  const ML = window.MatrixLive;
  const [members, setMembers] = useState(null); // null = still loading
  const [selected, setSelected] = useState(() => new Set());
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null); // { sent: [mxid], failed: [{mxid, error}] }
  const [emailDrafts, setEmailDrafts] = useState({});
  const [savingFor, setSavingFor] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await ML.loadMembers(roomId); } catch (e) {}
      if (alive) setMembers(ML.membersOf(roomId));
    })();
    return () => { alive = false; };
  }, [roomId]);

  const rows = useMemo(() => (members || [])
    .filter(m => m.userId !== session?.mxid)
    .map(m => ({ ...m, email: window.PeopleDirectory?.emailFor(state, m.userId) || null })),
  [members, state, session]);

  function toggle(mxid) {
    setSelected(s => { const n = new Set(s); if (n.has(mxid)) n.delete(mxid); else n.add(mxid); return n; });
  }

  async function saveEmailFor(mxid, displayName) {
    const value = (emailDrafts[mxid] || '').trim();
    if (!value || !window.PeopleDirectory) return;
    setSavingFor(mxid);
    try {
      await window.PeopleDirectory.setPersonEmail(onEmit, window.MatrixEngine, state, mxid, value, displayName);
      setSelected(s => new Set(s).add(mxid));
    } finally {
      setSavingFor(null);
      setEmailDrafts(d => ({ ...d, [mxid]: '' }));
    }
  }

  async function send() {
    if (busy || selected.size === 0 || !subject.trim()) return;
    setBusy(true); setResults(null);
    const sent = [], failed = [];
    const html = body.split('\n').map(l => `<p>${l || '&nbsp;'}</p>`).join('') +
      `<p style="color:#888;font-size:12px">Sent from ${roomTitle || 'a project'}${session?.mxid ? ` by ${session.mxid}` : ''}.</p>`;
    for (const mxid of selected) {
      const row = rows.find(r => r.userId === mxid);
      if (!row?.email) { failed.push({ mxid, error: 'no email on file' }); continue; }
      try {
        await ML.sendEmail({ to: row.email, subject: subject.trim(), html });
        sent.push(mxid);
      } catch (e) { failed.push({ mxid, error: e?.message || 'send failed' }); }
    }
    if (sent.length > 0 && window.PeopleDirectory) {
      try {
        const ME = window.MatrixEngine;
        const anchor = ME.makeAnchor('broadcast', { subject: subject.trim() }, session?.mxid || '@you:demo', Date.now());
        await onEmit(ME.OP.INS, { anchor, entity_type: 'broadcast', payload: { subject: subject.trim(), body } });
        for (const mxid of sent) {
          await onEmit(ME.OP.CON, { source_anchor: anchor, target_anchor: window.PeopleDirectory.personAnchorFor(mxid), relation_type: 'sent_to' });
        }
      } catch (e) { /* sends already happened; a logging hiccup shouldn't read as a send failure */ }
    }
    setResults({ sent, failed });
    setBusy(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ width: 'min(480px, 100%)', maxHeight: '85vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border-strong)', boxShadow: '0 8px 30px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Send an update — {roomTitle || 'this project'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-faint)' }}>
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>

        <div style={{ padding: 14 }}>
          {results ? (
            <div>
              {results.sent.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--green)', marginBottom: 6 }}>
                  <i className="ph ph-check" aria-hidden="true"></i> sent to {results.sent.length} {results.sent.length === 1 ? 'person' : 'people'}
                </div>
              )}
              {results.failed.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--red)', lineHeight: 1.5 }}>
                  couldn't reach: {results.failed.map(f => `${f.mxid} (${f.error})`).join(', ')}
                </div>
              )}
              <button style={{ ...btnStyle(false), marginTop: 12 }} onClick={() => { setResults(null); setSelected(new Set()); setSubject(''); setBody(''); }}>send another</button>
            </div>
          ) : (
            <>
              <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>recipients</label>
              <div style={{ border: '1px solid var(--border)', maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
                {members === null && <div style={{ padding: 10, fontSize: 11.5, color: 'var(--text-faint)' }}>loading members…</div>}
                {members !== null && rows.length === 0 && <div style={{ padding: 10, fontSize: 11.5, color: 'var(--text-faint)' }}>no other members yet.</div>}
                {rows.map(r => (
                  <div key={r.userId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--border)' }}>
                    <input type="checkbox" checked={selected.has(r.userId)} disabled={!r.email} onChange={() => toggle(r.userId)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{r.displayName}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{r.userId}</div>
                    </div>
                    {r.email ? (
                      <span style={{ fontSize: 10.5, color: 'var(--green)' }}>{r.email}</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          value={emailDrafts[r.userId] || ''} onChange={e => setEmailDrafts(d => ({ ...d, [r.userId]: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && saveEmailFor(r.userId, r.displayName)}
                          placeholder="add email" style={{ width: 110, fontSize: 10.5, padding: '3px 5px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)' }}
                        />
                        <button onClick={() => saveEmailFor(r.userId, r.displayName)} disabled={savingFor === r.userId} style={{ fontSize: 10, padding: '3px 6px', border: '1px solid var(--border-strong)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
                          {savingFor === r.userId ? '…' : 'set'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>subject</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Sprint update" style={{ ...fieldStyle, marginBottom: 8 }} />
              <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>message</label>
              <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="What's changed, what's next…"
                style={{ ...fieldStyle, resize: 'vertical', marginBottom: 10, fontFamily: 'inherit' }} />

              <button style={btnStyle(true)} disabled={busy || selected.size === 0 || !subject.trim()} onClick={send}>
                {busy ? <Spinner /> : <i className="ph ph-paper-plane-tilt" aria-hidden="true"></i>}
                {busy ? 'sending…' : `send to ${selected.size || ''} ${selected.size === 1 ? 'person' : 'people'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

window.BroadcastPanel = BroadcastPanel;

})();
