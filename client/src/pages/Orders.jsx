import { Link, useNavigate } from 'react-router-dom';
import { ORDER_STAGES, PRIORITIES, MATERIAL_STATUSES, labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, number, daysFromToday, downloadCsv } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, OptionBadge, PageHeader, Pagination, Progress, SearchBox, Select, Checkbox, Tile } from '../components/ui.jsx';
import { UserSelect, useMeta, SALES_ROLES } from '../components/domain.jsx';
import { api } from '../api.js';

export const PAYMENT_BADGE = {
  not_invoiced: ['Not invoiced', 'slate'], advance_pending: ['Advance pending', 'amber'], advance_partial: ['Advance partial', 'amber'],
  advance_received: ['Advance received', 'teal'], unpaid: ['Unpaid', 'amber'], partially_paid: ['Part paid', 'blue'],
  overdue: ['Overdue', 'red'], paid: ['Paid', 'green'], invoiced_paid: ['Invoices paid', 'green'],
};
export const DISPATCH_BADGE = {
  not_dispatched: ['Not dispatched', 'slate'], partial: ['Partially dispatched', 'amber'], dispatched: ['Dispatched', 'teal'], delivered: ['Delivered', 'green'],
};

export default function Orders() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters();
  const { data, loading } = useApi('/orders', { ...f, pageSize: 50 });
  const finance = can('finance.values');

  const columns = [
    { key: 'number', label: 'Order', render: (o) => (
      <div className="col" style={{ gap: 0, maxWidth: 230 }}>
        <Link to={`/orders/${o.id}`} className="strong">{o.number}</Link>
        <span className="tiny muted truncate">PO {o.customer_po_number || '—'} · {date(o.order_date)}</span>
      </div>
    ) },
    { key: 'customer', label: 'Customer', render: (o) => <div className="col" style={{ gap: 0, maxWidth: 200 }}><Link to={`/customers/${o.customer_id}`} className="truncate">{o.customer_name}</Link><span className="tiny muted">{o.city}</span></div> },
    { key: 'stage', label: 'Stage', render: (o) => (
      <div className="col" style={{ gap: 2 }}>
        <OptionBadge list={ORDER_STAGES} value={o.stage} />
        <span className="row" style={{ gap: 4 }}>
          {o.priority !== 'normal' && <OptionBadge list={PRIORITIES} value={o.priority} size="sm" />}
          {o.status === 'on_hold' && <Badge size="sm" color="amber">On hold</Badge>}
          {o.material_status === 'shortage' && <Badge size="sm" color="red">Shortage</Badge>}
        </span>
      </div>
    ) },
    finance && { key: 'value', label: 'Order value', align: 'num', render: (o) => <strong>{inrCompact(o.grand_total)}</strong> },
    { key: 'progress', label: 'Production', render: (o) => (
      <div style={{ minWidth: 110 }}>
        <Progress value={o.qty_ordered ? (o.qty_produced / o.qty_ordered) * 100 : 0} />
        <span className="tiny muted">{number(o.qty_produced)} / {number(o.qty_ordered)} produced</span>
      </div>
    ) },
    { key: 'delivery', label: 'Delivery', render: (o) => {
      const d = daysFromToday(o.delivery_date);
      return (
        <div className="col" style={{ gap: 0 }}>
          <span className={o.is_delayed ? 'danger-text strong' : d <= 7 && o.status === 'active' ? 'warning-text' : ''}>{date(o.delivery_date)}</span>
          {o.is_delayed ? <span className="tiny danger-text">{o.delay_days} days late</span> : o.revised_delivery_date ? <span className="tiny muted">revised</span> : null}
        </div>
      );
    } },
    { key: 'dispatch', label: 'Dispatch', render: (o) => <Badge size="sm" color={DISPATCH_BADGE[o.dispatch_status][1]}>{DISPATCH_BADGE[o.dispatch_status][0]}</Badge> },
    can('payments.view') && { key: 'payment', label: 'Payment', render: (o) => (
      <div className="col" style={{ gap: 1 }}>
        <Badge size="sm" color={PAYMENT_BADGE[o.payment_status]?.[1]}>{PAYMENT_BADGE[o.payment_status]?.[0]}</Badge>
        {o.outstanding > 1 && <span className="tiny muted num">{inrCompact(o.outstanding)} due</span>}
      </div>
    ) },
    { key: 'factory', label: 'Unit', render: (o) => <span className="small">{o.factory_name?.replace(/ -.*/, '')}</span> },
    { key: 'owner', label: 'Sales owner', render: (o) => <span className="small">{o.sales_owner_name}</span> },
  ];

  return (
    <div>
      <PageHeader title="Sales orders" subtitle="Purchase order to delivery, with production, dispatch and payment status in one place"
        actions={<Button icon="download" onClick={async () => {
          const all = await api.get('/orders', { ...f, pageSize: 500 });
          downloadCsv('sales-orders.csv', [
            { key: 'number', label: 'Order' }, { key: 'customer_po_number', label: 'Customer PO' }, { key: 'customer_name', label: 'Customer' },
            { key: 'order_date', label: 'Order date' }, { key: 'stage', label: 'Stage', csv: (o) => labelOf(ORDER_STAGES, o.stage) }, { key: 'priority', label: 'Priority' },
            { key: 'grand_total', label: 'Order value' }, { key: 'delivery_date', label: 'Delivery date' }, { key: 'delay_days', label: 'Days late' },
            { key: 'delay_reason', label: 'Delay reason' }, { key: 'dispatch_status', label: 'Dispatch' }, { key: 'payment_status', label: 'Payment' },
            { key: 'outstanding', label: 'Outstanding' }, { key: 'factory_name', label: 'Unit' }, { key: 'sales_owner_name', label: 'Sales owner' },
          ], all.rows);
        }}>Export</Button>} />

      {data?.totals && (
        <div className="tiles" style={{ marginBottom: 12 }}>
          <Tile label="Orders in view" value={number(data.totals.count)} />
          {finance && <Tile label="Order value" value={inrCompact(data.totals.value)} />}
          <Tile label="Delayed" value={number(data.totals.delayed)} alert={data.totals.delayed > 0} />
          {can('payments.view') && <Tile label="Outstanding" value={inrCompact(data.totals.outstanding)} />}
        </div>
      )}

      <div className="stack-sm" style={{ marginBottom: 12 }}>
        <Chips value={f.group || ''} onChange={(group) => setFilter({ group })} options={[
          { value: '', label: 'All open' }, { value: 'commercial', label: 'Commercial clearance' }, { value: 'production', label: 'In production' }, { value: 'dispatch', label: 'Packing & dispatch' },
        ]} />
        <div className="filter-bar" style={{ marginBottom: 0 }}>
          <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Order, PO number, customer" />
          <Select className="sm" value={f.stage} onChange={(e) => setFilter({ stage: e.target.value })} placeholder="Any stage" options={ORDER_STAGES} />
          <Select className="sm" value={f.priority} onChange={(e) => setFilter({ priority: e.target.value })} placeholder="Any priority" options={PRIORITIES} />
          <Select className="sm" value={f.factory_id} onChange={(e) => setFilter({ factory_id: e.target.value })} placeholder="Any unit" options={meta.factories.map((x) => ({ value: x.id, label: x.name }))} />
          {can('payments.view') && <Select className="sm" value={f.payment_status} onChange={(e) => setFilter({ payment_status: e.target.value })} placeholder="Any payment status" options={Object.entries(PAYMENT_BADGE).map(([v, [l]]) => ({ value: v, label: l }))} />}
          <Select className="sm" value={f.dispatch_status} onChange={(e) => setFilter({ dispatch_status: e.target.value })} placeholder="Any dispatch status" options={Object.entries(DISPATCH_BADGE).map(([v, [l]]) => ({ value: v, label: l }))} />
          <UserSelect className="sm" roles={SALES_ROLES} value={f.sales_owner_id} onChange={(e) => setFilter({ sales_owner_id: e.target.value })} placeholder="Any owner" />
          <Checkbox label="Delayed only" checked={f.delayed === '1'} onChange={(v) => setFilter({ delayed: v ? '1' : '' })} />
          <Checkbox label="Include closed" checked={f.include_closed === '1'} onChange={(v) => setFilter({ include_closed: v ? '1' : '' })} />
        </div>
      </div>

      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading} onRowClick={(o) => navigate(`/orders/${o.id}`)} />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
      </Card>
      <div className="small muted" style={{ marginTop: 8 }}>Material status legend: {MATERIAL_STATUSES.map((m) => m.label).join(' · ')}</div>
    </div>
  );
}
