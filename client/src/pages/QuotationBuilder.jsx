// Quotation builder: customer and opportunity, price list and currency, catalogue lines with configurator
// options (priced from the product master), discounts, GST, freight and installation. The server prices
// every preview, so list price, cost, minimum price and the approval level are never computed in the browser.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CURRENCIES, PRICE_LISTS, ROLES, ENQUIRY_STAGES, labelOf } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUnsavedGuard } from '../lib/hooks.js';
import { addDays, money, number, pct, todayLocal } from '../lib/format.js';
import {
  Button, Card, ErrorState, Field, Input, Notice, PageHeader, SaveStatus, Select, Spinner, Textarea, useToast,
} from '../components/ui.jsx';
import { CustomerPicker, Money, OptionSelect, ProductSelect, UserSelect, useMeta, ApprovalBadge, StageBadge } from '../components/domain.jsx';

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
        <Notice tone="warn" title="Awaiting internal approval" action={<Button to={`/quotations/${id}`}>Open quotation</Button>}>Withdraw it from approval on the quotation page before changing the draft.</Notice>
      </div>
    );
  }
  return <Builder key={existing?.current?.id || 'new'} existing={existing} initialCustomerId={params.get('customer_id')} initialEnquiryId={params.get('enquiry_id')} />;
}

