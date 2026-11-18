// Sales dashboard: enquiries, pipeline, quotations, orders, receivables and team performance for a period.
// Values are kept per currency; charts plot the company currency and say so.
import { Link } from 'react-router-dom';
import { labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { compactByCurrency, compactMoney, dateTime, monthLabel, number, pct } from '../lib/format.js';
import { Card, DataTable, ErrorState, PageHeader, Segmented, Select, Spinner, Tile, EmptyState } from '../components/ui.jsx';
import { useMeta, useOptionLabel, usePeople } from '../components/domain.jsx';
import { BarChartH, ColumnChart } from '../components/charts.jsx';

const PERIODS = [{ value: 'month', label: 'This month' }, { value: 'quarter', label: 'This quarter' }, { value: 'fy', label: 'Financial year' }];

export default function Dashboard() {
  const { can, user } = useAuth();
  const meta = useMeta();
  const people = usePeople();
  const optionLabel = useOptionLabel();
  const [f, setFilter] = useUrlFilters({ period: 'fy' });
  const { data: d, error, loading, reload } = useApi('/analytics', { period: f.period, owner: f.owner, region_id: f.region_id });
  const values = can('values.view');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const cur = d?.target_currency || 'INR';
  const fmt = `money:${cur}`;
  const winRate = d?.enquiries && d.enquiries.won + d.enquiries.lost ? (d.enquiries.won / (d.enquiries.won + d.enquiries.lost)) * 100 : null;

  return (
    <div className="stack">
      <PageHeader title="Sales dashboard" subtitle={d ? `${PERIODS.find((p) => p.value === d.period)?.label}: ${d.from} to ${d.to} · updated ${dateTime(d.generated_at)}` : 'Loading…'}
        actions={<>
          <Segmented label="Period" value={f.period} onChange={(period) => setFilter({ period })} options={PERIODS} />
          {user.scope !== 'own' && <Select aria-label="Salesperson" value={f.owner || ''} onChange={(e) => setFilter({ owner: e.target.value })} placeholder="Whole team" options={people.filter((p) => p.group === 'sales').map((p) => ({ value: String(p.id), label: p.name }))} style={{ width: 'auto' }} />}
          {user.scope === 'all' && <Select aria-label="Region" value={f.region_id || ''} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="All regions" options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} style={{ width: 'auto' }} />}
        </>} />
      {!d && loading && <Spinner />}
      {d && (
        <>
          <div className="tiles">
            {d.enquiries && <Tile icon="inbox" label="Enquiries received" value={number(d.enquiries.received)} foot={`${number(d.enquiries.open)} open · ${number(d.enquiries.hot)} hot`} to="/enquiries" />}
            {d.enquiries && values && <Tile icon="pipeline" label="Open pipeline" value={compactByCurrency(d.enquiries.pipeline_value)} foot={`Weighted ${compactByCurrency(d.enquiries.weighted_value)}${d.enquiries.unvalued_open ? ` · ${d.enquiries.unvalued_open} not valued` : ''}`} to="/enquiries?view=pipeline" />}
            {d.quotations && <Tile icon="quotation" label="Quotations issued" value={number(d.quotations.issued)} foot={values ? `${compactByCurrency(d.quotations.issued_value)} · ${d.quotations.awaiting} awaiting decision` : `${d.quotations.awaiting} awaiting decision`} to="/quotations?status=awaiting" />}
            <Tile icon="box" label="Orders confirmed" value={number(d.orders.confirmed)} foot={values ? compactByCurrency(d.orders.value_by_currency) : `${d.orders.active} active orders`} to="/orders" />
          </div>
          <div className="tiles">
            {d.enquiries && <Tile icon="target" label="Win rate" value={winRate === null ? '—' : pct(winRate)} foot={`${d.enquiries.won} won · ${d.enquiries.lost} lost in the period`} />}
            <Tile icon="calendar" label="Follow-ups" value={number(d.followups.overdue)} alert={d.followups.overdue > 0} foot={`overdue · ${d.followups.due_today} due today · ${d.followups.open} open`} to="/followups" />
            {d.receivables && values && <Tile icon="payment" label="Receivables" value={compactByCurrency(d.receivables.outstanding)} alert={Object.values(d.receivables.overdue).some(Boolean)} foot={`Overdue ${compactByCurrency(d.receivables.overdue)} · collected ${compactByCurrency(d.receivables.collected)}`} to="/payments" />}
            <Tile icon="truck" label="Dispatches" value={number(d.orders.dispatches)} foot={`${d.orders.in_transit} in transit · ${d.orders.ready_waiting_lines} lines ready`} to="/dispatches" />
          </div>

          <div className="grid grid-2">
            {values && (
              <Card title="Target vs achievement" sub={`${cur} · financial year`}>
                {d.target_vs_achievement.some((m) => m.target_minor) ? (
                  <ColumnChart data={d.target_vs_achievement.map((m) => ({ ...m, achieved: m.future ? 0 : m.achieved_minor, target: m.target_minor || 0 }))} x="month" xFormat={monthLabel}
                    series={[{ key: 'achieved', label: 'Orders confirmed' }]} target={{ key: 'target', label: 'Target' }} format={fmt} />
                ) : <EmptyState icon="target" title="No targets set" message={can('targets.edit') ? 'Set monthly targets on the Team page.' : 'Targets are set by the sales head.'} />}
              </Card>
            )}
            {values && (
              <Card title="Order intake" sub={`last 12 months · ${cur}`}>
                <ColumnChart data={d.order_trend.map((m) => ({ month: m.month, value: m.value_by_currency[cur] || 0, orders: m.orders }))} x="month" xFormat={monthLabel}
                  series={[{ key: 'value', label: `Order value (${cur})` }]} format={fmt} empty={`No ${cur} orders confirmed in the last 12 months`} />
                {d.order_trend.some((m) => Object.keys(m.value_by_currency).some((c) => c !== cur)) && <div className="tiny muted">Export orders in other currencies are counted in the totals above, not in this chart.</div>}
              </Card>
            )}
            {d.pipeline && (
              <Card title="Pipeline by stage" sub="open enquiries">
                <BarChartH data={d.pipeline} label="label" series={[{ key: 'count', label: 'Enquiries' }]} format="number" />
                {values && <div className="small mt-8">{d.pipeline.filter((s) => Object.keys(s.value_by_currency).length).map((s) => `${s.label}: ${compactByCurrency(s.value_by_currency)}`).join(' · ')}</div>}
              </Card>
            )}
            <Card title="Order lines by phase" sub={`${d.orders.active} active orders · ${d.orders.delayed} delayed · ${d.orders.overdue_lines} lines overdue`}>
              <BarChartH data={d.orders.by_phase} label="label" series={[{ key: 'lines', label: 'Lines' }]} format="number" />
            </Card>
            {d.quotations && (
              <Card title="Quotations">
                <div className="grid grid-3" style={{ gap: 10 }}>
                  <MiniStat k="Accepted" v={d.quotations.accepted} />
                  <MiniStat k="Rejected" v={d.quotations.rejected} />
                  <MiniStat k="Awaiting" v={d.quotations.awaiting} d={values ? compactByCurrency(d.quotations.awaiting_value) : null} />
                  <MiniStat k="Expiring in 7 days" v={d.quotations.expiring_soon} to="/quotations?status=expiring" />
                  <MiniStat k="Awaiting approval" v={d.quotations.approval_pending} to="/quotations?status=approval" />
                </div>
              </Card>
            )}
            {d.enquiry_sources && (
              <Card title="Where enquiries came from" sub="received in the period">
                <BarChartH data={Object.entries(d.enquiry_sources).map(([k, n]) => ({ source: optionLabel('enquiry_source', k) || k, n })).sort((a, b) => b.n - a.n)} label="source" series={[{ key: 'n', label: 'Enquiries' }]} format="number" limit={10} empty="No enquiries received in this period" />
              </Card>
            )}
          </div>

          {d.salespeople?.length > 0 && (
            <Card title="Salespeople" sub={`orders confirmed in the period · targets in ${cur}`} flush>
              <DataTable rows={d.salespeople} columns={[
                { key: 'n', label: 'Salesperson', render: (p) => <div className="col" style={{ gap: 0 }}><strong>{p.name}</strong><span className="tiny muted">{[p.region, labelOf([{ value: 'sales_executive', label: 'Executive' }, { value: 'regional_manager', label: 'Regional manager' }, { value: 'sales_head', label: 'Sales head' }], p.role)].filter(Boolean).join(' · ')}</span></div> },
                { key: 'o', label: 'Orders', align: 'num', render: (p) => number(p.orders) },
                values && { key: 'v', label: 'Order value', align: 'num', render: (p) => compactByCurrency(p.value_by_currency) },
                values && { key: 't', label: 'Target', align: 'num', render: (p) => (p.target_minor ? compactMoney(p.target_minor, p.currency) : '—') },
                values && { key: 'a', label: 'Achievement', render: (p) => (p.achievement_pct === null ? <span className="muted small">No target</span> : (
                  <div className="col" style={{ gap: 3, minWidth: 110 }}>
                    <span className="small num strong">{p.achievement_pct}%</span>
                    <div className={`progress ${p.achievement_pct >= 90 ? 'good' : p.achievement_pct >= 60 ? 'warn' : 'bad'}`}><span style={{ width: `${Math.min(100, p.achievement_pct)}%` }} /></div>
                  </div>
                )) },
                { key: 'w', label: 'Win rate', align: 'num', render: (p) => (p.win_rate_pct === null ? '—' : `${p.win_rate_pct}%`) },
                { key: 'e', label: 'Open enquiries', align: 'num', render: (p) => number(p.open_enquiries) },
                { key: 'f', label: 'Overdue follow-ups', align: 'num', render: (p) => (p.overdue_followups ? <span className="danger-text strong">{p.overdue_followups}</span> : '0') },
              ]} />
            </Card>
          )}

          <div className="grid grid-2">
            {d.by_region?.length > 0 && values && (
              <Card title="Orders by region" flush>
                <DataTable compact rows={d.by_region} rowKey="region_id" columns={[
                  { key: 'r', label: 'Region', render: (r) => <strong>{r.region}</strong> },
                  { key: 'o', label: 'Orders', align: 'num', render: (r) => number(r.orders) },
                  { key: 'v', label: 'Value', align: 'num', render: (r) => compactByCurrency(r.value_by_currency) },
                ]} />
              </Card>
            )}
            {d.by_source?.length > 0 && values && (
              <Card title="Orders by enquiry source" flush>
                <DataTable compact rows={d.by_source} rowKey="source" columns={[
                  { key: 's', label: 'Source', render: (r) => <strong>{r.source === 'direct_order' ? 'Direct order (no enquiry)' : optionLabel('enquiry_source', r.source) || r.source}</strong> },
                  { key: 'o', label: 'Orders', align: 'num', render: (r) => number(r.orders) },
                  { key: 'v', label: 'Value', align: 'num', render: (r) => compactByCurrency(r.value_by_currency) },
                ]} />
              </Card>
            )}
          </div>
          {d.receivables && <div className="tiny muted">{d.receivables.note} Order value is before tax and is not revenue or margin.</div>}
        </>
      )}
    </div>
  );
}

function MiniStat({ k, v, d, to }) {
  const inner = <><span className="tiny muted">{k}</span><span className="strong" style={{ fontSize: 20 }}>{number(v)}</span>{d && <span className="tiny muted">{d}</span>}</>;
  return to ? <Link to={to} className="col" style={{ gap: 0, color: 'inherit' }}>{inner}</Link> : <div className="col" style={{ gap: 0 }}>{inner}</div>;
}
