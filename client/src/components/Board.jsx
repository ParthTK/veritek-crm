// A row of columns wider than the screen. The edge with more beyond it says so, with a fade and an arrow
// button, and while a card is being dragged the board scrolls by itself near either edge, so that every
// column can be reached with the card in hand.
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export default function Board({ dragging, children }) {
  const ref = useRef(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 };
    setMore((m) => (m.left === next.left && m.right === next.right ? m : next));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(measure); // columns and cards change with the data
  const nudge = (dir) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(260, el.clientWidth * 0.8), behavior: 'smooth' });
  };
  // On the wrapper, so it also works while the pointer is over an edge button.
  const scrollAtEdges = (e) => {
    const el = ref.current;
    if (!dragging || !el) return;
    const { left, right } = el.getBoundingClientRect();
    if (e.clientX > right - 70) el.scrollLeft += 24;
    else if (e.clientX < left + 70) el.scrollLeft -= 24;
  };
  return (
    <div className="board" onDragOver={scrollAtEdges}>
      <div className="kanban" ref={ref} onScroll={measure}>{children}</div>
      {more.left && <div className="board-edge left"><button type="button" aria-label="Earlier stages" title="Earlier stages" onClick={() => nudge(-1)}><Icon name="chevronLeft" size={16} /></button></div>}
      {more.right && <div className="board-edge right"><button type="button" aria-label="Later stages" title="Later stages" onClick={() => nudge(1)}><Icon name="chevronRight" size={16} /></button></div>}
    </div>
  );
}
