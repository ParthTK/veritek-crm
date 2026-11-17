// Complaints, returns and quality feedback. The reported symptom is kept apart from the confirmed root cause;
// the insights tab shows repeated product issues, rates only where dispatched units are known.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { COMPLAINT_SEVERITIES, WARRANTY_STATUSES, labelOf, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { date, monthLabel, number, timeAgo, todayLocal } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, Field, Input, Modal, PageHeader, SaveStatus, SearchBox, Select, Spinner, Stat, Tabs, Textarea, EmptyState } from '../components/ui.jsx';
import { CustomerPicker, OptionSelect, UserSelect, DateField, ProductSelect, useOptions, usePeople } from '../components/domain.jsx';
import { BarChartH, ColumnChart } from '../components/charts.jsx';

export const SeverityBadge = ({ value, size }) => (value ? <Badge tone={toneOf(COMPLAINT_SEVERITIES, value)} size={size}>{labelOf(COMPLAINT_SEVERITIES, value)}</Badge> : null);
export const WarrantyBadge = ({ value, size }) => (value ? <Badge tone={toneOf(WARRANTY_STATUSES, value)} size={size}>{labelOf(WARRANTY_STATUSES, value)}</Badge> : null);

export default function Complaints() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const people = usePeople();
  const categories = useOptions('complaint_category');
  const [f, setF] = useUrlFilters({ state: 'open', tab: 'list' });
  const { data, error, reload } = useApi(f.tab === 'list' ? '/complaints' : null, { state: f.state, q: f.q, severity: f.severity, warranty: f.warranty, category: f.category, owner: f.owner, mine: f.mine });
  const [adding, setAdding] = useState(Boolean(params.get('from_activity') || params.get('new')));
  return (
    <div className="stack">
      <PageHeader title="Complaints & service" subtitle="Register, site visits, root cause, resolution and customer feedback — the reported symptom is kept separate from the confirmed cause."
        actions={can('complaints.edit') && <Button variant="cta" icon="plus" onClick={() => setAdding(true)}>Register complaint</Button>} />
      <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[{ key: 'list', label: 'Complaints' }, { key: 'insights', label: 'Quality insights' }]} />
      {f.tab === 'list' && (
        <>
          <Chips value={f.state} onChange={(v) => setF({ state: v })} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Resolved & closed' }, { value: 'all', label: 'All' }]} />
          <div className="filter-bar">
            <SearchBox value={f.q} onChange={(q) => setF({ q })} placeholder="Complaint, customer, serial or description" />
            <Select aria-label="Severity" value={f.severity || ''} onChange={(e) => setF({ severity: e.target.value })} placeholder="Any severity" options={COMPLAINT_SEVERITIES} />
            <Select aria-label="Warranty" value={f.warranty || ''} onChange={(e) => setF({ warranty: e.target.value })} placeholder="Any warranty" options={WARRANTY_STATUSES} />
            <Select aria-label="Category" value={f.category || ''} onChange={(e) => setF({ category: e.target.value })} placeholder="Any issue" options={categories} />
            <Select aria-label="Owner" value={f.owner || ''} onChange={(e) => setF({ owner: e.target.value })} placeholder="Any owner" options={people.filter((p) => ['service', 'admin', 'coordinator', 'sales', 'production'].includes(p.group)).map((p) => ({ value: String(p.id), label: p.name }))} />
          </div>
          {error && <ErrorState error={error} onRetry={reload} />}
          <Card flush>
            <DataTable rows={data} loading={!data} onRowClick={(k) => navigate(`/complaints/${k.id}`)} empty={<EmptyState icon="complaint" title="No complaints in this view" />} columns={[
              { key: 'code', label: 'Complaint', render: (k) => <><strong>{k.code}</strong><div className="sub">received {date(k.received_date)} · {timeAgo(k.received_date)}</div></> },
              { key: 'customer', label: 'Customer', render: (k) => <>{k.company_name}<div className="sub">{k.city}</div></> },
              { key: 'product', label: 'Product', render: (k) => <>{k.product || '—'}{k.serial_batch && <div className="sub">SN {k.serial_batch}</div>}</> },
              { key: 'category', label: 'Reported issue', render: (k) => k.category },
              { key: 'sev', label: 'Severity', render: (k) => <span className="row wrap" style={{ gap: 4 }}><SeverityBadge value={k.severity} size="sm" /><WarrantyBadge value={k.warranty_status} size="sm" /></span> },
              { key: 'status', label: 'Status', render: (k) => <Badge tone={k.open ? 'amber' : 'green'}>{k.status_label}</Badge> },
              { key: 'owner', label: 'Owner', render: (k) => k.owner_name },
              { key: 'next', label: 'Next response', render: (k) => (k.next_due ? <span className={k.response_overdue ? 'danger-text strong' : ''}>{date(k.next_due)}</span> : k.open ? <Badge tone="red">None set</Badge> : <span className="small muted">{k.age_days} days to resolve</span>) },
            ]} />
          </Card>
        </>
      )}
      {f.tab === 'insights' && <Insights />}
      <Modal open={adding} size="lg" onClose={() => setAdding(false)} title="Register complaint">
        {adding && <NewComplaint activityId={params.get('from_activity')} customerId={params.get('customer')} orderId={params.get('order')} onSaved={(id) => navigate(`/complaints/${id}`)} />}
      </Modal>
    </div>
  );
}

