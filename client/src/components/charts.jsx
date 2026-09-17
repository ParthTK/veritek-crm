// SVG charts following the dataviz mark specs: thin rounded bars from one baseline,
// 2px lines, hairline grid, fixed categorical order, legend for 2+ series, hover tooltips.
import { useState } from 'react';
import { useElementWidth } from '../lib/hooks.js';
import { formatValue, inrCompact, number } from '../lib/format.js';

export const seriesColor = (i) => `var(--series-${(i % 8) + 1})`;

function niceScale(maxValue, ticks = 4) {
  if (!(maxValue > 0)) return { max: 1, step: 0.25 };
  const raw = maxValue / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(maxValue / step) * step, step };
}

function axisFormat(value, format) {
  if (format === 'currency') return inrCompact(value).replace('.00', '');
  if (format === 'pct') return `${number(value)}%`;
  if (format === 'days') return `${number(value)}d`;
  return number(value, value < 10 && value % 1 ? 1 : 0);
}

function roundedBar(x, y, w, h, r, orientation = 'up') {
  if (h <= 0 || w <= 0) return '';
  if (orientation === 'up') {
    const rr = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
  }
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

export function Legend({ items }) {
  if (!items || items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <i className={it.type || ''} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ tip, width }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 0), Math.max(0, width - 190));
  return (
    <div className="viz-tooltip" style={{ left, top: Math.max(0, tip.y - 10) }}>
      <div className="t-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="t-row">
          <span className="key" style={{ background: r.color }} />
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Vertical columns. series: [{ key, label }]. `target` draws a tick per column (e.g. monthly target).
 * `colorIndex` lets a series keep its entity colour when others are filtered out.
 */
export function ColumnChart({ data = [], x, series, format, height = 240, stacked = false, target, xFormat = (v) => v, emphasize }) {
  const [ref, width] = useElementWidth();
  const [tip, setTip] = useState(null);
  const [hover, setHover] = useState(null);
  const margin = { top: 12, right: 8, bottom: 28, left: 54 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const totals = data.map((d) => (stacked ? series.reduce((s, se) => s + (Number(d[se.key]) || 0), 0) : Math.max(0, ...series.map((se) => Number(d[se.key]) || 0))));
  const maxVal = Math.max(...totals, ...(target ? data.map((d) => Number(d[target.key]) || 0) : [0]));
  const { max, step } = niceScale(maxVal);
  const yOf = (v) => margin.top + plotH - (v / max) * plotH;
  const band = data.length ? plotW / data.length : 0;
  const groupCount = stacked ? 1 : series.length;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - (groupCount - 1) * 2) / groupCount));
  const groupW = groupCount * barW + (groupCount - 1) * 2;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 58))));
  const legend = [...series.map((s, i) => ({ label: s.label, color: seriesColor(s.colorIndex ?? i) })), ...(target ? [{ label: target.label, type: 'tick', color: 'var(--text-2)' }] : [])];

  const showTip = (i, evt) => {
    const d = data[i];
    const box = ref.current.getBoundingClientRect();
    setHover(i);
    setTip({
      x: evt.clientX - box.left, y: evt.clientY - box.top, title: xFormat(d[x]),
      rows: [
        ...series.map((s, si) => ({ label: s.label, value: formatValue(d[s.key], s.format || format), color: seriesColor(s.colorIndex ?? si) })),
        ...(target ? [{ label: target.label, value: formatValue(d[target.key], format), color: 'var(--text-2)' }] : []),
      ],
    });
  };

  return (
    <div>
      <Legend items={legend} />
      <div className="chart" ref={ref} style={{ height }} onMouseLeave={() => { setTip(null); setHover(null); }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`Chart of ${series.map((s) => s.label).join(', ')}`}>
            {Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className={v === 0 ? 'axis-line' : 'grid-line'} x1={margin.left} x2={width - margin.right} y1={yOf(v)} y2={yOf(v)} />
                <text x={margin.left - 8} y={yOf(v) + 4} textAnchor="end">{axisFormat(v, format)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = margin.left + band * i + band / 2;
              const dim = hover !== null && hover !== i ? 'dim' : '';
              const emph = emphasize && !emphasize(d) ? 'dim' : '';
              let marks;
              if (stacked) {
                let acc = 0;
                const visible = series.filter((s) => Number(d[s.key]) > 0);
                marks = series.map((s, si) => {
                  const v = Number(d[s.key]) || 0;
                  if (v <= 0) return null;
                  const y1 = yOf(acc + v);
                  const y0 = yOf(acc);
                  acc += v;
                  const isTop = visible[visible.length - 1] === s;
                  const h = Math.max(0, y0 - y1 - (isTop ? 0 : 2));
                  return <path key={s.key} className={`mark ${dim} ${emph}`} d={isTop ? roundedBar(cx - barW / 2, y1, barW, h, 4) : `M${cx - barW / 2},${y1 + 2}h${barW}v${Math.max(0, y0 - y1 - 2)}h${-barW}Z`} fill={seriesColor(s.colorIndex ?? si)} />;
                });
              } else {
                marks = series.map((s, si) => {
                  const v = Math.max(0, Number(d[s.key]) || 0);
                  const bx = cx - groupW / 2 + si * (barW + 2);
                  return <path key={s.key} className={`mark ${dim} ${emph}`} d={roundedBar(bx, yOf(v), barW, yOf(0) - yOf(v), 4)} fill={seriesColor(s.colorIndex ?? si)} />;
                });
              }
              const t = target ? Number(d[target.key]) || 0 : 0;
              return (
                <g key={i}>
                  {marks}
                  {target && t > 0 && <line x1={cx - Math.max(groupW, 14) / 2 - 4} x2={cx + Math.max(groupW, 14) / 2 + 4} y1={yOf(t)} y2={yOf(t)} stroke="var(--text-2)" strokeWidth={2} strokeLinecap="round" />}
                  {i % labelEvery === 0 && <text x={cx} y={height - 8} textAnchor="middle">{String(xFormat(d[x])).slice(0, 14)}</text>}
                  <rect className="hit" x={margin.left + band * i} y={margin.top} width={band} height={plotH} onMouseMove={(e) => showTip(i, e)} />
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </div>
  );
}

/** Horizontal bars with category labels on the left; good for long names. */
export function BarChartH({ data = [], label, series, format, limit, stacked = false, onSelect }) {
  const [ref, width] = useElementWidth();
  const [tip, setTip] = useState(null);
  const rows = limit ? data.slice(0, limit) : data;
  const rowH = stacked || series.length === 1 ? 26 : 16 + series.length * 12;
  const labelW = Math.min(180, Math.max(90, width * 0.32));
  const valueW = 64;
  const plotW = Math.max(10, width - labelW - valueW - 12);
  const totals = rows.map((d) => (stacked ? series.reduce((s, se) => s + (Number(d[se.key]) || 0), 0) : Math.max(0, ...series.map((se) => Number(d[se.key]) || 0))));
  const max = Math.max(...totals, 0) || 1;
  const height = rows.length * rowH + 4;
  const barH = stacked || series.length === 1 ? 12 : 10;

  const showTip = (d, evt) => {
    const box = ref.current.getBoundingClientRect();
    setTip({
      x: evt.clientX - box.left, y: evt.clientY - box.top, title: d[label],
      rows: series.map((s, si) => ({ label: s.label, value: formatValue(d[s.key], s.format || format), color: seriesColor(s.colorIndex ?? si) })),
    });
  };

  return (
    <div>
      <Legend items={series.map((s, i) => ({ label: s.label, color: seriesColor(s.colorIndex ?? i) }))} />
      <div className="chart" ref={ref} style={{ height }} onMouseLeave={() => setTip(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Bar chart">
            <line className="axis-line" x1={labelW} x2={labelW} y1={0} y2={height} />
            {rows.map((d, i) => {
              const y = i * rowH + 4;
              let acc = 0;
              const total = totals[i];
              return (
                <g key={`${d[label]}-${i}`} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={onSelect ? () => onSelect(d) : undefined}>
                  <text x={labelW - 8} y={y + rowH / 2 + 2} textAnchor="end" style={{ fill: 'var(--text-2)' }}>{String(d[label] ?? '—').slice(0, 26)}</text>
                  {stacked ? series.map((s, si) => {
                    const v = Number(d[s.key]) || 0;
                    if (v <= 0) return null;
                    const x0 = labelW + (acc / max) * plotW;
                    acc += v;
                    const w = (v / max) * plotW;
                    const last = acc >= total - 1e-9;
                    return <path key={s.key} d={last ? roundedBar(x0, y + (rowH - barH) / 2 - 2, Math.max(1, w), barH, 4, 'right') : `M${x0},${y + (rowH - barH) / 2 - 2}h${Math.max(0.5, w - 2)}v${barH}h${-Math.max(0.5, w - 2)}Z`} fill={seriesColor(s.colorIndex ?? si)} />;
                  }) : series.map((s, si) => {
                    const v = Math.max(0, Number(d[s.key]) || 0);
                    const by = series.length === 1 ? y + (rowH - barH) / 2 - 2 : y + 4 + si * 12;
                    return <path key={s.key} d={roundedBar(labelW, by, Math.max(v > 0 ? 2 : 0, (v / max) * plotW), barH, 4, 'right')} fill={seriesColor(s.colorIndex ?? si)} />;
                  })}
                  {series.length === 1 || stacked ? (
                    <text className="value-label" x={labelW + ((stacked ? total : Number(d[series[0].key]) || 0) / max) * plotW + 6} y={y + rowH / 2 + 2}>
                      {formatValue(stacked ? total : d[series[0].key], series[0].format || format)}
                    </text>
                  ) : null}
                  <rect className="hit" x={0} y={y - 2} width={width} height={rowH} onMouseMove={(e) => showTip(d, e)} />
                </g>
              );
            })}
          </svg>
        )}
        <Tooltip tip={tip} width={width} />
      </div>
    </div>
  );
}

/** Multi-series line chart with a snapping crosshair and one tooltip for all series. */
export function LineChart({ data = [], x, series, format, height = 220, xFormat = (v) => v }) {
  const [ref, width] = useElementWidth();
  const [idx, setIdx] = useState(null);
  const margin = { top: 12, right: 16, bottom: 28, left: 50 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const maxVal = Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const { max, step } = niceScale(maxVal);
  const xOf = (i) => margin.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yOf = (v) => margin.top + plotH - ((Number(v) || 0) / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 58))));

  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const px = e.clientX - box.left - margin.left;
    const i = data.length <= 1 ? 0 : Math.round((px / plotW) * (data.length - 1));
    setIdx(Math.max(0, Math.min(data.length - 1, i)));
  };

  return (
    <div>
      <Legend items={series.map((s, i) => ({ label: s.label, color: seriesColor(s.colorIndex ?? i), type: 'line' }))} />
      <div className="chart" ref={ref} style={{ height }} onMouseMove={onMove} onMouseLeave={() => setIdx(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`Line chart of ${series.map((s) => s.label).join(', ')}`}>
            {Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className={v === 0 ? 'axis-line' : 'grid-line'} x1={margin.left} x2={width - margin.right} y1={yOf(v)} y2={yOf(v)} />
                <text x={margin.left - 8} y={yOf(v) + 4} textAnchor="end">{axisFormat(v, format)}</text>
              </g>
            ))}
            {data.map((d, i) => i % labelEvery === 0 && <text key={i} x={xOf(i)} y={height - 8} textAnchor="middle">{xFormat(d[x])}</text>)}
            {series.map((s, si) => (
              <g key={s.key}>
                <path d={data.map((d, i) => `${i ? 'L' : 'M'}${xOf(i)},${yOf(d[s.key])}`).join('')} fill="none" stroke={seriesColor(s.colorIndex ?? si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {data.length > 0 && <circle cx={xOf(data.length - 1)} cy={yOf(data[data.length - 1][s.key])} r={4} fill={seriesColor(s.colorIndex ?? si)} stroke="var(--surface)" strokeWidth={2} />}
              </g>
            ))}
            {idx !== null && (
              <g>
                <line x1={xOf(idx)} x2={xOf(idx)} y1={margin.top} y2={margin.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
                {series.map((s, si) => <circle key={s.key} cx={xOf(idx)} cy={yOf(data[idx][s.key])} r={4} fill={seriesColor(s.colorIndex ?? si)} stroke="var(--surface)" strokeWidth={2} />)}
              </g>
            )}
          </svg>
        )}
        {idx !== null && width > 0 && (
          <Tooltip width={width} tip={{
            x: xOf(idx), y: margin.top, title: xFormat(data[idx][x]),
            rows: series.map((s, si) => ({ label: s.label, value: formatValue(data[idx][s.key], s.format || format), color: seriesColor(s.colorIndex ?? si) })),
          }} />
        )}
      </div>
    </div>
  );
}

/** Stat-style single-ratio meter with severity fill. */
export function Meter({ value, max = 100, label, tone }) {
  const pctValue = max ? Math.min(100, (value / max) * 100) : 0;
  const auto = tone || (pctValue >= 90 ? 'good' : pctValue >= 60 ? 'warn' : 'bad');
  return (
    <div className="col" style={{ gap: 4 }}>
      {label && <div className="row between small"><span className="muted">{label}</span><span className="num">{Math.round(pctValue)}%</span></div>}
      <div className={`progress ${auto}`}><span style={{ width: `${pctValue}%` }} /></div>
    </div>
  );
}
