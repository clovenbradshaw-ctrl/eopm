import { useCallback, useEffect, useRef, useState } from 'react';
import { entitiesOfType } from '../src/fold.js';
import { ins, def } from './store.js';
import ObjectBox from './ObjectBox.jsx';
import { SLIDE_W, SLIDE_H } from './constants.js';

function nextZ(objects) {
  return 1 + objects.reduce((m, o) => Math.max(m, o.z || 0), 0);
}

export default function Canvas({ state, roomId, slideAnchor, onCursorMove, cursors }) {
  const [selected, setSelected] = useState(null);
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);

  const objects = entitiesOfType(state, 'object')
    .filter((o) => o.slide === slideAnchor)
    .sort((a, b) => (a.z || 0) - (b.z || 0));

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(Math.min(r.width / SLIDE_W, r.height / SLIDE_H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const addText = useCallback(async () => {
    const anchor = await ins(roomId, 'object', { kind: 'text', slide: slideAnchor });
    await Promise.all([
      def(roomId, anchor, 'x', 120), def(roomId, anchor, 'y', 120),
      def(roomId, anchor, 'w', 360), def(roomId, anchor, 'h', 80),
      def(roomId, anchor, 'z', nextZ(objects)),
      def(roomId, anchor, 'text', 'Text'),
    ]);
    setSelected(anchor);
  }, [roomId, slideAnchor, objects]);

  const addShape = useCallback(async (shapeType) => {
    const anchor = await ins(roomId, 'object', { kind: 'shape', slide: slideAnchor });
    await Promise.all([
      def(roomId, anchor, 'x', 160), def(roomId, anchor, 'y', 160),
      def(roomId, anchor, 'w', 200), def(roomId, anchor, 'h', 200),
      def(roomId, anchor, 'z', nextZ(objects)),
      def(roomId, anchor, 'shapeType', shapeType),
      def(roomId, anchor, 'fill', '#4C1D95'),
    ]);
    setSelected(anchor);
  }, [roomId, slideAnchor, objects]);

  function onDelete(anchor) {
    // No tenth "delete" operator — moving off-canvas + zeroing size reads as
    // gone without inventing a removal concept the algebra doesn't have.
    def(roomId, anchor, 'w', 0);
    def(roomId, anchor, 'h', 0);
    def(roomId, anchor, 'deleted', true);
    setSelected(null);
  }

  function onCanvasPointerMove(e) {
    const el = wrapRef.current;
    if (!el || !onCursorMove) return;
    const r = el.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / scale);
    const y = Math.round((e.clientY - r.top) / scale);
    onCursorMove(x, y);
  }

  const visibleObjects = objects.filter((o) => !o.deleted);

  return (
    <div className="canvas-pane">
      <div className="toolbar">
        <button onClick={addText}>+ Text</button>
        <button onClick={() => addShape('rect')}>+ Rectangle</button>
        <button onClick={() => addShape('ellipse')}>+ Ellipse</button>
      </div>
      <div className="canvas-wrap" ref={wrapRef} onPointerMove={onCanvasPointerMove}>
        {/* Flexbox centers this outer box at its POST-scale footprint;
            the inner box stays at the logical 1280x720 size and is only
            visually scaled, so centering math and hit-testing agree. */}
        <div className="slide-surface-outer" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
          <div
            className="slide-surface"
            style={{
              width: SLIDE_W, height: SLIDE_H,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
            onPointerDown={() => setSelected(null)}
          >
            {visibleObjects.map((o) => (
              <ObjectBox
                key={o._anchor}
                roomId={roomId}
                obj={o}
                scale={scale}
                selected={selected === o._anchor}
                onSelect={setSelected}
                onDelete={onDelete}
              />
            ))}
            {(cursors || []).map((c) => (
              <div key={c.userId} className="remote-cursor" style={{ left: c.x, top: c.y }}>
                <div className="remote-cursor-dot" />
                <div className="remote-cursor-label">{c.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
