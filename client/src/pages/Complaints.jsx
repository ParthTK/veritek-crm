import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES, COMPLAINT_SEVERITIES, WARRANTY_STATUSES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, number } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, Field, Input, Modal, OptionBadge, PageHeader, SearchBox, Select, Spinner, Tabs, Textarea, Tile, useToast } from '../components/ui.jsx';
import { LineChart, BarChartH } from '../components/charts.jsx';
import { CustomerPicker, PendingAttachments, UserSelect } from '../components/domain.jsx';

export default function Complaints() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [f, setFilter] = useUrlFilters({ tab: 'list', status: 'open' });
  const { data, loading, reload } = useApi(f.tab === 'list' ? '/complaints' : null, { q: f.q, status: f.status === 'all' ? '' : f.status, category: f.category, severity: f.severity, assigned_to: f.assigned_to, mine: f.mine });
  const insights = useApi(f.tab === 'insights' ? '/complaints/insights' : null);
  const [creating, setCreating] = useState(Boolean(params.get('new')));

  return (
    <div className="stack">
      <PageHeader title="Complaints & after-sales service" subtitle="Registration, warranty, site visits, root cause and customer feedback"
        actions={can('complaints.edit') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Register complaint</Button>} />
      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[{ key: 'list', label: 'Complaints' }, { key: 'insights', label: 'Quality insights' }]} />

      {f.tab === 'list' && (
        <>
          <div className="stack-sm" style={{ marginBottom: 12 }}>
            <Chips value={f.status} onChange={(status) => setFilter({ status: status || 'all' })} options={[
              { value: 'open', label: 'Open' }, ...COMPLAINT_STATUSES.map((s) => ({ value: s.value, label: s.label })), { value: 'all', label: 'All' },
            ]} />
            <div className="filter-bar" style={{ marginBottom: 0 }}>
              <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Number, customer, serial number, description" />
              <Select className="sm" value={f.category} onChange={(e) => setFilter({ category: e.target.value })} placeholder="Any issue type" options={COMPLAINT_CATEGORIES} />
              <Select className="sm" value={f.severity} onChange={(e) => setFilter({ severity: e.target.value })} placeholder="Any severity" options={COMPLAINT_SEVERITIES} />
              <UserSelect className="sm" roles={['service', 'quality']} value={f.assigned_to} onChange={(e) => setFilter({ assigned_to: e.target.value })} placeholder="Any technician" />
            </div>
          </div>
          <Card flush>
            <DataTable rows={data} loading={loading} onRowClick={(k) => navigate(`/complaints/${k.id}`)} columns={[
              { key: 'number', label: 'Complaint', render: (k) => <div className="col" style={{ gap: 0 }}><Link to={`/complaints/${k.id}`} className="strong">{k.number}</Link><span className="tiny muted">{date(k.created_at)} · {k.age_days}d old</span></div> },
              { key: 'customer', label: 'Customer', render: (k) => <div className="col" style={{ gap: 0, maxWidth: 200 }}><Link to={`/customers/${k.customer_id}`} className="truncate">{k.customer_name}</Link><span className="tiny muted">{k.city}{k.order_number ? ` · ${k.order_number}` : ''}</span></div> },
              { key: 'product', label: 'Product', render: (k) => <div className="col" style={{ gap: 0, maxWidth: 180 }}><span className="truncate small">{k.product_name || '—'}</span>{k.serial_number && <span className="tiny muted">SN {k.serial_number}</span>}</div> },
              { key: 'issue', label: 'Issue', render: (k) => <div className="col" style={{ gap: 0, maxWidth: 260 }}><span className="small">{labelOf(COMPLAINT_CATEGORIES, k.category)}</span><span className="tiny muted truncate">{k.description}</span></div> },
              { key: 'severity', label: 'Severity', render: (k) => <OptionBadge list={COMPLAINT_SEVERITIES} value={k.severity} size="sm" /> },
              { key: 'warranty', label: 'Warranty', render: (k) => <OptionBadge list={WARRANTY_STATUSES} value={k.warranty_status} size="sm" /> },
              { key: 'status', label: 'Status', render: (k) => <OptionBadge list={COMPLAINT_STATUSES} value={k.status} /> },
              { key: 'assigned', label: 'Technician', render: (k) => <span className="small">{k.assigned_to_name || <Badge color="amber" size="sm">Unassigned</Badge>}</span> },
              { key: 'resolution', label: 'Resolution', render: (k) => (k.resolved_at ? <span className="small">{date(k.resolved_at)}<div className="tiny muted">{k.age_days} days{k.feedback_rating ? ` · ${'★'.repeat(k.feedback_rating)}` : ''}</div></span> : <span className="muted small">Open</span>) },
            ]} />
          </Card>
        </>
      )}

      {f.tab === 'insights' && (insights.data ? <Insights data={insights.data} /> : <Spinner />)}

      <ComplaintForm open={creating} onClose={() => { setCreating(false); setParams(new URLSearchParams()); }} customerId={params.get('customer')} onSaved={(id) => navigate(`/complaints/${id}`)} />
    </div>
  );
}

