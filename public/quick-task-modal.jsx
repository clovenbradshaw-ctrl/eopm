/* quick-task-modal.jsx — one-field-at-a-time modal for adding a task fast.
 *
 * The kanban board's inline "new todo…" input only ever captures a title —
 * everything else (list, column, priority, due date) means opening the row
 * and editing cells by hand. This is the shortcut: title, list, column,
 * priority, due date, and a "add to calendar" button that turns the due
 * date into a downloadable .ics — no server, no OAuth, just a file the
 * user's own calendar app can import.
 *
 * Presentation only: onCreate hands the picked fields up to app.jsx, which
 * does the actual INS/SEG/CON emits (same split as sidebar.jsx's
 * NewViewModal / onCreateView).
 */

(function () {
  const { useState, useEffect, useMemo, useRef } = React;

  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  function icsTimestamp(d) {
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  function safeFilename(name) {
    return String(name || 'task').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  }

  function downloadIcs(title, dueDate) {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}@eopm`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//eopm//task//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${icsTimestamp(new Date())}`,
      `DTSTART;VALUE=DATE:${dueDate.replace(/-/g, '')}`,
      `SUMMARY:${icsEscape(title)}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const blob = new Blob([lines], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFilename(title)}.ics`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
  }

  function QuickTaskModal({ state, onClose, onCreate }) {
    const partitions = (state.schema?.partitions?.todo?.length ? state.schema.partitions.todo : ['backlog']);
    const priorityField = (state.schema?.fields?.todo || []).find(f => f.name === 'Priority');
    const priorities = priorityField?.options?.length ? priorityField.options : ['none', 'low', 'medium', 'high', 'urgent'];
    const lists = useMemo(() => (
      Object.values(state.entities)
        .filter(e => e._type === 'todo_list')
        .sort((a, b) => (a._created || 0) - (b._created || 0))
    ), [state.entities]);

    const [title, setTitle] = useState('');
    const [listAnchor, setListAnchor] = useState(() => lists[lists.length - 1]?._anchor || '');
    const [partition, setPartition] = useState(partitions[0]);
    const [priority, setPriority] = useState('none');
    const [dueDate, setDueDate] = useState('');
    const titleRef = useRef(null);

    useEffect(() => {
      function onKey(e) { if (e.key === 'Escape') onClose(); }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    function commit() {
      const trimmed = title.trim();
      if (!trimmed) { titleRef.current?.focus(); return; }
      onCreate({
        title: trimmed,
        partition,
        priority: priority !== 'none' ? priority : null,
        dueDate: dueDate || null,
        listAnchor: listAnchor || null,
      });
    }

    return (
      <div className="proj-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="proj-modal qt-modal" onMouseDown={e => e.stopPropagation()}>
          <header className="proj-modal-head">
            <div className="proj-modal-eyebrow">new task</div>
            <div className="proj-modal-title">
              <span className="proj-modal-dim">title, column, priority, due date — the rest can wait</span>
            </div>
          </header>

          <div className="proj-modal-body">
            <input
              ref={titleRef}
              autoFocus
              className="proj-name-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="what needs doing?"
              onKeyDown={e => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') onClose();
              }}
            />

            {lists.length > 1 && (
              <>
                <div className="proj-modal-section-label">list</div>
                <select className="proj-name-input qt-select" value={listAnchor} onChange={e => setListAnchor(e.target.value)}>
                  {lists.map(l => (
                    <option key={l._anchor} value={l._anchor}>{l.Title || '(untitled list)'}</option>
                  ))}
                </select>
              </>
            )}

            <div className="qt-row2">
              <div>
                <div className="proj-modal-section-label">column</div>
                <select className="proj-name-input qt-select" value={partition} onChange={e => setPartition(e.target.value)}>
                  {partitions.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <div className="proj-modal-section-label">priority</div>
                <select className="proj-name-input qt-select" value={priority} onChange={e => setPriority(e.target.value)}>
                  {priorities.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            <div className="proj-modal-section-label">due date</div>
            <div className="qt-due-row">
              <input
                type="date"
                className="proj-name-input qt-select"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
              />
              <button
                type="button"
                className="qt-cal-btn"
                disabled={!dueDate}
                onClick={() => downloadIcs(title.trim() || 'task', dueDate)}
                title={dueDate ? 'download this due date as a calendar event (.ics)' : 'set a due date first'}
              >
                <i className="ph ph-calendar-plus" aria-hidden="true"></i> add to calendar
              </button>
            </div>
          </div>

          <footer className="proj-modal-foot">
            <button className="proj-modal-cancel" onClick={onClose}>cancel</button>
            <button className="proj-modal-create" onClick={commit} disabled={!title.trim()}>create task</button>
          </footer>
        </div>
      </div>
    );
  }

  window.QuickTaskModal = QuickTaskModal;
})();
