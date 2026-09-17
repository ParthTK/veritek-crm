import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, number, pct, date, timeAgo, monthLabel } from '../lib/format.js';
import { Badge, Button, Card, DataTable, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, useToast, EmptyState, Progress, Checkbox } from '../components/ui.jsx';
import { ColumnChart } from '../components/charts.jsx';
import { useMeta, UserSelect } from '../components/domain.jsx';

export default function Team() {
  const { can, user } = useAuth();
  const [f, setFilter] = useUrlFilters({ tab: 'approvals' });
  const approvals = useApi(f.tab === 'approvals' ? '/approvals' : null, { status: f.astatus || 'pending' });
  const users = useApi(['members', 'performance'].includes(f.tab) ? '/users' : null);
  const targets = useApi(f.tab === 'targets' ? '/targets' : null);
  const [editing, setEditing] = useState(null);

  return (
    <div className="stack">
      <PageHeader title="Team & approvals" subtitle="Approval queue, users, access scope and monthly targets"
        actions={can('team.edit') && f.tab === 'members' && <Button variant="primary" icon="plus" onClick={() => setEditing({})}>Add user</Button>} />
      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[
        { key: 'approvals', label: 'Approvals', count: approvals.data?.filter((a) => a.status === 'pending').length },
        { key: 'members', label: 'Team members' },
        { key: 'targets', label: 'Targets' },
        { key: 'performance', label: 'Performance' },
      ]} />

      {f.tab === 'approvals' && <Approvals data={approvals} filter={f} setFilter={setFilter} />}
      {f.tab === 'members' && (
        <Card flush>
          <DataTable rows={users.data} loading={users.loading} columns={[
            { key: 'name', label: 'Name', render: (u) => <div className="col" style={{ gap: 0 }}><span className="strong">{u.name}</span><span className="tiny muted">{u.email}</span></div> },
            { key: 'role', label: 'Role', render: (u) => <div className="col" style={{ gap: 2 }}><Badge>{labelOf(ROLES, u.role)}</Badge><span className="tiny muted">{u.designation}</span></div> },
            { key: 'scope', label: 'Access scope', render: (u) => <span className="small">{u.region_name || u.factory_name || 'All regions'}{u.branch ? <div className="tiny muted">{u.branch}</div> : null}</span> },
            { key: 'manager', label: 'Reports to', render: (u) => <span className="small">{u.manager_name || '—'}</span> },
            { key: 'customers', label: 'Customers', align: 'num', render: (u) => number(u.customers) },
            { key: 'leads', label: 'Open leads', align: 'num', render: (u) => number(u.open_leads) },
            { key: 'overdue', label: 'Overdue follow-ups', align: 'num', render: (u) => (u.overdue_followups ? <span className="pill-count red">{u.overdue_followups}</span> : <span className="muted">0</span>) },
            { key: 'active', label: 'Status', render: (u) => <Badge color={u.active ? 'green' : 'slate'}>{u.active ? 'Active' : 'Disabled'}</Badge> },
            { key: 'login', label: 'Last sign-in', render: (u) => <span className="small muted">{u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</span> },
            can('team.edit') && { key: 'act', label: '', render: (u) => <div className="row"><Button size="xs" icon="edit" onClick={() => setEditing(u)} aria-label="Edit user" />{u.id !== user.id && <Button size="xs" variant="ghost" onClick={() => setEditing({ ...u, transfer: true })}>Transfer</Button>}</div> },
          ]} />
        </Card>
      )}
      {f.tab === 'targets' && <Targets data={targets} />}
      {f.tab === 'performance' && <Performance users={users.data} />}

      {editing && (editing.transfer
        ? <TransferModal user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); }} />
        : <UserModal user={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); }} />)}
    </div>
  );
}

