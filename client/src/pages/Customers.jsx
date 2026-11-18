import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { timeAgo } from '../lib/format.js';
import { INDIAN_STATES } from '@shared/constants.js';
import { Button, Card, DataTable, ErrorState, PageHeader, Pagination, SearchBox, Modal, Field, Input, SaveStatus, Select } from '../components/ui.jsx';
import { FilterBar, CountrySelect, PhoneInput, UserSelect, useOptions, useMeta } from '../components/domain.jsx';

export default function Customers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useUrlFilters({ page: '1' });
  const { data, error, loading, reload } = useApi('/customers', { ...f, pageSize: 50 });
  const [adding, setAdding] = useState(false);
  return (
    <div className="stack">
      <PageHeader title="Customers" actions={can('customers.edit') && <Button variant="cta" icon="plus" onClick={() => setAdding(true)}>New customer</Button>} />
      <div className="row wrap">
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Company, phone or email…" autoFocus />
        <FilterBar value={f} onChange={setF} fields={['owner']} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/customers/${r.id}`)}
          empty={<div className="empty">No customers yet.</div>}
          columns={[
            { key: 'name', label: 'Customer', render: (r) => <><strong>{r.company_name}</strong><div className="sub">{r.primary_contact || 'No contact yet'}</div></> },
            { key: 'where', label: 'Location', render: (r) => [r.city, r.state].filter(Boolean).join(', ') || r.country_code || <span className="muted">—</span> },
            { key: 'owner', label: 'Assigned to', render: (r) => r.owner_name },
            { key: 'last_contact', label: 'Last contact', render: (r) => (r.last_contact_at ? timeAgo(r.last_contact_at) : <span className="muted">—</span>) },
            { key: 'open', label: 'Open', render: (r) => <span className="small">{[r.open_enquiries ? `${r.open_enquiries} enquiry` : '', r.active_orders ? `${r.active_orders} order` : ''].filter(Boolean).join(' · ') || <span className="muted">—</span>}</span> },
          ]}
          card={(r) => <><strong>{r.company_name}</strong><div className="small">{[r.city, r.state].filter(Boolean).join(', ')}</div><div className="tiny muted">{r.primary_contact || ''}</div></>}
        />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(p) => setF({ page: String(p) })} />
      </Card>
      <Modal open={adding} onClose={() => setAdding(false)} title="New customer">
        {adding && <NewCustomerForm onSaved={(id) => navigate(`/customers/${id}`)} />}
      </Modal>
    </div>
  );
}

/** The essentials only; everything else (address, GSTIN, tags, payment terms…) is added on the customer's page. */
function NewCustomerForm({ onSaved }) {
  const save = useSave();
  const meta = useMeta();
  // Leaving this blank already means "Not known", so the list does not repeat it as "Unknown".
  const sources = useOptions('enquiry_source').filter((o) => o.value !== 'unknown');
  const [f, setF] = useState({ company_name: '', contact_name: '', phone: '', email: '', city: '', country_code: 'IN', state: '', acquisition_source: '', campaign_id: '', owner_id: null });
  const set = (p) => {
    setF((x) => ({ ...x, ...p }));
    if (save.error) save.reset();
  };
  const india = f.country_code === 'IN';
  const exhibition = f.acquisition_source === 'exhibition';
  const events = meta.campaigns.filter((c) => (c.type === 'exhibition') === exhibition);
  const askEvent = (exhibition || f.acquisition_source === 'campaign') && events.length > 0;
  const dup = save.error?.code === 'possible_duplicate' ? save.error.details.matches : null;
  const submit = (confirm) => save.run(async () => {
    const r = await api.post('/customers', {
      company_name: f.company_name, country_code: f.country_code, city: f.city, state: (india && f.state) || undefined, owner_id: f.owner_id,
      acquisition_source: f.acquisition_source || undefined, campaign_id: (askEvent && f.campaign_id) || undefined,
      contacts: [{ name: f.contact_name, phone: f.phone, email: f.email }], confirm_not_duplicate: confirm || undefined,
    });
    onSaved(r.id);
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <div className="form-grid">
        <Field label="Company name" required className="full" error={save.fields.company_name}><Input autoFocus value={f.company_name} onChange={(e) => set({ company_name: e.target.value })} /></Field>
        <Field label="Contact person" optional error={save.fields['contacts.0.name']}><Input value={f.contact_name} onChange={(e) => set({ contact_name: e.target.value })} /></Field>
        <Field label="Phone" error={save.fields['contacts.0.phone'] || save.fields.contacts}><PhoneInput value={f.phone} country={f.country_code} onChange={(v) => set({ phone: v })} /></Field>
        <Field label="Email" error={save.fields['contacts.0.email']}><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="City" optional><Input value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="Country"><CountrySelect value={f.country_code} onChange={(v) => set({ country_code: v })} /></Field>
        {india && <Field label="State" optional><Select value={f.state} onChange={(e) => set({ state: e.target.value })} placeholder="Choose…" options={INDIAN_STATES} /></Field>}
        <Field label="How they found us" optional><Select value={f.acquisition_source} onChange={(e) => set({ acquisition_source: e.target.value, campaign_id: '' })} placeholder="Not known" options={sources} /></Field>
        {askEvent && <Field label={exhibition ? 'Which exhibition' : 'Which event'} optional><Select value={f.campaign_id} onChange={(e) => set({ campaign_id: e.target.value })} placeholder="Choose…" options={events.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>}
        <Field label="Assigned to"><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} placeholder="Me" filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
      </div>
      <div className="small muted">Add a phone or an email. Everything else can be added later on the customer's page.</div>
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
