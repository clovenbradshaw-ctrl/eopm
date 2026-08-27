/* invite-view.jsx — share access to a project via a link.
 *
 * Two halves of one flow, mirrored from the pattern proven in NPJ's
 * app/admin/Invite.jsx + app/identity/matrix-auth.js, adapted onto this
 * app's own crypto-safe client (src/client.js) instead of a raw-fetch
 * client — a guest's session has to go through the SAME login() path
 * every other user does, or their device never gets Megolm crypto and
 * they can't read or write anything in an encrypted room.
 *
 *   InvitePanel  — the member-side widget. Two tabs:
 *     "new guest"      mints a fresh account (register(), never touches
 *                       the inviter's own session), invites it into the
 *                       room, sets its power level, hands back one link
 *                       carrying a one-time password (#welcome=…).
 *     "existing member" invites a real mxid the ordinary Matrix way and
 *                       hands back a plain deep link with no secret in it
 *                       (#join=…) — for someone who already has an
 *                       account and just needs a way back into THIS room.
 *
 *   WelcomeInvite — what a #welcome= link opens. Logs the guest in with
 *     the temp password, joins them into the room, lets them pick a
 *     name and set their own password. A second visit (temp password
 *     already spent) falls back to a plain sign-in with the password
 *     they chose — so the same link doubles as "get back in".
 *
 * Roles: "editor" is the room's default power level (0) — no override
 * needed. "viewer" is a negative power level, which the homeserver
 * itself enforces (every operator event requires PL >= 0 to send) —
 * not a client-side convention that a modified client could ignore.
 */
