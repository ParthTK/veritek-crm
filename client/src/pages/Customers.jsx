import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CUSTOMER_TYPES, CUSTOMER_STATUSES, VALUE_CATEGORIES, INDUSTRIES, LEAD_SOURCES, CONTACT_ROLES, labelOf,
} from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, timeAgo, downloadCsv } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, Field, Input, Modal, OptionBadge, PageHeader, Pagination, SearchBox, Select, Textarea, Tags, useToast, Checkbox,
} from '../components/ui.jsx';
import { UserSelect, useMeta, SALES_ROLES } from '../components/domain.jsx';

function Segment({ title, dimension, rows, value, onPick, labeler }) {
  const [more, setMore] = useState(false);
  if (!rows?.length) return null;
  const list = rows.filter((r) => r.key !== null && r.key !== undefined && r.key !== '');
  const shown = more ? list : list.slice(0, 6);
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="tiny muted strong" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>{title}</div>
      {shown.map((r) => {
        const active = String(value) === String(r.key);
        return (
          <button key={r.key} type="button" onClick={() => onPick(dimension, active ? '' : r.key)} className={`btn ghost sm ${active ? 'on' : ''}`}
            style={{ width: '100%', justifyContent: 'space-between', fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : undefined, background: active ? 'var(--accent-soft)' : undefined }}>
            <span className="truncate">{labeler ? labeler(r.key) : r.key}</span>
            <span className="muted tiny">{r.count}</span>
          </button>
        );
      })}
      {list.length > 6 && <button type="button" className="btn ghost xs" onClick={() => setMore(!more)}>{more ? 'Show less' : `+${list.length - 6} more`}</button>}
    </div>
  );
}