function Approvals({ data, filter, setFilter }) {
  const toast = useToast();
  const [decide, setDecide] = useState(null);
  const rows = data.data;
  return (
    <div className="stack">
      <div className="filter-bar">
        <Select className="sm" value={filter.astatus || 'pending'} onChange={(e) => setFilter({ astatus: e.target.value })} options={[
          { value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' },
        ]} />
      </div>
      <Card flush>
        <DataTable rows={rows} loading={data.loading} empty={<EmptyState icon="check" title="No approvals waiting" message="Quotations within the discount and margin policy approve automatically." />} columns={[
          { key: 'number', label: 'Quotation', render: (a) => <div className="col" style={{ gap: 0 }}><Link to={`/quotations/${a.quotation_id}`} className="strong">{a.number}</Link><span className="tiny muted">v{a.version_no} · {a.subject}</span></div> },
          { key: 'customer', label: 'Customer', render: (a) => <div className="col" style={{ gap: 0 }}><span>{a.customer_name}</span><span className="tiny muted">{a.region_name}</span></div> },
          { key: 'value', label: 'Value', align: 'num', render: (a) => (a.amount === undefined ? '—' : inrCompact(a.amount)) },
          { key: 'discount', label: 'Discount', align: 'num', render: (a) => <span className="warning-text">{pct(a.discount_pct)}</span> },
          { key: 'margin', label: 'Margin', align: 'num', render: (a) => (a.margin_pct === undefined ? '—' : a.margin_pct === null ? '—' : <span className={a.margin_pct < 22 ? 'danger-text' : ''}>{pct(a.margin_pct)}</span>) },
          { key: 'reasons', label: 'Why approval is needed', render: (a) => <span className="small">{a.reasons.join('; ')}{a.below_min_price ? <Badge size="sm" color="red">Below min price</Badge> : null}</span> },
          { key: 'role', label: 'Level', render: (a) => <Badge color="amber" size="sm">{labelOf(ROLES, a.required_role)}</Badge> },
          { key: 'requested', label: 'Requested', render: (a) => <span className="small">{a.requested_by_name}<div className="tiny muted">{date(a.requested_at)}</div></span> },
          { key: 'status', label: 'Status', render: (a) => (a.status === 'pending'
            ? (a.can_decide ? <div className="row"><Button size="xs" variant="primary" onClick={() => setDecide({ a, decision: 'approved' })}>Approve</Button><Button size="xs" variant="danger-ghost" onClick={() => setDecide({ a, decision: 'rejected' })}>Reject</Button></div> : <Badge color="amber">Pending</Badge>)
            : <div className="col" style={{ gap: 0 }}><Badge color={a.status === 'approved' ? 'green' : 'red'}>{a.status}</Badge><span className="tiny muted">{a.decided_by_name}</span></div>) },
        ]} />
      </Card>
      <Modal open={Boolean(decide)} onClose={() => setDecide(null)} size="sm" title={decide?.decision === 'approved' ? 'Approve quotation' : 'Reject quotation'}
        subtitle={decide ? `${decide.a.number} · ${decide.a.customer_name}` : ''}
        footer={<><Button onClick={() => setDecide(null)}>Cancel</Button><Button variant={decide?.decision === 'approved' ? 'primary' : 'danger'} onClick={async () => {
          try {
            await api.post(`/approvals/${decide.a.id}/decide`, { decision: decide.decision, comments: decide.comments });
            toast.success('Decision recorded');
            setDecide(null);
            data.reload();
          } catch (err) {
            toast.error(err.message);
          }
        }}>{decide?.decision === 'approved' ? 'Approve' : 'Reject'}</Button></>}>
        <div className="stack">
          <div className="small muted">{decide?.a.reasons.join('; ')}</div>
          <Field label="Comments" required={decide?.decision === 'rejected'}>
            <Textarea rows={3} value={decide?.comments || ''} onChange={(e) => setDecide((d) => ({ ...d, comments: e.target.value }))} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function Targets({ data }) {
  const toast = useToast();
  const { can, user } = useAuth();
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  const editable = ['super_admin', 'management', 'sales_head'].includes(user.role);
  if (!data.data) return <Spinner />;
  const { months, users } = data.data;
  const value = (u, m) => (edits[`${u.id}:${m}`] !== undefined ? edits[`${u.id}:${m}`] : u.targets[m]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/targets', { entries: Object.entries(edits).map(([k, v]) => ({ user_id: Number(k.split(':')[0]), month: k.split(':')[1], amount: Number(v) || 0 })) });
      toast.success('Targets saved');
      setEdits({});
      data.reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Monthly sales targets" sub="Order value excluding GST" actions={editable && Object.keys(edits).length > 0 && <Button variant="primary" loading={busy} onClick={save}>Save {Object.keys(edits).length} changes</Button>} flush>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th style={{ minWidth: 150 }}>Salesperson</th>
              {months.map((m) => <th key={m} className="num">{monthLabel(m)}</th>)}
              <th className="num">Year total</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const total = months.reduce((s, m) => s + Number(value(u, m) || 0), 0);
              const achieved = months.reduce((s, m) => s + (u.achieved[m] || 0), 0);
              return (
                <tr key={u.id}>
                  <td><div className="col" style={{ gap: 0 }}><span className="strong">{u.name}</span><span className="tiny muted">{u.region_name}</span></div></td>
                  {months.map((m) => (
                    <td key={m} className="num">
                      {editable ? (
                        <input className="input sm num" style={{ width: 92 }} type="number" min="0" step="50000" value={value(u, m) ?? 0}
                          onChange={(e) => setEdits((s) => ({ ...s, [`${u.id}:${m}`]: e.target.value }))} />
                      ) : inrCompact(u.targets[m])}
                      <div className="tiny muted">{u.achieved[m] ? inrCompact(u.achieved[m]) : '—'}</div>
                    </td>
                  ))}
                  <td className="num">
                    <strong>{inrCompact(total)}</strong>
                    <div className="tiny muted">{inrCompact(achieved)} achieved</div>
                    <Progress value={total ? (achieved / total) * 100 : 0} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="small muted" style={{ padding: 12 }}>Grey figures under each target are the achieved order value for that month.</div>
    </Card>
  );
}

function Performance({ users }) {
  const { data } = useApi('/dashboard', { period: 'fy' });
  if (!data || !users) return <Spinner />;
  const rows = data.salespeople || [];
  return (
    <div className="stack">
      <Card title="Financial year performance" sub="Order value excluding GST against target">
        <ColumnChart data={rows} x="name" format="currency" height={260} series={[{ key: 'won_value', label: 'Achieved' }]} target={{ key: 'target', label: 'Target' }} />
      </Card>
      <Card flush>
        <DataTable rows={rows} columns={[
          { key: 'name', label: 'Salesperson', render: (p) => <div className="col" style={{ gap: 0 }}><span className="strong">{p.name}</span><span className="tiny muted">{p.region} · {labelOf(ROLES, p.role)}</span></div> },
          { key: 'leads', label: 'Leads', align: 'num' },
          { key: 'open_leads', label: 'Open', align: 'num' },
          { key: 'pipeline', label: 'Pipeline', align: 'num', render: (p) => inrCompact(p.pipeline_value) },
          { key: 'quotes', label: 'Quotes sent', align: 'num', render: (p) => p.quotes_sent },
          { key: 'orders', label: 'Orders', align: 'num' },
          { key: 'revenue', label: 'Revenue', align: 'num', render: (p) => <strong>{inrCompact(p.won_value)}</strong> },
          { key: 'target', label: 'Target', align: 'num', render: (p) => inrCompact(p.target) },
          { key: 'ach', label: 'Achievement', render: (p) => (p.target ? <div className="row"><div className="grow"><Progress value={p.achievement_pct} tone={p.achievement_pct >= 100 ? 'good' : p.achievement_pct >= 70 ? 'warn' : 'bad'} /></div><span className="small num">{p.achievement_pct}%</span></div> : '—') },
          { key: 'conv', label: 'Win rate', align: 'num', render: (p) => (p.conversion_pct === null ? '—' : pct(p.conversion_pct, 0)) },
          { key: 'overdue', label: 'Overdue F/U', align: 'num', render: (p) => (p.overdue_followups ? <span className="pill-count red">{p.overdue_followups}</span> : '0') },
        ]} />
      </Card>
    </div>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const toast = useToast();
  const meta = useMeta();
  const [form, setForm] = useState(user || { role: 'sales_executive', active: 1 });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    setBusy(true);
    try {
      if (user?.id) await api.put(`/users/${user.id}`, form);
      else await api.post('/users', form);
      toast.success('User saved');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={user?.id ? `Edit ${user.name}` : 'Add team member'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Email" required><Input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Role" required hint="Controls modules and data access"><Select value={form.role} onChange={set('role')} options={ROLES} /></Field>
        <Field label="Designation"><Input value={form.designation} onChange={set('designation')} /></Field>
        <Field label="Region" hint="Regional managers see only their region"><Select value={form.region_id} onChange={set('region_id')} placeholder="All regions" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} /></Field>
        <Field label="Factory / unit" hint="Production sees only their unit"><Select value={form.factory_id} onChange={set('factory_id')} placeholder="All units" options={meta.factories.map((x) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="Branch"><Input value={form.branch} onChange={set('branch')} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Reports to"><UserSelect value={form.manager_id} onChange={set('manager_id')} placeholder="—" /></Field>
        <Field label={user?.id ? 'Reset password' : 'Initial password'} required={!user?.id} hint="At least 8 characters"><Input type="text" value={form.password} onChange={set('password')} placeholder={user?.id ? 'Leave blank to keep current' : ''} /></Field>
        {user?.id && <Checkbox label="Account active" checked={form.active !== 0} onChange={(v) => setForm((f) => ({ ...f, active: v ? 1 : 0 }))} />}
      </div>
    </Modal>
  );
}

function TransferModal({ user, onClose, onSaved }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [result, setResult] = useState(null);
  return (
    <Modal open onClose={onClose} size="sm" title={`Transfer ${user.name}'s work`}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={!to} onClick={async () => {
        try {
          const r = await api.post(`/users/${user.id}/transfer`, { to_user_id: to });
          setResult(r);
          toast.success('Work transferred');
          onSaved();
        } catch (err) {
          toast.error(err.message);
        }
      }}>Transfer</Button></>}>
      <div className="stack">
        <div className="small muted">Moves open leads, customers, pending follow-ups and live quotations to another salesperson.</div>
        <Field label="Transfer to"><UserSelect value={to} onChange={(e) => setTo(e.target.value)} placeholder="Select…" /></Field>
        {result && <div className="info-box small">Moved {result.leads} leads, {result.customers} customers, {result.followups} follow-ups and {result.quotations} quotations.</div>}
      </div>
    </Modal>
  );
}
