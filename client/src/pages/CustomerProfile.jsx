// One customer: their deals, enquiries, quotations, orders and history, with contacts and details.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { labelOf, toneOf, INDIAN_STATES, VISIT_OUTCOMES } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, qty } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, ErrorState, Field, Input, Modal, Notice, PageHeader, SaveStatus, Spinner, Tabs, Checkbox, Select, Textarea, useToast,
} from '../components/ui.jsx';
import {
  LineStateBadge, OutcomeBadges, DueBadge, StageBadge, Timeline, UserSelect, CountrySelect, PhoneInput, useOptions, Money, QuoteBadge, DealReasons, PaymentBadge,
} from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';

export default function CustomerProfile() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const quick = useQuickEntry();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(`/customers/${id}`);
  const [tab, setTab] = useState('enquiries');
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { customer: c, summary: s } = data;
  const next = s.next_action;
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
  };
  const openNext = async () => {
    try {
      setModal({ type: 'task', task: await api.get(`/tasks/${next.id}`) });
    } catch (err) {
      toast.error(err.message);
    }
  };
  const contact = data.contacts.find((x) => x.is_primary && x.active) || data.contacts.find((x) => x.active);
  const visits = data.exhibition_visits || [];

  return (
    <div className="stack">
      {c.merged_into_id && <Notice tone="warn" title="This customer was merged">See <Link to={`/customers/${c.merged_into_id}`}>{c.merged_into_code}</Link>.</Notice>}
      <PageHeader crumbs={[{ label: 'Customers', to: '/customers' }, { label: c.code }]} title={c.company_name}
        subtitle={[[c.city, c.state].filter(Boolean).join(', '), contact && [contact.name, contact.phone_raw || contact.email_raw].filter(Boolean).join(' · '), c.owner_name && `Assigned to ${c.owner_name}`].filter(Boolean).join('  ·  ')}
        actions={!c.merged_into_id && <>
          {can('enquiries.edit') && <Button icon="plus" onClick={() => quick.open('enquiry', { customer: { id: c.id, company_name: c.company_name } })}>New enquiry</Button>}
          {can('quotes.edit') && <Button icon="quotation" to={`/quotations/new?customer_id=${c.id}`}>New quotation</Button>}
          {next ? <Button variant="cta" icon="calendar" onClick={openNext}>{next.purpose} · <DueBadge task={next} /></Button>
            : can('tasks.edit') && <Button variant="cta" icon="plus" onClick={() => setModal({ type: 'new_task' })}>Set next action</Button>}
        </>}
      />
      {(can('enquiries.view') || can('orders.view')) && <CustomerDeals customerId={c.id} />}
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'enquiries', label: 'Enquiries', count: data.enquiries.length },
        can('quotes.view') && { key: 'quotations', label: 'Quotations', count: data.quotations?.length || null },
        { key: 'orders', label: 'Orders' },
        visits.length > 0 && { key: 'exhibitions', label: 'Exhibitions', count: visits.length },
        { key: 'history', label: 'History' },
        { key: 'details', label: 'Contacts & details' },
      ]} />

      {tab === 'enquiries' && <Card flush><DataTable rows={data.enquiries} onRowClick={(e) => navigate(`/enquiries/${e.id}`)} empty={<div className="empty small">No enquiries yet.</div>} columns={[
        { key: 'code', label: 'Enquiry', render: (e) => <strong>{e.code}</strong> },
        { key: 'products', label: 'Products', render: (e) => e.products || '—' },
        { key: 'stage', label: 'Status', render: (e) => <StageBadge stage={e.stage} /> },
        { key: 'received', label: 'Received', render: (e) => (e.received_unknown ? '—' : date(e.received_at, { year: true })) },
        { key: 'owner', label: 'Assigned to', render: (e) => e.owner_name },
      ]} /></Card>}
      {tab === 'quotations' && <Card flush><DataTable rows={data.quotations} onRowClick={(q) => navigate(`/quotations/${q.id}`)} empty={<div className="empty small">No quotations yet.</div>} columns={[
        { key: 'n', label: 'Quotation', render: (q) => <strong>{q.number}</strong> },
        { key: 'st', label: 'Status', render: (q) => <QuoteBadge status={q.status} size="sm" /> },
        can('values.view') && { key: 'v', label: 'Value', align: 'num', render: (q) => <Money minor={q.total_minor} currency={q.currency} /> },
        { key: 'sent', label: 'Sent', render: (q) => (q.sent_at ? date(q.sent_at) : <span className="muted">Not sent</span>) },
      ]} /></Card>}
      {tab === 'orders' && <OrdersTab customerId={c.id} />}
      {tab === 'exhibitions' && <Card flush><DataTable rows={visits} columns={[
        { key: 'x', label: 'Exhibition', render: (v) => <Link to={`/campaigns/${v.campaign_id}`} className="strong">{v.exhibition}</Link> },
        { key: 'd', label: 'Visited', render: (v) => date(v.visited_on) },
        { key: 'i', label: 'Interested in', render: (v) => v.interest || '—' },
        { key: 'o', label: 'Outcome', render: (v) => (v.enquiry_id ? <Link to={`/enquiries/${v.enquiry_id}`}><Badge size="sm" tone="green">{v.enquiry_code}</Badge></Link> : <Badge size="sm" tone={toneOf(VISIT_OUTCOMES, v.outcome)}>{labelOf(VISIT_OUTCOMES, v.outcome)}</Badge>) },
      ]} /></Card>}
      {tab === 'history' && <HistoryTab customerId={c.id} />}
      {tab === 'details' && <DetailsTab data={data} onSaved={() => done('Saved')} onAction={setModal} />}

      <Modal open={modal?.type === 'task'} onClose={() => setModal(null)} title="Update follow-up" subtitle={modal?.task?.purpose}>
        {modal?.type === 'task' && <FollowupForm task={modal.task} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'new_task'} size="sm" onClose={() => setModal(null)} title="Set next action">
        {modal?.type === 'new_task' && <NewTaskForm customerId={c.id} ownerId={c.owner_id} onSaved={() => done('Next action set')} />}
      </Modal>
      <Modal open={modal?.type === 'contact'} size="sm" onClose={() => setModal(null)} title={modal?.contact ? 'Edit contact' : 'Add contact'}>
        {modal?.type === 'contact' && <ContactForm customerId={c.id} country={c.country_code} contact={modal.contact} onSaved={() => done('Contact saved')} />}
      </Modal>
    </div>
  );
}

