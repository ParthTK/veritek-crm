// Quotations: one quotation per opportunity with immutable issued revisions. Each revision carries a priced
// line snapshot built from the product master and price list (configurator options, discounts, GST, cost
// and margin), an internal approval when discounts or margins go beyond policy, the issue evidence (sent
// time, channel, document or summary) and the outcome. Conversion to an order links the exact revision.
import { all, get, insert, run, tx, update, updateVersioned } from '../db.js';
import {
  Check, badRequest, conflict, forbidden, notFound, now, nowIso, today, str, intId, bool, num, checkOption, optionLabel, nextCode, audit, history,
  notify, notifyRoles, settings, token, likeTerm, paginate, parseJson,
} from '../util.js';
import { isInstant, addDays } from '../../shared/dates.js';
import { quoteTracking,
  OPEN_ENQUIRY_STAGES, CURRENCIES, PRICE_LISTS, QUOTE_STATUSES, ROLES, roleRank, can, labelOf, groupOf,
} from '../../shared/constants.js';
import { round3, toMinor, formatMoney } from '../../shared/rules.js';
import { hasPerm } from '../auth.js';
import { quotationScope } from '../access.js';
import { createTask, recordActivity, validateTaskInput } from './tasks.js';
import { linkAttachment, attachmentsFor } from './attachments.js';
import { changeStage, applyConvertedQuantities, maybeMarkWon, createEnquiry } from './enquiries.js';
import { createOrder } from './orders.js';
import { listPriceMinor } from './products.js';

// ------------------------------------------------------------------ pricing
export function priceListForCustomer(customer) {
  const types = parseJson(customer?.types, []);
  if (types.includes('distributor')) return 'distributor';
  if (types.includes('dealer')) return 'dealer';
  return 'standard';
}

export function defaultCurrency(customer) {
  if (!customer || customer.segment !== 'export') return 'INR';
  return customer.country_code === 'AE' ? 'AED' : 'USD';
}

const pct = (n) => `${Math.round(n * 10) / 10}%`;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Normalises quoted lines against the product master. List price, cost, minimum price, HSN and GST come
 * from the master (plus configurator options) when the quotation is in the price-list currency; users set
 * quantity, selling price and discount. Non-catalogue lines carry what the user entered.
 */
export function normaliseLines(c, rawLines, { priceList = 'standard', currency = 'INR', requireQty = false } = {}) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    c.fail('lines', 'Add at least one quoted line');
    return [];
  }
  const freightCurrencyMatches = (p) => (p.price_currency || 'INR') === currency;
  return rawLines.map((l, i) => {
    const productId = intId(l.product_id);
    const product = productId ? get('SELECT * FROM products WHERE id = ?', productId) : null;
    if (productId && !product) c.fail(`lines.${i}.product_id`, 'Choose a product from the list');
    const qtyRaw = l.qty === '' || l.qty === null || l.qty === undefined ? null : Number(l.qty);
    if (qtyRaw !== null && (!Number.isFinite(qtyRaw) || qtyRaw <= 0)) c.fail(`lines.${i}.qty`, 'Quantity must be greater than zero');
    if (requireQty && qtyRaw === null) c.fail(`lines.${i}.qty`, 'Quantity is needed before issue');
    if (qtyRaw && product?.integer_qty && !Number.isInteger(qtyRaw)) c.fail(`lines.${i}.qty`, 'Whole pieces only for this product');
    const qty = qtyRaw === null ? null : round3(qtyRaw);
    // Configurator options (only for catalogue products).
    const cfg = typeof l.config === 'string' ? parseJson(l.config, {}) : l.config || {};
    const optionIds = (l.option_ids || cfg?.options?.map((o) => o.id) || []).map(Number).filter(Boolean);
    const options = product && optionIds.length
      ? all(`SELECT * FROM product_options WHERE product_id = ? AND id IN (${optionIds.map(() => '?').join(',')})`, product.id, ...optionIds)
      : [];
    const sameCurrency = product ? freightCurrencyMatches(product) : false;
    const priceDelta = options.reduce((s, o) => s + o.price_delta_minor, 0);
    const costDelta = options.reduce((s, o) => s + o.cost_delta_minor, 0);
    const baseList = product && sameCurrency ? listPriceMinor(product, priceList) : null;
    const list = baseList === null || baseList === undefined ? null : baseList + priceDelta;
    const cost = product && sameCurrency && product.cost_price_minor !== null ? product.cost_price_minor + costDelta : (!product ? (toMinor(l.cost_price) ?? null) : null);
    const minRatio = product?.standard_price_minor ? (product.min_price_minor || 0) / product.standard_price_minor : 0;
    const min = product && sameCurrency && product.min_price_minor ? Math.round(product.min_price_minor + priceDelta * minRatio) : null;
    // Selling price: what the user entered, else the list price.
    let price = l.unit_price === undefined || l.unit_price === '' || l.unit_price === null ? (l.unit_price_minor ?? null) : toMinor(l.unit_price);
    if (price === null && list !== null) price = list;
    if (Number.isNaN(price) || (price !== null && price < 0)) {
      c.fail(`lines.${i}.unit_price`, 'Enter a valid price (up to 2 decimals)');
      price = null;
    }
    const discount = Math.min(Math.max(num(l.discount_pct) ?? 0, 0), 100);
    const gstDefault = currency === 'INR' ? (product?.gst_rate ?? 18) : 0;
    const gst = l.gst_rate === undefined || l.gst_rate === '' || l.gst_rate === null ? gstDefault : Math.min(Math.max(num(l.gst_rate) ?? 0, 0), 40);
    const description = str(l.description, 300) || product?.name || str(l.requirement, 300);
    if (!description && !productId) c.fail(`lines.${i}.description`, 'Describe the quoted item');
    const optionText = options.map((o) => `${o.group_name}: ${o.name}`).join('; ');
    const spec = l.spec !== undefined && l.spec !== null && l.spec !== '' ? str(l.spec, 300) : [product?.model, optionText].filter(Boolean).join(' | ') || null;
    const gross = qty === null || price === null ? null : Math.round(qty * price);
    const taxable = gross === null ? null : Math.round(gross * (1 - discount / 100));
    return {
      index: i,
      enquiry_line_id: intId(l.enquiry_line_id),
      product_id: productId,
      product_code: product?.code ?? str(l.product_code, 40) ?? null,
      description: description || 'Unspecified item',
      spec,
      hsn: product?.hsn ?? str(l.hsn, 20),
      qty,
      unit: str(l.unit, 20) || product?.default_unit || 'pcs',
      list_price_minor: list,
      unit_price_minor: price,
      discount_pct: discount,
      net_unit_price_minor: price === null ? null : Math.round(price * (1 - discount / 100)),
      gst_rate: gst,
      cost_price_minor: cost,
      min_price_minor: min,
      lead_time_days: product?.lead_time_days !== null && product?.lead_time_days !== undefined ? product.lead_time_days + options.reduce((s, o) => s + o.lead_time_delta, 0) : null,
      config: options.length ? { options: options.map((o) => ({ id: o.id, option_id: o.id, group: o.group_name, name: o.name, price_delta_minor: o.price_delta_minor })) } : null,
      custom: !productId,
      gross_minor: gross,
      line_total_minor: taxable,
      tax_minor: taxable === null ? null : Math.round((taxable * gst) / 100),
    };
  });
}

