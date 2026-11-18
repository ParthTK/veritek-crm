// The three steps after a quotation is written: it is sent, the customer decides, and it becomes an order.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addWorkingDays } from '@shared/dates.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, qty, todayLocal } from '../lib/format.js';
import { Button, Checkbox, Field, Input, Notice, SaveStatus, Spinner } from './ui.jsx';
import { DateField, OptionSelect, useMeta, useOptions } from './domain.jsx';

export function IssueForm({ r, ownerId, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const [f, setF] = useState({
    channel: 'email', validity_date: r.validity_date || '',
    due_date: addWorkingDays(todayLocal(), meta.settings.reminders?.quotationFollowupWorkingDays ?? 3, meta.settings.calendar),
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/quote-revisions/${r.id}/issue`, {
        sent_at: new Date().toISOString(), channel: f.channel, summary: r.summary || 'Quotation sent to the customer', validity_date: f.validity_date,
        next: { purpose: 'Follow up quotation', due_date: f.due_date, owner_id: ownerId },
      });
      onSaved();
    }); }}>
      <div className="form-grid">
        <Field label="Sent by" required error={save.fields.channel}><OptionSelect category="channel" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} exclude={['internal']} /></Field>
        <Field label="Valid until" required error={save.fields.validity_date}><Input type="date" value={f.validity_date} onChange={(e) => setF({ ...f, validity_date: e.target.value })} /></Field>
        <DateField label="Follow up on" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date'] || save.fields['next.owner_id']} />
      </div>
      {save.fields.lines && <Notice tone="danger">{save.fields.lines}</Notice>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Mark as sent</Button></div>
    </form>
  );
}

export function OutcomeForm({ r, outcome, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ note: '', reason_code: '' });
  const opt = useOptions('lost_reason').find((o) => o.value === f.reason_code);
  const approved = outcome === 'accepted';
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/quote-revisions/${r.id}/outcome`, { outcome, acceptance_type: approved ? 'written' : undefined, note: f.note, reason_code: f.reason_code, close_enquiry: !approved });
      onSaved();
    }); }}>
      {!approved && <Field label="Reason" required error={save.fields.reason_code}><OptionSelect category="lost_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>}
      <Field label="Note" optional={approved || !opt?.requires_note} required={!approved && opt?.requires_note} error={save.fields.note}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={approved ? 'primary' : 'danger'} loading={save.saving}>{approved ? 'Mark as approved' : 'Mark as rejected'}</Button></div>
    </form>
  );
}

const advanceFrom = (terms) => /(\d{1,3})\s*%\s*advance/i.exec(terms || '')?.[1] || '';

/** Turns an approved quotation into a confirmed order: quantities, prices and the dispatch date. */
export function ConvertForm({ r }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data } = useApi(`/quote-revisions/${r.id}`);
  const save = useSave();
  const [f, setF] = useState(null);
  useEffect(() => {
    if (!data || f) return;
    setF({
      po_reference: '', received_date: todayLocal(), advance_pct: advanceFrom(data.payment_terms), expired_terms_confirmed: false, expired_note: '', confirm_duplicate_po: false,
      lines: data.conversion.map((l) => ({ index: l.index, qty: l.remaining_qty ?? l.qty ?? '', date: '', unit_price: l.unit_price_minor === null ? '' : fromMinor(l.net_unit_price_minor ?? l.unit_price_minor) })),
    });
  }, [data, f]);
  if (!data || !f) return <Spinner />;
  const setLine = (i, p) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const submit = () => save.run(async (key) => {
    const res = await api.post(`/quote-revisions/${r.id}/convert`, {
      confirm: true, po_reference: f.po_reference, received_date: f.received_date, confirmation_type: 'po', advance_pct: f.advance_pct, expired_terms_confirmed: f.expired_terms_confirmed, expired_note: f.expired_note,
      confirm_duplicate_po: f.confirm_duplicate_po,
      lines: f.lines.filter((l) => Number(l.qty) > 0).map((l) => ({ index: l.index, qty: Number(l.qty), unit_price: l.unit_price, ...(l.date ? { original_commitment_date: l.date } : { commitment_state: 'uncommitted' }) })),
    }, { key });
    window.dispatchEvent(new Event('data:changed'));
    navigate(`/orders/${res.order_id}`);
    return res;
  });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {data.expired && (
        <Notice tone="warn" title={`This quotation expired on ${date(data.validity_date)}`}>
          {can('quotes.expired_override') ? (
            <div className="stack-xs mt-8">
              <Checkbox label="The customer confirmed these terms" checked={f.expired_terms_confirmed} onChange={(v) => setF({ ...f, expired_terms_confirmed: v })} />
              <Input placeholder="Who confirmed, and when" value={f.expired_note} onChange={(e) => setF({ ...f, expired_note: e.target.value })} />
              {(save.fields.expired_terms_confirmed || save.fields.expired_note) && <span className="small danger-text">{save.fields.expired_terms_confirmed || save.fields.expired_note}</span>}
            </div>
          ) : 'A coordinator or management needs to confirm the terms first.'}
        </Notice>
      )}
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Item</th><th style={{ width: 110 }}>Quantity</th><th style={{ width: 130 }}>Unit price</th><th style={{ width: 170 }}>Dispatch by</th></tr></thead>
          <tbody>
            {data.conversion.map((l, i) => (
              <tr key={l.index}>
                <td><strong>{l.product_code || ''}</strong> {l.description}<div className="sub">Quoted {qty(l.qty, l.unit)}</div></td>
                <td><Input type="number" min={0} max={l.remaining_qty ?? undefined} value={f.lines[i].qty} onChange={(e) => setLine(i, { qty: e.target.value })} invalid={Boolean(save.fields[`lines.${i}.qty`] || save.fields[`lines.${i}.confirmed_qty`])} aria-label="Quantity" /></td>
                <td><Input inputMode="decimal" value={f.lines[i].unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} aria-label="Unit price" /></td>
                <td><Input type="date" value={f.lines[i].date} onChange={(e) => setLine(i, { date: e.target.value })} invalid={Boolean(save.fields[`lines.${i}.original_commitment_date`])} aria-label="Dispatch by" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Object.entries(save.fields).filter(([k]) => k.startsWith('lines')).map(([k, v]) => <div key={k} className="small danger-text">{v}</div>)}
      <div className="form-grid three">
        <Field label="PO number" required error={save.fields.po_reference} hint="Or who confirmed the order"><Input value={f.po_reference} onChange={(e) => setF({ ...f, po_reference: e.target.value })} /></Field>
        <Field label="Order date" required error={save.fields.received_date}><Input type="date" max={todayLocal()} value={f.received_date} onChange={(e) => setF({ ...f, received_date: e.target.value })} /></Field>
        <Field label="Advance %" optional error={save.fields.advance_pct}><Input type="number" min={0} max={100} value={f.advance_pct} onChange={(e) => setF({ ...f, advance_pct: e.target.value })} /></Field>
      </div>
      {save.error?.code === 'duplicate_po' && <Notice tone="warn" title="This PO number is already on an order">{save.error.message}<div className="mt-8"><Checkbox label="This is a different order" checked={f.confirm_duplicate_po} onChange={(v) => setF({ ...f, confirm_duplicate_po: v })} /></div></Notice>}
      {save.fields.customer_id && <Notice tone="danger">{save.fields.customer_id}</Notice>}
      <div className="row between wrap"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Create order</Button></div>
    </form>
  );
}
