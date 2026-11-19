// The sales pipeline: every live deal across enquiry → quotation → confirmation → payment → production →
// dispatch, where it is now and, when it is stuck, why. Dragging a card on to the next column does that step
// for real (start the quotation, record the customer's approval, create the order, record the payment, mark it
// ready, dispatch it) after a short form. The card then sits wherever its records put it.
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { JOURNEY_STAGES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { compactMoney, date } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, Drawer, EmptyState, ErrorState, Facts, Modal, Notice, PageHeader, SaveStatus, SearchBox, Segmented, Select, Spinner, useToast,
} from '../components/ui.jsx';
import { DealReasons, PaymentBadge, SalesJourney, usePeople } from '../components/domain.jsx';
import Board from '../components/Board.jsx';
import StageForm from '../components/StageForm.jsx';
import { ConvertForm, OutcomeForm } from '../components/QuoteForms.jsx';
import { DispatchForm, PaymentForm, ReadyForm } from '../components/forms.jsx';

const TONE = { red: 'red', amber: 'amber' };
const ORDER = JOURNEY_STAGES.map((s) => s.value);
const stageName = (stage) => labelOf(JOURNEY_STAGES, stage);
// Whoever can do at least one of the steps can pick a card up; each drop checks its own permission.
const MOVE_PERMS = ['enquiries.edit', 'quotes.edit', 'orders.edit', 'finance.edit', 'orders.update', 'dispatch.post'];
const NEXT = { enquiry: 'quotation', quotation: 'confirmation', confirmation: 'production', payment: 'production', production: 'dispatch', dispatch: 'dispatched' };
const STEP_LABEL = { quote: 'Start quotation', approve: 'Customer approved', convert: 'Create order', confirm: 'Confirm order', payment: 'Record payment', ready: 'Mark ready', dispatch: 'Record dispatch', lost: 'Lost' };

/**
 * What dropping a deal on a column, or on Dispatched or Lost, does: the step to take, or why it cannot move.
 * A deal moves forward one step at a time, and its column always follows its records.
 */
export function planMove(deal, to, can) {
  const { code, quotation: q, order: o } = deal;
  if (!to || to === deal.stage) return null;
  if (to === 'lost') {
    if (o) return { reason: `${o.code} is an order. To cancel it, open it and cancel the quantity.` };
    if (!deal.enquiry) return { reason: `Open ${code} to record the customer's decision.` };
    if (!can('enquiries.edit')) return { reason: 'You cannot close enquiries.' };
    return { step: 'lost', title: `${deal.enquiry.code} lost` };
  }
  if (to === 'dispatched') {
    if (!o || o.status === 'draft') return { reason: `${code} has no confirmed order to dispatch yet.` };
    if (!can('dispatch.post')) return { reason: 'You cannot record dispatches.' };
    return { step: 'dispatch', title: `Dispatch ${o.code}` };
  }
  if (ORDER.indexOf(to) < ORDER.indexOf(deal.stage)) return { reason: `${code} cannot go back to ${stageName(to)}. To change it, open it.` };
  switch (deal.stage) {
    case 'enquiry':
      if (to !== 'quotation') return { reason: `${code} needs a quotation first: drop it on Quotation.` };
      if (!can('quotes.edit')) return { reason: 'You cannot make quotations.' };
      return { step: 'quote', title: `Quotation for ${code}` };
    case 'quotation':
      if (to !== 'confirmation') return { reason: `${code} needs the customer's approval first: drop it on Confirmation.` };
      if (q?.tracking === 'pending') return { reason: `${code} has not been sent yet. Open it and mark it as sent first.` };
      if (q?.tracking === 'rejected') return { reason: `The customer rejected ${code}. Open it to make a new version.` };
      if (!can('quotes.edit')) return { reason: 'You cannot record the customer\'s decision.' };
      return { step: 'approve', title: `${code} approved by the customer` };
    case 'confirmation':
      if (to === 'dispatch') return { reason: `${code} needs its order first: drop it on Payment or Production.` };
      if (!can('orders.edit')) return { reason: 'You cannot create or confirm orders.' };
      return o ? { step: 'confirm', title: `Confirm ${o.code}` } : { step: 'convert', title: `Order for ${code}` };
    case 'payment':
      if (to !== 'production') return { reason: `${code} is waiting for payment: drop it on Production once the advance is in.` };
      if (deal.payment?.code === 'on_hold') return { reason: `${code} has a payment hold. Open the order to release it.` };
      if (!can('finance.edit')) return { reason: 'Only accounts or management can record payments.' };
      return { step: 'payment', title: `Payment for ${code}` };
    case 'production':
      if (!can('orders.update')) return { reason: 'You cannot update production.' };
      return { step: 'ready', title: `${code} ready for dispatch` };
    default:
      return { reason: `${code} is waiting to be dispatched: drop it on Dispatched once it has left.` };
  }
}