function Insights({ data }) {
  const s = data.stats;
  const repeated = data.by_product.filter((p) => p.repeated);
  return (
    <div className="stack">
      <div className="tiles">
        <Tile label="Complaints (12 months)" value={number(s.count)} />
        <Tile label="Open now" value={number(s.open)} alert={s.open > 0} foot={`${number(s.critical_open)} critical`} />
        <Tile label="Avg. resolution time" value={s.avg_resolution_days ? `${number(s.avg_resolution_days, 1)} d` : '—'} />
        <Tile label="Avg. customer rating" value={s.avg_rating ? `${number(s.avg_rating, 1)} / 5` : '—'} />
        <Tile label="In warranty" value={number(s.in_warranty)} foot={`of ${number(s.count)} complaints`} />
        <Tile label="Products with repeat issues" value={number(repeated.length)} alert={repeated.length > 0} />
      </div>
      {repeated.length > 0 && (
        <Card title="Repeated product complaints" sub="Visible to management and the quality team" flush>
          <DataTable rows={repeated} rowKey="id" columns={[
            { key: 'name', label: 'Product', render: (p) => <div className="col" style={{ gap: 0 }}><strong>{p.name}</strong><span className="tiny muted">{p.sku}</span></div> },
            { key: 'complaints', label: 'Complaints', align: 'num' },
            { key: 'customers', label: 'Customers affected', align: 'num' },
            { key: 'open', label: 'Still open', align: 'num' },
            { key: 'units', label: 'Units supplied', align: 'num', render: (p) => number(p.units_sold) },
            { key: 'rate', label: 'Per 100 units', align: 'num', render: (p) => (p.rate_per_100 === null ? '—' : number(p.rate_per_100, 1)) },
            { key: 'cats', label: 'Issue types', render: (p) => <span className="small">{(p.categories || '').split(',').map((c) => labelOf(COMPLAINT_CATEGORIES, c)).join(', ')}</span> },
          ]} />
        </Card>
      )}
      <div className="grid grid-2">
        <Card title="Complaint trend" sub="Opened vs resolved per month">
          <LineChart data={data.by_month} x="month" series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved' }]} />
        </Card>
        <Card title="Issue types">
          <BarChartH data={data.by_category.map((c) => ({ ...c, label: labelOf(COMPLAINT_CATEGORIES, c.category) }))} label="label" series={[{ key: 'count', label: 'Complaints' }]} />
        </Card>
      </div>
      {data.repeat_serials.length > 0 && (
        <Card title="Units with more than one complaint" sub="Candidates for replacement instead of repair" flush>
          <DataTable rows={data.repeat_serials} rowKey="serial_number" columns={[
            { key: 'serial_number', label: 'Serial number', render: (r) => <span className="mono">{r.serial_number}</span> },
            { key: 'count', label: 'Complaints', align: 'num' },
            { key: 'customer_name', label: 'Customer' },
          ]} />
        </Card>
      )}
    </div>
  );
}

export function ComplaintForm({ open, onClose, onSaved, customerId }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const { data: customer } = useApi(open && form.customer_id ? `/customers/${form.customer_id}` : null);
  const { data: products } = useApi(open ? '/products' : null);

  useEffect(() => {
    if (open) {
      setForm({ customer_id: customerId ? Number(customerId) : '', severity: 'medium', category: 'hardware_failure' });
      setFiles([]);
    }
  }, [open, customerId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post('/complaints', { ...form, attachment_ids: files.map((x) => x.id) });
      toast.success('Complaint registered');
      onSaved(res.id);
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Register complaint"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Register</Button></>}>
      <div className="form-grid">
        <Field label="Customer" required className="full"><CustomerPicker value={form.customer_id} onChange={(id) => setForm((f) => ({ ...f, customer_id: id, contact_id: '', order_id: '' }))} /></Field>
        <Field label="Contact person"><Select value={form.contact_id} onChange={set('contact_id')} placeholder="—" options={(customer?.contacts || []).map((c) => ({ value: c.id, label: `${c.name}${c.phone ? ` · ${c.phone}` : ''}` }))} /></Field>
        <Field label="Related order" hint="Pulls the invoice automatically"><Select value={form.order_id} onChange={set('order_id')} placeholder="—" options={(customer?.orders || []).map((o) => ({ value: o.id, label: `${o.number} · ${date(o.order_date)}` }))} /></Field>
        <Field label="Product"><Select value={form.product_id} onChange={set('product_id')} placeholder="—" options={(products || []).map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))} /></Field>
        <Field label="Serial number"><Input value={form.serial_number} onChange={set('serial_number')} /></Field>
        <Field label="Invoice number"><Input value={form.invoice_number} onChange={set('invoice_number')} placeholder="Auto from order" /></Field>
        <Field label="Installation date"><Input type="date" value={form.installation_date} onChange={set('installation_date')} /></Field>
        <Field label="Warranty status" hint="Calculated from product warranty if left blank"><Select value={form.warranty_status} onChange={set('warranty_status')} placeholder="Auto" options={WARRANTY_STATUSES} /></Field>
        <Field label="Nature of issue"><Select value={form.category} onChange={set('category')} options={COMPLAINT_CATEGORIES} /></Field>
        <Field label="Severity"><Select value={form.severity} onChange={set('severity')} options={COMPLAINT_SEVERITIES} /></Field>
        <Field label="Assign to technician"><UserSelect roles={['service', 'quality']} value={form.assigned_to} onChange={set('assigned_to')} placeholder="Service team queue" /></Field>
        <Field label="Site visit date"><Input type="date" value={form.site_visit_date} onChange={set('site_visit_date')} /></Field>
        <Field label="Description of the problem" required className="full"><Textarea rows={3} value={form.description} onChange={set('description')} placeholder="What is the customer reporting?" /></Field>
        <Field label="Photos / videos from site" className="full"><PendingAttachments value={files} onChange={setFiles} voice kind="photo" accept="image/*,video/*,application/pdf" /></Field>
      </div>
    </Modal>
  );
}
