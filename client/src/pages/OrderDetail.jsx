// One order: what was ordered, how each item is progressing, what has been paid and what has been dispatched.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, qty } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Field, Input, Modal, Notice, PageHeader, Popover, SaveStatus, Spinner, Facts, useToast, Textarea,
} from '../components/ui.jsx';
import {
  LineStateBadge, PhaseLabel, OutcomeBadges, JourneyStepper, Attachments, DueBadge, Money, DateField, ProductSelect, useOptionLabel, UserSelect, useMeta, JourneyCard, PaymentBadge, DispatchBadge, transportText,
} from '../components/domain.jsx';
import {
  ProductionUpdateForm, CommunicationForm, DispatchForm, CancelQtyForm, FollowupForm, DeliveredForm, TransportForm, ReasonForm, PaymentForm,
} from '../components/forms.jsx';
import { summariseChanges } from './orderText.js';

export default function OrderDetail() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useApi(`/orders/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { order: o, summary: s, lines, finance } = data;
  const open = (type, extra) => setModal({ type, ...extra });
  const close = () => setModal(null);
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const act = async (fn, msg) => {
    try {
      await fn();
      done(msg);
    } catch (err) {
      toast.error(err.message);
    }
  };
  const confirmed = o.status === 'confirmed';
  const live = confirmed && s.active;
  const toTell = lines.filter((l) => l.comm?.state === 'pending').length;
  const openTasks = data.tasks.filter((t) => t.status === 'open');
  const showMenu = confirmed && (can('orders.edit') || can('orders.amend'));

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Orders', to: '/orders' }, { label: o.code }]}
        eyebrow={<>
          {!confirmed ? <Badge>Draft</Badge> : s.active ? <PhaseLabel phase={s.phase} /> : <OutcomeBadges outcome={s.outcome} />}
          {live && (s.overdue ? <LineStateBadge state="overdue" daysLate={Math.max(...lines.map((l) => l.status.daysLate || 0))} /> : s.at_risk ? <LineStateBadge state="at_risk" /> : null)}
          <PaymentBadge payment={data.payment} size="md" />
        </>}
        title={<>{o.code} · {can('customers.view') ? <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link> : o.customer_name}</>}
        subtitle={[o.po_reference && `PO ${o.po_reference}`, !o.received_unknown && date(o.received_date, { year: true }), `Assigned to ${o.owner_name}`].filter(Boolean).join(' · ')}
        actions={<>
          {!confirmed && can('orders.edit') && <Button variant="primary" onClick={() => act(() => api.post(`/orders/${o.id}/confirm`, { version: o.version }), 'Order confirmed')}>Confirm order</Button>}
          {live && toTell > 0 && can('orders.communicate') && <Button icon="phone" onClick={() => open('comm')}>Tell the customer</Button>}
          {confirmed && finance && can('finance.edit') && <Button icon="plus" onClick={() => open('payment')}>Record payment</Button>}
          {live && can('dispatch.post') && <Button variant="cta" icon="truck" onClick={() => open('dispatch')}>Record dispatch</Button>}
          {showMenu && (
            <Popover trigger={({ toggle }) => <Button icon="more" aria-label="More actions" onClick={toggle} />}>
              {({ close: closeMenu }) => (
                <div className="menu">
                  {can('orders.edit') && <button type="button" onClick={() => { closeMenu(); open('header'); }}>Edit order details</button>}
                  {can('orders.amend') && <button type="button" onClick={() => { closeMenu(); open('add_line'); }}>Add an item</button>}
                </div>
              )}
            </Popover>
          )}
        </>}
      />
      <JourneyCard orderId={o.id} version={o.version} />
      {data.holds.filter((h) => !h.released_at).map((h) => (
        <Notice key={h.id} tone="warn" title="Payment hold" action={can('finance.holds') && <Button size="sm" onClick={() => open('release', { hold: h })}>Release</Button>}>{h.reason}</Notice>
      ))}

      <div className="split wide">
        <div className="stack">
          <div>{lines.map((l) => <LineCard key={l.id} order={o} line={l} onAction={(type) => open(type, { line: l })} />)}</div>
          <Card title="Dispatches" flush>
            {!data.dispatches.length && <div className="muted small" style={{ padding: 16 }}>Nothing dispatched yet.</div>}
            {data.dispatches.length > 0 && (
              <div className="alert-list">
                {data.dispatches.map((d) => <DispatchRow key={d.id} dispatch={d} orderCode={o.code} onAction={(type) => open(type, { dispatch: d })} />)}
              </div>
            )}
          </Card>
          <Card title="History"><History data={data} onUndo={(c) => open('undo_cancel', { cancellation: c })} /></Card>
        </div>
        <div className="stack sticky-side">
          {finance && can('values.view') && <PaymentCard order={o} finance={finance} onUndo={(r) => open('undo_payment', { receipt: r })} />}
          <Card title="Next action">
            {!openTasks.length && <div className="muted small">None.</div>}
            <div className="stack-sm">
              {openTasks.map((t) => (
                <div key={t.id} className="m-card">
                  <div className="row between"><span className="small strong">{t.purpose}</span><DueBadge task={t} /></div>
                  <div className="tiny muted">{t.owner_name}</div>
                  {t.purpose_code === 'customer_update'
                    ? can('orders.communicate') && <div><Button size="xs" variant="primary" onClick={() => open('comm')}>Tell the customer</Button></div>
                    : (t.owner_id === user.id || can('tasks.manage_any')) && <div><Button size="xs" onClick={() => open('task', { task: t })}>Update</Button></div>}
                </div>
              ))}
            </div>
          </Card>
          <Card title="Details">
            <Facts items={[
              ['Contact', o.contact_name ? `${o.contact_name}${o.contact_phone ? ` · ${o.contact_phone}` : ''}` : null],
              o.quote_revision_id ? ['Quotation', <Link to={`/quotations/${o.quotation_id || ''}`}>{o.quote_number}</Link>] : null,
              o.enquiry_id ? ['Enquiry', <Link to={`/enquiries/${o.enquiry_id}`}>{o.enquiry_code}</Link>] : null,
              ['Payment terms', o.payment_terms],
              ['Delivery address', o.delivery_address],
              ['Notes', o.notes],
            ]} />
          </Card>
          <Card title="Documents"><Attachments items={data.attachments} entityType="order" entityId={o.id} onChange={reload} /></Card>
        </div>
      </div>

      <Modal open={modal?.type === 'update'} onClose={close} title="Update progress" subtitle={modal?.line?.product}>
        {modal?.type === 'update' && <ProductionUpdateForm line={modal.line} onSaved={(r) => (r?.unchanged ? (toast.info(r.message), close()) : done('Update saved'))} />}
      </Modal>
      <Modal open={modal?.type === 'comm'} onClose={close} title="Tell the customer about the new date">
        {modal?.type === 'comm' && <CommunicationForm order={o} lines={lines} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'payment'} size="sm" onClose={close} title="Record payment">
        {modal?.type === 'payment' && <PaymentForm order={o} balanceMinor={finance?.balance_minor} onSaved={() => done('Payment saved')} />}
      </Modal>
      <Modal open={modal?.type === 'undo_payment'} size="sm" onClose={close} title="Undo this payment">
        {modal?.type === 'undo_payment' && <ReasonForm label="Why?" danger button="Undo payment" note="It stays on record as reversed." onSubmit={(reason) => api.post(`/finance/receipts/${modal.receipt.id}/reverse`, { reason }).then(() => done('Payment undone'))} />}
      </Modal>
      <Modal open={modal?.type === 'dispatch'} size="lg" onClose={close} title="Record dispatch" subtitle={o.customer_name}>
        {modal?.type === 'dispatch' && <DispatchForm customerId={o.customer_id} orderId={o.id} onSaved={() => done('Dispatch saved')} />}
      </Modal>
      <Modal open={modal?.type === 'cancel'} size="sm" onClose={close} title="Cancel quantity" subtitle={modal?.line?.product}>
        {modal?.type === 'cancel' && <CancelQtyForm line={modal.line} onSaved={() => done('Quantity cancelled')} />}
      </Modal>
      <Modal open={modal?.type === 'undo_cancel'} size="sm" onClose={close} title="Undo this cancellation">
        {modal?.type === 'undo_cancel' && <ReasonForm label="Why?" button="Undo cancellation" onSubmit={(reason) => api.post(`/cancellations/${modal.cancellation.id}/reverse`, { reason }).then(() => done('Cancellation undone'))} />}
      </Modal>
      <Modal open={modal?.type === 'amend'} size="sm" onClose={close} title="Change quantity or price" subtitle={modal?.line?.product}>
        {modal?.type === 'amend' && <AmendForm line={modal.line} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'commitment'} size="sm" onClose={close} title="Dispatch date" subtitle={modal?.line?.product}>
        {modal?.type === 'commitment' && <CommitmentForm line={modal.line} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'clarify'} size="sm" onClose={close} title="Confirm specification">
        {modal?.type === 'clarify' && <ClarifyForm line={modal.line} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'add_line'} onClose={close} title="Add an item">
        {modal?.type === 'add_line' && <AddLineForm order={o} onSaved={() => done('Item added')} />}
      </Modal>
      <Modal open={modal?.type === 'header'} onClose={close} title="Order details">
        {modal?.type === 'header' && <HeaderForm order={o} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'task'} onClose={close} title="Update" subtitle={modal?.task?.purpose}>
        {modal?.type === 'task' && <FollowupForm task={modal.task} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'delivered'} size="sm" onClose={close} title={`Delivered — ${modal?.dispatch?.code}`}>
        {modal?.type === 'delivered' && <DeliveredForm dispatch={modal.dispatch} onSaved={() => done('Marked as delivered')} />}
      </Modal>
      <Modal open={modal?.type === 'transport'} size="sm" onClose={close} title={`Transport — ${modal?.dispatch?.code}`}>
        {modal?.type === 'transport' && <TransportForm dispatch={modal.dispatch} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'reverse'} size="sm" onClose={close} title={`Reverse ${modal?.dispatch?.code}`}>
        {modal?.type === 'reverse' && <ReasonForm label="Why?" danger button="Reverse dispatch" note="The quantities go back on the order. This dispatch stays on record." onSubmit={(reason) => api.post(`/dispatches/${modal.dispatch.id}/reverse`, { reason }).then(() => done('Dispatch reversed'))} />}
      </Modal>
      <Modal open={modal?.type === 'release'} size="sm" onClose={close} title="Release payment hold">
        {modal?.type === 'release' && <ReasonForm label="What changed?" button="Release hold" onSubmit={(evidence) => api.post(`/holds/${modal.hold.id}/release`, { evidence }).then(() => done('Hold released'))} />}
      </Modal>
    </div>
  );
}

function LineCard({ order, line: l, onAction }) {
  const { can } = useAuth();
  const q = l.quantities;
  const active = l.status.active;
  const live = order.status === 'confirmed' && active;
  const committed = l.commitment_state === 'committed';
  return (
    <div className="line-card">
      <div className="line-head">
        <strong>{qty(l.confirmed_qty, l.unit)} × {l.product}</strong>
        {l.spec && <span className="small muted">{l.spec}</span>}
        {l.needs_clarification ? <Badge tone="amber" icon="alert">Specification to confirm</Badge> : null}
        <span className="grow" />
        {order.status === 'confirmed' && <LineStateBadge state={l.status.state} daysLate={l.status.daysLate} pastAgreed={l.status.pastAgreed} />}
      </div>
      <div className="stack-sm" style={{ padding: '10px 16px 14px' }}>
        <JourneyStepper phase={l.phase} workStatus={l.work_status} dispatched={!active && q.dispatched > 0} />
        <dl className="facts">
          <dt>Dispatch by</dt><dd>{committed ? <strong>{date(l.original_commitment_date, { year: true })}</strong> : <Badge tone="violet">Not agreed yet</Badge>}</dd>
          {l.agreed_commitment_date && <><dt>New date agreed</dt><dd><Badge tone="green">{date(l.agreed_commitment_date)}</Badge></dd></>}
          {live && <><dt>Expected</dt><dd>{l.forecast_dispatch_date ? date(l.forecast_dispatch_date) : '—'}</dd></>}
          {l.issue_label && <><dt>Delay</dt><dd><Badge tone="red">{l.issue_label}</Badge>{l.stage_note && <span className="small"> {l.stage_note}</span>}</dd></>}
        </dl>
        <div className="qty-strip" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <div><div className="k">Ordered</div><div className="v">{qty(q.confirmed - q.cancelled)}</div></div>
          <div><div className="k">Ready</div><div className="v">{q.ready === null ? '—' : qty(q.ready)}</div></div>
          <div><div className="k">Dispatched</div><div className="v">{qty(q.dispatched)}</div></div>
          <div><div className="k">Left</div><div className="v">{qty(q.remaining)}</div></div>
        </div>
        {can('values.view') && l.unit_price_minor !== null && <div className="tiny muted">Unit price <Money minor={l.unit_price_minor} currency={order.currency} /></div>}
        {live && (
          <div className="row wrap">
            {can('orders.update') && <Button size="sm" variant="primary" onClick={() => onAction('update')}>Update progress</Button>}
            {can('orders.edit') && !committed && <Button size="sm" onClick={() => onAction('commitment')}>Set dispatch date</Button>}
            {can('orders.authorise') && committed && <Button size="sm" variant="ghost" onClick={() => onAction('commitment')}>Correct date</Button>}
            {can('orders.edit') && l.needs_clarification ? <Button size="sm" onClick={() => onAction('clarify')}>Confirm specification</Button> : null}
            {can('orders.amend') && <Button size="sm" variant="ghost" onClick={() => onAction('amend')}>Change</Button>}
            {can('orders.cancel') && <Button size="sm" variant="ghost" onClick={() => onAction('cancel')}>Cancel quantity</Button>}
          </div>
        )}
        {order.status === 'draft' && can('orders.edit') && !committed && <div><Button size="sm" onClick={() => onAction('commitment')}>Set dispatch date</Button></div>}
      </div>
    </div>
  );
}

function DispatchRow({ dispatch: d, orderCode, onAction }) {
  const { can } = useAuth();
  const post = can('dispatch.post');
  return (
    <div className="stack-xs" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
      <div className="row between wrap">
        <strong className="small">{d.code} · {d.status === 'planned' || d.status === 'cancelled' ? `planned ${date(d.planned_date)}` : d.date_unknown ? 'date not known' : date(d.dispatch_date, { year: true })}</strong>
        <DispatchBadge dispatch={d} />
      </div>
      <div className="small">{d.lines.map((x) => `${x.order_code === orderCode ? '' : `${x.order_code} `}${qty(x.qty, x.unit)} × ${x.product}`).join(' · ')}</div>
      {transportText(d) && <div className="tiny muted">{transportText(d)}</div>}
      {d.status === 'reversed' && <div className="tiny danger-text">Reversed: {d.reversal_reason}</div>}
      {d.status === 'posted' && (
        <div className="row wrap">
          {!d.delivered_at && (can('orders.communicate') || post) && <Button size="xs" onClick={() => onAction('delivered')}>Delivered</Button>}
          {post && <Button size="xs" variant="ghost" onClick={() => onAction('transport')}>Transport details</Button>}
          {can('dispatch.reverse') && <Button size="xs" variant="danger-ghost" onClick={() => onAction('reverse')}>Reverse</Button>}
        </div>
      )}
    </div>
  );
}

/** Order total, what has come in and what is left. */
function PaymentCard({ order, finance: f, onUndo }) {
  const { can } = useAuth();
  const meta = useMeta();
  const cur = f.currency;
  const receipts = f.receipts.filter((r) => !r.reversed_at);
  const advanceDue = f.advance_required_minor ? Math.max(0, f.advance_required_minor - (f.advance_received_minor || 0)) : 0;
  return (
    <Card title="Payment" actions={meta.settings.modules?.payments && can('finance.view') && <Button size="sm" variant="ghost" to={`/payments?order_id=${order.id}`}>Register</Button>}>
      <Facts items={[
        ['Order total', f.total_minor === null ? <span className="muted">Some prices are missing</span> : <strong><Money minor={f.total_minor} currency={cur} /></strong>],
        f.advance_pct !== null && f.advance_pct !== undefined ? ['Advance', <span className={advanceDue > 0 ? 'warning-text' : ''}>{f.advance_pct}% · <Money minor={f.advance_required_minor} currency={cur} /></span>] : null,
        ['Received', <Money minor={f.received_minor} currency={cur} />],
        f.balance_minor !== null ? ['Balance', <strong><Money minor={f.balance_minor} currency={cur} /></strong>] : null,
      ]} />
      {receipts.length > 0 && (
        <div className="stack-xs mt-8">
          {receipts.map((r) => (
            <div key={r.id} className="row between small">
              <span>{date(r.effective_date)}{r.reference ? ` · ${r.reference}` : ''}</span>
              <span className="row" style={{ gap: 6 }}>
                <Money minor={r.amount_minor + r.tds_minor + r.other_deduction_minor} currency={r.currency} />
                {r.order_id === order.id && !r.invoice_id && can('finance.edit') && <Button size="xs" variant="ghost" icon="x" aria-label="Undo this payment" onClick={() => onUndo(r)} />}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Everything that has happened on the order, newest first. */
function History({ data, onUndo }) {
  const { can } = useAuth();
  const optionLabel = useOptionLabel();
  const product = (lineNo) => data.lines.find((l) => l.line_no === lineNo)?.product;
  const rows = [
    ...data.updates.filter((u) => !['dispatch', 'header'].includes(u.kind)).map((u) => ({
      key: `u${u.id}`, at: u.occurred_at, by: u.entered_by_name, product: u.product,
      text: u.kind === 'still_on_track' ? 'Still on track' : u.kind === 'historical' ? 'Imported' : summariseChanges(u.changes, optionLabel), note: u.note,
    })),
    ...data.communications.map((c) => ({ key: `c${c.id}`, at: c.occurred_at, by: c.entered_by_name, product: product(c.line_no), text: `Customer told by ${c.channel}: ${c.response}${c.agreed_date ? ` (${date(c.agreed_date)})` : ''}`, note: c.note })),
    ...data.date_history.filter((d) => d.kind === 'original_correction').map((d) => ({ key: `d${d.id}`, at: d.occurred_at || d.created_at, by: d.actor_name, product: product(d.line_no), text: `Dispatch date corrected: ${date(d.old_date)} → ${date(d.new_date)}`, note: d.reason })),
    ...data.cancellations.map((c) => ({ key: `x${c.id}`, at: c.created_at, by: c.created_by_name, product: c.product, text: `Cancelled ${qty(c.qty, c.unit)}: ${c.reason}${c.reversed_at ? ' (undone)' : ''}`, note: c.reversed_at ? c.reversal_reason : c.note, undo: !c.reversed_at && can('orders.authorise') ? c : null })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!rows.length) return <div className="muted small">Nothing yet.</div>;
  return (
    <div className="stack-sm">
      {rows.map((r) => (
        <div key={r.key} className="row between top">
          <div className="grow">
            <div className="small">{r.product && <strong>{r.product}: </strong>}{r.text}</div>
            {r.note && <div className="tiny muted">{r.note}</div>}
            <div className="tiny muted">{dateTime(r.at)}{r.by ? ` · ${r.by}` : ''}</div>
          </div>
          {r.undo && <Button size="xs" variant="ghost" onClick={() => onUndo(r.undo)}>Undo</Button>}
        </div>
      ))}
    </div>
  );
}

function AmendForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ confirmed_qty: line.confirmed_qty, spec: line.spec || '', unit_price: line.unit_price_minor === null ? '' : fromMinor(line.unit_price_minor), reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/amend`, { ...f, version: line.version }); onSaved(); }); }}>
      <Field label="Quantity" error={save.fields.confirmed_qty}><Input type="number" min={0} step="any" value={f.confirmed_qty} onChange={(e) => setF({ ...f, confirmed_qty: e.target.value })} /></Field>
      <Field label="Unit price" optional error={save.fields.unit_price}><Input inputMode="decimal" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
      <Field label="Why?" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function CommitmentForm({ line, onSaved }) {
  const save = useSave();
  const correcting = line.commitment_state === 'committed';
  const [f, setF] = useState({ original_commitment_date: correcting ? line.original_commitment_date : '', reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/commitment`, f); onSaved(); }); }}>
      {correcting && <Notice tone="warn">Only for fixing a wrong entry. If the customer agreed a new date, use “Tell the customer” instead.</Notice>}
      <DateField label="Dispatch by" required value={f.original_commitment_date} onChange={(v) => setF({ ...f, original_commitment_date: v })} error={save.fields.original_commitment_date} presets={!correcting} />
      {correcting && <Field label="Why?" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function ClarifyForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ spec: line.spec || '', product_id: line.product_id, note: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/clarify`, f); onSaved(); }); }}>
      <Field label="Product" error={save.fields.product_id}><ProductSelect value={f.product_id} onChange={(v) => setF({ ...f, product_id: v })} allowUnspecified={false} /></Field>
      <Field label="Specification" required error={save.fields.spec}><Input value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function AddLineForm({ order, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ product_id: null, description: '', confirmed_qty: '', unit_price: '', date: '', reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/orders/${order.id}/lines`, {
        product_id: f.product_id, description: f.description, confirmed_qty: f.confirmed_qty, unit_price: f.unit_price, reason: f.reason,
        ...(f.date ? { commitment_state: 'committed', original_commitment_date: f.date } : { commitment_state: 'uncommitted' }),
      });
      onSaved();
    }); }}>
      <div className="form-grid">
        <Field label="Product" error={save.fields['lines.0.product_id']}><ProductSelect value={f.product_id} onChange={(v) => setF({ ...f, product_id: v })} /></Field>
        {!f.product_id && <Field label="Description" required error={save.fields['lines.0.description']}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>}
        <Field label="Quantity" required error={save.fields['lines.0.confirmed_qty']}><Input type="number" min={0} step="any" value={f.confirmed_qty} onChange={(e) => setF({ ...f, confirmed_qty: e.target.value })} /></Field>
        <Field label="Unit price" optional error={save.fields['lines.0.unit_price']}><Input inputMode="decimal" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
        <Field label="Dispatch by" optional error={save.fields['lines.0.original_commitment_date']}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Why?" required className="full" error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer added 20 pieces by email" /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Add item</Button></div>
    </form>
  );
}

function HeaderForm({ order: o, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const commercial = can('orders.amend');
  const [f, setF] = useState({
    owner_id: o.owner_id, po_reference: o.po_reference || '', delivery_address: o.delivery_address || '',
    payment_terms: o.payment_terms || '', advance_pct: o.advance_pct ?? '', freight: o.freight_minor ? fromMinor(o.freight_minor) : '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const body = { version: o.version, owner_id: f.owner_id, po_reference: f.po_reference, delivery_address: f.delivery_address };
    if (commercial) Object.assign(body, { payment_terms: f.payment_terms, advance_pct: f.advance_pct, freight: f.freight });
    const r = await api.put(`/orders/${o.id}`, body);
    onSaved(r);
    return r;
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {save.conflict && <Notice tone="warn">Someone else changed this order. Close this and open it again.</Notice>}
      <div className="form-grid">
        <Field label="Assigned to" error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
        <Field label="PO number" error={save.fields.po_reference}><Input value={f.po_reference} onChange={(e) => set({ po_reference: e.target.value })} /></Field>
        {commercial && <Field label="Payment terms" className="full" error={save.fields.payment_terms}><Input value={f.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>}
        {commercial && <Field label="Advance %" error={save.fields.advance_pct}><Input type="number" min={0} max={100} value={f.advance_pct} onChange={(e) => set({ advance_pct: e.target.value })} /></Field>}
        {commercial && <Field label={`Freight (${o.currency})`} error={save.fields.freight}><Input inputMode="decimal" value={f.freight} onChange={(e) => set({ freight: e.target.value })} /></Field>}
        <Field label="Delivery address" className="full" error={save.fields.delivery_address}><Textarea rows={2} value={f.delivery_address} onChange={(e) => set({ delivery_address: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}
