import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PAYMENT_MODES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inr, inrCompact, date, number, todayStr, downloadCsv, monthLabel } from '../lib/format.js';
import { Badge, Button, Card, DataTable, Field, Input, Modal, PageHeader, SearchBox, Select, Spinner, Tabs, Textarea, Tile, useToast, EmptyState } from '../components/ui.jsx';
import { BarChartH, LineChart } from '../components/charts.jsx';
import { LogActivityModal } from '../components/domain.jsx';

export default function Payments() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setFilter] = useUrlFilters({ tab: 'outstanding' });
  const overview = useApi('/payments/overview');
  const invoices = useApi(f.tab === 'invoices' ? '/invoices' : null, { status: f.status || 'outstanding', q: f.q, customer_id: f.customer });
  const receipts = useApi(f.tab === 'receipts' ? '/payments' : null, { q: f.q, from: f.from, to: f.to });
  const creditNotes = useApi(f.tab === 'credit' && can('finance.full') ? '/credit-notes' : null);
  const [payFor, setPayFor] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [creditFor, setCreditFor] = useState(null);

  const d = overview.data;
  if (!d) return <Spinner />;
  const customers = f.customer ? d.customers.filter((c) => String(c.customer_id) === String(f.customer)) : d.customers;

  return (
    <div className="stack">
      <PageHeader title="Payments & outstanding" subtitle="Receivables, ageing and collection follow-ups shared by accounts and sales"
        actions={can('payments.edit') && <Button variant="primary" icon="rupee" onClick={() => setPayFor({})}>Record payment</Button>} />

      <div className="tiles">
        <Tile label="Total outstanding" value={inrCompact(d.outstanding)} foot={`${d.customers.length} customers`} />
        <Tile label="Overdue" value={inrCompact(d.overdue)} alert={d.overdue > 0} foot="Past due date" />
        <Tile label="Due this week" value={inrCompact(d.due_this_week)} />
        <Tile label="Collected this month" value={inrCompact(d.collected_this_month)} />
        <Tile label="Advances pending" value={inrCompact(d.advances_pending.reduce((s, o) => s + (o.advance_required - o.advance_received), 0))} foot={`${d.advances_pending.length} orders`} alert={d.advances_pending.length > 0} />
      </div>

      <div className="grid grid-2">
        <Card title="Ageing" sub="Outstanding by invoice age">
          <BarChartH label="bucket" format="currency" series={[{ key: 'value', label: 'Outstanding' }]} data={[
            { bucket: '0–30 days', value: d.buckets.d0_30 }, { bucket: '31–60 days', value: d.buckets.d31_60 },
            { bucket: '61–90 days', value: d.buckets.d61_90 }, { bucket: '90+ days', value: d.buckets.d90_plus },
          ]} />
        </Card>
        <Card title="Collections trend" sub="Payments received per month">
          <LineChart data={d.trend} x="month" xFormat={monthLabel} format="currency" series={[{ key: 'received', label: 'Collected' }]} height={200} />
        </Card>
      </div>

      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[
        { key: 'outstanding', label: 'Outstanding by customer', count: d.customers.length },
        { key: 'invoices', label: 'Invoices' },
        { key: 'receipts', label: 'Payments received' },
        { key: 'advances', label: 'Advances pending', count: d.advances_pending.length },
        can('finance.full') && { key: 'credit', label: 'Credit notes' },
      ]} />

      {f.tab === 'outstanding' && (
        <Card flush actions={<Button size="sm" icon="download" onClick={() => downloadCsv('outstanding.csv', [
          { key: 'customer_name', label: 'Customer' }, { key: 'owner_name', label: 'Owner' }, { key: 'invoices', label: 'Invoices' },
          { key: 'd0_30', label: '0-30' }, { key: 'd31_60', label: '31-60' }, { key: 'd61_90', label: '61-90' }, { key: 'd90_plus', label: '90+' },
          { key: 'balance', label: 'Total' }, { key: 'overdue', label: 'Overdue' }, { key: 'oldest_due', label: 'Oldest due date' },
        ], d.customers)}>Export</Button>}>
          <DataTable rows={customers} columns={[
            { key: 'customer', label: 'Customer', render: (c) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${c.customer_id}`} className="strong">{c.customer_name}</Link><span className="tiny muted">{c.customer_code} · {c.owner_name}</span></div> },
            { key: 'invoices', label: 'Invoices', align: 'num', render: (c) => c.invoices },
            { key: 'd0_30', label: '0–30', align: 'num', render: (c) => (c.d0_30 ? inrCompact(c.d0_30) : '—') },
            { key: 'd31_60', label: '31–60', align: 'num', render: (c) => (c.d31_60 ? inrCompact(c.d31_60) : '—') },
            { key: 'd61_90', label: '61–90', align: 'num', render: (c) => (c.d61_90 ? inrCompact(c.d61_90) : '—') },
            { key: 'd90_plus', label: '90+', align: 'num', render: (c) => (c.d90_plus ? <span className="danger-text strong">{inrCompact(c.d90_plus)}</span> : '—') },
            { key: 'balance', label: 'Total', align: 'num', render: (c) => <strong>{inr(c.balance)}</strong> },
            { key: 'overdue', label: 'Overdue', align: 'num', render: (c) => (c.overdue > 1 ? <span className="danger-text">{inr(c.overdue)}</span> : '—') },
            { key: 'oldest', label: 'Oldest due', render: (c) => <span className="small">{date(c.oldest_due)}</span> },
            { key: 'act', label: '', render: (c) => (
              <div className="row">
                <Button size="xs" onClick={() => setFilter({ tab: 'invoices', customer: c.customer_id })}>Invoices</Button>
                <Button size="xs" variant="ghost" icon="phone" title="Log collection call" onClick={() => setLogFor(c.customer_id)} />
              </div>
            ) },
          ]} />
        </Card>
      )}

      {f.tab === 'invoices' && (
        <>
          <div className="filter-bar">
            <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Invoice, customer, order" />
            <Select className="sm" value={f.status || 'outstanding'} onChange={(e) => setFilter({ status: e.target.value })} options={[
              { value: 'outstanding', label: 'Outstanding' }, { value: 'overdue', label: 'Overdue only' }, { value: 'paid', label: 'Settled' }, { value: '', label: 'All invoices' },
            ]} />
            {f.customer && <Button size="sm" onClick={() => setFilter({ customer: '' })}>Clear customer filter</Button>}
          </div>
          <Card flush>
            <DataTable rows={invoices.data} loading={invoices.loading} columns={[
              { key: 'number', label: 'Invoice', render: (i) => <div className="col" style={{ gap: 0 }}><strong>{i.number}</strong><span className="tiny muted">{date(i.invoice_date)} · {i.age_days} days old</span></div> },
              { key: 'customer', label: 'Customer', render: (i) => <Link to={`/customers/${i.customer_id}`}>{i.customer_name}</Link> },
              { key: 'order', label: 'Order', render: (i) => (i.order_id ? <Link to={`/orders/${i.order_id}`}>{i.order_number}</Link> : '—') },
              { key: 'total', label: 'Invoice value', align: 'num', render: (i) => inr(i.total) },
              { key: 'adj', label: 'Advance adj.', align: 'num', render: (i) => (i.advance_adjusted ? inr(i.advance_adjusted) : '—') },
              { key: 'paid', label: 'Received', align: 'num', render: (i) => inr(i.paid) },
              { key: 'balance', label: 'Balance', align: 'num', render: (i) => (i.balance > 1 ? <strong className={i.due_date < todayStr() ? 'danger-text' : ''}>{inr(i.balance)}</strong> : <Badge color="green" size="sm">Settled</Badge>) },
              { key: 'due', label: 'Due date', render: (i) => <div className="col small" style={{ gap: 0 }}><span>{date(i.due_date)}</span>{i.balance > 1 && i.days_overdue > 0 && <span className="tiny danger-text">{i.days_overdue} days overdue</span>}</div> },
              { key: 'contact', label: 'Last collection contact', render: (i) => <span className="small muted">{i.last_collection_contact ? date(i.last_collection_contact) : '—'}</span> },
              can('payments.edit') && { key: 'act', label: '', render: (i) => (i.balance > 1 ? (
                <div className="row">
                  <Button size="xs" onClick={() => setPayFor({ invoice: i })}>Receive</Button>
                  {can('finance.full') && <Button size="xs" variant="ghost" onClick={() => setCreditFor(i)}>Credit note</Button>}
                </div>
              ) : null) },
            ]} />
          </Card>
        </>
      )}

      {f.tab === 'receipts' && (
        <>
          <div className="filter-bar">
            <span className="small muted">From</span><Input type="date" className="sm" style={{ width: 150 }} value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
            <span className="small muted">to</span><Input type="date" className="sm" style={{ width: 150 }} value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
          </div>
          <Card flush>
            <DataTable rows={receipts.data} loading={receipts.loading} columns={[
              { key: 'date', label: 'Date', render: (p) => date(p.payment_date) },
              { key: 'customer', label: 'Customer', render: (p) => <Link to={`/customers/${p.customer_id}`}>{p.customer_name}</Link> },
              { key: 'against', label: 'Against', render: (p) => <span className="small">{p.invoice_number || p.order_number || 'On account'}<div className="tiny muted">{p.type === 'advance' ? 'Advance' : p.type === 'on_account' ? 'On account' : 'Against invoice'}</div></span> },
              { key: 'amount', label: 'Amount', align: 'num', render: (p) => <strong>{inr(p.amount)}</strong> },
              { key: 'tds', label: 'TDS', align: 'num', render: (p) => (p.tds_amount ? inr(p.tds_amount) : '—') },
              { key: 'ded', label: 'Other deduction', align: 'num', render: (p) => (p.other_deduction ? <span title={p.deduction_note}>{inr(p.other_deduction)}</span> : '—') },
              { key: 'mode', label: 'Mode', render: (p) => <span className="small">{labelOf(PAYMENT_MODES, p.mode)}{p.reference && <div className="tiny muted">{p.reference}</div>}</span> },
              { key: 'by', label: 'Recorded by', render: (p) => <span className="small muted">{p.recorded_by_name}</span> },
            ]} />
          </Card>
        </>
      )}

      {f.tab === 'advances' && (
        <Card flush>
          <DataTable rows={d.advances_pending} empty={<EmptyState icon="check" title="All advances collected" />} columns={[
            { key: 'order', label: 'Order', render: (o) => <Link to={`/orders/${o.id}`} className="strong">{o.number}</Link> },
            { key: 'customer', label: 'Customer', render: (o) => o.customer_name },
            { key: 'required', label: 'Advance required', align: 'num', render: (o) => inr(o.advance_required) },
            { key: 'received', label: 'Received', align: 'num', render: (o) => inr(o.advance_received) },
            { key: 'pending', label: 'Pending', align: 'num', render: (o) => <strong className="danger-text">{inr(o.advance_required - o.advance_received)}</strong> },
            { key: 'stage', label: 'Order stage', render: (o) => <Badge>{o.stage.replace(/_/g, ' ')}</Badge> },
          ]} />
        </Card>
      )}

      {f.tab === 'credit' && (
        <Card flush>
          <DataTable rows={creditNotes.data} empty={<EmptyState title="No credit notes" />} columns={[
            { key: 'number', label: 'Credit note', render: (c) => <strong>{c.number}</strong> },
            { key: 'date', label: 'Date', render: (c) => date(c.note_date) },
            { key: 'customer', label: 'Customer', render: (c) => <Link to={`/customers/${c.customer_id}`}>{c.customer_name}</Link> },
            { key: 'invoice', label: 'Against invoice', render: (c) => c.invoice_number || '—' },
            { key: 'amount', label: 'Amount', align: 'num', render: (c) => inr(c.amount) },
            { key: 'reason', label: 'Reason' },
            { key: 'by', label: 'Issued by', render: (c) => <span className="small muted">{c.created_by_name}</span> },
          ]} />
        </Card>
      )}

      <RecordPaymentModal open={Boolean(payFor)} onClose={() => setPayFor(null)} invoice={payFor?.invoice} onSaved={() => { overview.reload(); invoices.reload?.(); receipts.reload?.(); }} />
      <CreditNoteModal open={Boolean(creditFor)} onClose={() => setCreditFor(null)} invoice={creditFor} onSaved={() => { overview.reload(); invoices.reload?.(); }} />
      <LogActivityModal open={Boolean(logFor)} onClose={() => setLogFor(null)} customerId={logFor} defaultType="call" onSaved={() => toast.success('Collection call logged')} />
    </div>
  );
}

function RecordPaymentModal({ open, onClose, invoice, onSaved }) {
  const toast = useToast();
  const { can } = useAuth();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const openInvoices = useApi(open && !invoice ? '/invoices' : null, { status: 'outstanding' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const target = invoice || (openInvoices.data || []).find((i) => String(i.id) === String(form.invoice_id));
  const close = () => { onClose(); setForm({}); };
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/payments', { ...form, invoice_id: invoice?.id || form.invoice_id, payment_date: form.payment_date || todayStr(), mode: form.mode || 'neft' });
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
    <Modal open={open} onClose={close} title="Record payment" subtitle={invoice ? `${invoice.number} · ${invoice.customer_name}` : undefined}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save payment</Button></>}>
      <div className="form-grid">
        {!invoice && (
          <Field label="Invoice" required className="full">
            <Select value={form.invoice_id} onChange={(e) => { const inv = (openInvoices.data || []).find((i) => String(i.id) === e.target.value); setForm((f) => ({ ...f, invoice_id: e.target.value, amount: inv?.balance })); }}
              placeholder="Select invoice…" options={(openInvoices.data || []).map((i) => ({ value: i.id, label: `${i.number} · ${i.customer_name} · ${inr(i.balance)}` }))} />
          </Field>
        )}
        <Field label="Amount received (₹)" required hint={target ? `Balance ${inr(target.balance)}` : undefined}><Input type="number" min="0" value={form.amount ?? invoice?.balance ?? ''} onChange={set('amount')} /></Field>
        <Field label="Payment date"><Input type="date" value={form.payment_date || todayStr()} onChange={set('payment_date')} /></Field>
        <Field label="Mode"><Select value={form.mode || 'neft'} onChange={set('mode')} options={PAYMENT_MODES} /></Field>
        <Field label="Reference / UTR"><Input value={form.reference} onChange={set('reference')} /></Field>
        {can('finance.full') && <>
          <Field label="TDS deducted (₹)"><Input type="number" min="0" value={form.tds_amount} onChange={set('tds_amount')} /></Field>
          <Field label="Other deduction (₹)"><Input type="number" min="0" value={form.other_deduction} onChange={set('other_deduction')} /></Field>
          <Field label="Deduction note" className="full"><Input value={form.deduction_note} onChange={set('deduction_note')} placeholder="e.g. Freight debit, quality deduction" /></Field>
        </>}
        <Field label="Notes" className="full"><Input value={form.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function CreditNoteModal({ open, onClose, invoice, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const close = () => { onClose(); setForm({}); };
  const save = async () => {
    try {
      await api.post('/credit-notes', { ...form, invoice_id: invoice.id, note_date: form.note_date || todayStr() });
      toast.success('Credit note issued');
      onSaved();
      close();
    } catch (err) {
      toast.error(err.message);
    }
  };
  if (!invoice) return null;
  return (
    <Modal open={open} onClose={close} title="Issue credit note" subtitle={`${invoice.number} · balance ${inr(invoice.balance)}`}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={save}>Issue</Button></>}>
      <div className="form-grid">
        <Field label="Amount (₹)" required><Input type="number" min="0" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
        <Field label="Date"><Input type="date" value={form.note_date || todayStr()} onChange={(e) => setForm((f) => ({ ...f, note_date: e.target.value }))} /></Field>
        <Field label="Reason" required className="full"><Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Short supply of 2 CTs, price difference as per revised PO" /></Field>
      </div>
    </Modal>
  );
}
