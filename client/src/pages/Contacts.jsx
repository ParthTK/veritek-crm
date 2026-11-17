// Contact directory across all visible customers: who to call, how, and when they were last reached.
import { Link, useNavigate } from 'react-router-dom';
import { CONTACT_ROLES } from '@shared/constants.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { timeAgo, downloadCsv } from '../lib/format.js';
import { Badge, Button, Card, DataTable, ErrorState, PageHeader, Pagination, SearchBox, Select, EmptyState } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';

const waLink = (phone) => `https://wa.me/${String(phone || '').replace(/[^\d]/g, '')}`;

export default function Contacts() {
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters();
  const { data, loading, error, reload } = useApi('/contacts', { ...f, pageSize: 100 });
  const columns = [
    { key: 'name', label: 'Contact', render: (c) => (
      <div className="col" style={{ gap: 0 }}>
        <span className="strong">{c.name || <span className="muted">No name</span>} {c.is_primary ? <Badge size="sm" tone="violet">Primary</Badge> : null}</span>
        <span className="tiny muted">{[c.role, c.contact_role_label].filter(Boolean).join(' · ')}</span>
      </div>
    ) },
    { key: 'company', label: 'Company', render: (c) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${c.customer_id}`}>{c.company_name}</Link><span className="tiny muted">{c.city}</span></div> },
    { key: 'reach', label: 'Reach', render: (c) => (
      <div className="row wrap" style={{ gap: 6 }}>
        {c.do_not_contact ? <Badge size="sm" tone="red" icon="ban">Do not contact</Badge> : (
          <>
            {c.phone_raw && <a className="btn xs" href={`tel:${c.phone_raw.replace(/\s/g, '')}`} title={c.phone_raw}><Icon name="phone" size={13} />{c.phone_raw}</a>}
            {(c.whatsapp_raw || c.phone_raw) && <a className="btn xs" href={waLink(c.whatsapp_raw || c.phone_raw)} target="_blank" rel="noreferrer" aria-label="WhatsApp"><Icon name="whatsapp" size={13} /></a>}
            {c.email_raw && <a className="btn xs" href={`mailto:${c.email_raw}`} title={c.email_raw}><Icon name="mail" size={13} /></a>}
          </>
        )}
      </div>
    ) },
    { key: 'pref', label: 'Prefers', render: (c) => <span className="small">{c.preferred_channel || '—'}</span> },
    { key: 'last', label: 'Last contacted', render: (c) => (c.last_contact_at ? <span className="small">{timeAgo(c.last_contact_at)}</span> : <span className="muted small">Never</span>) },
  ];
  return (
    <div className="stack">
      <PageHeader title="Contacts" subtitle="Everyone at the companies you can see — call, WhatsApp or email in one click"
        actions={<Button icon="download" onClick={() => downloadCsv('contacts.csv', [
          { key: 'name', label: 'Name' }, { key: 'role', label: 'Designation' }, { key: 'contact_role_label', label: 'Role' }, { key: 'company_name', label: 'Company' }, { key: 'city', label: 'City' },
          { key: 'phone_raw', label: 'Phone' }, { key: 'email_raw', label: 'Email' }, { key: 'last_contact_at', label: 'Last contacted' },
        ], (data?.rows || []).filter((c) => !c.do_not_contact))}>Export this page</Button>} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Name, phone, email, designation or company" />
        <Select aria-label="Contact role" value={f.contact_role || ''} onChange={(e) => setFilter({ contact_role: e.target.value })} placeholder="Any role" options={CONTACT_ROLES} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading} onRowClick={(c) => navigate(`/customers/${c.customer_id}`)}
          empty={<EmptyState icon="contacts" title="No contacts found" message="Contacts are added on each customer's page." />}
          card={(c) => (
            <>
              <div className="row between"><strong>{c.name || 'No name'}</strong><span className="tiny muted">{c.last_contact_at ? timeAgo(c.last_contact_at) : 'Never contacted'}</span></div>
              <div className="small">{c.company_name}{c.role ? ` · ${c.role}` : ''}</div>
              {!c.do_not_contact && <div className="row wrap">{c.phone_raw && <a className="btn sm" href={`tel:${c.phone_raw.replace(/\s/g, '')}`}><Icon name="phone" size={14} /> Call</a>}{c.email_raw && <a className="btn sm" href={`mailto:${c.email_raw}`}><Icon name="mail" size={14} /> Email</a>}</div>}
            </>
          )} />
        <Pagination page={data?.page} pageSize={data?.pageSize} count={data?.count} onChange={(page) => setFilter({ page })} />
      </Card>
    </div>
  );
}