function StuckBadge({ deal }) {
  if (deal.status !== 'active') return <Badge size="sm" tone="slate">{deal.status === 'completed' ? 'Completed' : 'Closed'}</Badge>;
  return deal.stuck ? <Badge size="sm" tone={TONE[deal.severity]}>Stuck</Badge> : <Badge size="sm" tone="green">Moving</Badge>;
}

function DealCard({ deal, onOpen, drag }) {
  const main = deal.reasons.find((r) => r.severity === 'red' || r.severity === 'amber');
  const more = deal.reasons.filter((r) => r.severity === 'red' || r.severity === 'amber').length - 1;
  const open = () => onOpen(deal);
  return (
    <div role="button" tabIndex={0} data-deal={deal.key} className={`kcard deal ${deal.severity || ''} ${drag.dragging?.key === deal.key ? 'dragging' : ''}`}
      draggable={drag.enabled} onDragStart={(e) => drag.start(e, deal)} onDragEnd={drag.end}
      onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
      <span className="row between" style={{ gap: 6 }}><strong className="small">{deal.code}</strong><span className="tiny muted nowrap">{deal.days_in_stage} d here</span></span>
      <span className="small strong truncate">{deal.customer_name}</span>
      <span className="tiny muted truncate">{deal.title}</span>
      {main && <span className={`tiny strong ${deal.severity === 'red' ? 'danger-text' : 'warning-text'}`}>{main.text}{more > 0 ? ` · +${more} more` : ''}</span>}
      <span className="row between wrap" style={{ gap: 4 }}><span className="tiny muted truncate">{deal.owner_name}</span><PaymentBadge payment={deal.payment} /></span>
    </div>
  );
}

export function DealDrawer({ deal, onClose, onStep }) {
  const { can } = useAuth();
  if (!deal) return null;
  const blocking = deal.reasons.some((r) => r.severity === 'red' || r.severity === 'amber');
  const next = onStep && deal.status === 'active' ? planMove(deal, NEXT[deal.stage], can) : null;
  return (
    <Drawer open wide onClose={onClose} title={`${deal.code} · ${deal.customer_name}`} subtitle={deal.title}>
      <div className="stack">
        <SalesJourney deal={deal} />
        {next?.step && <div><Button variant="cta" icon="arrowRight" onClick={() => onStep(deal, next)}>{STEP_LABEL[next.step]}</Button></div>}
        {next?.reason && <Notice tone="info">{next.reason}</Notice>}
        <Card title={blocking ? 'Why it is stuck' : 'Status'} sub={`${deal.days_in_stage} days at ${deal.stage_label}`}>
          {deal.reasons.length ? <DealReasons deal={deal} /> : <div className="small muted">Nothing is blocking this one.</div>}
        </Card>
        <Card title="Details">
          <Facts items={[
            ['Assigned to', deal.owner_name],
            ['Next action', deal.next_action ? `${deal.next_action.purpose} · ${date(deal.next_action.due_date)}${deal.next_action.owner_name ? ` · ${deal.next_action.owner_name}` : ''}` : 'None planned'],
            ['Source', deal.exhibition ? <Link to={`/campaigns/${deal.exhibition.id}`}>{deal.exhibition.name}</Link> : deal.source_label],
            ['Payment', deal.payment ? <PaymentBadge payment={deal.payment} /> : null],
            can('values.view') && deal.value_minor ? ['Value', compactMoney(deal.value_minor, deal.currency)] : null,
          ].filter(Boolean)} />
        </Card>
        <div className="row wrap">
          <Button to={`/customers/${deal.customer_id}`} icon="users">Customer</Button>
          {deal.enquiry && <Button to={`/enquiries/${deal.enquiry.id}`} icon="inbox">Enquiry {deal.enquiry.code}</Button>}
          {deal.quotation && <Button to={`/quotations/${deal.quotation.id}`} icon="quotation">Quotation {deal.quotation.number}</Button>}
          {deal.order && <Button to={`/orders/${deal.order.id}`} icon="box">Order {deal.order.code}</Button>}
        </div>
      </div>
    </Drawer>
  );
}

