/* subscribe-button.jsx — "watch this" toggle for any entity, with an
 * optional "also email me" address that turns future changes into a
 * real email via the shared n8n webhook (src/emailWebhook.js).
 *
 * A subscription is its own tiny entity, not a field on the thing being
 * watched and not a raw CON toggle — CON is append-only with no
 * supersession rule, so on/off state needs something SEG can carry. One
 * subscription entity per (owner, watched anchor): INS mints it, a single
 * CON 'watches' edge points at what it's watching, its SEG partition
 * ('active' | 'inactive') is the on/off switch — the same partition-toggle
 * pattern already used everywhere else in this app for archive/trash —
 * and an optional DEF 'notify_email' is where an address lives if they
 * added one. Ownership is read off _sender (the real, verified Matrix
 * sender of the INS event), not a second CON edge to a person entity —
 * there isn't one in this app, and _sender already is a durable,
 * unforgeable identity.
 *
 * Deliberately not registered in _schema.tables: a subscription is
 * plumbing, not a table anyone browses, so it gets no generic grid/kanban
 * view of its own. This button, entity-timeline.jsx's per-anchor history
 * (free — it already matches on c.source/c.target), and the "watching"
 * list are the whole surface.
 *
 * Email dispatch (notifySubscribers, below) is deliberately client-
 * triggered, not server-pushed — there is no server. It's called from
 * app.jsx's central onEmit right after a DEF/SEG/EVA on a watched anchor
 * lands, so the person who JUST made the change (who is, by definition,
 * online right now) is the one whose client fires the notification to
 * everyone else watching. Best-effort: a failed send is swallowed (with
 * a console warning) rather than surfaced, since nobody is looking at a
 * dialog for an email that was going to someone else anyway.
 */
