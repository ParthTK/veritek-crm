// Every quotation, by where it stands: pending, sent, approved or rejected.
import { useNavigate } from 'react-router-dom';
import { QUOTE_TRACKING } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Pagination, SearchBox, EmptyState } from '../components/ui.jsx';
import { Money, QuoteBadge } from '../components/domain.jsx';

export default function Quotations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters();
  const { data, loading, error, reload } = useApi('/quotations', { ...f, pageSize: 50 });
  const values = can('values.view');
  const columns = [
    { key: 'number', label: 'Quotation', render: (r) => <strong>{r.number}</strong> },
    { key: 'customer', label: 'Customer', render: (r) => r.company_name },
    { key: 'status', label: 'Status', render: (r) => <span className="row wrap" style={{ gap: 4 }}><QuoteBadge status={r.status} size="sm" />{r.expired && r.status === 'issued' && <Badge size="sm" tone="amber">Expired</Badge>}{r.orders > 0 && <Badge size="sm" tone="green" icon="box">Ordered</Badge>}</span> },
    values && { key: 'value', label: 'Value', align: 'num', render: (r) => <Money minor={r.total_minor} currency={r.currency} /> },
    { key: 'sent', label: 'Sent', render: (r) => (r.sent_at ? <span className="small">{date(r.sent_at)}</span> : <span className="muted small">Not sent</span>) },
    { key: 'owner', label: 'Assigned to', render: (r) => <span className="small">{r.owner_name || '—'}</span> },
  ];
  return (
    <div className="stack">
      <PageHeader title="Quotations" actions={can('quotes.edit') && <Button variant="cta" icon="plus" to="/quotations/new">New quotation</Button>} />
      <div className="row wrap between">
        <Chips value={f.status || ''} onChange={(v) => setFilter({ status: v })} options={[{ value: '', label: 'All' }, ...QUOTE_TRACKING.map((s) => ({ value: s.value, label: s.label, tone: s.tone, count: data?.tracking?.[s.value] }))]} />
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Number or customer…" />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading} onRowClick={(r) => navigate(`/quotations/${r.id}`)}
          empty={<EmptyState icon="quotation" title="No quotations here" />}
          card={(r) => <><div className="row between"><strong>{r.number}</strong><QuoteBadge status={r.status} size="sm" /></div><div>{r.company_name}</div>{values && <div className="small"><Money minor={r.total_minor} currency={r.currency} /></div>}</>} />
        <Pagination page={data?.page} pageSize={data?.pageSize} count={data?.count} onChange={(page) => setFilter({ page })} />
      </Card>
    </div>
  );
}