function Insights() {
  const [from, setFrom] = useState('');
  const { data, error, reload } = useApi('/complaints/insights', { from });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const s = data.stats;
  return (
    <div className="stack">
      <div className="row wrap"><span className="small muted">Since</span><input type="date" className="input" value={from || data.since} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} aria-label="Since" /></div>
      <div className="tiles">
        <Stat k="Complaints" v={number(s.count)} d={`${number(s.open)} open · ${number(s.critical_open || 0)} critical open`} />
        <Stat k="Average time to resolve" v={s.avg_resolution_days === null ? '—' : `${number(s.avg_resolution_days, 1)} days`} />
        <Stat k="Customer rating" v={s.avg_rating ? `${number(s.avg_rating, 1)} / 5` : '—'} d={`${number(s.rated)} rated`} />
        <Stat k="Overdue responses" v={number(s.overdue_responses)} d={`${number(s.in_warranty || 0)} in warranty`} />
      </div>
      <div className="grid grid-2">
        <Card title="By month" sub="opened vs resolved">
          <ColumnChart data={data.by_month} x="month" xFormat={monthLabel} series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved' }]} format="number" />
        </Card>
        <Card title="Reported issues"><BarChartH data={data.by_category} label="category" series={[{ key: 'count', label: 'Complaints' }]} format="number" limit={10} /></Card>
        <Card title="By product" sub="rate per 100 dispatched units where known" flush>
          <DataTable compact rows={data.by_product} rowKey="id" columns={[
            { key: 'p', label: 'Product', render: (x) => <span><Link to={`/products/${x.id}`}>{x.code}</Link> <span className="tiny muted">{x.name}</span> {x.repeated && <Badge size="sm" tone="red">Repeated</Badge>}</span> },
            { key: 'c', label: 'Complaints', align: 'num', render: (x) => x.complaints },
            { key: 'cu', label: 'Customers', align: 'num', render: (x) => x.customers },
            { key: 'u', label: 'Units dispatched', align: 'num', render: (x) => (x.units_dispatched ? number(x.units_dispatched) : <span className="muted">unknown</span>) },
            { key: 'r', label: 'Per 100 units', align: 'num', render: (x) => (x.rate_per_100 === null ? <span className="muted">—</span> : x.rate_per_100) },
            { key: 'cat', label: 'Issues', render: (x) => <span className="tiny">{x.categories.join(', ')}</span> },
          ]} empty={<div className="muted small" style={{ padding: 12 }}>No complaints with a product.</div>} />
        </Card>
        <Card title="Confirmed root causes"><BarChartH data={data.by_cause} label="cause" series={[{ key: 'count', label: 'Complaints' }]} format="number" limit={10} /></Card>
        {data.repeat_serials.length > 0 && (
          <Card title="Same serial / batch more than once" flush>
            <DataTable compact rows={data.repeat_serials} rowKey="serial_batch" columns={[{ key: 's', label: 'Serial / batch', render: (x) => <span className="mono">{x.serial_batch}</span> }, { key: 'c', label: 'Customer', render: (x) => x.company_name }, { key: 'n', label: 'Complaints', align: 'num', render: (x) => x.count }]} />
          </Card>
        )}
        {data.repeat_customers.length > 0 && (
          <Card title="Customers with repeat complaints" flush>
            <DataTable compact rows={data.repeat_customers} columns={[{ key: 'c', label: 'Customer', render: (x) => <Link to={`/customers/${x.id}`}>{x.company_name}</Link> }, { key: 'n', label: 'Complaints', align: 'num', render: (x) => x.count }]} />
          </Card>
        )}
      </div>
      <div className="tiny muted">{data.note}</div>
    </div>
  );
}

