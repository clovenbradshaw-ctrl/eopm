/* invite-view.jsx — share access to a room by link.
 *
 * Two halves of one flow.
 *
 *   InvitePanel   — the member side. One field ("who's this for?") and a
 *     link. Everything else (role, homeserver, registration token) is
 *     folded under "advanced" because the common case never touches it.
 *     Two tabs:
 *       "by link"        mints a fresh account with register() — which
 *                        runs on a throwaway client and never touches the
 *                        inviter's own session — invites it into the room,
 *                        sets its power level, and packages a #welcome=
 *                        link carrying a one-time password AND the room's
 *                        workspace key.
 *       "matrix account" invites a real mxid the ordinary way and hands
 *                        back a plain deep link with no secret in it
 *                        (#join=) for someone who signs in as themselves.
 *
 *   WelcomeInvite — what a #welcome= link opens. For a first-time
 *     recipient this is ONE screen: they confirm what to call them, and
 *     they are in the room. No account step, no password step, no "save
 *     this somewhere safe" gate. MatrixLive.claimInvite() does the work
 *     behind that single button — see main.js for the ordering.
 *
 *     The password only ever appears on the paths where it is genuinely
 *     load-bearing:
 *       - "returning"  a spent link on a device that doesn't know this
 *                      account: they need the password they added.
 *       - "stranded"   ...and never added one. A real dead end, said
 *                      plainly, because the alternative is a login form
 *                      that can never succeed.
 *
 * Roles: "editor" is the room's default power level (0) — no override
 * needed. "viewer" is a negative power level, which the homeserver
 * itself enforces (every operator event requires PL >= 0 to send) —
 * not a client-side convention that a modified client could ignore.
 *
 * Access according to the inviter: the homeserver also enforces who may
 * invite at all and who may grant which power level (you can't hand out
 * a level >= your own, and inviting itself needs a minimum level). Both
 * tabs read ML.getInviteCapability(roomId) and only ever offer a role
 * ML.canGrantLevel() says this inviter can actually deliver — and if the
 * power-level grant is rejected anyway (a race, or a stale UI), they fall
 * back to reporting the ACTUAL role granted rather than the one requested.
 * Without this, a low-privilege inviter's "viewer" request could silently
 * land as full editor access while the UI still claimed "invited as
 * viewer" — see permissions.js for the underlying power-level math.
 */
(function () {
const { useState, useEffect, useMemo } = React;

const ROLE_PL = { viewer: -1, editor: 0 };
const ROLE_DEFS = [
  ['editor', 'Editor', 'Full access — can create and change anything in this project.'],
  ['viewer', 'Viewer', "Read-only — the homeserver itself rejects their writes, not just the UI."],
];
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

function RolePicker({ role, setRole, roles }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10 }}>
      {ROLE_DEFS.filter(([val]) => roles.includes(val)).map(([val, label, desc]) => (
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

// A shared n8n webhook (Gmail underneath) can email the link directly
// instead of making the inviter copy/paste it. The secret that unlocks
// it is vault-encrypted per device — nobody types it more than once per
// device, and it never touches the room's operator log.
function EmailSendRow({ email, setEmail }) {
  const ML = window.MatrixLive;
  const [cfg, setCfg] = useState(() => ML.getEmailConfig());
  const [secretDraft, setSecretDraft] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretErr, setSecretErr] = useState('');

  const needsSecret = email.trim() && !cfg.canSend;

  async function saveSecret() {
    if (!secretDraft.trim() || savingSecret) return;
    setSavingSecret(true); setSecretErr('');
    try { setCfg(await ML.setEmailConfig({ secret: secretDraft.trim() })); setSecretDraft(''); }
    catch (e) { setSecretErr(e?.message || "Couldn't save that."); }
    setSavingSecret(false);
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>email it to them too (optional)</label>
      <input value={email} onChange={e => setEmail(e.target.value)} placeholder="sam@example.com" style={fieldStyle} />
      {needsSecret && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 4, lineHeight: 1.4 }}>
            One-time setup for this device: paste the email webhook secret to enable sending.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="password" value={secretDraft} onChange={e => { setSecretDraft(e.target.value); setSecretErr(''); }}
              onKeyDown={e => e.key === 'Enter' && saveSecret()} placeholder="webhook secret" style={{ ...fieldStyle, flex: 1 }} />
            <button style={btnStyle(false)} disabled={savingSecret} onClick={saveSecret}>{savingSecret ? <Spinner /> : 'save'}</button>
          </div>
          {secretErr && <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 4 }}>{secretErr}</div>}
        </div>
      )}
    </div>
  );
}

