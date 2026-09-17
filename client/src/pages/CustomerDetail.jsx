import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CUSTOMER_TYPES, CUSTOMER_STATUSES, VALUE_CATEGORIES, LEAD_STAGES, LEAD_STATUSES, QUOTATION_STATUSES, ORDER_STAGES, CONTACT_ROLES,
  COMPLAINT_STATUSES, COMPLAINT_CATEGORIES, FOLLOWUP_TYPES, LEAD_SOURCES, PAYMENT_MODES, labelOf,
} from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inrCompact, inr, date, relativeDay, daysFromToday, number } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, ErrorState, KV, OptionBadge, PageHeader, Spinner, Tabs, Tags, Tile, EmptyState, useConfirm, useToast,
} from '../components/ui.jsx';
import { ContactActions, ContactForm, LogActivityModal, Timeline } from '../components/domain.jsx';
import { CustomerFormModal } from './Customers.jsx';
import { LeadFormModal } from './Leads.jsx';
import { PAYMENT_BADGE } from './Orders.jsx';

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: c, error, reload } = useApi(`/customers/${id}`);
  const [tab, setTab] = useState('overview');
  const timeline = useApi(tab === 'timeline' ? `/customers/${id}/timeline` : null);
  const [modal, setModal] = useState(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!c) return <Spinner />;
  const s = c.stats;
  const finance = can('payments.view');

  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'timeline', label: 'Timeline' },
    can('leads.view') && { key: 'leads', label: 'Leads', count: c.leads.length },
    can('quotations.view') && { key: 'quotations', label: 'Quotations', count: c.quotations.length },
    { key: 'orders', label: 'Orders', count: c.orders.length },
    finance && { key: 'payments', label: 'Payments', count: c.invoices.length },
    { key: 'complaints', label: 'Service', count: c.complaints.length },
  ];

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Customers', to: '/customers' }, { label: c.code }]}
        title={c.name}
        subtitle={<span className="row wrap" style={{ gap: 6 }}>
          <Badge>{labelOf(CUSTOMER_TYPES, c.customer_type)}</Badge>
          <OptionBadge list={CUSTOMER_STATUSES} value={c.status} />
          {c.dormant && <Badge color="amber" title="No order within the dormant period">Dormant</Badge>}
          <OptionBadge list={VALUE_CATEGORIES} value={c.value_category} />
          <span className="muted small">{[c.industry, c.city, c.state, c.region_name].filter(Boolean).join(' · ')}</span>
          <Tags tags={c.tags} />
        </span>}
        actions={(
          <>
            {can('activities.edit', 'leads.edit') && <Button icon="phone" onClick={() => setModal('log')}>Log interaction</Button>}
            {can('leads.edit') && <Button icon="leads" onClick={() => setModal('lead')}>New lead</Button>}
            {can('quotations.edit') && <Button icon="quotations" to={`/quotations/new?customer=${c.id}`}>New quotation</Button>}
            {can('complaints.edit') && <Button icon="complaints" to={`/complaints?new=1&customer=${c.id}`}>Register complaint</Button>}
            {can('customers.edit') && <Button icon="edit" onClick={() => setModal('edit')}>Edit</Button>}
          </>
        )}
      />
      {c.status === 'blocked' && <div className="error-box">This customer is blocked. New quotations cannot be issued until accounts unblock the account.</div>}

      <div className="tiles">
        {s.lifetime_value !== undefined && <Tile label="Lifetime order value" value={inrCompact(s.lifetime_value)} foot={`${s.order_count} orders · last ${c.last_order_date ? date(c.last_order_date) : 'never'}`} />}
        {s.open_pipeline !== undefined && can('leads.view') && <Tile label="Open pipeline" value={inrCompact(s.open_pipeline)} foot={`${c.open_leads} open · ${s.won_leads} won · ${s.lost_leads} lost`} />}
        {finance && <Tile label="Outstanding" value={inrCompact(s.outstanding)} foot={s.overdue > 1 ? <span className="danger-text">{inrCompact(s.overdue)} overdue</span> : 'Nothing overdue'} alert={s.overdue > 1} />}
        {finance && c.credit_limit !== undefined && <Tile label="Credit available" value={c.credit_limit ? inrCompact(s.credit_available) : '—'} foot={c.credit_limit ? `Limit ${inrCompact(c.credit_limit)} · ${c.payment_terms_days} days` : `${c.payment_terms_days} days credit`} alert={c.credit_limit && s.credit_available < 0} />}
        {finance && <Tile label="Avg. days to pay" value={s.avg_payment_days ? `${Math.round(s.avg_payment_days)} d` : '—'} foot="From invoice date" />}
        <Tile label="Open complaints" value={s.open_complaints} foot={`${c.complaints.length} total`} alert={s.open_complaints > 0} />
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
          <Card title="Company details">
            <KV items={[
              ['Customer code', c.code],
              ['GST number', c.gstin && <span className="mono">{c.gstin}</span>],
              ['Website', c.website],
              ['Billing address', c.billing_address],
              ['Shipping address', c.shipping_address],
              ['Location', [c.city, c.state, c.pincode, c.country].filter(Boolean).join(', ')],
              ['Region', c.region_name],
              ['Payment terms', [c.payment_terms, c.payment_terms_days !== undefined && `${c.payment_terms_days} credit days`].filter(Boolean).join(' · ')],
              c.credit_limit !== undefined && ['Credit limit', inr(c.credit_limit)],
              ['Assigned salesperson', c.owner_name],
              ['Source', [labelOf(LEAD_SOURCES, c.source), c.campaign_name].filter(Boolean).join(' · ')],
              ['Product interest', c.interests.map((i) => i.name).join(', ')],
              ['Notes', c.notes],
            ]} />
          </Card>
          <div className="stack">
            <Card title="Contact people" actions={can('customers.edit', 'activities.edit') && <Button size="sm" icon="plus" onClick={() => setModal({ contact: {} })}>Add</Button>} flush>
              {c.contacts.length ? c.contacts.map((ct) => (
                <div key={ct.id} className="action-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}><strong>{ct.name}</strong>{ct.is_primary ? <Badge size="sm" color="blue">Primary</Badge> : null}</div>
                    <div className="small muted truncate">{labelOf(CONTACT_ROLES, ct.contact_role)}{ct.designation ? ` · ${ct.designation}` : ''} · prefers {ct.preferred_channel}</div>
                    <div className="small truncate">{[ct.phone, ct.email].filter(Boolean).join(' · ')}</div>
                  </div>
                  <ContactActions phone={ct.phone} whatsapp={ct.whatsapp} email={ct.email} size="sm" />
                  {can('customers.edit') && <Button size="xs" variant="ghost" icon="edit" onClick={() => setModal({ contact: ct })} aria-label="Edit contact" />}
                  {can('customers.edit') && <Button size="xs" variant="ghost" icon="trash" aria-label="Delete contact" onClick={async () => {
                    if (!(await confirm({ title: 'Delete contact?', message: `${ct.name} will be removed from ${c.name}.`, danger: true, confirmLabel: 'Delete' }))) return;
                    await api.del(`/contacts/${ct.id}`).then(() => { toast.success('Contact deleted'); reload(); }, (err) => toast.error(err.message));
                  }} />}
                </div>
              )) : <EmptyState title="No contacts" message="Add the owner, purchase, technical, accounts and site contacts." />}
            </Card>
            <Card title="Pending follow-ups" flush>
              {c.followups.length ? c.followups.map((f) => (
                <div key={f.id} className="action-row">
                  <span className="grow small truncate">{f.title}<div className="tiny muted">{labelOf(FOLLOWUP_TYPES, f.type)} · {f.owner_name}</div></span>
                  <span className={`small nowrap ${daysFromToday(f.due_date) < 0 ? 'danger-text' : ''}`}>{relativeDay(f.due_date)}</span>
                </div>
              )) : <EmptyState icon="check" title="Nothing pending" />}
            </Card>
          </div>
        </div>
      )}

      {tab === 'timeline' && <Card title="Complete relationship timeline" sub="Calls, messages, requirements, samples, quotations, orders, production, dispatch, payments and service"><Timeline items={timeline.data} loading={timeline.loading} /></Card>}

      {tab === 'leads' && (
        <Card flush>
          <DataTable rows={c.leads} onRowClick={(l) => navigate(`/leads/${l.id}`)} columns={[
            { key: 'code', label: 'Lead', render: (l) => <><Link to={`/leads/${l.id}`} className="strong">{l.title}</Link><div className="tiny muted">{l.code} · {date(l.created_at)}</div></> },
            { key: 'stage', label: 'Stage', render: (l) => (l.status === 'open' ? <OptionBadge list={LEAD_STAGES} value={l.stage} /> : <OptionBadge list={LEAD_STATUSES} value={l.status} />) },
            { key: 'value', label: 'Value', align: 'num', render: (l) => inrCompact(l.estimated_value) },
            { key: 'next', label: 'Next action', render: (l) => (l.status === 'open' ? <span className="small">{l.next_action} · <span className={daysFromToday(l.next_follow_up_date) < 0 ? 'danger-text' : 'muted'}>{relativeDay(l.next_follow_up_date)}</span></span> : '—') },
            { key: 'owner', label: 'Owner', render: (l) => l.owner_name },
          ]} />
        </Card>
      )}

      {tab === 'quotations' && (
        <Card flush>
          <DataTable rows={c.quotations} onRowClick={(q) => navigate(`/quotations/${q.id}`)} columns={[
            { key: 'number', label: 'Quotation', render: (q) => <><Link to={`/quotations/${q.id}`} className="strong">{q.number}</Link> <span className="muted small">v{q.current_version}</span><div className="tiny muted truncate" style={{ maxWidth: 320 }}>{q.subject}</div></> },
            { key: 'status', label: 'Status', render: (q) => <OptionBadge list={QUOTATION_STATUSES} value={q.status} /> },
            { key: 'value', label: 'Grand total', align: 'num', render: (q) => inrCompact(q.grand_total) },
            { key: 'discount', label: 'Discount', align: 'num', render: (q) => `${number(q.discount_pct, 1)}%` },
            { key: 'sent', label: 'Sent', render: (q) => (q.sent_at ? date(q.sent_at) : '—') },
            { key: 'valid', label: 'Valid until', render: (q) => (q.valid_until ? date(q.valid_until) : '—') },
          ]} />
        </Card>
      )}

      {tab === 'orders' && (
        <Card flush>
          <DataTable rows={c.orders} onRowClick={(o) => navigate(`/orders/${o.id}`)} columns={[
            { key: 'number', label: 'Order', render: (o) => <><Link to={`/orders/${o.id}`} className="strong">{o.number}</Link><div className="tiny muted">PO {o.customer_po_number} · {date(o.order_date)}</div></> },
            { key: 'stage', label: 'Stage', render: (o) => <span className="row" style={{ gap: 4 }}><OptionBadge list={ORDER_STAGES} value={o.stage} />{o.is_delayed && <Badge color="red" size="sm">{o.delay_days}d late</Badge>}</span> },
            { key: 'value', label: 'Value', align: 'num', render: (o) => inrCompact(o.grand_total) },
            { key: 'delivery', label: 'Delivery', render: (o) => date(o.delivery_date) },
            finance && { key: 'pay', label: 'Payment', render: (o) => <Badge color={PAYMENT_BADGE[o.payment_status]?.[1]}>{PAYMENT_BADGE[o.payment_status]?.[0]}</Badge> },
            can('quotations.edit') && { key: 'repeat', label: '', render: (o) => <Button size="xs" icon="copy" onClick={async () => { const r = await api.post('/quotations/duplicate', { order_id: o.id }).catch((e) => toast.error(e.message)); if (r) navigate(`/quotations/${r.id}/edit`); }}>Repeat order</Button> },
          ]} />
        </Card>
      )}

      {tab === 'payments' && (
        <div className="grid grid-2">
          <Card title="Invoices" flush>
            <DataTable rows={c.invoices} compact columns={[
              { key: 'number', label: 'Invoice', render: (i) => <><strong>{i.number}</strong><div className="tiny muted">{i.order_number}</div></> },
              { key: 'date', label: 'Date', render: (i) => date(i.invoice_date) },
              { key: 'total', label: 'Total', align: 'num', render: (i) => inrCompact(i.total) },
              { key: 'balance', label: 'Balance', align: 'num', render: (i) => (i.balance > 1 ? <span className={i.due_date < new Date().toISOString().slice(0, 10) ? 'danger-text strong' : 'strong'}>{inrCompact(i.balance)}</span> : <Badge color="green" size="sm">Paid</Badge>) },
              { key: 'due', label: 'Due', render: (i) => <span className="small">{date(i.due_date)}</span> },
            ]} />
          </Card>
          <Card title="Payments received" flush>
            <DataTable rows={c.payments} compact columns={[
              { key: 'date', label: 'Date', render: (p) => date(p.payment_date) },
              { key: 'ref', label: 'Against', render: (p) => <span className="small">{p.invoice_number || p.order_number || 'On account'}<div className="tiny muted">{p.type === 'advance' ? 'Advance' : labelOf(PAYMENT_MODES, p.mode)}</div></span> },
              { key: 'amount', label: 'Amount', align: 'num', render: (p) => inrCompact(p.amount) },
              { key: 'tds', label: 'TDS / deductions', align: 'num', render: (p) => (p.tds_amount === undefined ? '—' : inrCompact((p.tds_amount || 0) + (p.other_deduction || 0))) },
            ]} />
          </Card>
        </div>
      )}

      {tab === 'complaints' && (
        <Card flush actions={can('complaints.edit') && <Button size="sm" to={`/complaints?new=1&customer=${c.id}`}>Register complaint</Button>}>
          <DataTable rows={c.complaints} onRowClick={(k) => navigate(`/complaints/${k.id}`)} columns={[
            { key: 'number', label: 'Complaint', render: (k) => <strong>{k.number}</strong> },
            { key: 'category', label: 'Issue', render: (k) => labelOf(COMPLAINT_CATEGORIES, k.category) },
            { key: 'product', label: 'Product', render: (k) => k.product_name },
            { key: 'status', label: 'Status', render: (k) => <OptionBadge list={COMPLAINT_STATUSES} value={k.status} /> },
            { key: 'created', label: 'Registered', render: (k) => date(k.created_at) },
            { key: 'resolved', label: 'Resolved', render: (k) => (k.resolved_at ? date(k.resolved_at) : '—') },
          ]} />
        </Card>
      )}

      <LogActivityModal open={modal === 'log'} onClose={() => setModal(null)} onSaved={reload} customerId={c.id} />
      <LeadFormModal open={modal === 'lead'} onClose={() => setModal(null)} onSaved={(lid) => navigate(`/leads/${lid}`)} defaults={{ customer_id: c.id, source: 'existing_customer' }} />
      <CustomerFormModal open={modal === 'edit'} onClose={() => setModal(null)} onSaved={reload} customer={c} />
      <ContactForm open={Boolean(modal?.contact)} onClose={() => setModal(null)} onSaved={reload} customerId={c.id} contact={modal?.contact?.id ? modal.contact : null} />
    </div>
  );
}
