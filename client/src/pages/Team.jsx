// Team & approvals: quotation approvals waiting for a decision, monthly sales targets against confirmed
// orders, performance shown with workload, and who is on the team.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, labelOf } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { compactByCurrency, compactMoney, date, dateTime, monthLabel, number, pct, timeAgo, todayLocal, addDays } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, EmptyState, ErrorState, Field, Input, Modal, Notice, PageHeader, SaveStatus, Spinner, Tabs, Textarea,
} from '../components/ui.jsx';
import { Money } from '../components/domain.jsx';
import { ColumnChart } from '../components/charts.jsx';

export default function Team() {
  const { can } = useAuth();
  const [f, setFilter] = useUrlFilters({ tab: can('quotes.approve') ? 'approvals' : 'performance' });
  const tabs = [
    can('quotes.view') && { key: 'approvals', label: 'Approvals' },
    { key: 'performance', label: 'Performance' },
    can('values.view') && { key: 'targets', label: 'Targets' },
    { key: 'members', label: 'Members' },
  ].filter(Boolean);
  return (
    <div className="stack">
      <PageHeader title="Team & approvals" subtitle="Approvals waiting for a decision, targets against confirmed orders, and performance shown with workload" />
      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={tabs} />
      {f.tab === 'approvals' && <Approvals />}
      {f.tab === 'performance' && <Performance />}
      {f.tab === 'targets' && <Targets />}
      {f.tab === 'members' && <Members />}
    </div>
  );
}