/** Totals, margin, effective discount and the approval level the numbers require. Unknown quantities or prices leave totals unknown. */
export function computeQuote(lines, header = {}, currency = 'INR') {
  const cfg = settings().approvals;
  const freightGst = currency === 'INR' ? settings().quotation.freightGstRate : 0;
  const complete = lines.length > 0 && lines.every((l) => l.line_total_minor !== null);
  let listTotal = 0;
  let subtotal = 0;
  let discountTotal = 0;
  let taxable = 0;
  let tax = 0;
  let cost = 0;
  let costKnown = true;
  let listKnown = true;
  let maxLineDisc = 0;
  let belowMin = false;
  let hasCustom = false;
  for (const l of lines) {
    if (l.custom) hasCustom = true;
    if (l.line_total_minor === null) continue;
    const listUnit = l.list_price_minor ?? null;
    if (listUnit === null) listKnown = false;
    listTotal += Math.round(l.qty * (listUnit ?? l.unit_price_minor));
    subtotal += l.gross_minor;
    discountTotal += l.gross_minor - l.line_total_minor;
    taxable += l.line_total_minor;
    tax += l.tax_minor;
    if (l.cost_price_minor === null) costKnown = false;
    else cost += Math.round(l.qty * l.cost_price_minor);
    if (listUnit) {
      const lineDisc = (1 - l.net_unit_price_minor / listUnit) * 100;
      if (lineDisc > maxLineDisc) maxLineDisc = lineDisc;
    } else if (l.discount_pct > maxLineDisc) maxLineDisc = l.discount_pct;
    if (l.min_price_minor && l.net_unit_price_minor < l.min_price_minor) belowMin = true;
  }
  const freight = toMinor(header.freight) || header.freight_minor || 0;
  const installation = toMinor(header.installation) || header.installation_minor || 0;
  const extras = (Number.isNaN(freight) ? 0 : freight) + (Number.isNaN(installation) ? 0 : installation);
  const extraTax = Math.round((extras * freightGst) / 100);
  const productTaxable = taxable;
  const margin = complete && costKnown && productTaxable > 0 ? ((productTaxable - cost) / productTaxable) * 100 : null;
  const discountPct = complete && listTotal > 0 ? ((listTotal - productTaxable) / listTotal) * 100 : (lines.length ? Math.max(...lines.map((l) => l.discount_pct)) : 0);

  const reasons = [];
  let role = null;
  const bump = (r) => {
    if (!role || roleRank(r) > roleRank(role)) role = r;
  };
  if (discountPct > cfg.discountHeadPct) {
    reasons.push(`Overall discount ${pct(discountPct)} exceeds ${cfg.discountHeadPct}%`);
    bump('sales_head');
  } else if (discountPct > cfg.discountManagerPct) {
    reasons.push(`Overall discount ${pct(discountPct)} exceeds ${cfg.discountManagerPct}%`);
    bump('regional_manager');
  }
  if (maxLineDisc > cfg.discountHeadPct && discountPct <= cfg.discountHeadPct) {
    reasons.push(`A line discount of ${pct(maxLineDisc)} exceeds ${cfg.discountHeadPct}%`);
    bump('sales_head');
  } else if (maxLineDisc > cfg.discountManagerPct && discountPct <= cfg.discountManagerPct) {
    reasons.push(`A line discount of ${pct(maxLineDisc)} exceeds ${cfg.discountManagerPct}%`);
    bump('regional_manager');
  }
  if (margin !== null && margin < cfg.minMarginPct) {
    reasons.push(`Margin ${pct(margin)} is below the ${cfg.minMarginPct}% floor`);
    bump('sales_head');
  }
  if (belowMin) {
    reasons.push('One or more items are priced below the minimum selling price');
    bump(cfg.belowMinPriceRole || 'management');
  }
  if (hasCustom) {
    reasons.push('Contains non-catalogue items');
    bump('sales_head');
  }
  const total = complete ? productTaxable + extras : null;
  return {
    lines,
    totals: {
      list_total_minor: complete && listKnown ? listTotal : null,
      subtotal_minor: complete ? subtotal : null,
      discount_total_minor: complete ? discountTotal : null,
      freight_minor: Number.isNaN(freight) ? 0 : freight,
      installation_minor: Number.isNaN(installation) ? 0 : installation,
      total_minor: total,
      tax_total_minor: complete ? tax + extraTax : null,
      grand_total_minor: complete ? total + tax + extraTax : null,
      cost_total_minor: complete && costKnown ? cost : null,
      margin_pct: margin === null ? null : r2(margin),
      discount_pct: r2(discountPct),
      max_line_discount_pct: r2(maxLineDisc),
      below_min_price: belowMin ? 1 : 0,
    },
    approval_role: role,
    approval_reasons: reasons,
    large: currency === 'INR' && total !== null && total + tax >= (cfg.largeQuotationValue || Infinity) * 100,
  };
}

/**
 * Keeps every quoted line tied to its enquiry line so conversion can credit the opportunity. Lines that
 * arrive without the link inherit it from the previous revision, else match an open enquiry line by product.
 */
function linkEnquiryLines(lines, enquiryId, previous = []) {
  if (!enquiryId) return lines;
  const enquiryLines = all('SELECT id, product_id FROM enquiry_lines WHERE enquiry_id = ? ORDER BY sort, id', enquiryId);
  const valid = new Set(enquiryLines.map((x) => x.id));
  const used = new Set(lines.map((l) => l.enquiry_line_id).filter((x) => x && valid.has(x)));
  for (const l of lines) {
    if (l.enquiry_line_id && valid.has(l.enquiry_line_id)) continue;
    l.enquiry_line_id = null;
    const prev = previous.find((p) => p.enquiry_line_id && valid.has(p.enquiry_line_id) && !used.has(p.enquiry_line_id)
      && (l.product_id ? p.product_id === l.product_id : !p.product_id && p.description === l.description));
    const match = prev ? prev.enquiry_line_id : enquiryLines.find((x) => !used.has(x.id) && l.product_id && x.product_id === l.product_id)?.id;
    if (match) {
      l.enquiry_line_id = match;
      used.add(match);
    }
  }
  return lines;
}

function headerFrom(input, fallback = {}) {
  const qs = settings().quotation;
  const pick = (k, d) => (input[k] !== undefined ? input[k] : fallback[k] !== undefined && fallback[k] !== null ? fallback[k] : d);
  return {
    payment_terms: str(pick('payment_terms', qs.defaultPaymentTerms), 300),
    delivery_terms: str(pick('delivery_terms', qs.defaultDelivery), 300),
    warranty_terms: str(pick('warranty_terms', qs.defaultWarranty), 300),
    notes: str(pick('notes', null), 1000),
    summary: str(pick('summary', null), 1000),
  };
}

function revisionFields(calc, header, extra = {}) {
  return {
    ...header,
    lines: JSON.stringify(calc.lines),
    ...calc.totals,
    approval_role: calc.approval_role,
    approval_reasons: JSON.stringify(calc.approval_reasons),
    approval_status: calc.approval_role ? 'required' : 'not_required',
    approved_by: null,
    approved_at: null,
    ...extra,
  };
}

// ------------------------------------------------------------------ create & edit
/**
 * Creates a quotation with a draft revision 1. A quotation belongs to an enquiry: when started from the
 * quotation builder without one, a linked enquiry is created first (source required, as for any enquiry).
 */