(function () {
const { useState, useEffect, useRef } = React;

const ROLE_PL = { viewer: -1, editor: 0 };
const DEFAULT_HOMESERVER = 'hyphae.social';

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

function Spinner({ size }) {
  const s = size || 12;
  return <span style={{ width: s, height: s, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', verticalAlign: '-2px' }} />;
}

const fieldStyle = { width: '100%', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', padding: '7px 9px', fontSize: 12.5, fontFamily: 'var(--mono)', outline: 'none', boxSizing: 'border-box' };
const btnStyle = (primary) => ({
  fontSize: 12, padding: '6px 12px', border: '1px solid var(--border-strong)', cursor: 'pointer',
  background: primary ? 'var(--text)' : 'transparent', color: primary ? 'var(--surface)' : 'var(--text)',
  display: 'inline-flex', alignItems: 'center', gap: 6,
});

function RolePicker({ role, setRole }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
      {[['editor', 'Editor', 'Full access — can create and change anything in this project.'],
        ['viewer', 'Viewer', "Read-only — the homeserver itself rejects their writes, not just the UI."]].map(([val, label, desc]) => (
        <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: 'pointer', border: '1px solid ' + (role === val ? 'var(--border-strong)' : 'var(--border)'), background: role === val ? 'var(--surface-2, transparent)' : 'transparent', padding: '6px 8px' }}>
          <input type="radio" name="invite-role" checked={role === val} onChange={() => setRole(val)} style={{ marginTop: 3, flex: '0 0 auto' }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 12.5, display: 'block' }}>{label}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.4 }}>{desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function LinkOut({ url, note }) {
  const [copied, setCopied] = useState(false);
  const doCopy = async () => { if (await copyText(url)) { setCopied(true); setTimeout(() => setCopied(false), 1600); } };
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input readOnly value={url} onFocus={e => e.target.select()} style={{ ...fieldStyle, flex: 1, minWidth: 0 }} />
        <button style={btnStyle(true)} onClick={doCopy}>
          <i className={`ph ph-${copied ? 'check' : 'copy'}`} aria-hidden="true"></i>{copied ? 'copied' : 'copy'}
        </button>
      </div>
      {note && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.4 }}>{note}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// InvitePanel — the member-side widget
// ─────────────────────────────────────────────────────────────────────────

function NewGuestTab({ roomId, roomTitle, session }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('editor');
  const [homeserver, setHomeserver] = useState(DEFAULT_HOMESERVER);
  const [token, setToken] = useState('');
  const [needToken, setNeedToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState(null);
  const ML = window.MatrixLive;

  async function create() {
    const who = name.trim();
    if (busy) return;
    if (!who) { setErr("Add a name so everyone knows who this is."); return; }
    setBusy(true); setErr(''); setLink(null);
    try {
      const acct = await ML.register(homeserver.trim(), { seed: who, registrationToken: token.trim() || undefined });
      try { await ML.inviteUser(roomId, acct.mxid); } catch (e) { /* best-effort; the link still works once they land */ }
      if (ROLE_PL[role] < 0) { try { await ML.setUserPowerLevel(roomId, acct.mxid, ROLE_PL[role]); } catch (e) {} }
      const url = ML.buildInviteLink({ v: 1, hs: acct.domain, u: acct.localpart, p: acct.password, r: roomId, rt: roomTitle, n: who, role, by: session?.mxid });
      setLink({ url, mxid: acct.mxid, name: who }); setNeedToken(false);
    } catch (e) {
      if (e && e.code === 'uia' && /registration token/i.test(e.message || '')) { setNeedToken(true); setErr(e.message); }
      else setErr((e && e.message) || "Couldn't create that account.");
    }
    setBusy(false);
  }

  if (link) return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--green)', marginBottom: 8, lineHeight: 1.4 }}>
        Account created for <b>{link.name}</b> (<code>{link.mxid}</code>) · invited as {role}. Send them this link:
      </div>
      <LinkOut url={link.url} note="Carries a one-time password — it stops working once they set their own. Share it privately." />
      <button style={{ ...btnStyle(false), marginTop: 10 }} onClick={() => setLink(null)}>invite another</button>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.45 }}>
        Mints a real account on <b>{homeserver || 'a homeserver'}</b> and gives you one link.
        They click it, confirm their name, and set a password — no sign-up.
      </div>
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>who's this for?</label>
      <input value={name} onChange={e => { setName(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && create()}
        placeholder="e.g. Sam Rivera" style={{ ...fieldStyle, marginBottom: 8 }} />
      <RolePicker role={role} setRole={setRole} />
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>homeserver</label>
      <input value={homeserver} onChange={e => setHomeserver(e.target.value)} placeholder="hyphae.social" style={{ ...fieldStyle, marginBottom: 8 }} />
      {needToken && (
        <input value={token} onChange={e => setToken(e.target.value)} placeholder="registration token" style={{ ...fieldStyle, marginBottom: 8 }} />
      )}
      <button style={btnStyle(true)} disabled={busy} onClick={create}>
        {busy ? <Spinner /> : <i className="ph ph-link" aria-hidden="true"></i>}{busy ? 'creating…' : 'create invite link'}
      </button>
      {err && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8, lineHeight: 1.4 }}>{err}</div>}
    </div>
  );
}

function ExistingMemberTab({ roomId, roomTitle }) {
  const [mxid, setMxid] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState(null);
  const ML = window.MatrixLive;

  async function send() {
    const id = mxid.trim();
    if (busy) return;
    if (!/^@[^:\s]+:[^\s]+$/.test(id)) { setErr('Needs a full Matrix ID, like @name:server'); return; }
    setBusy(true); setErr(''); setLink(null);
    try {
      await ML.inviteUser(roomId, id);
      if (ROLE_PL[role] < 0) { try { await ML.setUserPowerLevel(roomId, id, ROLE_PL[role]); } catch (e) {} }
      const url = ML.buildJoinLink({ r: roomId, rt: roomTitle });
      setLink({ url, mxid: id });
    } catch (e) { setErr((e && e.message) || "Couldn't send that invite."); }
    setBusy(false);
  }

  if (link) return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--green)', marginBottom: 8, lineHeight: 1.4 }}>
        Invited <b>{link.mxid}</b> as {role}. This link drops them straight into the project once they sign in:
      </div>
      <LinkOut url={link.url} note="No password in this one — safe to share more casually. They sign in with their own account." />
      <button style={{ ...btnStyle(false), marginTop: 10 }} onClick={() => setLink(null)}>invite another</button>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.45 }}>
        For someone who already has a Matrix account. Sends a real room invite and gives you a link straight back to this project.
      </div>
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>their matrix id</label>
      <input value={mxid} onChange={e => { setMxid(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && send()}
        placeholder="@name:hyphae.social" style={{ ...fieldStyle, marginBottom: 8 }} />
      <RolePicker role={role} setRole={setRole} />
      <button style={btnStyle(true)} disabled={busy} onClick={send}>
        {busy ? <Spinner /> : <i className="ph ph-paper-plane-tilt" aria-hidden="true"></i>}{busy ? 'sending…' : 'send invite'}
      </button>
      {err && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8, lineHeight: 1.4 }}>{err}</div>}
    </div>
  );
}