function OrdersTab({ customerId }) {
  const navigate = useNavigate();
  const { data } = useApi('/orders', { customer_id: customerId, view: 'all' });
  if (!data) return <Spinner />;
  return (
    <Card flush>
      <DataTable rows={data.rows} onRowClick={(o) => navigate(`/orders/${o.id}`)} empty={<div className="empty small">No orders yet.</div>} columns={[
        { key: 'code', label: 'Order', render: (o) => <strong>{o.code}</strong> },
        { key: 'received', label: 'Received', render: (o) => date(o.received_date, { year: true }) },
        { key: 'lines', label: 'Items', render: (o) => o.lines.map((l) => <div key={l.id} className="small">{qty(l.quantities.confirmed)} × {l.product}</div>) },
        { key: 'status', label: 'Status', render: (o) => (o.status === 'draft' ? <Badge>Draft</Badge> : o.active && (o.overdue || o.at_risk) ? <LineStateBadge state={o.overdue ? 'overdue' : 'at_risk'} size="sm" /> : <OutcomeBadges outcome={o.outcome} size="sm" />) },
        { key: 'pay', label: 'Payment', render: (o) => <PaymentBadge payment={o.payment} /> },
      ]} />
    </Card>
  );
}

function HistoryTab({ customerId }) {
  const { data } = useApi(`/customers/${customerId}/timeline`, { filter: 'all' });
  return <Card>{data ? <Timeline items={data} /> : <Spinner />}</Card>;
}

