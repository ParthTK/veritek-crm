// Dispatch register: plans, shipments in transit, deliveries and customer notifications in one place.
// A plan changes no balance; only posting an actual dispatch does. Mistakes are reversed, never deleted.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DISPATCH_STATUSES, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { date, qty, todayLocal, downloadCsv } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, Drawer, ErrorState, Field, Input, Modal, Notice, PageHeader, SaveStatus, SearchBox, Select, Textarea, useToast, EmptyState,
} from '../components/ui.jsx';
import { DispatchForm } from '../components/forms.jsx';
import { DeliveredForm, ReasonForm } from './OrderDetail.jsx';

export default function Dispatches() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setFilter] = useUrlFilters({ view: 'recent' });
  const { data, loading, error, reload } = useApi('/dispatches', { view: f.view, q: f.q, from: f.from, to: f.to });
  const [modal, setModal] = useState(null);
  const counts = data?.counts || {};
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const post = can('dispatch.post');

  const columns = [
    { key: 'code', label: 'Dispatch', render: (d) => <div className="col" style={{ gap: 0 }}><strong>{d.code}</strong><span className="tiny muted">by {d.created_by_name || '—'}</span></div> },
    { key: 'cust', label: 'Customer', render: (d) => <Link to={`/customers/${d.customer_id}`}>{d.company_name}</Link> },
    { key: 'items', label: 'Items', render: (d) => (
      <div className="stack-xs">
        {d.lines.map((l, i) => <span key={i} className="small"><Link to={`/orders/${l.order_id}`}>{l.order_code}</Link> · {qty(l.qty, l.unit)} × {l.product}</span>)}
      </div>
    ) },
    { key: 'date', label: 'Date', render: (d) => (d.status === 'planned' || d.status === 'cancelled'
      ? <span className="small">Planned {date(d.planned_date)}{d.status === 'planned' && d.planned_date < todayLocal() ? <div className="tiny danger-text strong">Plan date passed</div> : null}</span>
      : <span className="small">{d.date_unknown ? 'Unknown (historical)' : date(d.dispatch_date)}{d.expected_arrival && !d.delivered_at ? <div className="tiny muted">ETA {date(d.expected_arrival)}</div> : null}</span>) },
    { key: 'transport', label: 'Transport', render: (d) => (
      <div className="tiny">
        {[d.carrier, d.tracking_no && `LR/AWB ${d.tracking_no}`].filter(Boolean).join(' · ') || <span className="muted">—</span>}
        {(d.vehicle_number || d.eway_bill) && <div className="muted">{[d.vehicle_number && `Vehicle ${d.vehicle_number}`, d.eway_bill && `E-way ${d.eway_bill}`].filter(Boolean).join(' · ')}</div>}
        {(d.boxes || d.weight_kg) && <div className="muted">{[d.boxes && `${d.boxes} boxes`, d.weight_kg && `${d.weight_kg} kg`].filter(Boolean).join(' · ')}</div>}
        {d.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer">Track</a>}
      </div>
    ) },
    { key: 'status', label: 'Status', render: (d) => (
      <span className="row wrap" style={{ gap: 4 }}>
        <Badge size="sm" tone={d.status === 'posted' ? (d.delivered_at ? 'green' : 'blue') : toneOf(DISPATCH_STATUSES, d.status)}>{d.status === 'posted' ? (d.delivered_at ? `Delivered ${date(d.delivered_at)}` : 'In transit') : d.status_label}</Badge>
        {d.status === 'posted' && d.notify_state === 'pending' && <Badge size="sm" tone="amber">Customer not informed</Badge>}
        {d.status === 'posted' && d.notify_state === 'recorded' && <Badge size="sm" tone="green" icon="check">Informed</Badge>}
        {d.override_reason && <Badge size="sm" tone="violet" title={d.override_reason}>Not-ready override</Badge>}
      </span>
    ) },
    { key: 'act', label: '', render: (d) => (
      <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
        {d.status === 'planned' && post && <Button size="xs" variant="cta" onClick={() => setModal({ type: 'post', d })}>Post as dispatched</Button>}
        {d.status === 'planned' && post && <Button size="xs" onClick={() => setModal({ type: 'edit', d })}>Edit plan</Button>}
        {d.status === 'planned' && post && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'cancel', d })}>Cancel</Button>}
        {d.status === 'posted' && d.notify_state === 'pending' && (can('orders.communicate') || post) && <Button size="xs" variant="primary" onClick={() => setModal({ type: 'notify', d })}>Customer informed</Button>}
        {d.status === 'posted' && !d.delivered_at && (can('orders.communicate') || post) && <Button size="xs" onClick={() => setModal({ type: 'delivered', d })}>Delivered</Button>}
        {d.status === 'posted' && post && <Button size="xs" variant="ghost" icon="edit" aria-label="Edit transport details" onClick={() => setModal({ type: 'edit', d })} />}
        {d.status === 'posted' && can('dispatch.reverse') && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'reverse', d })}>Reverse</Button>}
      </div>
    ) },
  ];

  return (
    <div className="stack">
      <PageHeader title="Dispatches" subtitle="Planned shipments, goods in transit, deliveries and whether the customer was told"
        actions={<>
          <Button icon="download" onClick={() => downloadCsv('dispatches.csv', [
            { key: 'code', label: 'Dispatch' }, { key: 'company_name', label: 'Customer' }, { key: 'status_label', label: 'Status' }, { key: 'dispatch_date', label: 'Dispatched' }, { key: 'planned_date', label: 'Planned' },
            { key: (d) => d.lines.map((l) => `${l.order_code} ${l.product} x ${l.qty}`).join('; '), label: 'Items' }, { key: 'carrier', label: 'Carrier' }, { key: 'tracking_no', label: 'LR / AWB' },
            { key: 'vehicle_number', label: 'Vehicle' }, { key: 'eway_bill', label: 'E-way bill' }, { key: 'delivered_at', label: 'Delivered' }, { key: 'notify_state', label: 'Customer informed' },
          ], data?.rows || [])}>Export</Button>
          {post && <Button variant="cta" icon="truck" onClick={() => setModal({ type: 'new' })}>New dispatch</Button>}
        </>} />
      <Chips value={f.view} onChange={(view) => setFilter({ view })} options={[
        { value: 'recent', label: 'All recent' },
        { value: 'planned', label: 'Planned', count: counts.planned },
        { value: 'in_transit', label: 'In transit', count: counts.in_transit },
        { value: 'not_informed', label: 'Customer not informed', count: counts.not_informed, tone: counts.not_informed ? 'amber' : '' },
        { value: 'delivered', label: 'Delivered' },
        { value: 'reversed', label: 'Reversed & cancelled' },
      ]} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Dispatch, order, PO, LR/AWB, invoice or customer" />
        <input type="date" className="input" aria-label="From" value={f.from || ''} onChange={(e) => setFilter({ from: e.target.value })} style={{ width: 'auto' }} />
        <input type="date" className="input" aria-label="To" value={f.to || ''} onChange={(e) => setFilter({ to: e.target.value })} style={{ width: 'auto' }} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data?.rows} loading={loading}
          empty={<EmptyState icon="truck" title="No dispatches here" message={f.view === 'planned' ? 'Plan a dispatch to see it here before it leaves.' : 'Nothing matches these filters.'} />}
          card={(d) => (
            <>
              <div className="row between"><strong>{d.code}</strong><Badge size="sm">{d.status === 'posted' ? (d.delivered_at ? 'Delivered' : 'In transit') : d.status_label}</Badge></div>
              <div className="small">{d.company_name}</div>
              <div className="tiny muted">{d.lines.map((l) => `${l.order_code} · ${qty(l.qty, l.unit)} × ${l.product}`).join(' · ')}</div>
              <div className="row wrap">
                {d.status === 'planned' && post && <Button size="sm" variant="cta" onClick={() => setModal({ type: 'post', d })}>Post</Button>}
                {d.status === 'posted' && !d.delivered_at && <Button size="sm" onClick={() => setModal({ type: 'delivered', d })}>Delivered</Button>}
              </div>
            </>
          )} />
      </Card>

      <Drawer open={modal?.type === 'new'} wide onClose={() => setModal(null)} title="New dispatch" subtitle="Dispatched now, or a plan for later">
        {modal?.type === 'new' && <DispatchForm onSaved={() => done('Saved')} />}
      </Drawer>
      <Modal open={modal?.type === 'post'} size="lg" onClose={() => setModal(null)} title={`Post ${modal?.d?.code} as dispatched`} subtitle="Adjust quantities to what actually left">
        {modal?.type === 'post' && <PostPlanForm d={modal.d} onSaved={() => done('Dispatch posted — balances recalculated')} />}
      </Modal>
      <Modal open={modal?.type === 'edit'} onClose={() => setModal(null)} title={`${modal?.d?.status === 'planned' ? 'Edit plan' : 'Transport details'} — ${modal?.d?.code}`} subtitle="Transport details never change quantities">
        {modal?.type === 'edit' && <TransportForm d={modal.d} onSaved={() => done('Details saved')} />}
      </Modal>
      <Modal open={modal?.type === 'cancel'} size="sm" onClose={() => setModal(null)} title={`Cancel plan ${modal?.d?.code}`}>
        {modal?.type === 'cancel' && <ReasonForm label="Why is this plan cancelled?" danger button="Cancel plan" note="The plan stays on record; no quantity changes." onSubmit={(reason) => api.post(`/dispatches/${modal.d.id}/cancel`, { reason }).then(() => done('Plan cancelled'))} />}
      </Modal>
      <Modal open={modal?.type === 'reverse'} size="sm" onClose={() => setModal(null)} title={`Reverse ${modal?.d?.code}`}>
        {modal?.type === 'reverse' && <ReasonForm label="Reason for the reversal" danger button="Reverse dispatch" note="The original dispatch stays in history; quantities and reports recalculate." onSubmit={(reason) => api.post(`/dispatches/${modal.d.id}/reverse`, { reason }).then(() => done('Dispatch reversed'))} />}
      </Modal>
      <Modal open={modal?.type === 'delivered'} size="sm" onClose={() => setModal(null)} title={`Delivery of ${modal?.d?.code}`}>
        {modal?.type === 'delivered' && <DeliveredForm dispatch={modal.d} onSaved={() => done('Delivery recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'notify'} size="sm" onClose={() => setModal(null)} title={`Customer told about ${modal?.d?.code}?`}>
        {modal?.type === 'notify' && <NotifyForm d={modal.d} onSaved={() => done('Customer notification recorded')} />}
      </Modal>
    </div>
  );
}

const transportInit = (d) => ({
  carrier: d.carrier || '', tracking_no: d.tracking_no || '', tracking_url: d.tracking_url || '', vehicle_number: d.vehicle_number || '', eway_bill: d.eway_bill || '',
  boxes: d.boxes ?? '', weight_kg: d.weight_kg ?? '', expected_arrival: d.expected_arrival || '', reference: d.reference || '', invoice_ref: d.invoice_ref || '', notes: d.notes || '',
});

function TransportFields({ f, set, save }) {
  return (
    <>
      <Field label="Carrier" optional><Input value={f.carrier} onChange={(e) => set({ carrier: e.target.value })} /></Field>
      <Field label="LR / AWB number" optional><Input value={f.tracking_no} onChange={(e) => set({ tracking_no: e.target.value })} /></Field>
      <Field label="Tracking link" optional error={save.fields.tracking_url}><Input value={f.tracking_url} onChange={(e) => set({ tracking_url: e.target.value })} placeholder="https://" /></Field>
      <Field label="Vehicle number" optional><Input value={f.vehicle_number} onChange={(e) => set({ vehicle_number: e.target.value })} /></Field>
      <Field label="E-way bill" optional><Input value={f.eway_bill} onChange={(e) => set({ eway_bill: e.target.value })} /></Field>
      <Field label="Expected arrival" optional error={save.fields.expected_arrival}><Input type="date" value={f.expected_arrival} onChange={(e) => set({ expected_arrival: e.target.value })} /></Field>
      <Field label="Boxes" optional error={save.fields.boxes}><Input type="number" min={0} value={f.boxes} onChange={(e) => set({ boxes: e.target.value })} /></Field>
      <Field label="Weight (kg)" optional error={save.fields.weight_kg}><Input type="number" min={0} step="any" value={f.weight_kg} onChange={(e) => set({ weight_kg: e.target.value })} /></Field>
      <Field label="Packing / dispatch ref" optional><Input value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
      <Field label="Invoice reference" optional><Input value={f.invoice_ref} onChange={(e) => set({ invoice_ref: e.target.value })} /></Field>
      <Field label="Notes" optional className="full"><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
    </>
  );
}

function TransportForm({ d, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ ...transportInit(d), planned_date: d.planned_date || '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/dispatches/${d.id}`, { ...f, planned_date: d.status === 'planned' ? f.planned_date : undefined }); onSaved(); }); }}>
      <div className="form-grid">
        {d.status === 'planned' && <Field label="Planned date" required error={save.fields.planned_date}><Input type="date" value={f.planned_date} onChange={(e) => set({ planned_date: e.target.value })} /></Field>}
        <TransportFields f={f} set={set} save={save} />
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function PostPlanForm({ d, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const [f, setF] = useState({ ...transportInit(d), dispatch_date: todayLocal(), override_reason: '' });
  const [qtys, setQtys] = useState(Object.fromEntries(d.lines.map((l) => [l.id, String(l.qty)])));
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const needsReason = save.fields.override_reason || save.error?.code === 'not_ready';
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => {
      await api.post(`/dispatches/${d.id}/post`, { ...f, override_reason: f.override_reason || undefined, qtys: Object.fromEntries(Object.entries(qtys).map(([k, v]) => [k, v === '' ? 0 : Number(v)])) }, { key });
      onSaved();
    }); }}>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Order / item</th><th className="num">Planned</th><th className="num" style={{ width: 130 }}>Actually sent</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id}>
              <td><strong>{l.order_code}</strong> · line {l.line_no} · {l.product}</td>
              <td className="num">{qty(l.qty, l.unit)}</td>
              <td><Input type="number" min={0} step="any" value={qtys[l.id]} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} aria-label={`Quantity sent for ${l.order_code} line ${l.line_no}`} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {Object.entries(save.fields).filter(([k]) => k.startsWith('lines')).map(([k, v]) => <Notice key={k} tone="danger">{v}</Notice>)}
      <div className="form-grid">
        <Field label="Actual dispatch date" required error={save.fields.dispatch_date}><Input type="date" max={todayLocal()} value={f.dispatch_date} onChange={(e) => set({ dispatch_date: e.target.value })} /></Field>
        <TransportFields f={f} set={set} save={save} />
        {needsReason && (
          <Field label="Reason to dispatch quantity not recorded as ready" required className="full" error={save.fields.override_reason} hint={can('dispatch.override') ? 'Allowed for the coordinator and management' : 'Only the coordinator or management can override'}>
            <Input value={f.override_reason} onChange={(e) => set({ override_reason: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Post dispatch</Button></div>
    </form>
  );
}

function NotifyForm({ d, onSaved }) {
  const save = useSave();
  const [channel, setChannel] = useState('email');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/dispatches/${d.id}/notify`, { channel }); onSaved(); }); }}>
      <div className="small muted">Record it only if the customer was actually told. A saved tracking number alone does not prove it.</div>
      <Field label="How they were told"><Select value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'phone', label: 'Phone call' }]} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Record</Button></div>
    </form>
  );
}
