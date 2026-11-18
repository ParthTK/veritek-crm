// Writing a quotation: who it is for, what is being offered and at what price. The server prices every preview.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CURRENCIES, ENQUIRY_STAGES, labelOf } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUnsavedGuard } from '../lib/hooks.js';
import { addDays, todayLocal } from '../lib/format.js';
import {
  Button, Card, ErrorState, Field, Input, Notice, PageHeader, SaveStatus, Select, Spinner, Textarea, useToast,
} from '../components/ui.jsx';
import { CustomerPicker, Money, ProductSelect, useMeta } from '../components/domain.jsx';

let seq = 0;
const newLine = (patch = {}) => ({
  key: `l${++seq}`, product_id: null, option_ids: [], qty: '', unit: '', unit_price: '', discount_pct: '', gst_rate: '', description: '', spec: '', custom: false, hsn: '', cost_price: '', enquiry_line_id: null, ...patch,
});
const major = (m) => (m === null || m === undefined ? '' : fromMinor(m));

function autoSpec(product, options) {
  const optionText = options.map((o) => `${o.group}: ${o.name}`).join('; ');
  return [product?.model, optionText].filter(Boolean).join(' | ');
}

/** Builder line -> API line. Blank price follows the price list; blank GST follows the product rate. */
function toPayload(l) {
  return {
    product_id: l.product_id || null, option_ids: l.option_ids, qty: l.qty === '' ? null : Number(l.qty), unit: l.unit || undefined,
    unit_price: l.unit_price === '' ? undefined : l.unit_price, discount_pct: l.discount_pct === '' ? 0 : Number(l.discount_pct),
    gst_rate: l.gst_rate === '' ? undefined : l.gst_rate, description: l.description || undefined, spec: l.spec || undefined,
    hsn: l.custom ? l.hsn || undefined : undefined, cost_price: l.custom && l.cost_price !== '' ? l.cost_price : undefined, enquiry_line_id: l.enquiry_line_id || undefined,
  };
}
const usable = (l) => l.product_id || (l.custom && l.description.trim());

export default function QuotationBuilder() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [params] = useSearchParams();
  const { data: existing, error, reload } = useApi(editing ? `/quotations/${id}` : null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (editing && !existing) return <Spinner />;
  if (editing && existing.current?.status !== 'draft') return <NotDraft q={existing} />;
  if (editing && existing.current?.approval_status === 'pending') {
    return (
      <div className="stack">
        <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: existing.number, to: `/quotations/${id}` }, { label: 'Edit' }]} title={`Edit ${existing.number}`} />
        <Notice tone="warn" title="Waiting for approval" action={<Button to={`/quotations/${id}`}>Open quotation</Button>}>Withdraw it from approval first.</Notice>
      </div>
    );
  }
  return <Builder key={existing?.current?.id || 'new'} existing={existing} initialCustomerId={params.get('customer_id')} initialEnquiryId={params.get('enquiry_id')} />;
}

function NotDraft({ q }) {
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: q.number, to: `/quotations/${q.id}` }, { label: 'Edit' }]} title={q.number} />
      <Notice tone="info" action={<Button to={`/quotations/${q.id}`}>Open quotation</Button>}>This quotation has been sent. To change it, create a new version from the quotation page.</Notice>
    </div>
  );
}