export default function Pipeline() {
  const { can } = useAuth();
  const toast = useToast();
  const people = usePeople({ activeOnly: false });
  const [f, setF] = useUrlFilters({ view: 'board' });
  const { data, error, loading, reload } = useApi('/pipeline', { q: f.q, owner: f.owner, stage: f.stage, stuck: f.stuck });
  const [open, setOpen] = useState(null);
  const [move, setMove] = useState(null); // a step waiting for its form: { deal, plan }
  const held = useRef(null); // the card being dragged, readable at once by the drag events
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const canMove = MOVE_PERMS.some((p) => can(p));
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const stages = data?.stages || [];
  const shownStages = stages.filter((s) => !f.stage || s.value === f.stage);

  const tryMove = (deal, to) => {
    const plan = planMove(deal, to, can);
    if (!plan) return;
    if (plan.reason) toast.error(plan.reason);
    else setMove({ deal, plan });
  };
  const endDrag = () => {
    held.current = null;
    setDragging(null);
    setOver(null);
  };
  const startDrag = (e, deal) => {
    held.current = deal;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/deal', deal.key);
    const box = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setDragImage(e.currentTarget, e.clientX - box.left, e.clientY - box.top);
    // After the browser has taken its picture of the card: changing the page during this event can cancel the drag.
    setTimeout(() => setDragging(deal), 0);
  };
  const dropTarget = (to) => (canMove ? {
    onDragOver: (e) => {
      if (!held.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== to) setOver(to);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOver((s) => (s === to ? null : s));
    },
    onDrop: (e) => {
      e.preventDefault();
      const deal = held.current;
      endDrag();
      if (deal) tryMove(deal, to);
    },
  } : {});
  const done = (message) => {
    toast.success(message);
    setMove(null);
    setOpen(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const drag = { enabled: canMove, dragging, start: startDrag, end: endDrag };
  const board = f.view === 'board';

  return (
    <div className="stack">
      <PageHeader title="Sales pipeline" subtitle={data ? `${data.total} live · ${data.stuck} stuck${board && canMove && data.total ? ' · drag a card to its next step' : ''}` : 'Loading…'}
        actions={<Segmented label="View" value={f.view} onChange={(v) => setF({ view: v })} options={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />} />
      <div className="stage-strip" role="group" aria-label="Journey stages">
        {stages.map((s) => (
          <button key={s.value} type="button" className={`stage ${f.stage === s.value ? 'on' : ''}`} aria-pressed={f.stage === s.value} onClick={() => setF({ stage: f.stage === s.value ? '' : s.value })}>
            <span className="l">{s.label}</span>
            <span className="n">{s.count}</span>
            <span className={`s ${s.stuck ? 'bad' : ''}`}>{s.stuck ? `${s.stuck} stuck` : 'None stuck'}</span>
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer…" />
        <Select aria-label="Assigned to" value={f.owner || ''} onChange={(e) => setF({ owner: e.target.value })} placeholder="Everyone" options={people.map((p) => ({ value: String(p.id), label: p.name }))} />
        <Chips value={f.stuck || ''} onChange={(v) => setF({ stuck: v })} options={[{ value: '', label: 'All' }, { value: '1', label: 'Stuck', tone: 'red' }]} />
      </div>
      {!data && loading && <Spinner />}
      {data && !data.count && (
        <EmptyState icon="pipeline" title={data.total ? 'No deals match these filters' : 'Nothing in the pipeline yet'}
          message={data.total ? 'Clear a filter to see more.' : 'Add a customer, then an enquiry. It moves along here by itself.'}
          action={!data.total && <Button variant="primary" icon="users" to="/customers">Go to customers</Button>} />
      )}
      {data && data.count > 0 && board && (
        <Board dragging={dragging}>
          {shownStages.map((s) => {
            const items = data.items.filter((d) => d.stage === s.value);
            return (
              <div key={s.value} className={`kcol ${over === s.value ? 'drop-over' : ''}`} data-stage={s.value} {...dropTarget(s.value)}>
                <div className="kcol-head"><strong>{s.label}</strong><span className="tiny muted">{items.length} shown{s.stuck ? ` · ${s.stuck} stuck` : ''}</span></div>
                <div className="kcol-body">
                  {items.map((d) => <DealCard key={d.key} deal={d} onOpen={setOpen} drag={drag} />)}
                  {!items.length && <div className="tiny muted" style={{ padding: 8 }}>{canMove ? 'Drag a deal here' : 'Nothing here'}</div>}
                </div>
              </div>
            );
          })}
        </Board>
      )}
      {dragging && (
        <div className="kclose-bar" role="group" aria-label="Finish this deal">
          {dragging.order
            ? <div data-stage="dispatched" className={`kclose done ${over === 'dispatched' ? 'drop-over' : ''}`} {...dropTarget('dispatched')}>Dispatched</div>
            : <div data-stage="lost" className={`kclose lost ${over === 'lost' ? 'drop-over' : ''}`} {...dropTarget('lost')}>Lost</div>}
        </div>
      )}
      {data && data.count > 0 && !board && (
        <Card flush>
          <DataTable rows={data.items} rowKey="key" onRowClick={setOpen} columns={[
            { key: 'c', label: 'Customer', render: (d) => <><strong>{d.customer_name}</strong><div className="sub">{d.code} · {d.title}</div></> },
            { key: 'st', label: 'Stage', render: (d) => <span className="stack-xs"><span className="small strong">{d.stage_label}</span><StuckBadge deal={d} /></span> },
            { key: 'why', label: 'Why it is stuck', render: (d) => (d.reasons.length ? <DealReasons deal={d} limit={2} /> : <span className="muted small">Nothing blocking</span>) },
            { key: 'days', label: 'Days here', align: 'num', render: (d) => d.days_in_stage },
            { key: 'pay', label: 'Payment', render: (d) => <PaymentBadge payment={d.payment} /> },
            { key: 'next', label: 'Next action', render: (d) => (d.next_action ? <span className="small">{d.next_action.purpose}<div className="tiny muted">{date(d.next_action.due_date)}</div></span> : <span className="muted small">None</span>) },
            { key: 'o', label: 'Assigned to', render: (d) => <span className="small">{d.owner_name}</span> },
          ]} />
        </Card>
      )}
      <DealDrawer deal={open} onClose={() => setOpen(null)} onStep={canMove ? (deal, plan) => setMove({ deal, plan }) : undefined} />
      {move && <MoveDialog move={move} onClose={() => setMove(null)} onDone={done} />}
    </div>
  );
}

/** The form for one step, opened by a drop or by the next-step button. */
function MoveDialog({ move: { deal, plan }, onClose, onDone }) {
  const wide = ['convert', 'dispatch', 'ready'].includes(plan.step);
  return (
    <Modal open size={wide ? 'lg' : 'sm'} onClose={onClose} title={plan.title} subtitle={deal.customer_name}>
      {plan.step === 'quote' && <StartQuote deal={deal} />}
      {plan.step === 'approve' && <OutcomeForm r={{ id: deal.quotation.revision_id }} outcome="accepted" onSaved={() => onDone(`${deal.code} approved`)} />}
      {plan.step === 'convert' && <ConvertForm r={{ id: deal.quotation.revision_id }} onSaved={(res) => onDone(`Order ${res.order_code} created`)} />}
      {plan.step === 'confirm' && <ConfirmOrder order={deal.order} onSaved={() => onDone(`${deal.order.code} confirmed`)} />}
      {plan.step === 'payment' && <Loaded url={`/orders/${deal.order.id}`}>{(d) => <PaymentForm order={d.order} amountMinor={dueNow(d.finance)} onSaved={() => onDone(`Payment saved for ${deal.code}`)} />}</Loaded>}
      {plan.step === 'ready' && <Loaded url={`/orders/${deal.order.id}`}>{(d) => <ReadyForm lines={d.lines} onSaved={() => onDone(`${deal.code} is ready for dispatch`)} />}</Loaded>}
      {plan.step === 'dispatch' && <DispatchForm customerId={deal.customer_id} orderId={deal.order.id} onSaved={() => onDone(`${deal.code} dispatched`)} />}
      {plan.step === 'lost' && <Loaded url={`/enquiries/${deal.enquiry.id}`}>{(d) => <StageForm enquiry={d.enquiry} stage="lost" hasTask={d.tasks.some((t) => t.status === 'open')} onSaved={() => onDone(`${deal.enquiry.code} closed as lost`)} />}</Loaded>}
    </Modal>
  );
}

function Loaded({ url, children }) {
  const { data, error, reload } = useApi(url);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return data ? children(data) : <Spinner />;
}

/** The advance still to come in, or else the balance. */
function dueNow(finance) {
  if (!finance) return null;
  const advance = (finance.advance_required_minor || 0) - (finance.advance_received_minor || 0);
  return advance > 0 ? advance : finance.balance_minor;
}

function StartQuote({ deal }) {
  const navigate = useNavigate();
  const save = useSave();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const res = await api.post('/quotations', { enquiry_id: deal.enquiry.id }); navigate(`/quotations/${res.quotation_id}/edit`); }); }}>
      <div className="small">The quotation opens with the products from {deal.enquiry.code}. Add the prices and save it.</div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Start quotation</Button></div>
    </form>
  );
}

function ConfirmOrder({ order, onSaved }) {
  const save = useSave();
  const problems = Object.values(save.fields || {});
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      const { order: current } = await api.get(`/orders/${order.id}`);
      await api.post(`/orders/${order.id}/confirm`, { version: current.version });
      onSaved();
    }); }}>
      <div className="small">Confirming {order.code} records who confirmed it and when. Production can then start.</div>
      {problems.length > 0 && <Notice tone="danger" title="Open the order to finish it first">{problems.join(' ')}</Notice>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Confirm order</Button></div>
    </form>
  );
}
