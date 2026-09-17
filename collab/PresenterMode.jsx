import { useEffect, useRef, useState } from 'react';
import { entitiesOfType } from '../src/fold.js';
import { orderedSlides } from './ThumbnailRail.jsx';
import { StaticObject } from './SlideThumb.jsx';
import { SLIDE_W, SLIDE_H } from './constants.js';

export default function PresenterMode({ state, current, onNavigate, onExit }) {
  const slides = orderedSlides(state);
  const idx = Math.max(0, slides.findIndex((s) => s._anchor === current));
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(1);

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

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onExit();
      else if (e.key === 'ArrowRight' || e.key === ' ') onNavigate(slides[Math.min(idx + 1, slides.length - 1)]?._anchor);
      else if (e.key === 'ArrowLeft') onNavigate(slides[Math.max(idx - 1, 0)]?._anchor);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, slides, onNavigate, onExit]);

  const slide = slides[idx];
  const objects = slide ? entitiesOfType(state, 'object').filter((o) => o.slide === slide._anchor && !o.deleted) : [];

  return (
    <div className="presenter">
      <div className="presenter-wrap" ref={wrapRef}>
        <div className="presenter-slide-outer" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
          <div
            className="presenter-slide"
            style={{
              position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
              transform: `scale(${scale})`, transformOrigin: 'top left',
              background: slide?.background || '#fff',
            }}
          >
            {objects.map((o) => <StaticObject key={o._anchor} obj={o} />)}
          </div>
        </div>
      </div>
      <button className="presenter-exit" onClick={onExit}>Exit</button>
    </div>
  );
}