function NewComplaint({ activityId, customerId, orderId, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({
    customer: customerId ? { id: Number(customerId), company_name: '' } : null, contact_id: '', order_id: orderId || '', product_id: null, serial_batch: '', received_date: todayLocal(), category_code: '', severity: 'medium',
    description: '', owner_id: null, next_response_date: '', invoice_ref: '', invoice_date: '', installation_date: '', warranty_status: '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (customerId) api.get(`/customers/${customerId}`).then((p) => setF((x) => ({ ...x, customer: { id: p.customer.id, company_name: p.customer.company_name } }))).catch(() => {});
  }, [customerId]);
  const { data: orders } = useApi(f.customer?.id ? '/orders' : null, { customer_id: f.customer?.id, view: 'all' });
  const { data: profile } = useApi(f.customer?.id ? `/customers/${f.customer.id}` : null);
  const cat = useOptions('complaint_category').find((o) => o.value === f.category_code);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      const r = await api.post('/complaints', { ...f, customer_id: f.customer?.id, contact_id: f.contact_id || undefined, order_id: f.order_id || undefined, warranty_status: f.warranty_status || undefined, source_activity_id: activityId || undefined });
      onSaved(r.id);
    }); }}>
      <Field label="Customer" required error={save.fields.customer_id}><CustomerPicker value={f.customer} onChange={(c) => set({ customer: c, contact_id: '', order_id: '' })} allowCreate={false} onNewCustomer={() => {}} /></Field>
      <div className="form-grid">
        <Field label="Contact" optional error={save.fields.contact_id}><Select value={f.contact_id} onChange={(e) => set({ contact_id: e.target.value })} placeholder="Who reported it" options={(profile?.contacts || []).filter((c) => c.active).map((c) => ({ value: String(c.id), label: c.name || c.phone_raw || c.email_raw }))} /></Field>
        <Field label="Order" optional error={save.fields.order_id}><Select value={f.order_id} onChange={(e) => set({ order_id: e.target.value })} options={(orders?.rows || []).map((o) => ({ value: String(o.id), label: `${o.code} · ${date(o.received_date)}` }))} placeholder="Not known" /></Field>
        <Field label="Product / model" optional><ProductSelect value={f.product_id} onChange={(v) => set({ product_id: v })} /></Field>
        <Field label="Serial / batch" optional hint="Not required if the customer cannot provide it"><Input value={f.serial_batch} onChange={(e) => set({ serial_batch: e.target.value })} /></Field>
        <Field label="Received" required error={save.fields.received_date}><Input type="date" max={todayLocal()} value={f.received_date} onChange={(e) => set({ received_date: e.target.value })} /></Field>
        <Field label="Reported issue" required error={save.fields.category_code}><OptionSelect category="complaint_category" value={f.category_code} onChange={(v) => set({ category_code: v })} /></Field>
        <Field label="Severity" error={save.fields.severity}><Select value={f.severity} onChange={(e) => set({ severity: e.target.value })} options={COMPLAINT_SEVERITIES} /></Field>
        <Field label="Owner" required error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['service', 'admin', 'coordinator', 'sales', 'production'].includes(p.group)} /></Field>
        <Field label="Short description" required className="full" error={save.fields.description}><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder={cat?.requires_note ? 'Describe the issue' : 'What the customer reported, in their words'} /></Field>
        <div className="form-section">Warranty</div>
        <Field label="Invoice number" optional><Input value={f.invoice_ref} onChange={(e) => set({ invoice_ref: e.target.value })} /></Field>
        <Field label="Invoice date" optional error={save.fields.invoice_date}><Input type="date" value={f.invoice_date} onChange={(e) => set({ invoice_date: e.target.value })} /></Field>
        <Field label="Installation date" optional error={save.fields.installation_date}><Input type="date" value={f.installation_date} onChange={(e) => set({ installation_date: e.target.value })} /></Field>
        <Field label="Warranty status" optional hint="Leave blank to work it out from the product warranty and these dates"><Select value={f.warranty_status} onChange={(e) => set({ warranty_status: e.target.value })} placeholder="Work it out" options={WARRANTY_STATUSES} /></Field>
        <DateField label="Next response date" required value={f.next_response_date} onChange={(v) => set({ next_response_date: v })} error={save.fields.next_response_date} />
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Register</Button></div>
    </form>
  );
}
