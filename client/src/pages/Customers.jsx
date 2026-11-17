import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, downloadAuthed } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { date, timeAgo } from '../lib/format.js';
import { VALUE_CATEGORIES, INDUSTRIES, labelOf, toneOf } from '@shared/constants.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Pagination, SearchBox, Modal, Field, Input, Checkbox, SaveStatus, Select, Textarea, useToast } from '../components/ui.jsx';
import { FilterBar, CountrySelect, UserSelect, useOptions, useMeta } from '../components/domain.jsx';

const REL = { prospect: { label: 'Prospect', tone: 'slate' }, active: { label: 'Active buyer', tone: 'green' }, dormant: { label: 'Dormant', tone: 'amber' } };
const TAG_TONE = (c) => c || 'slate';

export default function Customers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useUrlFilters({ page: '1' });
  const { data, error, loading, reload } = useApi('/customers', { ...f, pageSize: 50 });
  const { data: facets } = useApi('/customers/facets');
  const [adding, setAdding] = useState(false);
  return (
    <div className="stack">
      <PageHeader title="Customers" subtitle="Search by company, alias, phone, email, enquiry, order number or customer PO. Each record opens the one unified profile."
        actions={<>
          {can('export.lists') && <Button icon="download" onClick={() => downloadAuthed('/export/customers.csv', f).catch((e) => toast.error(e.message))}>Export</Button>}
          {can('customers.edit') && <Button variant="cta" icon="plus" onClick={() => setAdding(true)}>New customer</Button>}
        </>} />
      <div className="row wrap">
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Company, phone, email, order, PO…" autoFocus />
        <FilterBar value={f} onChange={setF} fields={['owner', 'segment', 'country']} />
        <Select aria-label="Flags" value={f.flag || ''} onChange={(e) => setF({ flag: e.target.value, provisional: e.target.value === 'provisional' ? '1' : '', dnc: e.target.value === 'dnc' ? '1' : '', credit_hold: e.target.value === 'credit_hold' ? '1' : '', include_archived: e.target.value === 'archived' ? '1' : '' })}
          options={[{ value: 'provisional', label: 'Provisional records' }, { value: 'dnc', label: 'Do not contact' }, { value: 'credit_hold', label: 'On credit hold' }, { value: 'archived', label: 'Include archived & merged' }]} placeholder="All customers" />
      </div>
      <Chips value={f.status || ''} onChange={(v) => setF({ status: v })} options={[
        { value: '', label: 'Everyone' }, { value: 'active', label: 'Active buyers' }, { value: 'dormant', label: 'Dormant buyers' }, { value: 'prospect', label: 'Prospects (no order yet)' }, { value: 'open_work', label: 'With open work' },
      ]} />
      {facets && (
        <div className="filter-bar">
          {facets.regions.length > 0 && <Select aria-label="Region" value={f.region_id || ''} onChange={(e) => setF({ region_id: e.target.value })} placeholder="All regions" options={facets.regions.map((x) => ({ value: String(x.value), label: `${x.label} (${x.n})` }))} />}
          {facets.states.length > 0 && <Select aria-label="State" value={f.state || ''} onChange={(e) => setF({ state: e.target.value })} placeholder="All states" options={facets.states.map((x) => ({ value: x.value, label: `${x.value} (${x.n})` }))} />}
          {facets.industries.length > 0 && <Select aria-label="Industry" value={f.industry || ''} onChange={(e) => setF({ industry: e.target.value })} placeholder="All industries" options={facets.industries.map((x) => ({ value: x.value, label: `${x.value} (${x.n})` }))} />}
          {facets.value_categories.length > 0 && <Select aria-label="Value category" value={f.value_category || ''} onChange={(e) => setF({ value_category: e.target.value })} placeholder="Any value category" options={facets.value_categories.map((x) => ({ value: x.value, label: `${labelOf(VALUE_CATEGORIES, x.value)} (${x.n})` }))} />}
          {facets.sources.length > 0 && <Select aria-label="First source" value={f.source || ''} onChange={(e) => setF({ source: e.target.value })} placeholder="Any first source" options={facets.sources.map((x) => ({ value: x.value, label: `${x.label || x.value} (${x.n})` }))} />}
          {facets.interests.length > 0 && <Select aria-label="Interested in" value={f.interest || ''} onChange={(e) => setF({ interest: e.target.value })} placeholder="Any product interest" options={facets.interests.map((x) => ({ value: String(x.value), label: `${x.label} (${x.n})` }))} />}
          {facets.tags.length > 0 && <Select aria-label="Tag" value={f.tag || ''} onChange={(e) => setF({ tag: e.target.value })} placeholder="Any tag" options={facets.tags.map((x) => ({ value: String(x.value), label: `${x.label} (${x.n})` }))} />}
          {facets.campaigns.length > 0 && <Select aria-label="Campaign" value={f.campaign_id || ''} onChange={(e) => setF({ campaign_id: e.target.value })} placeholder="Any campaign" options={facets.campaigns.map((x) => ({ value: String(x.value), label: `${x.label} (${x.n})` }))} />}
        </div>
      )}
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/customers/${r.id}`)}
          columns={[
            { key: 'name', label: 'Customer', render: (r) => <><strong>{r.company_name}</strong> {r.provisional ? <Badge size="sm">Provisional</Badge> : null}{r.do_not_contact ? <Badge size="sm" tone="slate" icon="ban">Do not contact</Badge> : null}{r.credit_hold ? <Badge size="sm" tone="red">Credit hold</Badge> : null}{r.archived_at ? <Badge size="sm">Archived</Badge> : null}<div className="sub">{r.code} · {r.primary_contact || 'no contact channel'}</div>{r.tags?.length > 0 && <div className="row wrap mt-8" style={{ gap: 4 }}>{r.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}</> },
            { key: 'rel', label: 'Relationship', render: (r) => <span className="stack-xs">{r.relationship && <Badge size="sm" tone={REL[r.relationship]?.tone}>{REL[r.relationship]?.label}</Badge>}{r.value_category && <Badge size="sm" tone={toneOf(VALUE_CATEGORIES, r.value_category)}>{labelOf(VALUE_CATEGORIES, r.value_category)}</Badge>}</span> },
            { key: 'where', label: 'Location', render: (r) => <>{[r.city, r.state, r.country_code].filter(Boolean).join(', ') || <span className="muted">Unknown</span>}{r.industry && <div className="sub">{r.industry}</div>}</> },
            { key: 'owner', label: 'Owner', render: (r) => r.owner_name },
            { key: 'last_order', label: 'Last order', render: (r) => (r.last_order_date ? date(r.last_order_date, { year: true }) : <span className="muted">None / unknown</span>) },
            { key: 'last_contact', label: 'Last contact', render: (r) => (r.last_contact_at ? timeAgo(r.last_contact_at) : <span className="muted">—</span>) },
            { key: 'open', label: 'Open work', render: (r) => <span className="small">{r.open_enquiries ? `${r.open_enquiries} enquiry · ` : ''}{r.active_orders ? `${r.active_orders} active order(s)` : ''}{!r.open_enquiries && !r.active_orders ? <span className="muted">—</span> : ''}</span> },
          ]}
          card={(r) => <><strong>{r.company_name}</strong><div className="small">{[r.city, r.country_code].filter(Boolean).join(', ')} · {r.owner_name}</div><div className="tiny muted">Last order {r.last_order_date ? date(r.last_order_date) : 'none'}</div></>}
        />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(p) => setF({ page: String(p) })} />
      </Card>
      <Modal open={adding} onClose={() => setAdding(false)} title="New customer" subtitle="Possible existing matches are shown before anything is created.">
        {adding && <NewCustomerForm onSaved={(id) => navigate(`/customers/${id}`)} />}
      </Modal>
    </div>
  );
}

function NewCustomerForm({ onSaved }) {
  const save = useSave();
  const types = useOptions('customer_type');
  const meta = useMeta();
  const sources = useOptions('enquiry_source');
  const [f, setF] = useState({ company_name: '', country_code: 'IN', city: '', state: '', segment: '', types: [], owner_id: null, contact_name: '', role: '', phone: '', email: '', provisional: false, external_account_id: '', industry: '', gstin: '', value_category: '', acquisition_source: '', campaign_id: '', region_id: '', tags: '', interests: [], billing_address: '', payment_terms: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const dup = save.error?.code === 'possible_duplicate' ? save.error.details.matches : null;
  const submit = (confirm) => save.run(async () => {
    const r = await api.post('/customers', {
      company_name: f.company_name, country_code: f.country_code, city: f.city, state: f.state || undefined, segment: f.segment || undefined, types: f.types, owner_id: f.owner_id, provisional: f.provisional,
      industry: f.industry || undefined, gstin: f.gstin || undefined, value_category: f.value_category || undefined, acquisition_source: f.acquisition_source || undefined, campaign_id: f.campaign_id || undefined,
      region_id: f.region_id || undefined, tags: f.tags ? f.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined, interests: f.interests.length ? f.interests : undefined, billing_address: f.billing_address || undefined, payment_terms: f.payment_terms || undefined,
      external_account_id: f.external_account_id || undefined, contacts: [{ name: f.contact_name, role: f.role, phone: f.phone, email: f.email }], confirm_not_duplicate: confirm || undefined,
    });
    onSaved(r.id);
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <div className="form-grid">
        <Field label="Company name" required className="full" error={save.fields.company_name}><Input value={f.company_name} onChange={(e) => set({ company_name: e.target.value })} /></Field>
        <Field label="Country" hint="Unknown is allowed for a first capture"><CountrySelect value={f.country_code} onChange={(v) => set({ country_code: v })} /></Field>
        <Field label="City" optional><Input value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="Domestic / export" optional hint="Not inferred from the phone number"><Select value={f.segment} onChange={(e) => set({ segment: e.target.value })} options={[{ value: 'domestic', label: 'Domestic' }, { value: 'export', label: 'Export' }]} placeholder="From country" /></Field>
        <Field label="Owner" hint="Defaults to you"><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
        <Field label="State" optional hint="Sets the sales region when it is left blank"><Input value={f.state} onChange={(e) => set({ state: e.target.value })} list="indian-states" /></Field>
        <Field label="Region" optional error={save.fields.region_id}><Select value={f.region_id} onChange={(e) => set({ region_id: e.target.value })} placeholder="From the state" options={meta.regions.filter((r) => r.active).map((r) => ({ value: String(r.id), label: r.name }))} /></Field>
        <Field label="Industry" optional><Input value={f.industry} onChange={(e) => set({ industry: e.target.value })} list="industries" /><datalist id="industries">{INDUSTRIES.map((x) => <option key={x} value={x} />)}</datalist></Field>
        <Field label="GSTIN" optional error={save.fields.gstin}><Input value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
        <Field label="Value category" optional><Select value={f.value_category} onChange={(e) => set({ value_category: e.target.value })} placeholder="Not classified" options={VALUE_CATEGORIES} /></Field>
        <Field label="How they found us" optional><Select value={f.acquisition_source} onChange={(e) => set({ acquisition_source: e.target.value })} placeholder="Not known" options={sources} /></Field>
        {meta.campaigns.length > 0 && <Field label="Campaign" optional><Select value={f.campaign_id} onChange={(e) => set({ campaign_id: e.target.value })} placeholder="None" options={meta.campaigns.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>}
        <Field label="Tags" optional hint="Comma separated, e.g. OEM, Key panel builder"><Input value={f.tags} onChange={(e) => set({ tags: e.target.value })} /></Field>
        <Field label="Interested in" optional className="full"><div className="row wrap">{meta.categories.filter((c) => c.active).map((c) => <Checkbox key={c.id} label={c.name} checked={f.interests.includes(c.id)} onChange={(v) => set({ interests: v ? [...f.interests, c.id] : f.interests.filter((x) => x !== c.id) })} />)}</div></Field>
        <Field label="Billing address" optional className="full"><Textarea rows={2} value={f.billing_address} onChange={(e) => set({ billing_address: e.target.value })} /></Field>
        <Field label="Payment terms" optional className="full"><Input value={f.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} placeholder="e.g. 30% advance, balance 30 days from invoice" /></Field>
        <Field label="Customer types" optional className="full"><div className="row wrap">{types.map((t) => <Checkbox key={t.value} label={t.label} checked={f.types.includes(t.value)} onChange={(v) => set({ types: v ? [...f.types, t.value] : f.types.filter((x) => x !== t.value) })} />)}</div></Field>
        <div className="form-section">Contact (phone or email needed)</div>
        <Field label="Name" optional><Input value={f.contact_name} onChange={(e) => set({ contact_name: e.target.value })} /></Field>
        <Field label="Designation" optional><Input value={f.role} onChange={(e) => set({ role: e.target.value })} /></Field>
        <Field label="Phone" error={save.fields['contacts.0.phone'] || save.fields.contacts}><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" /></Field>
        <Field label="Email" error={save.fields['contacts.0.email']}><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Accounting ID" optional><Input value={f.external_account_id} onChange={(e) => set({ external_account_id: e.target.value })} /></Field>
        <div style={{ alignSelf: 'end' }}><Checkbox label="Provisional (details to be confirmed)" checked={f.provisional} onChange={(v) => set({ provisional: v })} /></div>
      </div>
      {dup && (
        <div className="match-card" role="alert">
          <div className="strong small">Possible existing customer — nothing has been created:</div>
          {dup.map((m) => <div key={m.id} className="row between mt-8"><span className="small"><strong>{m.company_name}</strong> {m.city ? `· ${m.city}` : ''} — {m.reasons.join('; ')}</span><Button size="xs" to={`/customers/${m.id}`}>Open</Button></div>)}
          <Button size="sm" className="mt-8" onClick={() => submit(true)}>It is a separate company — create it</Button>
        </div>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Create customer</Button></div>
    </form>
  );
}
