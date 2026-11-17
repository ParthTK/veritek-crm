import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { labelOf, toneOf, ENQUIRY_STAGES, COUNTRIES, SEGMENTS, PHASES, VALUE_CATEGORIES, INDUSTRIES, CURRENCIES, CONTACT_ROLES } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, qty, pct, money, moneyByCurrency, timeAgo } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, ErrorState, Facts, Field, Input, Modal, Notice, PageHeader, SaveStatus, Spinner, Tabs, Checkbox, Select, Textarea, useToast, Combobox,
} from '../components/ui.jsx';
import {
  HealthLabels, LineStateBadge, OutcomeBadges, CommBadge, DueBadge, StageBadge, Timeline, TIMELINE_FILTERS, Attachments, PinButton, UserSelect, CountrySelect, useOptions, Money, ReactivationBadge, QuoteBadge, useMeta,
} from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';
import Icon from '../components/Icon.jsx';

export default function CustomerProfile() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const quick = useQuickEntry();
  const { data, error, reload } = useApi(`/customers/${id}`);
  const [tab, setTab] = useState('history');
  const [modal, setModal] = useState(params.get('compare') ? { type: 'merge', other: Number(params.get('compare')) } : null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { customer: c, summary: s, delivery: d, attention, health, commercial, recent_orders: recent, payment } = data;
  const next = s.next_action;
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
  };
  const openNext = async () => {
    const t = await api.get(`/tasks/${next.id}`);
    setModal({ type: 'task', task: { ...t } });
  };

  return (
    <div className="stack">
      {c.merged_into_id && <Notice tone="warn" title="This profile was merged">All its records now belong to <Link to={`/customers/${c.merged_into_id}`}>{c.merged_into_code}</Link>. This page is kept for the audit trail.</Notice>}
      <PageHeader crumbs={[{ label: 'Customers', to: '/customers' }, { label: c.code }]}
        title={c.company_name}
        subtitle={[c.industry, [c.city, c.state].filter(Boolean).join(', '), c.region_name, c.owner_name && `owner ${c.owner_name}`].filter(Boolean).join(' · ') || 'One customer. All enquiries, orders and interactions.'}
        eyebrow={<><HealthLabels labels={health} />{c.value_category && <Badge tone={toneOf(VALUE_CATEGORIES, c.value_category)}>{c.value_category_label}</Badge>}{c.credit_hold ? <Badge tone="red" icon="ban">Credit hold{c.credit_hold_reason ? `: ${c.credit_hold_reason}` : ''}</Badge> : null}{c.tags?.map((t) => <span key={t.id} className="tag">{t.name}</span>)}</>}
        actions={<>
          <PinButton type="customer" id={c.id} pinned={data.pinned} onChange={reload} />
          {can('enquiries.edit') && !c.merged_into_id && <Button icon="plus" onClick={() => quick.open('enquiry')}>New enquiry</Button>}
          {can('quotes.edit') && !c.merged_into_id && <Button icon="quotation" to={`/quotations/new?customer_id=${c.id}`}>New quotation</Button>}
          {next ? <Button variant="cta" icon="calendar" onClick={() => openNext().catch((e) => toast.error(e.message))}>Next action: {next.purpose} · <DueBadge task={next} /></Button>
            : can('tasks.edit') && <Button variant="cta" icon="plus" onClick={() => setModal({ type: 'new_task' })}>Set next action</Button>}
        </>}
      />
      <div className="tiles">
        <div className="tile"><span className="tile-icon"><Icon name="calendar" /></span><span><div className="label">First order</div><div className="value" style={{ fontSize: 22 }}>{s.first_order_date ? date(s.first_order_date, { year: true }) : '—'}</div><div className="foot">{s.first_order_source || 'No orders recorded'}</div></span></div>
        <div className="tile"><span className="tile-icon"><Icon name="layers" /></span><span><div className="label">Confirmed orders</div><div className="value">{s.orders.confirmed}{s.legacy_order_count ? <span className="small muted"> +{s.legacy_order_count} historical</span> : null}</div><div className="foot">{s.orders.active} active · {s.orders.fully_dispatched} dispatched · {s.orders.fully_cancelled} cancelled{s.orders.dispatched_and_cancelled ? ` · ${s.orders.dispatched_and_cancelled} mixed` : ''}</div></span></div>
        <div className="tile"><span className="tile-icon"><Icon name="checkCircle" /></span><span><div className="label">Dispatched on time</div><div className="value">{d.eligible ? `${d.on_time} of ${d.eligible}` : '—'}</div><div className="foot">lines vs original promise{d.excluded_unknown ? ` · ${d.excluded_unknown} excluded (no commitment)` : ''}</div></span></div>
        <div className="tile"><span className="tile-icon"><Icon name="box" /></span><span><div className="label">Active orders</div><div className="value">{s.orders.active}</div><div className="foot">{s.active_balance.lines} open line(s){can('values.view') && Object.keys(s.active_balance.value_by_currency).length ? ` · ${moneyByCurrency(s.active_balance.value_by_currency)}` : ''}</div></span></div>
      </div>
      <div className="card"><div className="card-body small" style={{ padding: '10px 16px' }}>
        <strong>{d.eligible + d.excluded_unknown} dispatched line(s):</strong> <span className="success-text">{d.on_time} on time</span>, <span className="danger-text">{d.late} late</span>
        {d.excluded_unknown ? <>, {d.excluded_unknown} without a commitment (excluded)</> : null} • {d.cancelled_lines} fully cancelled • {d.open_overdue} open and overdue
        <span className="muted"> · Late means dispatched after the original committed date — not late delivery.</span>
      </div></div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'history', label: 'History' },
        { key: 'enquiries', label: 'Enquiries', count: data.enquiries.length },
        can('quotes.view') && { key: 'quotations', label: 'Quotations', count: data.quotations?.length || null },
        { key: 'orders', label: 'Orders' },
        { key: 'activities', label: 'Activities' },
        { key: 'tasks', label: 'Tasks' },
        { key: 'documents', label: 'Documents', count: data.documents.length },
        can('finance.view') && { key: 'payments', label: 'Payments' },
        can('complaints.view') && { key: 'complaints', label: 'Complaints', count: data.complaints?.length || null },
        can('objects.view') && { key: 'objects', label: 'Equipment & QR', count: data.objects?.length || null },
        { key: 'details', label: 'Contacts & details' },
      ]} />

      {tab === 'history' && (
        <div className="split">
          <div className="stack">
            <Card title="Recent orders" sub="latest six — the full list is on the Orders tab" flush actions={<Button size="sm" variant="ghost" onClick={() => setTab('orders')}>All orders</Button>}>
              <DataTable rows={recent} empty={<div className="empty small">No orders yet.</div>} columns={[
                { key: 'code', label: 'Order', render: (o) => <Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link> },
                { key: 'product', label: 'Product', render: (o) => o.product },
                { key: 'orig', label: 'Original promise', render: (o) => (o.original_date ? date(o.original_date) : <span className="muted">—</span>) },
                { key: 'latest', label: 'Current forecast / dispatched', render: (o) => (o.active ? (o.forecast_date ? date(o.forecast_date) : '—') : o.last_dispatch_date ? `Dispatched ${date(o.last_dispatch_date)}` : '—') },
                { key: 'outcome', label: 'Outcome', render: (o) => (o.status === 'draft' ? <Badge>Draft</Badge> : o.active ? (o.overdue ? <LineStateBadge state="overdue" size="sm" /> : o.delayed ? <LineStateBadge state="at_risk" size="sm" /> : <Badge tone="amber" size="sm">{o.phase === 'mixed' ? 'In progress (mixed)' : `In ${labelOf(PHASES, o.phase).toLowerCase()}`}</Badge>): <>{o.cancel_reason ? <Badge tone="red" size="sm">Cancelled: {o.cancel_reason}</Badge> : <OutcomeBadges outcome={o.outcome} size="sm" />}</>) },
              ]} />
            </Card>
            <Card title="Recent customer interactions" actions={<Button size="sm" variant="ghost" onClick={() => setTab('activities')}>Full history</Button>}>
              <Timeline items={data.recent_interactions} />
              <div className="tiny muted mt-8"><Icon name="info" size={12} /> Original commitments remain visible when dates change.</div>
            </Card>
          </div>
          <div className="stack">
            <Card title="Current attention" className={attention.length ? 'highlight' : ''}>
              {!attention.length && <div className="muted small">Nothing needs attention right now.</div>}
              <div className="stack-sm">
                {attention.map((a, i) => <AttentionItem key={i} a={a} onRecord={() => quick.open('update', { line_id: a.line_id, order_code: a.order_code })} />)}
              </div>
            </Card>
            <Card title="Summary">
              <Facts items={[
                ['Last order', s.last_order_date ? `${date(s.last_order_date, { year: true })}${s.last_order_source !== 'orders' ? ` (${s.last_order_source})` : ''}` : s.has_orders ? 'Unknown (historical)' : 'Never'],
                ['Last enquiry', s.last_enquiry_date ? date(s.last_enquiry_date, { year: true }) : '—'],
                ['Last contact', s.last_contact ? `${s.last_contact.outcome_label || ''} · ${timeAgo(s.last_contact.occurred_at)}` : 'None recorded'],
                ['Last attempt', s.last_attempt && s.last_attempt.outcome === 'no_answer' ? `No answer · ${timeAgo(s.last_attempt.occurred_at)}` : null],
                ['Open opportunities', s.open_opportunities],
                ['Owner', c.owner_name],
                data.reactivation && ['Reconnect case', <ReactivationBadge status={data.reactivation.status} />],
              ]} />
            </Card>
            <Card title="Commercial context">
              <div className="stack-sm small">
                {can('values.view') && <div><strong>Order totals</strong> (confirmed, per currency — never combined): {commercial.order_totals_by_currency.length ? commercial.order_totals_by_currency.map((t) => <div key={t.currency}>{money(t.value_minor, t.currency)} across {t.orders} order(s){t.lines_without_price ? ` · ${t.lines_without_price} line(s) without price not counted` : ''}</div>) : '—'}</div>}
                <div><strong>Bought:</strong> {commercial.products_bought.map((p) => `${p.product} (${qty(p.qty)})`).join(', ') || '—'}</div>
                <div><strong>Enquired:</strong> {commercial.products_enquired.map((p) => p.product).join(', ') || '—'}</div>
                <div><strong>Missed opportunities:</strong> {commercial.missed_reasons.length ? commercial.missed_reasons.map((m) => <div key={m.enquiry_id}><Link to={`/enquiries/${m.enquiry_id}`}>{m.code}</Link> — {m.reason || 'reason not recorded'} ({date(m.decided_at)})</div>) : 'none recorded'}</div>
                <div className="tiny muted">Lifetime value and profitability are not inferred from incomplete order values.</div>
              </div>
            </Card>
          </div>
        </div>
      )}
      {tab === 'enquiries' && <Card flush><DataTable rows={data.enquiries} onRowClick={(e) => window.location.assign(`/enquiries/${e.id}`)} columns={[
        { key: 'code', label: 'Enquiry', render: (e) => <Link to={`/enquiries/${e.id}`}>{e.code}</Link> }, { key: 'products', label: 'Products', render: (e) => e.products || '—' },
        { key: 'stage', label: 'Status', render: (e) => <StageBadge stage={e.stage} /> }, { key: 'reason', label: 'Lost reason', render: (e) => e.lost_reason || '—' },
        { key: 'received', label: 'Received', render: (e) => (e.received_unknown ? 'Unknown' : date(e.received_at, { year: true })) }, { key: 'owner', label: 'Owner', render: (e) => e.owner_name },
      ]} /></Card>}
      {tab === 'quotations' && <Card flush><DataTable rows={data.quotations} onRowClick={(q) => window.location.assign(`/quotations/${q.id}`)} columns={[
        { key: 'n', label: 'Quotation', render: (q) => <Link to={`/quotations/${q.id}`}><strong>{q.number}</strong> rev {q.revision_no}</Link> },
        { key: 's', label: 'Subject', render: (q) => q.subject || '—' },
        { key: 'st', label: 'Status', render: (q) => <span className="row wrap" style={{ gap: 4 }}><QuoteBadge status={q.status} size="sm" />{q.expired && <Badge size="sm" tone="amber">Expired</Badge>}</span> },
        can('values.view') && { key: 'v', label: 'Value (pre-GST)', align: 'num', render: (q) => <Money minor={q.total_minor} currency={q.currency} /> },
        { key: 'sent', label: 'Sent', render: (q) => (q.sent_at ? date(q.sent_at) : <span className="muted">Not sent</span>) },
        { key: 'valid', label: 'Valid until', render: (q) => date(q.validity_date) },
      ]} empty={<div className="empty small">No quotations yet.</div>} /></Card>}
      {tab === 'objects' && <Card flush title="Equipment & QR codes" sub="objects linked to this customer" actions={can('objects.edit') && <Button size="sm" to="/objects">Objects & QR</Button>}><DataTable rows={data.objects} onRowClick={(o) => window.location.assign(`/objects/${o.id}`)} columns={[
        { key: 'id', label: 'Object ID', render: (o) => <span className="mono">{o.public_id}</span> },
        { key: 'n', label: 'Name', render: (o) => <Link to={`/objects/${o.id}`}>{o.name}</Link> },
        { key: 'sn', label: 'Serial', render: (o) => o.serial_number || '—' },
        { key: 'sc', label: 'Scans', align: 'num', render: (o) => o.scan_count || 0 },
        { key: 'st', label: 'Status', render: (o) => <Badge size="sm" tone={o.status === 'active' ? 'green' : 'slate'}>{o.status}</Badge> },
      ]} empty={<div className="empty small">No objects linked. Link a machine or panel to this customer from its object page.</div>} /></Card>}
      {tab === 'orders' && <OrdersTab customerId={c.id} />}
      {tab === 'activities' && <ActivitiesTab customerId={c.id} />}
      {tab === 'tasks' && <TasksTab customerId={c.id} />}
      {tab === 'documents' && <Card><Attachments items={data.documents} entityType="customer" entityId={c.id} onChange={reload} /></Card>}
      {tab === 'payments' && <PaymentsTab payment={payment} customerId={c.id} />}
      {tab === 'complaints' && <ComplaintsTab customerId={c.id} />}
      {tab === 'details' && <DetailsTab data={data} onSaved={() => done('Saved')} onAction={setModal} />}

      <Modal open={modal?.type === 'task'} onClose={() => setModal(null)} title="Record outcome" subtitle={modal?.task?.purpose}>
        {modal?.type === 'task' && <FollowupForm task={modal.task} contacts={data.contacts.filter((x) => x.active)} onSaved={() => done('Outcome recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'new_task'} size="sm" onClose={() => setModal(null)} title="Set next action">
        {modal?.type === 'new_task' && <NewTaskForm customerId={c.id} ownerId={c.owner_id} onSaved={() => done('Next action set')} />}
      </Modal>
      <Modal open={modal?.type === 'merge'} onClose={() => setModal(null)} title="Merge a duplicate into this customer">
        {modal?.type === 'merge' && <MergeForm target={c} otherId={modal.other} onSaved={() => done('Merged — all linked records kept, with an audit trail')} />}
      </Modal>
      <Modal open={modal?.type === 'dnc'} size="sm" onClose={() => setModal(null)} title={c.do_not_contact ? 'Clear do-not-contact' : 'Mark do-not-contact'}>
        {modal?.type === 'dnc' && <DncForm customer={c} onSaved={() => done('Preference saved')} />}
      </Modal>
      <Modal open={modal?.type === 'contact'} size="sm" onClose={() => setModal(null)} title={modal?.contact ? 'Edit contact' : 'Add contact'}>
        {modal?.type === 'contact' && <ContactForm customerId={c.id} contact={modal.contact} onSaved={() => done('Contact saved')} />}
      </Modal>
    </div>
  );
}

function AttentionItem({ a, onRecord }) {
  const { can } = useAuth();
  if (a.type === 'delay' || a.type === 'issue') {
    return (
      <div className="m-card">
        <div className="row"><Icon name="alert" size={16} /><strong><Link to={`/orders/${a.order_id}`}>{a.order_code}</Link> {a.state === 'overdue' ? `overdue ${a.days_late} day(s)` : a.forecast_date && a.original_date ? `expected ${Math.max(0, Math.round((Date.parse(a.forecast_date) - Date.parse(a.original_date)) / 86400000))} days late` : 'issue reported'}</strong></div>
        <dl className="facts small">
          <dt>Product</dt><dd>{a.product}</dd>
          <dt>Reason</dt><dd>{a.reason ? `${a.reason}${a.note ? ` — ${a.note}` : ''}` : 'Not recorded'}</dd>
          <dt>Promise</dt><dd>{date(a.original_date)} → {a.estimate_unknown ? 'estimate unknown' : date(a.forecast_date)}{a.agreed_date ? ` (agreed ${date(a.agreed_date)})` : ''}</dd>
          <dt>Customer informed</dt><dd><CommBadge state={a.communication.state} size="sm" /></dd>
          <dt>Next action</dt><dd>{a.next_action ? <>{a.next_action.purpose} · {a.next_action.owner_name} <DueBadge task={a.next_action} /></> : <Badge size="sm" tone="red">None</Badge>}</dd>
        </dl>
        {can('orders.update') && <Button size="sm" variant="cta" onClick={onRecord}>Record update</Button>}
      </div>
    );
  }
  if (a.type === 'payment_hold') return <div className="m-card"><strong>Payment hold — <Link to={`/orders/${a.order_id}`}>{a.order_code}</Link></strong><span className="small">{a.reason}</span></div>;
  if (a.type === 'complaint') return <div className="m-card"><strong>Open complaint <Link to={`/complaints/${a.complaint_id}`}>{a.code}</Link></strong><span className="small">{a.reason} · since {date(a.since)}</span></div>;
  if (a.type === 'followup_overdue') return <div className="m-card"><strong>{a.count} overdue follow-up(s)</strong></div>;
  return null;
}

function OrdersTab({ customerId }) {
  const { data } = useApi('/orders', { customer_id: customerId, view: 'all' });
  if (!data) return <Spinner />;
  return (
    <Card flush title="All orders" sub="separate outcomes — confirmed, active, dispatched, cancelled">
      <DataTable rows={data.rows} onRowClick={(o) => window.location.assign(`/orders/${o.id}`)} columns={[
        { key: 'code', label: 'Order', render: (o) => <Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link> },
        { key: 'received', label: 'Received', render: (o) => date(o.received_date, { year: true }) },
        { key: 'lines', label: 'Lines', render: (o) => o.lines.map((l) => <div key={l.id} className="small">{qty(l.quantities.confirmed)} × {l.product} · promised {date(l.original_commitment_date)}</div>) },
        { key: 'status', label: 'Outcome', render: (o) => (o.status === 'draft' ? <Badge>Draft</Badge> : <OutcomeBadges outcome={o.outcome} size="sm" />) },
        { key: 'state', label: 'Delay', render: (o) => (o.active ? (o.overdue ? <LineStateBadge state="overdue" size="sm" /> : o.at_risk ? <LineStateBadge state="at_risk" size="sm" /> : <LineStateBadge state="on_track" size="sm" />) : null) },
      ]} />
    </Card>
  );
}

function ActivitiesTab({ customerId }) {
  const [filter, setFilter] = useState('all');
  const { data } = useApi(`/customers/${customerId}/timeline`, { filter });
  return (
    <Card title="Complete history" sub="newest first, assembled from linked records">
      <Chips value={filter} onChange={setFilter} options={TIMELINE_FILTERS} />
      <div className="mt-16">{data ? <Timeline items={data} /> : <Spinner />}</div>
    </Card>
  );
}

function TasksTab({ customerId }) {
  const { data } = useApi(`/customers/${customerId}/tasks`);
  if (!data) return <Spinner />;
  return (
    <Card flush>
      <DataTable rows={data} columns={[
        { key: 'purpose', label: 'Task', render: (t) => <>{t.purpose}<div className="sub">{t.kind === 'internal' ? 'Internal action' : 'Customer contact'}{t.enquiry_code ? ` · ${t.enquiry_code}` : ''}{t.order_code ? ` · ${t.order_code}` : ''}</div></> },
        { key: 'owner', label: 'Owner', render: (t) => t.owner_name },
        { key: 'due', label: 'Due', render: (t) => (t.status === 'open' ? <DueBadge task={t} /> : date(t.due_date)) },
        { key: 'status', label: 'Status', render: (t) => (t.status === 'open' ? <Badge tone="blue">Open</Badge> : t.status === 'done' ? <Badge tone={t.completed_late ? 'amber' : 'green'}>{t.completed_late ? 'Done late' : 'Done'}</Badge> : <Badge>Cancelled{t.cancel_reason ? `: ${t.cancel_reason}` : ''}</Badge>) },
        { key: 'resched', label: 'Rescheduled', render: (t) => (t.reschedule_count ? `${t.reschedule_count}× (originally ${date(t.original_due_date)})` : '—') },
      ]} />
    </Card>
  );
}

function PaymentsTab({ payment, customerId }) {
  const { data } = useApi('/finance/invoices', { customer_id: customerId });
  if (!payment.has_data) return <Notice tone="info">No invoice data recorded for this customer — this is unknown, not zero outstanding.</Notice>;
  return (
    <Card flush title="Invoices" sub="operational mirror of the accounting system">
      <div className="card-body small">Outstanding: {moneyByCurrency(payment.outstanding_by_currency)} · Overdue: {moneyByCurrency(payment.overdue_by_currency)}{payment.broken_promises ? ` · ${payment.broken_promises} broken payment promise(s)` : ''}</div>
      {data && <DataTable rows={data.rows} columns={[
        { key: 'ref', label: 'Invoice', render: (i) => <Link to={`/payments?invoice=${i.id}`}>{i.invoice_ref}</Link> }, { key: 'date', label: 'Date', render: (i) => date(i.invoice_date) },
        { key: 'due', label: 'Due', render: (i) => date(i.due_date) }, { key: 'gross', label: 'Amount', align: 'num', render: (i) => <Money minor={i.gross_minor} currency={i.currency} /> },
        { key: 'out', label: 'Outstanding', align: 'num', render: (i) => <Money minor={i.outstanding_minor} currency={i.currency} /> },
        { key: 'state', label: 'State', render: (i) => <Badge tone={i.state === 'overdue' ? 'red' : i.state === 'paid' ? 'green' : 'slate'}>{i.state.replace('_', ' ')}</Badge> },
      ]} />}
    </Card>
  );
}

function ComplaintsTab({ customerId }) {
  const { data } = useApi('/complaints', { customer_id: customerId });
  if (!data) return <Spinner />;
  return <Card flush><DataTable rows={data} columns={[
    { key: 'code', label: 'Complaint', render: (k) => <Link to={`/complaints/${k.id}`}>{k.code}</Link> }, { key: 'cat', label: 'Category', render: (k) => k.category },
    { key: 'product', label: 'Product', render: (k) => k.product || '—' }, { key: 'status', label: 'Status', render: (k) => <Badge tone={k.open ? 'amber' : 'green'}>{k.status_label}</Badge> },
    { key: 'received', label: 'Received', render: (k) => date(k.received_date) },
  ]} empty={<div className="empty small">No complaints recorded.</div>} /></Card>;
}

function DetailsTab({ data, onSaved, onAction }) {
  const { can } = useAuth();
  const c = data.customer;
  const save = useSave();
  const types = useOptions('customer_type');
  const meta = useMeta();
  const sources = useOptions('enquiry_source');
  const [f, setF] = useState({
    company_name: c.company_name, country_code: c.country_code, city: c.city || '', segment: c.segment || '', types: c.types, owner_id: c.owner_id, provisional: Boolean(c.provisional), external_account_id: c.external_account_id || '', preferred_channel: c.preferred_channel || '', notes: c.notes || '',
    state: c.state || '', pincode: c.pincode || '', region_id: c.region_id ? String(c.region_id) : '', industry: c.industry || '', value_category: c.value_category || '', gstin: c.gstin || '', website: c.website || '',
    billing_address: c.billing_address || '', shipping_address: c.shipping_address || '', acquisition_source: c.acquisition_source || '', campaign_id: c.campaign_id ? String(c.campaign_id) : '',
    payment_terms: c.payment_terms || '', payment_terms_days: c.payment_terms_days ?? '', credit_limit: c.credit_limit_minor ? fromMinor(c.credit_limit_minor) : '', credit_currency: c.credit_currency || 'INR',
    credit_hold: Boolean(c.credit_hold), credit_hold_reason: c.credit_hold_reason || '', tags: (c.tags || []).map((t) => t.name).join(', '), interests: (c.interests || []).map((i) => i.id),
  });
  const financeFull = can('finance.full');
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const edit = can('customers.edit') && !c.merged_into_id;
  return (
    <div className="split">
      <Card title="Company">
        <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
          const body = { ...f, version: c.version, region_id: f.region_id || null, campaign_id: f.campaign_id || null, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) };
          if (!financeFull) { delete body.credit_limit; delete body.credit_currency; }
          if (!can('finance.holds')) { delete body.credit_hold; delete body.credit_hold_reason; }
          await api.put(`/customers/${c.id}`, body); onSaved();
        }); }}>
          {save.conflict && <Notice tone="warn" title="Someone else saved changes first">Reload to see the latest values before saving again. <Button size="xs" onClick={() => window.location.reload()}>Reload</Button></Notice>}
          <div className="form-grid">
            <Field label="Company name" className="full" error={save.fields.company_name}><Input disabled={!edit} value={f.company_name} onChange={(e) => set({ company_name: e.target.value })} /></Field>
            <Field label="Country"><CountrySelect value={f.country_code} onChange={(v) => set({ country_code: v })} /></Field>
            <Field label="City"><Input disabled={!edit} value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="Domestic / export"><Select disabled={!edit} value={f.segment} onChange={(e) => set({ segment: e.target.value })} options={SEGMENTS} placeholder="Not classified" /></Field>
            <Field label="Owner"><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} /></Field>
            <Field label="Customer types" className="full"><div className="row wrap">{types.map((t) => <Checkbox key={t.value} label={t.label} checked={f.types.includes(t.value)} onChange={(v) => set({ types: v ? [...f.types, t.value] : f.types.filter((x) => x !== t.value) })} />)}</div></Field>
            <Field label="Accounting ID"><Input disabled={!edit} value={f.external_account_id} onChange={(e) => set({ external_account_id: e.target.value })} /></Field>
            <Field label="Preferred channel"><Select disabled={!edit} value={f.preferred_channel} onChange={(e) => set({ preferred_channel: e.target.value })} options={['phone', 'whatsapp', 'email']} placeholder="No preference" /></Field>
            <Field label="Notes" className="full"><Textarea disabled={!edit} rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
            <div className="form-section">Location & classification</div>
            <Field label="State"><Input disabled={!edit} value={f.state} onChange={(e) => set({ state: e.target.value })} /></Field>
            <Field label="PIN code" error={save.fields.pincode}><Input disabled={!edit} value={f.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Field>
            <Field label="Sales region" error={save.fields.region_id}><Select disabled={!edit} value={f.region_id} onChange={(e) => set({ region_id: e.target.value })} placeholder="From the state" options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} /></Field>
            <Field label="Industry"><Input disabled={!edit} value={f.industry} onChange={(e) => set({ industry: e.target.value })} list="profile-industries" /><datalist id="profile-industries">{INDUSTRIES.map((x) => <option key={x} value={x} />)}</datalist></Field>
            <Field label="Value category"><Select disabled={!edit} value={f.value_category} onChange={(e) => set({ value_category: e.target.value })} placeholder="Not classified" options={VALUE_CATEGORIES} /></Field>
            <Field label="How they found us"><Select disabled={!edit} value={f.acquisition_source} onChange={(e) => set({ acquisition_source: e.target.value })} placeholder="Not known" options={sources} /></Field>
            <Field label="Campaign"><Select disabled={!edit} value={f.campaign_id} onChange={(e) => set({ campaign_id: e.target.value })} placeholder="None" options={meta.campaigns.map((x) => ({ value: String(x.id), label: x.name }))} /></Field>
            <Field label="Website"><Input disabled={!edit} value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
            <Field label="Tags" className="full" hint="Comma separated"><Input disabled={!edit} value={f.tags} onChange={(e) => set({ tags: e.target.value })} /></Field>
            <Field label="Interested in" className="full"><div className="row wrap">{meta.categories.filter((x) => x.active || f.interests.includes(x.id)).map((x) => <Checkbox key={x.id} disabled={!edit} label={x.name} checked={f.interests.includes(x.id)} onChange={(v) => set({ interests: v ? [...f.interests, x.id] : f.interests.filter((i) => i !== x.id) })} />)}</div></Field>
            <div className="form-section">Billing & credit</div>
            <Field label="GSTIN" error={save.fields.gstin}><Input disabled={!edit} value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
            <Field label="Payment terms (days)" error={save.fields.payment_terms_days}><Input disabled={!edit} type="number" min={0} max={365} value={f.payment_terms_days} onChange={(e) => set({ payment_terms_days: e.target.value })} /></Field>
            <Field label="Payment terms" className="full"><Input disabled={!edit} value={f.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
            <Field label="Billing address" className="full"><Textarea disabled={!edit} rows={2} value={f.billing_address} onChange={(e) => set({ billing_address: e.target.value })} /></Field>
            <Field label="Shipping address" className="full"><Textarea disabled={!edit} rows={2} value={f.shipping_address} onChange={(e) => set({ shipping_address: e.target.value })} /></Field>
            {financeFull && <Field label="Credit limit" error={save.fields.credit_limit}><div className="row"><Input disabled={!edit} inputMode="decimal" value={f.credit_limit} onChange={(e) => set({ credit_limit: e.target.value })} /><Select disabled={!edit} value={f.credit_currency} onChange={(e) => set({ credit_currency: e.target.value })} options={CURRENCIES} style={{ width: 96 }} aria-label="Credit currency" /></div></Field>}
            {can('finance.holds') && <div className="full"><Checkbox label="Credit hold — new orders need clearance" checked={f.credit_hold} onChange={(v) => set({ credit_hold: v })} disabled={!edit} /></div>}
            {can('finance.holds') && f.credit_hold && <Field label="Credit hold reason" className="full" error={save.fields.credit_hold_reason}><Input disabled={!edit} value={f.credit_hold_reason} onChange={(e) => set({ credit_hold_reason: e.target.value })} /></Field>}
            <div className="full"><Checkbox label="Provisional record (company details to be confirmed before an order)" checked={f.provisional} onChange={(v) => set({ provisional: v })} disabled={!edit} /></div>
          </div>
          {edit && <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>}
        </form>
      </Card>
      <div className="stack">
        <Card title="Contacts" actions={edit && <Button size="sm" icon="plus" onClick={() => onAction({ type: 'contact' })}>Add</Button>}>
          <div className="stack-sm">
            {data.contacts.map((ct) => (
              <div key={ct.id} className="row between">
                <span className="small"><strong>{ct.name || 'Unnamed'}</strong>{ct.is_primary ? <Badge size="sm" tone="violet"> Primary</Badge> : null}{!ct.active ? <Badge size="sm"> Inactive</Badge> : null}<br />{[ct.role, ct.phone_raw, ct.email_raw].filter(Boolean).join(' · ') || 'No contact channel'}</span>
                {edit && <Button size="xs" variant="ghost" icon="edit" aria-label="Edit contact" onClick={() => onAction({ type: 'contact', contact: ct })} />}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Contact preference">
          {c.do_not_contact ? <Notice tone="warn" title="Do not contact">{c.dnc_reason} · {c.dnc_source} · {date(c.dnc_date)}. Outreach suggestions are suppressed; orders and history are unaffected.</Notice> : <div className="small muted">No restriction recorded.</div>}
          {edit && <Button size="sm" className="mt-8" onClick={() => onAction({ type: 'dnc' })}>{c.do_not_contact ? 'Clear do-not-contact' : 'Mark do-not-contact'}</Button>}
        </Card>
        <Card title="Identifiers & aliases">
          <div className="small stack-xs">
            <div>Code <strong>{c.code}</strong> (permanent)</div>
            {c.aliases.map((a, i) => <div key={i}>{a.kind.replace(/_/g, ' ')}: {a.alias}</div>)}
            {c.import_batch_id && <div className="muted">Imported (batch #{c.import_batch_id}, {c.source_confidence || 'imported'})</div>}
          </div>
          {can('customers.merge') && !c.merged_into_id && <Button size="sm" className="mt-8" icon="link" onClick={() => onAction({ type: 'merge' })}>Merge a duplicate into this customer</Button>}
        </Card>
      </div>
    </div>
  );
}

function MergeForm({ target, otherId, onSaved }) {
  const save = useSave();
  const [other, setOther] = useState(otherId ? { id: otherId } : null);
  const [reason, setReason] = useState('');
  const { data: preview } = useApi(other?.id ? `/customers/${other.id}` : null);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/customers/${target.id}/merge`, { source_id: other.id, reason }); onSaved(); }); }}>
      <Notice tone="warn">Every contact, enquiry, quotation, order, task, document and history item of the duplicate moves to <strong>{target.company_name}</strong>. Its name and code become search aliases. Nothing is deleted, and both profiles keep an audit trail.</Notice>
      <Field label="Duplicate customer"><Combobox value={other?.id} label={preview?.customer?.company_name || ''} load={async (q) => (await api.get('/customers', { q, pageSize: 10 })).rows.filter((r) => r.id !== target.id).map((r) => ({ value: r.id, label: r.company_name, sub: [r.code, r.city].join(' · ') }))} onChange={(o) => setOther({ id: o.value })} minChars={2} /></Field>
      {preview && <div className="small m-card">{preview.customer.code} · {preview.customer.city} · {preview.contacts.length} contact(s) · {preview.summary.orders.confirmed} order(s) · {preview.enquiries.length} enquiry(ies)</div>}
      <Field label="Reason" required error={save.fields.reason}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving} disabled={!other}>Merge</Button></div>
    </form>
  );
}

function DncForm({ customer, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ reason: '', source: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/customers/${customer.id}/do-not-contact`, { do_not_contact: !customer.do_not_contact, ...f }); onSaved(); }); }}>
      {!customer.do_not_contact && <>
        <Field label="Reason" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Field label="Source" optional hint="e.g. Email from customer, 12 Nov"><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></Field>
      </>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function ContactForm({ customerId, contact, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ name: contact?.name || '', role: contact?.role || '', contact_role: contact?.contact_role || '', phone: contact?.phone_raw || '', whatsapp: contact?.whatsapp_raw || '', email: contact?.email_raw || '', preferred_channel: contact?.preferred_channel || '', is_primary: Boolean(contact?.is_primary), active: contact ? Boolean(contact.active) : true });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { if (contact) await api.put(`/contacts/${contact.id}`, { ...f, version: contact.version }); else await api.post(`/customers/${customerId}/contacts`, f); onSaved(); }); }}>
      <Field label="Name" error={save.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Designation"><Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
      <Field label="Role in buying" optional><Select value={f.contact_role} onChange={(e) => setF({ ...f, contact_role: e.target.value })} placeholder="Not set" options={CONTACT_ROLES} /></Field>
      <Field label="Phone" error={save.fields.phone}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      <Field label="WhatsApp" optional hint="If different from the phone"><Input value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} inputMode="tel" /></Field>
      <Field label="Email" error={save.fields.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Prefers" optional><Select value={f.preferred_channel} onChange={(e) => setF({ ...f, preferred_channel: e.target.value })} placeholder="No preference" options={[{ value: 'phone', label: 'Phone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' }, { value: 'meeting', label: 'Meeting' }]} /></Field>
      <Checkbox label="Primary contact" checked={f.is_primary} onChange={(v) => setF({ ...f, is_primary: v })} />
      {contact && <Checkbox label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function NewTaskForm({ customerId, ownerId, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ purpose: '', due_date: '', owner_id: ownerId, kind: 'customer', customer_promise: false });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post('/tasks', { ...f, customer_id: customerId }); onSaved(); }); }}>
      <Field label="Next action" required error={save.fields.purpose}><Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      <Field label="Due" required error={save.fields.due_date}><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      <Field label="Owner" required><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <Checkbox label="Promise to the customer" checked={f.customer_promise} onChange={(v) => setF({ ...f, customer_promise: v })} />
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

export { dateTime, pct, COUNTRIES, ENQUIRY_STAGES };