export function createQuotation(input, user) {
  let enquiryId = intId(input.enquiry_id);
  let e = enquiryId ? get('SELECT * FROM enquiries WHERE id = ?', enquiryId) : null;
  if (enquiryId && !e) throw badRequest('Enquiry not found', { enquiry_id: 'Choose the enquiry' });
  if (e && !OPEN_ENQUIRY_STAGES.includes(e.stage)) throw conflict('Reopen the enquiry (or create a linked new enquiry) before quoting');
  const customerId = e?.customer_id ?? intId(input.customer_id);
  const customer = customerId ? get('SELECT * FROM customers WHERE id = ?', customerId) : null;
  if (!customer) throw badRequest('Choose the customer', { customer_id: 'Choose the customer' });
  const c = new Check();
  const priceList = input.price_list || priceListForCustomer(customer);
  if (!PRICE_LISTS.some((p) => p.value === priceList)) c.fail('price_list', 'Choose a price list');
  const currency = input.currency || defaultCurrency(customer);
  if (!CURRENCIES.includes(currency)) c.fail('currency', 'Choose a currency');
  const source = input.lines?.length ? input.lines : e ? all(`SELECT el.id AS enquiry_line_id, el.product_id, el.requirement, el.spec, el.qty, el.unit, p.name AS description
    FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = ? AND el.outcome = 'open' ORDER BY el.sort, el.id`, e.id)
    .map((l) => ({ ...l, description: l.description || l.requirement })) : [];
  const lines = linkEnquiryLines(normaliseLines(c, source, { priceList, currency }), e?.id);
  if (input.validity_date) c.date('validity_date', input.validity_date);
  if (!e) checkOption(c, 'source_code', 'enquiry_source', input.source_code || 'existing_customer', { note: input.source_event, noteField: 'source_event' });
  if (!e && input.source_code === 'exhibition') {
    const campaign = intId(input.campaign_id) ? get('SELECT type FROM campaigns WHERE id = ?', intId(input.campaign_id)) : null;
    if (campaign?.type !== 'exhibition') c.fail('campaign_id', 'Choose the exhibition this enquiry came from');
  }
  c.throwIfAny();
  const header = headerFrom(input);
  const calc = computeQuote(lines, input, currency);
  return tx(() => {
    if (!e) {
      const created = createEnquiry({
        customer_id: customerId, contact_id: intId(input.contact_id), owner_id: intId(input.owner_id) || customer.owner_id || user.id,
        source_code: input.source_code || 'existing_customer', source_event: input.source_event, campaign_id: input.campaign_id || undefined, title: str(input.subject, 160),
        lines: lines.map((l) => ({ product_id: l.product_id, requirement: l.product_id ? undefined : l.description, spec: l.spec, qty: l.qty, unit: l.unit })),
        next: { purpose: 'Send quotation', owner_id: intId(input.owner_id) || customer.owner_id || user.id, due_date: today() },
        requirement_note: 'Created from the quotation builder',
      }, user);
      enquiryId = created.id;
      e = get('SELECT * FROM enquiries WHERE id = ?', enquiryId);
      const enquiryLines = all('SELECT id FROM enquiry_lines WHERE enquiry_id = ? ORDER BY sort, id', enquiryId);
      calc.lines.forEach((l, i) => { l.enquiry_line_id = enquiryLines[i]?.id ?? null; });
    }
    const stamp = nowIso();
    const qid = insert('quotations', {
      number: nextCode('Q'), enquiry_id: enquiryId, customer_id: customerId, contact_id: intId(input.contact_id) || e.contact_id, subject: str(input.subject, 160) || e.title || null,
      owner_id: intId(input.owner_id) || e.owner_id, price_list: priceList, public_token: token(18), prepared_by: user.id, created_at: stamp, updated_at: stamp,
    });
    const rid = insert('quote_revisions', {
      quotation_id: qid, revision_no: 1, status: 'draft', currency, price_list: priceList, change_note: 'Initial quotation',
      ...revisionFields(calc, header), validity_date: input.validity_date || addDays(today(), settings().quotation.defaultValidityDays || 30),
      created_by: user.id, created_at: stamp, updated_at: stamp,
    });
    if (['new', 'clarification'].includes(e.stage)) {
      run("UPDATE enquiries SET stage = 'quote_to_prepare', updated_at = ?, version = version + 1 WHERE id = ?", stamp, enquiryId);
      history('enquiry', enquiryId, 'stage_changed', { customerId, data: { from: e.stage, to: 'quote_to_prepare' } });
    }
    audit('quotation', qid, 'create', { enquiry_id: enquiryId, revision_id: rid, total_minor: calc.totals.total_minor, currency });
    return { quotation_id: qid, revision_id: rid, enquiry_id: enquiryId };
  });
}

function loadRevision(id) {
  const r = get(`SELECT r.*, q.number, q.enquiry_id, q.customer_id, q.contact_id, q.owner_id, q.subject FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE r.id = ?`, id);
  if (!r) throw notFound('Quotation revision');
  return { ...r, lines: JSON.parse(r.lines || '[]'), approval_reasons: parseJson(r.approval_reasons, []) };
}

/** Only drafts can change; an issued revision is immutable (a change means a new revision). */
export function updateDraft(revisionId, input, user) {
  const r = loadRevision(revisionId);
  if (r.status !== 'draft') throw conflict('Issued revisions cannot be changed. Create a new revision instead.');
  if (input.version !== undefined && Number(input.version) !== r.version) throw conflict('Someone else updated this draft.', { code: 'version_conflict' });
  if (r.approval_status === 'pending') throw conflict('This revision is awaiting approval. Withdraw it from approval before editing.');
  const c = new Check();
  const currency = input.currency || r.currency;
  if (!CURRENCIES.includes(currency)) c.fail('currency', 'Choose a currency');
  const priceList = input.price_list || r.price_list || 'standard';
  if (!PRICE_LISTS.some((p) => p.value === priceList)) c.fail('price_list', 'Choose a price list');
  const lines = linkEnquiryLines(normaliseLines(c, input.lines || r.lines, { priceList, currency }), r.enquiry_id, r.lines);
  if (input.validity_date) c.date('validity_date', input.validity_date);
  c.throwIfAny();
  const calc = computeQuote(lines, {
    freight: input.freight, installation: input.installation,
    freight_minor: input.freight === undefined ? r.freight_minor : undefined, installation_minor: input.installation === undefined ? r.installation_minor : undefined,
  }, currency);
  const header = headerFrom(input, r);
  const fields = { ...revisionFields(calc, header), currency, price_list: priceList, updated_at: nowIso() };
  if (input.validity_date !== undefined) fields.validity_date = input.validity_date || null;
  if (input.change_note !== undefined) fields.change_note = str(input.change_note, 300);
  return tx(() => {
    if (!updateVersioned('quote_revisions', revisionId, r.version, fields)) throw conflict('Someone else updated this draft.', { code: 'version_conflict' });
    if (input.subject !== undefined || input.contact_id !== undefined || input.owner_id !== undefined || input.price_list !== undefined) {
      update('quotations', r.quotation_id, {
        subject: input.subject !== undefined ? str(input.subject, 160) : undefined, contact_id: input.contact_id !== undefined ? intId(input.contact_id) : undefined,
        owner_id: input.owner_id !== undefined ? intId(input.owner_id) : undefined, price_list: priceList, updated_at: nowIso(),
      });
    }
    audit('quote_revision', revisionId, 'update_draft', { total_minor: calc.totals.total_minor, approval_role: calc.approval_role });
    return { revision_id: revisionId, approval_role: calc.approval_role, approval_reasons: calc.approval_reasons };
  });
}

/** Starts a new draft revision from the latest one (re-checked against today's price master only if asked). */
export function newRevision(quotationId, user, input = {}) {
  const q = get('SELECT * FROM quotations WHERE id = ?', quotationId);
  if (!q) throw notFound('Quotation');
  if (get("SELECT id FROM quote_revisions WHERE quotation_id = ? AND status = 'draft'", quotationId)) throw conflict('A draft revision already exists — edit and issue it');
  const last = get('SELECT * FROM quote_revisions WHERE quotation_id = ? ORDER BY revision_no DESC LIMIT 1', quotationId);
  if (last.status === 'accepted' && get('SELECT id FROM orders WHERE quote_revision_id = ? LIMIT 1', last.id)) {
    throw conflict('This revision was accepted and converted. Start a new linked enquiry for a fresh requirement.');
  }
  const stamp = nowIso();
  const lines = JSON.parse(last.lines || '[]');
  const calc = computeQuote(normaliseLines(new Check(), lines, { priceList: last.price_list || q.price_list, currency: last.currency }), last, last.currency);
  const id = insert('quote_revisions', {
    quotation_id: quotationId, revision_no: last.revision_no + 1, status: 'draft', currency: last.currency, price_list: last.price_list || q.price_list,
    ...revisionFields(calc, headerFrom({}, last)), change_note: str(input.change_note, 300) || `Revision ${last.revision_no + 1}`,
    validity_date: addDays(today(), settings().quotation.defaultValidityDays || 30), created_by: user.id, created_at: stamp, updated_at: stamp,
  });
  audit('quote_revision', id, 'create', { quotation_id: quotationId, revision_no: last.revision_no + 1 });
  return { revision_id: id };
}