function Builder({ existing, initialCustomerId, initialEnquiryId }) {
  const meta = useMeta();
  const { user, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const save = useSave();
  const editing = Boolean(existing);
  const rev = existing?.current;
  const values = can('values.view');
  const qs = meta.settings.quotation || {};

  const productById = useMemo(() => Object.fromEntries(meta.products.map((p) => [p.id, p])), [meta.products]);
  const [header, setHeader] = useState(() => (rev ? {
    customer: { id: existing.customer_id, company_name: existing.customer_name }, enquiry_id: existing.enquiry_id ? String(existing.enquiry_id) : '', contact_id: existing.contact_id ? String(existing.contact_id) : '',
    owner_id: existing.owner_id, subject: existing.subject || '', source_code: 'existing_customer', source_event: '', price_list: rev.price_list || existing.price_list || '', currency: rev.currency,
    validity_date: rev.validity_date || '', payment_terms: rev.payment_terms || '', delivery_terms: rev.delivery_terms || '', warranty_terms: rev.warranty_terms || '', notes: rev.notes || '', summary: rev.summary || '',
    freight: rev.freight_minor ? fromMinor(rev.freight_minor) : '', installation: rev.installation_minor ? fromMinor(rev.installation_minor) : '', change_note: rev.change_note || '',
  } : {
    customer: null, enquiry_id: initialEnquiryId || '', contact_id: '', owner_id: user.group === 'sales' ? user.id : null, subject: '', source_code: 'existing_customer', source_event: '', campaign_id: '',
    price_list: '', currency: '', validity_date: addDays(todayLocal(), qs.defaultValidityDays || 30), payment_terms: qs.defaultPaymentTerms || '', delivery_terms: qs.defaultDelivery || '',
    warranty_terms: qs.defaultWarranty || '', notes: '', summary: '', freight: '', installation: '', change_note: '',
  }));
  const [lines, setLines] = useState(() => (rev ? rev.lines.map((l) => {
    const p = productById[l.product_id];
    const opts = l.config?.options || [];
    return newLine({
      product_id: l.product_id, option_ids: opts.map((o) => o.option_id || o.id), qty: l.qty ?? '', unit: l.unit || '',
      unit_price: l.list_price_minor !== null && l.list_price_minor !== undefined && l.unit_price_minor === l.list_price_minor ? '' : major(l.unit_price_minor),
      discount_pct: l.discount_pct ? String(l.discount_pct) : '', gst_rate: l.gst_rate === (rev.currency === 'INR' ? p?.gst_rate ?? 18 : 0) ? '' : String(l.gst_rate),
      description: l.custom || !p || l.description !== p.name ? l.description : '', spec: l.spec && l.spec !== autoSpec(p, opts) ? l.spec : '',
      custom: Boolean(l.custom), hsn: l.custom ? l.hsn || '' : '', cost_price: l.custom ? major(l.cost_price_minor) : '', enquiry_line_id: l.enquiry_line_id,
    });
  }) : [newLine()]));
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty && !save.saving);
  const setH = (patch) => { setDirty(true); setHeader((h) => ({ ...h, ...patch })); };
  const setLine = (key, patch) => { setDirty(true); setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); };

  // Customer context: contacts, owner, open enquiries.
  const customerId = header.customer?.id;
  const { data: profile } = useApi(customerId ? `/customers/${customerId}` : null);
  const { data: enquiries } = useApi(customerId && !editing ? '/enquiries' : null, { customer_id: customerId, stage: 'open', pageSize: 50 });
  const firstCustomer = useRef(true);
  useEffect(() => {
    if (!initialCustomerId || header.customer) return;
    api.get(`/customers/${initialCustomerId}`).then((p) => setHeader((h) => ({ ...h, customer: { id: p.customer.id, company_name: p.customer.company_name } }))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCustomerId]);
  useEffect(() => {
    if (!profile || editing) return;
    if (firstCustomer.current && header.contact_id) return;
    firstCustomer.current = false;
    const primary = profile.contacts.find((c) => c.is_primary && c.active) || profile.contacts.find((c) => c.active);
    setHeader((h) => ({ ...h, contact_id: primary ? String(primary.id) : '', owner_id: h.owner_id || profile.customer.owner_id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  // Starting from an enquiry copies its open lines (linked, so conversion tracks them).
  const loadEnquiry = async (enquiryId) => {
    if (!enquiryId) return;
    try {
      const e = await api.get(`/enquiries/${enquiryId}`);
      setHeader((h) => ({ ...h, customer: h.customer || { id: e.enquiry.customer_id, company_name: e.enquiry.customer_name }, subject: h.subject || e.enquiry.title || '', owner_id: e.enquiry.owner_id || h.owner_id, contact_id: e.enquiry.contact_id ? String(e.enquiry.contact_id) : h.contact_id }));
      const open = e.lines.filter((l) => l.outcome === 'open');
      if (open.length && !lines.some(usable)) {
        setLines(open.map((l) => newLine({
          product_id: l.product_id, qty: l.open_qty ?? l.qty ?? '', unit: l.unit || '', spec: l.spec || '', custom: !l.product_id, description: l.product_id ? '' : l.requirement || '', enquiry_line_id: l.id,
        })));
      }
    } catch (err) {
      toast.error(err.message);
    }
  };
  useEffect(() => {
    if (initialEnquiryId && !editing) loadEnquiry(initialEnquiryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live preview priced by the server.
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const sent = lines.filter(usable);
  useEffect(() => {
    if (!sent.length) {
      setPreview(null);
      return undefined;
    }
    const t = setTimeout(() => {
      api.post('/quotations/preview', {
        customer_id: customerId, price_list: header.price_list || undefined, currency: header.currency || undefined, freight: header.freight, installation: header.installation, lines: sent.map(toPayload),
      }).then((p) => { setPreview(p); setPreviewError(null); }).catch((e) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sent.map(toPayload)), customerId, header.price_list, header.currency, header.freight, header.installation]);
  const pvByKey = useMemo(() => Object.fromEntries(sent.map((l, i) => [l.key, preview?.lines?.[i]])), [preview, sent]);
  const pvErr = (l, field) => {
    const i = sent.indexOf(l);
    return i >= 0 ? (save.fields[`lines.${i}.${field}`] || preview?.field_errors?.[`lines.${i}.${field}`]) : undefined;
  };
  const currency = preview?.currency || header.currency || rev?.currency || 'INR';
  const priceList = preview?.price_list || header.price_list || 'standard';
  const totals = preview?.totals;

  const body = () => ({
    customer_id: customerId, enquiry_id: header.enquiry_id || undefined, contact_id: header.contact_id || undefined, owner_id: header.owner_id || undefined, subject: header.subject,
    source_code: header.enquiry_id ? undefined : header.source_code, source_event: header.enquiry_id ? undefined : header.source_event, campaign_id: header.enquiry_id ? undefined : header.campaign_id || undefined,
    price_list: header.price_list || priceList, currency: header.currency || currency, validity_date: header.validity_date || undefined,
    payment_terms: header.payment_terms, delivery_terms: header.delivery_terms, warranty_terms: header.warranty_terms, notes: header.notes, summary: header.summary,
    freight: header.freight, installation: header.installation, lines: sent.map(toPayload),
  });
  const submit = () => save.run(async (key) => {
    let quotationId = existing?.id;
    if (editing) await api.put(`/quote-revisions/${rev.id}`, { ...body(), version: rev.version, change_note: header.change_note });
    else quotationId = (await api.post('/quotations', body(), { key })).quotation_id;
    setDirty(false);
    toast.success('Quotation saved');
    window.dispatchEvent(new Event('data:changed'));
    setTimeout(() => navigate(`/quotations/${quotationId}`), 0);
    return { quotationId };
  });
  const contacts = (profile?.contacts || []).filter((c) => c.active || String(c.id) === header.contact_id);
  const openEnquiries = enquiries?.rows || [];

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, editing ? { label: existing.number, to: `/quotations/${existing.id}` } : null, { label: editing ? 'Edit' : 'New' }].filter(Boolean)}
        title={editing ? `Edit ${existing.number}` : 'New quotation'}
        actions={<>
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="cta" loading={save.saving} onClick={submit} disabled={!customerId || !sent.length}>Save quotation</Button>
        </>} />
      {save.conflict && <Notice tone="warn">Someone else saved this first. Reload the page and try again.</Notice>}
      {save.error && !save.conflict && <Notice tone="danger">{save.error.message}</Notice>}

      <div className="split side-330">
        <div className="stack">
          <Card>
            <div className="form-grid">
              <Field label="Customer" required className="full" error={save.fields.customer_id}>
                {editing ? <div className="strong"><Link to={`/customers/${existing.customer_id}`}>{existing.customer_name}</Link></div>
                  : <CustomerPicker value={header.customer} allowCreate={false} onNewCustomer={() => {}} onChange={(c) => { firstCustomer.current = false; setH({ customer: c, enquiry_id: '', contact_id: '', price_list: '', currency: '' }); }} />}
              </Field>
              {!editing && customerId && openEnquiries.length > 0 && (
                <Field label="Enquiry" error={save.fields.enquiry_id}>
                  <Select value={header.enquiry_id} onChange={(e) => { setH({ enquiry_id: e.target.value }); loadEnquiry(e.target.value); }} placeholder="New enquiry"
                    options={openEnquiries.map((e) => ({ value: String(e.id), label: `${e.code} · ${e.product || 'Enquiry'} — ${labelOf(ENQUIRY_STAGES, e.stage)}` }))} />
                </Field>
              )}
              {contacts.length > 1 && (
                <Field label="Contact">
                  <Select value={header.contact_id} onChange={(e) => setH({ contact_id: e.target.value })} placeholder="No contact" options={contacts.map((c) => ({ value: String(c.id), label: c.name || c.email_raw || c.phone_raw }))} />
                </Field>
              )}
            </div>
          </Card>

          <Card title="Items">
            <div className="table-wrap">
              <table className="lines" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num" style={{ width: 90 }}>Qty</th>
                    <th className="num" style={{ width: 120 }}>Unit price</th>
                    <th className="num" style={{ width: 80 }}>Disc %</th>
                    {values && <th className="num" style={{ width: 126 }}>Amount</th>}
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const pv = pvByKey[l.key];
                    const p = productById[l.product_id];
                    return (
                      <tr key={l.key}>
                        <td>
                          {l.custom
                            ? <Input placeholder="Item description" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} invalid={Boolean(pvErr(l, 'description'))} />
                            : <ProductSelect value={l.product_id} allowUnspecified={false} onChange={(v) => setLine(l.key, { product_id: v, option_ids: [], unit_price: '', description: '', spec: '', unit: '' })} invalid={Boolean(pvErr(l, 'product_id'))} />}
                          {pvErr(l, 'qty') && <div className="tiny danger-text">{pvErr(l, 'qty')}</div>}
                          {pvErr(l, 'unit_price') && <div className="tiny danger-text">{pvErr(l, 'unit_price')}</div>}
                        </td>
                        <td><Input type="number" min={0} step={p?.integer_qty ? 1 : 'any'} className="num" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} invalid={Boolean(pvErr(l, 'qty'))} aria-label="Quantity" /></td>
                        <td><Input inputMode="decimal" className="num" placeholder={pv?.list_price_minor !== null && pv?.list_price_minor !== undefined ? fromMinor(pv.list_price_minor) : 'Price'} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} invalid={Boolean(pvErr(l, 'unit_price'))} aria-label="Unit price" /></td>
                        <td><Input type="number" min={0} max={100} step="0.5" className="num" placeholder="0" value={l.discount_pct} onChange={(e) => setLine(l.key, { discount_pct: e.target.value })} aria-label="Discount percent" /></td>
                        {values && <td className="num">{pv ? <strong><Money minor={pv.line_total_minor} currency={currency} empty="—" /></strong> : '—'}</td>}
                        <td><Button size="sm" variant="ghost" icon="trash" aria-label="Remove item" onClick={() => { setDirty(true); setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()])); }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row wrap mt-12">
              <Button size="sm" icon="plus" onClick={() => setLines((ls) => [...ls, newLine()])}>Add product</Button>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setLines((ls) => [...ls, newLine({ custom: true })])}>Other item</Button>
            </div>
            {save.fields.lines && <Notice tone="danger">{save.fields.lines}</Notice>}
            {previewError && <Notice tone="danger">{previewError}</Notice>}
          </Card>

          <Card title="Terms">
            <div className="form-grid">
              <Field label="Valid until" error={save.fields.validity_date}><Input type="date" min={todayLocal()} value={header.validity_date} onChange={(e) => setH({ validity_date: e.target.value })} /></Field>
              <Field label="Currency" error={save.fields.currency}><Select value={header.currency} onChange={(e) => setH({ currency: e.target.value })} placeholder={currency} options={CURRENCIES} /></Field>
              <Field label="Payment terms" className="full"><Input value={header.payment_terms} onChange={(e) => setH({ payment_terms: e.target.value })} /></Field>
              <Field label="Delivery" className="full"><Input value={header.delivery_terms} onChange={(e) => setH({ delivery_terms: e.target.value })} /></Field>
              <Field label={`Freight (${currency})`} optional><Input inputMode="decimal" value={header.freight} onChange={(e) => setH({ freight: e.target.value })} /></Field>
              <Field label="Warranty" optional><Input value={header.warranty_terms} onChange={(e) => setH({ warranty_terms: e.target.value })} /></Field>
              <Field label="Notes" optional className="full"><Textarea rows={2} value={header.notes} onChange={(e) => setH({ notes: e.target.value })} maxLength={1000} /></Field>
            </div>
          </Card>
        </div>

        <div className="stack sticky-side">
          <Card title="Total">
            {!totals ? <div className="muted small">Add a product, quantity and price.</div> : !values ? <div className="muted small">Hidden for your role.</div> : (
              <div className="totals">
                <span>Before tax</span><span className="num strong"><Money minor={totals.total_minor} currency={currency} empty="—" /></span>
                <span className="muted">GST</span><span className="num"><Money minor={totals.tax_total_minor} currency={currency} empty="—" /></span>
                <span className="grand">Total</span><span className="grand num"><Money minor={totals.grand_total_minor} currency={currency} empty="—" /></span>
              </div>
            )}
          </Card>
          <SaveStatus save={save} />
        </div>
      </div>
    </div>
  );
}
