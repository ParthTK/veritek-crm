// Active orders: what was ordered, how far along it is, payment, and when it is due out.
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, qty } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, SearchBox } from '../components/ui.jsx';
import { LineStateBadge, PhaseLabel, OutcomeBadges, PaymentBadge } from '../components/domain.jsx';

function OrderState({ o }) {
  if (o.status !== 'confirmed') return <Badge>Draft</Badge>;
  if (!o.active) return <OutcomeBadges outcome={o.outcome} size="sm" />;
  return (
    <span className="stack-xs">
      {o.overdue ? <LineStateBadge state="overdue" daysLate={o.max_days_late} /> : o.at_risk ? <LineStateBadge state="at_risk" /> : o.uncommitted ? <LineStateBadge state="uncommitted" /> : <LineStateBadge state="on_track" />}
      {o.ready_waiting > 0 && <Badge size="sm" tone="teal">Ready to dispatch</Badge>}
    </span>
  );
}

export default function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [f, setF] = useUrlFilters({ view: 'active' });
  const { data, error, loading, reload } = useApi('/orders', { view: f.view, state: f.state, q: f.q });
  const counts = data?.counts || {};
  const shown = f.view === 'closed' ? 'closed' : f.state || 'active';
  const show = (v) => setF(v === 'closed' ? { view: 'closed', state: '' } : { view: 'active', state: v === 'active' ? '' : v });
  return (
    <div className="stack">
      <PageHeader title="Orders" actions={can('orders.edit') && <Button variant="cta" icon="plus" to="/orders/new">New order</Button>} />
      <div className="row wrap between">
        <Chips value={shown} onChange={show} options={[
          { value: 'active', label: 'Active' },
          { value: 'delayed', label: 'Delayed', tone: 'red', count: f.view === 'active' ? counts.delayed : undefined },
          { value: 'ready_waiting', label: 'Ready to dispatch', count: f.view === 'active' ? counts.ready_waiting : undefined },
          { value: 'closed', label: 'Closed' },
        ]} />
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Order, PO or customer…" />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/orders/${r.id}`)}
          empty={<div className="empty">No orders here.</div>}
          columns={[
            { key: 'order', label: 'Order', render: (r) => <><strong>{r.code}</strong><div className="sub">{r.po_reference ? `PO ${r.po_reference}` : date(r.received_date)}</div></> },
            { key: 'customer', label: 'Customer', render: (r) => r.customer_name },
            { key: 'items', label: 'Items', render: (r) => <>{r.lines.slice(0, 2).map((l) => <div key={l.id} className="small">{qty(l.quantities.confirmed, l.unit)} × {l.product}</div>)}{r.lines.length > 2 && <div className="sub">+{r.lines.length - 2} more</div>}</> },
            { key: 'progress', label: 'Progress', render: (r) => (r.status === 'confirmed' && r.active ? <div style={{ minWidth: 110 }}><PhaseLabel phase={r.phase} /><div className="progress mt-8" title={`${r.progress.ready_pct}% ready · ${r.progress.dispatched_pct}% dispatched`}><span style={{ width: `${r.progress.ready_pct}%` }} /></div></div> : null) },
            { key: 'payment', label: 'Payment', render: (r) => <PaymentBadge payment={r.payment} /> },
            { key: 'state', label: 'Status', render: (r) => <OrderState o={r} /> },
            { key: 'due', label: 'Dispatch by', render: (r) => (r.earliest_due ? date(r.earliest_due) : <span className="muted">—</span>) },
          ]}
          card={(r) => <><div className="row between"><strong>{r.code} · {r.customer_name}</strong><PaymentBadge payment={r.payment} /></div>
            {r.lines.slice(0, 2).map((l) => <div key={l.id} className="small">{qty(l.quantities.confirmed, l.unit)} × {l.product}</div>)}
            <div className="row wrap"><OrderState o={r} />{r.earliest_due && <span className="small muted">by {date(r.earliest_due)}</span>}</div></>}
        />
      </Card>
    </div>
  );
}