// ------------------------------------------------------------------ approvals
/** Who is asked to approve: the regional manager of the customer's region, else the next level up. */
function approversFor(requiredRole, customer) {
  const chain = ['regional_manager', 'sales_head', 'management', 'super_admin'];
  for (const role of chain.slice(Math.max(0, chain.indexOf(requiredRole)))) {
    const ids = all(`SELECT id FROM users WHERE active = 1 AND login_enabled = 1 AND role = ? ${role === 'regional_manager' ? 'AND region_id = ?' : ''}`, ...(role === 'regional_manager' ? [role, customer.region_id ?? -1] : [role])).map((u) => u.id);
    if (ids.length) return ids;
  }
  return [];
}

export function canDecide(user, approval, customer) {
  if (!approval || approval.status !== 'pending') return false;
  if (!can(user.role, 'quotes.approve') || roleRank(user.role) < roleRank(approval.required_role)) return false;
  if (user.role === 'regional_manager' && customer?.region_id !== user.region_id) return false;
  return true;
}

export function submitForApproval(revisionId, user) {
  const r = loadRevision(revisionId);
  if (r.status !== 'draft') throw conflict('Only a draft revision goes for approval');
  if (!r.approval_role) return { revision_id: revisionId, approval_status: 'not_required' };
  if (r.approval_status === 'pending') return { revision_id: revisionId, approval_status: 'pending' };
  if (r.approval_status === 'approved') return { revision_id: revisionId, approval_status: 'approved' };
  if (r.lines.some((l) => l.qty === null || l.unit_price_minor === null)) throw badRequest('Complete quantities and prices before asking for approval', { lines: 'Quantity and price are needed on every line' });
  const customer = get('SELECT * FROM customers WHERE id = ?', r.customer_id);
  return tx(() => {
    const stamp = nowIso();
    run("UPDATE approvals SET status = 'withdrawn', decided_at = ? WHERE entity_type = 'quote_revision' AND entity_id = ? AND status = 'pending'", stamp, revisionId);
    const approvalId = insert('approvals', {
      entity_type: 'quote_revision', entity_id: revisionId, revision_id: revisionId, required_role: r.approval_role, reasons: JSON.stringify(r.approval_reasons),
      amount_minor: r.total_minor, currency: r.currency, status: 'pending', requested_by: user.id, requested_at: stamp,
    });
    update('quote_revisions', revisionId, { approval_status: 'pending', updated_at: stamp, version: r.version + 1 });
    for (const uid of approversFor(r.approval_role, customer)) {
      notify(uid, {
        title: `Approval needed: ${r.number} rev ${r.revision_no} — ${customer.company_name}`, message: r.approval_reasons.join('; '),
        link: `/quotations/${r.quotation_id}`, severity: 'warning', dedupeKey: `approval:${approvalId}`,
      });
    }
    history('quotation', r.quotation_id, 'approval_requested', { customerId: r.customer_id, data: { revision: r.revision_no, role: r.approval_role }, note: r.approval_reasons.join('; ') });
    audit('approval', approvalId, 'request', { revision_id: revisionId, required_role: r.approval_role });
    return { revision_id: revisionId, approval_status: 'pending', approval_id: approvalId };
  });
}

export function withdrawApproval(revisionId, user) {
  const r = loadRevision(revisionId);
  if (r.approval_status !== 'pending') throw conflict('This revision is not awaiting approval');
  return tx(() => {
    run("UPDATE approvals SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE entity_type = 'quote_revision' AND entity_id = ? AND status = 'pending'", user.id, nowIso(), revisionId);
    update('quote_revisions', revisionId, { approval_status: 'required', updated_at: nowIso(), version: r.version + 1 });
    audit('quote_revision', revisionId, 'approval_withdrawn', {});
    return { revision_id: revisionId };
  });
}