function NotDraft({ q }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const canRevise = !q.revisions.some((r) => r.status === 'accepted' && q.orders.some((o) => o.revision_no === r.revision_no));
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: q.number, to: `/quotations/${q.id}` }, { label: 'Edit' }]} title={`${q.number} rev ${q.current.revision_no} is ${q.current.status}`} />
      <Notice tone="info" title="Issued revisions never change"
        action={canRevise && <Button variant="primary" loading={busy} onClick={async () => {
          setBusy(true);
          try {
            await api.post(`/quotations/${q.id}/revisions`, { change_note: 'Revised offer' });
            toast.success('New draft revision created — earlier revisions stay retrievable');
            navigate(0);
          } catch (e) {
            toast.error(e.message);
          } finally {
            setBusy(false);
          }
        }}>Start revision {q.current.revision_no + 1}</Button>}>
        To change prices, quantities or terms, start a new revision. Revision {q.current.revision_no} stays exactly as the customer received it.
      </Notice>
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
  const margin = can('margin.view');
  const values = can('values.view');
  const qs = meta.settings.quotation || {};

  const productById = useMemo(() => Object.fromEntries(meta.products.map((p) => [p.id, p])), [meta.products]);
  const [header, setHeader] = useState(() => (rev ? {
    customer: { id: existing.customer_id, company_name: existing.customer_name }, enquiry_id: existing.enquiry_id ? String(existing.enquiry_id) : '', contact_id: existing.contact_id ? String(existing.contact_id) : '',
    owner_id: existing.owner_id, subject: existing.subject || '', source_code: 'existing_customer', source_event: '', price_list: rev.price_list || existing.price_list || '', currency: rev.currency,
    validity_date: rev.validity_date || '', payment_terms: rev.payment_terms || '', delivery_terms: rev.delivery_terms || '', warranty_terms: rev.warranty_terms || '', notes: rev.notes || '', summary: rev.summary || '',
    freight: rev.freight_minor ? fromMinor(rev.freight_minor) : '', installation: rev.installation_minor ? fromMinor(rev.installation_minor) : '', change_note: rev.change_note || '',
  } : {
    customer: null, enquiry_id: initialEnquiryId || '', contact_id: '', owner_id: user.group === 'sales' ? user.id : null, subject: '', source_code: 'existing_customer', source_event: '',
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

  // Product details (configurator options) for products in use.
  const [details, setDetails] = useState({});
  useEffect(() => {
    for (const pid of new Set(lines.map((l) => l.product_id).filter(Boolean))) {
      if (!details[pid]) {
        setDetails((d) => ({ ...d, [pid]: { loading: true, options: [] } }));
        api.get(`/products/${pid}`).then((p) => setDetails((d) => ({ ...d, [pid]: { ...p.product, options: p.options.filter((o) => o.active) } }))).catch(() => {});
      }
    }
  }, [lines, details]);

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
    source_code: header.enquiry_id ? undefined : header.source_code, source_event: header.enquiry_id ? undefined : header.source_event,
    price_list: header.price_list || priceList, currency: header.currency || currency, validity_date: header.validity_date || undefined,
    payment_terms: header.payment_terms, delivery_terms: header.delivery_terms, warranty_terms: header.warranty_terms, notes: header.notes, summary: header.summary,
    freight: header.freight, installation: header.installation, lines: sent.map(toPayload),
  });
  const submit = (forApproval) => save.run(async (key) => {
    let quotationId = existing?.id;
    let revisionId = rev?.id;
    if (editing) {
      await api.put(`/quote-revisions/${rev.id}`, { ...body(), version: rev.version, change_note: header.change_note });
    } else {
      const r = await api.post('/quotations', body(), { key });
      quotationId = r.quotation_id;
      revisionId = r.revision_id;
    }
    setDirty(false);
    if (forApproval) {
      const a = await api.post(`/quote-revisions/${revisionId}/submit`);
      toast.success(a.approval_status === 'pending' ? 'Saved and sent for internal approval' : 'Saved — within policy, no approval needed');
    } else toast.success(editing ? 'Draft saved' : 'Draft quotation created');
    window.dispatchEvent(new Event('data:changed'));
    setTimeout(() => navigate(`/quotations/${quotationId}`), 0);
    return { quotationId };
  });

  const needsApproval = Boolean(preview?.approval_role);
  const contacts = (profile?.contacts || []).filter((c) => c.active || String(c.id) === header.contact_id);
  const openEnquiries = enquiries?.rows || [];

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, editing ? { label: existing.number, to: `/quotations/${existing.id}` } : null, { label: editing ? `Edit rev ${rev.revision_no}` : 'New' }].filter(Boolean)}
        title={editing ? `Edit ${existing.number} — revision ${rev.revision_no} (draft)` : 'New quotation'}
        subtitle="List prices, cost, minimum price, HSN and GST come from the product master for the chosen price list. A draft is not sent until it is issued."
        actions={<>
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button loading={save.saving} onClick={() => submit(false)} disabled={!customerId || !sent.length}>Save draft</Button>
          {needsApproval && <Button variant="primary" icon="send" loading={save.saving} onClick={() => submit(true)} disabled={!customerId || !sent.length}>Save &amp; ask for approval</Button>}
        </>} />
      {save.conflict && <Notice tone="warn" title="Someone else saved this draft first">Reload the page to see their version, then apply your change again.</Notice>}
      {save.error && !save.conflict && <Notice tone="danger">{save.error.message}</Notice>}

      <div className="split side-330">
        <div className="stack">
          <Card title="Customer & opportunity">
            <div className="form-grid">
              <Field label="Customer" required className="full" error={save.fields.customer_id}>
                {editing ? <div className="strong"><Link to={`/customers/${existing.customer_id}`}>{existing.customer_name}</Link></div>
                  : <CustomerPicker value={header.customer} allowCreate={false} onNewCustomer={() => {}} onChange={(c) => { firstCustomer.current = false; setH({ customer: c, enquiry_id: '', contact_id: '', price_list: '', currency: '' }); }} />}
              </Field>
              {!editing && customerId && (
                <Field label="Opportunity (enquiry)" className="full" hint={header.enquiry_id ? 'Open lines are copied and stay linked for conversion' : 'A linked enquiry is created automatically with the source below'} error={save.fields.enquiry_id}>
                  <Select value={header.enquiry_id} onChange={(e) => { setH({ enquiry_id: e.target.value }); loadEnquiry(e.target.value); }} placeholder="New opportunity — create an enquiry"
                    options={openEnquiries.map((e) => ({ value: String(e.id), label: `${e.code} · ${e.title || e.product || 'Enquiry'}${e.line_count > 1 ? ` +${e.line_count - 1}` : ''} — ${labelOf(ENQUIRY_STAGES, e.stage)}${e.quote_ref ? ` (has ${e.quote_ref})` : ''}` }))} />
                </Field>
              )}
              {editing && existing.enquiry_id && (
                <Field label="Opportunity" className="full"><span><Link to={`/enquiries/${existing.enquiry_id}`}>{existing.enquiry_code}</Link> <StageBadge stage={existing.enquiry_stage} size="sm" /></span></Field>
              )}
              {!editing && customerId && !header.enquiry_id && (
                <>
                  <Field label="Source" required error={save.fields.source_code}><OptionSelect category="enquiry_source" value={header.source_code} onChange={(v) => setH({ source_code: v })} /></Field>
                  <Field label="Source detail" optional error={save.fields.source_event}><Input value={header.source_event} onChange={(e) => setH({ source_event: e.target.value })} placeholder="e.g. event name or referrer" /></Field>
                </>
              )}
              <Field label="Contact person">
                <Select value={header.contact_id} onChange={(e) => setH({ contact_id: e.target.value })} placeholder={customerId ? 'No contact' : 'Choose the customer first'}
                  options={contacts.map((c) => ({ value: String(c.id), label: [c.name, c.role || c.designation].filter(Boolean).join(' — ') || c.email_raw || c.phone_raw }))} />
              </Field>
              <Field label="Owner"><UserSelect value={header.owner_id} onChange={(v) => setH({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
              <Field label="Subject" className="full" optional><Input value={header.subject} onChange={(e) => setH({ subject: e.target.value })} placeholder="e.g. Multifunction meters for the new LT panel" maxLength={160} /></Field>
            </div>
          </Card>

          <Card title="Lines" sub={`${labelOf(PRICE_LISTS, priceList)} · ${currency}`}>
            <div className="form-grid three mb-12">
              <Field label="Price list" hint={!header.price_list ? 'Automatic from the customer type' : undefined} error={save.fields.price_list}>
                <Select value={header.price_list} onChange={(e) => setH({ price_list: e.target.value })} placeholder={`Automatic (${labelOf(PRICE_LISTS, priceList)})`} options={PRICE_LISTS} />
              </Field>
              <Field label="Currency" hint={currency !== 'INR' ? 'Export: GST 0% unless changed; catalogue prices only apply in the price-list currency' : undefined} error={save.fields.currency}>
                <Select value={header.currency} onChange={(e) => setH({ currency: e.target.value })} placeholder={`Automatic (${currency})`} options={CURRENCIES} />
              </Field>
              <Field label="Valid until" error={save.fields.validity_date}><Input type="date" min={todayLocal()} value={header.validity_date} onChange={(e) => setH({ validity_date: e.target.value })} /></Field>
            </div>
            <div className="table-wrap">
              <table className="lines" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>Product &amp; configuration</th>
                    <th className="num" style={{ width: 86 }}>Qty</th>
                    <th className="num" style={{ width: 118 }}>Unit price</th>
                    <th className="num" style={{ width: 76 }}>Disc %</th>
                    <th className="num" style={{ width: 76 }}>GST %</th>
                    {values && <th className="num" style={{ width: 126 }}>Line value</th>}
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const pv = pvByKey[l.key];
                    const d = l.product_id ? details[l.product_id] : null;
                    const groups = d ? [...new Set(d.options.map((o) => o.group_name))] : [];
                    const below = pv && pv.min_price_minor && pv.net_unit_price_minor !== null && pv.net_unit_price_minor < pv.min_price_minor;
                    const lineMargin = pv && pv.cost_price_minor !== undefined && pv.cost_price_minor !== null && pv.line_total_minor > 0 ? ((pv.line_total_minor - pv.qty * pv.cost_price_minor) / pv.line_total_minor) * 100 : null;
                    const p = productById[l.product_id];
                    return (
                      <tr key={l.key} className={below ? 'line-warn' : ''}>
                        <td>
                          {l.custom ? (
                            <div className="stack-xs">
                              <Input placeholder="Non-catalogue item description" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} invalid={Boolean(pvErr(l, 'description'))} />
                              <div className="row">
                                <Input className="sm" placeholder="Specification" value={l.spec} onChange={(e) => setLine(l.key, { spec: e.target.value })} />
                                <Input className="sm" placeholder="HSN" value={l.hsn} onChange={(e) => setLine(l.key, { hsn: e.target.value })} style={{ maxWidth: 110 }} />
                                {margin && <Input className="sm" inputMode="decimal" placeholder="Unit cost" value={l.cost_price} onChange={(e) => setLine(l.key, { cost_price: e.target.value })} style={{ maxWidth: 120 }} />}
                              </div>
                              <span className="tiny warning-text">Non-catalogue items need sales head approval.</span>
                            </div>
                          ) : (
                            <div className="stack-xs">
                              <ProductSelect value={l.product_id} allowUnspecified={false} onChange={(v) => setLine(l.key, { product_id: v, option_ids: [], unit_price: '', description: '', spec: '', unit: '' })} invalid={Boolean(pvErr(l, 'product_id'))} />
                              {groups.map((g) => (
                                <div key={g} className="row small">
                                  <span className="muted" style={{ width: 104, flex: 'none' }}>{g}</span>
                                  <Select className="sm" aria-label={g} value={String(l.option_ids.find((oid) => d.options.find((o) => o.id === oid)?.group_name === g) || '')}
                                    onChange={(e) => {
                                      const others = l.option_ids.filter((oid) => d.options.find((o) => o.id === oid)?.group_name !== g);
                                      setLine(l.key, { option_ids: e.target.value ? [...others, Number(e.target.value)] : others });
                                    }}
                                    placeholder="Standard" options={d.options.filter((o) => o.group_name === g).map((o) => ({ value: String(o.id), label: `${o.name}${values && o.price_delta_minor ? ` (${o.price_delta_minor > 0 ? '+' : '−'}${fromMinor(Math.abs(o.price_delta_minor))})` : ''}` }))} />
                                </div>
                              ))}
                              {l.product_id && <Input className="sm" placeholder={p?.spec_hint ? `Variant note — ${p.spec_hint}` : 'Variant / specification note (optional)'} value={l.spec} onChange={(e) => setLine(l.key, { spec: e.target.value })} />}
                              {pv && <div className="tiny muted">{[values && pv.list_price_minor !== null && pv.list_price_minor !== undefined ? `List ${money(pv.list_price_minor, currency)}` : null, pv.spec && !l.spec ? pv.spec : null, pv.hsn ? `HSN ${pv.hsn}` : null, pv.lead_time_days !== null && pv.lead_time_days !== undefined ? `lead time ${pv.lead_time_days} days (indicative)` : null].filter(Boolean).join(' · ')}</div>}
                              {p && p.price_currency !== currency && <div className="tiny warning-text">Price list is in {p.price_currency} — enter the {currency} price.</div>}
                            </div>
                          )}
                          {below && <div className="tiny danger-text strong mt-8">Below the minimum selling price — needs approval</div>}
                          {pvErr(l, 'qty') && <div className="tiny danger-text">{pvErr(l, 'qty')}</div>}
                          {pvErr(l, 'unit_price') && <div className="tiny danger-text">{pvErr(l, 'unit_price')}</div>}
                        </td>
                        <td>
                          <Input type="number" min={0} step={p?.integer_qty ? 1 : 'any'} className="num" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} invalid={Boolean(pvErr(l, 'qty'))} aria-label="Quantity" />
                          <div className="tiny muted mt-8">{pv?.unit || p?.default_unit || 'pcs'}</div>
                        </td>
                        <td><Input inputMode="decimal" className="num" placeholder={pv?.list_price_minor !== null && pv?.list_price_minor !== undefined ? fromMinor(pv.list_price_minor) : 'Price'} value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} invalid={Boolean(pvErr(l, 'unit_price'))} aria-label="Unit price" /></td>
                        <td><Input type="number" min={0} max={100} step="0.5" className="num" placeholder="0" value={l.discount_pct} onChange={(e) => setLine(l.key, { discount_pct: e.target.value })} aria-label="Discount percent" /></td>
                        <td><Input type="number" min={0} max={40} step="0.5" className="num" placeholder={pv ? String(pv.gst_rate) : ''} value={l.gst_rate} onChange={(e) => setLine(l.key, { gst_rate: e.target.value })} aria-label="GST percent" /></td>
                        {values && <td className="num">{pv ? <><strong><Money minor={pv.line_total_minor} currency={currency} /></strong>{pv.discount_pct > 0 && <div className="tiny muted">{number(pv.discount_pct, 1)}% off</div>}{margin && lineMargin !== null && <div className={`tiny ${lineMargin < (meta.settings.approvals?.minMarginPct ?? 0) ? 'danger-text strong' : 'muted'}`}>margin {pct(lineMargin)}</div>}</> : '—'}</td>}
                        <td><Button size="sm" variant="ghost" icon="trash" aria-label="Remove line" onClick={() => { setDirty(true); setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()])); }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row wrap mt-12">
              <Button size="sm" icon="plus" onClick={() => setLines((ls) => [...ls, newLine()])}>Add product</Button>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setLines((ls) => [...ls, newLine({ custom: true })])}>Non-catalogue item</Button>
            </div>
            {save.fields.lines && <Notice tone="danger">{save.fields.lines}</Notice>}
            {previewError && <Notice tone="danger">Pricing preview failed: {previewError}</Notice>}
          </Card>

          <Card title="Commercial terms">
            <div className="form-grid">
              <Field label={`Freight (${currency})`} optional hint={currency === 'INR' ? `GST ${qs.freightGstRate ?? 18}% applies` : undefined}><Input inputMode="decimal" value={header.freight} onChange={(e) => setH({ freight: e.target.value })} /></Field>
              <Field label={`Installation (${currency})`} optional><Input inputMode="decimal" value={header.installation} onChange={(e) => setH({ installation: e.target.value })} /></Field>
              <Field label="Payment terms"><Input value={header.payment_terms} onChange={(e) => setH({ payment_terms: e.target.value })} /></Field>
              <Field label="Delivery (indicative)" hint="Not a dispatch commitment"><Input value={header.delivery_terms} onChange={(e) => setH({ delivery_terms: e.target.value })} /></Field>
              <Field label="Warranty" className="full"><Input value={header.warranty_terms} onChange={(e) => setH({ warranty_terms: e.target.value })} /></Field>
              <Field label="Notes for the customer" optional className="full"><Textarea rows={2} value={header.notes} onChange={(e) => setH({ notes: e.target.value })} maxLength={1000} /></Field>
              <Field label="Internal summary" optional className="full" hint="Recorded with the revision; enough to issue without attaching a PDF"><Textarea rows={2} value={header.summary} onChange={(e) => setH({ summary: e.target.value })} maxLength={1000} /></Field>
              {editing && rev.revision_no > 1 && <Field label="What changed in this revision" optional className="full"><Input value={header.change_note} onChange={(e) => setH({ change_note: e.target.value })} placeholder="e.g. Discount revised after negotiation" /></Field>}
            </div>
          </Card>
        </div>

        <div className="stack sticky-side">
          <Card title="Summary" sub={currency}>
            {!totals ? <div className="muted small">Add a product and a quantity to see prices, GST and the approval check.</div> : (
              <div className="stack-sm">
                {values ? (
                  <div className="totals">
                    {totals.list_total_minor !== null && totals.list_total_minor !== undefined && <><span className="muted">At list price</span><span className="num"><Money minor={totals.list_total_minor} currency={currency} /></span></>}
                    <span className="muted">Discount</span><span className="num">{totals.discount_total_minor ? <>−<Money minor={totals.discount_total_minor} currency={currency} /></> : '—'}</span>
                    {totals.freight_minor > 0 && <><span className="muted">Freight</span><span className="num"><Money minor={totals.freight_minor} currency={currency} /></span></>}
                    {totals.installation_minor > 0 && <><span className="muted">Installation</span><span className="num"><Money minor={totals.installation_minor} currency={currency} /></span></>}
                    <span>Total before tax</span><span className="num strong"><Money minor={totals.total_minor} currency={currency} /></span>
                    <span className="muted">GST</span><span className="num"><Money minor={totals.tax_total_minor} currency={currency} /></span>
                    <span className="grand">Grand total</span><span className="grand num"><Money minor={totals.grand_total_minor} currency={currency} /></span>
                  </div>
                ) : <div className="muted small">Commercial values are hidden for your role.</div>}
                {totals.total_minor === null && <Notice tone="warn">Some lines have no quantity or price — totals stay unknown until they are filled.</Notice>}
                <div className="divider" />
                <div className="row between small"><span className="muted">Overall discount vs list</span><strong>{pct(totals.discount_pct)}</strong></div>
                {margin && totals.margin_pct !== undefined && <div className="row between small"><span className="muted">Margin</span><strong className={totals.margin_pct !== null && totals.margin_pct < (meta.settings.approvals?.minMarginPct ?? 0) ? 'danger-text' : ''}>{totals.margin_pct === null ? 'Unknown (cost missing)' : pct(totals.margin_pct)}</strong></div>}
              </div>
            )}
          </Card>
          <Card title="Approval check">
            {!preview ? <div className="muted small">Shown once the lines are priced.</div> : needsApproval ? (
              <div className="stack-sm">
                <Notice tone="warn" title={`Needs approval by ${labelOf(ROLES, preview.approval_role)} or above`}>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{preview.approval_reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                </Notice>
                <div className="small muted">{meta.settings.approvals?.requireBeforeIssue ? 'It cannot be issued to the customer until approved.' : 'Approval is recorded but issuing is not blocked.'}</div>
              </div>
            ) : <Notice tone="success" title="Within policy">No approval needed at these prices.</Notice>}
            {preview?.large && <Notice tone="info">Large quotation — management and the sales head are told when it is issued.</Notice>}
            {editing && rev.approval_status && rev.approval_status !== 'not_required' && <div className="mt-8 small">Current draft status: <ApprovalBadge status={rev.approval_status} size="sm" /> {['approved', 'rejected'].includes(rev.approval_status) && 'Saving changes clears the earlier decision.'}</div>}
          </Card>
          <SaveStatus save={save} />
        </div>
      </div>
    </div>
  );
}