function DetailsTab({ data, onSaved, onAction }) {
  const { can } = useAuth();
  const c = data.customer;
  const save = useSave();
  const sources = useOptions('enquiry_source', { keep: c.acquisition_source });
  const [f, setF] = useState({
    company_name: c.company_name, country_code: c.country_code, state: c.state || '', city: c.city || '', billing_address: c.billing_address || '', gstin: c.gstin || '',
    owner_id: c.owner_id, acquisition_source: c.acquisition_source || '', notes: c.notes || '',
  });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const edit = can('customers.edit') && !c.merged_into_id;
  const states = f.state && !INDIAN_STATES.includes(f.state) ? [f.state, ...INDIAN_STATES] : INDIAN_STATES;
  return (
    <div className="split">
      <Card title="Company">
        <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/customers/${c.id}`, { ...f, version: c.version }); onSaved(); }); }}>
          {save.conflict && <Notice tone="warn">Someone else saved changes first. <Button size="xs" onClick={() => window.location.reload()}>Reload</Button></Notice>}
          <div className="form-grid">
            <Field label="Company name" className="full" error={save.fields.company_name}><Input disabled={!edit} value={f.company_name} onChange={(e) => set({ company_name: e.target.value })} /></Field>
            <Field label="Country"><CountrySelect value={f.country_code} onChange={(v) => set({ country_code: v })} /></Field>
            <Field label="State">{f.country_code === 'IN' ? <Select disabled={!edit} value={f.state} onChange={(e) => set({ state: e.target.value })} placeholder="Choose…" options={states} /> : <Input disabled={!edit} value={f.state} onChange={(e) => set({ state: e.target.value })} />}</Field>
            <Field label="City"><Input disabled={!edit} value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="GSTIN" error={save.fields.gstin}><Input disabled={!edit} value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
            <Field label="Address" className="full"><Textarea disabled={!edit} rows={2} value={f.billing_address} onChange={(e) => set({ billing_address: e.target.value })} /></Field>
            <Field label="Assigned to"><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} /></Field>
            <Field label="How they found us"><Select disabled={!edit} value={f.acquisition_source} onChange={(e) => set({ acquisition_source: e.target.value })} placeholder="Not known" options={sources.filter((o) => o.value !== 'unknown' || o.value === f.acquisition_source)} /></Field>
            <Field label="Notes" className="full"><Textarea disabled={!edit} rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
          </div>
          {edit && <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>}
        </form>
      </Card>
      <Card title="Contacts" actions={edit && <Button size="sm" icon="plus" onClick={() => onAction({ type: 'contact' })}>Add</Button>}>
        <div className="stack-sm">
          {!data.contacts.length && <div className="small muted">No contacts yet.</div>}
          {data.contacts.map((ct) => (
            <div key={ct.id} className="row between">
              <span className="small"><strong>{ct.name || 'Unnamed'}</strong>{ct.is_primary ? <Badge size="sm" tone="violet"> Main</Badge> : null}{!ct.active ? <Badge size="sm"> Inactive</Badge> : null}<br />{[ct.role, ct.phone_raw, ct.email_raw].filter(Boolean).join(' · ') || 'No phone or email'}</span>
              {edit && <Button size="xs" variant="ghost" icon="edit" aria-label="Edit contact" onClick={() => onAction({ type: 'contact', contact: ct })} />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ContactForm({ customerId, country, contact, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ name: contact?.name || '', role: contact?.role || '', phone: contact?.phone_raw || '', email: contact?.email_raw || '', is_primary: Boolean(contact?.is_primary), active: contact ? Boolean(contact.active) : true });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { if (contact) await api.put(`/contacts/${contact.id}`, { ...f, version: contact.version }); else await api.post(`/customers/${customerId}/contacts`, f); onSaved(); }); }}>
      <Field label="Name" error={save.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Designation" optional><Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
      <Field label="Phone" error={save.fields.phone}><PhoneInput value={f.phone} country={country} onChange={(v) => setF({ ...f, phone: v })} /></Field>
      <Field label="Email" error={save.fields.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Checkbox label="Main contact" checked={f.is_primary} onChange={(v) => setF({ ...f, is_primary: v })} />
      {contact && <Checkbox label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function NewTaskForm({ customerId, ownerId, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ purpose: '', due_date: '', owner_id: ownerId, kind: 'customer' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post('/tasks', { ...f, customer_id: customerId }); onSaved(); }); }}>
      <Field label="Next action" required error={save.fields.purpose}><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      <Field label="Date" required error={save.fields.due_date}><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      <Field label="Assigned to" required><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

/** This customer's live deals: where each one is and what is holding it up. */
function CustomerDeals({ customerId }) {
  const navigate = useNavigate();
  const { data } = useApi('/pipeline', { customer_id: customerId });
  if (!data?.items?.length) return null;
  return (
    <Card title="In progress" flush>
      <DataTable rows={data.items} rowKey="key" compact onRowClick={(d) => navigate(d.link)} columns={[
        { key: 'c', label: 'Deal', render: (d) => <><strong>{d.code}</strong><div className="sub">{d.title}</div></> },
        { key: 's', label: 'Stage', render: (d) => <span className="small strong">{d.stage_label}</span> },
        { key: 'w', label: 'Holding it up', render: (d) => (d.stuck ? <DealReasons deal={{ ...d, reasons: d.reasons.filter((r) => r.severity !== 'info') }} limit={1} /> : <span className="muted small">Nothing</span>) },
        { key: 'p', label: 'Payment', render: (d) => <PaymentBadge payment={d.payment} /> },
      ]} />
    </Card>
  );
}
