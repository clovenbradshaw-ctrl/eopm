import { useEffect, useMemo, useRef, useState } from 'react';
import { getClient } from '../src/client.js';
import { getMembers, loadRoomMembers, onMembersChange } from '../src/rooms.js';
import { entitiesOfType, initial as initialFold } from '../src/fold.js';
import PasswordGate from './PasswordGate.jsx';
import { normalizeSlug, joinOrCreate } from './slug.js';
import { ensureSession } from './session.js';
import { watchRoom, ins, def, defSchema } from './store.js';
import ThumbnailRail, { orderedSlides } from './ThumbnailRail.jsx';
import Canvas from './Canvas.jsx';
import PresenterMode from './PresenterMode.jsx';
import PresenceTray from './PresenceTray.jsx';
import { GATE_FLAG_KEY, CURSOR_COMMIT_MS, CURSOR_STALE_MS } from './constants.js';

function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  const run = (...a) => { last = Date.now(); pending = null; fn(...a); };
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { if (timer) { clearTimeout(timer); timer = null; } run(...a); }
    else { pending = a; if (!timer) timer = setTimeout(() => { timer = null; if (pending) run(...pending); }, ms - (now - last)); }
  };
}

function presenceAnchorKey(roomId) { return `collab_presence_${roomId}`; }

export default function App() {
  const [gateOk, setGateOk] = useState(() => {
    try { return localStorage.getItem(GATE_FLAG_KEY) === '1'; } catch { return false; }
  });
  const [phase, setPhase] = useState('connecting'); // connecting | no-slug | error | ready
  const [error, setError] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [state, setState] = useState(initialFold());
  const [currentSlide, setCurrentSlide] = useState(null);
  const [presenting, setPresenting] = useState(false);
  const [members, setMembers] = useState([]);
  const presenceAnchorRef = useRef(null);

  const slug = useMemo(() => normalizeSlug(location.search.replace(/^\?/, '').split('&')[0]), []);

  useEffect(() => {
    if (!gateOk) return; // password gate blocks all network activity until passed
    let unwatch = null;
    let unMembers = null;
    let cancelled = false;

    (async () => {
      try {
        if (!slug) { setPhase('no-slug'); return; }
        await ensureSession();
        const { roomId: rid } = await joinOrCreate(slug);
        if (cancelled) return;
        setRoomId(rid);

        try { document.title = slug; } catch {}
        try { await defSchema(rid, 'title', slug); } catch {}

        let anchor = null;
        try { anchor = sessionStorage.getItem(presenceAnchorKey(rid)); } catch {}
        if (!anchor) {
          anchor = await ins(rid, 'presence', {});
          try { sessionStorage.setItem(presenceAnchorKey(rid), anchor); } catch {}
        }
        presenceAnchorRef.current = anchor;

        await loadRoomMembers(rid);
        setMembers(getMembers(rid));
        unMembers = onMembersChange(rid, () => setMembers(getMembers(rid)));

        unwatch = await watchRoom(rid, (s) => {
          setState(s);
          setCurrentSlide((cur) => {
            if (cur) return cur;
            const slides = orderedSlides(s);
            return slides[0]?._anchor || null;
          });
        });

        setPhase('ready');
      } catch (e) {
        console.error(e);
        if (!cancelled) { setError(e?.message || String(e)); setPhase('error'); }
      }
    })();

    return () => { cancelled = true; if (unwatch) unwatch(); if (unMembers) unMembers(); };
  }, [gateOk, slug]);

  const sendCursor = useMemo(() => throttle((x, y) => {
    const client = getClient();
    if (!roomId || !presenceAnchorRef.current || !client) return;
    def(roomId, presenceAnchorRef.current, 'cursor', { x, y, slide: currentSlide, ts: Date.now() });
  }, CURSOR_COMMIT_MS), [roomId, currentSlide]);

  if (!gateOk) return <PasswordGate onPass={() => setGateOk(true)} />;
  if (phase === 'no-slug') {
    return <div className="empty-state">No canvas specified — add <code>?your-canvas-name</code> to the URL.</div>;
  }
  if (phase === 'error') {
    return <div className="empty-state">Couldn't connect: {error}</div>;
  }
  if (phase === 'connecting') {
    return (
      <div className="loading-state">
        <div className="loading-spinner">
          <div /><div /><div />
        </div>
        <div className="loading-label">Connecting…</div>
      </div>
    );
  }

  const myUserId = getClient()?.getUserId();
  const presenceEntities = entitiesOfType(state, 'presence');
  const cursorByUser = {};
  for (const p of presenceEntities) {
    if (!p.cursor || p._sender === myUserId) continue;
    const existing = cursorByUser[p._sender];
    if (!existing || p.cursor.ts > existing.ts) cursorByUser[p._sender] = p.cursor;
  }
  const now = Date.now();
  const cursorsOnThisSlide = Object.entries(cursorByUser)
    .filter(([, c]) => c.slide === currentSlide && now - c.ts < CURSOR_STALE_MS)
    .map(([userId, c]) => {
      const m = members.find((m) => m.userId === userId);
      return { userId, x: c.x, y: c.y, name: (m?.displayName || userId).split(':')[0] };
    });

  if (presenting) {
    return (
      <PresenterMode
        state={state}
        current={currentSlide}
        onNavigate={(a) => a && setCurrentSlide(a)}
        onExit={() => setPresenting(false)}
      />
    );
  }

  return (
    <div className="app-shell">
      <ThumbnailRail state={state} roomId={roomId} current={currentSlide} onSelect={setCurrentSlide} />
      <div className="main-pane">
        <div className="topbar">
          <span className="topbar-title">{slug}</span>
          <PresenceTray members={members} cursorByUser={cursorByUser} />
          <button className="present-btn" onClick={() => setPresenting(true)}>Present</button>
        </div>
        {currentSlide ? (
          <Canvas
            state={state}
            roomId={roomId}
            slideAnchor={currentSlide}
            onCursorMove={sendCursor}
            cursors={cursorsOnThisSlide}
          />
        ) : (
          <div className="empty-state">No slides yet.</div>
        )}
      </div>
    </div>
  );
}