(function () {
const { useState, useMemo, useEffect } = React;

const LAST_EMAIL_KEY = 'eopm_last_notify_email';

function findMySubscription(state, watchedAnchor, myUserId) {
  if (!myUserId) return null;
  for (const c of state.connections) {
    if (c.type !== 'watches' || c.target !== watchedAnchor) continue;
    const sub = state.entities[c.source];
    if (sub && sub._type === 'subscription' && sub._sender === myUserId) return sub;
  }
  return null;
}

function isActive(sub, state) {
  return !!sub && state.partitions[sub._anchor] === 'active';
}

/** Every active subscription watching one anchor (any owner). */
function subscriptionsFor(state, watchedAnchor) {
  const out = [];
  for (const c of state.connections) {
    if (c.type !== 'watches' || c.target !== watchedAnchor) continue;
    const sub = state.entities[c.source];
    if (sub && sub._type === 'subscription' && state.partitions[sub._anchor] === 'active') out.push(sub);
  }
  return out;
}

/** Every entity a given user is actively watching, most recently touched first. */
function entitiesIWatch(state, myUserId) {
  if (!myUserId) return [];
  const out = [];
  for (const c of state.connections) {
    if (c.type !== 'watches') continue;
    const sub = state.entities[c.source];
    if (!sub || sub._type !== 'subscription' || sub._sender !== myUserId) continue;
    if (state.partitions[sub._anchor] !== 'active') continue;
    const watched = state.entities[c.target];
    if (watched) out.push(watched);
  }
  return out.sort((a, b) => (b._updated || b._created || 0) - (a._updated || a._created || 0));
}

function displayName(e) {
  if (!e) return '(deleted)';
  return e.Title || e.Name || e.title || e.body || e.claim || e.what || e._anchor;
}

// Only these operators represent "something changed" worth an email —
// DEF is the workhorse for everything from a title edit to a priority
// change, SEG is a column/status move, EVA is a recorded judgment. INS/
// CON/SYN/REC don't carry a meaningful single-anchor "this changed".
const NOTIFIABLE_OPS = new Set(['def', 'seg', 'eva']);

// In-memory per (anchor, subscriber) cooldown so a burst of edits (e.g.
// dragging a card, then immediately editing its title) sends one email,
// not one per keystroke. Resets on reload — acceptable for a best-effort
// notification, not a durable delivery guarantee.
const lastNotified = new Map();
const COOLDOWN_MS = 2 * 60 * 1000;

function changeSummary(opKey, content) {
  if (opKey === 'seg') return `moved to "${content.partition}"`;
  if (opKey === 'eva') return `${content.criterion} → ${content.result}${content.note ? ` (${content.note})` : ''}`;
  if (opKey === 'def') {
    if (content.path && content.path.startsWith('_schema.')) return null; // schema edits aren't per-item news
    return `${content.path} updated`;
  }
  return 'updated';
}

/**
 * Call from the central emit path right after a DEF/SEG/EVA lands.
 * state must be the FOLD STATE AFTER this event (so subscriptions and
 * the entity's current name are current). Fire-and-forget; never throws.
 */
async function notifySubscribers({ state, op, content, sender, roomTitle, joinUrl, sendEmail }) {
  const opKey = op && op.key;
  if (!NOTIFIABLE_OPS.has(opKey)) return;
  const anchor = content && content.anchor;
  if (!anchor) return;
  const summary = changeSummary(opKey, content);
  if (!summary) return;

  const subs = subscriptionsFor(state, anchor).filter(s => s._sender !== sender && s.notify_email);
  if (subs.length === 0) return;

  const entity = state.entities[anchor];
  const name = displayName(entity);
  const now = Date.now();

  for (const sub of subs) {
    const key = anchor + '|' + sub._sender;
    const last = lastNotified.get(key) || 0;
    if (now - last < COOLDOWN_MS) continue;
    lastNotified.set(key, now);

    sendEmail({
      to: sub.notify_email,
      subject: `${name} — ${summary}`,
      html: `<p><b>${name}</b> ${summary}${roomTitle ? ` in <b>${roomTitle}</b>` : ''}.</p>` +
            (joinUrl ? `<p><a href="${joinUrl}">Open it</a></p>` : '') +
            `<p style="color:#888;font-size:12px">You're watching this. Unsubscribe any time from its page.</p>`,
    }).catch(e => console.warn('[subscribe] notify email failed:', e?.message || e));
  }
}

function SubscribeButton({ state, entityAnchor, onEmit, myUserId, size, showLabel }) {
  const ME = window.MatrixEngine;
  const sub = useMemo(
    () => findMySubscription(state, entityAnchor, myUserId),
    [state.connections, state.entities, entityAnchor, myUserId]
  );
  const on = isActive(sub, state);
  const [showEmailField, setShowEmailField] = useState(false);
  const [emailDraft, setEmailDraft] = useState(() => { try { return localStorage.getItem(LAST_EMAIL_KEY) || ''; } catch { return ''; } });
  const [savingEmail, setSavingEmail] = useState(false);

  useEffect(() => { if (!on) setShowEmailField(false); }, [on]);

  async function toggle(e) {
    if (e) e.stopPropagation();
    const sender = myUserId || '@you:demo';
    if (sub) {
      const next = on ? 'inactive' : 'active';
      await onEmit(ME.OP.SEG, { anchor: sub._anchor, partition: next });
      if (next === 'active' && !sub.notify_email) setShowEmailField(true);
      return;
    }
    const anchor = ME.makeAnchor('subscription', {}, sender, Date.now());
    await onEmit(ME.OP.INS, { anchor, entity_type: 'subscription', payload: {} });
    await onEmit(ME.OP.SEG, { anchor, partition: 'active' });
    await onEmit(ME.OP.CON, { source_anchor: anchor, target_anchor: entityAnchor, relation_type: 'watches' });
    setShowEmailField(true);
  }

  async function saveEmail(e) {
    if (e) e.stopPropagation();
    const value = emailDraft.trim();
    if (!value || !sub || savingEmail) { setShowEmailField(false); return; }
    setSavingEmail(true);
    try {
      await onEmit(ME.OP.DEF, { anchor: sub._anchor, path: 'notify_email', value });
      try { localStorage.setItem(LAST_EMAIL_KEY, value); } catch {}
    } finally {
      setSavingEmail(false);
      setShowEmailField(false);
    }
  }

  const fontSize = size || 13;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
      <button
        onClick={toggle}
        title={on ? "stop watching — you won't be called out to this anymore" : 'watch this — see it under "my subscriptions" and optionally get emailed when it changes'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
          color: on ? 'var(--blue, #3b6ea5)' : 'var(--text-faint)', fontSize,
          display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
        }}
      >
        <i className={`ph ${on ? 'ph-bell-ringing' : 'ph-bell'}`} aria-hidden="true"></i>
        {showLabel && <span style={{ fontSize: fontSize - 2 }}>{on ? 'watching' : 'watch'}</span>}
        {on && sub?.notify_email && <i className="ph ph-envelope-simple" style={{ fontSize: fontSize - 3, color: 'var(--green)' }} title={`emailing ${sub.notify_email}`} aria-hidden="true"></i>}
      </button>
      {showEmailField && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, zIndex: 40, marginTop: 4,
          background: 'var(--surface)', border: '1px solid var(--border-strong)', padding: 8,
          display: 'flex', flexDirection: 'column', gap: 6,
          width: 180, maxWidth: 'min(180px, 85vw)', boxShadow: '0 4px 14px rgba(0,0,0,.16)',
        }}>
          <input
            autoFocus type="email" value={emailDraft} onChange={e => setEmailDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveEmail(e); if (e.key === 'Escape') setShowEmailField(false); }}
            placeholder="email me changes"
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 11.5, padding: '4px 6px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={saveEmail} disabled={savingEmail} style={{ flex: 1, fontSize: 11, padding: '4px 0', border: '1px solid var(--border-strong)', background: 'var(--text)', color: 'var(--surface)', cursor: 'pointer' }}>
              {savingEmail ? '…' : 'set'}
            </button>
            <button onClick={() => setShowEmailField(false)} style={{ fontSize: 11, padding: '4px 8px', border: '1px solid var(--border-strong)', background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer' }}>
              skip
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function WatchingView({ state, myUserId, setSelection, scrubber }) {
  const watched = useMemo(() => entitiesIWatch(state, myUserId), [state, myUserId]);

  function jumpTo(e) {
    setSelection({ kind: 'slice', sliceId: `${e._type}.timeline.${e._anchor}`, sliceKind: 'timeline', tableId: e._type, entityAnchor: e._anchor });
  }

  return (
    <div className="table-view">
      {scrubber}
      <div className="tv-body single schema-body">
        <header className="page-hero entity-hero">
          <div className="page-hero-eyebrow">
            <span className="page-hero-kind"><span className="page-hero-glyph"><i className="ph ph-bell-ringing" aria-hidden="true"></i></span> watching</span>
          </div>
          <h1 className="page-hero-title">my subscriptions</h1>
          <div className="page-hero-sub">{watched.length} thing{watched.length !== 1 ? 's' : ''} you're watching · click one to jump to its history</div>
        </header>
        <section className="page-section">
          {watched.length === 0 ? (
            <div className="tv-empty">
              <div className="glyph"><i className="ph ph-bell" aria-hidden="true"></i></div>
              <div>nothing yet — click the bell on any card or record to watch it here.</div>
            </div>
          ) : (
            <div className="tl-picker">
              {watched.map(e => (
                <button key={e._anchor} className="tl-picker-row" onClick={() => jumpTo(e)}>
                  <span className="tl-picker-name">{displayName(e)}</span>
                  <span className="tl-picker-anchor">{e._type} · {e._anchor}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

window.SubscribeButton = SubscribeButton;
window.WatchingView = WatchingView;
window.findMySubscription = findMySubscription;
window.entitiesIWatch = entitiesIWatch;
window.notifySubscribers = notifySubscribers;

})();