function NewGuestTab({ roomId, roomTitle, session, state, onEmit, availableRoles }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState(() => availableRoles.includes('editor') ? 'editor' : availableRoles[0]);
  const [homeserver, setHomeserver] = useState(DEFAULT_HOMESERVER);
  const [token, setToken] = useState('');
  const [needToken, setNeedToken] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState(null);
  const [roleWarning, setRoleWarning] = useState('');
  const [email, setEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState(null); // 'sending' | 'sent' | {error}
  const ML = window.MatrixLive;

  async function create() {
    const who = name.trim();
    if (busy) return;
    if (!who) { setErr("Add a name so everyone knows who this is."); return; }
    setBusy(true); setErr(''); setLink(null); setEmailStatus(null); setRoleWarning('');

    // The workspace key first: without it the recipient lands in a room
    // whose history they can't decrypt until some existing member next
    // happens to open the app, which reads as a broken invite. Matrix
    // auth rules stop us pre-granting it — only they can publish their
    // own member_key — so it has to travel in the link. Not fatal if
    // it's unavailable; they'd see the workspace from their join
    // onward, which beats blocking the share.
    let roomKey = null;
    try { roomKey = await ML.exportRoomKey(roomId); }
    catch (e) { console.warn('[invite] no workspace key to share:', e?.message || e); }

    let acct;
    try {
      acct = await ML.register(homeserver.trim(), { seed: who, registrationToken: token.trim() || undefined });
    } catch (e) {
      if (e && e.code === 'uia' && /registration token/i.test(e.message || '')) { setNeedToken(true); setAdvanced(true); setErr(e.message); }
      else setErr((e && e.message) || "Couldn't create that account.");
      setBusy(false);
      return;
    }

    // Not best-effort: for a private room this IS the access grant. A guest
    // whose invite silently failed gets a link that can never join, while
    // the panel below would otherwise still claim success.
    try {
      await ML.inviteUser(roomId, acct.mxid);
    } catch (e) {
      setErr(`Account created (${acct.mxid}), but inviting them into the project failed: ${e?.message || 'unknown error'}. Try "existing member" with that ID once you have permission to invite.`);
      setBusy(false);
      return;
    }

    // Report what was actually granted, not what was requested — a denied
    // power-level change leaves the guest at the room default (editor),
    // which is MORE access than "viewer" promised, not less.
    let grantedRole = role;
    if (ROLE_PL[role] < 0) {
      try { await ML.setUserPowerLevel(roomId, acct.mxid, ROLE_PL[role]); }
      catch (e) {
        grantedRole = 'editor';
        setRoleWarning(`Couldn't restrict this to viewer (${e?.message || "you don't have permission to set roles here"}) — they have editor access instead.`);
      }
    }

    const url = ML.buildInviteLink({
      v: 1, hs: acct.domain, u: acct.localpart, p: acct.password,
      r: roomId, rt: roomTitle, n: who, role: grantedRole, by: session?.mxid,
      ...(roomKey ? { k: roomKey } : {}),
    });
    setLink({ url, mxid: acct.mxid, name: who, role: grantedRole, keyed: !!roomKey }); setNeedToken(false);

    const to = email.trim();
    if (to && ML.getEmailConfig().canSend) {
      setEmailStatus('sending');
      try {
        await ML.sendEmail({
          to, subject: `You're invited to ${roomTitle || 'a project'}`,
          html: `<p>Hi ${who},</p><p>You've been invited to <b>${roomTitle || 'a project'}</b> as ${grantedRole === 'viewer' ? 'a viewer' : 'an editor'}.</p><p><a href="${url}">${url}</a></p><p style="color:#888;font-size:12px">This link logs you straight in — no account setup needed.</p>`,
        });
        setEmailStatus('sent');
        // Record the mapping so anyone can reach this person later (the
        // bulk "update" sender looks recipients up here) without having
        // to re-type an address someone already gave once.
        if (window.PeopleDirectory && state && onEmit) {
          window.PeopleDirectory.setPersonEmail(onEmit, window.MatrixEngine, state, acct.mxid, to, who).catch(() => {});
        }
      } catch (e) { setEmailStatus({ error: e?.message || 'Email failed to send.' }); }
    }
    setBusy(false);
  }

  if (link) return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--green)', marginBottom: 8, lineHeight: 1.4 }}>
        Ready for <b>{link.name}</b> · invited as {link.role}. They open this and they're in — nothing to sign up for.
      </div>
      {roleWarning && <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 8, lineHeight: 1.4 }}>{roleWarning}</div>}
      <LinkOut url={link.url}
        note={link.keyed
          ? "Treat this like a key, not a notification: it opens the account AND decrypts this workspace's history. Send it privately, to one person."
          : "Treat this like a key: it signs them straight in. Send it privately, to one person."} />
      {!link.keyed && (
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.4 }}>
          Couldn't attach this workspace's key, so they'll see changes from when they join onward — earlier history fills in the next time you open the app.
        </div>
      )}
      {emailStatus === 'sending' && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={10} /> emailing {email}…</div>}
      {emailStatus === 'sent' && <div style={{ fontSize: 10.5, color: 'var(--green)', marginTop: 8 }}><i className="ph ph-check" aria-hidden="true"></i> emailed to {email}</div>}
      {emailStatus?.error && <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 8 }}>couldn't email it: {emailStatus.error} — the link above still works.</div>}
      <button style={{ ...btnStyle(false), marginTop: 10 }} onClick={() => { setLink(null); setEmailStatus(null); setName(''); setRoleWarning(''); }}>share with someone else</button>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.45 }}>
        One link. They open it, confirm their name, and they're in — no sign-up, no password.
      </div>
      <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>who's this for?</label>
      <input value={name} onChange={e => { setName(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && create()}
        placeholder="e.g. Sam Rivera" style={{ ...fieldStyle, marginBottom: 8 }} autoFocus />
      <EmailSendRow email={email} setEmail={setEmail} />

      <button onClick={() => setAdvanced(a => !a)}
        style={{ background: 'none', border: 'none', padding: 0, marginBottom: advanced ? 8 : 10, cursor: 'pointer', color: 'var(--text-faint)', fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 4 }}>
        <i className={`ph ph-caret-${advanced ? 'down' : 'right'}`} aria-hidden="true"></i>
        {role === 'editor' ? 'editor' : 'viewer'} · {homeserver || 'no homeserver'}
      </button>
      {advanced && (
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10, marginBottom: 10 }}>
          {availableRoles.length > 1
            ? <RolePicker role={role} setRole={setRole} roles={availableRoles} />
            : <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.4 }}>
                They'll get <b>{availableRoles[0]}</b> access — you don't have permission to grant any other role in this project.
              </div>}
          <label style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginBottom: 4 }}>homeserver</label>
          <input value={homeserver} onChange={e => setHomeserver(e.target.value)} placeholder="hyphae.social" style={{ ...fieldStyle, marginBottom: needToken ? 8 : 0 }} />
          {needToken && (
            <input value={token} onChange={e => setToken(e.target.value)} placeholder="registration token" style={fieldStyle} />
          )}
        </div>
      )}

      <button style={btnStyle(true)} disabled={busy} onClick={create}>
        {busy ? <Spinner /> : <i className="ph ph-link" aria-hidden="true"></i>}{busy ? 'preparing…' : 'create link'}
      </button>
      {err && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8, lineHeight: 1.4 }}>{err}</div>}
    </div>
  );
}

