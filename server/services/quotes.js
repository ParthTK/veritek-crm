import { get, all, run, insert, update, tx, getSetting } from '../db.js';
import { DEFAULT_SETTINGS, roleRank, can, ROLES } from '../../shared/constants.js';
import {
  badRequest, forbidden, nowIso, today, addDays, round2, num, intOrNull, strOrNull, nextNumber, token,
  notify, audit, parseJson,
} from '../util.js';
import { advanceLeadTo, moveLead, syncLeadFollowup } from './leads.js';

export const approvalSettings = () => ({ ...DEFAULT_SETTINGS.approvals, ...getSetting('approvals', {}) });
export const quotationSettings = () => ({ ...DEFAULT_SETTINGS.quotation, ...getSetting('quotation', {}) });
export const followupSettings = () => ({ ...DEFAULT_SETTINGS.followups, ...getSetting('followups', {}) });

export function priceListForCustomer(customer) {
  if (customer?.customer_type === 'dealer') return 'dealer';
  if (customer?.customer_type === 'distributor') return 'distributor';
  return 'standard';
}

export function listPriceFor(product, priceList) {
  if (priceList === 'dealer' && product.dealer_price > 0) return product.dealer_price;
  if (priceList === 'distributor' && product.distributor_price > 0) return product.distributor_price;
  return product.standard_price;
}

const fmtPct = (n) => `${Math.round(n * 10) / 10}%`;

/**
 * Normalise quotation lines against the product & price master. List price, cost, minimum
 * price and GST always come from the master (plus configurator options); users set qty,
 * selling price and discount.
 */
export function normalizeItems(rawItems, priceList) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw badRequest('Add at least one product line');
  return rawItems.map((it, i) => {
    const qty = num(it.qty);
    if (qty <= 0) throw badRequest(`Line ${i + 1}: quantity must be greater than zero`);
    let base;
    if (it.product_id) {
      const p = get('SELECT * FROM products WHERE id = ?', it.product_id);
      if (!p) throw badRequest(`Line ${i + 1}: product not found in price master`);
      if (p.status === 'discontinued') throw badRequest(`Line ${i + 1}: ${p.name} is discontinued`);
      const cfg = parseJson(it.config, {});
      const optionIds = (it.option_ids || cfg?.options?.map((o) => o.id) || []).map(Number).filter(Boolean);
      const options = optionIds.length
        ? all(`SELECT * FROM product_options WHERE product_id = ? AND id IN (${optionIds.map(() => '?').join(',')})`, [p.id, ...optionIds])
        : [];
      const priceDelta = options.reduce((s, o) => s + o.price_delta, 0);
      const costDelta = options.reduce((s, o) => s + o.cost_delta, 0);
      const minRatio = p.standard_price > 0 ? p.min_price / p.standard_price : 0;
      const optionText = options.map((o) => `${o.group_name}: ${o.name}`).join('; ');
      base = {
        product_id: p.id,
        sku: p.sku,
        description: strOrNull(it.description) || p.name,
        specs: it.specs !== undefined ? strOrNull(it.specs) : [p.model, optionText].filter(Boolean).join(' | ') || null,
        hsn: p.hsn,
        unit: p.unit,
        gst_rate: p.gst_rate,
        list_price: round2(listPriceFor(p, priceList) + priceDelta),
        cost_price: round2(p.cost_price + costDelta),
        min_price: round2(p.min_price + priceDelta * minRatio),
        config: options.length ? { options: options.map((o) => ({ id: o.id, group: o.group_name, name: o.name, price_delta: o.price_delta })) } : null,
        custom: false,
      };
    } else {
      if (!strOrNull(it.description)) throw badRequest(`Line ${i + 1}: describe the non-catalogue item`);
      base = {
        product_id: null, sku: strOrNull(it.sku), description: strOrNull(it.description), specs: strOrNull(it.specs),
        hsn: strOrNull(it.hsn), unit: it.unit || 'Nos', gst_rate: num(it.gst_rate, 18),
        list_price: num(it.unit_price), cost_price: num(it.cost_price), min_price: 0, config: null, custom: true,
      };
    }
    const unitPrice = it.unit_price === undefined || it.unit_price === '' || it.unit_price === null ? base.list_price : num(it.unit_price);
    if (unitPrice < 0) throw badRequest(`Line ${i + 1}: price cannot be negative`);
    return {
      ...base,
      sort_order: i,
      qty,
      unit_price: round2(unitPrice),
      discount_pct: Math.min(Math.max(num(it.discount_pct), 0), 100),
    };
  });
}