export function decideApproval(approvalId, input, user) {
  const a = get('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a) throw notFound('Approval');
  if (a.status !== 'pending') throw conflict('This approval is no longer pending');
  const r = loadRevision(a.entity_id);
  const customer = get('SELECT * FROM customers WHERE id = ?', r.customer_id);
  if (!canDecide(user, a, customer)) {
    throw forbidden(user.role === 'regional_manager' && customer.region_id !== user.region_id ? 'This quotation belongs to another region' : `Requires ${labelOf(ROLES, a.required_role)} or above`);
  }
  const decision = input.decision;
  const c = new Check();
  if (!['approved', 'rejected'].includes(decision)) c.fail('decision', 'Approve or reject');
  if (decision === 'rejected') c.text('comments', input.comments, { required: true, max: 500, label: 'Reason for rejecting' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    update('approvals', approvalId, { status: decision, decided_by: user.id, decided_at: stamp, comments: str(input.comments, 500) });
    update('quote_revisions', r.id, { approval_status: decision, approved_by: decision === 'approved' ? user.id : null, approved_at: decision === 'approved' ? stamp : null, updated_at: stamp, version: r.version + 1 });
    for (const uid of new Set([a.requested_by, r.owner_id].filter(Boolean))) {
      notify(uid, {
        title: `${r.number} rev ${r.revision_no} ${decision === 'approved' ? 'approved' : 'rejected'} by ${user.name}`,
        message: str(input.comments, 300) || (decision === 'approved' ? 'You can now issue it to the customer' : ''),
        link: `/quotations/${r.quotation_id}`, severity: decision === 'approved' ? 'success' : 'warning', dedupeKey: `approval_decision:${approvalId}`,
      });
    }
    history('quotation', r.quotation_id, decision === 'approved' ? 'approved' : 'approval_rejected', { customerId: r.customer_id, data: { revision: r.revision_no }, note: str(input.comments, 500) });
    audit('approval', approvalId, decision, { revision_id: r.id, comments: input.comments });
    return { approval_id: approvalId, status: decision };
  });
}

export function listApprovals(query, user) {
  const status = query.status || 'pending';
  const scope = quotationScope(user, 'q');
  return all(`SELECT a.*, r.quotation_id, r.revision_no, r.currency, r.total_minor, r.grand_total_minor, r.discount_pct, r.max_line_discount_pct, r.margin_pct, r.below_min_price,
      q.number, q.subject, c.company_name, c.region_id, rg.name AS region_name, ru.name AS requested_by_name, du.name AS decided_by_name
    FROM approvals a JOIN quote_revisions r ON r.id = a.entity_id AND a.entity_type = 'quote_revision' JOIN quotations q ON q.id = r.quotation_id
    JOIN customers c ON c.id = q.customer_id LEFT JOIN regions rg ON rg.id = c.region_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
    WHERE ${status === 'all' ? '1 = 1' : 'a.status = ?'} ${scope ? `AND ${scope}` : ''} ORDER BY a.requested_at DESC LIMIT 200`, ...(status === 'all' ? [] : [status]))
    .map((a) => ({ ...a, reasons: parseJson(a.reasons, []), can_decide: canDecide(user, a, { region_id: a.region_id }), required_role_label: labelOf(ROLES, a.required_role) }));
}

// ------------------------------------------------------------------ issue & outcome
/**
 * Issuing requires a sent date/time, channel, the issued document or a recorded summary, a validity date and
 * the next follow-up with a named owner. A revision needing approval must be approved first (configurable).
 * Earlier issued revisions become superseded but stay retrievable.
 */
export function issueRevision(revisionId, input, user) {
  const r = loadRevision(revisionId);
  if (r.status !== 'draft') throw conflict('This revision has already been issued');
  if (r.approval_role && settings().approvals.requireBeforeIssue && r.approval_status !== 'approved') {
    throw conflict(r.approval_status === 'pending' ? 'This revision is awaiting internal approval' : `This revision needs approval before it is issued: ${r.approval_reasons.join('; ')}`, { code: 'approval_required' });
  }
  const c = new Check();
  if (!input.sent_at || !isInstant(input.sent_at)) c.fail('sent_at', 'Enter when it was sent');
  else if (Date.parse(input.sent_at) > now().getTime() + 10 * 60000) c.fail('sent_at', 'The sent time cannot be in the future');
  checkOption(c, 'channel', 'channel', input.channel, { note: input.summary });
  if (input.channel === 'internal') c.fail('channel', 'Choose how it was sent to the customer');
  const docId = intId(input.document_id) || r.document_id;
  const summary = str(input.summary, 1000) || r.summary;
  if (!docId && !summary) c.fail('document_id', 'Attach the issued document, or record a summary of what was quoted');
  if (!r.lines.length || r.lines.some((l) => l.qty === null)) c.fail('lines', 'Every quoted line needs a quantity before issue');
  const validity = input.validity_date || r.validity_date;
  c.date('validity_date', validity, { required: true, message: 'Set the validity date' });
  const next = { purpose: input.next?.purpose || 'Follow up quotation', owner_id: input.next?.owner_id, due_date: input.next?.due_date, due_time: input.next?.due_time };
  validateTaskInput(c, next, 'next.');
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const sentAt = new Date(input.sent_at).toISOString();
    run("UPDATE quote_revisions SET status = 'superseded', updated_at = ?, version = version + 1 WHERE quotation_id = ? AND status = 'issued'", stamp, r.quotation_id);
    const activityId = recordActivity({
      customer_id: r.customer_id, enquiry_id: r.enquiry_id, contact_id: input.contact_id || r.contact_id, channel: input.channel, outcome: 'quotation_sent', system_outcome: true,
      kind: 'quotation', quote_revision_id: revisionId, note: `${r.number} rev ${r.revision_no} issued${summary ? ` — ${summary}` : ''}`, occurred_at: sentAt,
    }, user, { validated: true });
    update('quote_revisions', revisionId, {
      status: 'issued', sent_at: sentAt, sent_channel: input.channel, sent_activity_id: activityId, issued_by: user.id, document_id: docId, summary,
      validity_date: validity, updated_at: stamp, version: r.version + 1,
    });
    if (docId) linkAttachment(docId, 'quote_revision', revisionId, user);
    if (r.enquiry_id) {
      const e = get('SELECT * FROM enquiries WHERE id = ?', r.enquiry_id);
      if (e && OPEN_ENQUIRY_STAGES.includes(e.stage) && e.stage !== 'quote_sent') {
        run("UPDATE enquiries SET stage = 'quote_sent', updated_at = ?, version = version + 1 WHERE id = ?", stamp, e.id);
        history('enquiry', e.id, 'stage_changed', { customerId: e.customer_id, data: { from: e.stage, to: 'quote_sent', reason: `${r.number} rev ${r.revision_no} issued` }, occurredAt: sentAt });
      }
      if (e && r.total_minor !== null) run('UPDATE enquiries SET est_value_minor = ?, est_currency = ? WHERE id = ?', r.total_minor, r.currency, e.id);
      for (const t of all("SELECT id FROM tasks WHERE enquiry_id = ? AND status = 'open' AND purpose_code IN ('respond_enquiry','send_quotation','revised_offer','quote_followup')", r.enquiry_id)) {
        run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, completion_activity_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          sentAt, user.id, sentAt, activityId, stamp, t.id);
      }
      createTask({ enquiry_id: r.enquiry_id, quotation_id: r.quotation_id, ...next, purpose_code: 'quote_followup', kind: 'customer', source: 'quote_issued' }, user, { validated: true });
      run('UPDATE enquiries SET no_followup_reason = NULL WHERE id = ?', r.enquiry_id);
    }
    const cfg = settings().approvals;
    if (r.currency === 'INR' && r.grand_total_minor !== null && r.grand_total_minor >= (cfg.largeQuotationValue || Infinity) * 100) {
      const cust = get('SELECT company_name FROM customers WHERE id = ?', r.customer_id);
      notifyRoles(['management', 'sales_head'], {
        title: `Large quotation issued: ${r.number} (${cust.company_name})`, message: `${formatMoney(r.grand_total_minor, r.currency)} incl. GST, prepared by ${user.name}`,
        link: `/quotations/${r.quotation_id}`, dedupeKey: `large_quote:${r.quotation_id}:${r.revision_no}`,
      });
    }
    audit('quote_revision', revisionId, 'issue', { sent_at: sentAt, channel: input.channel, document_id: docId });
    return { revision_id: revisionId, activity_id: activityId };
  });
}

/** Accepted, rejected or awaiting decision. A rejection reason belongs to this opportunity only. */
export function recordOutcome(revisionId, input, user) {
  const r = loadRevision(revisionId);
  const c = new Check();
  const outcome = input.outcome;
  if (!['accepted', 'rejected', 'awaiting'].includes(outcome)) c.fail('outcome', 'Choose accepted, rejected or awaiting decision');
  if (outcome !== 'awaiting' && r.status !== 'issued') c.fail('outcome', r.status === 'draft' ? 'Issue the quotation first — a draft cannot be accepted or rejected' : `This revision is already ${r.status}`);
  if (outcome === 'rejected') checkOption(c, 'reason_code', 'lost_reason', input.reason_code, { note: input.note });
  if (outcome === 'accepted' && input.acceptance_type && !['po', 'written', 'verbal', 'portal'].includes(input.acceptance_type)) c.fail('acceptance_type', 'Choose PO, written or verbal');
  if (outcome === 'accepted' && input.acceptance_type === 'verbal') c.text('note', input.note, { required: true, max: 500, label: 'Who confirmed, and when' });
  c.note('note', input.note);
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    if (outcome === 'accepted') {
      update('quote_revisions', revisionId, { status: 'accepted', decided_at: stamp, acceptance_type: input.acceptance_type || null, acceptance_note: str(input.note, 500), acceptance_document_id: intId(input.document_id), updated_at: stamp, version: r.version + 1 });
      if (input.document_id) linkAttachment(intId(input.document_id), 'quote_revision', revisionId, user);
      history('quotation', r.quotation_id, 'accepted', { customerId: r.customer_id, data: { number: r.number, revision: r.revision_no } });
      // Accepted is not won: the enquiry becomes Won only with a linked confirmed order.
      if (r.enquiry_id) {
        createTask({ enquiry_id: r.enquiry_id, quotation_id: r.quotation_id, purpose: `Convert accepted ${r.number} rev ${r.revision_no} into an order`, purpose_code: 'convert_quote', owner_id: r.owner_id || user.id, due_date: today(), kind: 'internal', source: 'quote_accepted', alert_key: `convert_quote:${revisionId}` }, user, { validated: true });
      }
    } else if (outcome === 'rejected') {
      update('quote_revisions', revisionId, { status: 'rejected', decided_at: stamp, rejection_reason_code: input.reason_code, decision_note: str(input.note, 1000), updated_at: stamp, version: r.version + 1 });
      history('quotation', r.quotation_id, 'rejected', { customerId: r.customer_id, data: { number: r.number, revision: r.revision_no, reason: input.reason_code }, note: str(input.note, 1000) });
      if (bool(input.close_enquiry) && r.enquiry_id) {
        changeStage(r.enquiry_id, { stage: 'lost', lost_reason_code: input.reason_code, lost_note: input.note, competitor: input.competitor }, user);
      }
    } else if (r.enquiry_id) {
      const e = get('SELECT stage FROM enquiries WHERE id = ?', r.enquiry_id);
      if (e.stage !== 'awaiting_decision') changeStage(r.enquiry_id, { stage: 'awaiting_decision', next: input.next }, user);
    }
    audit('quote_revision', revisionId, outcome, { reason: input.reason_code, note: input.note });
    return { revision_id: revisionId };
  });
}