function ExistingMemberTab({ roomId, roomTitle, state, onEmit, availableRoles }) {
  const [mxid, setMxid] = useState('');
  const [role, setRole] = useState(() => availableRoles.includes('editor') ? 'editor' : availableRoles[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState(null);
  const [roleWarning, setRoleWarning] = useState('');
  const [email, setEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState(null);
  const ML = window.MatrixLive;

  async function send() {
    const id = mxid.trim();
    if (busy) return;
    if (!/^@[^:\s]+:[^\s]+$/.test(id)) { setErr('Needs a full Matrix ID, like @name:server'); return; }
    setBusy(true); setErr(''); setLink(null); setEmailStatus(null); setRoleWarning('');

    try {
      await ML.inviteUser(roomId, id);
    } catch (e) {
      setErr((e && e.message) || "Couldn't send that invite.");
      setBusy(false);
      return;
    }

    // Report what was actually granted, not what was requested — see the
    // matching comment in NewGuestTab.create().
    let grantedRole = role;
    if (ROLE_PL[role] < 0) {
      try { await ML.setUserPowerLevel(roomId, id, ROLE_PL[role]); }
      catch (e) {
        grantedRole = 'editor';
        setRoleWarning(`Couldn't restrict this to viewer (${e?.message || "you don't have permission to set roles here"}) — they have editor access instead.`);
      }
    }

    const url = ML.buildJoinLink({ r: roomId, rt: roomTitle });
    setLink({ url, mxid: id, role: grantedRole });

    const to = email.trim();
    if (to && ML.getEmailConfig().canSend) {
      setEmailStatus('sending');
      try {
        await ML.sendEmail({
          to, subject: `You're invited to ${roomTitle || 'a project'}`,
          html: `<p>Hi,</p><p>You've been invited to <b>${roomTitle || 'a project'}</b> as ${grantedRole === 'viewer' ? 'a viewer' : 'an editor'} (${id}).</p><p><a href="${url}">${url}</a></p><p style="color:#888;font-size:12px">Sign in with your own account and this link drops you straight into the project.</p>`,
        });
        setEmailStatus('sent');
        if (window.PeopleDirectory && state && onEmit) {
          window.PeopleDirectory.setPersonEmail(onEmit, window.MatrixEngine, state, id, to, null).catch(() => {});
        }
      } catch (e) { setEmailStatus({ error: e?.message || 'Email failed to send.' }); }
    }
    setBusy(false);
  }

  if (link) return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--green)', marginBottom: 8, lineHeight: 1.4 }}>
        Invited <b>{link.mxid}</b> as {link.role}. This link drops them straight into the project once they sign in:
      </div>
      {roleWarning && <div style={{ fontSize: 10.5, color: 'var(--red)', marginBottom: 8, lineHeight: 1.4 }}>{roleWarning}</div>}
      <LinkOut url={link.url} note="No password in this one — safe to share more casually. They sign in with their own account." />
      {emailStatus === 'sending' && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={10} /> emailing {email}…</div>}
      {emailStatus === 'sent' && <div style={{ fontSize: 10.5, color: 'var(--green)', marginTop: 8 }}><i className="ph ph-check" aria-hidden="true"></i> emailed to {email}</div>}
      {emailStatus?.error && <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 8 }}>couldn't email it: {emailStatus.error} — the link above still works.</div>}
      <button style={{ ...btnStyle(false), marginTop: 10 }} onClick={() => { setLink(null); setEmailStatus(null); setRoleWarning(''); }}>invite another</button>
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
      {availableRoles.length > 1
        ? <RolePicker role={role} setRole={setRole} roles={availableRoles} />
        : <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.4 }}>
            They'll get <b>{availableRoles[0]}</b> access — you don't have permission to grant any other role in this project.
          </div>}
      <EmailSendRow email={email} setEmail={setEmail} />
      <button style={btnStyle(true)} disabled={busy} onClick={send}>
        {busy ? <Spinner /> : <i className="ph ph-paper-plane-tilt" aria-hidden="true"></i>}{busy ? 'sending…' : 'send invite'}
      </button>
      {err && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 8, lineHeight: 1.4 }}>{err}</div>}
    </div>
  );
}

