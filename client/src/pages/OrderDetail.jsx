import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ORDER_STAGES, PRIORITIES, MATERIAL_STATUSES, QC_STATUSES, DISPATCH_STATUSES, PAYMENT_MODES, PRODUCTION_STAGE_KEYS, stageIndex, labelOf } from '@shared/constants.js';
import { api, fileUrl } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inr, inrCompact, number, date, dateTime, relativeDay, todayStr, addDaysStr } from '../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, ErrorState, Field, Input, KV, Modal, OptionBadge, PageHeader, Progress, Select, Spinner, Tabs, Textarea, Tile, useToast, EmptyState } from '../components/ui.jsx';
import { EntityAttachments, LogActivityModal, PendingAttachments, Timeline, UserSelect, useMeta } from '../components/domain.jsx';
import { PAYMENT_BADGE, DISPATCH_BADGE } from './Orders.jsx';
import Icon from '../components/Icon.jsx';

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { can, user } = useAuth();
  const { data: o, error, reload } = useApi(`/orders/${id}`);
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!o) return <Spinner />;
  const finance = can('payments.view');
  const values = can('finance.values');
  const idx = stageIndex(ORDER_STAGES, o.stage);
  const nextStage = ORDER_STAGES[idx + 1];
  const trackingUrl = `${window.location.origin}/portal/order/${o.tracking_token}`;

  const move = async (stage, extra = {}) => {
    try {
      await api.post(`/orders/${o.id}/stage`, { stage, ...extra });
      toast.success(`Moved to ${labelOf(ORDER_STAGES, stage)}`);
      reload();
      setModal(null);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'production', label: 'Production' },
    { key: 'dispatch', label: 'Dispatches', count: o.dispatches.length },
    finance && { key: 'payments', label: 'Payments', count: o.invoices.length },
    { key: 'history', label: 'History & notes' },
  ];

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Sales orders', to: '/orders' }, { label: o.number }]}
        title={<span className="row wrap" style={{ gap: 10 }}>{o.number}<OptionBadge list={ORDER_STAGES} value={o.stage} />{o.priority !== 'normal' && <OptionBadge list={PRIORITIES} value={o.priority} />}{o.status !== 'active' && <Badge color={o.status === 'cancelled' ? 'red' : 'amber'}>{o.status.replace('_', ' ')}</Badge>}</span>}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link>
          <span className="muted small">PO {o.customer_po_number} of {date(o.po_date)}</span>
          {o.quotation_number && <Link className="small" to={`/quotations/${o.quotation_id}`}>{o.quotation_number} v{o.quotation_version}</Link>}
          <span className="muted small">·</span>
          <span className={`small ${o.is_delayed ? 'danger-text strong' : ''}`}>Delivery {date(o.delivery_date)}{o.is_delayed ? ` · ${o.delay_days} days late` : ` · ${relativeDay(o.delivery_date)}`}</span>
        </span>}
        actions={(
          <>
            <Button icon="link" onClick={() => { navigator.clipboard?.writeText(trackingUrl); toast.success('Customer tracking link copied'); }}>Tracking link</Button>
            {can('activities.edit') && <Button icon="phone" onClick={() => setModal({ log: true })}>Log call</Button>}
            {can('dispatch.edit') && o.qty_pending_dispatch > 0 && idx >= stageIndex(ORDER_STAGES, 'packing') && <Button icon="truck" onClick={() => setModal({ dispatch: true })}>New dispatch</Button>}
            {can('payments.edit') && <Button icon="rupee" onClick={() => setModal({ payment: true })}>Record payment</Button>}
            {can('orders.edit') && <Button icon="edit" onClick={() => setModal({ edit: true })}>Edit</Button>}
            {nextStage && o.status === 'active' && <Button variant="primary" icon="chevronRight" onClick={() => setModal({ stage: nextStage.value })}>{nextStage.label}</Button>}
          </>
        )}
      />

      <Card>
        <div className="stack-sm">
          <div className="table-wrap"><div style={{ minWidth: 900 }}>
            <Stepper stages={ORDER_STAGES} current={o.stage} onSelect={o.status === 'active' ? (s) => setModal({ stage: s }) : undefined} />
          </div></div>
          {o.delay_reason && <div className="warn-box small">Delay reason: {o.delay_reason}{o.revised_delivery_date ? ` · revised delivery ${date(o.revised_delivery_date)}` : ''}</div>}
        </div>
      </Card>

      <div className="tiles">
        {values && <Tile label="Order value" value={inrCompact(o.grand_total)} foot={`incl. GST ${inrCompact(o.tax_total)}`} />}
        {finance && o.advance_required > 0 && <Tile label="Advance" value={inrCompact(o.advance_received)} foot={`of ${inrCompact(o.advance_required)} (${o.advance_pct}%)`} alert={o.advance_received < o.advance_required - 1} />}
        {finance && <Tile label="Invoiced" value={inrCompact(o.invoiced)} foot={`Received ${inrCompact(o.received)}`} />}
        {finance && <Tile label="Outstanding" value={inrCompact(o.outstanding)} foot={<Badge size="sm" color={PAYMENT_BADGE[o.payment_status]?.[1]}>{PAYMENT_BADGE[o.payment_status]?.[0]}</Badge>} alert={o.payment_status === 'overdue'} />}
        <Tile label="Production" value={`${o.qty_ordered ? Math.round((o.qty_produced / o.qty_ordered) * 100) : 0}%`} foot={`${number(o.qty_produced)} of ${number(o.qty_ordered)} units`} />
        <Tile label="Dispatch" value={<Badge color={DISPATCH_BADGE[o.dispatch_status][1]}>{DISPATCH_BADGE[o.dispatch_status][0]}</Badge>} foot={o.qty_pending_dispatch > 0 ? `${number(o.qty_pending_dispatch)} units pending` : 'Nothing pending'} />
        <Tile label="Committed delivery" value={date(o.delivery_date)} foot={o.is_delayed ? <span className="danger-text">{o.delay_days} days late</span> : relativeDay(o.delivery_date)} alert={o.is_delayed} />
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="stack">
          <Card title="Order items" flush>
            <DataTable rows={o.items} columns={[
              { key: 'desc', label: 'Item', render: (i) => <div style={{ maxWidth: 380 }}><strong>{i.description}</strong>{i.sku && <div className="tiny muted">{i.sku}{i.config?.options?.length ? ` · ${i.config.options.map((x) => x.name).join(', ')}` : ''}</div>}</div> },
              { key: 'qty', label: 'Ordered', align: 'num', render: (i) => `${number(i.qty)} ${i.unit}` },
              { key: 'produced', label: 'Produced', align: 'num', render: (i) => <span className={i.qty_produced >= i.qty ? 'success-text' : ''}>{number(i.qty_produced)}</span> },
              { key: 'dispatched', label: 'Dispatched', align: 'num', render: (i) => number(i.qty_dispatched) },
              { key: 'pending', label: 'Pending', align: 'num', render: (i) => number(Math.max(0, i.qty - i.qty_dispatched)) },
              values && { key: 'price', label: 'Unit price', align: 'num', render: (i) => inr(i.unit_price) },
              values && { key: 'disc', label: 'Disc', align: 'num', render: (i) => (i.discount_pct ? `${number(i.discount_pct, 1)}%` : '—') },
              values && { key: 'total', label: 'Line total', align: 'num', render: (i) => <strong>{inr(i.total)}</strong> },
            ]} footer={values && (
              <tr><td colSpan={5}>Taxable {inr(o.taxable_total)} · GST {inr(o.tax_total)}{o.freight ? ` · freight ${inr(o.freight)}` : ''}{o.installation ? ` · installation ${inr(o.installation)}` : ''}</td><td colSpan={3} className="num">Grand total {inr(o.grand_total)}</td></tr>
            )} />
          </Card>
          <div className="grid grid-3">
            <Card title="Commercial">
              <KV items={[
                ['Customer PO', o.customer_po_number],
                ['PO date', date(o.po_date)],
                ['Payment terms', o.payment_terms],
                o.advance_pct !== undefined && ['Advance', `${o.advance_pct}%${o.advance_required ? ` · ${inr(o.advance_required)}` : ''}`],
                ['Quotation', o.quotation_number && <Link to={`/quotations/${o.quotation_id}`}>{o.quotation_number} v{o.quotation_version}</Link>],
                ['Lead', o.lead_code && <Link to={`/leads/${o.lead_id}`}>{o.lead_code}</Link>],
                ['Order date', date(o.order_date)],
              ]} />
            </Card>
            <Card title="Responsible people">
              <KV items={[
                ['Sales owner', o.sales_owner_name],
                ['Commercial', o.commercial_owner_name],
                ['Production', o.production_owner_name],
                ['Dispatch', o.dispatch_owner_name],
                ['Accounts', o.accounts_owner_name],
                ['Factory / unit', o.factory_name],
                ['Customer contact', o.contact_name && `${o.contact_name}${o.contact_phone ? ` · ${o.contact_phone}` : ''}`],
              ]} />
            </Card>
            <Card title="Addresses & notes">
              <KV items={[
                ['Billing', o.billing_address],
                ['Shipping', o.shipping_address],
                ['Internal notes', o.internal_notes],
              ]} />
            </Card>
          </div>
          <Card title="Documents"><EntityAttachments entity="order" entityId={o.id} canUpload={can('orders.edit', 'dispatch.edit')} title="Purchase order, drawings, test certificates" /></Card>
        </div>
      )}

      {tab === 'production' && <ProductionPanel o={o} reload={reload} onUpdate={() => setModal({ production: true })} canEdit={can('production.edit')} />}

      {tab === 'dispatch' && (
        <div className="stack">
          {o.dispatches.length === 0 && <EmptyState icon="truck" title="Nothing dispatched yet" message={o.qty_pending_dispatch > 0 && can('dispatch.edit') ? 'Create a dispatch when the material is packed and ready.' : undefined} action={can('dispatch.edit') && idx >= stageIndex(ORDER_STAGES, 'packing') ? <Button variant="primary" onClick={() => setModal({ dispatch: true })}>New dispatch</Button> : null} />}
          {o.dispatches.map((d) => (
            <Card key={d.id} title={`${d.number} · ${d.dispatch_type === 'partial' ? 'Partial shipment' : 'Complete shipment'}`}
              sub={<OptionBadge list={DISPATCH_STATUSES} value={d.status} />}
              actions={can('dispatch.edit') && d.status !== 'delivered' && <Button size="sm" onClick={() => setModal({ deliver: d })}>Mark delivered</Button>}>
              <div className="grid grid-2">
                <KV items={[
                  ['Dispatch date', date(d.dispatch_date)],
                  ['Invoice', d.invoice_number],
                  ['E-way bill', d.eway_bill],
                  ['Transporter', d.transporter],
                  ['Vehicle number', d.vehicle_number],
                  ['LR / AWB number', d.lr_number],
                  ['Boxes', d.boxes],
                  ['Weight', d.weight_kg && `${d.weight_kg} kg`],
                ]} />
                <KV items={[
                  ['Expected delivery', date(d.expected_delivery_date)],
                  ['Delivered on', d.delivered_date ? date(d.delivered_date) : 'In transit'],
                  ['Material received', d.received_confirmed ? `Confirmed${d.received_by ? ` by ${d.received_by}` : ''}` : 'Not confirmed'],
                  ['Tracking', d.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer">Track shipment</a>],
                  ['Proof of delivery', d.pod ? <a href={fileUrl(d.pod.id)} target="_blank" rel="noreferrer">{d.pod.original_name}</a> : 'Not uploaded'],
                  ['Remarks', d.remarks],
                  ['Created by', `${d.created_by_name} · ${date(d.created_at)}`],
                ]} />
              </div>
              <div className="divider" />
              <table className="table compact">
                <thead><tr><th>Item</th><th className="num">Dispatched qty</th></tr></thead>
                <tbody>{d.items.map((i) => <tr key={i.id}><td>{i.description}</td><td className="num">{number(i.qty)} {i.unit}</td></tr>)}</tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      {tab === 'payments' && finance && (
        <div className="stack">
          <div className="grid grid-2">
            <Card title="Invoices" actions={can('payments.edit') && <Button size="sm" icon="plus" onClick={() => setModal({ invoice: true })}>Raise invoice</Button>} flush>
              <DataTable rows={o.invoices} compact empty={<EmptyState title="No invoices yet" />} columns={[
                { key: 'number', label: 'Invoice', render: (i) => <><strong>{i.number}</strong><div className="tiny muted">{date(i.invoice_date)}</div></> },
                { key: 'total', label: 'Total', align: 'num', render: (i) => inr(i.total) },
                { key: 'adj', label: 'Advance adj.', align: 'num', render: (i) => (i.advance_adjusted ? inr(i.advance_adjusted) : '—') },
                { key: 'paid', label: 'Received', align: 'num', render: (i) => inr(i.paid) },
                { key: 'balance', label: 'Balance', align: 'num', render: (i) => (i.balance > 1 ? <strong className={i.due_date < todayStr() ? 'danger-text' : ''}>{inr(i.balance)}</strong> : <Badge color="green" size="sm">Settled</Badge>) },
                { key: 'due', label: 'Due', render: (i) => <span className="small">{date(i.due_date)}</span> },
                can('payments.edit') && { key: 'act', label: '', render: (i) => (i.balance > 1 ? <Button size="xs" onClick={() => setModal({ payment: true, invoice: i })}>Receive</Button> : null) },
              ]} />
            </Card>
            <Card title="Payments received" flush>
              <DataTable rows={o.payments} compact empty={<EmptyState title="No payments yet" />} columns={[
                { key: 'date', label: 'Date', render: (p) => date(p.payment_date) },
                { key: 'type', label: 'Type', render: (p) => <Badge size="sm" color={p.type === 'advance' ? 'teal' : 'slate'}>{p.type === 'advance' ? 'Advance' : 'Against invoice'}</Badge> },
                { key: 'amount', label: 'Amount', align: 'num', render: (p) => <strong>{inr(p.amount)}</strong> },
                { key: 'tds', label: 'TDS', align: 'num', render: (p) => (p.tds_amount ? inr(p.tds_amount) : '—') },
                { key: 'mode', label: 'Mode', render: (p) => <span className="small">{labelOf(PAYMENT_MODES, p.mode)}{p.reference ? <div className="tiny muted">{p.reference}</div> : null}</span> },
              ]} />
            </Card>
          </div>
          {o.credit_notes?.length > 0 && (
            <Card title="Credit notes" flush>
              <DataTable rows={o.credit_notes} compact columns={[
                { key: 'number', label: 'Note', render: (c) => c.number }, { key: 'date', label: 'Date', render: (c) => date(c.note_date) },
                { key: 'amount', label: 'Amount', align: 'num', render: (c) => inr(c.amount) }, { key: 'reason', label: 'Reason' },
              ]} />
            </Card>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="grid grid-2">
          <Card title="Stage history" flush>
            {o.history.map((h) => (
              <div key={h.id} className="action-row small">
                <span className="grow">
                  <strong>{h.from_stage === h.to_stage ? h.note : labelOf(ORDER_STAGES, h.to_stage)}</strong>
                  {h.from_stage !== h.to_stage && h.note && <div className="tiny muted">{h.note}</div>}
                </span>
                <span className="tiny muted nowrap">{date(h.changed_at)}<div>{h.user_name || 'System'}</div></span>
              </div>
            ))}
          </Card>
          <Card title="Conversations about this order">
            <Timeline items={o.activities} filterable={false} />
          </Card>
        </div>
      )}

      <StageModal open={Boolean(modal?.stage)} onClose={() => setModal(null)} stage={modal?.stage} order={o} onConfirm={move} />
      <EditOrderModal open={Boolean(modal?.edit)} onClose={() => setModal(null)} order={o} onSaved={reload} />
      <ProductionModal open={Boolean(modal?.production)} onClose={() => setModal(null)} order={o} onSaved={reload} />
      <DispatchModal open={Boolean(modal?.dispatch)} onClose={() => setModal(null)} order={o} onSaved={reload} />
      <DeliverModal open={Boolean(modal?.deliver)} onClose={() => setModal(null)} dispatch={modal?.deliver} onSaved={reload} />
      <PaymentModal open={Boolean(modal?.payment)} onClose={() => setModal(null)} order={o} invoice={modal?.invoice} onSaved={reload} />
      <InvoiceModal open={modal?.invoice === true} onClose={() => setModal(null)} order={o} onSaved={reload} />
      <LogActivityModal open={Boolean(modal?.log)} onClose={() => setModal(null)} onSaved={reload} customerId={o.customer_id} orderId={o.id} />
    </div>
  );
}

function Stepper({ stages, current, onSelect }) {
  const idx = stageIndex(stages, current);
  return (
    <div className="stepper">
      {stages.map((s, i) => (
        <button key={s.value} type="button" className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''} ${onSelect && i !== idx ? 'clickable' : ''}`}
          onClick={onSelect && i !== idx ? () => onSelect(s.value) : undefined} title={onSelect ? `Move to ${s.label}` : s.label}>
          <span className="bar" />
          <span className="lbl">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

function StageModal({ open, onClose, stage, order, onConfirm }) {
  const [form, setForm] = useState({});
  const backwards = stageIndex(ORDER_STAGES, stage) < stageIndex(ORDER_STAGES, order.stage);
  const needsDelayReason = PRODUCTION_STAGE_KEYS.includes(stage) && order.is_delayed;
  return (
    <Modal open={open} onClose={onClose} size="sm" title={`Move to ${labelOf(ORDER_STAGES, stage)}`} subtitle={`${order.number} · currently ${labelOf(ORDER_STAGES, order.stage)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onConfirm(stage, form)}>Confirm</Button></>}>
      <div className="stack">
        {backwards && <div className="warn-box small">This moves the order backwards. The change is recorded in the stage history.</div>}
        {stage === 'ready_for_dispatch' && order.qc_status !== 'passed' && <div className="warn-box small">Quality check is “{labelOf(QC_STATUSES, order.qc_status)}” — packing needs a QC pass first.</div>}
        {stage === 'order_confirmed' && order.advance_required > 0 && order.advance_received < order.advance_required - 1 && <div className="warn-box small">Advance of {inr(order.advance_required)} is not fully received ({inr(order.advance_received)} so far).</div>}
        <Field label="Note" hint="Shown in the stage history and the customer tracking page"><Textarea rows={2} value={form.note || ''} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
        {(needsDelayReason || form.revised_delivery_date) && (
          <>
            <Field label="Revised delivery date"><Input type="date" value={form.revised_delivery_date || ''} onChange={(e) => setForm((f) => ({ ...f, revised_delivery_date: e.target.value }))} /></Field>
            <Field label="Delay reason"><Input value={form.delay_reason || ''} onChange={(e) => setForm((f) => ({ ...f, delay_reason: e.target.value }))} /></Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function ProductionPanel({ o, onUpdate, canEdit }) {
  const completion = o.revised_completion || o.planned_completion;
  const late = completion && completion < todayStr() && !o.actual_completion;
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Card title="Plan vs actual" actions={canEdit && <Button size="sm" icon="edit" onClick={onUpdate}>Update</Button>}>
          <KV items={[
            ['Order received', date(o.order_date)],
            ['Planned start', date(o.planned_start)],
            ['Planned completion', date(o.planned_completion)],
            ['Revised completion', o.revised_completion ? <span className="warning-text">{date(o.revised_completion)}</span> : '—'],
            ['Actual start', date(o.actual_start)],
            ['Actual completion', o.actual_completion ? <span className="success-text">{date(o.actual_completion)}</span> : late ? <span className="danger-text">Overdue</span> : 'In progress'],
            ['Committed delivery', <span className={o.is_delayed ? 'danger-text' : ''}>{date(o.delivery_date)}</span>],
            ['Factory / unit', o.factory_name],
          ]} />
        </Card>
        <Card title="Material & quality">
          <div className="stack">
            <div className="row between"><span className="muted small">Raw material</span><OptionBadge list={MATERIAL_STATUSES} value={o.material_status} /></div>
            {o.material_constraint && <div className="warn-box small">{o.material_constraint}</div>}
            <div className="row between"><span className="muted small">Quality check</span><OptionBadge list={QC_STATUSES} value={o.qc_status} /></div>
            {o.qc_remarks && <div className="small secondary">{o.qc_remarks}</div>}
            {o.delay_reason && <><div className="divider" style={{ margin: '4px 0' }} /><div className="small"><span className="muted">Delay reason: </span>{o.delay_reason}</div></>}
          </div>
        </Card>
        <Card title="Quantity progress">
          <div className="stack">
            <div>
              <div className="row between small"><span className="muted">Produced</span><span className="num">{number(o.qty_produced)} / {number(o.qty_ordered)}</span></div>
              <Progress value={o.qty_ordered ? (o.qty_produced / o.qty_ordered) * 100 : 0} />
            </div>
            <div>
              <div className="row between small"><span className="muted">Dispatched</span><span className="num">{number(o.qty_dispatched)} / {number(o.qty_ordered)}</span></div>
              <Progress value={o.qty_ordered ? (o.qty_dispatched / o.qty_ordered) * 100 : 0} />
            </div>
            <div className="small muted">Pending to produce: {number(Math.max(0, o.qty_ordered - o.qty_produced))} · pending dispatch: {number(o.qty_pending_dispatch)}</div>
          </div>
        </Card>
      </div>
      <Card title="Item-wise production" flush>
        <DataTable rows={o.items} compact columns={[
          { key: 'desc', label: 'Item', render: (i) => i.description },
          { key: 'ordered', label: 'Ordered', align: 'num', render: (i) => number(i.qty) },
          { key: 'produced', label: 'Produced', align: 'num', render: (i) => number(i.qty_produced) },
          { key: 'pending', label: 'Pending', align: 'num', render: (i) => number(Math.max(0, i.qty - i.qty_produced)) },
          { key: 'progress', label: 'Progress', render: (i) => <Progress value={i.qty ? (i.qty_produced / i.qty) * 100 : 0} /> },
          { key: 'lead', label: 'Lead time', render: (i) => (i.lead_time_days ? `${i.lead_time_days} days` : '—') },
        ]} />
      </Card>
      <Card title="Production updates" sub="Updates marked visible also appear on the customer tracking page" flush>
        {o.updates.length ? o.updates.map((u) => (
          <div key={u.id} className="action-row">
            <Icon name="production" size={15} />
            <span className="grow small">{u.note}{u.stage && <span className="muted"> · {labelOf(ORDER_STAGES, u.stage)}</span>}</span>
            {!u.visible_to_customer && <Badge size="sm">Internal</Badge>}
            <span className="tiny muted nowrap">{dateTime(u.created_at)} · {u.user_name || 'System'}</span>
          </div>
        )) : <EmptyState title="No updates yet" />}
      </Card>
    </div>
  );
}

function EditOrderModal({ open, onClose, order, onSaved }) {
  const toast = useToast();
  const meta = useMeta();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  useEffect(() => {
    if (!open) return;
    setForm({
      customer_po_number: order.customer_po_number, po_date: order.po_date, priority: order.priority, factory_id: order.factory_id,
      expected_delivery_date: order.expected_delivery_date, revised_delivery_date: order.revised_delivery_date || '', delay_reason: order.delay_reason || '',
      advance_pct: order.advance_pct, payment_terms: order.payment_terms, shipping_address: order.shipping_address, internal_notes: order.internal_notes || '',
      status: order.status, commercial_owner_id: order.commercial_owner_id, production_owner_id: order.production_owner_id,
      dispatch_owner_id: order.dispatch_owner_id, accounts_owner_id: order.accounts_owner_id,
    });
  }, [open, order]);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/orders/${order.id}`, form);
      toast.success('Order updated');
      onSaved();
      onClose();
      setForm({});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={() => { onClose(); setForm({}); }} size="lg" title={`Edit ${order.number}`}
      footer={<><Button onClick={() => { onClose(); setForm({}); }}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Customer PO number"><Input value={form.customer_po_number} onChange={set('customer_po_number')} /></Field>
        <Field label="PO date"><Input type="date" value={form.po_date} onChange={set('po_date')} /></Field>
        <Field label="Expected delivery date"><Input type="date" value={form.expected_delivery_date} onChange={set('expected_delivery_date')} /></Field>
        <Field label="Revised delivery date" hint="Needs a delay reason"><Input type="date" value={form.revised_delivery_date} onChange={set('revised_delivery_date')} /></Field>
        <Field label="Delay reason" className="full"><Input value={form.delay_reason} onChange={set('delay_reason')} /></Field>
        <Field label="Priority"><Select value={form.priority} onChange={set('priority')} options={PRIORITIES} /></Field>
        <Field label="Factory / unit"><Select value={form.factory_id} onChange={set('factory_id')} options={meta.factories.map((f) => ({ value: f.id, label: f.name }))} /></Field>
        <Field label="Advance (%)"><Input type="number" min="0" max="100" value={form.advance_pct} onChange={set('advance_pct')} /></Field>
        <Field label="Order status"><Select value={form.status} onChange={set('status')} options={[{ value: 'active', label: 'Active' }, { value: 'on_hold', label: 'On hold' }, { value: 'cancelled', label: 'Cancelled' }]} /></Field>
        <Field label="Payment terms" className="full"><Input value={form.payment_terms} onChange={set('payment_terms')} /></Field>
        <Field label="Shipping address" className="full"><Textarea rows={2} value={form.shipping_address} onChange={set('shipping_address')} /></Field>
        <div className="form-section">Responsible people</div>
        <Field label="Commercial"><UserSelect roles={['commercial', 'sales_head', 'management']} value={form.commercial_owner_id} onChange={set('commercial_owner_id')} /></Field>
        <Field label="Production"><UserSelect roles={['production']} value={form.production_owner_id} onChange={set('production_owner_id')} /></Field>
        <Field label="Dispatch"><UserSelect roles={['dispatch']} value={form.dispatch_owner_id} onChange={set('dispatch_owner_id')} /></Field>
        <Field label="Accounts"><UserSelect roles={['accounts']} value={form.accounts_owner_id} onChange={set('accounts_owner_id')} /></Field>
        <Field label="Internal notes" className="full"><Textarea rows={2} value={form.internal_notes} onChange={set('internal_notes')} /></Field>
      </div>
    </Modal>
  );
}

export function ProductionModal({ open, onClose, order, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({
      planned_start: order.planned_start || '', planned_completion: order.planned_completion || '', actual_start: order.actual_start || '',
      actual_completion: order.actual_completion || '', revised_completion: order.revised_completion || '', material_status: order.material_status,
      material_constraint: order.material_constraint || '', qc_status: order.qc_status, qc_remarks: order.qc_remarks || '', delay_reason: order.delay_reason || '',
      items: order.items.map((i) => ({ id: i.id, qty_produced: i.qty_produced, qty: i.qty, description: i.description })), update_note: '', visible_to_customer: true,
    });
  }, [open, order]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const close = () => { onClose(); setForm({}); };
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/orders/${order.id}/production`, form);
      toast.success('Production updated');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={close} size="lg" title="Update production" subtitle={`${order.number} · ${order.customer_name}`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save update</Button></>}>
      <div className="form-grid">
        <Field label="Planned start"><Input type="date" value={form.planned_start} onChange={set('planned_start')} /></Field>
        <Field label="Planned completion"><Input type="date" value={form.planned_completion} onChange={set('planned_completion')} /></Field>
        <Field label="Actual start"><Input type="date" value={form.actual_start} onChange={set('actual_start')} /></Field>
        <Field label="Actual completion"><Input type="date" value={form.actual_completion} onChange={set('actual_completion')} /></Field>
        <Field label="Revised completion" hint="Needs a delay reason"><Input type="date" value={form.revised_completion} onChange={set('revised_completion')} /></Field>
        <Field label="Delay reason"><Input value={form.delay_reason} onChange={set('delay_reason')} placeholder="e.g. Raw material delay" /></Field>
        <Field label="Raw material status"><Select value={form.material_status} onChange={set('material_status')} options={MATERIAL_STATUSES} /></Field>
        <Field label="Material constraint"><Input value={form.material_constraint} onChange={set('material_constraint')} placeholder="What is short?" /></Field>
        {can('quality.edit') && <Field label="Quality check status"><Select value={form.qc_status} onChange={set('qc_status')} options={QC_STATUSES} /></Field>}
        {can('quality.edit') && <Field label="QC remarks"><Input value={form.qc_remarks} onChange={set('qc_remarks')} /></Field>}
        <div className="form-section">Quantity produced</div>
        {(form.items || []).map((i, n) => (
          <Field key={i.id} label={`${i.description} (of ${number(i.qty)})`}>
            <Input type="number" min="0" max={i.qty} value={i.qty_produced} onChange={(e) => setForm((f) => ({ ...f, items: f.items.map((x, xi) => (xi === n ? { ...x, qty_produced: e.target.value } : x)) }))} />
          </Field>
        ))}
        <div className="form-section">Update note</div>
        <Field label="Note for the record" className="full"><Textarea rows={2} value={form.update_note} onChange={set('update_note')} placeholder="e.g. Panel wiring complete, testing tomorrow" /></Field>
        <Checkbox label="Visible on the customer tracking page" checked={form.visible_to_customer} onChange={(v) => setForm((f) => ({ ...f, visible_to_customer: v }))} />
      </div>
    </Modal>
  );
}

export function DispatchModal({ open, onClose, order, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({
      dispatch_date: todayStr(), expected_delivery_date: addDaysStr(todayStr(), 4), create_invoice: true, status: 'dispatched',
      items: order.items.map((i) => ({ order_item_id: i.id, description: i.description, unit: i.unit, pending: i.qty - i.qty_dispatched, qty: i.qty - i.qty_dispatched })),
    });
  }, [open, order]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const close = () => { onClose(); setForm({}); };
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/orders/${order.id}/dispatches`, { ...form, items: form.items.filter((i) => Number(i.qty) > 0).map((i) => ({ order_item_id: i.order_item_id, qty: i.qty })) });
      toast.success('Dispatch recorded — sales and accounts notified');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const partial = (form.items || []).some((i) => Number(i.qty) < i.pending);
  return (
    <Modal open={open} onClose={close} size="lg" title="New dispatch" subtitle={`${order.number} · ${order.customer_name}`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} icon="truck">Record dispatch</Button></>}>
      <div className="stack">
        <table className="table compact">
          <thead><tr><th>Item</th><th className="num">Pending</th><th className="num" style={{ width: 130 }}>Dispatch now</th></tr></thead>
          <tbody>
            {(form.items || []).map((i, n) => (
              <tr key={i.order_item_id}>
                <td>{i.description}</td>
                <td className="num">{number(i.pending)} {i.unit}</td>
                <td><Input type="number" min="0" max={i.pending} className="num" value={i.qty} onChange={(e) => setForm((f) => ({ ...f, items: f.items.map((x, xi) => (xi === n ? { ...x, qty: e.target.value } : x)) }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {partial && <div className="info-box small">This will be recorded as a partial shipment; the balance can be dispatched later.</div>}
        <div className="form-grid">
          <Field label="Dispatch date" required><Input type="date" value={form.dispatch_date} onChange={set('dispatch_date')} /></Field>
          <Field label="Expected delivery"><Input type="date" value={form.expected_delivery_date} onChange={set('expected_delivery_date')} /></Field>
          <Field label="Transporter"><Input value={form.transporter} onChange={set('transporter')} placeholder="e.g. VRL Logistics" /></Field>
          <Field label="Vehicle number"><Input value={form.vehicle_number} onChange={set('vehicle_number')} /></Field>
          <Field label="LR / AWB number"><Input value={form.lr_number} onChange={set('lr_number')} /></Field>
          <Field label="E-way bill number"><Input value={form.eway_bill} onChange={set('eway_bill')} /></Field>
          <Field label="Number of boxes"><Input type="number" min="0" value={form.boxes} onChange={set('boxes')} /></Field>
          <Field label="Weight (kg)"><Input type="number" min="0" value={form.weight_kg} onChange={set('weight_kg')} /></Field>
          <Field label="Tracking URL" className="full"><Input value={form.tracking_url} onChange={set('tracking_url')} placeholder="Transporter tracking link" /></Field>
          <Field label="Invoice number" hint="Leave blank to use the CRM invoice number"><Input value={form.invoice_number} onChange={set('invoice_number')} /></Field>
          <Field label="Remarks"><Input value={form.remarks} onChange={set('remarks')} /></Field>
          <Checkbox label="Raise a tax invoice in the CRM for this shipment" checked={form.create_invoice} onChange={(v) => setForm((f) => ({ ...f, create_invoice: v }))} />
        </div>
      </div>
    </Modal>
  );
}

export function DeliverModal({ open, onClose, dispatch, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [pod, setPod] = useState([]);
  useEffect(() => {
    if (open) setForm({ status: 'delivered', delivered_date: todayStr(), received_by: '', received_confirmed: true });
  }, [open]);
  const close = () => { onClose(); setForm({}); setPod([]); };
  const save = async () => {
    try {
      await api.put(`/dispatches/${dispatch.id}`, { ...form, pod_attachment_id: pod[0]?.id });
      toast.success('Delivery recorded');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    }
  };
  if (!dispatch) return null;
  return (
    <Modal open={open} onClose={close} title={`Mark ${dispatch.number} delivered`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Status"><Select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} options={DISPATCH_STATUSES} /></Field>
        <Field label="Delivered on"><Input type="date" value={form.delivered_date} onChange={(e) => setForm((f) => ({ ...f, delivered_date: e.target.value }))} /></Field>
        <Field label="Received by" className="full"><Input value={form.received_by} onChange={(e) => setForm((f) => ({ ...f, received_by: e.target.value }))} placeholder="Name of person at site" /></Field>
        <Field label="Proof of delivery" className="full" hint="Signed LR, photo or receipt"><PendingAttachments value={pod} onChange={setPod} voice={false} kind="pod" /></Field>
        <Checkbox label="Material receipt confirmed by customer" checked={form.received_confirmed} onChange={(v) => setForm((f) => ({ ...f, received_confirmed: v }))} />
      </div>
    </Modal>
  );
}

function PaymentModal({ open, onClose, order, invoice, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const openInvoices = (order.invoices || []).filter((i) => i.balance > 1);
  useEffect(() => {
    if (!open) return;
    const first = openInvoices[0];
    setForm({
      payment_date: todayStr(), mode: 'neft', invoice_id: invoice?.id || (first?.id ?? ''),
      amount: invoice?.balance || first?.balance || Math.max(0, (order.advance_required || 0) - (order.advance_received || 0)) || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const close = () => { onClose(); setForm({}); };
  const selected = openInvoices.find((i) => String(i.id) === String(form.invoice_id));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/payments', { ...form, order_id: order.id, invoice_id: form.invoice_id || undefined });
      toast.success('Payment recorded');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={close} title="Record payment" subtitle={`${order.number} · ${order.customer_name}`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save payment</Button></>}>
      <div className="form-grid">
        <Field label="Against" className="full" hint={form.invoice_id ? undefined : 'Recorded as an advance against the order'}>
          <Select value={form.invoice_id} onChange={(e) => { const inv = openInvoices.find((i) => String(i.id) === e.target.value); setForm((f) => ({ ...f, invoice_id: e.target.value, amount: inv ? inv.balance : f.amount })); }}
            placeholder="Advance against order" options={openInvoices.map((i) => ({ value: i.id, label: `${i.number} — balance ${inr(i.balance)}` }))} />
        </Field>
        <Field label="Amount received (₹)" required hint={selected ? `Invoice balance ${inr(selected.balance)}` : order.advance_required ? `Advance pending ${inr(Math.max(0, order.advance_required - order.advance_received))}` : undefined}>
          <Input type="number" min="0" value={form.amount} onChange={set('amount')} />
        </Field>
        <Field label="Payment date"><Input type="date" value={form.payment_date} onChange={set('payment_date')} /></Field>
        <Field label="Mode"><Select value={form.mode} onChange={set('mode')} options={PAYMENT_MODES} /></Field>
        <Field label="Reference / UTR"><Input value={form.reference} onChange={set('reference')} /></Field>
        {can('finance.full') && <>
          <Field label="TDS deducted (₹)"><Input type="number" min="0" value={form.tds_amount} onChange={set('tds_amount')} /></Field>
          <Field label="Other deduction (₹)"><Input type="number" min="0" value={form.other_deduction} onChange={set('other_deduction')} /></Field>
          <Field label="Deduction note" className="full"><Input value={form.deduction_note} onChange={set('deduction_note')} /></Field>
        </>}
      </div>
    </Modal>
  );
}

function InvoiceModal({ open, onClose, order, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const remaining = Math.max(0, (order.taxable_total || 0) - (order.invoices || []).reduce((s, i) => s + i.taxable, 0));
  useEffect(() => {
    if (open) setForm({ invoice_date: todayStr(), taxable: remaining || '', tax: Math.round(remaining * 0.18) || '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const close = () => { onClose(); setForm({}); };
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/invoices', { ...form, order_id: order.id });
      toast.success('Invoice raised');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={close} title="Raise invoice" subtitle={order.number}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Raise invoice</Button></>}>
      <div className="form-grid">
        <Field label="Invoice number" hint="Blank = auto number"><Input value={form.number} onChange={set('number')} /></Field>
        <Field label="Invoice date"><Input type="date" value={form.invoice_date} onChange={set('invoice_date')} /></Field>
        <Field label="Taxable value (₹)" required hint={`Not yet invoiced: ${inr(remaining)}`}><Input type="number" min="0" value={form.taxable} onChange={(e) => setForm((f) => ({ ...f, taxable: e.target.value, tax: Math.round(Number(e.target.value) * 0.18) }))} /></Field>
        <Field label="GST (₹)"><Input type="number" min="0" value={form.tax} onChange={set('tax')} /></Field>
        <Field label="Due date" hint={`Default: invoice date + ${order.payment_terms_days || 30} days`}><Input type="date" value={form.due_date} onChange={set('due_date')} /></Field>
        <Field label="Notes"><Input value={form.notes} onChange={set('notes')} /></Field>
        <div className="info-box small full">Unadjusted advance payments are applied to this invoice automatically.</div>
      </div>
    </Modal>
  );
}
