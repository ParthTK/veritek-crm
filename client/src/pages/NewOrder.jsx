// An order that did not come through a quotation, such as a repeat order. Orders from a quotation start on the
// quotation page instead.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CURRENCIES } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSave, useUnsavedGuard } from '../lib/hooks.js';
import { todayLocal } from '../lib/format.js';
import { Button, Card, Field, Input, Notice, PageHeader, SaveStatus, Select, Checkbox } from '../components/ui.jsx';
import { CustomerPicker, ProductSelect, UserSelect } from '../components/domain.jsx';

const emptyLine = () => ({ product_id: null, description: '', confirmed_qty: '', unit_price: '', date: '' });

export default function NewOrder() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const save = useSave();
  const [f, setF] = useState({
    customer: null, po_reference: '', received_date: todayLocal(), owner_id: user.group === 'sales' ? user.id : null, currency: 'INR', advance_pct: '', lines: [emptyLine()], confirm_duplicate_po: false,
  });
  useUnsavedGuard(Boolean(f.customer || f.lines.some((l) => l.product_id || l.confirmed_qty)) && !save.savedAt);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const setLine = (i, p) => set({ lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const submit = () => save.run(async (key) => {
    const res = await api.post('/orders', {
      customer_id: f.customer?.id, owner_id: f.owner_id, source_code: 'repeat_order', po_reference: f.po_reference, received_date: f.received_date, currency: f.currency, advance_pct: f.advance_pct, confirm: true, confirm_duplicate_po: f.confirm_duplicate_po,
      lines: f.lines.map((l) => ({
        product_id: l.product_id, description: l.description, confirmed_qty: l.confirmed_qty, unit_price: l.unit_price,
        ...(l.date ? { commitment_state: 'committed', original_commitment_date: l.date } : { commitment_state: 'uncommitted' }),
      })),
    }, { key });
    navigate(`/orders/${res.id}`);
    return res;
  });
  const fe = save.fields;
  return (
    <form className="stack" style={{ maxWidth: 960 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <PageHeader crumbs={[{ label: 'Orders', to: '/orders' }, { label: 'New order' }]} title="New order" />
      <Card>
        <div className="form-grid">
          <Field label="Customer" required className="full" error={fe.customer_id}><CustomerPicker value={f.customer} onChange={(c) => set({ customer: c, owner_id: f.owner_id || c?.row?.owner_id || null, currency: c?.row?.segment === 'export' ? 'USD' : 'INR' })} allowCreate={false} onNewCustomer={() => {}} /></Field>
          <Field label="PO number" required hint="Or who confirmed the order" error={fe.po_reference}><Input value={f.po_reference} onChange={(e) => set({ po_reference: e.target.value })} /></Field>
          <Field label="Order date" required error={fe.received_date}><Input type="date" max={todayLocal()} value={f.received_date} onChange={(e) => set({ received_date: e.target.value })} /></Field>
          <Field label="Assigned to" required error={fe.owner_id}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <Field label="Advance %" optional className="grow" error={fe.advance_pct}><Input type="number" min={0} max={100} value={f.advance_pct} onChange={(e) => set({ advance_pct: e.target.value })} /></Field>
            <Field label="Currency" error={fe.currency}><Select value={f.currency} onChange={(e) => set({ currency: e.target.value })} options={CURRENCIES} style={{ width: 96 }} /></Field>
          </div>
        </div>
      </Card>
      <Card title="Items">
        <div className="table-wrap">
          <table className="lines" style={{ minWidth: 640 }}>
            <thead><tr><th>Product</th><th className="num" style={{ width: 96 }}>Qty</th><th className="num" style={{ width: 120 }}>Unit price</th><th style={{ width: 160 }}>Dispatch by</th><th style={{ width: 36 }} /></tr></thead>
            <tbody>
              {f.lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <ProductSelect value={l.product_id} onChange={(v) => setLine(i, { product_id: v })} invalid={Boolean(fe[`lines.${i}.product_id`])} />
                    {!l.product_id && <Input className="mt-8" placeholder="Describe the item" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} invalid={Boolean(fe[`lines.${i}.description`])} aria-label="Item description" />}
                    {['description', 'confirmed_qty', 'unit_price', 'original_commitment_date'].map((k) => fe[`lines.${i}.${k}`] && <div key={k} className="tiny danger-text">{fe[`lines.${i}.${k}`]}</div>)}
                  </td>
                  <td><Input type="number" min={0} step="any" className="num" value={l.confirmed_qty} onChange={(e) => setLine(i, { confirmed_qty: e.target.value })} invalid={Boolean(fe[`lines.${i}.confirmed_qty`])} aria-label="Quantity" /></td>
                  <td><Input inputMode="decimal" className="num" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} invalid={Boolean(fe[`lines.${i}.unit_price`])} aria-label="Unit price" /></td>
                  <td><Input type="date" value={l.date} onChange={(e) => setLine(i, { date: e.target.value })} aria-label="Dispatch by" /></td>
                  <td>{f.lines.length > 1 && <Button size="sm" variant="ghost" icon="trash" aria-label="Remove item" onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-12"><Button size="sm" icon="plus" onClick={() => set({ lines: [...f.lines, emptyLine()] })}>Add item</Button></div>
        {fe.lines && <Notice tone="danger">{fe.lines}</Notice>}
      </Card>
      {save.error?.code === 'duplicate_po' && <Notice tone="warn" title="This PO number is already on an order">{save.error.message}<div className="mt-8"><Checkbox label="This is a different order" checked={f.confirm_duplicate_po} onChange={(v) => set({ confirm_duplicate_po: v })} /></div></Notice>}
      {save.error && !Object.keys(fe).length && save.error.code !== 'duplicate_po' && <Notice tone="danger">{save.error.message}</Notice>}
      <div className="row between wrap"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Create order</Button></div>
    </form>
  );
}
