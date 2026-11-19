// A shaded world map: each country with enquiries (or sales) in one of up to five shades of one colour, darker for
// more (lighter for more in dark mode), grey where there are none, with a key saying what each shade means.
// Zoom with the buttons, Ctrl or ⌘ + scroll, or a pinch; drag to move; choosing a country zooms to it. Plain
// scrolling still scrolls the page. The outline (client/src/data/world-map.json, made by scripts/world-map.js)
// loads as its own file the first time a map is shown.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useElementWidth } from '../lib/hooks.js';
import { compactByCurrency, number } from '../lib/format.js';
import { loadFresh } from '../lib/update.js';
import Icon from './Icon.jsx';

let outline = null;
const loadOutline = () => (outline ||= loadFresh(() => import('../data/world-map.json'))().then((m) => m.default));
const WORDS = { enquiries: ['enquiry', 'enquiries'], sales: ['sale', 'sales'] };
const word = (measure, n) => WORDS[measure][n === 1 ? 0 : 1];
const STEPS = 5;
const MAX_ZOOM = 12;
const WORLD = { k: 1, x: 0, y: 0 };

/** Up to five ranges of counts. They grow geometrically, so small markets do not all share the palest shade. */
export function classesFor(max) {
  if (max <= 0) return [];
  if (max <= STEPS) return Array.from({ length: max }, (_, i) => [i + 1, i + 1]);
  const tops = [];
  for (let i = 1; i < STEPS; i++) tops.push(Math.max((tops[i - 2] ?? 0) + 1, Math.ceil(max ** (i / STEPS))));
  const ranges = [];
  let from = 1;
  for (const top of tops) {
    if (top >= max) break;
    ranges.push([from, top]);
    from = top + 1;
  }
  ranges.push([from, max]);
  return ranges;
}
/** Which of the five shades a range takes: spread across them, so two ranges are the palest and the darkest. */
const shadeOf = (i, n) => (n <= 1 ? STEPS : Math.round((i * (STEPS - 1)) / (n - 1)) + 1);