function InvitePanel({ roomId, roomTitle, session, onClose }) {
  const [tab, setTab] = useState('new');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ width: 'min(420px, 100%)', background: 'var(--surface)', border: '1px solid var(--border-strong)', boxShadow: '0 8px 30px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Invite people to {roomTitle || 'this project'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-faint)' }}>
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
          <button onClick={() => setTab('new')} style={{ flex: 1, padding: '8px 0', fontSize: 11.5, border: 'none', borderBottom: '2px solid ' + (tab === 'new' ? 'var(--text)' : 'transparent'), background: 'none', cursor: 'pointer', color: tab === 'new' ? 'var(--text)' : 'var(--text-faint)' }}>new guest</button>
          <button onClick={() => setTab('existing')} style={{ flex: 1, padding: '8px 0', fontSize: 11.5, border: 'none', borderBottom: '2px solid ' + (tab === 'existing' ? 'var(--text)' : 'transparent'), background: 'none', cursor: 'pointer', color: tab === 'existing' ? 'var(--text)' : 'var(--text-faint)' }}>existing member</button>
        </div>
        <div style={{ padding: 14 }}>
          {tab === 'new'
            ? <NewGuestTab roomId={roomId} roomTitle={roomTitle} session={session} />
            : <ExistingMemberTab roomId={roomId} roomTitle={roomTitle} />}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// WelcomeInvite — the #welcome= link's landing page
// ─────────────────────────────────────────────────────────────────────────

function SecureAccountStep({ creds, onEnter }) {
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  const copy = async (label, value) => { if (await copyText(value)) { setCopied(label); setTimeout(() => setCopied(c => c === label ? '' : c), 1500); } };
  const row = (label, value, secret) => {
    const shown = secret && !reveal ? '•'.repeat(Math.min(16, String(value || '').length || 12)) : (value || '—');
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, wordBreak: 'break-all' }}>{shown}</span>
          {secret && <button onClick={() => setReveal(r => !r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)' }}><i className={`ph ph-${reveal ? 'eye-slash' : 'eye'}`} aria-hidden="true"></i></button>}
          <button onClick={() => copy(label, value)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === label ? 'var(--green)' : 'var(--text-faint)' }}><i className={`ph ph-${copied === label ? 'check' : 'copy'}`} aria-hidden="true"></i></button>
        </span>
      </div>
    );
  };
  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>you're a member now · last step</div>
      <h1 style={{ fontSize: 24, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>Save your password.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        Your account is real and it's yours — but there's no easy reset. The password you just set is the only key. Save it in a password manager (or somewhere safe) before you go in.
      </p>
      <div style={{ border: '1px solid var(--border-strong)', padding: '2px 10px', marginBottom: 14 }}>
        {row('name', creds.displayName, false)}
        {row('sign-in id', creds.mxid, false)}
        {row('password', creds.password, true)}
      </div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', marginBottom: 14, fontSize: 12.5 }}>
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} style={{ marginTop: 3 }} />
        I've saved my password somewhere safe — I understand it can't be reset for me.
      </label>
      <button style={{ ...btnStyle(true), width: '100%', justifyContent: 'center', opacity: saved ? 1 : .5, cursor: saved ? 'pointer' : 'not-allowed' }} disabled={!saved} onClick={onEnter}>
        enter the project<i className="ph ph-arrow-right" aria-hidden="true"></i>
      </button>
    </>
  );
}

