import { CURSOR_IDLE_MS } from './constants.js';

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

export default function PresenceTray({ members, cursorByUser }) {
  const now = Date.now();
  const rows = members.map((m) => {
    const cur = cursorByUser[m.userId];
    const active = cur && now - cur.ts < CURSOR_IDLE_MS;
    return { ...m, active };
  });
  const activeCount = rows.filter((r) => r.active).length;

  return (
    <div className="presence-tray">
      <span className="presence-count">{activeCount} active</span>
      <div className="presence-avatars">
        {rows.map((r) => (
          <div key={r.userId} className={'presence-avatar' + (r.active ? ' is-active' : ' is-idle')} title={r.displayName}>
            {initials(r.displayName)}
          </div>
        ))}
      </div>
    </div>
  );
}