// ------------------------------------------------------------------ conversion
/** Quoted vs converted quantities per line of a revision: the unconverted scope is always visible. */
export function conversionStatus(revisionId) {
  const r = loadRevision(revisionId);
  const converted = Object.fromEntries(all(`SELECT l.quote_line_index AS idx, SUM(COALESCE(l.original_qty, l.confirmed_qty)) AS q FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.quote_revision_id = ? AND o.archived_at IS NULL GROUP BY l.quote_line_index`, revisionId).map((x) => [x.idx, x.q]));
  return r.lines.map((l) => {
    const done = round3(converted[l.index] || 0);
    return { ...l, converted_qty: done, remaining_qty: l.qty === null ? null : Math.max(0, round3(l.qty - done)) };
  });
}

/**
 * Converts an accepted (or issued) revision into an order linked to that exact revision. Smaller accepted
 * quantities are allowed and the remainder stays visible. Expired quotations need an authorised
 * confirmation of the accepted terms. Retried requests are made safe by the idempotency key at the route.
 */
export function convertToOrder(revisionId, input, user) {
  const r = loadRevision(revisionId);
  if (!['issued', 'accepted'].includes(r.status)) {
    throw conflict(r.status === 'draft' ? 'Issue the quotation first' : `A ${r.status} revision cannot be converted — use the accepted revision`);
  }
  const c = new Check();
  const expired = r.validity_date && r.validity_date < today();
  if (expired) {
    if (!hasPerm(user, 'quotes.expired_override')) throw forbidden(`This quotation expired on ${r.validity_date}. The coordinator or management must confirm the accepted terms.`);
    if (!bool(input.expired_terms_confirmed)) c.fail('expired_terms_confirmed', `This quotation expired on ${r.validity_date}. Confirm the customer accepted these terms.`);
    c.text('expired_note', input.expired_note, { required: true, max: 300, label: 'Who confirmed the terms' });
  }
  const status = conversionStatus(revisionId);
  const chosen = (input.lines || []).filter((x) => num(x.qty) !== null && Number(x.qty) > 0);
  if (!chosen.length) c.fail('lines', 'Enter the accepted quantity for at least one line');
  const orderLines = chosen.map((x, i) => {
    const ql = status.find((s) => s.index === Number(x.index));
    if (!ql) {
      c.fail(`lines.${i}.qty`, 'Unknown quoted line');
      return null;
    }
    const q = round3(Number(x.qty));
    if (ql.remaining_qty !== null && q > ql.remaining_qty + 0.0005) c.fail(`lines.${i}.qty`, `Only ${ql.remaining_qty} remains unconverted on this line`);
    const netUnit = ql.net_unit_price_minor ?? (ql.unit_price_minor === null ? null : Math.round(ql.unit_price_minor * (1 - (ql.discount_pct || 0) / 100)));
    return {
      product_id: ql.product_id, description: ql.description, spec: x.spec !== undefined ? x.spec : ql.spec, unit: ql.unit, confirmed_qty: q,
      unit_price: x.unit_price !== undefined && x.unit_price !== '' ? x.unit_price : netUnit === null ? null : (netUnit / 100).toFixed(2),
      sku: ql.product_code, hsn: ql.hsn, list_price_minor: ql.list_price_minor, discount_pct: ql.discount_pct, gst_rate: ql.gst_rate, cost_price_minor: ql.cost_price_minor, config: ql.config,
      commitment_state: x.commitment_state || (x.original_commitment_date ? 'committed' : 'uncommitted'),
      original_commitment_date: x.original_commitment_date || null,
      needs_clarification: x.needs_clarification ?? !ql.product_id,
      enquiry_line_id: ql.enquiry_line_id, quote_line_index: ql.index,
    };
  }).filter(Boolean);
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    if (r.status === 'issued') {
      update('quote_revisions', revisionId, { status: 'accepted', decided_at: stamp, acceptance_type: input.confirmation_type || 'po', acceptance_note: str(input.confirmation_note, 500), updated_at: stamp, version: r.version + 1 });
      history('quotation', r.quotation_id, 'accepted', { customerId: r.customer_id, data: { number: r.number, revision: r.revision_no } });
    }
    const fullScope = status.every((l) => {
      const taken = orderLines.find((o) => o.quote_line_index === l.index);
      return l.qty !== null && taken && Math.abs(taken.confirmed_qty - l.remaining_qty) < 0.0005;
    });
    const orderId = createOrder({
      customer_id: r.customer_id, contact_id: input.contact_id || r.contact_id, owner_id: input.owner_id || r.owner_id || get('SELECT owner_id FROM enquiries WHERE id = ?', r.enquiry_id)?.owner_id,
      coordinator_id: input.coordinator_id, po_reference: input.po_reference, po_date: input.po_date, received_date: input.received_date || today(),
      confirmation_type: input.confirmation_type, confirmation_note: [str(input.confirmation_note, 500), expired ? `Expired quotation terms confirmed: ${str(input.expired_note, 300)}` : null].filter(Boolean).join(' — ') || null,
      confirmation_document_id: input.confirmation_document_id, currency: r.currency, payment_terms: input.payment_terms ?? r.payment_terms,
      delivery_address: input.delivery_address, billing_address: input.billing_address, shipping_mode: input.shipping_mode, segment: input.segment, notes: input.notes,
      priority: input.priority, factory_id: input.factory_id, advance_pct: input.advance_pct,
      freight: input.freight !== undefined ? input.freight : fullScope && r.freight_minor ? (r.freight_minor / 100).toFixed(2) : undefined,
      installation: input.installation !== undefined ? input.installation : fullScope && r.installation_minor ? (r.installation_minor / 100).toFixed(2) : undefined,
      confirm_duplicate_po: input.confirm_duplicate_po, lines: orderLines, confirm: input.confirm !== false,
    }, user, { fromRevision: { id: revisionId, enquiry_id: r.enquiry_id, currency: r.currency, document_id: r.document_id } });
    applyConvertedQuantities(all('SELECT enquiry_line_id, COALESCE(original_qty, confirmed_qty) AS qty FROM order_lines WHERE order_id = ?', orderId));
    if (r.enquiry_id) maybeMarkWon(r.enquiry_id, user);
    for (const t of all("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `convert_quote:${revisionId}`)) {
      run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?", stamp, user.id, stamp, stamp, t.id);
    }
    audit('quote_revision', revisionId, 'convert', { order_id: orderId, lines: orderLines.length, expired: Boolean(expired) });
    const order = get('SELECT id, code, status FROM orders WHERE id = ?', orderId);
    return { order_id: orderId, order_code: order.code, order_status: order.status, unconverted: conversionStatus(revisionId).filter((l) => l.remaining_qty === null || l.remaining_qty > 0) };
  });
}

// ------------------------------------------------------------------ reading
export function revisionDetail(revisionId) {
  const r = loadRevision(revisionId);
  return { ...r, conversion: conversionStatus(revisionId), expired: r.validity_date ? r.validity_date < today() : false, rejection_reason: optionLabel('lost_reason', r.rejection_reason_code) };
}