// ------------------------------------------------------------------ approvals
function Approvals() {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useApi('/approvals', { status });
  const [decide, setDecide] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Chips value={status} onChange={setStatus} options={[{ value: 'pending', label: 'Waiting for a decision', count: status === 'pending' ? data?.length : undefined }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} />
      <Card flush>
        <DataTable rows={data} loading={loading} columns={[
          { key: 'q', label: 'Quotation', render: (a) => <div className="col" style={{ gap: 0 }}><Link to={`/quotations/${a.quotation_id}`} className="strong">{a.number} rev {a.revision_no}</Link><span className="tiny muted">{a.company_name}{a.region_name ? ` · ${a.region_name}` : ''}</span></div> },
          { key: 'v', label: 'Value (pre-GST)', align: 'num', render: (a) => <Money minor={a.total_minor} currency={a.currency} /> },
          { key: 'd', label: 'Discount', align: 'num', render: (a) => pct(a.discount_pct) },
          { key: 'm', label: 'Margin', align: 'num', render: (a) => (a.margin_pct === undefined ? <span className="muted">Hidden</span> : a.margin_pct === null ? '—' : pct(a.margin_pct)) },
          { key: 'why', label: 'Why approval is needed', render: (a) => <div className="small" style={{ maxWidth: 360 }}>{a.reasons.join(' · ')}{a.comments && <div className="muted">“{a.comments}”</div>}</div> },
          { key: 'who', label: 'Needs', render: (a) => <Badge size="sm" tone="violet">{a.required_role_label}</Badge> },
          { key: 'when', label: 'Requested', render: (a) => <span className="small">{a.requested_by_name}<div className="tiny muted">{timeAgo(a.requested_at)}</div></span> },
          { key: 'st', label: 'Status', render: (a) => (a.status === 'pending' ? (a.can_decide
            ? <div className="row"><Button size="xs" variant="primary" onClick={() => setDecide({ a, decision: 'approved' })}>Approve</Button><Button size="xs" variant="danger-ghost" onClick={() => setDecide({ a, decision: 'rejected' })}>Reject</Button></div>
            : <span className="small muted">Waiting for {a.required_role_label}</span>)
            : <span className="small"><Badge size="sm" tone={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'slate'}>{a.status}</Badge><div className="tiny muted">{a.decided_by_name} {a.decided_at ? dateTime(a.decided_at) : ''}</div></span>) },
        ]} empty={<EmptyState icon="shield" title={status === 'pending' ? 'Nothing waiting' : 'No approvals'} message={status === 'pending' ? 'Quotations outside the discount or margin policy appear here.' : undefined} />} />
      </Card>
      <Modal open={Boolean(decide)} size="sm" onClose={() => setDecide(null)} title={decide?.decision === 'approved' ? `Approve ${decide?.a.number}` : `Reject ${decide?.a.number}`}>
        {decide && <DecideForm a={decide.a} decision={decide.decision} onSaved={() => { setDecide(null); reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Modal>
    </div>
  );
}

function DecideForm({ a, decision, onSaved }) {
  const save = useSave();
  const [comments, setComments] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/approvals/${a.id}/decide`, { decision, comments }); onSaved(); }); }}>
      <div className="small">{a.company_name} · <Money minor={a.total_minor} currency={a.currency} /> · {a.reasons.join('; ')}</div>
      <Field label={decision === 'approved' ? 'Comment' : 'Reason for rejecting'} required={decision === 'rejected'} optional={decision === 'approved'} error={save.fields.comments}>
        <Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={500} />
      </Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={decision === 'approved' ? 'primary' : 'danger'} loading={save.saving}>{decision === 'approved' ? 'Approve' : 'Reject'}</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ performance
function Performance() {
  const { can } = useAuth();
  const [range, setRange] = useState({ from: addDays(todayLocal(), -89), to: todayLocal() });
  const { data, error, loading, reload } = useApi('/team/performance', range);
  const values = can('values.view');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="filter-bar">
        <span className="small muted">From</span><input type="date" className="input" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" style={{ width: 'auto' }} />
        <span className="small muted">to</span><input type="date" className="input" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" style={{ width: 'auto' }} />
      </div>
      {!data && loading && <Spinner />}
      {data && (
        <Card title="Outcomes with workload" sub={`${date(data.from)} – ${date(data.to)}`} flush>
          <DataTable rows={data.rows} columns={[
            { key: 'n', label: 'Person', render: (p) => <div className="col" style={{ gap: 0 }}><strong>{p.name}</strong><span className="tiny muted">{[p.role_label, p.region_name].filter(Boolean).join(' · ')}</span></div> },
            { key: 'w', label: 'Workload now', render: (p) => <span className="small">{p.workload.open_enquiries} open enquiries · {p.workload.customers} customers · {p.workload.open_tasks} tasks{p.workload.overdue_tasks ? <span className="danger-text strong"> ({p.workload.overdue_tasks} overdue)</span> : ''}</span> },
            { key: 'e', label: 'Enquiries', align: 'num', render: (p) => number(p.enquiries_received) },
            { key: 'q', label: 'Quotes issued', align: 'num', render: (p) => number(p.quotes_issued) },
            { key: 'wl', label: 'Won / lost', align: 'num', render: (p) => `${p.won} / ${p.lost}` },
            { key: 'wr', label: 'Win rate', align: 'num', render: (p) => (p.win_rate_pct === null ? '—' : pct(p.win_rate_pct)) },
            { key: 'o', label: 'Orders', align: 'num', render: (p) => number(p.orders) },
            values && { key: 'v', label: 'Order value', align: 'num', render: (p) => compactByCurrency(p.order_value_by_currency) },
            { key: 'c', label: 'Contacts logged', align: 'num', render: (p) => number(p.contacts_logged) },
            { key: 't', label: 'Tasks on time', align: 'num', render: (p) => (p.tasks_on_time_pct === null ? '—' : `${pct(p.tasks_on_time_pct)} of ${p.tasks_done}`) },
          ]} empty={<EmptyState title="No salespeople in your view" />} />
          <div className="tiny muted" style={{ padding: '8px 14px' }}>{data.note}</div>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ targets
function Targets() {
  const { can } = useAuth();
  const { data, error, reload } = useApi('/team/targets');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const cur = data.currency;
  const totals = data.months.map((m) => ({
    month: m,
    target: data.users.reduce((s, u) => s + (u.targets[m] || 0), 0),
    achieved: data.users.reduce((s, u) => s + (u.achieved[m] || 0), 0),
  }));
  const person = data.users.find((u) => u.id === selected);
  const chart = person ? data.months.map((m) => ({ month: m, target: person.targets[m] || 0, achieved: person.achieved[m] || 0 })) : totals;
  return (
    <div className="stack">
      <Card title={person ? `${person.name}: target vs achievement` : 'Team target vs achievement'} sub={`${cur} · financial year`}
        actions={<>{person && <Button size="sm" onClick={() => setSelected(null)}>Whole team</Button>}{can('targets.edit') && <Button size="sm" variant="primary" icon="edit" onClick={() => setEditing(true)}>Set targets</Button>}</>}>
        <ColumnChart data={chart} x="month" xFormat={monthLabel} series={[{ key: 'achieved', label: 'Confirmed orders' }]} target={{ key: 'target', label: 'Target' }} format={`money:${cur}`} />
        <div className="tiny muted mt-8">{data.note}{Object.keys(data.other_currencies).length ? ` Other currencies this year: ${compactByCurrency(data.other_currencies)}.` : ''}</div>
      </Card>
      <Card title="By person" flush>
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Person</th>{data.months.map((m) => <th key={m} className="num">{monthLabel(m)}</th>)}<th className="num">Year</th></tr></thead>
            <tbody>
              {data.users.map((u) => {
                const t = Object.values(u.targets).reduce((s, v) => s + (v || 0), 0);
                const a = Object.values(u.achieved).reduce((s, v) => s + (v || 0), 0);
                return (
                  <tr key={u.id} className="clickable" onClick={() => setSelected(u.id)}>
                    <td><strong>{u.name}</strong><div className="sub">{[u.role_label, u.region_name].filter(Boolean).join(' · ')}</div></td>
                    {data.months.map((m) => (
                      <td key={m} className="num small">
                        <div>{u.achieved[m] ? compactMoney(u.achieved[m], cur) : '—'}</div>
                        <div className="tiny muted">{u.targets[m] ? `of ${compactMoney(u.targets[m], cur)}` : ''}</div>
                      </td>
                    ))}
                    <td className="num"><strong>{compactMoney(a, cur)}</strong><div className="tiny muted">{t ? `${Math.round((a / t) * 100)}% of ${compactMoney(t, cur)}` : 'no target'}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <TargetsEditor data={data} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

function TargetsEditor({ data, onClose, onSaved }) {
  const save = useSave();
  const initial = useMemo(() => Object.fromEntries(data.users.flatMap((u) => data.months.map((m) => [`${u.id}|${m}`, u.targets[m] ? fromMinor(u.targets[m]) : '']))), [data]);
  const [grid, setGrid] = useState(initial);
  useEffect(() => setGrid(initial), [initial]);
  const fill = (userId) => {
    const first = data.months.map((m) => grid[`${userId}|${m}`]).find((v) => v !== '');
    if (first === undefined) return;
    setGrid((g) => ({ ...g, ...Object.fromEntries(data.months.map((m) => [`${userId}|${m}`, g[`${userId}|${m}`] || first])) }));
  };
  const submit = () => save.run(async () => {
    const entries = Object.entries(grid).filter(([k, v]) => v !== initial[k]).map(([k, v]) => {
      const [user_id, month] = k.split('|');
      return { user_id: Number(user_id), month, amount: v };
    });
    await api.put('/team/targets', { currency: data.currency, entries });
    onSaved();
  });
  return (
    <Modal open size="xl" onClose={onClose} title={`Monthly targets (${data.currency}, before tax)`} subtitle="Blank means no target for that month. “Fill” copies the first value across the empty months."
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save targets</Button></>}>
      {Object.keys(save.fields).length > 0 && <Notice tone="danger">Some amounts are not valid numbers.</Notice>}
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Person</th>{data.months.map((m) => <th key={m}>{monthLabel(m)}</th>)}<th /></tr></thead>
          <tbody>{data.users.map((u) => (
            <tr key={u.id}>
              <td className="nowrap"><strong>{u.name}</strong></td>
              {data.months.map((m) => <td key={m}><Input inputMode="decimal" value={grid[`${u.id}|${m}`]} onChange={(e) => setGrid({ ...grid, [`${u.id}|${m}`]: e.target.value })} style={{ minWidth: 90 }} aria-label={`${u.name} ${monthLabel(m)}`} /></td>)}
              <td><Button size="xs" onClick={() => fill(u.id)}>Fill</Button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ members
function Members() {
  const { data, error, reload } = useApi('/team/members');
  const { can } = useAuth();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  return (
    <Card title="People" sub={`${data.filter((u) => u.active).length} active`} actions={can('users.manage') && <Button size="sm" to="/settings?tab=users">Manage users</Button>} flush>
      <DataTable rows={data} columns={[
        { key: 'n', label: 'Name', render: (u) => <div className="col" style={{ gap: 0 }}><strong>{u.name}</strong><span className="tiny muted">{u.designation || u.role_label}{u.login_enabled ? '' : ' · no sign-in'}</span></div> },
        { key: 'r', label: 'Role', render: (u) => <span className="small">{labelOf(ROLES, u.role)}</span> },
        { key: 'where', label: 'Region / factory', render: (u) => <span className="small">{u.region_name || u.factory_name || '—'}</span> },
        { key: 'mgr', label: 'Reports to', render: (u) => <span className="small">{u.manager_name || '—'}</span> },
        { key: 'load', label: 'Workload', render: (u) => <span className="small">{u.open_enquiries ? `${u.open_enquiries} enquiries · ` : ''}{u.customers ? `${u.customers} customers · ` : ''}{u.active_orders ? `${u.active_orders} orders · ` : ''}{u.open_tasks} tasks{u.overdue_tasks ? <span className="danger-text strong"> ({u.overdue_tasks} overdue)</span> : ''}</span> },
        { key: 'last', label: 'Last sign-in', render: (u) => (u.login_enabled ? <span className="small">{u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</span> : <span className="muted small">—</span>) },
        { key: 's', label: 'Status', render: (u) => (u.active ? <Badge size="sm" tone="green">Active</Badge> : <Badge size="sm">Inactive</Badge>) },
      ]} />
    </Card>
  );
}
