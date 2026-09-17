import { entitiesOfType } from '../src/fold.js';
import { ins, def } from './store.js';
import { SlideThumb } from './SlideThumb.jsx';
import { SLIDE_W, SLIDE_H } from './constants.js';

// Thumbnail width is fixed by CSS (.rail-thumb-inner), so the scale is a
// constant, not something measured per-thumbnail — 104px of usable rail
// width (120px rail minus its padding) over the logical slide width.
const THUMB_SCALE = 104 / SLIDE_W;

export function orderedSlides(state) {
  return entitiesOfType(state, 'slide')
    .filter((s) => !s.deleted)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export default function ThumbnailRail({ state, roomId, current, onSelect }) {
  const slides = orderedSlides(state);
  const allObjects = entitiesOfType(state, 'object').filter((o) => !o.deleted);

  async function addSlide() {
    const maxOrder = slides.reduce((m, s) => Math.max(m, s.order ?? 0), -1);
    const anchor = await ins(roomId, 'slide', {});
    await def(roomId, anchor, 'order', maxOrder + 1);
    onSelect(anchor);
  }

  return (
    <div className="rail">
      {slides.map((s, i) => (
        <button
          key={s._anchor}
          className={'rail-thumb' + (s._anchor === current ? ' active' : '')}
          onClick={() => onSelect(s._anchor)}
          title={`Slide ${i + 1}`}
        >
          <div className="rail-thumb-inner" style={{ aspectRatio: `${SLIDE_W} / ${SLIDE_H}` }}>
            <SlideThumb
              slide={s}
              objects={allObjects.filter((o) => o.slide === s._anchor)}
              scale={THUMB_SCALE}
            />
            <span className="rail-thumb-n">{i + 1}</span>
          </div>
        </button>
      ))}
      <button className="rail-add" onClick={addSlide}>+ Slide</button>
    </div>
  );
}