/** Full quotation with every revision (newest first), approvals, conversions, documents and history. */
export function loadQuotation(id, user) {
  const q = get(`SELECT q.*, c.company_name AS customer_name, c.code AS customer_code, c.types AS customer_types, c.gstin AS customer_gstin, c.billing_address, c.shipping_address,
      c.city, c.state, c.country_code, c.region_id, c.segment, ct.name AS contact_name, ct.email_raw AS contact_email, ct.phone_raw AS contact_phone, ct.role AS contact_designation,
      u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, pb.name AS prepared_by_name, e.code AS enquiry_code, e.stage AS enquiry_stage, e.title AS enquiry_title
    FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN contacts ct ON ct.id = q.contact_id LEFT JOIN users u ON u.id = q.owner_id
    LEFT JOIN users pb ON pb.id = q.prepared_by LEFT JOIN enquiries e ON e.id = q.enquiry_id WHERE q.id = ?`, id);
  if (!q) throw notFound('Quotation');
  const revisions = all(`SELECT r.*, u.name AS created_by_name, iu.name AS issued_by_name, au.name AS approved_by_name FROM quote_revisions r
    LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users iu ON iu.id = r.issued_by LEFT JOIN users au ON au.id = r.approved_by
    WHERE r.quotation_id = ? ORDER BY r.revision_no DESC`, id).map((r) => ({
    ...r, lines: JSON.parse(r.lines || '[]'), approval_reasons: parseJson(r.approval_reasons, []), expired: r.status === 'issued' && r.validity_date && r.validity_date < today(),
    rejection_reason: optionLabel('lost_reason', r.rejection_reason_code), channel_label: optionLabel('channel', r.sent_channel),
    conversion: ['issued', 'accepted'].includes(r.status) ? conversionStatus(r.id) : null,
  }));
  const approvals = all(`SELECT a.*, ru.name AS requested_by_name, du.name AS decided_by_name, r.revision_no FROM approvals a
    JOIN quote_revisions r ON r.id = a.entity_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
    WHERE a.entity_type = 'quote_revision' AND r.quotation_id = ? ORDER BY a.requested_at DESC`, id).map((a) => ({ ...a, reasons: parseJson(a.reasons, []) }));
  const pending = approvals.find((a) => a.status === 'pending');
  const orders = all(`SELECT o.id, o.code, o.status, o.received_date, r.revision_no FROM orders o JOIN quote_revisions r ON r.id = o.quote_revision_id WHERE r.quotation_id = ? ORDER BY o.id`, id);
  const history = all(`SELECT h.*, u.name AS actor_name FROM history_events h LEFT JOIN users u ON u.id = h.actor_id WHERE h.entity_type = 'quotation' AND h.entity_id = ? ORDER BY h.id DESC`, id)
    .map((h) => ({ ...h, data: parseJson(h.data, {}) }));
  const documents = revisions.flatMap((r) => attachmentsFor('quote_revision', r.id).map((a) => ({ ...a, revision_no: r.revision_no })));
  return {
    ...q,
    customer_types: parseJson(q.customer_types, []),
    revisions,
    current: revisions[0] || null,
    approvals,
    can_decide: user ? canDecide(user, pending, q) : false,
    pending_approval_id: pending?.id ?? null,
    orders,
    history,
    documents,
    contacts: all('SELECT id, name, role, email_raw, phone_raw FROM contacts WHERE customer_id = ? AND active = 1 ORDER BY is_primary DESC, name', q.customer_id),
  };
}

