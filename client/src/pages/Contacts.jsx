import { Link } from 'react-router-dom';
import { CONTACT_ROLES, CUSTOMER_TYPES, CUSTOMER_STATUSES, labelOf } from '@shared/constants.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { timeAgo, downloadCsv } from '../lib/format.js';
import { Button, Card, DataTable, OptionBadge, PageHeader, Pagination, SearchBox, Select, Badge } from '../components/ui.jsx';
import { ContactActions, useMeta } from '../components/domain.jsx';
import { api } from '../api.js';

export default function Contacts() {
  const meta = useMeta();
  const [f, setFilter] = useUrlFilters();
  const query = { ...f, pageSize: 50 };
  const { data, loading } = useApi('/contacts', query);
  return (
    <div>
      <PageHeader title="Contacts" subtitle="Owners, purchase, technical, accounts and site contacts across all customers"
        actions={<Button icon="download" onClick={async () => {
          const all = await api.get('/contacts', { ...query, pageSize: 500, page: 1 });
          downloadCsv('contacts.csv', [
            { key: 'name', label: 'Name' }, { key: 'designation', label: 'Designation' }, { key: 'contact_role', label: 'Role', csv: (c) => labelOf(CONTACT_ROLES, c.contact_role) },
            { key: 'customer_name', label: 'Company' }, { key: 'phone', label: 'Phone' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'email', label: 'Email' },
            { key: 'preferred_channel', label: 'Preferred channel' }, { key: 'city', label: 'City' },
          ], all.rows);
        }}>Export</Button>} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Name, phone, email, company" />
        <Select className="sm" value={f.contact_role} onChange={(e) => setFilter({ contact_role: e.target.value })} placeholder="Any role" options={CONTACT_ROLES} />
        <Select className="sm" value={f.customer_type} onChange={(e) => setFilter({ customer_type: e.target.value })} placeholder="Any customer type" options={CUSTOMER_TYPES} />
        <Select className="sm" value={f.region_id} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="Any region" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} />
        <Select className="sm" value={f.sort} onChange={(e) => setFilter({ sort: e.target.value })} placeholder="Sort by name" options={[{ value: 'last_contacted', label: 'Recently contacted' }]} />
      </div>
      <Card flush>
        <DataTable rows={data?.rows} loading={loading} columns={[
          { key: 'name', label: 'Name', render: (c) => <div className="col" style={{ gap: 0 }}><span className="row" style={{ gap: 6 }}><strong>{c.name}</strong>{c.is_primary ? <Badge size="sm" color="blue">Primary</Badge> : null}</span><span className="tiny muted">{c.designation}</span></div> },
          { key: 'role', label: 'Role', render: (c) => <span className="small">{labelOf(CONTACT_ROLES, c.contact_role)}</span> },
          { key: 'company', label: 'Company', render: (c) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${c.customer_id}`}>{c.customer_name}</Link><span className="tiny muted">{labelOf(CUSTOMER_TYPES, c.customer_type)} · {c.city}</span></div> },
          { key: 'status', label: 'Account', render: (c) => <OptionBadge list={CUSTOMER_STATUSES} value={c.customer_status} size="sm" /> },
          { key: 'phone', label: 'Phone / email', render: (c) => <div className="col small" style={{ gap: 0 }}><span>{c.phone}</span><span className="muted">{c.email}</span></div> },
          { key: 'channel', label: 'Prefers', render: (c) => <span className="small">{c.preferred_channel}</span> },
          { key: 'last', label: 'Last contacted', render: (c) => <span className="small muted">{c.last_contacted ? timeAgo(c.last_contacted) : 'Never'}</span> },
          { key: 'owner', label: 'Account owner', render: (c) => <span className="small">{c.owner_name}</span> },
          { key: 'actions', label: '', render: (c) => <ContactActions phone={c.phone} whatsapp={c.whatsapp} email={c.email} /> },
        ]} />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
      </Card>
    </div>
  );
}