/** Totals, margin, effective discount and the approval level the numbers require. */
export function computeQuote(lines, header) {
  const cfg = approvalSettings();
  const freightGst = quotationSettings().freightGstRate;
  let listTotal = 0; let subtotal = 0; let discountTotal = 0; let productTaxable = 0; let productTax = 0;
  let costTotal = 0; let maxLineDisc = 0; let belowMin = false; let hasCustom = false;
  const out = lines.map((l) => {
    const gross = l.qty * l.unit_price;
    const disc = (gross * l.discount_pct) / 100;
    const taxable = gross - disc;
    const tax = (taxable * l.gst_rate) / 100;
    const netUnit = l.unit_price * (1 - l.discount_pct / 100);
    const listUnit = l.list_price > 0 ? l.list_price : l.unit_price;
    const lineDisc = listUnit > 0 ? (1 - netUnit / listUnit) * 100 : 0;
    maxLineDisc = Math.max(maxLineDisc, lineDisc);
    if (l.min_price > 0 && netUnit < l.min_price - 0.01) belowMin = true;
    if (l.custom) hasCustom = true;
    listTotal += l.qty * listUnit;
    subtotal += gross;
    discountTotal += disc;
    productTaxable += taxable;
    productTax += tax;
    costTotal += l.qty * l.cost_price;
    return { ...l, line_discount_pct: round2(lineDisc), below_min: l.min_price > 0 && netUnit < l.min_price - 0.01, taxable: round2(taxable), tax: round2(tax), total: round2(taxable + tax) };
  });
  const freight = round2(num(header.freight));
  const installation = round2(num(header.installation));
  const extra = freight + installation;
  const extraTax = (extra * freightGst) / 100;
  const taxableTotal = productTaxable + extra;
  const taxTotal = productTax + extraTax;
  const marginPct = productTaxable > 0 && costTotal > 0 ? ((productTaxable - costTotal) / productTaxable) * 100 : null;
  const discountPct = listTotal > 0 ? ((listTotal - productTaxable) / listTotal) * 100 : 0;

  const reasons = [];
  let role = null;
  const bump = (r) => {
    if (!role || roleRank(r) > roleRank(role)) role = r;
  };
  if (discountPct > cfg.discountHeadPct) {
    reasons.push(`Overall discount ${fmtPct(discountPct)} exceeds ${cfg.discountHeadPct}%`);
    bump('sales_head');
  } else if (discountPct > cfg.discountManagerPct) {
    reasons.push(`Overall discount ${fmtPct(discountPct)} exceeds ${cfg.discountManagerPct}%`);
    bump('regional_manager');
  }
  if (maxLineDisc > cfg.discountHeadPct && discountPct <= cfg.discountHeadPct) {
    reasons.push(`A line discount of ${fmtPct(maxLineDisc)} exceeds ${cfg.discountHeadPct}%`);
    bump('sales_head');
  } else if (maxLineDisc > cfg.discountManagerPct && discountPct <= cfg.discountManagerPct) {
    reasons.push(`A line discount of ${fmtPct(maxLineDisc)} exceeds ${cfg.discountManagerPct}%`);
    bump('regional_manager');
  }
  if (marginPct !== null && marginPct < cfg.minMarginPct) {
    reasons.push(`Margin ${fmtPct(marginPct)} is below the ${cfg.minMarginPct}% floor`);
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

  return {
    lines: out,
    totals: {
      list_total: round2(listTotal),
      subtotal: round2(subtotal),
      discount_total: round2(discountTotal),
      taxable_total: round2(taxableTotal),
      tax_total: round2(taxTotal),
      grand_total: round2(taxableTotal + taxTotal),
      cost_total: round2(costTotal),
      margin_pct: marginPct === null ? null : round2(marginPct),
      discount_pct: round2(discountPct),
      max_line_discount_pct: round2(maxLineDisc),
      below_min_price: belowMin ? 1 : 0,
      freight,
      installation,
    },
    approval_role: role,
    approval_reasons: reasons,
    large: taxableTotal + taxTotal >= cfg.largeQuotationValue,
  };
}

function headerFrom(body, fallback = {}) {
  const qs = quotationSettings();
  const pick = (k, d) => (body[k] !== undefined ? body[k] : fallback[k] !== undefined ? fallback[k] : d);
  return {
    payment_terms: strOrNull(pick('payment_terms', qs.defaultPaymentTerms)),
    delivery_terms: strOrNull(pick('delivery_terms', qs.defaultDelivery)),
    warranty_terms: strOrNull(pick('warranty_terms', qs.defaultWarranty)),
    validity_days: Math.max(1, num(pick('validity_days', qs.defaultValidityDays), qs.defaultValidityDays)),
    freight: num(pick('freight', 0)),
    installation: num(pick('installation', 0)),
    notes: strOrNull(pick('notes', null)),
  };
}

function writeItems(versionId, lines) {
  run('DELETE FROM quotation_items WHERE version_id = ?', versionId);
  for (const l of lines) {
    insert('quotation_items', { ...l, version_id: versionId });
  }
}

function event(quotationId, versionNo, ev, fromStatus, toStatus, note, userId) {
  insert('quotation_events', {
    quotation_id: quotationId, version_no: versionNo, event: ev, from_status: fromStatus ?? null, to_status: toStatus ?? null,
    note: note ?? null, user_id: userId ?? null, created_at: nowIso(),
  });
}

export function currentVersion(q) {
  return get('SELECT * FROM quotation_versions WHERE quotation_id = ? AND version_no = ?', q.id, q.current_version);
}

export function createQuotation(body, user) {
  const customer = get('SELECT * FROM customers WHERE id = ?', intOrNull(body.customer_id));
  if (!customer) throw badRequest('Select a customer');
  if (customer.status === 'blocked') throw badRequest('This customer is blocked. Contact accounts before quoting.');
  const lead = body.lead_id ? get('SELECT * FROM leads WHERE id = ?', body.lead_id) : null;
  const priceList = body.price_list || priceListForCustomer(customer);
  const lines = normalizeItems(body.items, priceList);
  const header = headerFrom(body);
  const calc = computeQuote(lines, header);

  return tx(() => {
    const id = insert('quotations', {
      number: nextNumber('QT'),
      customer_id: customer.id,
      contact_id: intOrNull(body.contact_id) ?? lead?.contact_id ?? null,
      lead_id: lead?.id ?? null,
      subject: strOrNull(body.subject) || lead?.title || `Supply of ${lines[0].description}`,
      status: 'draft',
      current_version: 1,
      price_list: priceList,
      owner_id: intOrNull(body.owner_id) ?? lead?.assigned_to ?? customer.assigned_to ?? user.id,
      public_token: token(18),
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    const versionId = insert('quotation_versions', {
      ...header, ...calc.totals, quotation_id: id, version_no: 1, change_note: 'Initial quotation',
      approval_role: calc.approval_role, approval_reasons: calc.approval_reasons, locked: 0, created_by: user.id, created_at: nowIso(),
    });
    writeItems(versionId, calc.lines);
    event(id, 1, 'created', null, 'draft', null, user.id);
    if (lead) advanceLeadTo(lead.id, 'quotation_preparation', user, 'Quotation drafted');
    audit(user.id, 'quotation', id, 'create', { grand_total: calc.totals.grand_total });
    return id;
  });
}

/** Edit a quotation. Unlocked drafts change in place; anything submitted or sent becomes a new version. */
export function updateQuotation(id, body, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', id);
  if (['converted', 'accepted', 'approval_pending'].includes(q.status)) {
    throw badRequest(q.status === 'approval_pending' ? 'Quotation is awaiting approval. Withdraw it before editing.' : 'Accepted or converted quotations cannot be edited');
  }
  const v = currentVersion(q);
  const priceList = body.price_list || q.price_list;
  const existingItems = all('SELECT * FROM quotation_items WHERE version_id = ? ORDER BY sort_order', v.id);
  const lines = normalizeItems(body.items ?? existingItems, priceList);
  const header = headerFrom(body, v);
  const calc = computeQuote(lines, header);
  const common = { ...header, ...calc.totals, approval_role: calc.approval_role, approval_reasons: calc.approval_reasons };

  return tx(() => {
    const qUpdate = {
      subject: body.subject !== undefined ? strOrNull(body.subject) : q.subject,
      contact_id: body.contact_id !== undefined ? intOrNull(body.contact_id) : q.contact_id,
      owner_id: body.owner_id !== undefined ? intOrNull(body.owner_id) : q.owner_id,
      price_list: priceList,
      updated_at: nowIso(),
    };
    if (!v.locked) {
      update('quotation_versions', v.id, { ...common, change_note: strOrNull(body.change_note) ?? v.change_note });
      writeItems(v.id, calc.lines);
      update('quotations', id, qUpdate);
      event(id, v.version_no, 'edited', q.status, q.status, null, user.id);
      return { version_no: v.version_no, new_version: false };
    }
    const versionNo = q.current_version + 1;
    const versionId = insert('quotation_versions', {
      ...common, quotation_id: id, version_no: versionNo,
      change_note: strOrNull(body.change_note) || `Revision ${versionNo}`, locked: 0, created_by: user.id, created_at: nowIso(),
    });
    writeItems(versionId, calc.lines);
    update('quotations', id, { ...qUpdate, current_version: versionNo, status: 'draft', viewed_at: null });
    event(id, versionNo, 'revised', q.status, 'draft', strOrNull(body.change_note), user.id);
    audit(user.id, 'quotation', id, 'revise', { from: v.version_no, to: versionNo, grand_total: calc.totals.grand_total, prev_total: v.grand_total });
    return { version_no: versionNo, new_version: true };
  });
}

/** Who is asked to approve: regional managers of the customer's region, else the next level up. */
function approversFor(requiredRole, customer) {
  const byRole = (role, regionId) => all(
    `SELECT id FROM users WHERE active = 1 AND role = ? ${regionId ? 'AND region_id = ?' : ''}`,
    ...(regionId ? [role, regionId] : [role]),
  ).map((u) => u.id);
  const chain = ['regional_manager', 'sales_head', 'management', 'super_admin'];
  for (const role of chain.slice(chain.indexOf(requiredRole))) {
    const ids = byRole(role, role === 'regional_manager' ? customer.region_id : null);
    if (ids.length) return ids;
  }
  return [];
}

/** Submit for internal approval. Auto-approves when numbers are within policy. */
export function submitQuotation(id, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', id);
  if (q.status !== 'draft') throw badRequest('Only draft quotations can be submitted');
  const v = currentVersion(q);
  const customer = get('SELECT * FROM customers WHERE id = ?', q.customer_id);
  const cfg = approvalSettings();
  return tx(() => {
    update('quotation_versions', v.id, { locked: 1 });
    run("UPDATE approvals SET status = 'withdrawn', decided_at = ? WHERE entity = 'quotation' AND entity_id = ? AND status = 'pending'", nowIso(), id);
    let status = 'approved';
    if (v.approval_role) {
      status = 'approval_pending';
      const approvalId = insert('approvals', {
        entity: 'quotation', entity_id: id, version_id: v.id, required_role: v.approval_role,
        reasons: parseJson(v.approval_reasons, []), amount: v.grand_total, status: 'pending', requested_by: user.id, requested_at: nowIso(),
      });
      notify(approversFor(v.approval_role, customer), {
        type: 'approval_request',
        title: `Approval needed: ${q.number} v${v.version_no} for ${customer.name}`,
        message: parseJson(v.approval_reasons, []).join('; '),
        link: `/quotations/${id}`, severity: 'warning', dedupeKey: `approval:${approvalId}`,
      });
      event(id, v.version_no, 'submitted', q.status, status, parseJson(v.approval_reasons, []).join('; '), user.id);
    } else {
      event(id, v.version_no, 'auto_approved', q.status, status, 'Within discount and margin policy', user.id);
    }
    update('quotations', id, { status, updated_at: nowIso() });
    if (v.grand_total >= cfg.largeQuotationValue) {
      notify({ roles: ['management', 'sales_head'] }, {
        type: 'large_quotation',
        title: `Large quotation: ${q.number} (${customer.name})`,
        message: `Grand total ₹${Math.round(v.grand_total).toLocaleString('en-IN')} prepared by ${user.name}`,
        link: `/quotations/${id}`, dedupeKey: `large_quote:${id}:${v.version_no}`,
      });
    }
    return status;
  });
}

export function withdrawQuotation(id, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', id);
  if (q.status !== 'approval_pending') throw badRequest('Only quotations awaiting approval can be withdrawn');
  tx(() => {
    run("UPDATE approvals SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE entity = 'quotation' AND entity_id = ? AND status = 'pending'", user.id, nowIso(), id);
    update('quotations', id, { status: 'draft', updated_at: nowIso() });
    event(id, q.current_version, 'withdrawn', q.status, 'draft', null, user.id);
  });
}

export function decideApproval(approvalId, decision, comments, user) {
  const a = get('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a || a.status !== 'pending') throw badRequest('This approval is no longer pending');
  if (!can(user.role, 'approvals.decide') || roleRank(user.role) < roleRank(a.required_role)) {
    throw forbidden(`Requires ${ROLES.find((r) => r.value === a.required_role)?.label} or above`);
  }
  if (!['approved', 'rejected'].includes(decision)) throw badRequest('Decision must be approved or rejected');
  if (decision === 'rejected' && !strOrNull(comments)) throw badRequest('Add a comment explaining the rejection');
  const q = get('SELECT * FROM quotations WHERE id = ?', a.entity_id);
  if (user.role === 'regional_manager') {
    const c = get('SELECT region_id FROM customers WHERE id = ?', q.customer_id);
    if (c.region_id !== user.region_id) throw forbidden('This quotation belongs to another region');
  }
  const version = get('SELECT version_no FROM quotation_versions WHERE id = ?', a.version_id);
  tx(() => {
    update('approvals', a.id, { status: decision, decided_by: user.id, decided_at: nowIso(), comments: strOrNull(comments) });
    const status = decision === 'approved' ? 'approved' : 'draft';
    update('quotations', q.id, { status, updated_at: nowIso() });
    event(q.id, version?.version_no, decision === 'approved' ? 'approved' : 'approval_rejected', q.status, status, strOrNull(comments), user.id);
    notify([a.requested_by, q.owner_id], {
      type: 'approval_decision',
      title: `${q.number} ${decision === 'approved' ? 'approved' : 'rejected'} by ${user.name}`,
      message: strOrNull(comments) || (decision === 'approved' ? 'You can now send it to the customer' : ''),
      link: `/quotations/${q.id}`, severity: decision === 'approved' ? 'success' : 'warning', dedupeKey: `approval_decision:${a.id}`,
    });
    audit(user.id, 'approval', a.id, decision, { quotation: q.number, comments });
  });
}

export function sendQuotation(id, body, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', id);
  if (!['approved', 'sent', 'viewed', 'responded', 'negotiation'].includes(q.status)) {
    throw badRequest(q.status === 'draft' ? 'Submit the quotation for approval before sending' : `Cannot send a quotation that is ${q.status.replace('_', ' ')}`);
  }
  const v = currentVersion(q);
  const fs = followupSettings();
  const validUntil = strOrNull(body.valid_until) || addDays(today(), v.validity_days);
  tx(() => {
    update('quotation_versions', v.id, { locked: 1 });
    const fresh = q.status === 'approved';
    update('quotations', id, {
      status: fresh ? 'sent' : q.status, sent_at: nowIso(), valid_until: validUntil, viewed_at: fresh ? null : q.viewed_at, updated_at: nowIso(),
    });
    event(id, v.version_no, fresh ? 'sent' : 'resent', q.status, fresh ? 'sent' : q.status, body.channel ? `Via ${body.channel}` : null, user.id);
    run("UPDATE followups SET status = 'cancelled' WHERE auto_key = ? AND status = 'pending'", `quote:${id}`);
    insert('followups', {
      title: `Follow up on ${q.number} v${v.version_no}`, type: 'quotation', customer_id: q.customer_id, lead_id: q.lead_id,
      quotation_id: id, assigned_to: q.owner_id, due_date: addDays(today(), fs.quotationFollowupDays), status: 'pending',
      auto_key: `quote:${id}`, created_by: user.id, created_at: nowIso(),
    });
    if (q.lead_id) {
      advanceLeadTo(q.lead_id, 'quotation_sent', user, `${q.number} v${v.version_no} sent`);
      const lead = get('SELECT * FROM leads WHERE id = ?', q.lead_id);
      if (lead?.status === 'open') {
        run('UPDATE leads SET next_action = ?, next_follow_up_date = ?, estimated_value = ? WHERE id = ?',
          `Follow up on quotation ${q.number}`, addDays(today(), fs.quotationFollowupDays), v.taxable_total, lead.id);
        syncLeadFollowup(lead.id); // keep the lead's follow-up task in step with its next action
      }
    }
  });
}

const TRANSITIONS = {
  viewed: ['sent'],
  responded: ['sent', 'viewed', 'revision_requested'],
  revision_requested: ['sent', 'viewed', 'responded', 'negotiation'],
  negotiation: ['sent', 'viewed', 'responded', 'revision_requested'],
  accepted: ['sent', 'viewed', 'responded', 'negotiation', 'revision_requested'],
  rejected: ['approved', 'sent', 'viewed', 'responded', 'revision_requested', 'negotiation'],
  expired: ['sent', 'viewed', 'responded', 'revision_requested', 'negotiation'],
};

/** Record customer-side progress on a sent quotation. `user` is null for portal actions. */
export function setQuotationStatus(id, body, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', id);
  const to = body.status;
  if (!TRANSITIONS[to]) throw badRequest('Unsupported status change');
  if (!TRANSITIONS[to].includes(q.status)) throw badRequest(`Cannot move from ${q.status.replace('_', ' ')} to ${to.replace('_', ' ')}`);
  if (to === 'rejected' && !strOrNull(body.reason)) throw badRequest('Record why the customer rejected the quotation');
  const note = strOrNull(body.note);
  tx(() => {
    const patch = { status: to, updated_at: nowIso() };
    if (to === 'viewed') patch.viewed_at = nowIso();
    if (['responded', 'revision_requested', 'negotiation'].includes(to)) {
      patch.responded_at = nowIso();
      if (note) patch.customer_feedback = note;
    }
    if (to === 'accepted' || to === 'rejected') patch.decided_at = nowIso();
    if (to === 'rejected') patch.rejection_reason = strOrNull(body.reason);
    update('quotations', id, patch);
    event(id, q.current_version, to, q.status, to, note || strOrNull(body.reason), user?.id);

    const actor = user || { id: null, name: 'Customer' };
    if (q.lead_id) {
      if (to === 'negotiation' || to === 'revision_requested') advanceLeadTo(q.lead_id, 'negotiation', actor, `Quotation ${to.replace('_', ' ')}`);
      if (to === 'accepted') advanceLeadTo(q.lead_id, 'po_expected', actor, 'Quotation accepted, PO expected');
      if (to === 'rejected' && body.mark_lead_lost) {
        moveLead(q.lead_id, { status: 'lost', win_loss_reason: strOrNull(body.reason), competitor: body.competitor, note: `${q.number} rejected` }, actor, { system: true });
      }
    }
    if (to === 'accepted') {
      run("UPDATE followups SET title = ?, type = 'po_followup', due_date = ? WHERE auto_key = ? AND status = 'pending'",
        `Collect purchase order for ${q.number}`, addDays(today(), 2), `quote:${id}`);
    }
    if (['rejected', 'expired'].includes(to)) {
      run("UPDATE followups SET status = 'cancelled' WHERE auto_key = ? AND status = 'pending'", `quote:${id}`);
    }
    if (!user && ['viewed', 'accepted', 'revision_requested', 'responded'].includes(to)) {
      notify(q.owner_id, {
        type: 'quotation_customer',
        title: `${q.number}: customer ${to === 'viewed' ? 'opened the quotation' : to.replace('_', ' ')}`,
        message: note, link: `/quotations/${id}`, severity: to === 'accepted' ? 'success' : 'info',
        dedupeKey: `quote_customer:${id}:${to}:${q.current_version}`,
      });
    }
  });
}

/** Full quotation with every version and its items (used for detail view, compare and print). */
export function loadQuotation(id) {
  const q = get(
    `SELECT q.*, c.name AS customer_name, c.code AS customer_code, c.customer_type, c.gstin AS customer_gstin,
            c.billing_address, c.shipping_address, c.city, c.state, c.region_id,
            ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone, ct.whatsapp AS contact_whatsapp, ct.designation AS contact_designation,
            u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, l.code AS lead_code, l.title AS lead_title,
            o.number AS order_number
     FROM quotations q
     JOIN customers c ON c.id = q.customer_id
     LEFT JOIN contacts ct ON ct.id = q.contact_id
     LEFT JOIN users u ON u.id = q.owner_id
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN sales_orders o ON o.id = q.order_id
     WHERE q.id = ?`,
    id,
  );
  if (!q) return null;
  const versions = all(
    `SELECT v.*, u.name AS created_by_name FROM quotation_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.quotation_id = ? ORDER BY v.version_no DESC`,
    id,
  );
  for (const v of versions) {
    v.approval_reasons = parseJson(v.approval_reasons, []);
    v.items = all('SELECT * FROM quotation_items WHERE version_id = ? ORDER BY sort_order', v.id).map((it) => ({ ...it, config: parseJson(it.config) }));
  }
  const events = all(
    `SELECT e.*, u.name AS user_name FROM quotation_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.quotation_id = ? ORDER BY e.created_at DESC, e.id DESC`,
    id,
  );
  const approvals = all(
    `SELECT a.*, r.name AS requested_by_name, d.name AS decided_by_name, v.version_no
     FROM approvals a LEFT JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
     LEFT JOIN quotation_versions v ON v.id = a.version_id
     WHERE a.entity = 'quotation' AND a.entity_id = ? ORDER BY a.requested_at DESC`,
    id,
  ).map((a) => ({ ...a, reasons: parseJson(a.reasons, []) }));
  return { ...q, versions, current: versions.find((v) => v.version_no === q.current_version), events, approvals };
}
