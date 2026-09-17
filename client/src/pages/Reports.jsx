import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CUSTOMER_TYPES, ORDER_STAGES, labelOf } from '@shared/constants.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { formatValue, date, downloadCsv, todayStr, addDaysStr, monthLabel } from '../lib/format.js';
import { Button, Card, DataTable, Input, PageHeader, Select, Spinner, Tile, EmptyState } from '../components/ui.jsx';
import { BarChartH, ColumnChart, LineChart } from '../components/charts.jsx';

const RANGES = [
  { value: 'fy', label: 'This financial year' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
  { value: 'custom', label: 'Custom range' },
];

function fyStart() {
  const t = todayStr();
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

export default function Reports() {
  const [f, setFilter] = useUrlFilters({ report: 'lead_sources', range: 'fy' });
  const { data: list } = useApi('/reports');
  const from = f.range === 'custom' ? f.from : f.range === 'fy' ? fyStart() : addDaysStr(todayStr(), -Number(f.range));
  const to = f.range === 'custom' ? f.to : todayStr();
  const { data, loading } = useApi(`/reports/${f.report}`, { from, to });
  const [chartGroup, setChartGroup] = useState(null);

  const groups = [...new Set((list || []).map((r) => r.group))];
  const chartRows = data?.chart?.filter ? data.rows.filter((r) => r[Object.keys(data.chart.filter)[0]] === (chartGroup || Object.values(data.chart.filter)[0])) : data?.rows;
  const filterKey = data?.chart?.filter ? Object.keys(data.chart.filter)[0] : null;
  const filterOptions = filterKey ? [...new Set(data.rows.map((r) => r[filterKey]))] : [];

  return (
    <div className="stack">
      <PageHeader title="Reports & analytics" subtitle="Conversion, revenue, delivery, receivables, service and forecast"
        actions={data && (
          <Button icon="download" onClick={() => downloadCsv(`${f.report}.csv`, data.columns, data.rows)}>Export CSV</Button>
        )} />
      <div className="grid" style={{ gridTemplateColumns: '240px minmax(0, 1fr)', alignItems: 'start' }}>
        <Card title="Reports">
          {!list ? <Spinner /> : groups.map((g) => (
            <div key={g} style={{ marginBottom: 10 }}>
              <div className="tiny muted strong" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{g}</div>
              {list.filter((r) => r.group === g).map((r) => (
                <button key={r.key} type="button" onClick={() => { setFilter({ report: r.key }); setChartGroup(null); }}
                  className={`btn ghost sm ${f.report === r.key ? 'on' : ''}`}
                  style={{ width: '100%', justifyContent: 'flex-start', color: f.report === r.key ? 'var(--accent)' : undefined, background: f.report === r.key ? 'var(--accent-soft)' : undefined, fontWeight: f.report === r.key ? 600 : 400 }}>
                  {r.label}
                </button>
              ))}
            </div>
          ))}
        </Card>

        <div className="stack" style={{ minWidth: 0, opacity: loading ? 0.6 : 1 }}>
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <Select className="sm" value={f.range} onChange={(e) => setFilter({ range: e.target.value })} options={RANGES} />
            {f.range === 'custom' && <>
              <Input type="date" className="sm" style={{ width: 150 }} value={f.from || ''} onChange={(e) => setFilter({ from: e.target.value })} />
              <Input type="date" className="sm" style={{ width: 150 }} value={f.to || ''} onChange={(e) => setFilter({ to: e.target.value })} />
            </>}
            <span className="small muted">{date(from)} – {date(to)}</span>
          </div>

          {!data ? <Spinner /> : (
            <>
              <div>
                <h2 style={{ marginBottom: 4 }}>{data.label}</h2>
                {data.kpis && (
                  <div className="tiles" style={{ marginTop: 10 }}>
                    {data.kpis.map((k) => <Tile key={k.label} label={k.label} value={k.value === undefined ? '—' : formatValue(k.value, k.format)} />)}
                  </div>
                )}
              </div>

              {data.chart && data.rows.length > 0 && (
                <Card title="Chart" actions={filterKey && (
                  <Select className="sm" value={chartGroup || Object.values(data.chart.filter)[0]} onChange={(e) => setChartGroup(e.target.value)} options={filterOptions.map((o) => ({ value: o, label: o }))} />
                )}>
                  <ChartFor spec={data.chart} rows={chartRows} />
                </Card>
              )}

              <Card title="Data" flush>
                <DataTable rows={data.rows} rowKey={data.columns[0].key}
                  columns={data.columns.map((c) => ({
                    key: c.key, label: c.label, align: ['number', 'currency', 'pct', 'days', 'decimal', 'multiple'].includes(c.format) ? 'num' : undefined,
                    render: (r) => (c.key === data.columns[0].key && r.link ? <Link to={r.link}>{formatValue(r[c.key], c.format)}</Link> : formatValue(r[c.key], c.format)),
                  }))}
                  empty={<EmptyState title="No data in this period" message="Try a wider date range." />} />
              </Card>

              {data.detail && (
                <Card title={data.detail.title} flush actions={<Button size="sm" icon="download" onClick={() => downloadCsv(`${f.report}-detail.csv`, data.detail.columns, data.detail.rows)}>Export</Button>}>
                  <DataTable rows={data.detail.rows} rowKey={data.detail.columns[0].key}
                    columns={data.detail.columns.map((c) => ({
                      key: c.key, label: c.label, align: ['number', 'currency', 'pct', 'days', 'decimal', 'multiple'].includes(c.format) ? 'num' : undefined,
                      render: (r) => {
                        const value = c.format === 'order_stage' ? labelOf(ORDER_STAGES, r[c.key]) : c.format === 'customer_type' ? labelOf(CUSTOMER_TYPES, r[c.key]) : formatValue(r[c.key], c.format);
                        return c.key === data.detail.columns[0].key && r.link ? <Link to={r.link}>{value}</Link> : value;
                      },
                    }))} />
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ChartFor({ spec, rows }) {
  const series = spec.series.map((s) => ({ ...s, format: spec.format }));
  const data = spec.limit ? rows.slice(0, spec.limit) : rows;
  // Long category names read better on horizontal bars than in truncated column labels.
  const longLabels = spec.x !== 'month' && data.some((r) => String(r[spec.x] ?? '').length > 12);
  if (spec.type === 'line') return <LineChart data={data} x={spec.x} series={series} format={spec.format} xFormat={spec.x === 'month' ? monthLabel : undefined} />;
  if (spec.horizontal || spec.type === 'donut' || longLabels) return <BarChartH data={data} label={spec.x} series={series} format={spec.format} />;
  if (spec.type === 'stacked') return <BarChartH data={data} label={spec.x} series={series} format={spec.format} stacked />;
  return <ColumnChart data={data} x={spec.x} series={series} format={spec.format} height={280} xFormat={spec.x === 'month' ? monthLabel : undefined} />;
}
