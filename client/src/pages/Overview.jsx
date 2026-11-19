// The dashboard: enquiries today, replies, pending quotations, active orders, production and delays.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { compactByCurrency, date, number, qty } from '../lib/format.js';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Segmented, Spinner, Tile, Drawer, useToast } from '../components/ui.jsx';
import { ColumnChart, BarChartH } from '../components/charts.jsx';
import { DueBadge, LineStateBadge } from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import WorldMap from '../components/WorldMap.jsx';
import { api } from '../api.js';

export default function Overview() {
  const { can, user } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useApi('/dashboard');
  const [task, setTask] = useState(null);
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('data:changed', on);
    return () => window.removeEventListener('data:changed', on);
  }, [reload]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const openTask = async (id) => {
    try {
      setTask(await api.get(`/tasks/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  };
  if (data.empty.customers) {
    return (
      <div className="stack">
        <PageHeader title="Dashboard" />
        <EmptyState icon="users" title="Start with your first customer" message="Add a customer, then record their enquiries."
          action={<div className="row">{can('customers.edit') && <Button variant="primary" to="/customers">Add a customer</Button>}{can('imports.run') && <Button to="/settings?tab=imports">Import from a sheet</Button>}</div>} />
      </div>
    );
  }
  const t = data.tiles;
  const flow = data.flow;
  const inProduction = flow.production.filter((p) => p.phase !== 'ready').reduce((n, p) => n + p.lines, 0);
  const ready = flow.production.find((p) => p.phase === 'ready')?.lines || 0;
  const followups = [...data.followups.overdue.rows, ...data.followups.today.rows].slice(0, 8);
  const delayed = [...data.order_alerts.overdue.rows, ...data.order_alerts.forecast_late.rows].slice(0, 8);
  return (
    <div className="stack">
      <PageHeader title="Dashboard" />
      <div className="tiles">
        {can('enquiries.view') && <Tile icon="inbox" label="Enquiries today" value={flow.enquiries_today} to="/enquiries?stage=all" foot={`${flow.enquiries_yesterday} yesterday`} />}
        {can('enquiries.view') && <Tile icon="phone" alert={flow.not_replied > 0} label="Not replied" value={flow.not_replied} to="/enquiries?stage=open&reply=unreplied" foot={`${flow.replied} replied`} />}
        {can('quotes.view') && <Tile icon="quotation" label="Pending quotations" value={flow.quotations.not_sent + flow.quotations.sent} to="/quotations?status=pending" foot={`${flow.quotations.not_sent} to send · ${flow.quotations.sent} with customer`} />}
        <Tile icon="box" label="Active orders" value={t.active_orders.count} to="/orders" />
        <Tile icon="factory" label="In production" value={inProduction} to="/production" foot={`${ready} ready to dispatch`} />
        <Tile icon="alert" alert={t.delayed.count > 0} label="Delayed orders" value={t.delayed.count} to="/orders?state=delayed" />
      </div>
      <div className="grid grid-2">
        {can('enquiries.view') && (
          <Card title="Daily enquiries" sub="last 14 days">
            <ColumnChart data={flow.daily_enquiries} x="day" xFormat={(d) => date(d)} stacked height={200} format="number" empty="No enquiries yet" series={[{ key: 'replied', label: 'Replied' }, { key: 'not_replied', label: 'Not replied' }]} />
          </Card>
        )}
        <Card title="Production status"><BarChartH data={flow.production} label="label" format="number" series={[{ key: 'lines', label: 'In this stage' }, { key: 'delayed', label: 'Delayed' }]} /></Card>
      </div>
      {(can('enquiries.view') || can('orders.view')) && <SalesMap />}
      <div className="grid grid-2">
        {can('tasks.edit') && (
          <Card title="Follow-ups due" flush actions={<Button size="sm" variant="ghost" to="/followups">All</Button>}>
            {!followups.length && <div className="empty small">Nothing due.</div>}
            <div className="alert-list">
              {followups.map((r) => (
                <div key={r.id} className="alert-row">
                  <span className="who">{r.customer_name || r.order_code}</span>
                  <span className="small muted grow truncate">{r.purpose}</span>
                  <DueBadge task={r} />
                  {(r.owner_id === user.id || can('tasks.manage_any')) && <Button size="xs" onClick={() => openTask(r.id)}>Update</Button>}
                </div>
              ))}
            </div>
          </Card>
        )}
        <Card title="Delayed orders" flush actions={<Button size="sm" variant="ghost" to="/orders?state=delayed">All</Button>}>
          {!delayed.length && <div className="empty small">No delays.</div>}
          <div className="alert-list">
            {delayed.map((r) => (
              <Link key={r.line_id} to={`/orders/${r.order_id}`} className="alert-row">
                <span className="who">{r.order_code} · {r.customer_name}</span>
                <span className="small muted grow truncate">{qty(r.qty, r.unit)} × {r.product}</span>
                {r.issue ? <Badge tone="red">{r.issue}</Badge> : <LineStateBadge state={r.state} daysLate={r.days_late} size="sm" />}
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <Drawer open={Boolean(task)} onClose={() => setTask(null)} title={task?.customer_name || 'Follow-up'} subtitle={task?.purpose}>
        {task && <FollowupForm task={task} onSaved={() => { toast.success('Saved'); setTask(null); reload(); }} />}
      </Drawer>
    </div>
  );
}

/** This financial year's enquiries and sales by country, on a world map with the same numbers in a table beside it. */
function SalesMap() {
  const { can } = useAuth();
  const { data, error, reload } = useApi('/dashboard/map');
  const [measure, setMeasure] = useState('enquiries');
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('data:changed', on);
    return () => window.removeEventListener('data:changed', on);
  }, [reload]);
  const values = can('values.view');
  const country = data?.countries.find((c) => c.code === selected);
  const pick = (code) => setSelected((s) => (s === code ? null : code));
  return (
    <Card title="Where enquiries and sales come from" sub={data ? `this financial year, since ${date(data.from, { year: true })}` : undefined}
      actions={<Segmented label="Show on the map" value={measure} onChange={setMeasure} options={[{ value: 'enquiries', label: 'Enquiries' }, { value: 'sales', label: 'Sales' }]} />}>
      {error && <ErrorState error={error} onRetry={reload} />}
      {!data && !error && <Spinner />}
      {data && (
        <div className="map-card">
          <div>
            <WorldMap countries={data.countries} measure={measure} selected={selected} onSelect={pick} values={values} />
            <div className="tiny muted mt-8">
              Sales are confirmed orders{values ? ', valued before tax' : ''}.
              {(data.unknown.enquiries > 0 || data.unknown.sales > 0) && ` ${countOf(data.unknown.enquiries, 'enquiry', 'enquiries')} and ${countOf(data.unknown.sales, 'sale', 'sales')} are from customers with no country set.`}
              {values && data.totals.unpriced > 0 && ` ${countOf(data.totals.unpriced, 'order has', 'orders have')} items without a price; those items are not in the values.`}
            </div>
          </div>
          {country ? <CountryDetail country={country} values={values} onBack={() => setSelected(null)} /> : <CountryTable data={data} measure={measure} values={values} onPick={pick} />}
        </div>
      )}
    </Card>
  );
}

const countOf = (n, one, many) => `${number(n)} ${n === 1 ? one : many}`;

function CountryTable({ data, measure, values, onPick }) {
  const rows = [...data.countries].sort((a, b) => b[measure] - a[measure] || b.enquiries + b.sales - (a.enquiries + a.sales));
  if (!rows.length) return <div className="small muted">Nothing yet this financial year.</div>;
  return (
    <div className="table-wrap">
      <table className="table compact map-table">
        <thead><tr><th>Country</th><th className="num">Enquiries</th><th className="num">Sales</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.code} className="clickable" onClick={() => onPick(c.code)}>
              <td>
                <button type="button" className="btn link" onClick={(e) => { e.stopPropagation(); onPick(c.code); }}>{c.name}</button>
                {values && c.sales > 0 && <div className="sub">{compactByCurrency(c.value_by_currency)} sold</div>}
              </td>
              <td className="num">{number(c.enquiries)}</td>
              <td className="num">{number(c.sales)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CountryDetail({ country: c, values, onBack }) {
  return (
    <div className="stack-sm">
      <div><button type="button" className="btn link" onClick={onBack}>‹ All countries</button></div>
      <div>
        <div className="strong">{c.name}</div>
        <div className="small muted">{countOf(c.enquiries, 'enquiry', 'enquiries')} · {countOf(c.sales, 'sale', 'sales')}{values && c.sales > 0 ? ` · ${compactByCurrency(c.value_by_currency)}` : ''}</div>
      </div>
      {c.states?.length > 0 && (
        <div className="table-wrap">
          <table className="table compact map-table">
            <thead><tr><th>State</th><th className="num">Enquiries</th><th className="num">Sales</th></tr></thead>
            <tbody>{c.states.map((s) => <tr key={s.name || '-'}><td>{s.name || 'Not known'}</td><td className="num">{number(s.enquiries)}</td><td className="num">{number(s.sales)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="table-wrap">
        <table className="table compact map-table">
          <thead><tr><th>Top customers</th><th className="num">Enquiries</th><th className="num">Sales</th></tr></thead>
          <tbody>{c.customers.map((x) => <tr key={x.id}><td><Link to={`/customers/${x.id}`}>{x.name}</Link></td><td className="num">{number(x.enquiries)}</td><td className="num">{number(x.sales)}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
