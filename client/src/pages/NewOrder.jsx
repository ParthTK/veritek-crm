import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CURRENCIES } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSave, useUnsavedGuard } from '../lib/hooks.js';
import { todayLocal } from '../lib/format.js';
import { Button, Card, Field, Input, Notice, PageHeader, SaveStatus, Select, Checkbox, Textarea } from '../components/ui.jsx';
import { CustomerPicker, ProductSelect, OptionSelect, UserSelect, FilePick, useOptions, useMeta } from '../components/domain.jsx';

const emptyLine = () => ({ product_id: null, description: '', spec: '', confirmed_qty: '', unit: 'pcs', unit_price: '', original_commitment_date: '', uncommitted: false });

export default function NewOrder() {
  const { user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const save = useSave();
  const [f, setF] = useState({
    customer: null, source_code: 'repeat_order', po_reference: '', received_date: todayLocal(), confirmation_note: '', doc: null, owner_id: user.group === 'sales' ? user.id : null,
    currency: 'INR', payment_terms: '', delivery_address: '', notes: '', lines: [emptyLine()], confirm_duplicate_po: false,
  });
  const dirty = Boolean(f.customer || f.lines.some((l) => l.product_id || l.confirmed_qty));
  useUnsavedGuard(dirty && !save.savedAt);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const setLine = (i, p) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const source = useOptions('order_source').find((o) => o.value === f.source_code);
  const submit = (confirm) => save.run(async (key) => {
    const res = await api.post('/orders', {
      customer_id: f.customer?.id, owner_id: f.owner_id, source_code: f.source_code, po_reference: f.po_reference, received_date: f.received_date, confirmation_note: f.confirmation_note,
      confirmation_document_id: f.doc?.id, currency: f.currency, payment_terms: f.payment_terms, delivery_address: f.delivery_address, notes: f.notes, confirm, confirm_duplicate_po: f.confirm_duplicate_po,
      lines: f.lines.map((l) => ({ ...l, commitment_state: l.uncommitted ? 'uncommitted' : 'committed', original_commitment_date: l.uncommitted ? undefined : l.original_commitment_date })),
    }, { key });
    navigate(`/orders/${res.id}`);
    return res;
  });
  const fe = save.fields;
  return (
    <div className="stack" style={{ maxWidth: 1100 }}>
      <PageHeader crumbs={[{ label: 'Active orders', to: '/orders' }, { label: 'Direct order' }]} title="Enter a direct order" subtitle="For repeat orders or purchase orders received without a tracked enquiry. Orders from an accepted quotation are converted from the enquiry instead." />
      <Card title="Customer & confirmation">
        <div className="form-grid">
          <Field label="Customer" required className="full" error={fe.customer_id}><CustomerPicker value={f.customer} onChange={(c) => set({ customer: c, owner_id: f.owner_id || c?.row?.owner_id || null, currency: c?.row?.segment === 'export' ? 'USD' : 'INR' })} allowCreate={false} onNewCustomer={() => {}} /></Field>
          <Field label="How the order came in" required error={fe.source_code}><OptionSelect category="order_source" value={f.source_code} onChange={(v) => set({ source_code: v })} /></Field>
          <Field label="Customer PO reference" hint="Or a short note of who confirmed and when" error={fe.po_reference}><Input value={f.po_reference} onChange={(e) => set({ po_reference: e.target.value })} /></Field>
          <Field label="Order received" required error={fe.received_date}><Input type="date" max={todayLocal()} value={f.received_date} onChange={(e) => set({ received_date: e.target.value })} /></Field>
          <Field label="Sales owner" required error={fe.owner_id}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
          <Field label="Confirmation note" optional={!source?.requires_note} required={source?.requires_note} error={fe.confirmation_note} className="full"><Input value={f.confirmation_note} onChange={(e) => set({ confirmation_note: e.target.value })} placeholder="e.g. Verbal order from Mr. Shah on 12 Nov, PO to follow" /></Field>
          <Field label="PO / confirmation document" optional className="full"><FilePick value={f.doc} onChange={(doc) => set({ doc })} label="Attach PO" /></Field>
        </div>
      </Card>
      <Card title="Lines" sub="one line per delivery schedule — each has its own committed dispatch date">
        <div className="stack-sm">
          {f.lines.map((l, i) => (
            <div key={i} className="form-grid three" style={{ alignItems: 'end', paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
              <Field label={`Product ${i + 1}`} error={fe[`lines.${i}.product_id`]}><ProductSelect value={l.product_id} onChange={(v) => setLine(i, { product_id: v })} /></Field>
              <Field label={l.product_id ? 'Variant / specification' : 'Description'} required={!l.product_id} error={fe[`lines.${i}.description`]}>
                <Input value={l.product_id ? l.spec : l.description} onChange={(e) => setLine(i, l.product_id ? { spec: e.target.value } : { description: e.target.value })} />
              </Field>
              <Field label="Quantity" required error={fe[`lines.${i}.confirmed_qty`]}><div className="row"><Input type="number" min={0} value={l.confirmed_qty} onChange={(e) => setLine(i, { confirmed_qty: e.target.value })} /><OptionSelect category="unit" value={l.unit} onChange={(v) => setLine(i, { unit: v })} /></div></Field>
              <Field label="Unit price" optional error={fe[`lines.${i}.unit_price`]} hint="Blank = not priced (never treated as zero)"><Input inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></Field>
              <Field label="Committed dispatch date" required={!l.uncommitted} error={fe[`lines.${i}.original_commitment_date`] || fe[`lines.${i}.commitment_state`]}>
                <Input type="date" disabled={l.uncommitted} value={l.original_commitment_date} onChange={(e) => setLine(i, { original_commitment_date: e.target.value })} />
                <Checkbox label="Not agreed yet (a task to agree it is created)" checked={l.uncommitted} onChange={(v) => setLine(i, { uncommitted: v })} />
              </Field>
              <div className="row">
                <Button size="sm" onClick={() => set({ lines: [...f.lines.slice(0, i + 1), { ...l, confirmed_qty: '', original_commitment_date: '' }, ...f.lines.slice(i + 1)] })}>Add delivery schedule</Button>
                {f.lines.length > 1 && <Button size="sm" variant="ghost" icon="trash" aria-label="Remove line" onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })} />}
              </div>
            </div>
          ))}
          <div><Button size="sm" icon="plus" onClick={() => set({ lines: [...f.lines, emptyLine()] })}>Add product</Button></div>
        </div>
      </Card>
      <Card title="Commercial & shipping" sub="as relevant">
        <div className="form-grid three">
          <Field label="Currency"><Select value={f.currency} onChange={(e) => set({ currency: e.target.value })} options={CURRENCIES} /></Field>
          <Field label="Payment terms" optional><Input value={f.payment_terms} onChange={(e) => set({ payment_terms: e.target.value })} /></Field>
          <Field label="Delivery address" optional><Input value={f.delivery_address} onChange={(e) => set({ delivery_address: e.target.value })} /></Field>
          <Field label="Notes" optional className="full"><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        </div>
      </Card>
      {save.error?.code === 'duplicate_po' && <Notice tone="warn" title="Possible duplicate order">{save.error.message}<div className="mt-8"><Checkbox label="This is a different order — continue" checked={f.confirm_duplicate_po} onChange={(v) => set({ confirm_duplicate_po: v })} /></div></Notice>}
      {save.error && !Object.keys(save.fields).length && save.error.code !== 'duplicate_po' && <Notice tone="danger">{save.error.message}</Notice>}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <div className="row"><Button onClick={() => submit(false)} loading={save.saving}>Save as draft</Button><Button variant="cta" onClick={() => submit(true)} loading={save.saving}>Confirm order</Button></div>
      </div>
      <div className="small muted">Confirming records who confirmed it and when. Production status does not change automatically — the first production update does that.</div>
    </div>
  );
}
