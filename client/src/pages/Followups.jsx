import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FOLLOWUP_TYPES, PRIORITIES, LEAD_STAGES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, relativeDay, daysFromToday, todayStr, addDaysStr } from '../lib/format.js';
import { Badge, Button, Card, Field, Input, Modal, OptionBadge, PageHeader, Select, Tabs, Textarea, useToast, EmptyState, Spinner } from '../components/ui.jsx';
import { ContactActions, CustomerPicker, LogActivityModal, UserSelect } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

const REMINDERS = [
  { key: 'no_next_action', label: 'Leads without a next action', icon: 'alert' },
  { key: 'quotation_expiring', label: 'Quotations expiring in 3 days', icon: 'quotations' },
  { key: 'no_response', label: 'No response for 7+ days', icon: 'clock' },
  { key: 'sample_feedback', label: 'Sample delivered, feedback pending', icon: 'box' },
  { key: 'po_promised', label: 'PO promised but not received', icon: 'orders' },
  { key: 'repeat_opportunities', label: 'Repeat-order opportunities', icon: 'refresh' },
  { key: 'dormant_customers', label: 'Repeat customers gone inactive', icon: 'customers' },
];

function reminderLink(key, item) {
  if (['quotation_expiring'].includes(key) || item.kind === 'quotation') return `/quotations/${item.id}`;
  if (['repeat_opportunities', 'dormant_customers'].includes(key)) return `/customers/${item.id}`;
  if (key === 'sample_feedback') return item.lead_id ? `/leads/${item.lead_id}` : `/customers/${item.customer_id}`;
  return `/leads/${item.id}`;
}

function reminderText(key, item) {
  switch (key) {
    case 'quotation_expiring': return [`${item.number} · ${item.customer_name}`, `expires ${relativeDay(item.valid_until)} · ${inrCompact(item.grand_total)}`];
    case 'no_response': return [`${item.kind === 'quotation' ? item.number : item.code} · ${item.customer_name}`, `${item.days} days without contact`];
    case 'sample_feedback': return [`${item.customer_name}${item.lead_code ? ` · ${item.lead_code}` : ''}`, `delivered ${item.days} days ago`];
    case 'po_promised': return [`${item.code} · ${item.customer_name}`, `${item.days} days overdue · ${inrCompact(item.estimated_value)}`];
    case 'repeat_opportunities': return [item.name, `orders every ~${item.cycle} days · last ${item.days} days ago`];
    case 'dormant_customers': return [item.name, `no order for ${item.days} days · ${inrCompact(item.lifetime_value)} lifetime`];
    default: return [`${item.code} · ${item.customer_name}`, item.title];
  }
}

