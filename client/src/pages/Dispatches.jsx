// What has left the factory: transport details and whether it has arrived. Mistakes are reversed, never deleted.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, qty } from '../lib/format.js';
import { Button, Card, Chips, DataTable, Drawer, ErrorState, Modal, PageHeader, SearchBox, useToast, EmptyState } from '../components/ui.jsx';
import { DispatchBadge, transportText } from '../components/domain.jsx';
import { DeliveredForm, DispatchForm, ReasonForm, TransportForm } from '../components/forms.jsx';

export default function Dispatches() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setFilter] = useUrlFilters({ view: 'recent' });
  const { data, loading, error, reload } = useApi('/dispatches', { view: f.view, q: f.q });
  const [modal, setModal] = useState(null);
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const post = can('dispatch.post');
  const canDeliver = can('orders.communicate') || post;
  const columns = [
    { key: 'code', label: 'Dispatch', render: (d) => <strong>{d.code}</strong> },
    { key: 'cust', label: 'Customer', render: (d) => <Link to={`/customers/${d.customer_id}`}>{d.company_name}</Link> },
    { key: 'items', label: 'Items', render: (d) => <div className="stack-xs">{d.lines.map((l, i) => <span key={i} className="small"><Link to={`/orders/${l.order_id}`}>{l.order_code}</Link> · {qty(l.qty, l.unit)} × {l.product}</span>)}</div> },
    { key: 'date', label: 'Date', render: (d) => <span className="small">{d.status === 'planned' ? `Planned ${date(d.planned_date)}` : d.date_unknown ? 'Not known' : date(d.dispatch_date)}</span> },
    { key: 'transport', label: 'Transport', render: (d) => <span className="small">{transportText(d) || <span className="muted">—</span>}</span> },
    { key: 'status', label: 'Status', render: (d) => <DispatchBadge dispatch={d} /> },
    { key: 'act', label: '', render: (d) => (
      <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
        {d.status === 'posted' && !d.delivered_at && canDeliver && <Button size="xs" variant="primary" onClick={() => setModal({ type: 'delivered', d })}>Delivered</Button>}
        {d.status === 'posted' && post && <Button size="xs" variant="ghost" icon="edit" aria-label="Edit transport details" onClick={() => setModal({ type: 'edit', d })} />}
        {d.status === 'posted' && can('dispatch.reverse') && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'reverse', d })}>Reverse</Button>}
        {d.status === 'planned' && post && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'cancel', d })}>Cancel plan</Button>}
      </div>
    ) },
  ];
  return (
    <div className="stack">
      <PageHeader title="Dispatch" actions={post && <Button variant="cta" icon="truck" onClick={() => setModal({ type: 'new' })}>New dispatch</Button>} />
      <div className="row wrap between">
        <Chips value={f.view} onChange={(view) => setFilter({ view })} options={[
          { value: 'recent', label: 'All' },
          { value: 'in_transit', label: 'In transit', count: data?.counts?.in_transit },
          { value: 'delivered', label: 'Delivered' },
        ]} />
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Dispatch, order, LR or customer…" />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading}
          empty={<EmptyState icon="truck" title="No dispatches here" />}
          card={(d) => (
            <>
              <div className="row between"><strong>{d.code}</strong><DispatchBadge dispatch={d} /></div>
              <div className="small">{d.company_name}</div>
              <div className="tiny muted">{d.lines.map((l) => `${l.order_code} · ${qty(l.qty, l.unit)} × ${l.product}`).join(' · ')}</div>
              {d.status === 'posted' && !d.delivered_at && canDeliver && <div><Button size="sm" onClick={() => setModal({ type: 'delivered', d })}>Delivered</Button></div>}
            </>
          )} />
      </Card>
      <Drawer open={modal?.type === 'new'} wide onClose={() => setModal(null)} title="New dispatch">
        {modal?.type === 'new' && <DispatchForm onSaved={() => done('Dispatch saved')} />}
      </Drawer>
      <Modal open={modal?.type === 'edit'} size="sm" onClose={() => setModal(null)} title={`Transport — ${modal?.d?.code}`}>
        {modal?.type === 'edit' && <TransportForm dispatch={modal.d} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'delivered'} size="sm" onClose={() => setModal(null)} title={`Delivered — ${modal?.d?.code}`}>
        {modal?.type === 'delivered' && <DeliveredForm dispatch={modal.d} onSaved={() => done('Marked as delivered')} />}
      </Modal>
      <Modal open={modal?.type === 'reverse'} size="sm" onClose={() => setModal(null)} title={`Reverse ${modal?.d?.code}`}>
        {modal?.type === 'reverse' && <ReasonForm label="Why?" danger button="Reverse dispatch" note="The quantities go back on the order. This dispatch stays on record." onSubmit={(reason) => api.post(`/dispatches/${modal.d.id}/reverse`, { reason }).then(() => done('Dispatch reversed'))} />}
      </Modal>
      <Modal open={modal?.type === 'cancel'} size="sm" onClose={() => setModal(null)} title={`Cancel plan ${modal?.d?.code}`}>
        {modal?.type === 'cancel' && <ReasonForm label="Why?" danger button="Cancel plan" onSubmit={(reason) => api.post(`/dispatches/${modal.d.id}/cancel`, { reason }).then(() => done('Plan cancelled'))} />}
      </Modal>
    </div>
  );
}