export default function Customers() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter, clear] = useUrlFilters();
  const [creating, setCreating] = useState(false);
  const query = { ...f, pageSize: 50 };
  const { data, loading } = useApi('/customers', query);
  const { data: seg } = useApi('/customers/segments');
  const sort = f.sort ? { key: f.sort, dir: f.dir || 'desc' } : null;
  const active = ['customer_type', 'industry', 'status', 'value_category', 'region_id', 'state', 'source', 'campaign_id', 'category_id', 'tag', 'assigned_to', 'outstanding'].filter((k) => f[k]);

  const columns = [
    { key: 'name', label: 'Customer', sort: 'name', render: (c) => (
      <div className="col" style={{ gap: 1, maxWidth: 300 }}>
        <Link to={`/customers/${c.id}`} className="strong truncate">{c.name}</Link>
        <span className="tiny muted">{c.code}{c.primary_contact ? ` · ${c.primary_contact}` : ''}</span>
        <Tags tags={c.tags} />
      </div>
    ) },
    { key: 'type', label: 'Type', sort: 'type', render: (c) => <span className="small">{labelOf(CUSTOMER_TYPES, c.customer_type)}<div className="tiny muted">{c.industry}</div></span> },
    { key: 'city', label: 'Location', sort: 'city', render: (c) => <span className="small">{[c.city, c.state].filter(Boolean).join(', ')}<div className="tiny muted">{c.region_name}</div></span> },
    { key: 'status', label: 'Status', sort: 'status', render: (c) => <span className="row" style={{ gap: 4 }}><OptionBadge list={CUSTOMER_STATUSES} value={c.status} size="sm" />{c.dormant && <Badge size="sm" color="amber">Dormant</Badge>}</span> },
    { key: 'value_category', label: 'Value', render: (c) => <OptionBadge list={VALUE_CATEGORIES} value={c.value_category} size="sm" /> },
    { key: 'owner', label: 'Owner', sort: 'owner', render: (c) => <span className="small">{c.owner_name || '—'}</span> },
    { key: 'open_leads', label: 'Open leads', align: 'num', render: (c) => c.open_leads || <span className="muted">0</span> },
    { key: 'value', label: 'Lifetime value', align: 'num', sort: 'value', render: (c) => (c.lifetime_value !== undefined ? inrCompact(c.lifetime_value) : '—') },
    can('payments.view') && { key: 'outstanding', label: 'Outstanding', align: 'num', sort: 'outstanding', render: (c) => (c.outstanding > 1 ? <span className="strong">{inrCompact(c.outstanding)}</span> : <span className="muted">—</span>) },
    { key: 'last_order', label: 'Last order', sort: 'last_order', render: (c) => <span className="small">{c.last_order_date ? date(c.last_order_date) : '—'}</span> },
    { key: 'last_activity', label: 'Last contact', sort: 'last_activity', render: (c) => <span className="small muted">{c.last_activity ? timeAgo(c.last_activity) : '—'}</span> },
  ];

  const exportCsv = async () => {
    const all = await api.get('/customers', { ...query, pageSize: 500, page: 1 });
    downloadCsv('customers.csv', [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'customer_type', label: 'Type', csv: (c) => labelOf(CUSTOMER_TYPES, c.customer_type) },
      { key: 'industry', label: 'Industry' }, { key: 'gstin', label: 'GSTIN' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'region_name', label: 'Region' },
      { key: 'status', label: 'Status' }, { key: 'value_category', label: 'Value category' }, { key: 'owner_name', label: 'Owner' }, { key: 'primary_contact', label: 'Primary contact' },
      { key: 'primary_phone', label: 'Phone' }, { key: 'lifetime_value', label: 'Lifetime value' }, { key: 'outstanding', label: 'Outstanding' }, { key: 'last_order_date', label: 'Last order' },
      { key: 'tags', label: 'Tags', csv: (c) => c.tags.map((t) => t.name).join('; ') },
    ], all.rows);
  };

  return (
    <div>
      <PageHeader title="Customers" subtitle="Company master with multi-dimensional segmentation"
        actions={<><Button icon="download" onClick={exportCsv}>Export</Button>{can('customers.edit') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New customer</Button>}</>} />
      <div className="grid" style={{ gridTemplateColumns: '230px minmax(0, 1fr)', alignItems: 'start' }}>
        <Card className="no-print" title="Segments" actions={active.length > 0 && <Button size="xs" variant="ghost" onClick={clear}>Clear</Button>}>
          {seg ? (
            <>
              <Segment title="Business status" dimension="status" rows={seg.status} value={f.status} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => (v === 'dormant' ? 'Dormant (no recent order)' : labelOf(CUSTOMER_STATUSES, v))} />
              <Segment title="Customer type" dimension="customer_type" rows={seg.customer_type} value={f.customer_type} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => labelOf(CUSTOMER_TYPES, v)} />
              <Segment title="Value category" dimension="value_category" rows={seg.value_category} value={f.value_category} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => labelOf(VALUE_CATEGORIES, v)} />
              <Segment title="Region" dimension="region_id" rows={seg.region_id} value={f.region_id} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => meta.regions.find((r) => r.id === v)?.name || '—'} />
              <Segment title="State" dimension="state" rows={seg.state} value={f.state} onPick={(k, v) => setFilter({ [k]: v })} />
              <Segment title="Industry" dimension="industry" rows={seg.industry} value={f.industry} onPick={(k, v) => setFilter({ [k]: v })} />
              <Segment title="Product interest" dimension="category_id" rows={seg.category_id} value={f.category_id} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => meta.categories.find((c) => c.id === v)?.name} />
              <Segment title="Source" dimension="source" rows={seg.source} value={f.source} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => labelOf(LEAD_SOURCES, v)} />
              <Segment title="Exhibition / campaign" dimension="campaign_id" rows={seg.campaign_id} value={f.campaign_id} onPick={(k, v) => setFilter({ [k]: v })} labeler={(v) => meta.campaigns.find((c) => c.id === v)?.name} />
              <Segment title="Tags" dimension="tag" rows={seg.tag} value={f.tag} onPick={(k, v) => setFilter({ [k]: v })} />
            </>
          ) : <span className="muted small">Loading…</span>}
        </Card>
        <div className="stack-sm" style={{ minWidth: 0 }}>
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Name, code, GSTIN, city, contact, phone" />
            <UserSelect className="sm" roles={SALES_ROLES} value={f.assigned_to} onChange={(e) => setFilter({ assigned_to: e.target.value })} placeholder="Any owner" />
            {can('payments.view') && <Checkbox label="With outstanding" checked={f.outstanding === '1'} onChange={(v) => setFilter({ outstanding: v ? '1' : '' })} />}
          </div>
          {active.length > 0 && (
            <div className="chips">
              {active.map((k) => <button key={k} type="button" className="chip on" onClick={() => setFilter({ [k]: '' })}>{k.replace('_id', '').replace('_', ' ')}: {k === 'region_id' ? meta.regions.find((r) => r.id === Number(f[k]))?.name : k === 'campaign_id' ? meta.campaigns.find((c) => c.id === Number(f[k]))?.name : k === 'category_id' ? meta.categories.find((c) => c.id === Number(f[k]))?.name : f[k]} ×</button>)}
            </div>
          )}
          <Card flush>
            <DataTable columns={columns} rows={data?.rows} loading={loading} sort={sort} onSort={(s) => setFilter({ sort: s.key, dir: s.dir })} onRowClick={(c) => navigate(`/customers/${c.id}`)} />
            <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
          </Card>
        </div>
      </div>
      <CustomerFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/customers/${id}`)} />
    </div>
  );
}

export function CustomerFormModal({ open, onClose, onSaved, customer }) {
  const meta = useMeta();
  const toast = useToast();
  const { can, user } = useAuth();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(customer
      ? { ...customer, interests: customer.interests.map((i) => i.id), tags: customer.tags.map((t) => t.name).join(', ') }
      : { customer_type: 'direct', status: 'prospect', value_category: 'regular', country: 'India', payment_terms_days: 30, interests: [], contact: { contact_role: 'purchase' } });
  }, [open, customer]);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const setContact = (k) => (e) => setForm((s) => ({ ...s, contact: { ...s.contact, [k]: e.target.value } }));

  const save = async (allowDuplicate = false) => {
    setBusy(true);
    try {
      const body = { ...form, tags: String(form.tags || '').split(',').map((t) => t.trim()).filter(Boolean), allow_duplicate: allowDuplicate };
      if (!customer && form.contact?.name) body.contacts = [{ ...form.contact, is_primary: true }];
      if (customer) {
        await api.put(`/customers/${customer.id}`, body);
        toast.success('Customer updated');
        onSaved?.(customer.id);
      } else {
        const res = await api.post('/customers', body);
        toast.success('Customer created');
        onSaved?.(res.id);
      }
      onClose();
    } catch (err) {
      if (err.details?.duplicate_id) {
        toast.error(`${err.message}. Opening the existing record.`);
        onClose();
        onSaved?.(err.details.duplicate_id);
      } else toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finance = can('finance.full');
  return (
    <Modal open={open} onClose={onClose} size="lg" title={customer ? `Edit ${customer.name}` : 'New customer'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => save()}>Save</Button></>}>
      <div className="form-grid">
        <div className="form-section">Company</div>
        <Field label="Company name" required className="full"><Input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Customer type"><Select value={form.customer_type} onChange={set('customer_type')} options={CUSTOMER_TYPES} /></Field>
        <Field label="Industry"><Input list="industries" value={form.industry} onChange={set('industry')} /><datalist id="industries">{INDUSTRIES.map((i) => <option key={i} value={i} />)}</datalist></Field>
        <Field label="GST number" hint="15 characters"><Input value={form.gstin} onChange={set('gstin')} style={{ textTransform: 'uppercase' }} /></Field>
        <Field label="Website"><Input value={form.website} onChange={set('website')} /></Field>
        <Field label="Status"><Select value={form.status} onChange={set('status')} options={CUSTOMER_STATUSES.filter((s) => finance || s.value !== 'blocked' || form.status === 'blocked')} /></Field>
        <Field label="Value category"><Select value={form.value_category} onChange={set('value_category')} options={VALUE_CATEGORIES} /></Field>
        <Field label="Assigned salesperson"><UserSelect roles={SALES_ROLES} value={form.assigned_to} onChange={set('assigned_to')} disabled={user.role === 'sales_executive'} placeholder={user.role === 'sales_executive' ? 'You' : 'Unassigned'} /></Field>
        <Field label="Source"><Select value={form.source} onChange={set('source')} placeholder="—" options={LEAD_SOURCES} /></Field>
        <Field label="Exhibition / campaign" className="full"><Select value={form.campaign_id} onChange={set('campaign_id')} placeholder="—" options={meta.campaigns.map((c) => ({ value: c.id, label: c.name }))} /></Field>

        <div className="form-section">Location</div>
        <Field label="Billing address" className="full"><Textarea rows={2} value={form.billing_address} onChange={set('billing_address')} /></Field>
        <Field label="Shipping address" className="full"><Textarea rows={2} value={form.shipping_address} onChange={set('shipping_address')} placeholder="Same as billing if blank" /></Field>
        <Field label="Region"><Select value={form.region_id} onChange={set('region_id')} placeholder="—" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} /></Field>
        <Field label="State"><Input list="states" value={form.state} onChange={set('state')} /><datalist id="states">{meta.states.map((s) => <option key={s} value={s} />)}</datalist></Field>
        <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
        <Field label="Country / PIN"><div className="row"><Input value={form.country} onChange={set('country')} /><Input value={form.pincode} onChange={set('pincode')} placeholder="PIN" /></div></Field>

        <div className="form-section">Commercial</div>
        <Field label="Payment terms"><Input value={form.payment_terms} onChange={set('payment_terms')} placeholder="e.g. 30 days from invoice" /></Field>
        <Field label="Credit days"><Input type="number" min="0" value={form.payment_terms_days} onChange={set('payment_terms_days')} disabled={Boolean(customer) && !finance} /></Field>
        {finance && <Field label="Credit limit (₹)"><Input type="number" min="0" value={form.credit_limit} onChange={set('credit_limit')} /></Field>}
        <Field label="Tags" hint="Comma separated"><Input list="ctags" value={form.tags} onChange={set('tags')} /><datalist id="ctags">{meta.tags.map((t) => <option key={t.id} value={t.name} />)}</datalist></Field>
        <Field label="Product interest" className="full">
          <div className="chips">
            {meta.categories.map((c) => {
              const on = (form.interests || []).includes(c.id);
              return <button key={c.id} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => setForm((s) => ({ ...s, interests: on ? s.interests.filter((x) => x !== c.id) : [...(s.interests || []), c.id] }))}>{c.name}</button>;
            })}
          </div>
        </Field>
        <Field label="Notes" className="full"><Textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>

        {!customer && (
          <>
            <div className="form-section">Primary contact</div>
            <Field label="Name"><Input value={form.contact?.name} onChange={setContact('name')} /></Field>
            <Field label="Role"><Select value={form.contact?.contact_role} onChange={setContact('contact_role')} options={CONTACT_ROLES} /></Field>
            <Field label="Phone"><Input value={form.contact?.phone} onChange={setContact('phone')} /></Field>
            <Field label="Email"><Input value={form.contact?.email} onChange={setContact('email')} /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}
