import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DISPATCH_STATUSES, ORDER_STAGES } from '@shared/constants.js';
import { api, fileUrl } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, number, inrCompact } from '../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, OptionBadge, PageHeader, SearchBox, Select, Tabs, Tile, Spinner } from '../components/ui.jsx';
import { DispatchModal, DeliverModal } from './OrderDetail.jsx';

export default function Dispatches() {
  const { can } = useAuth();
  const [f, setFilter] = useUrlFilters({ tab: 'shipments' });
  const { data, loading, reload } = useApi('/dispatches', { q: f.q, status: f.status, pending_pod: f.pending_pod, in_transit: f.in_transit });
  const [dispatchOrder, setDispatchOrder] = useState(null);
  const [deliver, setDeliver] = useState(null);
  const canEdit = can('dispatch.edit');

  if (!data) return <Spinner />;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const delivered = data.rows.filter((d) => d.delivered_date >= monthStart).length;
  const inTransit = data.rows.filter((d) => d.status !== 'delivered').length;
  const podPending = data.rows.filter((d) => d.status === 'delivered' && !d.pod_attachment_id).length;

  return (
    <div className="stack">
      <PageHeader title="Dispatch & logistics" subtitle="Shipments, transporter details, e-way bills and proof of delivery — one order can ship in parts" />
      <div className="tiles">
        <Tile label="Ready to dispatch" value={number(data.ready.length)} foot={`${number(data.ready.reduce((s, o) => s + o.qty_pending_dispatch, 0))} units pending`} />
        <Tile label="In transit" value={number(inTransit)} />
        <Tile label="Delivered this month" value={number(delivered)} />
        <Tile label="Proof of delivery pending" value={number(podPending)} alert={podPending > 0} />
      </div>

      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[
        { key: 'shipments', label: 'Shipments', count: data.rows.length },
        { key: 'ready', label: 'Ready for dispatch', count: data.ready.length },
      ]} />

      {f.tab === 'ready' ? (
        <Card flush>
          <DataTable rows={data.ready} empty={<div className="empty">No orders waiting for dispatch.</div>} columns={[
            { key: 'order', label: 'Order', render: (o) => <><Link to={`/orders/${o.id}`} className="strong">{o.number}</Link><div className="tiny muted">{o.customer_name} · {o.city}</div></> },
            { key: 'stage', label: 'Stage', render: (o) => <OptionBadge list={ORDER_STAGES} value={o.stage} /> },
            { key: 'pending', label: 'Pending units', align: 'num', render: (o) => number(o.qty_pending_dispatch) },
            { key: 'delivery', label: 'Committed delivery', render: (o) => <span className={o.is_delayed ? 'danger-text strong' : ''}>{date(o.delivery_date)}</span> },
            can('payments.view') && { key: 'payment', label: 'Payment', render: (o) => <span className="small">{o.outstanding > 1 ? `${inrCompact(o.outstanding)} outstanding` : 'Clear'}</span> },
            canEdit && { key: 'act', label: '', render: (o) => <Button size="xs" variant="primary" icon="truck" onClick={async () => setDispatchOrder(await api.get(`/orders/${o.id}`))}>Dispatch</Button> },
          ]} />
        </Card>
      ) : (
        <>
          <div className="filter-bar">
            <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Dispatch, order, LR, invoice, vehicle" />
            <Select className="sm" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} placeholder="Any status" options={DISPATCH_STATUSES} />
            <Checkbox label="In transit only" checked={f.in_transit === '1'} onChange={(v) => setFilter({ in_transit: v ? '1' : '' })} />
            <Checkbox label="POD pending" checked={f.pending_pod === '1'} onChange={(v) => setFilter({ pending_pod: v ? '1' : '' })} />
          </div>
          <Card flush>
            <DataTable rows={data.rows} loading={loading} columns={[
              { key: 'number', label: 'Dispatch', render: (d) => (
                <div className="col" style={{ gap: 0 }}>
                  <span className="strong">{d.number}</span>
                  <span className="tiny muted">{date(d.dispatch_date)}{d.dispatch_type === 'partial' ? ' · partial' : ''}</span>
                </div>
              ) },
              { key: 'order', label: 'Order / customer', render: (d) => <div className="col" style={{ gap: 0, maxWidth: 220 }}><Link to={`/orders/${d.order_id}`}>{d.order_number}</Link><span className="tiny muted truncate">{d.customer_name} · {d.city}</span></div> },
              { key: 'qty', label: 'Qty', align: 'num', render: (d) => number(d.qty) },
              { key: 'invoice', label: 'Invoice / e-way bill', render: (d) => <span className="small">{d.invoice_number || '—'}{d.eway_bill && <div className="tiny muted">EWB {d.eway_bill}</div>}</span> },
              { key: 'transport', label: 'Transport', render: (d) => <span className="small">{d.transporter}{d.vehicle_number && <div className="tiny muted">{d.vehicle_number}{d.lr_number ? ` · LR ${d.lr_number}` : ''}</div>}</span> },
              { key: 'boxes', label: 'Boxes', align: 'num', render: (d) => number(d.boxes) },
              { key: 'status', label: 'Status', render: (d) => (
                <div className="col" style={{ gap: 2 }}>
                  <OptionBadge list={DISPATCH_STATUSES} value={d.status} />
                  {d.overdue_delivery && <Badge size="sm" color="red">Delivery overdue</Badge>}
                </div>
              ) },
              { key: 'delivery', label: 'Delivery', render: (d) => (
                <div className="col small" style={{ gap: 0 }}>
                  <span>{d.delivered_date ? date(d.delivered_date) : d.expected_delivery_date ? `exp. ${date(d.expected_delivery_date)}` : '—'}</span>
                  {d.received_by && <span className="tiny muted">by {d.received_by}</span>}
                </div>
              ) },
              { key: 'pod', label: 'POD', render: (d) => (d.pod_attachment_id ? <a href={fileUrl(d.pod_attachment_id)} target="_blank" rel="noreferrer" className="small">View</a> : d.status === 'delivered' ? <Badge size="sm" color="amber">Pending</Badge> : <span className="muted">—</span>) },
              canEdit && { key: 'act', label: '', render: (d) => (d.status !== 'delivered' ? <Button size="xs" onClick={() => setDeliver(d)}>Mark delivered</Button> : null) },
            ]} />
          </Card>
        </>
      )}

      {dispatchOrder && <DispatchModal open onClose={() => setDispatchOrder(null)} order={dispatchOrder} onSaved={reload} />}
      <DeliverModal open={Boolean(deliver)} onClose={() => setDeliver(null)} dispatch={deliver} onSaved={reload} />
    </div>
  );
}
