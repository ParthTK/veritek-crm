import { Link, useNavigate } from 'react-router-dom';
import { QUOTATION_STATUSES, QUOTE_AWAITING, ROLES, labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, relativeDay, daysFromToday, number, downloadCsv } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, OptionBadge, PageHeader, Pagination, SearchBox, Select, Checkbox, Input } from '../components/ui.jsx';
import { UserSelect, useMeta, SALES_ROLES } from '../components/domain.jsx';
import { api } from '../api.js';

export default function Quotations() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters();
  const query = { ...f, pageSize: 50 };
  const { data, loading } = useApi('/quotations', query);
  const sort = f.sort ? { key: f.sort, dir: f.dir || 'desc' } : null;
  const summary = Object.fromEntries((data?.summary || []).map((s) => [s.status, s]));
  const sum = (statuses) => statuses.reduce((a, s) => a + (summary[s]?.n || 0), 0);
  const counts = {
    '': (data?.summary || []).reduce((a, s) => a + s.n, 0), draft: sum(['draft']), approval_pending: sum(['approval_pending']), approved: sum(['approved']),
    awaiting: sum(QUOTE_AWAITING), won: sum(['accepted', 'converted']), rejected: sum(['rejected']), expired: sum(['expired']),
  };
  const marginVisible = can('margin.view');

  const columns = [
    { key: 'number', label: 'Quotation', sort: 'number', render: (q) => (
      <div className="col" style={{ gap: 0, maxWidth: 300 }}>
        <span><Link to={`/quotations/${q.id}`} className="strong">{q.number}</Link> <span className="muted small">v{q.current_version}</span></span>
        <span className="tiny muted truncate">{q.subject}</span>
      </div>
    ) },
    { key: 'customer', label: 'Customer', sort: 'customer', render: (q) => <div className="col" style={{ gap: 0, maxWidth: 220 }}><Link to={`/customers/${q.customer_id}`} className="truncate">{q.customer_name}</Link><span className="tiny muted">{q.city}{q.lead_code ? ` · ${q.lead_code}` : ''}</span></div> },
    { key: 'status', label: 'Status', sort: 'status', render: (q) => <OptionBadge list={QUOTATION_STATUSES} value={q.status} /> },
    { key: 'value', label: 'Grand total', align: 'num', sort: 'value', render: (q) => <strong>{inrCompact(q.grand_total)}</strong> },
    { key: 'discount', label: 'Discount', align: 'num', sort: 'discount', render: (q) => <span className={q.discount_pct > 10 ? 'warning-text' : ''}>{number(q.discount_pct, 1)}%</span> },
    marginVisible && { key: 'margin', label: 'Margin', align: 'num', sort: 'margin', render: (q) => (q.margin_pct === null || q.margin_pct === undefined ? '—' : <span className={q.margin_pct < 22 ? 'danger-text' : ''}>{number(q.margin_pct, 1)}%</span>) },
    { key: 'approval', label: 'Approval', render: (q) => (q.approval_role ? <Badge size="sm" color={q.status === 'approval_pending' ? 'amber' : 'slate'}>{labelOf(ROLES, q.approval_role)}</Badge> : <span className="muted small">Within policy</span>) },
    { key: 'valid', label: 'Valid until', sort: 'valid', render: (q) => {
      if (!q.valid_until) return <span className="muted">—</span>;
      const d = daysFromToday(q.valid_until);
      const live = QUOTE_AWAITING.includes(q.status);
      return <span className={`small ${live && d <= 3 ? (d < 0 ? 'danger-text' : 'warning-text strong') : ''}`}>{date(q.valid_until)}{live && d >= 0 && d <= 7 ? <div className="tiny">{relativeDay(q.valid_until)}</div> : null}</span>;
    } },
    { key: 'owner', label: 'Owner', sort: 'owner', render: (q) => <span className="small">{q.owner_name}</span> },
    { key: 'created', label: 'Created', sort: 'created', render: (q) => <span className="small muted">{date(q.created_at)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Quotations" subtitle="Price-master based quotations with versioning, approvals and customer tracking"
        actions={(
          <>
            <Button icon="download" onClick={async () => {
              const all = await api.get('/quotations', { ...query, pageSize: 500, page: 1 });
              downloadCsv('quotations.csv', [
                { key: 'number', label: 'Number' }, { key: 'current_version', label: 'Version' }, { key: 'customer_name', label: 'Customer' }, { key: 'subject', label: 'Subject' },
                { key: 'status', label: 'Status', csv: (q) => labelOf(QUOTATION_STATUSES, q.status) }, { key: 'taxable_total', label: 'Taxable' }, { key: 'grand_total', label: 'Grand total' },
                { key: 'discount_pct', label: 'Discount %' }, ...(marginVisible ? [{ key: 'margin_pct', label: 'Margin %' }] : []), { key: 'sent_at', label: 'Sent' }, { key: 'valid_until', label: 'Valid until' }, { key: 'owner_name', label: 'Owner' },
              ], all.rows);
            }}>Export</Button>
            {can('quotations.edit') && <Button variant="primary" icon="plus" to="/quotations/new">New quotation</Button>}
          </>
        )} />
      <div className="stack-sm" style={{ marginBottom: 12 }}>
        <Chips value={f.status || ''} onChange={(status) => setFilter({ status })} counts={counts} options={[
          { value: '', label: 'All' }, { value: 'draft', label: 'Draft' }, { value: 'approval_pending', label: 'Approval pending' }, { value: 'approved', label: 'Approved' },
          { value: 'awaiting', label: 'Awaiting response' }, { value: 'won', label: 'Accepted / converted' }, { value: 'rejected', label: 'Rejected' }, { value: 'expired', label: 'Expired' },
        ]} />
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Number, subject, customer" />
          <UserSelect className="sm" roles={[...SALES_ROLES, 'commercial']} value={f.owner_id} onChange={(e) => setFilter({ owner_id: e.target.value })} placeholder="Any owner" />
          <Select className="sm" value={f.region_id} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="Any region" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} />
          <Checkbox label="Expiring within 7 days" checked={f.expiring === '1'} onChange={(v) => setFilter({ expiring: v ? '1' : '' })} />
          <Checkbox label="Needed approval" checked={f.needs_approval === '1'} onChange={(v) => setFilter({ needs_approval: v ? '1' : '' })} />
          <span className="small muted">Created</span>
          <Input type="date" className="sm" style={{ width: 140 }} value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
          <Input type="date" className="sm" style={{ width: 140 }} value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
        </div>
      </div>
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading} sort={sort} onSort={(s) => setFilter({ sort: s.key, dir: s.dir })} onRowClick={(q) => navigate(`/quotations/${q.id}`)} />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
      </Card>
    </div>
  );
}