export default function Followups() {
  const { can, user } = useAuth();
  const toast = useToast();
  const manager = ['regional_manager', 'sales_head', 'management', 'super_admin'].includes(user.role);
  // Senior managers do not carry personal tasks, so they start on the team view.
  const [f, setFilter] = useUrlFilters({ view: ['sales_head', 'management', 'super_admin'].includes(user.role) ? 'team' : 'mine', bucket: 'due' });
  const status = f.bucket === 'done' ? 'done' : 'pending';
  const bucket = f.bucket === 'due' ? '' : f.bucket === 'done' ? '' : f.bucket;
  const { data, loading, reload } = useApi('/followups', { view: f.view, status, bucket, type: f.type, assigned_to: f.assigned_to });
  const reminders = useApi('/reminders', { view: f.view });
  const [logFor, setLogFor] = useState(null);
  const [creating, setCreating] = useState(false);
  const [reschedule, setReschedule] = useState(null);

  const rows = (data?.rows || []).filter((r) => f.bucket !== 'due' || r.due_date <= todayStr());
  const counts = data?.counts || {};

  const complete = async (row) => {
    try {
      await api.post(`/followups/${row.id}/complete`, { outcome: 'Done' });
      toast.success('Marked done');
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="stack">
      <PageHeader title="Follow-ups" subtitle="Everything due, with the context to act on it in one click"
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New follow-up</Button>} />
      {manager && (
        <div className="btn-group" role="group">
          <button type="button" className={`btn sm ${f.view === 'mine' ? 'on' : ''}`} onClick={() => setFilter({ view: 'mine', assigned_to: '' })}>My follow-ups</button>
          <button type="button" className={`btn sm ${f.view === 'team' ? 'on' : ''}`} onClick={() => setFilter({ view: 'team' })}>{user.role === 'regional_manager' ? 'My region' : 'Whole team'}</button>
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.8fr) minmax(280px, 1fr)', alignItems: 'start' }}>
        <Card flush>
          <div style={{ padding: '4px 16px 0' }}>
            <Tabs value={f.bucket} onChange={(b) => setFilter({ bucket: b })} tabs={[
              { key: 'due', label: 'Due now', count: (counts.overdue || 0) + (counts.today || 0) },
              { key: 'overdue', label: 'Overdue', count: counts.overdue || 0 },
              { key: 'today', label: 'Today', count: counts.today || 0 },
              { key: 'upcoming', label: 'Upcoming', count: counts.upcoming || 0 },
              { key: 'done', label: 'Completed' },
            ]} />
            <div className="filter-bar">
              <Select className="sm" value={f.type} onChange={(e) => setFilter({ type: e.target.value })} placeholder="All types" options={FOLLOWUP_TYPES} />
              {f.view === 'team' && <UserSelect className="sm" value={f.assigned_to} onChange={(e) => setFilter({ assigned_to: e.target.value })} placeholder="Anyone" />}
            </div>
          </div>
          {loading && !data ? <Spinner /> : rows.length === 0 ? (
            <EmptyState icon="check" title="Nothing here" message={f.view === 'mine' ? 'You are up to date.' : 'No follow-ups match this filter.'}
              action={manager && f.view === 'mine' ? <Button onClick={() => setFilter({ view: 'team' })}>See the team's follow-ups</Button> : null} />
          ) : (
            <div className="action-list">
              {rows.map((r) => {
                const d = daysFromToday(r.due_date);
                const leadTask = r.lead_id && r.auto_key === `lead:${r.lead_id}`;
                return (
                  <div key={r.id} className="action-row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ width: 84, flex: 'none' }}>
                      {status === 'pending'
                        ? <div className={`small strong ${d < 0 ? 'danger-text' : d === 0 ? 'warning-text' : ''}`}>{relativeDay(r.due_date)}</div>
                        : <div className="small">{date(r.completed_at)}</div>}
                      <div className="tiny muted">{date(r.due_date)}</div>
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <strong>{r.title}</strong>
                        <Badge size="sm">{labelOf(FOLLOWUP_TYPES, r.type)}</Badge>
                        {r.priority === 'high' && <OptionBadge list={PRIORITIES} value="high" size="sm" />}
                        {r.escalated_at && <Badge size="sm" color="red">Escalated</Badge>}
                        {r.temperature === 'hot' && <Badge size="sm" color="red">Hot lead</Badge>}
                      </div>
                      <div className="small secondary row wrap" style={{ gap: 8, marginTop: 2 }}>
                        {r.customer_name && <Link to={`/customers/${r.customer_id}`}>{r.customer_name}</Link>}
                        {r.lead_code && <Link to={`/leads/${r.lead_id}`}>{r.lead_code} · {labelOf(LEAD_STAGES, r.lead_stage)}</Link>}
                        {r.quotation_number && <Link to={`/quotations/${r.quotation_id}`}>{r.quotation_number}</Link>}
                        {r.order_number && <Link to={`/orders/${r.order_id}`}>{r.order_number}</Link>}
                        {r.invoice_number && <span>Invoice {r.invoice_number}</span>}
                        {r.complaint_number && <Link to={`/complaints/${r.complaint_id}`}>{r.complaint_number}</Link>}
                        {r.estimated_value > 0 && <span className="muted">{inrCompact(r.estimated_value)}</span>}
                      </div>
                      {r.contact_name && <div className="tiny muted">{r.contact_name} · {r.contact_phone}</div>}
                      {f.view === 'team' && <div className="tiny muted">Owner: {r.owner_name}</div>}
                      {status === 'done' && r.outcome && <div className="small muted">Outcome: {r.outcome} · {r.completed_by_name}</div>}
                    </div>
                    {status === 'pending' && (
                      <div className="row" style={{ flex: 'none' }}>
                        <ContactActions phone={r.contact_phone} whatsapp={r.contact_whatsapp} />
                        {r.customer_id && can('activities.edit', 'leads.edit') && <Button size="sm" onClick={() => setLogFor(r)}>Log &amp; complete</Button>}
                        {!leadTask && <Button size="sm" variant="ghost" icon="check" title="Mark done" onClick={() => complete(r)} />}
                        <Button size="sm" variant="ghost" icon="calendar" title="Reschedule" onClick={() => setReschedule({ ...r, new_date: addDaysStr(todayStr(), 1) })} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Smart reminders" sub={f.view === 'team' ? 'Team' : 'Yours'} flush>
          {!reminders.data ? <Spinner /> : REMINDERS.map((rem) => {
            const items = reminders.data[rem.key] || [];
            return (
              <details key={rem.key} className="action-list" open={items.length > 0 && items.length <= 4}>
                <summary className="action-row" style={{ cursor: 'pointer', listStyle: 'none' }}>
                  <Icon name={rem.icon} size={16} />
                  <span className="grow small strong">{rem.label}</span>
                  <span className={`pill-count ${items.length ? 'amber' : ''}`}>{items.length}</span>
                </summary>
                {items.slice(0, 15).map((it) => {
                  const [a, b] = reminderText(rem.key, it);
                  return (
                    <Link key={`${it.kind || ''}${it.id}`} to={reminderLink(rem.key, it)} className="action-row" style={{ paddingLeft: 42 }}>
                      <span className="grow small" style={{ minWidth: 0 }}><div className="truncate">{a}</div><div className="tiny muted truncate">{b}{f.view === 'team' && (it.owner_name) ? ` · ${it.owner_name}` : ''}</div></span>
                    </Link>
                  );
                })}
              </details>
            );
          })}
        </Card>
      </div>

      <LogActivityModal open={Boolean(logFor)} onClose={() => setLogFor(null)} onSaved={() => { reload(); reminders.reload(); }}
        customerId={logFor?.customer_id} leadId={logFor?.lead_id} quotationId={logFor?.quotation_id} orderId={logFor?.order_id} complaintId={logFor?.complaint_id}
        followup={logFor} requireNext={Boolean(logFor?.lead_id)} defaultType={['call', 'whatsapp', 'email', 'meeting'].includes(logFor?.type) ? logFor.type : 'call'} />
      <NewFollowupModal open={creating} onClose={() => setCreating(false)} onSaved={reload} />
      <Modal open={Boolean(reschedule)} size="sm" onClose={() => setReschedule(null)} title="Reschedule follow-up" subtitle={reschedule?.title}
        footer={<><Button onClick={() => setReschedule(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
          try {
            await api.put(`/followups/${reschedule.id}`, { due_date: reschedule.new_date });
            toast.success(`Moved to ${date(reschedule.new_date)}`);
            setReschedule(null);
            reload();
          } catch (err) {
            toast.error(err.message);
          }
        }}>Reschedule</Button></>}>
        <Field label="New date" hint={reschedule && relativeDay(reschedule.new_date)}><Input type="date" min={todayStr()} value={reschedule?.new_date} onChange={(e) => setReschedule((r) => ({ ...r, new_date: e.target.value }))} /></Field>
        {reschedule?.lead_id && <div className="small muted" style={{ marginTop: 8 }}>The lead's next follow-up date moves too.</div>}
      </Modal>
    </div>
  );
}

function NewFollowupModal({ open, onClose, onSaved }) {
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState({ type: 'call', due_date: addDaysStr(todayStr(), 1), priority: 'normal' });
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    try {
      await api.post('/followups', form);
      toast.success('Follow-up created');
      onSaved();
      onClose();
      setForm({ type: 'call', due_date: addDaysStr(todayStr(), 1), priority: 'normal' });
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New follow-up" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Create</Button></>}>
      <div className="form-grid">
        <Field label="What needs to be done" required className="full"><Input value={form.title} onChange={set('title')} autoFocus /></Field>
        <Field label="Customer" className="full"><CustomerPicker value={form.customer_id} onChange={(id) => setForm((s) => ({ ...s, customer_id: id }))} /></Field>
        <Field label="Type"><Select value={form.type} onChange={set('type')} options={FOLLOWUP_TYPES} /></Field>
        <Field label="Due date" required><Input type="date" value={form.due_date} onChange={set('due_date')} /></Field>
        <Field label="Priority"><Select value={form.priority} onChange={set('priority')} options={PRIORITIES.filter((p) => p.value !== 'urgent')} /></Field>
        {user.role !== 'sales_executive' && <Field label="Assign to"><UserSelect value={form.assigned_to} onChange={set('assigned_to')} placeholder="Me" /></Field>}
        <Field label="Notes" className="full"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}
