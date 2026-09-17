import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ORDER_STAGES, labelOf, ROLES, FOLLOWUP_TYPES, QUOTATION_STATUSES } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inrCompact, number, date, relativeDay, monthLabel, pct } from '../lib/format.js';
import { Badge, Card, ErrorState, PageHeader, Select, Spinner, Tabs, Tile, EmptyState, OptionBadge, Button } from '../components/ui.jsx';
import { ColumnChart, BarChartH, Meter } from '../components/charts.jsx';
import { useMeta, userOptions } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const PERIODS = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'fy', label: 'Financial year' },
];

export default function Dashboard() {
  const { user, can } = useAuth();
  const meta = useMeta();
  const [period, setPeriod] = useState('fy');
  const [regionId, setRegionId] = useState('');
  const [owner, setOwner] = useState('');
  const { data: d, error, loading, reload } = useApi('/dashboard', { period, region_id: regionId, owner });
  const [actionTab, setActionTab] = useState('overdue_followups');

  if (error && !d) return <ErrorState error={error} onRetry={reload} />;
  if (!d) return <Spinner />;

  const sales = can('leads.view');
  const finance = can('payments.view');
  const periodLabel = PERIODS.find((p) => p.value === period).label.toLowerCase();
  const a = d.actions;
  const actionTabs = [
    { key: 'overdue_followups', label: 'Overdue follow-ups', count: a.overdue_followups.length },
    can('quotations.view') && { key: 'expiring_quotations', label: 'Expiring quotations', count: a.expiring_quotations.length },
    { key: 'delayed_production', label: 'Delayed production', count: a.delayed_production.length },
    can('quotations.view') && { key: 'pending_approvals', label: 'Pending approvals', count: a.pending_approvals.length },
    finance && { key: 'unpaid_invoices', label: 'Unpaid invoices', count: a.unpaid_invoices.length },
  ].filter(Boolean);
  const activeTab = actionTabs.some((t) => t.key === actionTab) ? actionTab : actionTabs[0].key;
  const fyTarget = d.monthly?.reduce((s, m) => s + m.target, 0) || 0;
  const fyAchieved = d.monthly?.reduce((s, m) => s + m.achieved, 0) || 0;
  const ytdTarget = d.monthly?.filter((m) => !m.future).reduce((s, m) => s + m.target, 0) || 0;

  return (
    <div className="stack" style={{ opacity: loading ? 0.7 : 1, transition: 'opacity .15s' }}>
      <PageHeader
        title={`${greeting()}, ${user.name.split(' ')[0]}`}
        subtitle={`${labelOf(ROLES, user.role)}${user.region_name ? ` · ${user.region_name}` : ''}${user.factory_name ? ` · ${user.factory_name}` : ''} · figures for ${periodLabel} (${date(d.from)} – ${date(d.to)})`}
        actions={(
          <>
            <div className="btn-group" role="group" aria-label="Period">
              {PERIODS.map((p) => <button key={p.value} type="button" className={`btn sm ${period === p.value ? 'on' : ''}`} onClick={() => setPeriod(p.value)}>{p.label}</button>)}
            </div>
            {user.scope === 'all' && sales && <Select className="sm" style={{ width: 150 }} value={regionId} onChange={(e) => setRegionId(e.target.value)} placeholder="All regions" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} />}
            {['all', 'region'].includes(user.scope) && sales && (
              <Select className="sm" style={{ width: 190 }} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="All salespeople"
                options={userOptions(meta.users.filter((u) => !regionId || u.region_id === Number(regionId)).filter((u) => user.scope === 'all' || u.region_id === user.region_id), ['sales_executive', 'regional_manager'])} />
            )}
          </>
        )}
      />

      {sales && (
        <div className="tiles">
          <Tile icon="leads" label="Total leads" value={number(d.leads.count)} foot={`${number(d.leads.new_this_month)} new this month · ${number(d.leads.open_count)} open`} to="/leads" />
          <Tile icon="followups" label="Follow-ups due today" value={number(d.followups.due_today)} foot={d.followups.overdue ? <span className="danger-text">{d.followups.overdue} overdue</span> : 'Nothing overdue'} to="/followups" alert={d.followups.overdue > 0} />
          <Tile icon="pipeline" label="Open pipeline" value={inrCompact(d.leads.pipeline_value)} foot={`Weighted ${inrCompact(d.leads.weighted_value)} · ${d.leads.hot} hot`} to="/opportunities" />
          <Tile icon="quotations" label={`Quotations sent (${periodLabel})`} value={number(d.quotations?.sent)} foot={`Value ${inrCompact(d.quotations?.sent_value)}`} to="/quotations" />
          <Tile icon="clock" label="Awaiting customer response" value={number(d.quotations?.awaiting)} foot={`${inrCompact(d.quotations?.awaiting_value)} on the table`} to="/quotations?status=awaiting" />
          <Tile icon="check" label="Quotations accepted / rejected" value={<span>{number(d.quotations?.accepted)} <span className="muted" style={{ fontSize: 16 }}>/ {number(d.quotations?.rejected)}</span></span>} foot={`${d.quotations?.approval_pending || 0} awaiting internal approval`} to="/quotations?status=won" />
        </div>
      )}

      <div className="tiles">
        {d.orders.order_value !== undefined && <Tile icon="orders" label={`Confirmed order value (${periodLabel})`} value={inrCompact(d.orders.order_value)} foot={`${d.orders.confirmed_count} orders`} to="/orders?include_closed=1" />}
        <Tile icon="production" label="Orders under production" value={number(d.orders.under_production)} foot={d.orders.under_production_value !== undefined ? inrCompact(d.orders.under_production_value) : `${d.orders.awaiting_commercial} awaiting commercial clearance`} to="/production" />
        <Tile icon="box" label="Ready for dispatch" value={number(d.orders.ready_for_dispatch)} foot={d.orders.ready_value !== undefined ? inrCompact(d.orders.ready_value) : `${d.orders.in_transit} in transit`} to="/dispatches" />
        <Tile icon="alert" label="Delayed orders" value={number(d.orders.delayed)} foot="Past committed delivery date" to="/orders?delayed=1" alert={d.orders.delayed > 0} />
        {finance && <Tile icon="rupee" label="Outstanding payments" value={inrCompact(d.payments.outstanding)} foot={<span className={d.payments.overdue > 0 ? 'danger-text' : ''}>{inrCompact(d.payments.overdue)} overdue</span>} to="/payments" alert={d.payments.overdue > 0} />}
        {finance && <Tile icon="payments" label={`Collected (${periodLabel})`} value={inrCompact(d.payments.collected)} foot={`${d.payments.invoices} open invoices`} to="/payments" />}
      </div>

      <Card title="Action required" sub="Items that need someone to act today" flush>
        <div style={{ padding: '4px 16px 0' }}>
          <Tabs tabs={actionTabs} value={activeTab} onChange={setActionTab} />
        </div>
        <ActionList tab={activeTab} actions={a} />
      </Card>

      {sales && d.monthly && (
        <div className="grid grid-3">
          <Card title="Monthly target vs achievement" sub="Order value excluding GST, this financial year" className="span-2">
            <ColumnChart data={d.monthly} x="month" xFormat={monthLabel} format="currency" height={250}
              series={[{ key: 'achieved', label: 'Achieved' }]} target={{ key: 'target', label: 'Target' }}
              emphasize={(m) => !m.future} />
          </Card>
          <Card title="Target progress">
            <div className="stack">
              <div>
                <div className="muted small">Achieved this financial year</div>
                <div className="hero-figure">{inrCompact(fyAchieved)}</div>
                <div className="small muted">of {inrCompact(fyTarget)} annual target</div>
              </div>
              <Meter label="Against year-to-date target" value={fyAchieved} max={ytdTarget || 1} />
              <Meter label="Against full-year target" value={fyAchieved} max={fyTarget || 1} />
              <div className="divider" />
              <div className="small muted">Pipeline cover</div>
              <div className="row between"><span>Weighted open pipeline</span><strong>{inrCompact(d.leads.weighted_value)}</strong></div>
              <div className="row between"><span>Remaining annual target</span><strong>{inrCompact(Math.max(0, fyTarget - fyAchieved))}</strong></div>
            </div>
          </Card>
        </div>
      )}

      {sales && (
        <Card title="Salesperson performance" sub={`${periodLabel} · revenue excludes GST`} flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Salesperson</th><th>Region</th><th className="num">Open leads</th><th className="num">Pipeline</th><th className="num">Quotes sent</th>
                  <th className="num">Orders</th><th className="num">Revenue</th><th style={{ width: 160 }}>Target achievement</th><th className="num">Win rate</th><th className="num">Overdue F/U</th>
                </tr>
              </thead>
              <tbody>
                {d.salespeople.map((p) => (
                  <tr key={p.id}>
                    <td><button type="button" className="btn ghost xs" onClick={() => setOwner(String(p.id))} title="Filter dashboard">{p.name}</button></td>
                    <td className="secondary">{p.region}</td>
                    <td className="num">{p.open_leads}</td>
                    <td className="num">{inrCompact(p.pipeline_value)}</td>
                    <td className="num">{p.quotes_sent}</td>
                    <td className="num">{p.orders}</td>
                    <td className="num strong">{inrCompact(p.won_value)}</td>
                    <td>{p.target ? <div className="row"><div className="grow"><Meter value={p.won_value} max={p.target} /></div><span className="small num">{p.achievement_pct}%</span></div> : <span className="muted small">No target</span>}</td>
                    <td className="num">{p.conversion_pct === null ? '—' : pct(p.conversion_pct, 0)}</td>
                    <td className="num">{p.overdue_followups ? <span className="pill-count red">{p.overdue_followups}</span> : <span className="muted">0</span>}</td>
                  </tr>
                ))}
                {!d.salespeople.length && <tr><td colSpan={10}><EmptyState title="No salespeople in this view" /></td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {sales && (
        <div className="grid grid-3">
          <Card title="Open pipeline by stage" sub="Estimated value">
            <BarChartH data={d.pipeline.filter((p) => p.count > 0)} label="label" series={[{ key: 'value', label: 'Pipeline value' }]} format="currency" />
          </Card>
          <Card title="Region-wise sales" sub={`Order value, ${periodLabel}`}>
            {d.by_region.length ? <BarChartH data={d.by_region} label="region" series={[{ key: 'value', label: 'Order value' }]} format="currency" /> : <EmptyState title="No orders yet" />}
          </Card>
          <Card title="Source-wise sales" sub={`Orders by original lead source, ${periodLabel}`}>
            {d.by_source.length ? <BarChartH data={[...d.by_source].sort((x, y) => y.value - x.value)} label="source" series={[{ key: 'value', label: 'Order value' }]} format="currency" /> : <EmptyState title="No data" />}
          </Card>
        </div>
      )}

      {finance && (
        <Card title="Receivables ageing" sub="Outstanding balance by invoice age" actions={<Button size="sm" to="/payments">Open payments</Button>}>
          <BarChartH data={[
            { bucket: '0–30 days', value: d.payments.d0_30 },
            { bucket: '31–60 days', value: d.payments.d31_60 },
            { bucket: '61–90 days', value: d.payments.d61_90 },
            { bucket: '90+ days', value: d.payments.d90_plus },
          ]} label="bucket" series={[{ key: 'value', label: 'Outstanding' }]} format="currency" />
        </Card>
      )}
    </div>
  );
}

function ActionList({ tab, actions }) {
  const rows = actions[tab] || [];
  if (!rows.length) return <EmptyState icon="check" title="All clear" message="Nothing needs attention here." />;
  return (
    <div className="action-list" style={{ maxHeight: 360, overflowY: 'auto' }}>
      {tab === 'overdue_followups' && rows.map((f) => (
        <Link key={f.id} className="action-row" to={f.lead_id ? `/leads/${f.lead_id}` : f.quotation_id ? `/quotations/${f.quotation_id}` : f.order_id ? `/orders/${f.order_id}` : f.customer_id ? `/customers/${f.customer_id}` : '/followups'}>
          <Icon name="clock" size={16} className="danger-text" />
          <span className="grow truncate"><span className="strong">{f.title}</span> <span className="muted">· {f.customer_name}</span></span>
          <span className="small muted nowrap">{labelOf(FOLLOWUP_TYPES, f.type)}</span>
          {f.escalated_at && <Badge color="red" size="sm">Escalated</Badge>}
          <span className="small nowrap">{f.owner_name}</span>
          <span className="small danger-text nowrap" style={{ width: 90, textAlign: 'right' }}>{relativeDay(f.due_date)}</span>
        </Link>
      ))}
      {tab === 'expiring_quotations' && rows.map((q) => (
        <Link key={q.id} className="action-row" to={`/quotations/${q.id}`}>
          <Icon name="quotations" size={16} />
          <span className="grow truncate"><span className="strong">{q.number}</span> <span className="muted">· {q.customer_name}</span></span>
          <OptionBadge list={QUOTATION_STATUSES} value={q.status} size="sm" />
          <span className="small num nowrap">{inrCompact(q.grand_total)}</span>
          <span className="small nowrap">{q.owner_name}</span>
          <span className="small warning-text nowrap" style={{ width: 90, textAlign: 'right' }}>expires {relativeDay(q.valid_until)}</span>
        </Link>
      ))}
      {tab === 'delayed_production' && rows.map((o) => (
        <Link key={o.id} className="action-row" to={`/orders/${o.id}`}>
          <Icon name="production" size={16} />
          <span className="grow truncate"><span className="strong">{o.number}</span> <span className="muted">· {o.customer_name}</span></span>
          <OptionBadge list={ORDER_STAGES} value={o.stage} size="sm" />
          {o.material_status === 'shortage' && <Badge color="red" size="sm">Material shortage</Badge>}
          {o.qc_status === 'failed' && <Badge color="red" size="sm">QC failed</Badge>}
          <span className="small muted truncate" style={{ maxWidth: 200 }}>{o.delay_reason || 'No delay reason recorded'}</span>
          <span className="small danger-text nowrap" style={{ width: 110, textAlign: 'right' }}>{o.delay_days ? `${o.delay_days} days late` : `completion ${relativeDay(o.planned_completion)}`}</span>
        </Link>
      ))}
      {tab === 'pending_approvals' && rows.map((x) => (
        <Link key={x.id} className="action-row" to={`/quotations/${x.quotation_id}`}>
          <Icon name="shield" size={16} />
          <span className="grow truncate"><span className="strong">{x.number}</span> <span className="muted">· {x.customer_name} · {x.reasons.join('; ')}</span></span>
          <span className="small num nowrap">{inrCompact(x.amount)}</span>
          <Badge color="amber" size="sm">{labelOf(ROLES, x.required_role)}</Badge>
          <span className="small nowrap">{x.requested_by_name}</span>
        </Link>
      ))}
      {tab === 'unpaid_invoices' && rows.map((i) => (
        <Link key={i.id} className="action-row" to={`/payments?customer=${i.customer_id}`}>
          <Icon name="rupee" size={16} />
          <span className="grow truncate"><span className="strong">{i.number}</span> <span className="muted">· {i.customer_name}</span></span>
          <span className="small num nowrap strong">{inrCompact(i.balance)}</span>
          <span className="small muted nowrap">due {date(i.due_date)}</span>
          <span className="small danger-text nowrap" style={{ width: 110, textAlign: 'right' }}>{i.days_overdue} days overdue</span>
        </Link>
      ))}
    </div>
  );
}