/** Quotation register: the latest revision of each quotation, with values per currency. */
export function listQuotations(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = quotationScope(user, 'q');
  if (scope) where.push(scope);
  const day = today();
  if (query.q) {
    where.push('(q.number LIKE ? OR q.subject LIKE ? OR c.company_name LIKE ? OR e.code LIKE ?)');
    params.push(...Array(4).fill(likeTerm(query.q)));
  }
  const st = query.status;
  if (st === 'awaiting' || st === 'sent') where.push("r.status = 'issued'");
  else if (st === 'pending') where.push("r.status = 'draft'");
  else if (st === 'approved') where.push("r.status = 'accepted'");
  else if (st === 'expiring') where.push(`r.status = 'issued' AND r.validity_date BETWEEN '${day}' AND '${addDays(day, 7)}'`);
  else if (st === 'expired') where.push(`r.status = 'issued' AND r.validity_date < '${day}'`);
  else if (st === 'approval') where.push("r.status = 'draft' AND r.approval_status IN ('required','pending','rejected')");
  else if (st && QUOTE_STATUSES.some((s) => s.value === st)) {
    where.push('r.status = ?');
    params.push(st);
  }
  for (const [k, col] of [['customer_id', 'q.customer_id'], ['owner', 'q.owner_id'], ['enquiry_id', 'q.enquiry_id'], ['region_id', 'c.region_id']]) {
    if (intId(query[k])) {
      where.push(`${col} = ?`);
      params.push(intId(query[k]));
    }
  }
  if (query.from) {
    where.push('substr(q.created_at, 1, 10) >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('substr(q.created_at, 1, 10) <= ?');
    params.push(query.to);
  }
  const from = `FROM quotations q JOIN quote_revisions r ON r.quotation_id = q.id AND r.revision_no = (SELECT MAX(r2.revision_no) FROM quote_revisions r2 WHERE r2.quotation_id = q.id)
    JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id LEFT JOIN enquiries e ON e.id = q.enquiry_id`;
  const sorts = { number: 'q.id', customer: 'c.company_name', value: 'r.total_minor', discount: 'r.discount_pct', margin: 'r.margin_pct', sent: 'r.sent_at', valid: 'r.validity_date', owner: 'u.name', created: 'q.created_at' };
  const sortCol = sorts[query.sort];
  const order = sortCol ? `ORDER BY ${sortCol} ${String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : 'ORDER BY q.updated_at DESC, q.id DESC';
  const { limit, offset, page, pageSize } = paginate(query);
  const rows = all(`SELECT q.id, q.number, q.subject, q.customer_id, q.enquiry_id, q.owner_id, q.price_list, q.created_at, c.company_name, c.city, u.name AS owner_name, e.code AS enquiry_code, e.stage AS enquiry_stage,
      r.id AS revision_id, r.revision_no, r.status, r.currency, r.total_minor, r.grand_total_minor, r.discount_pct, r.margin_pct, r.approval_status, r.approval_role,
      r.validity_date, r.sent_at, r.viewed_at, r.customer_response, (SELECT COUNT(*) FROM orders o JOIN quote_revisions rr ON rr.id = o.quote_revision_id WHERE rr.quotation_id = q.id) AS orders
    ${from} WHERE ${where.join(' AND ')} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset)
    .map((x) => ({ ...x, tracking: quoteTracking(x.status), expired: x.status === 'issued' && x.validity_date && x.validity_date < day }));
  const count = get(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`, ...params).n;
  const summary = all(`SELECT r.status, r.currency, COUNT(*) AS n, SUM(r.total_minor) AS value_minor ${from} WHERE ${scope || '1 = 1'} GROUP BY r.status, r.currency`);
  const attention = get(`SELECT SUM(CASE WHEN r.status = 'draft' AND r.approval_status IN ('required','pending','rejected') THEN 1 ELSE 0 END) AS approval,
      SUM(CASE WHEN r.status = 'issued' AND r.validity_date < ? THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN r.status = 'issued' AND r.validity_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS expiring ${from} WHERE ${scope || '1 = 1'}`, day, day, addDays(day, 7));
  const tracking = { pending: 0, sent: 0, approved: 0, rejected: 0 };
  for (const s of summary) if (quoteTracking(s.status)) tracking[quoteTracking(s.status)] += s.n;
  return { rows, count, page, pageSize, summary, tracking, attention: { approval: attention.approval || 0, expired: attention.expired || 0, expiring: attention.expiring || 0 } };
}

/** Price, tax, margin and approval preview for the builder without saving. */
export function previewQuote(input) {
  const customer = intId(input.customer_id) ? get('SELECT * FROM customers WHERE id = ?', intId(input.customer_id)) : null;
  const priceList = input.price_list || priceListForCustomer(customer);
  const currency = input.currency || defaultCurrency(customer);
  if (!Array.isArray(input.lines) || !input.lines.length) return { lines: [], totals: null, approval_reasons: [], price_list: priceList, currency };
  const c = new Check();
  const lines = normaliseLines(c, input.lines, { priceList, currency });
  const calc = computeQuote(lines, input, currency);
  return { ...calc, price_list: priceList, currency, field_errors: c.ok ? null : c.fields };
}

/** Starts a new quotation from a past order (repeat business) or another quotation; catalogue items are re-priced today. */
export function duplicateQuotation(input, user) {
  let lines;
  let customerId;
  let header = {};
  let subject;
  if (intId(input.order_id)) {
    const o = get('SELECT * FROM orders WHERE id = ?', intId(input.order_id));
    if (!o) throw notFound('Order');
    customerId = o.customer_id;
    lines = all('SELECT product_id, description, spec, confirmed_qty AS qty, unit, discount_pct, gst_rate, unit_price_minor, config FROM order_lines WHERE order_id = ? ORDER BY line_no', o.id)
      .map((l) => ({ ...l, config: parseJson(l.config, null), unit_price_minor: l.product_id ? undefined : l.unit_price_minor }));
    subject = `Repeat order (ref ${o.code})`;
    header = { currency: o.currency, payment_terms: o.payment_terms };
  } else if (intId(input.quotation_id)) {
    const src = get('SELECT * FROM quotations WHERE id = ?', intId(input.quotation_id));
    if (!src) throw notFound('Quotation');
    const last = get('SELECT * FROM quote_revisions WHERE quotation_id = ? ORDER BY revision_no DESC LIMIT 1', src.id);
    customerId = intId(input.customer_id) || src.customer_id;
    lines = JSON.parse(last.lines || '[]').map((l) => ({ ...l, unit_price_minor: l.product_id ? undefined : l.unit_price_minor, enquiry_line_id: null }));
    header = { currency: last.currency, payment_terms: last.payment_terms, delivery_terms: last.delivery_terms, warranty_terms: last.warranty_terms };
    subject = src.subject;
  } else throw badRequest('Choose the order or quotation to copy');
  return createQuotation({ ...header, customer_id: customerId, subject, lines, source_code: 'existing_customer', owner_id: input.owner_id }, user);
}

// ------------------------------------------------------------------ customer link (portal)
/** What the customer sees through the share link: the latest issued (or accepted) revision only. */
export function portalQuotation(publicToken) {
  const q = get('SELECT * FROM quotations WHERE public_token = ?', String(publicToken || ''));
  if (!q) throw notFound('Quotation');
  const r = get("SELECT * FROM quote_revisions WHERE quotation_id = ? AND status IN ('issued','accepted','rejected') ORDER BY revision_no DESC LIMIT 1", q.id);
  if (!r) throw notFound('Quotation');
  const c = get('SELECT company_name, city, country_code FROM customers WHERE id = ?', q.customer_id);
  const owner = get('SELECT name, email, phone FROM users WHERE id = ?', q.owner_id);
  if (r.status === 'issued' && !r.viewed_at) {
    run('UPDATE quote_revisions SET viewed_at = ? WHERE id = ?', nowIso(), r.id);
    history('quotation', q.id, 'viewed', { customerId: q.customer_id, data: { revision: r.revision_no } });
    if (q.owner_id) notify(q.owner_id, { title: `${q.number}: the customer opened the quotation`, message: c.company_name, link: `/quotations/${q.id}`, dedupeKey: `quote_viewed:${r.id}` });
  }
  const s = settings();
  return {
    number: q.number, subject: q.subject, revision_no: r.revision_no, status: r.status, currency: r.currency, validity_date: r.validity_date, expired: r.status === 'issued' && r.validity_date < today(),
    sent_at: r.sent_at, payment_terms: r.payment_terms, delivery_terms: r.delivery_terms, warranty_terms: r.warranty_terms, notes: r.notes,
    lines: JSON.parse(r.lines || '[]').map((l) => ({
      description: l.description, spec: l.spec, product_code: l.product_code, hsn: l.hsn, qty: l.qty, unit: l.unit, unit_price_minor: l.unit_price_minor,
      discount_pct: l.discount_pct, gst_rate: l.gst_rate, line_total_minor: l.line_total_minor, tax_minor: l.tax_minor,
    })),
    totals: {
      subtotal_minor: r.subtotal_minor, discount_total_minor: r.discount_total_minor, freight_minor: r.freight_minor, installation_minor: r.installation_minor,
      total_minor: r.total_minor, tax_total_minor: r.tax_total_minor, grand_total_minor: r.grand_total_minor,
    },
    customer: c, owner, company: { name: s.company.name, gstin: s.company.gstin, address: s.company.address, phone: s.company.phone, email: s.company.email, website: s.company.website },
    customer_response: r.customer_response, decided_at: r.decided_at,
  };
}

/** Customer response through the link: accept (staff still convert it into an order) or ask for a revision. */
export function portalRespond(publicToken, input) {
  const q = get('SELECT * FROM quotations WHERE public_token = ?', String(publicToken || ''));
  if (!q) throw notFound('Quotation');
  const r = get("SELECT * FROM quote_revisions WHERE quotation_id = ? AND status = 'issued' ORDER BY revision_no DESC LIMIT 1", q.id);
  if (!r) throw conflict('This quotation is no longer open for a response');
  const c = new Check();
  if (!['accept', 'revise'].includes(input.action)) c.fail('action', 'Choose accept or request a revision');
  c.text('name', input.name, { required: true, max: 120, label: 'Your name' });
  c.text('note', input.note, { required: input.action === 'revise', max: 1000, label: 'What should change' });
  c.throwIfAny();
  const expired = r.validity_date && r.validity_date < today();
  if (input.action === 'accept' && expired) throw conflict('This quotation has expired. Please contact us for an updated offer.');
  const note = `${input.action === 'accept' ? 'Accepted' : 'Revision requested'} online by ${str(input.name, 120)}${input.note ? `: ${str(input.note, 1000)}` : ''}`;
  return tx(() => {
    const stamp = nowIso();
    const owner = q.owner_id || get('SELECT owner_id FROM enquiries WHERE id = ?', q.enquiry_id)?.owner_id;
    const system = { id: null, name: 'Customer', permissions: [] };
    if (input.action === 'accept') {
      update('quote_revisions', r.id, { status: 'accepted', decided_at: stamp, acceptance_type: 'portal', acceptance_note: note, customer_response: note, customer_response_at: stamp, updated_at: stamp, version: r.version + 1 });
      history('quotation', q.id, 'accepted', { customerId: q.customer_id, data: { number: q.number, revision: r.revision_no, via: 'customer link' }, note });
      if (owner) createTask({ enquiry_id: q.enquiry_id, quotation_id: q.id, purpose: `Customer accepted ${q.number} online — collect the PO and convert to an order`, purpose_code: 'convert_quote', owner_id: owner, due_date: today(), kind: 'customer', source: 'portal', alert_key: `convert_quote:${r.id}` }, system, { validated: true });
    } else {
      update('quote_revisions', r.id, { customer_response: note, customer_response_at: stamp, updated_at: stamp, version: r.version + 1 });
      history('quotation', q.id, 'revision_requested', { customerId: q.customer_id, data: { revision: r.revision_no }, note });
      if (owner) createTask({ enquiry_id: q.enquiry_id, quotation_id: q.id, purpose: `Send revised offer — customer asked for changes to ${q.number}`, purpose_code: 'revised_offer', owner_id: owner, due_date: today(), kind: 'customer', source: 'portal', alert_key: `revise_quote:${r.id}` }, system, { validated: true });
    }
    if (owner) notify(owner, { title: `${q.number}: customer ${input.action === 'accept' ? 'accepted the quotation' : 'asked for a revision'}`, message: note, link: `/quotations/${q.id}`, severity: input.action === 'accept' ? 'success' : 'warning', dedupeKey: `portal:${r.id}:${input.action}` });
    audit('quote_revision', r.id, `portal_${input.action}`, { name: input.name });
    return { ok: true, status: input.action === 'accept' ? 'accepted' : 'revision_requested' };
  });
}

export { groupOf };
