// Quotation register: the latest revision of every quotation, with what needs attention first —
// approvals, quotations awaiting a decision, expiring and expired offers.
import { Link, useNavigate } from 'react-router-dom';
import { QUOTE_STATUSES, labelOf, toneOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, dateTime, pct, relDay, compactMoney } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Pagination, SearchBox, Select, EmptyState } from '../components/ui.jsx';
import { ApprovalBadge, Money, QuoteBadge, useMeta, usePeople } from '../components/domain.jsx';

const VIEWS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'approval', label: 'Needs approval' },
  { value: 'awaiting', label: 'Awaiting decision' },
  { value: 'expiring', label: 'Expiring in 7 days' },
  { value: 'expired', label: 'Expired' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
];

export default function Quotations() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const people = usePeople({ activeOnly: false });
  const [f, setFilter] = useUrlFilters();
  const { data, loading, error, reload } = useApi('/quotations', { ...f, pageSize: 50 });
  const margin = can('margin.view');
  const values = can('values.view');
  const summary = data?.summary || [];
  const byStatus = (st) => summary.filter((s) => s.status === st);
  const count = (st) => byStatus(st).reduce((n, s) => n + s.n, 0);
  const valueText = (st) => byStatus(st).filter((s) => s.value_minor).map((s) => compactMoney(s.value_minor, s.currency)).join(' + ') || '—';

  const columns = [
    { key: 'number', label: 'Quotation', sort: 'number', render: (r) => <div className="col" style={{ gap: 0 }}><Link to={`/quotations/${r.id}`} className="strong">{r.number}</Link><span className="tiny muted">rev {r.revision_no}{r.enquiry_code ? ` · ${r.enquiry_code}` : ''}</span></div> },
    { key: 'customer', label: 'Customer', sort: 'customer', render: (r) => <div className="col" style={{ gap: 0, maxWidth: 300 }}><span className="strong truncate">{r.company_name}</span><span className="tiny muted truncate">{r.subject || r.city || ''}</span></div> },
    { key: 'status', label: 'Status', render: (r) => (
      <span className="row wrap" style={{ gap: 4 }}>
        <QuoteBadge status={r.status} size="sm" />
        {r.status === 'draft' && <ApprovalBadge status={r.approval_status} size="sm" />}
        {r.expired && <Badge size="sm" tone="amber">Expired</Badge>}
        {r.viewed_at && r.status === 'issued' && <Badge size="sm" tone="teal" icon="eye">Opened</Badge>}
        {r.customer_response && r.status === 'issued' && <Badge size="sm" tone="violet">Customer replied</Badge>}
        {r.orders > 0 && <Badge size="sm" tone="green" icon="box">Ordered</Badge>}
      </span>
    ) },
    values && { key: 'value', label: 'Value (pre-GST)', align: 'num', sort: 'value', render: (r) => <Money minor={r.total_minor} currency={r.currency} /> },
    values && { key: 'discount', label: 'Discount', align: 'num', sort: 'discount', render: (r) => (r.discount_pct ? pct(r.discount_pct) : '—') },
    margin && { key: 'margin', label: 'Margin', align: 'num', sort: 'margin', render: (r) => (r.margin_pct === null || r.margin_pct === undefined ? <span className="muted">—</span> : <span className={r.margin_pct < (meta.settings.approvals?.minMarginPct ?? 0) ? 'danger-text strong' : ''}>{pct(r.margin_pct)}</span>) },
    { key: 'sent', label: 'Sent', sort: 'sent', render: (r) => (r.sent_at ? <span className="small">{dateTime(r.sent_at)}</span> : <span className="muted small">Not sent</span>) },
    { key: 'valid', label: 'Valid until', sort: 'valid', render: (r) => (r.validity_date ? <span className={r.expired ? 'danger-text small strong' : 'small'}>{r.status === 'issued' ? relDay(r.validity_date) : date(r.validity_date)}</span> : '—') },
    { key: 'owner', label: 'Owner', sort: 'owner', render: (r) => <span className="small">{r.owner_name || '—'}</span> },
  ];

  return (
    <div className="stack">
      <PageHeader title="Quotations" subtitle="Every quotation with its latest revision. Issued revisions never change — a change is a new revision."
        actions={can('quotes.edit') && <Button variant="primary" icon="plus" to="/quotations/new">New quotation</Button>} />
      <div className="tiles">
        <TileLink label="Needs approval" n={data?.attention?.approval ?? '—'} foot="Drafts outside the discount or margin policy" onClick={() => setFilter({ status: 'approval' })} alert={data?.attention?.approval > 0} />
        <TileLink label="Awaiting decision" n={count('issued')} foot={values ? valueText('issued') : 'Issued, no decision yet'} onClick={() => setFilter({ status: 'awaiting' })} />
        <TileLink label="Accepted" n={count('accepted')} foot={values ? valueText('accepted') : undefined} onClick={() => setFilter({ status: 'accepted' })} />
        <TileLink label="Expiring or expired" n={data ? data.attention.expiring + data.attention.expired : '—'} foot={data ? `${data.attention.expiring} within 7 days · ${data.attention.expired} already expired` : undefined} onClick={() => setFilter({ status: data?.attention?.expired ? 'expired' : 'expiring' })} alert={data?.attention?.expired > 0} />
      </div>
      <Chips options={VIEWS} value={f.status || ''} onChange={(v) => setFilter({ status: v })} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Number, customer, subject or enquiry" />
        <Select aria-label="Owner" value={f.owner || ''} onChange={(e) => setFilter({ owner: e.target.value })} placeholder="All owners" options={people.filter((p) => ['admin', 'coordinator', 'sales'].includes(p.group)).map((p) => ({ value: String(p.id), label: p.name }))} />
        <Select aria-label="Region" value={f.region_id || ''} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="All regions" options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} />
        <input type="date" className="input" aria-label="Created from" value={f.from || ''} onChange={(e) => setFilter({ from: e.target.value })} style={{ width: 'auto' }} />
        <input type="date" className="input" aria-label="Created to" value={f.to || ''} onChange={(e) => setFilter({ to: e.target.value })} style={{ width: 'auto' }} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading} onRowClick={(r) => navigate(`/quotations/${r.id}`)}
          sort={f.sort ? { key: f.sort, dir: f.dir || 'desc' } : null} onSort={(s) => setFilter({ sort: s.key, dir: s.dir })}
          empty={<EmptyState icon="quotation" title="No quotations here" message="Start one from an enquiry, a customer or the New quotation button." />}
          card={(r) => (
            <>
              <div className="row between"><strong>{r.number} <span className="muted small">rev {r.revision_no}</span></strong><Badge size="sm" tone={toneOf(QUOTE_STATUSES, r.status)}>{labelOf(QUOTE_STATUSES, r.status)}</Badge></div>
              <div>{r.company_name}</div>
              <div className="row between small"><span className="muted">{r.owner_name}</span>{values && <Money minor={r.total_minor} currency={r.currency} />}</div>
            </>
          )} />
        <Pagination page={data?.page} pageSize={data?.pageSize} count={data?.count} onChange={(page) => setFilter({ page })} />
      </Card>
    </div>
  );
}

function TileLink({ label, n, foot, onClick, alert }) {
  return (
    <button type="button" className={`tile ${alert ? 'alert' : ''}`} onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
      <span className="grow">
        <div className="label">{label}</div>
        <div className="value">{n}</div>
        {foot && <div className="foot">{foot}</div>}
      </span>
    </button>
  );
}
