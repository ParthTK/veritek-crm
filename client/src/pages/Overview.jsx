import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, dateTime, relDay, timeAgo, qty } from '../lib/format.js';
import {
  Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Spinner, Tabs, Tile, Drawer, useToast,
} from '../components/ui.jsx';
import { FilterBar, DueBadge, LineStateBadge, CommBadge, useMeta } from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const withFilters = (base, f) => {
  const p = new URLSearchParams(base.includes('?') ? base.split('?')[1] : '');
  for (const k of ['owner', 'segment', 'country', 'family']) if (f[k]) p.set(k, f[k]);
  return `${base.split('?')[0]}${p.toString() ? `?${p}` : ''}`;
};

const ALERT_TABS = [
  { key: 'overdue', label: 'Dispatch overdue', tone: 'red' },
  { key: 'forecast_late', label: 'Forecast late' },
  { key: 'not_informed', label: 'Customer not informed', tone: 'red' },
  { key: 'no_action', label: 'Delayed, no next action' },
  { key: 'ready_waiting', label: 'Ready, awaiting dispatch' },
  { key: 'estimate_unknown', label: 'Estimate unknown' },
];
const STATE_LINK = { overdue: 'overdue', forecast_late: 'at_risk', not_informed: 'not_informed', no_action: 'no_action', ready_waiting: 'ready_waiting', estimate_unknown: 'estimate_unknown' };

