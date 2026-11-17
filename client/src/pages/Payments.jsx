// Payments: an operational mirror of the accounting system — invoices, receipts (with TDS and deductions),
// credit notes, advances against orders, promises and holds. Not a ledger; a promise is not a receipt.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AGEING_BUCKETS, CURRENCIES, PAYMENT_MODES, RECEIPT_KINDS, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { compactMoney, date, money, monthLabel, todayLocal, downloadCsv } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, ErrorState, Field, Input, Modal, Notice, PageHeader, SaveStatus, SearchBox, Select, Spinner, Drawer, Tabs, Textarea, useToast, Segmented, EmptyState,
} from '../components/ui.jsx';
import { CustomerPicker, UserSelect, DateField } from '../components/domain.jsx';
import { ColumnChart } from '../components/charts.jsx';

const STATE_TONE = { overdue: 'red', paid: 'green', part_paid: 'amber', not_due: 'slate', overpaid: 'violet' };
const STATE_LABEL = { overdue: 'Overdue', paid: 'Paid', part_paid: 'Part paid', not_due: 'Not yet due', overpaid: 'Overpaid' };
const BUCKET_KEYS = ['current', 'd0_30', 'd31_60', 'd61_90', 'd90_plus'];

export default function Payments() {
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const [f, setF] = useUrlFilters({ tab: params.get('order_id') || params.get('invoice') ? 'invoices' : 'overview', state: 'open' });
  const [modal, setModal] = useState(null);
  const { data: overview, error, reload } = useApi('/finance/overview');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const asOf = overview?.as_of;
  return (
    <div className="stack">
      <PageHeader title="Payments & receivables" subtitle="An operational mirror of the accounting system — not a ledger. A promised payment is not a receipt."
        actions={<>
          {can('finance.edit') && asOf && <Button onClick={() => setModal('asof')}>Data as of {asOf.asOf ? date(asOf.asOf, { year: true }) : 'not set'}</Button>}
          {can('finance.edit') && <Button variant="cta" icon="plus" onClick={() => setModal('invoice')}>Record invoice</Button>}
        </>} />
      {asOf && <Notice tone={asOf.reconciliation === 'reconciled' ? 'success' : 'warn'}>Source: {asOf.source} · as of {asOf.asOf ? date(asOf.asOf, { year: true }) : 'not recorded'} · {asOf.reconciliation === 'reconciled' ? 'reconciled with accounts' : 'not yet reconciled'}. Customers with no invoice data show “unknown”, not zero.</Notice>}
      <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[
        { key: 'overview', label: 'Overview' },
        { key: 'invoices', label: 'Invoices' },
        { key: 'receipts', label: 'Receipts & credit notes' },
        { key: 'advances', label: 'Advances', count: overview?.advances_pending?.length || null },
      ]} />
      {f.tab === 'overview' && (overview ? <Overview o={overview} onOpenInvoices={(patch) => setF({ tab: 'invoices', ...patch })} /> : <Spinner />)}
      {f.tab === 'invoices' && <Invoices f={f} setF={setF} onChange={reload} />}
      {f.tab === 'receipts' && <Receipts onChange={reload} />}
      {f.tab === 'advances' && <Advances rows={overview?.advances_pending} onChange={reload} />}
      <Modal open={modal === 'invoice'} size="lg" onClose={() => setModal(null)} title="Record invoice" subtitle="As issued by the accounting system">
        {modal === 'invoice' && <InvoiceForm onSaved={() => { toast.success('Invoice recorded'); setModal(null); reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Modal>
      <Modal open={modal === 'asof'} size="sm" onClose={() => setModal(null)} title="Finance data status">
        {modal === 'asof' && <AsOfForm current={asOf} onSaved={() => { setModal(null); reload(); }} />}
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ o, onOpenInvoices }) {
  const inr = o.trend.filter((t) => t.currency === 'INR');
  const months = [...new Set(o.trend.map((t) => t.month))];
  return (
    <div className="stack">
      <div className="tiles">
        {o.totals.filter((t) => t.outstanding_minor > 0 || t.overpaid_minor > 0).map((t) => (
          <div key={t.currency} className="stat"><span className="k">{t.currency} outstanding</span><span className="v">{money(t.outstanding_minor, t.currency)}</span><span className="d">overdue {money(t.overdue_minor, t.currency)}{t.overpaid_minor ? ` · credit balances ${money(t.overpaid_minor, t.currency)}` : ''}</span></div>
        ))}
        <div className="stat"><span className="k">Collected this month</span><span className="v" style={{ fontSize: 18 }}>{o.collected_this_month.length ? o.collected_this_month.map((c) => compactMoney(c.amount_minor, c.currency)).join(' + ') : '—'}</span><span className="d">receipts and advances, net of TDS</span></div>
        <div className="stat"><span className="k">Due in the next 7 days</span><span className="v" style={{ fontSize: 18 }}>{o.due_this_week.length ? o.due_this_week.map((c) => compactMoney(c.amount_minor, c.currency)).join(' + ') : '—'}</span><span className="d">{o.broken_promises} broken payment promise{o.broken_promises === 1 ? '' : 's'}</span></div>
      </div>
      <Card title="Ageing" sub="outstanding by days past due, per currency" flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Currency</th>{AGEING_BUCKETS.map((b) => <th key={b.value} className="num">{b.label}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>{o.totals.filter((t) => t.outstanding_minor > 0).map((t) => (
              <tr key={t.currency}>
                <td><strong>{t.currency}</strong></td>
                {BUCKET_KEYS.map((k) => (
                  <td key={k} className="num">{t[`${k}_minor`] ? <button type="button" className={`btn link ${k === 'd90_plus' ? 'danger-text' : ''}`} onClick={() => onOpenInvoices({ state: 'open', bucket: k, currency: t.currency })}>{money(t[`${k}_minor`], t.currency)}</button> : <span className="muted">—</span>}</td>
                ))}
                <td className="num strong">{money(t.outstanding_minor, t.currency)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!o.totals.some((t) => t.outstanding_minor > 0) && <EmptyState title="Nothing outstanding" message={o.unknown_note} />}
      </Card>
      <div className="grid grid-2">
        <Card title="Customers with balances" sub="most overdue first" flush>
          <DataTable compact rows={o.customers} rowKey={(r) => `${r.customer_id}-${r.currency}`} columns={[
            { key: 'c', label: 'Customer', render: (r) => <Link to={`/customers/${r.customer_id}`}>{r.company_name}</Link> },
            { key: 'n', label: 'Invoices', align: 'num', render: (r) => r.invoices },
            { key: 'o', label: 'Outstanding', align: 'num', render: (r) => money(r.outstanding_minor, r.currency) },
            { key: 'd', label: 'Overdue', align: 'num', render: (r) => (r.overdue_minor ? <span className="danger-text">{money(r.overdue_minor, r.currency)}</span> : '—') },
            { key: 'old', label: 'Oldest due', render: (r) => date(r.oldest_due) },
          ]} empty={<div className="muted small" style={{ padding: 12 }}>No open balances.</div>} />
        </Card>
        <Card title="Collections" sub="last 12 months · INR">
          {months.length ? <ColumnChart data={months.map((m) => ({ month: m, v: inr.find((t) => t.month === m)?.amount_minor || 0 }))} x="month" xFormat={monthLabel} series={[{ key: 'v', label: 'Collected (INR)' }]} format="money:INR" /> : <div className="muted small">No receipts recorded yet.</div>}
          {o.trend.some((t) => t.currency !== 'INR') && <div className="tiny muted">Receipts in other currencies are listed on the Receipts tab.</div>}
        </Card>
      </div>
      {o.holds.length > 0 && (
        <Card title="Active payment holds" flush>
          <DataTable rows={o.holds} columns={[
            { key: 'order', label: 'Order', render: (h) => <Link to={`/orders/${h.order_id}`}>{h.order_code}</Link> }, { key: 'customer', label: 'Customer', render: (h) => h.company_name },
            { key: 'reason', label: 'Reason', render: (h) => h.reason }, { key: 'by', label: 'Authorised by', render: (h) => `${h.authorised_by_name || '—'} · ${date(h.held_at)}` },
          ]} />
        </Card>
      )}
      <div className="tiny muted">{o.unknown_note}</div>
    </div>
  );
}

// ------------------------------------------------------------------ invoices
function Invoices({ f, setF, onChange }) {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi('/finance/invoices', { state: f.state, bucket: f.bucket, currency: f.currency, q: f.q, order_id: params.get('order_id') || undefined, customer_id: params.get('customer_id') || undefined });
  const [open, setOpen] = useState(Number(params.get('invoice')) || null);
  const full = can('finance.full');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <Chips value={f.state} onChange={(v) => setF({ state: v })} options={[{ value: 'open', label: 'With balance' }, { value: 'overdue', label: 'Overdue' }, { value: 'broken', label: 'Broken promises' }, { value: 'paid', label: 'Paid' }, { value: 'overpaid', label: 'Overpaid' }, { value: 'all', label: 'All' }]} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setF({ q })} placeholder="Invoice, customer or order" />
        <Select aria-label="Ageing" value={f.bucket || ''} onChange={(e) => setF({ bucket: e.target.value })} placeholder="Any age" options={AGEING_BUCKETS} />
        <Select aria-label="Currency" value={f.currency || ''} onChange={(e) => setF({ currency: e.target.value })} placeholder="All currencies" options={CURRENCIES} />
        {params.get('order_id') && <Badge tone="violet">Filtered to one order</Badge>}
        <Button size="sm" icon="download" onClick={() => downloadCsv('invoices.csv', [
          { key: 'invoice_ref', label: 'Invoice' }, { key: 'company_name', label: 'Customer' }, { key: 'order_code', label: 'Order' }, { key: 'invoice_date', label: 'Invoice date' }, { key: 'due_date', label: 'Due' },
          { key: 'currency', label: 'Currency' }, { key: (i) => (i.gross_minor / 100).toFixed(2), label: 'Amount' }, { key: (i) => (i.outstanding_minor / 100).toFixed(2), label: 'Outstanding' }, { key: 'days_overdue', label: 'Days overdue' }, { key: 'state', label: 'State' },
        ], data?.rows || [])}>Export</Button>
      </div>
      <Card flush>
        <DataTable rows={data?.rows} loading={loading} onRowClick={(i) => setOpen(i.id)} columns={[
          { key: 'ref', label: 'Invoice', render: (i) => <div className="col" style={{ gap: 0 }}><strong>{i.invoice_ref}</strong><span className="tiny muted">{date(i.invoice_date)}</span></div> },
          { key: 'customer', label: 'Customer', render: (i) => <Link to={`/customers/${i.customer_id}`}>{i.company_name}</Link> },
          { key: 'order', label: 'Order', render: (i) => (i.order_id ? <Link to={`/orders/${i.order_id}`}>{i.order_code}</Link> : '—') },
          { key: 'due', label: 'Due', render: (i) => <span>{date(i.due_date, { year: true })}{i.days_overdue > 0 && <div className="tiny danger-text">{i.days_overdue} days overdue</div>}</span> },
          { key: 'gross', label: 'Amount', align: 'num', render: (i) => money(i.gross_minor, i.currency) },
          full && { key: 'tds', label: 'TDS / deductions', align: 'num', render: (i) => (i.tds_minor || i.other_deduction_minor ? <span className="small">{money((i.tds_minor || 0) + (i.other_deduction_minor || 0), i.currency)}</span> : '—') },
          { key: 'out', label: 'Outstanding', align: 'num', render: (i) => <strong>{money(i.outstanding_minor, i.currency)}</strong> },
          { key: 'state', label: 'State', render: (i) => <span className="row wrap" style={{ gap: 4 }}><Badge tone={STATE_TONE[i.state]}>{STATE_LABEL[i.state]}</Badge>{i.promise_broken && <Badge tone="red">Promise broken</Badge>}{i.promise_date && !i.promise_broken && i.outstanding_minor > 0 && <Badge tone="blue">Promised {date(i.promise_date)}</Badge>}</span> },
          { key: 'owner', label: 'Collection owner', render: (i) => <span className="small">{i.owner_name || '—'}</span> },
        ]} empty={<EmptyState icon="payment" title="No invoices here" message="Invoices are recorded as issued by the accounting system." />} />
      </Card>
      <Drawer open={Boolean(open)} onClose={() => setOpen(null)} title="Invoice">
        {open && <InvoiceDetail id={open} onChange={() => { reload(); onChange(); }} />}
      </Drawer>
    </div>
  );
}

function InvoiceDetail({ id, onChange }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data, reload } = useApi(`/finance/invoices/${id}`);
  const [mode, setMode] = useState(null);
  if (!data) return <Spinner />;
  const i = data.invoice;
  const full = can('finance.full');
  const refresh = () => {
    reload();
    onChange();
    setMode(null);
  };
  return (
    <div className="stack">
      <div><h2>{i.invoice_ref}</h2><div className="small muted">{i.company_name}{i.order_code ? ` · ${i.order_code}` : ''}{i.dispatch_code ? ` · dispatch ${i.dispatch_code}` : ''} · invoiced {date(i.invoice_date, { year: true })} · due {date(i.due_date, { year: true })}</div></div>
      <div className="grid grid-2">
        <div className="stat"><span className="k">Amount (incl. tax)</span><span className="v">{money(i.gross_minor, i.currency)}</span>{(i.taxable_minor || i.tax_minor) && <span className="d">taxable {money(i.taxable_minor, i.currency)} · tax {money(i.tax_minor, i.currency)}</span>}</div>
        <div className="stat"><span className="k">Outstanding</span><span className="v">{money(i.outstanding_minor, i.currency)}</span>{i.outstanding_minor < 0 && <span className="d">Overpaid — shown as a credit balance</span>}{i.advance_adjusted_minor > 0 && <span className="d">after {money(i.advance_adjusted_minor, i.currency)} advance adjusted</span>}</div>
      </div>
      {i.promise_date && <Notice tone={i.promise_date < todayLocal() && i.outstanding_minor > 0 ? 'danger' : 'info'}>Customer promised payment by {date(i.promise_date)}{i.promise_note ? ` — ${i.promise_note}` : ''}. A promise stays a follow-up until a receipt is recorded.</Notice>}
      <div>
        <h3 className="mb-8">Receipts & credit notes</h3>
        {!data.receipts.length && <div className="muted small">None recorded.</div>}
        {data.receipts.map((r) => (
          <div key={r.id} className="row between small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>
              {date(r.effective_date)} · <strong>{labelOf(RECEIPT_KINDS, r.kind)}</strong> {money(r.amount_minor, i.currency)}
              {full && r.tds_minor > 0 && <span className="muted"> + TDS {money(r.tds_minor, i.currency)}</span>}
              {full && r.other_deduction_minor > 0 && <span className="muted"> + deduction {money(r.other_deduction_minor, i.currency)}{r.deduction_note ? ` (${r.deduction_note})` : ''}</span>}
              {r.mode ? ` · ${labelOf(PAYMENT_MODES, r.mode)}` : ''}{r.reference ? ` · ${r.reference}` : ''}
              {r.reversed_at && <Badge size="sm" tone="red"> Reversed: {r.reversal_reason}</Badge>}
            </span>
            {!r.reversed_at && can('finance.edit') && <Button size="xs" variant="ghost" onClick={async () => { const reason = window.prompt('Reason for correcting this receipt:'); if (reason) { try { await api.post(`/finance/receipts/${r.id}/reverse`, { reason }); refresh(); } catch (e) { toast.error(e.message); } } }}>Correct</Button>}
          </div>
        ))}
      </div>
      <div className="row wrap">
        {can('finance.edit') && <Button variant="primary" onClick={() => setMode('receipt')}>Record receipt</Button>}
        {can('finance.edit') && <Button onClick={() => setMode('credit')}>Credit note</Button>}
        {(can('finance.edit') || can('orders.communicate')) && i.outstanding_minor > 0 && <Button onClick={() => setMode('promise')}>Record payment promise</Button>}
      </div>
      {(mode === 'receipt' || mode === 'credit') && <ReceiptForm key={mode} invoice={i} kind={mode} onSaved={refresh} />}
      {mode === 'promise' && <PromiseForm invoice={i} onSaved={refresh} />}
    </div>
  );
}

function ReceiptForm({ invoice, kind, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const [f, setF] = useState({ amount: '', tds_amount: '', other_deduction: '', deduction_note: '', mode: 'neft', effective_date: todayLocal(), reference: '', note: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const credit = kind === 'credit';
  return (
    <form className="stack-sm card" style={{ padding: 14 }} onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/finance/invoices/${invoice.id}/receipts`, { ...f, kind }); onSaved(); }); }}>
      <div className="strong">{credit ? 'Credit note / adjustment' : 'Receipt'}</div>
      <div className="form-grid">
        <Field label={`${credit ? 'Credit amount' : 'Amount received'} (${invoice.currency})`} required error={save.fields.amount}><Input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
        <Field label="Effective date" required error={save.fields.effective_date}><Input type="date" max={todayLocal()} value={f.effective_date} onChange={(e) => set({ effective_date: e.target.value })} /></Field>
        {!credit && can('finance.full') && <Field label="TDS deducted" optional error={save.fields.tds_amount} hint="Counts towards settling the invoice"><Input inputMode="decimal" value={f.tds_amount} onChange={(e) => set({ tds_amount: e.target.value })} /></Field>}
        {!credit && can('finance.full') && <Field label="Other deduction" optional error={save.fields.other_deduction}><Input inputMode="decimal" value={f.other_deduction} onChange={(e) => set({ other_deduction: e.target.value })} /></Field>}
        {!credit && f.other_deduction && <Field label="Why was it deducted?" required className="full" error={save.fields.deduction_note}><Input value={f.deduction_note} onChange={(e) => set({ deduction_note: e.target.value })} placeholder="e.g. Bank charges, LD for late delivery" /></Field>}
        {!credit && <Field label="Mode" error={save.fields.mode}><Select value={f.mode} onChange={(e) => set({ mode: e.target.value })} options={PAYMENT_MODES} /></Field>}
        <Field label={credit ? 'Credit note number' : 'Bank / UTR reference'} required={credit} optional={!credit} error={save.fields.reference}><Input value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
        <Field label={credit ? 'Reason for the credit note' : 'Note'} required={credit} optional={!credit} className="full" error={save.fields.note}><Input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function PromiseForm({ invoice, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ promise_date: '', note: '' });
  return (
    <form className="stack-sm card" style={{ padding: 14 }} onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/finance/invoices/${invoice.id}/promise`, f); onSaved(); }); }}>
      <DateField label="Customer promised payment by" required value={f.promise_date} onChange={(v) => setF({ ...f, promise_date: v })} error={save.fields.promise_date} />
      <Field label="Note" optional><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save promise & set check</Button></div>
    </form>
  );
}

function InvoiceForm({ onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ customer: null, invoice_ref: '', order_id: '', dispatch_id: '', invoice_date: todayLocal(), due_date: '', currency: 'INR', taxable_amount: '', tax_amount: '', gross_amount: '', advance_adjusted: '', owner_id: null, external_ref: '', notes: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const { data: orders } = useApi(f.customer ? '/orders' : null, { customer_id: f.customer?.id, view: 'all' });
  const { data: dispatches } = useApi(f.customer ? '/dispatches' : null, { customer_id: f.customer?.id });
  const order = (orders?.rows || []).find((o) => String(o.id) === f.order_id);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post('/finance/invoices', { ...f, customer_id: f.customer?.id, order_id: f.order_id || undefined, dispatch_id: f.dispatch_id || undefined }); onSaved(); }); }}>
      <Field label="Customer" required error={save.fields.customer_id}><CustomerPicker value={f.customer} onChange={(c) => set({ customer: c, order_id: '', dispatch_id: '' })} allowCreate={false} onNewCustomer={() => {}} /></Field>
      <div className="form-grid">
        <Field label="Invoice reference" required error={save.fields.invoice_ref}><Input value={f.invoice_ref} onChange={(e) => set({ invoice_ref: e.target.value })} /></Field>
        <Field label="Order" optional error={save.fields.order_id}><Select value={f.order_id} onChange={(e) => { const o = (orders?.rows || []).find((x) => String(x.id) === e.target.value); set({ order_id: e.target.value, currency: o?.currency || f.currency }); }} options={(orders?.rows || []).map((o) => ({ value: String(o.id), label: `${o.code}${o.po_reference ? ` · PO ${o.po_reference}` : ''}` }))} placeholder="Not linked" /></Field>
        <Field label="Dispatch" optional error={save.fields.dispatch_id}><Select value={f.dispatch_id} onChange={(e) => set({ dispatch_id: e.target.value })} options={(dispatches?.rows || []).filter((d) => d.status === 'posted').map((d) => ({ value: String(d.id), label: `${d.code} · ${date(d.dispatch_date)}` }))} placeholder="Not linked" /></Field>
        <Field label="Currency" required error={save.fields.currency}><Select value={f.currency} onChange={(e) => set({ currency: e.target.value })} options={CURRENCIES} /></Field>
        <Field label="Invoice date" required error={save.fields.invoice_date}><Input type="date" value={f.invoice_date} onChange={(e) => set({ invoice_date: e.target.value })} /></Field>
        <Field label="Due date" required error={save.fields.due_date}><Input type="date" value={f.due_date} onChange={(e) => set({ due_date: e.target.value })} /></Field>
        <Field label="Taxable value" optional error={save.fields.taxable_amount}><Input inputMode="decimal" value={f.taxable_amount} onChange={(e) => set({ taxable_amount: e.target.value })} /></Field>
        <Field label="GST / tax" optional error={save.fields.tax_amount}><Input inputMode="decimal" value={f.tax_amount} onChange={(e) => set({ tax_amount: e.target.value })} /></Field>
        <Field label="Invoice total (incl. tax)" required error={save.fields.gross_amount}><Input inputMode="decimal" value={f.gross_amount} onChange={(e) => set({ gross_amount: e.target.value })} /></Field>
        {order && <Field label="Advance adjusted" optional error={save.fields.advance_adjusted} hint="Advance already received against this order"><Input inputMode="decimal" value={f.advance_adjusted} onChange={(e) => set({ advance_adjusted: e.target.value })} /></Field>}
        <Field label="Collection owner" optional><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['accounts', 'admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
        <Field label="Accounting reference" optional><Input value={f.external_ref} onChange={(e) => set({ external_ref: e.target.value })} /></Field>
        <Field label="Notes" optional className="full"><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Record invoice</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ receipts register
function Receipts({ onChange }) {
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState({ kind: '', from: '', to: '' });
  const { data, error, loading, reload } = useApi('/finance/receipts', q);
  const full = can('finance.full');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <div className="filter-bar">
        <Segmented label="Kind" value={q.kind} onChange={(kind) => setQ({ ...q, kind })} options={[{ value: '', label: 'All' }, ...RECEIPT_KINDS]} />
        <input type="date" className="input" aria-label="From" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} style={{ width: 'auto' }} />
        <input type="date" className="input" aria-label="To" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} style={{ width: 'auto' }} />
        <Button size="sm" icon="download" onClick={() => downloadCsv('receipts.csv', [
          { key: 'effective_date', label: 'Date' }, { key: 'kind', label: 'Kind' }, { key: 'company_name', label: 'Customer' }, { key: 'invoice_ref', label: 'Invoice' }, { key: 'order_code', label: 'Order' },
          { key: 'currency', label: 'Currency' }, { key: (r) => (r.amount_minor / 100).toFixed(2), label: 'Amount' }, ...(full ? [{ key: (r) => ((r.tds_minor || 0) / 100).toFixed(2), label: 'TDS' }, { key: (r) => ((r.other_deduction_minor || 0) / 100).toFixed(2), label: 'Other deduction' }] : []),
          { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference' }, { key: 'reversed_at', label: 'Reversed' },
        ], data || [])}>Export</Button>
      </div>
      <Card flush>
        <DataTable rows={data} loading={loading} columns={[
          { key: 'd', label: 'Date', render: (r) => date(r.effective_date, { year: true }) },
          { key: 'k', label: 'Kind', render: (r) => <Badge size="sm" tone={r.kind === 'credit' ? 'violet' : r.kind === 'advance' ? 'blue' : 'green'}>{labelOf(RECEIPT_KINDS, r.kind)}</Badge> },
          { key: 'c', label: 'Customer', render: (r) => <Link to={`/customers/${r.customer_id}`}>{r.company_name}</Link> },
          { key: 'ref', label: 'Against', render: (r) => <span className="small">{r.invoice_ref ? `Invoice ${r.invoice_ref}` : r.order_code ? <Link to={`/orders/${r.order_id}`}>{r.order_code}</Link> : '—'}</span> },
          { key: 'a', label: 'Amount', align: 'num', render: (r) => money(r.amount_minor, r.currency) },
          full && { key: 't', label: 'TDS / deductions', align: 'num', render: (r) => ((r.tds_minor || 0) + (r.other_deduction_minor || 0) ? money((r.tds_minor || 0) + (r.other_deduction_minor || 0), r.currency) : '—') },
          { key: 'm', label: 'Mode / reference', render: (r) => <span className="small">{[labelOf(PAYMENT_MODES, r.mode), r.reference].filter(Boolean).join(' · ') || '—'}</span> },
          { key: 's', label: '', render: (r) => (r.reversed_at ? <Badge size="sm" tone="red" title={r.reversal_reason}>Reversed</Badge> : can('finance.edit') ? <Button size="xs" variant="ghost" onClick={async () => { const reason = window.prompt('Reason for correcting this entry:'); if (reason) { try { await api.post(`/finance/receipts/${r.id}/reverse`, { reason }); reload(); onChange(); } catch (e) { toast.error(e.message); } } }}>Correct</Button> : null) },
        ]} empty={<EmptyState icon="payment" title="No receipts in this range" />} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ advances
function Advances({ rows, onChange }) {
  const { can } = useAuth();
  const [recording, setRecording] = useState(null);
  return (
    <div className="stack">
      <Card title="Advances not yet received in full" sub="confirmed orders with a required advance" flush>
        <DataTable rows={rows} columns={[
          { key: 'o', label: 'Order', render: (o) => <Link to={`/orders/${o.id}`} className="strong">{o.code}</Link> },
          { key: 'c', label: 'Customer', render: (o) => <Link to={`/customers/${o.customer_id}`}>{o.company_name}</Link> },
          { key: 'r', label: 'Required', align: 'num', render: (o) => <span>{money(o.advance_required_minor, o.currency)}{o.advance_pct ? <div className="tiny muted">{o.advance_pct}%</div> : null}</span> },
          { key: 'g', label: 'Received', align: 'num', render: (o) => money(o.advance_received_minor, o.currency) },
          { key: 'b', label: 'Balance', align: 'num', render: (o) => <strong className="warning-text">{money(o.advance_required_minor - o.advance_received_minor, o.currency)}</strong> },
          { key: 'h', label: '', render: (o) => <span className="row" style={{ gap: 4 }}>{o.on_hold ? <Badge size="sm" tone="red">On hold</Badge> : null}{can('finance.edit') && <Button size="xs" variant="primary" onClick={() => setRecording(o)}>Record advance</Button>}</span> },
        ]} empty={<EmptyState icon="check" title="No pending advances" message="Every order with a required advance has received it." />} />
      </Card>
      <Modal open={Boolean(recording)} size="sm" onClose={() => setRecording(null)} title={`Advance for ${recording?.code}`} subtitle={recording?.company_name}>
        {recording && <AdvanceForm order={recording} onSaved={() => { setRecording(null); onChange(); }} />}
      </Modal>
    </div>
  );
}

export function AdvanceForm({ order, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const [f, setF] = useState({ amount: '', tds_amount: '', mode: 'neft', effective_date: todayLocal(), reference: '', note: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/finance/orders/${order.id}/advances`, f); onSaved(); }); }}>
      <div className="form-grid">
        <Field label={`Amount received (${order.currency})`} required error={save.fields.amount}><Input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></Field>
        <Field label="Date received" required error={save.fields.effective_date}><Input type="date" max={todayLocal()} value={f.effective_date} onChange={(e) => set({ effective_date: e.target.value })} /></Field>
        {can('finance.full') && <Field label="TDS deducted" optional error={save.fields.tds_amount}><Input inputMode="decimal" value={f.tds_amount} onChange={(e) => set({ tds_amount: e.target.value })} /></Field>}
        <Field label="Mode"><Select value={f.mode} onChange={(e) => set({ mode: e.target.value })} options={PAYMENT_MODES} /></Field>
        <Field label="Bank / UTR reference" optional className="full"><Input value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
      </div>
      <div className="small muted">Recording an advance does not release a payment hold — release it on the order with the evidence.</div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Record advance</Button></div>
    </form>
  );
}

function AsOfForm({ current, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ as_of: current.asOf || todayLocal(), reconciliation: current.reconciliation, source: current.source });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put('/finance/as-of', f); onSaved(); }); }}>
      <Field label="Data as of" required><Input type="date" value={f.as_of} onChange={(e) => setF({ ...f, as_of: e.target.value })} /></Field>
      <Field label="Reconciliation"><Select value={f.reconciliation} onChange={(e) => setF({ ...f, reconciliation: e.target.value })} options={[{ value: 'not_reconciled', label: 'Not reconciled' }, { value: 'reconciled', label: 'Reconciled with accounts' }]} /></Field>
      <Field label="Source"><Input value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}
