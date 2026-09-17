import { useEffect, useRef, useState, useCallback } from 'react';
import { def } from './store.js';
import { DRAG_COMMIT_MS, TEXT_COMMIT_MS } from './constants.js';

function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  const run = (...args) => { last = Date.now(); pending = null; fn(...args); };
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { if (timer) { clearTimeout(timer); timer = null; } run(...args); }
    else { pending = args; if (!timer) timer = setTimeout(() => { timer = null; if (pending) run(...pending); }, ms - (now - last)); }
  };
}

function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => { if (timer) clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; } fn(...args); };
  return wrapped;
}

/**
 * One text box or shape. Geometry drags/resizes with an instant local
 * update + throttled remote commit; text edits debounce. While a field is
 * under local focus/gesture, incoming remote updates for THAT field are
 * suppressed so a concurrent edit doesn't yank the cursor or snap a drag —
 * def() is last-write-wins with no merge, so this is about not fighting
 * your own in-flight gesture, not real conflict resolution.
 */
export default function ObjectBox({ roomId, obj, scale, selected, onSelect, onDelete }) {
  const [geo, setGeo] = useState({ x: obj.x || 0, y: obj.y || 0, w: obj.w ?? 240, h: obj.h ?? 80 });
  const busyRef = useRef(false); // true while dragging/resizing this box
  const editingRef = useRef(false); // true while text is focused
  const textRef = useRef(null);

  useEffect(() => {
    if (!busyRef.current) setGeo({ x: obj.x || 0, y: obj.y || 0, w: obj.w ?? 240, h: obj.h ?? 80 });
  }, [obj.x, obj.y, obj.w, obj.h]);

  useEffect(() => {
    if (!editingRef.current && textRef.current && obj.kind === 'text') {
      if (textRef.current.innerText !== (obj.text || '')) textRef.current.innerText = obj.text || '';
    }
  }, [obj.text, obj.kind]);

  const commitGeo = useCallback(throttle((patch) => {
    for (const [k, v] of Object.entries(patch)) def(roomId, obj._anchor, k, v);
  }, DRAG_COMMIT_MS), [roomId, obj._anchor]);

  function startDrag(e) {
    e.stopPropagation();
    onSelect(obj._anchor);
    e.preventDefault();
    busyRef.current = true;
    const startX = e.clientX, startY = e.clientY;
    const origX = geo.x, origY = geo.y;
    let finalPatch = { x: origX, y: origY };
    function move(ev) {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      finalPatch = { x: Math.round(origX + dx), y: Math.round(origY + dy) };
      setGeo((g) => ({ ...g, ...finalPatch }));
      commitGeo(finalPatch);
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      move(ev);
      busyRef.current = false;
      def(roomId, obj._anchor, 'x', finalPatch.x);
      def(roomId, obj._anchor, 'y', finalPatch.y);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e) {
    e.stopPropagation();
    e.preventDefault();
    busyRef.current = true;
    const startX = e.clientX, startY = e.clientY;
    const origW = geo.w, origH = geo.h;
    let finalPatch = null;
    function move(ev) {
      const dw = (ev.clientX - startX) / scale;
      const dh = (ev.clientY - startY) / scale;
      const next = { ...geo, w: Math.max(24, Math.round(origW + dw)), h: Math.max(24, Math.round(origH + dh)) };
      finalPatch = next;
      setGeo(next);
      commitGeo({ w: next.w, h: next.h });
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      move(ev);
      busyRef.current = false;
      if (finalPatch) { def(roomId, obj._anchor, 'w', finalPatch.w); def(roomId, obj._anchor, 'h', finalPatch.h); }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const commitText = useCallback(debounce((value) => {
    def(roomId, obj._anchor, 'text', value);
  }, TEXT_COMMIT_MS), [roomId, obj._anchor]);

  const style = {
    position: 'absolute',
    left: geo.x, top: geo.y, width: geo.w, height: geo.h,
    zIndex: obj.z || 0,
    outline: selected ? '2px solid var(--sel)' : 'none',
    outlineOffset: 2,
  };

  return (
    <div className="obj-box" style={style} onPointerDown={(e) => { e.stopPropagation(); onSelect(obj._anchor); }}>
      {obj.kind === 'shape' ? (
        <div
          className="obj-shape"
          onPointerDown={startDrag}
          style={{
            width: '100%', height: '100%',
            background: obj.fill && obj.fill !== 'none' ? obj.fill : 'transparent',
            border: obj.stroke && obj.stroke !== 'none' ? `${obj.strokeWidth || 2}px solid ${obj.stroke}` : 'none',
            borderRadius: obj.shapeType === 'ellipse' ? '50%' : 0,
            cursor: 'move',
          }}
        />
      ) : (
        <>
          {selected && (
            <div className="obj-grip" title="Drag to move" onPointerDown={startDrag}>⠿</div>
          )}
          <div
            ref={textRef}
            className="obj-text"
            contentEditable={selected}
            suppressContentEditableWarning
            onFocus={() => { editingRef.current = true; }}
            onBlur={(e) => { editingRef.current = false; commitText.flush(e.currentTarget.innerText); }}
            onInput={(e) => commitText(e.currentTarget.innerText)}
            style={{
              width: '100%', height: '100%',
              fontSize: obj.fontSize || 20,
              fontFamily: obj.fontFamily || 'Inter, sans-serif',
              color: obj.color || '#1a1a1a',
              textAlign: obj.align || 'left',
              fontWeight: obj.bold ? 700 : 400,
              background: obj.fill && obj.fill !== 'transparent' ? obj.fill : 'transparent',
              whiteSpace: 'pre-wrap',
              outline: 'none',
              padding: 4,
              cursor: selected ? 'text' : 'move',
            }}
            onPointerDown={(e) => { if (!selected) startDrag(e); }}
          >
            {obj.text || ''}
          </div>
        </>
      )}
      {selected && (
        <>
          <div className="obj-handle" onPointerDown={startResize} />
          <button className="obj-delete" onPointerDown={(e) => e.stopPropagation()} onClick={() => onDelete(obj._anchor)}>×</button>
        </>
      )}
    </div>
  );
}