export default function Overview() {
  const { can, user } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const [filters, setFilter] = useUrlFilters({});
  const [showFilters, setShowFilters] = useState(Boolean(filters.owner || filters.segment || filters.country || filters.family));
  const { data, error, loading, reload } = useApi('/dashboard', filters);
  const [alertTab, setAlertTab] = useState(null);
  const [fuTab, setFuTab] = useState('overdue');
  const [task, setTask] = useState(null);
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('data:changed', on);
    return () => window.removeEventListener('data:changed', on);
  }, [reload]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const t = data.tiles;
  const firstAlert = alertTab || ALERT_TABS.find((a) => data.order_alerts[a.key].count)?.key || 'overdue';
  const alerts = data.order_alerts[firstAlert];
  const fu = data.followups[fuTab];
  const openTask = async (id) => {
    try {
      const full = await api.get(`/tasks/${id}`);
      const contacts = full.customer_id && can('customers.view') ? (await api.get(`/customers/${full.customer_id}`)).contacts : [];
      setTask({ ...full, contacts });
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (data.empty.customers) {
    return (
      <div className="stack">
        <PageHeader title="Welcome" subtitle="There are no records yet." />
        <EmptyState icon="upload" title="Start by importing or adding your records" message="Import customers, open enquiries and active order lines from your existing sheets, or add them one by one. Until then, the overview has nothing to measure — it will not show reassuring zeros."
          action={<div className="row">{can('imports.run') && <Button variant="primary" to="/settings?tab=imports">Import data</Button>}{can('enquiries.edit') && <Button to="/enquiries">Add an enquiry</Button>}</div>} />
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader
        eyebrow={<>Business overview {data.notices.length > 0 && (
          <span className="pill-notice"><Icon name="alert" size={14} />{data.notices.map((n, i) => <span key={n.code}>{i > 0 && ' • '}<Link to={n.link}>{n.text}</Link></span>)}</span>
        )}</>}
        title="Everything that needs your attention"
        subtitle={<span>Updated {dateTime(data.refreshed_at)} ({data.timezone}){data.last_scheduler_run ? ` · reminders checked ${timeAgo(data.last_scheduler_run.at)}` : ''}</span>}
        actions={<><Button icon="filter" onClick={() => setShowFilters(!showFilters)}>Filters</Button><Button icon="refresh" loading={loading} onClick={reload}>Refresh</Button></>}
      />
      {showFilters && <FilterBar value={filters} onChange={setFilter} />}

      <div className="tiles">
        {can('past.view') && <Tile icon="users" label="Past customers to reconnect" value={t.reconnect.count} to={withFilters(t.reconnect.link, filters)} foot="Reconnect task due today or overdue" />}
        {can('enquiries.view') && <Tile icon="inbox" label="Open enquiries" value={t.open_enquiries.count} to={withFilters(t.open_enquiries.link, filters)} foot={t.open_enquiries.no_response ? `${t.open_enquiries.no_response} without a first response` : 'Includes on hold with a review date'} />}
        <Tile icon="box" label="Active orders" value={t.active_orders.count} to={withFilters(t.active_orders.link, filters)} foot="Unfulfilled, non-cancelled balance" />
        <Tile icon="alert" alert={t.delayed.count > 0} label="Delayed orders" value={t.delayed.count} to={withFilters(t.delayed.link, filters)} title={t.delayed.explanation}
          foot={<span><Badge size="sm" tone="red">{t.delayed.overdue} overdue</Badge> <Badge size="sm" tone="amber">{t.delayed.at_risk} at risk</Badge></span>} />
      </div>
      <div className="small muted" style={{ marginTop: -8 }}><Icon name="info" size={13} /> {t.delayed.explanation} Cards are not added together.</div>

      {data.pinned.length > 0 && (
        <Card title="Pinned" sub="customers and orders you follow">
          <div className="row wrap">{data.pinned.map((p) => <Link key={`${p.type}${p.id}`} to={p.link} className="tag" style={{ height: 30, fontSize: 13 }}><Icon name="pin" size={13} />&nbsp;{p.label}&nbsp;<Badge size="sm" tone={p.tone}>{p.state}</Badge></Link>)}</div>
        </Card>
      )}

      <div className="grid grid-2">
        <Card title="Active order alerts" flush actions={<Button size="sm" variant="ghost" to={withFilters(`/orders?state=${STATE_LINK[firstAlert]}`, filters)}>Open list ({alerts.count})</Button>}>
          <div style={{ padding: '0 12px' }}>
            <Tabs value={firstAlert} onChange={setAlertTab} tabs={ALERT_TABS.map((a) => ({ key: a.key, label: a.label, count: data.order_alerts[a.key].count, tone: data.order_alerts[a.key].count ? a.tone : '' }))} />
          </div>
          <div className="alert-list">
            {!alerts.rows.length && <div className="empty small">No orders in this list.</div>}
            {alerts.rows.map((r) => (
              <Link key={`${r.line_id}`} to={`/orders/${r.order_id}`} className="alert-row">
                <span className="who">{r.order_code} · {r.customer_name}</span>
                <span className="small muted grow truncate">{qty(r.qty, r.unit)} × {r.product}</span>
                <Badge tone="slate" icon="calendar">Due {date(r.original)}</Badge>
                {firstAlert === 'forecast_late' && <Badge tone="amber">Now {date(r.forecast)}</Badge>}
                {firstAlert === 'not_informed' && <CommBadge state="pending" size="sm" />}
                {r.issue ? <Badge tone="red">{r.issue}</Badge> : <LineStateBadge state={r.state} daysLate={r.days_late} size="sm" />}
              </Link>
            ))}
          </div>
        </Card>

        {can('past.view') ? (
          <Card title="Customer opportunities" sub="past customers and lost enquiries" flush actions={<Button size="sm" variant="ghost" to={withFilters('/past-customers?filter=followup_due', filters)}>All</Button>}>
            {!data.customer_opportunities.length && <div className="empty small">No reconnect actions due.</div>}
            {data.customer_opportunities.map((o) => (
              <div key={o.customer_id} className="opp-row">
                <div><div className="strong">{o.customer_name}</div><div className="tiny muted">{o.kind === 'past_buyer' ? 'Past buyer' : 'Lost prospect'}</div></div>
                <div className="small">
                  <div>{o.kind === 'past_buyer' ? (o.last_order_date ? `No order for ${Math.round(o.days_since_order / 30)} months` : 'Last order date unknown') : 'Lost quotation'}</div>
                  <div>Last reason: <strong>{o.why?.label || 'Not recorded'}</strong></div>
                  {o.next_action && <div className="mt-8"><DueBadge task={o.next_action} /> {o.next_action.purpose}</div>}
                </div>
                <Button size="sm" variant="cta" to={`/past-customers?customer=${o.customer_id}`}>View</Button>
              </div>
            ))}
          </Card>
        ) : (
          <Card title="Missing production updates" flush>
            <MissingUpdates rows={data.missing_updates.rows} />
          </Card>
        )}
      </div>

      {can('tasks.edit') && (
        <Card title="Follow-ups" flush actions={<Button size="sm" variant="ghost" to="/followups">Open follow-ups</Button>}>
          <div style={{ padding: '0 12px' }}>
            <Tabs value={fuTab} onChange={setFuTab} tabs={[{ key: 'overdue', label: 'Overdue', count: data.followups.overdue.count, tone: 'red' }, { key: 'today', label: 'Today', count: data.followups.today.count }]} />
          </div>
          {!fu.rows.length ? (
            <div className="empty small">{fuTab === 'overdue' ? 'No overdue follow-ups.' : 'Nothing else due today.'}{data.notices.length ? ' (See the data-quality notice above: some records have no next action yet.)' : ''}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Customer</th><th>Purpose</th><th>Owner</th><th>Last result</th><th>Due</th><th /></tr></thead>
                <tbody>
                  {fu.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.customer_id && can('customers.view') ? <Link to={`/customers/${r.customer_id}`}>{r.customer_name}</Link> : r.customer_name || r.order_code}</td>
                      <td>{r.purpose}{r.product && <div className="sub">{r.product}</div>}</td>
                      <td>{r.owner_name}</td>
                      <td className="small">{r.last_outcome_label || <span className="muted">—</span>}</td>
                      <td><DueBadge task={r} /></td>
                      <td>{(r.owner_id === user.id || can('tasks.manage_any')) && <Button size="xs" onClick={() => openTask(r.id)}>Record</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-3">
        {can('past.view') && (
          <Card title="Missing production updates" sub={`older than ${meta.settings.rules.staleWorkingDays} working days`} flush actions={<Button size="sm" variant="ghost" to="/orders?state=stale">All ({data.missing_updates.count})</Button>}>
            <MissingUpdates rows={data.missing_updates.rows} />
          </Card>
        )}
        {can('tasks.edit') && (
          <Card title="Customer promises overdue" sub="quotes, callbacks, datasheets" flush>
            {!data.promises_overdue.rows.length && <div className="empty small">No overdue promises to customers.</div>}
            <div className="alert-list">
              {data.promises_overdue.rows.map((r) => <div key={r.id} className="alert-row"><span className="who">{r.customer_name}</span><span className="small grow">{r.purpose}</span><DueBadge task={r} /></div>)}
            </div>
          </Card>
        )}
        <Card title="Upcoming commitments" sub="next 5 working days" flush>
          {!data.upcoming_commitments.rows.length && <div className="empty small">No dispatch commitments in the next 5 working days.</div>}
          <div className="alert-list">
            {data.upcoming_commitments.rows.map((r) => (
              <Link key={r.line_id} to={`/orders/${r.order_id}`} className="alert-row">
                <span className="who">{r.order_code}</span><span className="small grow truncate">{r.customer_name} · {r.product}</span><Badge tone="slate">{relDay(r.original)}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      </div>

      <Drawer open={Boolean(task)} onClose={() => setTask(null)} title={task?.customer_name || 'Follow-up'} subtitle={task?.purpose}>
        {task && <FollowupForm task={task} contacts={task.contacts} onSaved={() => { toast.success('Outcome recorded'); setTask(null); reload(); }} />}
      </Drawer>
      <Notice tone="info">Counts reflect what has been recorded. Reminders create internal tasks; they do not prove a customer was contacted.</Notice>
    </div>
  );
}

function MissingUpdates({ rows }) {
  if (!rows.length) return <div className="empty small">All active lines have a recent update.</div>;
  return (
    <div className="alert-list">
      {rows.map((r) => (
        <Link key={r.line_id} to={`/orders/${r.order_id}`} className="alert-row">
          <span className="who">{r.order_code}</span>
          <span className="small grow truncate">{r.product}</span>
          <Badge tone="amber" icon="clock">{r.freshness?.as_of ? `${r.freshness.working_days} working days` : 'Never updated'}</Badge>
        </Link>
      ))}
    </div>
  );
}