function InvitePanel({ roomId, roomTitle, session, state, onEmit, onClose }) {
  const [tab, setTab] = useState('new');
  const ML = window.MatrixLive;
  // Read fresh on every render (cheap in-memory state read, no network) so
  // a permission change while the dialog happens to be open isn't stale.
  const cap = ML.getInviteCapability(roomId);
  const availableRoles = ['editor', 'viewer'].filter(r => ML.canGrantLevel(cap, ROLE_PL[r]));
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div style={{ width: 'min(420px, 100%)', background: 'var(--surface)', border: '1px solid var(--border-strong)', boxShadow: '0 8px 30px rgba(0,0,0,.25)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Invite people to {roomTitle || 'this project'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text-faint)' }}>
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        </div>
        {!cap.canInvite ? (
          <div style={{ padding: 14, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
            You don't have permission to invite people to {roomTitle || 'this project'} — ask an editor or the project owner.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => setTab('new')} style={{ flex: 1, padding: '8px 0', fontSize: 11.5, border: 'none', borderBottom: '2px solid ' + (tab === 'new' ? 'var(--text)' : 'transparent'), background: 'none', cursor: 'pointer', color: tab === 'new' ? 'var(--text)' : 'var(--text-faint)' }}>new guest</button>
              <button onClick={() => setTab('existing')} style={{ flex: 1, padding: '8px 0', fontSize: 11.5, border: 'none', borderBottom: '2px solid ' + (tab === 'existing' ? 'var(--text)' : 'transparent'), background: 'none', cursor: 'pointer', color: tab === 'existing' ? 'var(--text)' : 'var(--text-faint)' }}>existing member</button>
            </div>
            <div style={{ padding: 14 }}>
              {tab === 'new'
                ? <NewGuestTab roomId={roomId} roomTitle={roomTitle} session={session} state={state} onEmit={onEmit} availableRoles={availableRoles} />
                : <ExistingMemberTab roomId={roomId} roomTitle={roomTitle} state={state} onEmit={onEmit} availableRoles={availableRoles} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// WelcomeInvite — the #welcome= link's landing page
//
// Phases:
//   claiming   the one screen a first-time recipient sees (name → in)
//   entering   claimInvite() is running
//   returning  spent link, this device doesn't know the account: they
//              need the password they added
//   stranded   ...and there is no password to enter. A dead end, stated
//              plainly rather than dressed as a login form
//   expired    the link outlived its TTL
//   error      anything else
// ─────────────────────────────────────────────────────────────────────────

function WelcomeInvite({ payload, onDone }) {
  const ML = window.MatrixLive;
  const expired = !!payload.expired;
  const [phase, setPhase] = useState(expired ? 'expired' : 'claiming');
  const [err, setErr] = useState('');
  const [name, setName] = useState(payload.n || '');
  const [returnPw, setReturnPw] = useState('');
  const [busy, setBusy] = useState(false);
  const device = useMemo(() => (ML?.currentDevice?.() || { device: 'device' }), []);
  const mxid = expired ? null : '@' + payload.u + ':' + payload.hs;

  // The link's secrets are in the fragment, which is in the address bar,
  // the tab title's share sheet, and any screenshot of either. Strip it
  // before doing anything else — we already hold the payload in memory.
  useEffect(() => {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }, []);

  const enter = async () => {
    if (busy) return;
    const who = name.trim();
    if (!who) { setErr('Just a name to show people — anything you like.'); return; }
    setBusy(true); setErr(''); setPhase('entering');
    try {
      const sess = await ML.claimInvite(payload, { displayName: who });
      onDone && onDone(sess, payload.r);
    } catch (e) {
      setBusy(false);
      // A dead one-time password means this link has already been
      // claimed — by them on another device, or by whoever it was
      // forwarded to. Either way the way back in is the password they
      // set, if they ever set one.
      if (e && (e.errcode === 'M_FORBIDDEN' || e.httpStatus === 403 || e.status === 403 || /forbidden|invalid|password/i.test(e.message || ''))) {
        setErr(''); setPhase('returning');
      } else {
        setErr(e?.message || "We couldn't open this invite."); setPhase('error');
      }
    }
  };

  const returnSignIn = async () => {
    if (busy) return;
    if (!returnPw) { setErr('Enter your password.'); return; }
    setBusy(true); setErr('');
    try {
      const sess = await ML.login({ homeserver: payload.hs, username: mxid, password: returnPw, keepSignedIn: true });
      if (payload.r) { try { await ML.joinRoom(payload.r); } catch (e) {} }
      setPhase('entering');
      onDone && onDone(sess, payload.r);
    } catch (e) { setErr(e?.message || "That password didn't match."); setBusy(false); }
  };

  const card = (children) => (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflowY: 'auto' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid var(--border-strong)', padding: '26px 24px 28px' }}>{children}</div>
    </div>
  );
  const errBox = err ? <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, lineHeight: 1.4 }}>{err}</div> : null;

  if (phase === 'entering') return card(
    <div style={{ textAlign: 'center', padding: '14px 0' }}>
      <Spinner size={22} />
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 14 }}>Setting up your access…</div>
    </div>
  );

  if (phase === 'expired') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>expired link</div>
      <h1 style={{ fontSize: 22, margin: '0 0 10px', fontFamily: 'var(--mono)' }}>This link has expired.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 6px' }}>
        Invite links stop working after a while so an old message can't stay an open door{payload.rt ? <> into <b>{payload.rt}</b></> : ''}.
      </p>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)', margin: 0 }}>Ask whoever sent it for a fresh one — it takes them a few seconds.</p>
    </>
  );

  if (phase === 'stranded') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8 }}>new device</div>
      <h1 style={{ fontSize: 22, margin: '0 0 10px', fontFamily: 'var(--mono)' }}>This one needs a password.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        Your access lives on the device you first opened this link on, and it stays there until you add a password. Without one there's no way to sign in here.
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 10px' }}>
        On that first device, open the account menu and choose <b>add a password</b>. Then come back here and use it.
      </p>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)', margin: 0 }}>
        No longer have it? Ask whoever invited you for a new link. You'll come in as a new member — your earlier work stays in the room under your old name.
      </p>
      <button style={{ ...btnStyle(false), marginTop: 14 }} onClick={() => { setErr(''); setPhase('returning'); }}>
        <i className="ph ph-arrow-left" aria-hidden="true"></i>I do have a password
      </button>
    </>
  );

  if (phase === 'returning') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>welcome back</div>
      <h1 style={{ fontSize: 24, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>Sign in to continue.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        This link has already been used, so it can't sign you in again. Enter the password <b>you added</b> to pick up where you left off.
      </p>
      <input autoFocus type="password" value={returnPw} onChange={e => { setReturnPw(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && returnSignIn()} style={fieldStyle} />
      {errBox}
      <button style={{ ...btnStyle(true), width: '100%', justifyContent: 'center', marginTop: 14 }} disabled={busy} onClick={returnSignIn}>
        {busy ? <Spinner /> : <i className="ph ph-lock-key" aria-hidden="true"></i>}{busy ? 'signing in…' : 'sign in'}
      </button>
      <button style={{ background: 'none', border: 'none', padding: 0, marginTop: 12, cursor: 'pointer', color: 'var(--text-faint)', fontSize: 11.5, textDecoration: 'underline' }}
        onClick={() => { setErr(''); setPhase('stranded'); }}>
        I never added a password
      </button>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 12 }}>{mxid}</div>
    </>
  );

  if (phase === 'error') return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>something went wrong</div>
      <h1 style={{ fontSize: 22, margin: '0 0 10px', fontFamily: 'var(--mono)' }}>We couldn't open this.</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 6px' }}>{err}</p>
      <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-faint)', margin: '0 0 14px' }}>Ask whoever sent it for a fresh link.</p>
      <button style={btnStyle(false)} onClick={() => { setErr(''); setPhase('claiming'); setBusy(false); }}>
        <i className="ph ph-arrow-clockwise" aria-hidden="true"></i>try again
      </button>
    </>
  );

  // phase === 'claiming' — the only screen most people ever see.
  return card(
    <>
      <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 8 }}>you've been invited</div>
      <h1 style={{ fontSize: 26, margin: '0 0 8px', fontFamily: 'var(--mono)' }}>What should we call you?</h1>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-dim)', margin: '0 0 14px' }}>
        {payload.rt ? <><b>{payload.rt}</b> is ready for you.</> : 'Your workspace is ready.'} There's nothing to sign up for — this {device.device} remembers you.
      </p>
      <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr(''); }} onKeyDown={e => e.key === 'Enter' && enter()}
        placeholder="e.g. Sam Rivera" style={fieldStyle} />
      {errBox}
      <button style={{ ...btnStyle(true), width: '100%', justifyContent: 'center', marginTop: 14 }} disabled={busy} onClick={enter}>
        {busy ? <Spinner /> : <i className="ph ph-arrow-right" aria-hidden="true"></i>}
        {busy ? 'setting up…' : (payload.rt ? `open ${payload.rt}` : 'open the workspace')}
      </button>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 14, lineHeight: 1.5 }}>
        You'll show up as <b>{(ML.accountDisplayName?.(name) || name.trim()) || '…'}</b>. Add a password later if you want this on another {device.device === 'device' ? 'device' : 'device too'}.
      </div>
    </>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// PasswordNudge — the one place we bring the password up unprompted.