function WelcomeInvite({ payload, onDone }) {
  const [phase, setPhase] = useState('signing'); // signing | returning | name | password | secure | finishing | error
  const [err, setErr] = useState('');
  const [name, setName] = useState(payload.n || '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [returnPw, setReturnPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState(null);
  const sessRef = useRef(null);
  const mxid = '@' + payload.u + ':' + payload.hs;
  const ML = window.MatrixLive;

  const landInProject = async () => { if (payload.r) { try { await ML.joinRoom(payload.r); } catch (e) {} } };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sess = await ML.login({ homeserver: payload.hs, username: mxid, password: payload.p, keepSignedIn: true });
        sessRef.current = sess;
        await landInProject();
        if (alive) setPhase('name');
      } catch (e) {
        if (!alive) return;
        // A dead temp password (already spent by an earlier visit) means
        // "you've been here before" — not a dead end.
        if (e && (e.errcode === 'M_FORBIDDEN' || e.status === 403 || /forbidden|invalid/i.test(e.message || ''))) setPhase('returning');
        else { setErr(e?.message || "We couldn't open this invite."); setPhase('error'); }
      }
    })();
    return () => { alive = false; };
  }, []);

  const saveName = async () => {
    if (busy) return;
    const n = name.trim(); if (!n) { setErr('Pick a name people will see.'); return; }
    setBusy(true); setErr('');
    try { await ML.setMyDisplayName(n); setPhase('password'); }
    catch (e) { setErr(e?.message || "Couldn't save that name."); }
    setBusy(false);
  };

  const savePassword = async () => {
    if (busy) return;
    if (pw.length < 8) { setErr('Use at least 8 characters.'); return; }
    if (pw !== pw2) { setErr("The two passwords don't match."); return; }
    setBusy(true); setErr('');
    try {
      await ML.changePassword(payload.p, pw, { logoutDevices: false });
      setCreds({ mxid, password: pw, displayName: name.trim() || payload.n || '' });
      setBusy(false); setPhase('secure');
    } catch (e) { setErr(e?.message || "Couldn't set your password."); setBusy(false); }
  };

  const enterProject = () => { setPhase('finishing'); onDone && onDone(sessRef.current, payload.r); };

  const returnSignIn = async () => {
    if (busy) return;
    if (!returnPw) { setErr('Enter your password.'); return; }
    setBusy(true); setErr('');
    try {
      const sess = await ML.login({ homeserver: payload.hs, username: mxid, password: returnPw, keepSignedIn: true });
      await landInProject();
      setPhase('finishing');
      onDone && onDone(sess, payload.r);
    } catch (e) { setErr(e?.message || "That password didn't match."); setBusy(false); }
  };

  const card = (children) => (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflowY: 'auto' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid var(--border-strong)', padding: '26px 24px 28px' }}>{children}</div>
    </div>
  );
  const errBox = err ? <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, lineHeight: 1.4 }}>{err}</div> : null;

  if (phase === 'signing') return card(
    <div style={{ textAlign: 'center', padding: '14px 0' }}>
      <Spinner size={22} />
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 14 }}>Opening your invite…</div>
    </div>
  );

  if (phase === 'returning') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>welcome back</div>
      <h1 style={{ fontSize: 24, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>Sign in to continue.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        You've set this account up already, so the link's one-time password is spent. Enter the password <b>you chose</b> to pick up where you left off.
      </p>
      <input autoFocus type="password" value={returnPw} onChange={e => { setReturnPw(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && returnSignIn()} style={fieldStyle} />
      {errBox}
      <button style={{ ...btnStyle(true), width: '100%', justifyContent: 'center', marginTop: 14 }} disabled={busy} onClick={returnSignIn}>
        {busy ? <Spinner /> : <i className="ph ph-lock-key" aria-hidden="true"></i>}{busy ? 'signing in…' : 'sign in'}
      </button>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 12 }}>{mxid}</div>
    </>
  );

  if (phase === 'error') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>something went wrong</div>
      <h1 style={{ fontSize: 22, margin: '0 0 10px', fontFamily: 'var(--mono)' }}>We couldn't open this.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 6px' }}>{err}</p>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)', margin: 0 }}>Ask whoever sent it for a fresh link.</p>
    </>
  );

  if (phase === 'secure') return card(<SecureAccountStep creds={creds} onEnter={enterProject} />);

  if (phase === 'finishing') return card(
    <div style={{ textAlign: 'center', padding: '14px 0' }}>
      <i className="ph ph-check-circle" style={{ fontSize: 30, color: 'var(--green)' }} aria-hidden="true"></i>
      <div style={{ fontSize: 18, margin: '10px 0 4px', fontFamily: 'var(--mono)' }}>You're all set.</div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Taking you in…</div>
    </div>
  );

  if (phase === 'name') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>welcome · step 1 of 2</div>
      <h1 style={{ fontSize: 26, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>What should we call you?</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        You've been invited{payload.rt ? <> to <b>{payload.rt}</b></> : ''}. This is your display name — you can change it later.
      </p>
      <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && saveName()}
        placeholder="e.g. Sam Rivera" style={fieldStyle} />
      {errBox}
      <button style={{ ...btnStyle(true), marginTop: 14 }} disabled={busy} onClick={saveName}>
        {busy ? <Spinner /> : <i className="ph ph-arrow-right" aria-hidden="true"></i>}{busy ? 'saving…' : 'continue'}
      </button>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 12 }}>signed in as {mxid}</div>
    </>
  );

  // phase === 'password'
  return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>welcome · step 2 of 2</div>
      <h1 style={{ fontSize: 26, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>Set your password.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        Your invite came with a temporary password. Choose your own now — only you will know it.
      </p>
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>new password</label>
      <input autoFocus type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} style={{ ...fieldStyle, marginBottom: 10 }} />
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>confirm password</label>
      <input type="password" value={pw2} onChange={e => { setPw2(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && savePassword()} style={fieldStyle} />
      {errBox}
      <button style={{ ...btnStyle(true), marginTop: 14 }} disabled={busy} onClick={savePassword}>
        {busy ? <Spinner /> : <i className="ph ph-lock-key" aria-hidden="true"></i>}{busy ? 'setting…' : 'finish & enter'}
      </button>
    </>
  );
}

Object.assign(window, { InvitePanel, WelcomeInvite });

})();
