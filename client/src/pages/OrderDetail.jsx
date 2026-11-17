import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PHASES, PRIORITIES, labelOf, toneOf } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, qty, relDay, timeAgo, moneyByCurrency, todayLocal } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Field, Input, Modal, Notice, PageHeader, Popover, SaveStatus, Select, Spinner, Tabs, Facts, Checkbox, useToast, useConfirm, Textarea,
} from '../components/ui.jsx';
import {
  LineStateBadge, CommBadge, PhaseLabel, OutcomeBadges, JourneyStepper, Attachments, DueBadge, PinButton, Money, DateField, ProductSelect, useOptionLabel, FilePick, UserSelect, useMeta,
} from '../components/domain.jsx';
import { ProductionUpdateForm, CommunicationForm, DispatchForm, CancelQtyForm, FollowupForm } from '../components/forms.jsx';
import { summariseChanges } from './orderText.js';

export default function OrderDetail() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const optionLabel = useOptionLabel();
  const { data, error, reload } = useApi(`/orders/${id}`);
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('updates');
  const [contacts, setContacts] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { order: o, summary: s, lines } = data;
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const loadContacts = async () => {
    if (contacts || !can('customers.view')) return;
    const p = await api.get(`/customers/${o.customer_id}`).catch(() => null);
    setContacts(p?.contacts?.filter((c) => c.active) || []);
  };
  const first = lines[0];
  const pendingComm = lines.filter((l) => l.comm?.state === 'pending').length;
  const act = async (fn, msg) => {
    try {
      await fn();
      done(msg);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Active orders', to: '/orders' }, { label: o.code }]}
        eyebrow={<>{o.status === 'draft' ? <Badge>Draft — not confirmed</Badge> : s.active ? <PhaseLabel phase={s.phase} /> : <OutcomeBadges outcome={s.outcome} />}
          {s.active && (s.overdue ? <LineStateBadge state="overdue" daysLate={Math.max(...lines.map((l) => l.status.daysLate || 0))} /> : s.at_risk ? <LineStateBadge state="at_risk" /> : null)}
          {s.active && <OutcomeBadges outcome={s.outcome} size="sm" />}
          {pendingComm > 0 && <CommBadge state="pending" />}
          {o.priority && o.priority !== 'normal' && <Badge tone={toneOf(PRIORITIES, o.priority)} icon="flag">{labelOf(PRIORITIES, o.priority)} priority</Badge>}</>}
        title={<>{o.code} · {can('customers.view') ? <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link> : o.customer_name}{first ? ` · ${qty(first.confirmed_qty, first.unit)} × ${first.product}${lines.length > 1 ? ` +${lines.length - 1}` : ''}` : ''}</>}
        subtitle={<>PO {o.po_reference || '—'} · received {o.received_unknown ? 'date unknown' : date(o.received_date, { year: true })} · owner {o.owner_name}{o.coordinator_name ? ` · coordinator ${o.coordinator_name}` : ''}</>}
        actions={<>
          <PinButton type="order" id={o.id} pinned={o.pinned} onChange={reload} />
          {o.status === 'confirmed' && o.tracking_token && can('orders.communicate') && <Button icon="link" onClick={async () => {
            const url = `${window.location.origin}/portal/order/${o.tracking_token}`;
            try { await navigator.clipboard.writeText(url); toast.success('Tracking link copied — the customer sees progress, dates and shipments only'); } catch { window.prompt('Copy the tracking link', url); }
          }}>Copy tracking link</Button>}
          {o.status === 'draft' && can('orders.edit') && <Button variant="primary" onClick={() => act(() => api.post(`/orders/${o.id}/confirm`, { version: o.version }), 'Order confirmed')}>Confirm order</Button>}
          {o.status === 'confirmed' && s.active && can('orders.communicate') && <Button icon="phone" onClick={() => { loadContacts(); setModal({ type: 'comm' }); }}>Record customer update</Button>}
          {o.status === 'confirmed' && s.active && can('dispatch.post') && <Button variant="cta" icon="truck" onClick={() => setModal({ type: 'dispatch' })}>Record dispatch</Button>}
          {o.status === 'confirmed' && (can('orders.amend') || can('finance.holds') || can('orders.edit') || can('orders.update')) && (
            <Popover trigger={({ toggle }) => <Button icon="more" aria-label="More actions" onClick={toggle} />}>
              {({ close }) => (
                <div className="menu">
                  {can('orders.amend') && <button type="button" onClick={() => { close(); setModal({ type: 'add_line' }); }}>Add a line (new requirement)</button>}
                  {(can('orders.edit') || can('orders.update')) && <button type="button" onClick={() => { close(); setModal({ type: 'header' }); }}>Edit order details</button>}
                  {can('finance.holds') && !data.holds.some((h) => !h.released_at) && <button type="button" onClick={() => { close(); setModal({ type: 'hold' }); }}>Place payment hold</button>}
                </div>
              )}
            </Popover>
          )}
        </>}
      />
      {data.holds.filter((h) => !h.released_at).map((h) => (
        <Notice key={h.id} tone="warn" title="Payment hold" action={can('finance.holds') && <Button size="sm" onClick={() => setModal({ type: 'release', hold: h })}>Release</Button>}>{h.reason} · authorised by {h.authorised_by_name} on {date(h.held_at)}</Notice>
      ))}
      {data.alerts.length > 0 && (
        <Card title="Open alerts" sub="from the reminder evaluator">
          <div className="stack-xs">{data.alerts.map((a) => <div key={a.id} className="row small"><Badge size="sm" tone={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'slate'}>{a.severity}</Badge>{a.title}</div>)}</div>
        </Card>
      )}

      <div className="split wide">
        <div className="stack">
          {lines.map((l) => <LineCard key={l.id} order={o} line={l} onSaved={(res) => (res?.unchanged ? toast.info(res.message) : done('Update saved'))} onAction={(type) => setModal({ type, line: l })} />)}
        </div>
        <div className="stack sticky-side">
          <Card title="Order">
            <Facts items={[
              ['Customer', can('customers.view') ? <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link> : o.customer_name],
              ['Contact', o.contact_name ? `${o.contact_name}${o.contact_phone ? ` · ${o.contact_phone}` : ''}` : null],
              ['Source', o.quote_revision_id ? <Link to={`/enquiries/${o.enquiry_id}`}>{o.quote_number} rev {o.quote_revision_no} ({o.enquiry_code})</Link> : o.source_label],
              ['Confirmed', o.confirmed_at ? `${dateTime(o.confirmed_at)} by ${o.confirmed_by_name}` : 'Not yet'],
              ['Confirmation', [o.confirmation_type, o.confirmation_note].filter(Boolean).join(' — ')],
              ['Totals', `${qty(s.totals.confirmed)} ordered · ${qty(s.totals.dispatched)} dispatched · ${qty(s.totals.cancelled)} cancelled · ${qty(s.totals.remaining)} remaining`],
              ['Earliest promise', s.earliest_due ? `${date(s.earliest_due)} (${relDay(s.earliest_due)})` : null],
              can('values.view') && ['Order value', <>{moneyByCurrency(s.value_by_currency)}{s.lines_without_price ? <span className="muted small"> · {s.lines_without_price} line(s) without price</span> : ''}</>],
              ['Payment terms', o.payment_terms],
              ['Priority', labelOf(PRIORITIES, o.priority || 'normal')],
              ['Factory', o.factory_name],
              ['Production owner', o.production_owner_name],
              ['Dispatch owner', o.dispatch_owner_name],
              ['Accounts owner', o.accounts_owner_name],
              ['Delivery', [o.delivery_address, o.shipping_mode].filter(Boolean).join(' · ')],
              ['Billing address', o.billing_address],
              ['Accounting ref', [o.external_order_ref, o.external_invoice_ref].filter(Boolean).join(' / ')],
              ['Notes', o.notes],
            ]} />
          </Card>
          <Card title="Next actions">
            {!data.tasks.filter((t) => t.status === 'open').length && <div className="muted small">No open actions.</div>}
            <div className="stack-sm">
              {data.tasks.filter((t) => t.status === 'open').map((t) => (
                <div key={t.id} className="m-card">
                  <div className="row between"><span className="small strong">{t.purpose}</span><DueBadge task={t} /></div>
                  <div className="tiny muted">{t.owner_name}{t.owner_department ? ` (${t.owner_department})` : ''} · {t.kind === 'internal' ? 'internal action' : 'customer contact'}{t.escalated_at ? ' · escalated' : ''}</div>
                  {(t.owner_id === user.id || can('tasks.manage_any')) && t.purpose_code !== 'customer_update' && <div><Button size="xs" onClick={() => setModal({ type: 'task', task: t })}>Record outcome</Button></div>}
                  {t.purpose_code === 'customer_update' && can('orders.communicate') && <div><Button size="xs" variant="primary" onClick={() => { loadContacts(); setModal({ type: 'comm' }); }}>Record customer update</Button></div>}
                </div>
              ))}
            </div>
          </Card>
          {data.finance && can('values.view') && <FinanceCard order={o} finance={data.finance} />}
          {(data.objects?.length > 0 || can('objects.edit')) && (
            <Card title="Equipment & QR" sub={data.objects?.length ? `${data.objects.length}` : undefined} actions={can('objects.edit') && <Button size="sm" variant="ghost" icon="plus" to="/objects">Objects</Button>}>
              {!data.objects?.length && <div className="muted small">No QR objects linked. Link an object (machine, panel, meter) to this order from its object page.</div>}
              <div className="stack-xs">{data.objects?.map((x) => <Link key={x.id} to={`/objects/${x.id}`} className="small"><span className="mono">{x.public_id}</span> · {x.name}{x.serial_number ? ` · SN ${x.serial_number}` : ''}</Link>)}</div>
            </Card>
          )}
          {data.complaints?.length > 0 && (
            <Card title="Complaints on this order">
              <div className="stack-xs">{data.complaints.map((k) => <Link key={k.id} to={`/complaints/${k.id}`} className="small"><strong>{k.code}</strong> · {k.category} · {k.status.replace(/_/g, ' ')} · {date(k.received_date)}</Link>)}</div>
            </Card>
          )}
          <Card title="Documents"><Attachments items={data.attachments} entityType="order" entityId={o.id} onChange={reload} /></Card>
        </div>
      </div>

      <Card flush>
        <div style={{ padding: '0 16px' }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            { key: 'updates', label: 'Updates', count: data.updates.length },
            { key: 'dates', label: 'Date history', count: data.date_history.length },
            { key: 'comms', label: 'Customer communication', count: data.communications.length },
            { key: 'dispatches', label: 'Dispatches', count: data.dispatches.length },
            { key: 'cancellations', label: 'Cancellations', count: data.cancellations.length },
          ]} />
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          {tab === 'updates' && (
            <table className="table compact">
              <thead><tr><th>As of</th><th>Line</th><th>Change</th><th>Reported by</th><th>Entered</th></tr></thead>
              <tbody>{data.updates.map((u) => (
                <tr key={u.id}>
                  <td className="nowrap">{dateTime(u.occurred_at)}{u.basis === 'entry_time' && <div className="sub">entry-time based</div>}</td>
                  <td>{u.line_no ? `${u.line_no} · ${u.product}` : '—'}</td>
                  <td>{u.kind === 'still_on_track' ? 'No change — still on track' : u.kind === 'historical' ? <Badge size="sm">Historical entry</Badge> : summariseChanges(u.changes, optionLabel)}{u.kind === 'correction' && <Badge size="sm" tone="amber"> correction</Badge>}{u.note && <div className="sub">{u.note}</div>}</td>
                  <td className="small">{u.reported_by_name || '—'}</td>
                  <td className="small">{u.entered_by_name} · {dateTime(u.entered_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {tab === 'dates' && (
            <table className="table compact">
              <thead><tr><th>When</th><th>Line</th><th>Change</th><th>Customer informed</th><th>By</th></tr></thead>
              <tbody>{data.date_history.map((d) => (
                <tr key={d.id}>
                  <td className="nowrap">{dateTime(d.occurred_at || d.created_at)}</td>
                  <td>{d.line_no}</td>
                  <td>{{ original: 'Original commitment', original_correction: 'Original commitment corrected', agreed: 'Customer-agreed revised date', forecast_ready: 'Expected ready date', forecast_dispatch: 'Dispatch forecast', missed: 'Commitment date passed' }[d.kind]}: {d.old_date ? `${date(d.old_date)} → ` : ''}{d.estimate_unknown ? 'estimate unknown' : date(d.new_date)}{d.reason && <div className="sub">{d.reason}</div>}</td>
                  <td>{d.comm_required ? (d.informed_at ? <Badge size="sm" tone="green" icon="check">Informed {date(d.informed_at)}{d.informed_by_name ? ` by ${d.informed_by_name}` : ''}</Badge> : <Badge size="sm" tone="red">Not informed</Badge>) : d.kind === 'agreed' ? <Badge size="sm" tone="green">Agreed</Badge> : <span className="muted small">Not needed</span>}</td>
                  <td className="small">{d.actor_name || 'System'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {tab === 'comms' && (data.communications.length ? (
            <table className="table compact">
              <thead><tr><th>When</th><th>Line</th><th>How / with</th><th>Customer response</th><th>Agreed date</th><th>Entered by</th></tr></thead>
              <tbody>{data.communications.map((c) => <tr key={c.id}><td>{dateTime(c.occurred_at)}</td><td>{c.line_no}</td><td>{c.channel}{c.contact_name ? ` · ${c.contact_name}` : ''}</td><td>{c.response}{c.note && <div className="sub">{c.note}</div>}</td><td>{c.agreed_date ? date(c.agreed_date) : '—'}</td><td>{c.entered_by_name}</td></tr>)}</tbody>
            </table>
          ) : <div className="muted small" style={{ padding: 12 }}>No customer communication recorded on this order.</div>)}
          {tab === 'dispatches' && (data.dispatches.length ? (
            <div className="stack-sm">{data.dispatches.map((d) => (
              <div key={d.id} className="m-card">
                <div className="row between wrap">
                  <strong>{d.code} · {d.status === 'planned' || d.status === 'cancelled' ? `planned for ${date(d.planned_date, { year: true })}` : d.date_unknown ? 'date unknown (historical)' : date(d.dispatch_date, { year: true })}</strong>
                  <span className="row">{d.status === 'reversed' ? <Badge tone="red">Reversed</Badge> : d.status === 'planned' ? <Badge tone="slate" icon="calendar">Planned — not dispatched</Badge> : d.status === 'cancelled' ? <Badge>Plan cancelled</Badge> : <Badge tone="green">Posted</Badge>}{d.status === 'posted' && (d.notify_state === 'pending' ? <Badge tone="amber">Customer notification pending</Badge> : d.notify_state === 'recorded' ? <Badge tone="green">Customer notified</Badge> : null)}</span>
                </div>
                <div className="small">{d.lines.map((x) => `${x.order_code === o.code ? '' : `${x.order_code} `}line ${x.line_no}: ${qty(x.qty, x.unit)} × ${x.product}`).join(' · ')}</div>
                <div className="tiny muted">{[d.carrier, d.tracking_no, d.vehicle_number && `vehicle ${d.vehicle_number}`, d.eway_bill && `e-way ${d.eway_bill}`, d.reference, d.invoice_ref && `invoice ${d.invoice_ref}`, d.expected_arrival && `ETA ${date(d.expected_arrival)}`, d.delivered_at && `delivered ${date(d.delivered_at)}${d.received_by_name ? ` (received by ${d.received_by_name})` : ''}`].filter(Boolean).join(' · ')} · entered by {d.created_by_name}{d.override_reason ? ` · not-ready override: ${d.override_reason}` : ''}</div>
                {d.status === 'reversed' && <div className="small danger-text">Reversed {dateTime(d.reversed_at)} by {d.reversed_by_name}: {d.reversal_reason}</div>}
                <div className="row wrap">
                  {d.status === 'posted' && d.notify_state === 'pending' && can('orders.communicate') && <Button size="xs" onClick={() => act(() => api.post(`/dispatches/${d.id}/notify`, { channel: 'email' }), 'Customer notification recorded')}>Record customer notified</Button>}
                  {d.status === 'posted' && !d.delivered_at && can('orders.communicate') && <Button size="xs" onClick={() => setModal({ type: 'delivered', dispatch: d })}>Record delivery</Button>}
                  {d.status === 'posted' && can('dispatch.reverse') && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'reverse', dispatch: d })}>Reverse (correction)</Button>}
                  {d.status === 'planned' && can('dispatch.post') && <Button size="xs" variant="primary" to={`/dispatches?view=planned&q=${d.code}`}>Post when it leaves</Button>}
                  {d.status === 'planned' && can('dispatch.post') && <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'cancel_plan', dispatch: d })}>Cancel plan</Button>}
                  {d.tracking_url && <a className="btn xs" href={d.tracking_url} target="_blank" rel="noreferrer">Track</a>}
                </div>
              </div>
            ))}</div>
          ) : <div className="muted small" style={{ padding: 12 }}>Nothing dispatched yet.</div>)}
          {tab === 'cancellations' && (data.cancellations.length ? (
            <table className="table compact">
              <thead><tr><th>Date</th><th>Line</th><th className="num">Quantity</th><th>Reason</th><th>Requested by</th><th /></tr></thead>
              <tbody>{data.cancellations.map((c) => (
                <tr key={c.id}>
                  <td>{date(c.effective_date)}</td><td>{c.line_no} · {c.product}</td><td className="num">{qty(c.qty, c.unit)}</td>
                  <td>{c.reason}{c.note && <div className="sub">{c.note}</div>}{c.reversed_at && <div className="sub danger-text">Reversed: {c.reversal_reason}</div>}</td>
                  <td>{c.requested_source}{c.requested_by_name ? ` · ${c.requested_by_name}` : ''}</td>
                  <td>{!c.reversed_at && can('orders.authorise') && <Button size="xs" variant="ghost" onClick={async () => {
                    const reason = window.prompt('Reason for undoing this cancellation (authorised correction):');
                    if (reason) act(() => api.post(`/cancellations/${c.id}/reverse`, { reason }), 'Cancellation reversed');
                  }}>Undo</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div className="muted small" style={{ padding: 12 }}>No cancellations.</div>)}
        </div>
      </Card>

      <Modal open={modal?.type === 'comm'} onClose={() => setModal(null)} title={`Customer update — ${o.code}`}>
        {modal?.type === 'comm' && <CommunicationForm order={o} lines={lines} contacts={contacts || []} onSaved={() => done('Customer update recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'dispatch'} size="lg" onClose={() => setModal(null)} title="Record dispatch" subtitle={o.customer_name}>
        {modal?.type === 'dispatch' && <DispatchForm customerId={o.customer_id} orderId={o.id} onSaved={() => done('Dispatch posted')} />}
      </Modal>
      <Modal open={modal?.type === 'cancel'} size="sm" onClose={() => setModal(null)} title={`Cancel quantity — line ${modal?.line?.line_no}`}>
        {modal?.type === 'cancel' && <CancelQtyForm line={modal.line} onSaved={() => done('Quantity cancelled')} />}
      </Modal>
      <Modal open={modal?.type === 'amend'} size="sm" onClose={() => setModal(null)} title={`Amend line ${modal?.line?.line_no}`} subtitle="Needs a reason; the original baseline is kept">
        {modal?.type === 'amend' && <AmendForm line={modal.line} onSaved={() => done('Line amended')} />}
      </Modal>
      <Modal open={modal?.type === 'commitment'} size="sm" onClose={() => setModal(null)} title={modal?.line?.commitment_state === 'committed' ? 'Correct original commitment' : 'Agree dispatch commitment'}>
        {modal?.type === 'commitment' && <CommitmentForm line={modal.line} onSaved={() => done('Commitment saved')} />}
      </Modal>
      <Modal open={modal?.type === 'split'} size="sm" onClose={() => setModal(null)} title="Split into a separate delivery">
        {modal?.type === 'split' && <SplitForm line={modal.line} onSaved={() => done('Line split')} />}
      </Modal>
      <Modal open={modal?.type === 'clarify'} size="sm" onClose={() => setModal(null)} title="Clarify specification">
        {modal?.type === 'clarify' && <ClarifyForm line={modal.line} onSaved={() => done('Specification clarified — the line can go into production')} />}
      </Modal>
      <Modal open={modal?.type === 'add_line'} onClose={() => setModal(null)} title="Add a line" subtitle="A new requirement becomes its own line with its own commitment">
        {modal?.type === 'add_line' && <AddLineForm order={o} onSaved={() => done('Line added')} />}
      </Modal>
      <Modal open={modal?.type === 'task'} onClose={() => setModal(null)} title="Record outcome" subtitle={modal?.task?.purpose}>
        {modal?.type === 'task' && <FollowupForm task={modal.task} onSaved={() => done('Recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'reverse'} size="sm" onClose={() => setModal(null)} title={`Reverse ${modal?.dispatch?.code}`}>
        {modal?.type === 'reverse' && <ReasonForm label="Reason for the reversal" danger button="Reverse dispatch" note="The original dispatch stays in history; quantities and reports recalculate." onSubmit={(reason) => api.post(`/dispatches/${modal.dispatch.id}/reverse`, { reason }).then(() => done('Dispatch reversed'))} />}
      </Modal>
      <Modal open={modal?.type === 'cancel_plan'} size="sm" onClose={() => setModal(null)} title={`Cancel plan ${modal?.dispatch?.code}`}>
        {modal?.type === 'cancel_plan' && <ReasonForm label="Why is this plan cancelled?" danger button="Cancel plan" note="The plan stays on record; no quantity changes." onSubmit={(reason) => api.post(`/dispatches/${modal.dispatch.id}/cancel`, { reason }).then(() => done('Plan cancelled'))} />}
      </Modal>
      <Modal open={modal?.type === 'header'} onClose={() => setModal(null)} title={`Order details — ${o.code}`}>
        {modal?.type === 'header' && <HeaderForm order={o} onSaved={() => done('Order details saved')} />}
      </Modal>
      <Modal open={modal?.type === 'delivered'} size="sm" onClose={() => setModal(null)} title="Record delivery">
        {modal?.type === 'delivered' && <DeliveredForm dispatch={modal.dispatch} onSaved={() => done('Delivery recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'hold'} size="sm" onClose={() => setModal(null)} title="Place payment hold">
        {modal?.type === 'hold' && <ReasonForm label="Hold reason" button="Place hold" onSubmit={(reason) => api.post(`/orders/${o.id}/holds`, { reason }).then(() => done('Payment hold placed'))} />}
      </Modal>
      <Modal open={modal?.type === 'release'} size="sm" onClose={() => setModal(null)} title="Release payment hold">
        {modal?.type === 'release' && <ReasonForm label="Release evidence" button="Release hold" note="e.g. advance received — bank reference" onSubmit={(evidence) => api.post(`/holds/${modal.hold.id}/release`, { evidence }).then(() => done('Hold released'))} />}
      </Modal>
    </div>
  );
}

function LineCard({ order, line: l, onSaved, onAction }) {
  const { can } = useAuth();
  const optionLabel = useOptionLabel();
  const q = l.quantities;
  const active = l.status.active;
  const [showForm, setShowForm] = useState(true);
  return (
    <div className="line-card">
      <div className="line-head">
        <strong>Line {l.line_no} · {qty(l.confirmed_qty, l.unit)} × {l.product}</strong>
        {l.spec && <span className="small muted">{l.spec}</span>}
        {l.needs_clarification ? <Badge tone="amber" icon="alert">Specification to clarify</Badge> : null}
        <span className="grow" />
        {order.status === 'confirmed' && <LineStateBadge state={l.status.state} daysLate={l.status.daysLate} pastAgreed={l.status.pastAgreed} />}
      </div>
      <div style={{ padding: '10px 16px 0' }}><JourneyStepper phase={l.phase} workStatus={l.work_status} dispatched={!active && q.dispatched > 0} /></div>
      <div className="line-grid">
        <div className="stack-sm">
          <dl className="facts">
            <dt>Original dispatch promise</dt><dd>{l.commitment_state === 'committed' ? <strong>{date(l.original_commitment_date, { year: true })}</strong> : <Badge tone="violet">{l.commitment_state === 'unknown' ? 'Unknown (legacy) — excluded from timeliness' : 'Not yet agreed'}</Badge>}</dd>
            {l.agreed_commitment_date && <><dt>Customer-agreed date</dt><dd><Badge tone="green">{date(l.agreed_commitment_date)}</Badge></dd></>}
            <dt>Expected dispatch now</dt><dd>{l.estimate_unknown ? <Badge tone="amber">Estimate unknown</Badge> : l.forecast_dispatch_date ? <Badge tone={l.status.atRisk || l.status.overdue ? 'amber' : 'slate'}>{date(l.forecast_dispatch_date)}</Badge> : '—'}</dd>
            {l.forecast_ready_date && <><dt>Expected ready date</dt><dd>{date(l.forecast_ready_date)}</dd></>}
            {active && <><dt>Customer informed</dt><dd><CommBadge state={l.comm?.state} />{l.comm?.state === 'informed' && <span className="tiny muted"> {date(l.comm.informed_at)} by {l.comm.informed_by_name}{l.comm.response ? ` · ${optionLabel('customer_update_outcome', l.comm.response)}` : ''}</span>}</dd></>}
            <dt>Status</dt><dd>{l.phase_label} · {l.work_status_label}{l.work_status === 'on_hold' && l.hold_review_date ? ` (review ${date(l.hold_review_date)})` : ''}</dd>
            {l.issue_label && <><dt>Delay reason</dt><dd><Badge tone="red">{l.issue_label}</Badge>{l.stage_note && <span className="small"> {l.stage_note}</span>}{l.issue && <div className="tiny muted">since {dateTime(l.issue.reported_at)}{l.issue.reported_by_name ? ` (reported by ${l.issue.reported_by_name})` : ''}</div>}</dd></>}
            {!l.issue_label && l.stage_note && <><dt>Stage / note</dt><dd>{l.stage_note}</dd></>}
            {l.action && <><dt>Next action</dt><dd>{l.action.purpose} — <strong>{l.action.owner_name}</strong>{l.action.owner_department ? ` (${l.action.owner_department})` : ''} <DueBadge task={l.action} /></dd></>}
            {active && <><dt>Last update</dt><dd>{l.source_update_at ? `${timeAgo(l.source_update_at)}${l.reported_by ? ` · ${l.reported_by}` : ''}` : 'never'}{l.freshness?.basis === 'entry_time' && <span className="tiny muted"> (entry-time based)</span>}{l.freshness?.stale && <> <Badge size="sm" tone="amber" icon="clock">Needs a fresh update</Badge></>}</dd></>}
          </dl>
          <div className="qty-strip">
            <div><div className="k">Ordered</div><div className="v">{qty(q.confirmed)}</div></div>
            <div><div className="k">Ready (total)</div><div className="v">{q.ready === null ? '—' : qty(q.ready)}</div></div>
            <div><div className="k">Dispatched</div><div className="v">{qty(q.dispatched)}</div></div>
            <div><div className="k">Cancelled</div><div className="v">{qty(q.cancelled)}</div></div>
            <div><div className="k">Remaining</div><div className="v">{qty(q.remaining)}</div></div>
          </div>
          {l.original_qty !== null && l.original_qty !== l.confirmed_qty && <div className="tiny muted">Originally confirmed {qty(l.original_qty)} (amended since).</div>}
          {can('values.view') && <div className="tiny muted">Unit price <Money minor={l.unit_price_minor} currency={order.currency} /></div>}
          {order.status === 'confirmed' && active && (
            <div className="row wrap">
              {can('orders.cancel') && <Button size="xs" variant="ghost" onClick={() => onAction('cancel')}>Cancel quantity</Button>}
              {can('orders.amend') && <Button size="xs" variant="ghost" onClick={() => onAction('amend')}>Amend</Button>}
              {can('orders.amend') && <Button size="xs" variant="ghost" onClick={() => onAction('split')}>Split delivery</Button>}
              {can('orders.edit') && l.commitment_state !== 'committed' && <Button size="xs" variant="primary" onClick={() => onAction('commitment')}>Agree commitment</Button>}
              {can('orders.authorise') && l.commitment_state === 'committed' && <Button size="xs" variant="ghost" onClick={() => onAction('commitment')}>Correct original date</Button>}
              {can('orders.edit') && l.needs_clarification ? <Button size="xs" variant="primary" onClick={() => onAction('clarify')}>Clarify specification</Button> : null}
            </div>
          )}
          {order.status === 'draft' && can('orders.edit') && l.commitment_state !== 'committed' && <Button size="xs" onClick={() => onAction('commitment')}>Set committed date</Button>}
        </div>
        <div>
          {order.status === 'confirmed' && active && can('orders.update') ? (
            showForm ? <ProductionUpdateForm line={l} order={order} onSaved={onSaved} /> : <Button onClick={() => setShowForm(true)}>Record update</Button>
          ) : (
            <div className="muted small">{!active ? 'This line is closed. Its history and timeliness result are kept.' : order.status === 'draft' ? 'Confirm the order before recording production progress.' : 'Production updates are entered by the coordinator or production.'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ReasonForm({ label, button, note, danger, onSubmit }) {
  const save = useSave();
  const [reason, setReason] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(() => onSubmit(reason)); }}>
      {note && <div className="small muted">{note}</div>}
      <Field label={label} required error={save.fields.reason || save.fields.evidence}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={danger ? 'danger' : 'primary'} loading={save.saving}>{button}</Button></div>
    </form>
  );
}

function AmendForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ confirmed_qty: line.confirmed_qty, spec: line.spec || '', unit_price: line.unit_price_minor === null ? '' : fromMinor(line.unit_price_minor), reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/amend`, { ...f, version: line.version }); onSaved(); }); }}>
      <Field label="Confirmed quantity" error={save.fields.confirmed_qty} hint={`Cannot go below dispatched + cancelled (${qty(line.quantities.dispatched + line.quantities.cancelled)})`}><Input type="number" value={f.confirmed_qty} onChange={(e) => setF({ ...f, confirmed_qty: e.target.value })} /></Field>
      <Field label="Specification"><Input value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></Field>
      <Field label="Unit price" optional><Input value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
      <Field label="Reason" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save amendment</Button></div>
    </form>
  );
}

function CommitmentForm({ line, onSaved }) {
  const save = useSave();
  const correcting = line.commitment_state === 'committed';
  const [f, setF] = useState({ original_commitment_date: correcting ? line.original_commitment_date : '', reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/commitment`, f); onSaved(); }); }}>
      {correcting && <Notice tone="warn">Only for correcting a wrong entry. If the customer agreed a new date, record a customer update instead — the original promise must be kept.</Notice>}
      <DateField label="Committed dispatch date" required value={f.original_commitment_date} onChange={(v) => setF({ ...f, original_commitment_date: v })} error={save.fields.original_commitment_date} presets={!correcting} />
      {correcting && <Field label="Reason" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function SplitForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ qty: '', original_commitment_date: '', reason: 'Customer scheduled a separate delivery' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/split`, f); onSaved(); }); }}>
      <div className="small muted">Scheduled deliveries are kept as separate lines, each with its own commitment.</div>
      <Field label={`Quantity for the new delivery (of ${qty(line.quantities.remaining)} remaining)`} required error={save.fields.qty}><Input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
      <DateField label="Its committed dispatch date" required value={f.original_commitment_date} onChange={(v) => setF({ ...f, original_commitment_date: v })} error={save.fields.original_commitment_date} />
      <Field label="Reason" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Split</Button></div>
    </form>
  );
}

function ClarifyForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ spec: line.spec || '', product_id: line.product_id, note: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/order-lines/${line.id}/clarify`, f); onSaved(); }); }}>
      <Field label="Product"><ProductSelect value={f.product_id} onChange={(v) => setF({ ...f, product_id: v })} allowUnspecified={false} /></Field>
      <Field label="Confirmed specification / variant" required error={save.fields.spec}><Input value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></Field>
      <Field label="How it was confirmed" optional><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function AddLineForm({ order, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ product_id: null, description: '', spec: '', confirmed_qty: '', unit: 'pcs', unit_price: '', original_commitment_date: '', uncommitted: false, reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/orders/${order.id}/lines`, { ...f, commitment_state: f.uncommitted ? 'uncommitted' : 'committed', original_commitment_date: f.uncommitted ? undefined : f.original_commitment_date });
      onSaved();
    }); }}>
      <div className="form-grid">
        <Field label="Product"><ProductSelect value={f.product_id} onChange={(v) => setF({ ...f, product_id: v })} /></Field>
        {!f.product_id && <Field label="Description" required error={save.fields['lines.0.description']}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>}
        <Field label="Specification" optional><Input value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} /></Field>
        <Field label="Quantity" required error={save.fields['lines.0.confirmed_qty']}><Input type="number" value={f.confirmed_qty} onChange={(e) => setF({ ...f, confirmed_qty: e.target.value })} /></Field>
        <Field label="Unit price" optional><Input value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
        <Field label="Committed dispatch date" error={save.fields['lines.0.original_commitment_date']}><Input type="date" disabled={f.uncommitted} value={f.original_commitment_date} onChange={(e) => setF({ ...f, original_commitment_date: e.target.value })} /><Checkbox label="Not agreed yet" checked={f.uncommitted} onChange={(v) => setF({ ...f, uncommitted: v })} /></Field>
        <Field label="Reason" required className="full" error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer added 20 pieces by email" /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Add line</Button></div>
    </form>
  );
}

export function DeliveredForm({ dispatch, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ delivered_at: '', received_by_name: '', note: '', pod: null });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/dispatches/${dispatch.id}/delivered`, { delivered_at: f.delivered_at, received_by_name: f.received_by_name, note: f.note, pod_document_id: f.pod?.id }); onSaved(); }); }}>
      <div className="small muted">Optional: actual delivery is separate from dispatch. Timeliness is measured on dispatch unless delivery dates are tracked.</div>
      <Field label="Delivered on" required error={save.fields.delivered_at}><Input type="date" min={dispatch.dispatch_date || undefined} value={f.delivered_at} onChange={(e) => setF({ ...f, delivered_at: e.target.value })} /></Field>
      <Field label="Received by" optional error={save.fields.received_by_name}><Input value={f.received_by_name} onChange={(e) => setF({ ...f, received_by_name: e.target.value })} placeholder="Name at the customer's site" /></Field>
      <Field label="Proof of delivery" optional><FilePick value={f.pod} onChange={(pod) => setF({ ...f, pod })} entityType="dispatch" entityId={dispatch.id} label="Attach signed POD" /></Field>
      <Field label="Note" optional><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

/** Advance, invoices and receipts for this order (per the invoice register; missing invoices are unknown). */
function FinanceCard({ order, finance: f }) {
  const { can } = useAuth();
  const cur = f.currency;
  const due = f.advance_required_minor ? Math.max(0, f.advance_required_minor - (f.advance_received_minor || 0)) : 0;
  return (
    <Card title="Payments" actions={can('finance.view') && <Button size="sm" variant="ghost" to={`/payments?order_id=${order.id}`}>Register</Button>}>
      <Facts items={[
        ['Order value', f.value_minor === null ? <span className="muted">Not fully priced</span> : <Money minor={f.value_minor} currency={cur} />],
        f.advance_pct !== null && f.advance_pct !== undefined ? ['Advance', <span>{f.advance_pct}% · <Money minor={f.advance_required_minor} currency={cur} /> required</span>] : null,
        f.advance_required_minor ? ['Advance received', <span className={due > 0 ? 'warning-text strong' : 'success-text'}><Money minor={f.advance_received_minor} currency={cur} />{due > 0 ? ' — balance pending' : ' — complete'}</span>] : null,
        ['Invoiced', f.invoices.length ? <Money minor={f.invoiced_minor} currency={cur} /> : <span className="muted">No invoices recorded</span>],
        ['Outstanding', f.invoices.length ? <strong><Money minor={f.outstanding_minor} currency={cur} /></strong> : null],
        f.hold ? ['Payment hold', <span className="danger-text">{f.hold.reason}</span>] : null,
      ]} />
      {f.invoices.length > 0 && (
        <div className="stack-xs mt-8">
          {f.invoices.map((i) => <div key={i.id} className="row between small"><span>{i.invoice_ref} · {date(i.invoice_date)}</span><span>{i.outstanding_minor > 0 ? <>due <Money minor={i.outstanding_minor} currency={i.currency} /></> : <Badge size="sm" tone="green">Paid</Badge>}</span></div>)}
        </div>
      )}
    </Card>
  );
}

/** Header details that change after confirmation: owners, factory, priority and commercial terms (audited). */
function HeaderForm({ order: o, onSaved }) {
  const { can } = useAuth();
  const meta = useMeta();
  const save = useSave();
  const commercial = can('orders.amend');
  const sales = can('orders.edit');
  const [f, setF] = useState({
    priority: o.priority || 'normal', factory_id: o.factory_id ? String(o.factory_id) : '', production_owner_id: o.production_owner_id, dispatch_owner_id: o.dispatch_owner_id, accounts_owner_id: o.accounts_owner_id,
    owner_id: o.owner_id, po_reference: o.po_reference || '', payment_terms: o.payment_terms || '', advance_pct: o.advance_pct ?? '', freight: o.freight_minor ? fromMinor(o.freight_minor) : '',
    installation: o.installation_minor ? fromMinor(o.installation_minor) : '', delivery_address: o.delivery_address || '', billing_address: o.billing_address || '', shipping_mode: o.shipping_mode || '', reason: '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const body = { version: o.version, reason: f.reason, factory_id: f.factory_id || null, production_owner_id: f.production_owner_id || null, dispatch_owner_id: f.dispatch_owner_id || null };
    if (sales) Object.assign(body, { priority: f.priority, accounts_owner_id: f.accounts_owner_id || null, owner_id: f.owner_id, po_reference: f.po_reference, delivery_address: f.delivery_address, billing_address: f.billing_address, shipping_mode: f.shipping_mode });
    if (commercial) Object.assign(body, { payment_terms: f.payment_terms, advance_pct: f.advance_pct, freight: f.freight, installation: f.installation });
    const r = await api.put(`/orders/${o.id}`, body);
    onSaved(r);
    return r;
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {save.conflict && <Notice tone="warn">Someone else changed this order — close and reopen it to see the latest version.</Notice>}
      <div className="form-grid">
        {sales && <Field label="Priority"><Select value={f.priority} onChange={(e) => set({ priority: e.target.value })} options={PRIORITIES} /></Field>}
        <Field label="Factory" error={save.fields.factory_id}><Select value={f.factory_id} onChange={(e) => set({ factory_id: e.target.value })} placeholder="Not assigned" options={meta.factories.filter((x) => x.active || String(x.id) === f.factory_id).map((x) => ({ value: String(x.id), label: x.name }))} /></Field>
        <Field label="Production owner" error={save.fields.production_owner_id}><UserSelect value={f.production_owner_id} onChange={(v) => set({ production_owner_id: v })} filter={(p) => ['production', 'coordinator', 'admin', 'staff'].includes(p.group)} placeholder="Not assigned" /></Field>
        <Field label="Dispatch owner" error={save.fields.dispatch_owner_id}><UserSelect value={f.dispatch_owner_id} onChange={(v) => set({ dispatch_owner_id: v })} filter={(p) => ['production', 'coordinator', 'admin', 'staff'].includes(p.group)} placeholder="Not assigned" /></Field>
        {sales && <Field label="Accounts owner" error={save.fields.accounts_owner_id}><UserSelect value={f.accounts_owner_id} onChange={(v) => set({ accounts_owner_id: v })} filter={(p) => ['accounts', 'admin', 'coordinator'].includes(p.group)} placeholder="Not assigned" /></Field>}
        {sales && <Field label="Sales owner" error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>}
        {sales && <Field label="Customer PO reference" error={save.fields.po_reference}><Input value={f.po_reference} onChange={(e) => set({ po_reference: e.target.value })} /></Field>}
        {sales && <Field label="Shipping mode" optional><Input value={f.shipping_mode} onChange={(e) => set({ shipping_mode: e.target.value })} /></Field>}
        {commercial && <div className="form-section">Commercial terms (coordinator / management)</div>}
        {commercial && <Field label="Payment terms" className="full"><Input value={f.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>}
        {commercial && <Field label="Advance %" error={save.fields.advance_pct}><Input type="number" min={0} max={100} value={f.advance_pct} onChange={(e) => set({ advance_pct: e.target.value })} /></Field>}
        {commercial && <Field label={`Freight (${o.currency})`} error={save.fields.freight}><Input inputMode="decimal" value={f.freight} onChange={(e) => set({ freight: e.target.value })} /></Field>}
        {commercial && <Field label={`Installation (${o.currency})`} error={save.fields.installation}><Input inputMode="decimal" value={f.installation} onChange={(e) => set({ installation: e.target.value })} /></Field>}
        {sales && <Field label="Delivery address" className="full"><Textarea rows={2} value={f.delivery_address} onChange={(e) => set({ delivery_address: e.target.value })} /></Field>}
        {sales && <Field label="Billing address" className="full"><Textarea rows={2} value={f.billing_address} onChange={(e) => set({ billing_address: e.target.value })} /></Field>}
        <Field label="Reason for the change" optional className="full" hint="Kept with the change in the order history"><Input value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save details</Button></div>
    </form>
  );
}

export { labelOf, PHASES, todayLocal };
