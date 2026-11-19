// A world map with one circle per country, its area in proportion to the count shown (enquiries or sales), over a
// plain outline of the countries. Circle sizes, labels and hover areas are worked out in screen pixels, so they
// stay the same size on a phone and on a wide screen. The outline (client/src/data/world-map.json, made by
// scripts/world-map.js) loads as its own file the first time a map is shown.
import { useEffect, useState } from 'react';
import { useElementWidth } from '../lib/hooks.js';
import { compactByCurrency, number } from '../lib/format.js';

let outline = null;
const loadOutline = () => (outline ||= import('../data/world-map.json').then((m) => m.default));
const WORDS = { enquiries: ['enquiry', 'enquiries'], sales: ['sale', 'sales'] };
const word = (measure, n) => WORDS[measure][n === 1 ? 0 : 1];

export default function WorldMap({ countries, measure, selected, onSelect, values }) {
  const [ref, width] = useElementWidth();
  const [map, setMap] = useState(null);
  const [tip, setTip] = useState(null);
  useEffect(() => {
    let live = true;
    loadOutline().then((m) => live && setMap(m));
    return () => {
      live = false;
    };
  }, []);
  const k = map && width ? width / map.width : 1; // screen pixels per map unit
  const u = (px) => px / k; // a size in screen pixels, in map units
  const shown = map ? countries.filter((c) => c[measure] > 0 && map.countries[c.code]) : [];
  const max = Math.max(1, ...shown.map((c) => c[measure]));
  const biggest = Math.min(28, Math.max(12, width * 0.03)); // px
  const radius = (v) => Math.max(4, biggest * Math.sqrt(v / max));
  // Largest first, so the smaller circles sit on top and stay reachable.
  const bubbles = shown.map((c) => ({ ...c, at: map.countries[c.code], r: radius(c[measure]) })).sort((a, b) => b.r - a.r);
  const active = new Set(countries.filter((c) => c.enquiries || c.sales).map((c) => c.code));

  // Name the three largest, where the name fits without running into another.
  const labels = [];
  for (const b of [...bubbles].sort((x, y) => y[measure] - x[measure]).slice(0, 3)) {
    const text = `${b.name} ${number(b[measure])}`;
    const w = text.length * 6.6;
    const cx = b.at.x * k;
    const cy = b.at.y * k;
    const fits = (x0) => x0 >= 0 && x0 + w <= width && !labels.some((l) => x0 < l.x0 + l.w + 6 && l.x0 < x0 + w + 6 && Math.abs(l.cy - cy) < 15);
    const right = cx + b.r + 5;
    const left = cx - b.r - 5 - w;
    const x0 = fits(right) ? right : fits(left) ? left : null;
    if (x0 !== null) labels.push({ code: b.code, text, x0, w, cy });
  }

  const tipAt = tip && map ? { left: Math.min(Math.max(tip.at.x * k, 80), Math.max(80, width - 80)), top: tip.at.y * k - tip.r - 8 } : null;
  return (
    <div className="world-map" ref={ref}>
      {map && (
        <svg viewBox={`0 0 ${map.width} ${map.height}`} role="img" aria-label={`${measure === 'sales' ? 'Sales' : 'Enquiries'} by country`}>
          <path className="land" d={map.land} />
          {Object.entries(map.countries).map(([code, c]) => (c.d ? <path key={code} className={`land ${active.has(code) ? 'on' : ''}`} d={c.d} /> : null))}
          {bubbles.map((b) => (
            <g key={b.code} className={`bubble ${selected === b.code ? 'sel' : ''}`} role="button" tabIndex={0}
              aria-label={`${b.name}: ${number(b.enquiries)} ${word('enquiries', b.enquiries)}, ${number(b.sales)} ${word('sales', b.sales)}`}
              onMouseEnter={() => setTip(b)} onMouseLeave={() => setTip(null)} onFocus={() => setTip(b)} onBlur={() => setTip(null)}
              onClick={() => onSelect?.(b.code)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(b.code); } }}>
              <circle className="hit" cx={b.at.x} cy={b.at.y} r={u(Math.max(b.r + 3, 12))} />
              <circle className="mark" cx={b.at.x} cy={b.at.y} r={u(b.r)} />
            </g>
          ))}
          {labels.map((l) => (
            <text key={l.code} className="map-label" x={u(l.x0)} y={u(l.cy + 4)} style={{ fontSize: u(11), strokeWidth: u(3) }}>{l.text}</text>
          ))}
        </svg>
      )}
      {map && !bubbles.length && <div className="map-empty">No {measure} this financial year yet</div>}
      {tipAt && (
        <div className="viz-tooltip map-tip" style={tipAt}>
          <div className="t-title">{tip.name}</div>
          {['enquiries', 'sales'].map((m) => (
            <div key={m} className="t-row">
              <span className="key" style={{ background: m === measure ? 'var(--series-1)' : 'transparent' }} />
              <b>{number(tip[m])}</b>
              <span>{word(m, tip[m])}{m === 'sales' && values && tip.sales > 0 ? ` · ${compactByCurrency(tip.value_by_currency)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {!map && <div className="map-placeholder" />}
      {map && bubbles.length > 0 && (
        <div className="map-key" aria-hidden="true">
          <svg width={(max > 1 ? radius(1) * 2 + 12 : 0) + biggest * 2 + 4} height={biggest * 2 + 4}>
            {max > 1 && <circle cx={radius(1) + 2} cy={biggest + 2} r={radius(1)} />}
            <circle cx={(max > 1 ? radius(1) * 2 + 12 : 0) + biggest + 2} cy={biggest + 2} r={biggest} />
          </svg>
          <span>{max > 1 ? `Circle size: number of ${measure}, from 1 to ${number(max)}` : `Circle size: number of ${measure}`}</span>
        </div>
      )}
    </div>
  );
}