export default function WorldMap({ countries, measure, selected, onSelect, values }) {
  const [ref, width] = useElementWidth();
  const svgRef = useRef(null);
  const [map, setMap] = useState(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState(WORLD);
  const [live, setLive] = useState(false); // a drag, pinch or wheel in progress: no easing
  const [tip, setTip] = useState(null);
  const gesture = useRef({ pointers: new Map(), start: null, moved: false, spread: 0 });
  useEffect(() => {
    let alive = true;
    loadOutline().then((m) => alive && setMap(m), () => {
      outline = null; // let the next visit try again
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const W = map?.width || 1000;
  const H = map?.height || 442;
  const s = width ? width / W : 1; // screen pixels per map unit at the world view
  const clamp = useCallback((v) => {
    const k = Math.min(MAX_ZOOM, Math.max(1, v.k));
    return { k, x: Math.min(0, Math.max(W - W * k, v.x)), y: Math.min(0, Math.max(H - H * k, v.y)) };
  }, [W, H]);
  /** Zooms by `factor` around a point given in map units of the frame (not of the map). */
  const zoomAt = useCallback((factor, fx, fy) => setView((v) => {
    const k = Math.min(MAX_ZOOM, Math.max(1, v.k * factor));
    return clamp({ k, x: fx - ((fx - v.x) * k) / v.k, y: fy - ((fy - v.y) * k) / v.k });
  }), [clamp]);
  const fitTo = useCallback((code) => {
    const box = map?.countries[code]?.box;
    if (!box) return;
    const [x0, y0, x1, y1] = box;
    const k = Math.min(MAX_ZOOM, Math.max(1, Math.min(W / Math.max(x1 - x0, 4), H / Math.max(y1 - y0, 4)) * 0.55));
    setView(clamp({ k, x: W / 2 - (k * (x0 + x1)) / 2, y: H / 2 - (k * (y0 + y1)) / 2 }));
  }, [map, W, H, clamp]);
  // Choosing a country, on the map or in the table, zooms to it; letting go of it goes back to the world.
  useEffect(() => {
    if (!map) return;
    if (selected) fitTo(selected);
    else setView(WORLD);
  }, [selected, map, fitTo]);

  // Ctrl or ⌘ + scroll zooms (as does a trackpad pinch, which arrives the same way); plain scrolling moves the page.
  const wheel = useRef(null);
  wheel.current = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = svgRef.current.getBoundingClientRect();
    setLive(true);
    zoomAt(Math.exp(-e.deltaY * 0.0025), (e.clientX - r.left) / s, (e.clientY - r.top) / s);
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(() => setLive(false), 200);
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const on = (e) => wheel.current(e);
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [map]);

  // Drag to move once zoomed in; two fingers pinch to zoom. A press that does not move is a click.
  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const g = gesture.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1) g.start = { x: e.clientX, y: e.clientY };
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.spread = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const move = (e) => {
    const g = gesture.current;
    const prev = g.pointers.get(e.pointerId);
    if (!prev) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = svgRef.current.getBoundingClientRect();
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.spread) zoomAt(spread / g.spread, ((a.x + b.x) / 2 - r.left) / s, ((a.y + b.y) / 2 - r.top) / s);
      g.spread = spread;
      g.moved = true;
      setLive(true);
      return;
    }
    if (!g.moved && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 4) return;
    if (view.k <= 1 && !g.moved) return; // nothing to move at the world view
    if (!g.moved) {
      g.moved = true;
      setLive(true);
      setTip(null);
      svgRef.current.setPointerCapture?.(e.pointerId);
    }
    setView((v) => clamp({ ...v, x: v.x + (e.clientX - prev.x) / (s || 1), y: v.y + (e.clientY - prev.y) / (s || 1) }));
  };
  const up = (e) => {
    const g = gesture.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.spread = 0;
    if (!g.pointers.size) {
      setLive(false);
      setTimeout(() => {
        g.moved = false; // after the click that follows a drag has been ignored
      }, 0);
    }
  };

  if (failed) {
    return <div className="map-placeholder map-failed">The map could not load. <button type="button" className="btn link" onClick={() => window.location.reload()}>Reload the page</button></div>;
  }
  const data = Object.fromEntries(countries.map((c) => [c.code, c]));
  const max = Math.max(0, ...countries.map((c) => c[measure] || 0));
  const classes = classesFor(max);
  const shade = (v) => {
    const i = classes.findIndex(([a, b]) => v >= a && v <= b);
    return i < 0 ? null : shadeOf(i, classes.length);
  };
  const choose = (code) => {
    if (!gesture.current.moved) onSelect?.(code);
  };
  // On screen: where a map point lands at the current zoom, in pixels from the map's top left.
  const toScreen = (x, y) => [(x * view.k + view.x) * s, (y * view.k + view.y) * s];
  const showAt = (code, e) => {
    if (gesture.current.moved) return;
    const r = ref.current.getBoundingClientRect();
    setTip({ code, left: e.clientX - r.left, top: e.clientY - r.top });
  };
  const focusTip = (code) => {
    const [left, top] = toScreen(map.countries[code].x, map.countries[code].y);
    setTip({ code, left, top });
  };

  // Name the three largest, where the name fits on screen without running into another.
  const labels = [];
  if (map) {
    for (const c of [...countries].filter((x) => x[measure] > 0 && map.countries[x.code]).sort((a, b) => b[measure] - a[measure]).slice(0, 3)) {
      const text = `${c.name} ${number(c[measure])}`;
      const w = text.length * 6.6;
      const [cx, cy] = toScreen(map.countries[c.code].x, map.countries[c.code].y);
      const x0 = cx - w / 2;
      const fits = x0 >= 2 && x0 + w <= width - 40 && cy > 10 && cy < H * s - 6 && !labels.some((l) => x0 < l.x0 + l.w + 6 && l.x0 < x0 + w + 6 && Math.abs(l.cy - cy) < 15);
      if (fits) labels.push({ code: c.code, text, x0, w, cy });
    }
  }
  const tipCountry = tip && data[tip.code];
  const zoomButton = (factor) => () => zoomAt(factor, W / 2, H / 2);

  return (
    <div>
      <div className={`world-map ${view.k > 1 ? 'zoomed' : ''} ${live ? 'live' : ''}`} ref={ref}>
        {!map && <div className="map-placeholder" />}
        {map && (
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${measure === 'sales' ? 'Sales' : 'Enquiries'} by country`}
            style={{ touchAction: view.k > 1 ? 'none' : 'pan-y' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <g className="map-view" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
              <path className="land" d={map.land} />
              {Object.entries(map.countries).map(([code, c]) => {
                const row = data[code];
                const n = row?.[measure] || 0;
                const step = n ? shade(n) : null;
                const active = Boolean(row && (row.enquiries || row.sales));
                return (
                  <path key={code} className={`country ${active ? 'on' : ''}`} d={c.d} style={step ? { fill: `var(--map-${step})` } : undefined}
                    {...(active ? {
                      tabIndex: 0, role: 'button',
                      'aria-label': `${row.name}: ${number(row.enquiries)} ${word('enquiries', row.enquiries)}, ${number(row.sales)} ${word('sales', row.sales)}`,
                      onPointerEnter: (e) => showAt(code, e), onPointerMove: (e) => showAt(code, e), onPointerLeave: () => setTip(null),
                      onFocus: () => focusTip(code), onBlur: () => setTip(null), onClick: () => choose(code),
                      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(code); } },
                    } : {})} />
                );
              })}
              {selected && map.countries[selected] && <path className="sel-outline" d={map.countries[selected].d} />}
            </g>
            {labels.map((l) => (
              <text key={l.code} className="map-label" x={(l.x0 + l.w / 2) / s} y={(l.cy + 4) / s} textAnchor="middle" style={{ fontSize: 11 / s, strokeWidth: 3 / s }}>{l.text}</text>
            ))}
          </svg>
        )}
        {map && (
          <div className="map-zoom">
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={zoomButton(1.8)} disabled={view.k >= MAX_ZOOM}><Icon name="plus" size={15} /></button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={zoomButton(1 / 1.8)} disabled={view.k <= 1}>−</button>
            <button type="button" aria-label="Show the whole world" title="Whole world" onClick={() => (selected ? onSelect?.(selected) : setView(WORLD))} disabled={view.k <= 1}><Icon name="globe" size={15} /></button>
          </div>
        )}
        {map && !classes.length && <div className="map-empty">No {measure} this financial year yet</div>}
        {tipCountry && (
          <div className="viz-tooltip map-tip" style={{ left: Math.min(Math.max(tip.left, 80), Math.max(80, width - 80)), top: tip.top - 12 }}>
            <div className="t-title">{tipCountry.name}</div>
            {['enquiries', 'sales'].map((m) => (
              <div key={m} className="t-row">
                <span className="key" style={{ background: m === measure && shade(tipCountry[m]) ? `var(--map-${shade(tipCountry[m])})` : 'transparent' }} />
                <b>{number(tipCountry[m])}</b>
                <span>{word(m, tipCountry[m])}{m === 'sales' && values && tipCountry.sales > 0 ? ` · ${compactByCurrency(tipCountry.value_by_currency)}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {map && classes.length > 0 && (
        <div className="map-legend">
          <span className="title">{measure === 'sales' ? 'Sales' : 'Enquiries'}</span>
          {classes.map(([a, b], i) => <span key={a}><i style={{ background: `var(--map-${shadeOf(i, classes.length)})` }} />{a === b ? number(a) : `${number(a)}–${number(b)}`}</span>)}
          <span><i className="none" />None</span>
          <span className="hint">Zoom with + and −, Ctrl + scroll or a pinch; drag to move.</span>
        </div>
      )}
    </div>
  );
}