//
// A share-link account lives on the device that claimed it. That is the
// point (nobody had to sign up) and it is also the risk (lose the device,
// lose the access), and the only moment we can do anything about it is
// while they still have the device. So we do raise it — but as a strip
// they can wave away, not a gate, and not until they have actually done
// something worth keeping.
//
// Rules it follows, deliberately:
//   - never on arrival: EDITS_BEFORE_NUDGE writes have to land first
//   - never twice in a session, and not for a week after a dismissal
//   - never for an account that already has a password
//   - louder, and immediately, when the browser tells us it won't keep
//     local storage at all (private windows) — there the account really
//     does die with the tab, so "later" is not an option we can offer
// ─────────────────────────────────────────────────────────────────────────

const NUDGE_SNOOZE_KEY = 'matrix-events.password-nudge.snoozed-until';
const NUDGE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const EDITS_BEFORE_NUDGE = 3;

function snoozed() {
  try { return Date.now() < Number(localStorage.getItem(NUDGE_SNOOZE_KEY) || 0); }
  catch { return false; }
}
function snooze() {
  try { localStorage.setItem(NUDGE_SNOOZE_KEY, String(Date.now() + NUDGE_SNOOZE_MS)); } catch {}
}

function PasswordNudge({ session, editCount, onAddPassword }) {
  const ML = window.MatrixLive;
  const [deviceOnly, setDeviceOnly] = useState(false);
  const [durable, setDurable] = useState(true);
  const [dismissed, setDismissed] = useState(() => snoozed());
  const device = useMemo(() => ML?.currentDevice?.() || { device: 'device' }, []);

  useEffect(() => {
    if (!session || session.demo) return;
    let alive = true;
    Promise.resolve(ML?.isDeviceOnlyAccount?.())
      .then(v => { if (alive) setDeviceOnly(!!v); })
      .catch(() => {});
    // Storage the browser won't promise to keep means the account can
    // vanish on its own — worth saying out loud rather than waiting for
    // the edit count.
    Promise.resolve(navigator.storage?.persisted?.())
      .then(p => { if (alive && p === false) setDurable(false); })
      .catch(() => {});
    return () => { alive = false; };
  }, [session]);

  const urgent = deviceOnly && !durable;
  if (!deviceOnly || dismissed) return null;
  if (!urgent && editCount < EDITS_BEFORE_NUDGE) return null;

  const dismiss = () => { snooze(); setDismissed(true); };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
      borderBottom: '1px solid var(--border)',
      background: urgent ? 'var(--surface-2, transparent)' : 'transparent',
      fontSize: 11.5, lineHeight: 1.45,
    }}>
      <i className={`ph ph-${urgent ? 'warning' : 'device-mobile'}`} style={{ color: urgent ? 'var(--red)' : 'var(--text-faint)', flex: '0 0 auto' }} aria-hidden="true"></i>
      <span style={{ minWidth: 0, color: 'var(--text-dim)' }}>
        {urgent
          ? <>This browser isn't saving anything to disk, so your access disappears when you close it. <b>Add a password now</b> to keep it.</>
          : <>Your access lives on this {device.device}. Add a password to open it on another one — or to get back in if you lose this.</>}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flex: '0 0 auto' }}>
        <button style={btnStyle(true)} onClick={() => { setDismissed(true); onAddPassword?.(); }}>add a password</button>
        {!urgent && (
          <button onClick={dismiss} title="not now"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 13 }}>
            <i className="ph ph-x" aria-hidden="true"></i>
          </button>
        )}
      </span>
    </div>
  );
}

Object.assign(window, { InvitePanel, WelcomeInvite, PasswordNudge });

})();
