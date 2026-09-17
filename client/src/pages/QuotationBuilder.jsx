import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ROLES, CUSTOMER_TYPES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inr, inrCompact, number, pct } from '../lib/format.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, Textarea, useToast, ErrorState } from '../components/ui.jsx';
import { CustomerPicker, useMeta } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

let lineSeq = 0;
const newLine = (extra = {}) => ({ key: ++lineSeq, product_id: '', option_ids: [], qty: 1, unit_price: '', discount_pct: 0, description: '', specs: undefined, ...extra });

export default function QuotationBuilder() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { can } = useAuth();
  const editing = Boolean(id);
  const { data: existing, error: loadError } = useApi(editing ? `/quotations/${id}` : null);
  const { data: products } = useApi('/products', { active: 1 });
  const [productDetail, setProductDetail] = useState({});
  const [header, setHeader] = useState({ customer_id: params.get('customer') || '', lead_id: params.get('lead') || '', validity_days: meta.settings?.quotation?.defaultValidityDays || 30 });
  const [lines, setLines] = useState([newLine()]);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const initialized = useRef(false);
  const { data: customer } = useApi(header.customer_id ? `/customers/${header.customer_id}` : null);
  const { data: lead } = useApi(!editing && params.get('lead') ? `/leads/${params.get('lead')}` : null);
  const marginVisible = can('margin.view');

  // Defaults from settings, lead or existing quotation.
  useEffect(() => {
    if (initialized.current) return;
    if (editing && existing) {
      const v = existing.current;
      setHeader({
        customer_id: existing.customer_id, contact_id: existing.contact_id || '', lead_id: existing.lead_id || '', subject: existing.subject, price_list: existing.price_list,
        payment_terms: v.payment_terms, delivery_terms: v.delivery_terms, warranty_terms: v.warranty_terms, validity_days: v.validity_days,
        freight: v.freight || '', installation: v.installation || '', notes: v.notes || '', change_note: '',
      });
      setLines(v.items.map((it) => newLine({
        product_id: it.product_id || '', option_ids: (it.config?.options || []).map((o) => o.id), qty: it.qty, unit_price: it.unit_price,
        discount_pct: it.discount_pct, description: it.description, specs: it.specs, custom: !it.product_id, gst_rate: it.gst_rate, cost_price: it.cost_price, unit: it.unit, hsn: it.hsn,
      })));
      initialized.current = true;
    } else if (!editing && meta.loaded) {
      const q = meta.settings.quotation;
      setHeader((h) => ({ ...h, payment_terms: q.defaultPaymentTerms, delivery_terms: q.defaultDelivery, warranty_terms: q.defaultWarranty, validity_days: q.defaultValidityDays }));
      initialized.current = true;
    }
  }, [editing, existing, meta.loaded, meta.settings]);

  useEffect(() => {
    if (lead && !editing) {
      setHeader((h) => ({ ...h, customer_id: lead.customer_id, contact_id: lead.contact_id || '', subject: h.subject || lead.title }));
      if (lead.product_id && lines.length === 1 && !lines[0].product_id) setLines([newLine({ product_id: lead.product_id, qty: lead.quantity || 1 })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead]);

  // Load configurator options for products in use.
  useEffect(() => {
    for (const l of lines) {
      if (l.product_id && !productDetail[l.product_id]) {
        api.get(`/products/${l.product_id}`).then((p) => setProductDetail((d) => ({ ...d, [p.id]: p })));
      }
    }
  }, [lines, productDetail]);

  // Live pricing, tax, margin and approval preview from the server.
  useEffect(() => {
    const valid = lines.filter((l) => (l.product_id || (l.custom && l.description)) && Number(l.qty) > 0);
    if (!valid.length) {
      setPreview(null);
      return undefined;
    }
    const t = setTimeout(() => {
      api.post('/quotations/preview', { ...header, items: valid.map(toPayload) })
        .then((p) => { setPreview(p); setPreviewError(null); })
        .catch((err) => setPreviewError(err.message));
    }, 350);
    return () => clearTimeout(t);
  }, [lines, header]);

  const previewByKey = useMemo(() => {
    const valid = lines.filter((l) => (l.product_id || (l.custom && l.description)) && Number(l.qty) > 0);
    const map = {};
    valid.forEach((l, i) => { map[l.key] = preview?.lines?.[i]; });
    return map;
  }, [preview, lines]);

  const setH = (k) => (e) => setHeader((h) => ({ ...h, [k]: e?.target ? e.target.value : e }));
  const setLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const locked = editing && existing?.current?.locked;

  const save = async (submit) => {
    setBusy(true);
    try {
      const body = { ...header, items: lines.filter((l) => l.product_id || l.description).map(toPayload) };
      let qid = id;
      if (editing) await api.put(`/quotations/${id}`, body);
      else qid = (await api.post('/quotations', body)).id;
      if (submit) {
        const r = await api.post(`/quotations/${qid}/submit`);
        toast.success(r.status === 'approval_pending' ? 'Submitted for approval' : 'Approved automatically — ready to send');
      } else toast.success(locked ? 'New version saved as draft' : 'Draft saved');
      navigate(`/quotations/${qid}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <ErrorState error={loadError} />;
  if ((editing && !existing) || !products) return <Spinner />;
  if (editing && ['converted', 'accepted', 'approval_pending'].includes(existing.status)) {
    return <ErrorState error={{ message: existing.status === 'approval_pending' ? 'This quotation is awaiting approval. Withdraw it first to edit.' : 'Accepted or converted quotations cannot be edited.' }} />;
  }
  const totals = preview?.totals;
  const productOptions = products.filter((p) => !categoryFilter || p.category_id === Number(categoryFilter));

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: editing ? existing.number : 'New' }]}
        title={editing ? `${locked ? 'Revise' : 'Edit'} ${existing.number}` : 'New quotation'}
        subtitle={editing ? (locked ? `Version ${existing.current_version} was submitted or sent — saving creates version ${existing.current_version + 1}` : `Editing draft version ${existing.current_version}`) : 'Prices, GST, cost and minimum price come from the approved product & price master'}
        actions={<><Button onClick={() => navigate(-1)}>Cancel</Button><Button loading={busy} onClick={() => save(false)}>Save draft</Button><Button variant="primary" loading={busy} onClick={() => save(true)} icon="send">Save &amp; submit</Button></>}
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px', alignItems: 'start' }}>
        <div className="stack">
          <Card title="Customer">
            <div className="form-grid three">
              <Field label="Customer" required className="span-2">
                {editing ? <Input value={existing.customer_name} disabled /> : <CustomerPicker value={header.customer_id} onChange={(cid, c) => setHeader((h) => ({ ...h, customer_id: cid || '', contact_id: '', lead_id: '', price_list: c ? undefined : h.price_list }))} />}
              </Field>
              <Field label="Price list" hint={customer ? `Default for ${labelOf(CUSTOMER_TYPES, customer.customer_type).toLowerCase()} customers` : undefined}>
                <Select value={header.price_list || preview?.price_list || ''} onChange={setH('price_list')} options={[{ value: 'standard', label: 'Standard' }, { value: 'dealer', label: 'Dealer' }, { value: 'distributor', label: 'Distributor' }]} />
              </Field>
              <Field label="Contact person">
                <Select value={header.contact_id} onChange={setH('contact_id')} placeholder="—" options={(customer?.contacts || []).map((c) => ({ value: c.id, label: `${c.name}${c.designation ? ` (${c.designation})` : ''}` }))} />
              </Field>
              <Field label="Linked lead">
                <Select value={header.lead_id} onChange={setH('lead_id')} placeholder="—" disabled={editing}
                  options={(customer?.leads || []).filter((l) => l.status === 'open' || String(l.id) === String(header.lead_id)).map((l) => ({ value: l.id, label: `${l.code} · ${l.title}` }))} />
              </Field>
              <Field label="Subject"><Input value={header.subject} onChange={setH('subject')} placeholder="e.g. Supply of APFC panel" /></Field>
            </div>
            {customer?.status === 'blocked' && <div className="error-box" style={{ marginTop: 12 }}>This customer is blocked — the quotation cannot be saved.</div>}
          </Card>

          <Card title="Products" sub="Add from the price master; configure variants; adjust price or discount"
            actions={<><Select className="sm" style={{ width: 170 }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} placeholder="All categories" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} /></>}>
            <div className="table-wrap">
              <table className="lines">
                <thead>
                  <tr>
                    <th style={{ minWidth: 260 }}>Product &amp; configuration</th>
                    <th className="num" style={{ width: 80 }}>Qty</th>
                    <th className="num" style={{ width: 110 }}>List price</th>
                    <th className="num" style={{ width: 120 }}>Unit price</th>
                    <th className="num" style={{ width: 80 }}>Disc %</th>
                    <th className="num" style={{ width: 60 }}>GST</th>
                    <th className="num" style={{ width: 110 }}>Line total</th>
                    {marginVisible && <th className="num" style={{ width: 70 }}>Margin</th>}
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const pv = previewByKey[l.key];
                    const detail = productDetail[l.product_id];
                    const groups = detail ? [...new Set(detail.options.map((o) => o.group_name))] : [];
                    const lineMargin = pv && pv.cost_price !== undefined && pv.taxable > 0 ? ((pv.taxable - pv.qty * pv.cost_price) / pv.taxable) * 100 : null;
                    return (
                      <tr key={l.key} className={pv?.below_min ? 'line-warn' : ''}>
                        <td>
                          {l.custom ? (
                            <div className="stack-sm">
                              <Input placeholder="Non-catalogue item description" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                              <div className="row">
                                <Input placeholder="HSN" value={l.hsn} onChange={(e) => setLine(l.key, { hsn: e.target.value })} />
                                {marginVisible && <Input type="number" placeholder="Cost price" value={l.cost_price} onChange={(e) => setLine(l.key, { cost_price: e.target.value })} />}
                              </div>
                            </div>
                          ) : (
                            <div className="stack-sm">
                              <Select value={l.product_id} onChange={(e) => setLine(l.key, { product_id: Number(e.target.value) || '', option_ids: [], unit_price: '', description: '', specs: undefined })} placeholder="Select product…"
                                options={productOptions.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}${p.stock_type === 'made_to_order' ? ' (MTO)' : ''}` }))} />
                              {groups.map((g) => (
                                <div key={g} className="row small">
                                  <span className="muted" style={{ width: 96, flex: 'none' }}>{g}</span>
                                  <Select className="sm" value={l.option_ids.find((oid) => detail.options.find((o) => o.id === oid)?.group_name === g) || ''}
                                    onChange={(e) => {
                                      const others = l.option_ids.filter((oid) => detail.options.find((o) => o.id === oid)?.group_name !== g);
                                      setLine(l.key, { option_ids: e.target.value ? [...others, Number(e.target.value)] : others, unit_price: '' });
                                    }}
                                    placeholder="Standard" options={detail.options.filter((o) => o.group_name === g).map((o) => ({ value: o.id, label: `${o.name}${o.price_delta ? ` (${o.price_delta > 0 ? '+' : '−'}${inr(Math.abs(o.price_delta))})` : ''}` }))} />
                                </div>
                              ))}
                              {l.product_id && <Input className="sm" placeholder={pv?.description || 'Description'} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />}
                              {pv?.specs && <div className="tiny muted">{pv.specs}</div>}
                              {detail && <div className="tiny muted">Lead time {detail.lead_time_days} days · warranty {detail.warranty_months} months · {detail.stock_type === 'stock' ? `${detail.stock_qty} in stock` : 'made to order'}</div>}
                            </div>
                          )}
                          {pv?.below_min && <div className="tiny danger-text strong" style={{ marginTop: 4 }}>Below minimum selling price — needs management approval</div>}
                        </td>
                        <td><Input type="number" min="1" className="num" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} /></td>
                        <td className="num small">{pv ? inr(pv.list_price) : '—'}</td>
                        <td><Input type="number" min="0" className="num" placeholder={pv ? String(pv.list_price) : ''} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} /></td>
                        <td><Input type="number" min="0" max="100" step="0.5" className="num" value={l.discount_pct} onChange={(e) => setLine(l.key, { discount_pct: e.target.value })} /></td>
                        <td className="num small">{l.custom ? <Input type="number" value={l.gst_rate ?? 18} onChange={(e) => setLine(l.key, { gst_rate: e.target.value })} /> : pv ? `${pv.gst_rate}%` : '—'}</td>
                        <td className="num">{pv ? <><strong>{inr(pv.total)}</strong>{pv.line_discount_pct > 0.05 && <div className="tiny muted">{number(pv.line_discount_pct, 1)}% off list</div>}</> : '—'}</td>
                        {marginVisible && <td className={`num small ${lineMargin !== null && lineMargin < (meta.settings.approvals?.minMarginPct ?? 22) ? 'danger-text strong' : ''}`}>{lineMargin === null ? '—' : pct(lineMargin)}</td>}
                        <td><Button size="sm" variant="ghost" icon="trash" aria-label="Remove line" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()]))} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Button size="sm" icon="plus" onClick={() => setLines((ls) => [...ls, newLine()])}>Add product</Button>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setLines((ls) => [...ls, newLine({ custom: true, unit_price: 0, gst_rate: 18 })])}>Non-catalogue item</Button>
            </div>
            {previewError && <div className="error-box" style={{ marginTop: 10 }}>{previewError}</div>}
          </Card>

          <Card title="Commercial terms">
            <div className="form-grid">
              <Field label="Freight charges (₹)" hint="GST applied at the service rate"><Input type="number" min="0" value={header.freight} onChange={setH('freight')} /></Field>
              <Field label="Installation / commissioning (₹)"><Input type="number" min="0" value={header.installation} onChange={setH('installation')} /></Field>
              <Field label="Payment terms" className="full"><Input value={header.payment_terms} onChange={setH('payment_terms')} /></Field>
              <Field label="Delivery timeline" className="full"><Input value={header.delivery_terms} onChange={setH('delivery_terms')} /></Field>
              <Field label="Warranty" className="full"><Input value={header.warranty_terms} onChange={setH('warranty_terms')} /></Field>
              <Field label="Validity (days)"><Input type="number" min="1" value={header.validity_days} onChange={setH('validity_days')} /></Field>
              <Field label="Notes / technical remarks" className="full"><Textarea rows={3} value={header.notes} onChange={setH('notes')} placeholder="Scope, exclusions, technical attachments reference…" /></Field>
              {editing && <Field label="What changed in this revision?" className="full" hint="Recorded in version history"><Input value={header.change_note} onChange={setH('change_note')} placeholder="e.g. Additional 3% discount after negotiation" /></Field>}
            </div>
          </Card>
        </div>

        <div className="stack" style={{ position: 'sticky', top: 72 }}>
          <Card title="Summary">
            {!totals ? <div className="muted small">Add a product to see totals.</div> : (
              <div className="stack">
                <div className="totals">
                  <span className="muted">List value</span><span className="num">{inr(totals.list_total)}</span>
                  <span className="muted">Gross at quoted price</span><span className="num">{inr(totals.subtotal)}</span>
                  <span className="muted">Line discounts</span><span className="num">− {inr(totals.discount_total)}</span>
                  {totals.freight > 0 && <><span className="muted">Freight</span><span className="num">{inr(totals.freight)}</span></>}
                  {totals.installation > 0 && <><span className="muted">Installation</span><span className="num">{inr(totals.installation)}</span></>}
                  <span className="muted">Taxable value</span><span className="num">{inr(totals.taxable_total)}</span>
                  <span className="muted">GST</span><span className="num">{inr(totals.tax_total)}</span>
                  <span className="grand">Grand total</span><span className="grand num">{inr(totals.grand_total)}</span>
                </div>
                <div className="divider" style={{ margin: 0 }} />
                <div className="totals">
                  <span className="muted">Effective discount</span><span className={`num strong ${totals.discount_pct > (meta.settings.approvals?.discountManagerPct ?? 10) ? 'warning-text' : ''}`}>{pct(totals.discount_pct)}</span>
                  {marginVisible && totals.margin_pct !== undefined && <><span className="muted">Gross margin</span><span className={`num strong ${totals.margin_pct !== null && totals.margin_pct < (meta.settings.approvals?.minMarginPct ?? 22) ? 'danger-text' : 'success-text'}`}>{totals.margin_pct === null ? '—' : pct(totals.margin_pct)}</span></>}
                </div>
              </div>
            )}
          </Card>
          {preview && (
            preview.approval_role ? (
              <div className="warn-box stack-sm">
                <div className="row strong"><Icon name="shield" size={16} /> Needs {labelOf(ROLES, preview.approval_role)} approval</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>{preview.approval_reasons.map((r) => <li key={r} className="small">{r}</li>)}</ul>
                <div className="tiny">Submitting sends it to the approver automatically.</div>
              </div>
            ) : (
              <div className="info-box row"><Icon name="check" size={16} /> Within discount and margin policy — approves automatically on submit.</div>
            )
          )}
          {preview?.large && <div className="info-box small">Large quotation: management will be notified.</div>}
          {totals && <div className="small muted">Policy: discount &gt; {meta.settings.approvals?.discountManagerPct}% → Regional Manager; &gt; {meta.settings.approvals?.discountHeadPct}% or margin &lt; {meta.settings.approvals?.minMarginPct}% → Sales Head; below minimum price → Management.</div>}
          {totals && <Badge color="slate">{inrCompact(totals.grand_total)} incl. GST</Badge>}
        </div>
      </div>
    </div>
  );
}

function toPayload(l) {
  if (l.custom) {
    return { description: l.description, qty: l.qty, unit_price: l.unit_price, discount_pct: l.discount_pct, gst_rate: l.gst_rate ?? 18, cost_price: l.cost_price, hsn: l.hsn, unit: l.unit || 'Nos' };
  }
  return { product_id: l.product_id, option_ids: l.option_ids, qty: l.qty, unit_price: l.unit_price === '' ? undefined : l.unit_price, discount_pct: l.discount_pct, description: l.description || undefined, specs: l.specs };
}
