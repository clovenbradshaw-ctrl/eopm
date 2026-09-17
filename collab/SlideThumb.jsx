import { SLIDE_W, SLIDE_H } from './constants.js';

/** Non-interactive render of one object — shared by PresenterMode and the rail's live thumbnails. */
export function StaticObject({ obj }) {
  const style = {
    position: 'absolute',
    left: obj.x || 0, top: obj.y || 0, width: obj.w ?? 240, height: obj.h ?? 80,
    zIndex: obj.z || 0,
  };
  if (obj.kind === 'shape') {
    return (
      <div style={{
        ...style,
        background: obj.fill && obj.fill !== 'none' ? obj.fill : 'transparent',
        border: obj.stroke && obj.stroke !== 'none' ? `${obj.strokeWidth || 2}px solid ${obj.stroke}` : 'none',
        borderRadius: obj.shapeType === 'ellipse' ? '50%' : 0,
      }} />
    );
  }
  return (
    <div style={{
      ...style,
      fontSize: obj.fontSize || 20,
      fontFamily: obj.fontFamily || 'Inter, sans-serif',
      color: obj.color || '#1a1a1a',
      textAlign: obj.align || 'left',
      fontWeight: obj.bold ? 700 : 400,
      background: obj.fill && obj.fill !== 'transparent' ? obj.fill : 'transparent',
      whiteSpace: 'pre-wrap',
      padding: 4,
    }}>
      {obj.text || ''}
    </div>
  );
}

/**
 * A slide rendered at a fixed CSS scale via transform — the objects stay
 * laid out at the real SLIDE_W x SLIDE_H logical size and only the paint
 * shrinks, same technique Canvas.jsx/PresenterMode use for the full-size
 * views, just with a caller-supplied scale instead of one measured from a
 * container (a rail thumbnail's size is fixed by CSS, not worth a
 * ResizeObserver per thumbnail).
 */
export function SlideThumb({ slide, objects, scale }) {
  return (
    <div
      style={{
        position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
        transform: `scale(${scale})`, transformOrigin: 'top left',
        background: slide?.background || '#fff',
      }}
    >
      {objects.map((o) => <StaticObject key={o._anchor} obj={o} />)}
    </div>
  );
}
