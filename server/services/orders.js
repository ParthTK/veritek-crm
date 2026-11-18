// Orders and order lines: commitments, broad progress updates, date revisions, customer communication,
// dispatch, cancellation and corrections. Quantities are derived from immutable events and kept in a
// current-state read model that can always be reconciled with them.
import { all, get, insert, run, tx, update, updateVersioned } from '../db.js';
import {
  Check, HttpError, badRequest, conflict, forbidden, notFound, now, nowIso, today, tz, calendar, settings, str, intId, bool, num,
  checkOption, optionLabel, nextCode, audit, history, diff, likeTerm, placeholders, parseJson, normName, token,
} from '../util.js';
import { isInstant, localDate, workingDaysBetween, addWorkingDays, isDate } from '../../shared/dates.js';
import {
  SELECTABLE_PHASES, WORK_STATUSES, PHASES, labelOf, COMMITMENT_STATES, PRIORITIES, DISPATCH_STATUSES,
} from '../../shared/constants.js';
import { orderFinance, paymentStatusByOrder } from './finance.js';
import {
  lineQty, lineStatus, orderSummary, isBackwardMove, isPositive, round3, toMinor, lineValueMinor,
} from '../../shared/rules.js';
import { orderScope } from '../access.js';
import { hasPerm } from '../auth.js';
import { requireActiveUser, resolveReporter, defaultCoordinatorId } from './people.js';
import { createTask, cancelTask, recordActivity, tasksWhere, activitiesWhere, decorateTask } from './tasks.js';
import { linkAttachment, attachmentsFor } from './attachments.js';
import { maybeMarkWon, applyConvertedQuantities } from './enquiries.js';
import { commStateForLine } from './customers.js';

// ------------------------------------------------------------------ loading
export function loadOrder(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  if (!o) throw notFound('Order');
  return o;
}

export function loadLine(id) {
  const l = get(`SELECT l.*, o.status AS order_status, o.customer_id, o.owner_id AS order_owner_id, o.code AS order_code
    FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ?`, id);
  if (!l) throw notFound('Order line');
  return l;
}

function checkVersion(row, version, label) {
  if (version !== undefined && version !== null && version !== '' && Number(version) !== row.version) {
    throw conflict(`Someone else updated this ${label}. Review the latest values before saving.`, { code: 'version_conflict', current: row });
  }
}

/** Freshness uses the reported/as-of time of the last substantive update, in working days. */
export function freshness(l) {
  const threshold = settings().rules.staleWorkingDays;
  if (!l.source_update_at) return { stale: true, working_days: null, as_of: null, basis: null, threshold };
  const wd = workingDaysBetween(localDate(new Date(l.source_update_at), tz()), today(), calendar());
  return { stale: wd >= threshold, working_days: wd, as_of: l.source_update_at, basis: l.source_update_basis, threshold };
}

function readyWaiting(l) {
  const q = lineQty(l);
  if (!isPositive(q.remaining)) return false;
  return q.ready !== null ? isPositive(q.readyNotDispatched) : l.phase === 'ready';
}

export function decorateLine(l, orderStatus) {
  const q = lineQty(l);
  const st = lineStatus(l, today(), orderStatus);
  const active = orderStatus === 'confirmed' && st.active;
  return {
    ...l,
    product: l.product_code || l.description,
    quantities: q,
    status: st,
    freshness: active ? freshness(l) : null,
    comm: active ? commStateForLine(l.id) : { state: 'not_needed' },
    ready_waiting: active && readyWaiting(l),
    issue_label: l.issue_code ? optionLabel('delay_reason', l.issue_code) : null,
    phase_label: labelOf(PHASES, isPositive(q.remaining) || !isPositive(q.dispatched) ? l.phase : 'dispatched'),
    work_status_label: labelOf(WORK_STATUSES, l.work_status),
    value_minor: lineValueMinor(round3(q.confirmed - q.cancelled), l.unit_price_minor),
  };
}

const LINE_SELECT = `SELECT l.*, p.code AS product_code, p.name AS product_name, p.family, p.integer_qty,
  ru.name AS reporter_user_name,
  (SELECT t.id FROM tasks t WHERE t.line_id = l.id AND t.status = 'open' AND t.kind = 'internal' ORDER BY t.overdue_at LIMIT 1) AS action_task_id
  FROM order_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN users ru ON ru.id = l.last_reported_by_id`;

// ------------------------------------------------------------------ create & confirm
function validateLines(c, lines, { confirming, allowUnknown = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    c.fail('lines', 'Add at least one order line');
    return [];
  }
  return lines.map((l, i) => {
    const productId = intId(l.product_id);
    const product = productId ? get('SELECT * FROM products WHERE id = ?', productId) : null;
    if (productId && !product) c.fail(`lines.${i}.product_id`, 'Choose a product from the list');
    const description = str(l.description, 300) || product?.name || null;
    if (!productId && !description) c.fail(`lines.${i}.description`, 'Choose a product or describe the item');
    c.positive(`lines.${i}.confirmed_qty`, l.confirmed_qty, { label: 'Quantity' });
    const qty = num(l.confirmed_qty);
    if (qty && product?.integer_qty && !Number.isInteger(qty)) c.fail(`lines.${i}.confirmed_qty`, 'Whole pieces only for this product');
    const state = l.commitment_state || (l.original_commitment_date ? 'committed' : confirming ? null : 'uncommitted');
    if (!COMMITMENT_STATES.some((s) => s.value === state)) c.fail(`lines.${i}.commitment_state`, 'Choose a committed dispatch date, or mark it as not yet agreed');
    else if (state === 'unknown' && !allowUnknown) c.fail(`lines.${i}.commitment_state`, 'Unknown commitments are only for imported historical orders');
    if (state === 'committed') c.date(`lines.${i}.original_commitment_date`, l.original_commitment_date, { required: true, message: 'Committed dispatch date is required' });
    const price = l.unit_price === undefined || l.unit_price === null || l.unit_price === '' ? (l.unit_price_minor ?? null) : toMinor(l.unit_price);
    if (Number.isNaN(price) || (price !== null && price < 0)) c.fail(`lines.${i}.unit_price`, 'Enter a valid price (up to 2 decimals)');
    c.text(`lines.${i}.spec`, l.spec, { max: 300, label: 'Specification' });
    const discount = l.discount_pct === undefined || l.discount_pct === null || l.discount_pct === '' ? null : Number(l.discount_pct);
    if (discount !== null && (!Number.isFinite(discount) || discount < 0 || discount > 100)) c.fail(`lines.${i}.discount_pct`, 'Discount must be 0–100%');
    const gst = l.gst_rate === undefined || l.gst_rate === null || l.gst_rate === '' ? (product?.gst_rate ?? null) : Number(l.gst_rate);
    if (gst !== null && (!Number.isFinite(gst) || gst < 0 || gst > 40)) c.fail(`lines.${i}.gst_rate`, 'GST rate looks wrong');
    return {
      product_id: productId,
      sku: str(l.sku, 40) || product?.code || null,
      hsn: str(l.hsn, 20) || product?.hsn || null,
      config: l.config ? JSON.stringify(typeof l.config === 'string' ? parseJson(l.config, null) : l.config) : null,
      list_price_minor: Number.isInteger(l.list_price_minor) ? l.list_price_minor : null,
      discount_pct: discount,
      gst_rate: gst,
      cost_price_minor: Number.isInteger(l.cost_price_minor) ? l.cost_price_minor : (product?.cost_price_minor ?? null),
      description: description || 'Unspecified item',
      spec: str(l.spec, 300),
      needs_clarification: bool(l.needs_clarification) || (!productId) ? 1 : 0,
      unit: str(l.unit, 20) || product?.default_unit || 'pcs',
      confirmed_qty: qty === null ? null : round3(qty),
      unit_price_minor: Number.isNaN(price) ? null : price,
      commitment_state: state,
      original_commitment_date: state === 'committed' ? l.original_commitment_date : null,
      enquiry_line_id: intId(l.enquiry_line_id),
      quote_line_index: l.quote_line_index ?? null,
    };
  });
}

/**
 * Header details carried over from the earlier order module: priority, factory, named owners for
 * production / dispatch / accounts, advance terms, freight and installation charges. All optional.
 */
function headerExtras(c, input, customer) {
  const out = {};
  if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
    if (!PRIORITIES.some((p) => p.value === input.priority)) c.fail('priority', 'Choose a priority');
    else out.priority = input.priority;
  }
  if (input.factory_id !== undefined) {
    const f = intId(input.factory_id);
    if (f && !get('SELECT id FROM factories WHERE id = ?', f)) c.fail('factory_id', 'Choose a factory');
    out.factory_id = f;
  }
  for (const k of ['production_owner_id', 'dispatch_owner_id', 'accounts_owner_id']) {
    if (input[k] === undefined) continue;
    const uid = intId(input[k]);
    if (uid) requireActiveUser(c, k, uid, 'Owner');
    out[k] = uid;
  }
  if (input.advance_pct !== undefined) {
    const p = input.advance_pct === '' || input.advance_pct === null ? null : Number(input.advance_pct);
    if (p !== null && (!Number.isFinite(p) || p < 0 || p > 100)) c.fail('advance_pct', 'Advance must be 0–100%');
    else out.advance_pct = p;
  }
  if (input.advance_required !== undefined) {
    const m = input.advance_required === '' || input.advance_required === null ? null : toMinor(input.advance_required);
    if (Number.isNaN(m) || (m !== null && m < 0)) c.fail('advance_required', 'Enter a valid amount');
    else out.advance_required_minor = m;
  }
  for (const k of ['freight', 'installation']) {
    if (input[k] === undefined) continue;
    const m = input[k] === '' || input[k] === null ? 0 : toMinor(input[k]);
    if (Number.isNaN(m) || m < 0) c.fail(k, 'Enter a valid amount');
    else out[`${k}_minor`] = m;
  }
  if (customer && out.advance_pct === undefined && /(\d{1,3})\s*%\s*advance/i.test(customer.payment_terms || '')) out.advance_pct = Number(/(\d{1,3})\s*%\s*advance/i.exec(customer.payment_terms)[1]);
  return out;
}

/** Required advance = advance % × order value (when prices are known), unless an amount was entered. */
function refreshAdvance(orderId) {
  const o = get('SELECT advance_pct, advance_required_minor, freight_minor, installation_minor FROM orders WHERE id = ?', orderId);
  if (!o || o.advance_pct === null || o.advance_pct === undefined) return;
  const lines = all('SELECT confirmed_qty, cancelled_qty, unit_price_minor, gst_rate FROM order_lines WHERE order_id = ?', orderId);
  if (!lines.length || lines.some((l) => l.unit_price_minor === null)) return;
  const taxable = lines.reduce((s, l) => s + lineValueMinor(round3(l.confirmed_qty - l.cancelled_qty), l.unit_price_minor), 0) + (o.freight_minor || 0) + (o.installation_minor || 0);
  const tax = lines.reduce((s, l) => s + Math.round((lineValueMinor(round3(l.confirmed_qty - l.cancelled_qty), l.unit_price_minor) * (l.gst_rate || 0)) / 100), 0);
  run('UPDATE orders SET advance_required_minor = ? WHERE id = ?', Math.round(((taxable + tax) * o.advance_pct) / 100), orderId);
}

function checkDuplicatePo(customerId, po, excludeOrderId) {
  const norm = normName(po).replace(/\s/g, '');
  if (!norm) return [];
  return all('SELECT id, code, status, received_date FROM orders WHERE customer_id = ? AND po_norm = ? AND id IS NOT ? AND archived_at IS NULL', customerId, norm, excludeOrderId ?? null);
}

/**
 * Enters an order (draft, or confirmed straight away when everything required is present).
 * A direct/repeat order without a quotation needs a source and a PO reference or short explanation.
 */
export function createOrder(input, user, { fromRevision = null, importBatchId = null, allowUnknown = false, sourceConfidence = null } = {}) {
  const c = new Check();
  const customerId = intId(input.customer_id);
  const customer = customerId ? get('SELECT * FROM customers WHERE id = ?', customerId) : null;
  if (!customer) c.fail('customer_id', 'Choose the customer');
  else if (customer.merged_into_id) c.fail('customer_id', 'This profile was merged — choose the surviving customer');
  const ownerId = intId(input.owner_id) || customer?.owner_id || user.id;
  requireActiveUser(c, 'owner_id', ownerId, 'Sales owner');
  if (input.coordinator_id) requireActiveUser(c, 'coordinator_id', intId(input.coordinator_id), 'Coordinator');
  if (!(allowUnknown && bool(input.received_unknown))) c.date('received_date', input.received_date, { required: true, message: 'Order received date is required' });
  if (input.received_date && input.received_date > today()) c.fail('received_date', 'The received date cannot be in the future');
  const confirming = bool(input.confirm);
  const lines = validateLines(c, input.lines, { confirming, allowUnknown });
  if (!fromRevision && input.source_code) checkOption(c, 'source_code', 'order_source', input.source_code, { note: input.confirmation_note, noteField: 'confirmation_note' });
  c.text('po_reference', input.po_reference, { max: 80, label: 'PO reference' });
  c.note('confirmation_note', input.confirmation_note);
  c.note('notes', input.notes);
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency)) c.fail('currency', 'Use a 3-letter currency code');
  if (lines.some((l) => l.unit_price_minor !== null) && !(input.currency || fromRevision?.currency)) c.fail('currency', 'Choose the currency for the prices entered');
  const header = headerExtras(c, input, customer);
  c.throwIfAny();
  if (input.po_reference && !bool(input.confirm_duplicate_po)) {
    const dupes = checkDuplicatePo(customerId, input.po_reference);
    if (dupes.length) throw conflict(`This customer already has an order with PO "${input.po_reference}" (${dupes.map((d) => d.code).join(', ')}). Confirm it is a different order.`, { code: 'duplicate_po', orders: dupes });
  }

  return tx(() => {
    const stamp = nowIso();
    const id = insert('orders', {
      code: nextCode('SO'),
      customer_id: customerId,
      contact_id: intId(input.contact_id) || get('SELECT id FROM contacts WHERE customer_id = ? AND active = 1 ORDER BY is_primary DESC, id LIMIT 1', customerId)?.id || null,
      owner_id: ownerId,
      coordinator_id: intId(input.coordinator_id),
      status: 'draft',
      po_reference: str(input.po_reference, 80),
      po_norm: input.po_reference ? normName(input.po_reference).replace(/\s/g, '') : null,
      po_date: isDate(input.po_date) ? input.po_date : null,
      received_date: input.received_date || null,
      received_unknown: allowUnknown && bool(input.received_unknown) ? 1 : 0,
      enquiry_id: intId(input.enquiry_id) || fromRevision?.enquiry_id || null,
      quote_revision_id: fromRevision?.id ?? null,
      source_code: fromRevision ? 'quotation' : input.source_code || null,
      confirmation_type: input.confirmation_type || null,
      confirmation_note: str(input.confirmation_note, 1000),
      confirmation_document_id: intId(input.confirmation_document_id),
      currency: input.currency || fromRevision?.currency || (customer.segment === 'export' ? 'USD' : 'INR'),
      payment_terms: str(input.payment_terms, 300) || customer.payment_terms || null,
      delivery_address: str(input.delivery_address, 500) || customer.shipping_address || null,
      billing_address: str(input.billing_address, 500) || customer.billing_address || null,
      ...header,
      tracking_token: token(16),
      shipping_mode: str(input.shipping_mode, 60),
      segment: input.segment || customer.segment || null,
      notes: str(input.notes, 1000),
      external_order_ref: str(input.external_order_ref, 80),
      external_invoice_ref: str(input.external_invoice_ref, 80),
      import_batch_id: importBatchId,
      external_id: str(input.external_id, 80),
      source_confidence: sourceConfidence,
      created_by: user.id,
      created_at: stamp,
      updated_at: stamp,
    });
    lines.forEach((l, i) => insert('order_lines', {
      order_id: id, line_no: i + 1, ...l, forecast_dispatch_date: l.original_commitment_date, created_at: stamp, updated_at: stamp,
    }));
    refreshAdvance(id);
    if (input.confirmation_document_id) linkAttachment(intId(input.confirmation_document_id), 'order', id, user);
    if (fromRevision?.document_id) linkAttachment(fromRevision.document_id, 'order', id, user);
    const enquiryId = intId(input.enquiry_id) || fromRevision?.enquiry_id;
    if (enquiryId) for (const a of all("SELECT attachment_id FROM attachment_links WHERE entity_type = 'enquiry' AND entity_id = ?", enquiryId)) linkAttachment(a.attachment_id, 'order', id, user);
    history('order', id, 'created', { customerId, data: { code: get('SELECT code FROM orders WHERE id = ?', id).code, status: 'draft' } });
    audit('order', id, 'create', { customer_id: customerId, lines: lines.length, from_revision: fromRevision?.id ?? null, po_reference: input.po_reference });
    if (confirming) confirmOrder(id, { reported_by_id: input.reported_by_id }, user, { allowUnknown });
    return id;
  });
}

export function updateDraftOrder(id, input, user) {
  const o = loadOrder(id);
  if (o.status !== 'draft') throw conflict('Only draft orders can be edited freely. Use an amendment for confirmed orders.');
  checkVersion(o, input.version, 'order');
  const c = new Check();
  const lines = input.lines ? validateLines(c, input.lines, { confirming: false }) : null;
  if (input.received_date !== undefined) c.date('received_date', input.received_date, { required: true });
  if (input.owner_id !== undefined) requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Sales owner');
  const extras = headerExtras(c, input, null);
  c.throwIfAny();
  return tx(() => {
    const fields = { ...extras };
    for (const k of ['po_reference', 'received_date', 'payment_terms', 'delivery_address', 'billing_address', 'shipping_mode', 'notes', 'currency', 'confirmation_note', 'confirmation_type', 'source_code', 'segment']) {
      if (input[k] !== undefined) fields[k] = str(input[k], 1000);
    }
    if (input.po_reference !== undefined) fields.po_norm = input.po_reference ? normName(input.po_reference).replace(/\s/g, '') : null;
    if (input.owner_id !== undefined) fields.owner_id = intId(input.owner_id);
    if (input.coordinator_id !== undefined) fields.coordinator_id = intId(input.coordinator_id);
    if (!updateVersioned('orders', id, o.version, { ...fields, updated_at: nowIso() })) throw conflict('Someone else updated this order.', { code: 'version_conflict' });
    if (lines) {
      const existing = all('SELECT id FROM order_lines WHERE order_id = ?', id).map((r) => r.id);
      const stamp = nowIso();
      const keep = new Set();
      input.lines.forEach((raw, i) => {
        const lid = intId(raw.id);
        const data = { ...lines[i], line_no: i + 1, forecast_dispatch_date: lines[i].original_commitment_date, updated_at: stamp };
        if (lid && existing.includes(lid)) {
          update('order_lines', lid, data);
          keep.add(lid);
        } else insert('order_lines', { order_id: id, ...data, created_at: stamp });
      });
      for (const lid of existing) if (!keep.has(lid)) run('DELETE FROM order_lines WHERE id = ?', lid);
    }
    refreshAdvance(id);
    audit('order', id, 'update_draft', fields);
    return { id };
  });
}

/**
 * Header details of a confirmed order that are not commitments or quantities: priority, factory, named
 * owners, addresses, shipping, notes, advance terms and charges. Commercial terms need the amend permission.
 */
export function updateOrderHeader(id, input, user) {
  const o = loadOrder(id);
  if (o.status !== 'confirmed') return updateDraftOrder(id, input, user);
  checkVersion(o, input.version, 'order');
  const c = new Check();
  const fields = headerExtras(c, input, null);
  const commercial = ['payment_terms', 'advance_pct', 'advance_required', 'freight', 'installation', 'currency'].some((k) => input[k] !== undefined);
  if (commercial && !hasPerm(user, 'orders.amend')) throw forbidden('Changing commercial terms on a confirmed order needs the coordinator or management');
  if (input.owner_id !== undefined) {
    if (requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Sales owner')) fields.owner_id = intId(input.owner_id);
  }
  if (input.coordinator_id !== undefined) {
    const cid = intId(input.coordinator_id);
    if (cid) requireActiveUser(c, 'coordinator_id', cid, 'Coordinator');
    fields.coordinator_id = cid;
  }
  for (const k of ['payment_terms', 'delivery_address', 'billing_address', 'shipping_mode', 'notes', 'external_order_ref', 'external_invoice_ref']) {
    if (input[k] !== undefined) fields[k] = str(input[k], k.endsWith('address') ? 500 : 1000);
  }
  if (input.po_reference !== undefined) {
    fields.po_reference = str(input.po_reference, 80);
    fields.po_norm = input.po_reference ? normName(input.po_reference).replace(/\s/g, '') : null;
  }
  c.throwIfAny();
  const changes = diff(o, { ...o, ...fields }, Object.keys(fields));
  if (!Object.keys(changes).length) return { id, unchanged: true };
  return tx(() => {
    if (!updateVersioned('orders', id, o.version, { ...fields, updated_at: nowIso() })) throw conflict('Someone else updated this order.', { code: 'version_conflict' });
    refreshAdvance(id);
    insert('order_updates', { order_id: id, kind: 'header', changes: JSON.stringify(changes), note: str(input.reason, 300), occurred_at: nowIso(), entered_at: nowIso(), entered_by: user.id, substantive: 0, record_version: o.version + 1 });
    if (changes.owner_id) history('order', id, 'owner_changed', { customerId: o.customer_id, data: { code: o.code, from: changes.owner_id[0], to: changes.owner_id[1] } });
    audit('order', id, 'update_header', changes);
    return { id };
  });
}

/**
 * Confirmation needs a confirmed (non-provisional) customer, line descriptions, positive quantities and an
 * explicit commitment state per line. Production status never changes automatically on confirmation.
 */
export function confirmOrder(id, input, user, { allowUnknown = false } = {}) {
  const o = loadOrder(id);
  if (o.status === 'confirmed') return { id, unchanged: true };
  checkVersion(o, input.version, 'order');
  const customer = get('SELECT * FROM customers WHERE id = ?', o.customer_id);
  const lines = all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_no', id);
  const c = new Check();
  if (customer.provisional) c.fail('customer_id', 'The customer is provisional. Confirm the company details before confirming the order.');
  if (!lines.length) c.fail('lines', 'Add at least one line');
  lines.forEach((l, i) => {
    if (!l.description) c.fail(`lines.${i}.description`, 'Describe the item');
    if (!(l.confirmed_qty > 0)) c.fail(`lines.${i}.confirmed_qty`, 'Quantity must be greater than zero');
    if (l.commitment_state === 'committed' && !l.original_commitment_date) c.fail(`lines.${i}.original_commitment_date`, 'Committed dispatch date is required');
    if (l.commitment_state === 'unknown' && !allowUnknown) c.fail(`lines.${i}.commitment_state`, 'Choose a committed date or mark it as not yet agreed');
  });
  if (!o.quote_revision_id && !o.import_batch_id) {
    if (!o.source_code) c.fail('source_code', 'Choose how this order came in (repeat order, PO without enquiry…)');
    if (!o.po_reference && !o.confirmation_note) c.fail('po_reference', 'Enter the customer PO reference, or a short note of who confirmed and when');
  }
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    if (!updateVersioned('orders', id, o.version, { status: 'confirmed', confirmed_at: stamp, confirmed_by: user.id, updated_at: stamp })) {
      throw conflict('Someone else updated this order.', { code: 'version_conflict' });
    }
    for (const l of lines) {
      update('order_lines', l.id, {
        original_qty: l.confirmed_qty,
        forecast_dispatch_date: l.forecast_dispatch_date || l.original_commitment_date,
        source_update_at: stamp,
        source_update_basis: 'entry_time',
        updated_at: stamp,
      });
      if (l.original_commitment_date) {
        insert('commitment_changes', { line_id: l.id, order_id: id, kind: 'original', old_date: null, new_date: l.original_commitment_date, actor_id: user.id, created_at: stamp, occurred_at: stamp });
      }
      if (l.commitment_state === 'uncommitted') {
        createTask({
          line_id: l.id, purpose: `Agree dispatch commitment for ${o.code} line ${l.line_no}`, purpose_code: 'agree_commitment', owner_id: o.owner_id,
          due_date: addWorkingDays(today(), 1, calendar()), kind: 'customer', source: 'order_confirmed', alert_key: `agree_commitment:${l.id}`,
        }, user, { validated: true });
      }
      if (l.needs_clarification) {
        createTask({
          line_id: l.id, purpose: `Clarify specification before production (${o.code} line ${l.line_no})`, purpose_code: 'clarify_spec', owner_id: o.owner_id,
          due_date: addWorkingDays(today(), 1, calendar()), kind: 'customer', source: 'order_confirmed', alert_key: `clarify_spec:${l.id}`,
        }, user, { validated: true });
      }
    }
    insert('order_updates', { order_id: id, kind: 'confirm', changes: JSON.stringify({ status: ['draft', 'confirmed'] }), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: o.version + 1 });
    history('order', id, 'confirmed', { customerId: o.customer_id, data: { code: o.code } });
    audit('order', id, 'confirm', { lines: lines.length });
    if (o.enquiry_id) maybeMarkWon(o.enquiry_id, user);
    const rc = get("SELECT * FROM reactivation_cases WHERE customer_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1", o.customer_id);
    if (rc && rc.enquiry_id && rc.enquiry_id === o.enquiry_id) {
      run("UPDATE reactivation_cases SET status = 'won_back', order_id = ?, closed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", id, stamp, stamp, rc.id);
      history('customer', o.customer_id, 'won_back', { customerId: o.customer_id, data: { order_id: id, code: o.code } });
    }
    return { id };
  });
}

// ------------------------------------------------------------------ read
export function getOrder(id, user) {
  const o = get(`SELECT o.*, c.company_name AS customer_name, c.code AS customer_code, c.do_not_contact, c.segment AS customer_segment, c.credit_hold,
      u.name AS owner_name, cu.name AS coordinator_name, cb.name AS confirmed_by_name, ct.name AS contact_name, ct.phone_raw AS contact_phone, ct.email_raw AS contact_email,
      e.code AS enquiry_code, q.number AS quote_number, r.revision_no AS quote_revision_no, q.id AS quotation_id,
      f.name AS factory_name, po.name AS production_owner_name, dop.name AS dispatch_owner_name, ao.name AS accounts_owner_name
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN users u ON u.id = o.owner_id LEFT JOIN users cu ON cu.id = o.coordinator_id
    LEFT JOIN users cb ON cb.id = o.confirmed_by LEFT JOIN contacts ct ON ct.id = o.contact_id LEFT JOIN enquiries e ON e.id = o.enquiry_id
    LEFT JOIN quote_revisions r ON r.id = o.quote_revision_id LEFT JOIN quotations q ON q.id = r.quotation_id LEFT JOIN factories f ON f.id = o.factory_id
    LEFT JOIN users po ON po.id = o.production_owner_id LEFT JOIN users dop ON dop.id = o.dispatch_owner_id LEFT JOIN users ao ON ao.id = o.accounts_owner_id WHERE o.id = ?`, id);
  if (!o) throw notFound('Order');
  const rawLines = all(`${LINE_SELECT} WHERE l.order_id = ? ORDER BY l.line_no`, id);
  const lines = rawLines.map((l) => {
    const d = decorateLine(l, o.status);
    const issue = get(`SELECT li.*, u.name AS entered_by_name FROM line_issues li LEFT JOIN users u ON u.id = li.entered_by WHERE li.line_id = ? AND li.resolved_at IS NULL ORDER BY li.id DESC LIMIT 1`, l.id);
    const action = l.action_task_id ? decorateTask(get(`SELECT t.*, u.name AS owner_name, u.department AS owner_department FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.id = ?`, l.action_task_id)) : null;
    return { ...d, issue, action, reported_by: l.last_reported_by_name || l.reporter_user_name || null };
  });
  const summary = orderSummary(o, rawLines, today());
  const updates = all(`SELECT ou.*, u.name AS entered_by_name, l.line_no, COALESCE(p.code, l.description) AS product
    FROM order_updates ou LEFT JOIN users u ON u.id = ou.entered_by LEFT JOIN order_lines l ON l.id = ou.line_id LEFT JOIN products p ON p.id = l.product_id
    WHERE ou.order_id = ? ORDER BY ou.occurred_at DESC, ou.id DESC LIMIT 300`, id).map((u) => ({ ...u, changes: parseJson(u.changes, {}) }));
  const dateHistory = all(`SELECT cc.*, u.name AS actor_name, l.line_no, iu.name AS informed_by_name
    FROM commitment_changes cc LEFT JOIN users u ON u.id = cc.actor_id LEFT JOIN users iu ON iu.id = cc.informed_by JOIN order_lines l ON l.id = cc.line_id
    WHERE cc.order_id = ? ORDER BY cc.id DESC`, id);
  const dispatches = all(`SELECT d.*, u.name AS created_by_name, ru.name AS reversed_by_name FROM dispatches d LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users ru ON ru.id = d.reversed_by
    WHERE d.id IN (SELECT dispatch_id FROM dispatch_lines WHERE order_id = ?) ORDER BY d.dispatch_date DESC, d.id DESC`, id)
    .map((d) => ({ ...d, lines: all(`SELECT dl.*, l.line_no, COALESCE(p.code, l.description) AS product, l.unit, o2.code AS order_code FROM dispatch_lines dl JOIN order_lines l ON l.id = dl.line_id
      JOIN orders o2 ON o2.id = dl.order_id LEFT JOIN products p ON p.id = l.product_id WHERE dl.dispatch_id = ?`, d.id), attachments: attachmentsFor('dispatch', d.id) }));
  const cancellations = all(`SELECT k.*, u.name AS created_by_name, ru.name AS reversed_by_name, l.line_no, COALESCE(p.code, l.description) AS product, l.unit
    FROM cancellations k LEFT JOIN users u ON u.id = k.created_by LEFT JOIN users ru ON ru.id = k.reversed_by JOIN order_lines l ON l.id = k.line_id LEFT JOIN products p ON p.id = l.product_id
    WHERE k.order_id = ? ORDER BY k.id DESC`, id).map((k) => ({ ...k, reason: optionLabel('cancel_reason', k.reason_code) }));
  const communications = all(`SELECT cf.*, a.note AS activity_note, a.channel AS activity_channel, u.name AS entered_by_name, ct.name AS contact_name, l.line_no
    FROM communication_confirmations cf JOIN activities a ON a.id = cf.activity_id LEFT JOIN users u ON u.id = cf.entered_by LEFT JOIN contacts ct ON ct.id = cf.contact_id
    JOIN order_lines l ON l.id = cf.line_id WHERE cf.order_id = ? ORDER BY cf.occurred_at DESC`, id).map((x) => ({ ...x, response: optionLabel('customer_update_outcome', x.response_code) }));
  const attachments = [...attachmentsFor('order', id), ...rawLines.flatMap((l) => attachmentsFor('order_line', l.id))];
  if (o.quote_revision_id) for (const a of attachmentsFor('quote_revision', o.quote_revision_id)) if (!attachments.some((x) => x.id === a.id)) attachments.push({ ...a, via: 'quotation' });
  const holds = all(`SELECT h.*, u.name AS authorised_by_name, ru.name AS released_by_name FROM payment_holds h LEFT JOIN users u ON u.id = h.authorised_by LEFT JOIN users ru ON ru.id = h.released_by WHERE h.order_id = ? ORDER BY h.id DESC`, id);
  const alerts = all("SELECT * FROM alerts WHERE order_id = ? AND resolved_at IS NULL ORDER BY severity DESC, first_seen_at", id);
  const valueByCurrency = {};
  for (const l of lines) if (l.value_minor !== null) valueByCurrency[o.currency || 'INR'] = (valueByCurrency[o.currency || 'INR'] || 0) + l.value_minor;
  return {
    order: { ...o, source_label: o.source_code === 'quotation' ? 'Accepted quotation' : optionLabel('order_source', o.source_code), pinned: Boolean(get("SELECT 1 FROM pins WHERE user_id = ? AND entity_type = 'order' AND entity_id = ?", user.id, id)) },
    summary: { ...summary, value_by_currency: valueByCurrency, lines_without_price: lines.filter((l) => l.unit_price_minor === null).length },
    lines,
    updates,
    date_history: dateHistory,
    dispatches,
    cancellations,
    communications,
    tasks: tasksWhere('order_id', id),
    activities: activitiesWhere('order_id', id),
    attachments,
    holds,
    alerts,
    finance: hasPerm(user, 'finance.view') ? orderFinance(id) : null,
    payment: paymentStatusByOrder([id]).get(id) || null,
    complaints: all('SELECT id, code, status, category_code, received_date FROM complaints WHERE order_id = ? ORDER BY id DESC', id).map((k) => ({ ...k, category: optionLabel('complaint_category', k.category_code) })),
  };
}

/**
 * Active-order list. Lines are classified in one place (shared rules) so counts here, on the dashboard
 * and in reports always agree.
 */
export function loadOrdersWithLines(where = [], params = [], user = null) {
  const w = ['o.archived_at IS NULL', ...where];
  if (user) {
    const scope = orderScope(user, 'o');
    if (scope) w.push(scope);
  }
  const orders = all(`SELECT o.*, c.company_name AS customer_name, c.code AS customer_code, c.segment AS customer_segment, c.country_code, u.name AS owner_name
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN users u ON u.id = o.owner_id WHERE ${w.join(' AND ')} ORDER BY o.id`, ...params);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const lines = all(`${LINE_SELECT} WHERE l.order_id IN (${placeholders(ids)}) ORDER BY l.order_id, l.line_no`, ids);
  const byOrder = new Map(ids.map((i) => [i, []]));
  for (const l of lines) byOrder.get(l.order_id).push(l);
  return orders.map((o) => ({ order: o, lines: byOrder.get(o.id) }));
}

/** How far an order has got: share of its net quantity built (ready or already dispatched) and dispatched. */
function orderProgress(lines) {
  let total = 0;
  let built = 0;
  let dispatched = 0;
  for (const l of lines) {
    const net = Math.max(0, l.quantities.confirmed - l.quantities.cancelled);
    total += net;
    dispatched += l.quantities.dispatched;
    const ready = l.quantities.ready ?? (l.phase === 'ready' ? net : 0);
    built += Math.min(net, Math.max(ready, l.quantities.dispatched));
  }
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
  return { ready_pct: pct(built), dispatched_pct: pct(dispatched) };
}

export function orderListRow(o, lines, pinnedIds = new Set()) {
  const day = today();
  const summary = orderSummary(o, lines, day);
  const decorated = lines.map((l) => decorateLine(l, o.status));
  const active = decorated.filter((l) => l.status.active);
  const lastUpdate = lines.map((l) => l.source_update_at).filter(Boolean).sort().at(-1) || null;
  const valueRemaining = {};
  for (const l of active) {
    const v = lineValueMinor(l.quantities.remaining, l.unit_price_minor);
    if (v !== null) valueRemaining[o.currency || 'INR'] = (valueRemaining[o.currency || 'INR'] || 0) + v;
  }
  return {
    id: o.id, code: o.code, status: o.status, customer_id: o.customer_id, customer_name: o.customer_name, customer_code: o.customer_code,
    segment: o.segment || o.customer_segment, country_code: o.country_code, po_reference: o.po_reference, owner_id: o.owner_id, owner_name: o.owner_name,
    received_date: o.received_date, confirmed_at: o.confirmed_at, closed_at: o.closed_at, currency: o.currency, version: o.version,
    priority: o.priority, factory_id: o.factory_id, enquiry_id: o.enquiry_id, quote_revision_id: o.quote_revision_id, progress: orderProgress(decorated),
    phase: summary.phase, outcome: summary.outcome, totals: summary.totals, earliest_due: summary.earliest_due, latest_due: summary.latest_due,
    active: summary.active, overdue: summary.overdue, at_risk: summary.at_risk, delayed: summary.delayed, issue: summary.issue, uncommitted: summary.uncommitted,
    max_days_late: Math.max(0, ...active.map((l) => l.status.daysLate || 0)),
    past_agreed: active.some((l) => l.status.pastAgreed),
    stale_lines: active.filter((l) => l.freshness?.stale).length,
    comm_pending: active.filter((l) => l.comm.state === 'pending').length,
    ready_waiting: active.filter((l) => l.ready_waiting).length,
    estimate_unknown: active.filter((l) => l.estimate_unknown).length,
    no_action: active.filter((l) => (l.status.delayed || l.issue_code) && !l.action_task_id).length,
    last_update_at: lastUpdate,
    remaining_value_by_currency: valueRemaining,
    pinned: pinnedIds.has(o.id),
    lines: decorated.map((l) => ({
      id: l.id, line_no: l.line_no, product: l.product, family: l.family, unit: l.unit, quantities: l.quantities, phase: l.phase, phase_label: l.phase_label,
      work_status: l.work_status, state: l.status.state, days_late: l.status.daysLate, original_commitment_date: l.original_commitment_date,
      agreed_commitment_date: l.agreed_commitment_date, forecast_dispatch_date: l.forecast_dispatch_date, forecast_ready_date: l.forecast_ready_date,
      estimate_unknown: Boolean(l.estimate_unknown), commitment_state: l.commitment_state, issue_code: l.issue_code, issue_label: l.issue_label, stage_note: l.stage_note,
      comm_state: l.comm.state, stale: Boolean(l.freshness?.stale), freshness: l.freshness, ready_waiting: l.ready_waiting, action_task_id: l.action_task_id,
      needs_clarification: Boolean(l.needs_clarification), version: l.version, source_update_at: l.source_update_at,
    })),
  };
}

const STATE_FILTERS = {
  overdue: (r) => r.overdue,
  at_risk: (r) => r.at_risk || r.lines.some((l) => l.state === 'at_risk'),
  delayed: (r) => r.delayed,
  issue: (r) => r.issue,
  stale: (r) => r.stale_lines > 0,
  ready_waiting: (r) => r.ready_waiting > 0,
  not_informed: (r) => r.comm_pending > 0,
  uncommitted: (r) => r.uncommitted,
  estimate_unknown: (r) => r.estimate_unknown > 0,
  no_action: (r) => r.no_action > 0,
  due_soon: (r) => r.earliest_due && r.earliest_due <= addWorkingDays(today(), 5, calendar()) && !r.overdue,
};

export function listOrders(query, user) {
  const where = [];
  const params = [];
  const view = query.view || 'active';
  if (view === 'active') where.push("o.status = 'confirmed' AND o.closed_at IS NULL");
  else if (view === 'drafts') where.push("o.status = 'draft'");
  else if (view === 'closed') where.push("o.status = 'confirmed' AND o.closed_at IS NOT NULL");
  if (query.owner === 'me') {
    where.push('o.owner_id = ?');
    params.push(user.id);
  } else if (intId(query.owner)) {
    where.push('o.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (intId(query.customer_id)) {
    where.push('o.customer_id = ?');
    params.push(intId(query.customer_id));
  }
  if (query.segment) {
    where.push('COALESCE(o.segment, c.segment) = ?');
    params.push(query.segment);
  }
  if (query.country) {
    where.push('c.country_code = ?');
    params.push(query.country);
  }
  if (query.family) {
    where.push('EXISTS (SELECT 1 FROM order_lines l2 JOIN products p2 ON p2.id = l2.product_id WHERE l2.order_id = o.id AND p2.family = ?)');
    params.push(query.family);
  }
  if (query.priority) {
    where.push('o.priority = ?');
    params.push(query.priority);
  }
  if (intId(query.factory_id)) {
    where.push('o.factory_id = ?');
    params.push(intId(query.factory_id));
  }
  if (query.ids) {
    const ids = String(query.ids).split(',').map(intId).filter(Boolean);
    where.push(ids.length ? `o.id IN (${placeholders(ids)})` : '1 = 0');
    params.push(...ids);
  }
  if (query.q) {
    where.push('(o.code LIKE ? OR o.po_reference LIKE ? OR c.company_name LIKE ? OR EXISTS (SELECT 1 FROM order_lines l3 LEFT JOIN products p3 ON p3.id = l3.product_id WHERE l3.order_id = o.id AND (p3.code LIKE ? OR l3.description LIKE ?)))');
    const like = likeTerm(query.q);
    params.push(like, like, like, like, like);
  }
  const pinned = new Set(all("SELECT entity_id FROM pins WHERE user_id = ? AND entity_type = 'order'", user.id).map((r) => r.entity_id));
  let rows = loadOrdersWithLines(where, params, user).map(({ order, lines }) => orderListRow(order, lines, pinned));
  const payments = paymentStatusByOrder(rows.map((r) => r.id));
  rows = rows.map((r) => ({ ...r, payment: payments.get(r.id) || null }));
  const counts = Object.fromEntries(Object.entries(STATE_FILTERS).map(([k, fn]) => [k, rows.filter(fn).length]));
  if (query.state && STATE_FILTERS[query.state]) rows = rows.filter(STATE_FILTERS[query.state]);
  const rank = (r) => (r.overdue ? 0 : r.at_risk ? 1 : r.comm_pending ? 2 : r.issue ? 3 : r.stale_lines ? 4 : r.ready_waiting ? 5 : 6);
  if (query.sort === 'received') rows.sort((a, b) => String(b.received_date).localeCompare(String(a.received_date)));
  else if (query.sort === 'customer') rows.sort((a, b) => a.customer_name.localeCompare(b.customer_name));
  else rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a) - rank(b) || b.max_days_late - a.max_days_late || String(a.earliest_due || '9999').localeCompare(String(b.earliest_due || '9999')));
  return { rows, count: rows.length, counts, today: today() };
}

// ------------------------------------------------------------------ quick update
const UPDATE_FIELDS = ['phase', 'work_status', 'issue_code', 'stage_note', 'forecast_ready_date', 'forecast_dispatch_date', 'estimate_unknown', 'ready_qty', 'hold_review_date'];

function asOfFrom(input, c) {
  if (!input.as_of) return { at: nowIso(), basis: 'entry_time' };
  if (!isInstant(input.as_of)) {
    c.fail('as_of', 'Use a valid date and time');
    return { at: nowIso(), basis: 'entry_time' };
  }
  if (Date.parse(input.as_of) > now().getTime() + 10 * 60000) c.fail('as_of', 'The reported time cannot be in the future');
  return { at: new Date(input.as_of).toISOString(), basis: 'reported' };
}

/** Customer update needed when the dispatch forecast is beyond the date the customer currently expects. */
function needsCommunication(line, forecast) {
  const expected = line.agreed_commitment_date || line.original_commitment_date;
  return Boolean(forecast && expected && forecast > expected);
}

/** Keeps exactly one open "inform the customer" task per order while any active line has an uninformed revision. */
export function refreshCustomerUpdateTask(orderId, user) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return;
  const lines = all('SELECT * FROM order_lines WHERE order_id = ?', orderId);
  const pending = lines.filter((l) => isPositive(lineQty(l).remaining) && commStateForLine(l.id).state === 'pending');
  const key = `customer_update:order:${orderId}`;
  const open = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", key);
  if (pending.length && o.status === 'confirmed' && !o.closed_at) {
    const latest = pending.map((l) => l.forecast_dispatch_date).filter(Boolean).sort().at(-1);
    const purpose = `Inform customer of revised dispatch date — ${o.code}${latest ? ` (now ${latest})` : ''}`;
    if (open) run('UPDATE tasks SET purpose = ?, updated_at = ? WHERE id = ?', purpose, nowIso(), open.id);
    else {
      createTask({
        order_id: orderId, purpose, purpose_code: 'customer_update', owner_id: o.owner_id, due_date: today(), kind: 'customer', source: 'forecast_late', alert_key: key,
      }, user, { validated: true });
    }
  } else if (open) {
    cancelTask(open.id, { reason: 'No customer update pending (forecast recovered, customer informed or order closed)' }, user, { system: true });
  }
}

/**
 * The minimum production update: change only what changed. Delay fields are needed only when an issue
 * is reported; a new blocker needs a named action owner and date; an unchanged save is not fresh
 * information; an older report never silently replaces a newer known state.
 */
export function quickUpdate(lineId, input, user, { bulkId = null } = {}) {
  const l = loadLine(lineId);
  if (l.order_status !== 'confirmed') throw conflict('Confirm the order before recording production progress');
  const q = lineQty(l);
  if (!isPositive(q.remaining)) throw conflict('This line is closed — it has been fully dispatched or cancelled');
  checkVersion(l, input.version, 'order line');
  const c = new Check();
  const { at: asOf, basis } = asOfFrom(input, c);
  const coordinatorMode = settings().access.coordinatorMode && ['admin', 'coordinator'].includes(user.group);
  const reporter = user.group === 'production' && !input.reported_by_id && !input.reported_by_name
    ? { reported_by_id: user.id, reported_by_name: user.name }
    : resolveReporter(input, user, c, { required: coordinatorMode && !bool(input.historical) });
  c.note('note', input.note);

  if (l.source_update_at && asOf < l.source_update_at && !bool(input.historical) && !bool(input.correction)) {
    throw conflict(`A newer update (reported ${l.source_update_at}) already exists. Record this as a historical entry, or as a correction with a reason.`, { code: 'stale_report', current: l });
  }
  if (bool(input.historical)) {
    c.throwIfAny();
    return tx(() => {
      const stamp = nowIso();
      const uid = insert('order_updates', {
        order_id: l.order_id, line_id: l.id, kind: 'historical', changes: JSON.stringify(input.reported_values || {}), note: str(input.note, 1000),
        occurred_at: asOf, basis, entered_at: stamp, entered_by: user.id, ...reporter, substantive: 0, historical: 1, record_version: l.version, bulk_id: bulkId,
      });
      audit('order_line', l.id, 'historical_entry', { update_id: uid, as_of: asOf });
      return { line_id: l.id, update_id: uid, historical: true };
    });
  }
  if (bool(input.correction)) c.text('note', input.note, { required: true, max: 1000, label: 'Correction reason' });

  const next = {};
  if (input.phase !== undefined && input.phase !== l.phase) {
    if (!SELECTABLE_PHASES.includes(input.phase)) c.fail('phase', 'Dispatched is set by recording a dispatch, not chosen here');
    else {
      if (l.needs_clarification && input.phase !== 'received') c.fail('phase', 'Clarify the specification before releasing this line to production');
      if (isBackwardMove(l.phase, input.phase) && !str(input.note)) c.fail('note', `Moving back from ${labelOf(PHASES, l.phase)} to ${labelOf(PHASES, input.phase)} needs a short reason`);
      if (l.phase === 'qc' && input.phase === 'ready' && !hasPerm(user, 'qc.pass')) c.fail('phase', 'Only QC (or the coordinator recording on QC\'s behalf) can pass a line from QC to ready');
      next.phase = input.phase;
    }
  }
  if (input.qc_summary !== undefined && (str(input.qc_summary, 300) || null) !== (l.qc_summary || null)) {
    c.text('qc_summary', input.qc_summary, { max: 300, label: 'QC summary' });
    next.qc_summary = str(input.qc_summary, 300);
  }
  if (input.work_status !== undefined && input.work_status !== l.work_status) {
    if (!WORK_STATUSES.some((s) => s.value === input.work_status)) c.fail('work_status', 'Choose a status');
    else next.work_status = input.work_status;
  }
  const status = next.work_status ?? l.work_status;
  if (status === 'on_hold' && (next.work_status || input.hold_review_date !== undefined)) {
    c.date('hold_review_date', input.hold_review_date ?? l.hold_review_date, { required: true, message: 'On hold needs a review date' });
    if (!str(input.note) && !str(input.stage_note) && !l.stage_note) c.fail('note', 'Give the reason for the hold');
    if ((input.hold_review_date ?? null) !== l.hold_review_date && input.hold_review_date) next.hold_review_date = input.hold_review_date;
  } else if (status !== 'on_hold' && l.hold_review_date) next.hold_review_date = null;

  let newIssue = false;
  if (bool(input.resolve_issue) && l.issue_code) next.issue_code = null;
  else if (input.issue_code !== undefined && (input.issue_code || null) !== l.issue_code) {
    if (input.issue_code) {
      checkOption(c, 'issue_code', 'delay_reason', input.issue_code, { note: input.stage_note ?? input.note ?? l.stage_note, noteField: 'stage_note' });
      newIssue = true;
    }
    next.issue_code = input.issue_code || null;
  }
  if (input.stage_note !== undefined && (str(input.stage_note, 300) || null) !== (l.stage_note || null)) {
    c.text('stage_note', input.stage_note, { max: 300, label: 'Stage / note' });
    next.stage_note = str(input.stage_note, 300);
  }

  for (const f of ['forecast_ready_date', 'forecast_dispatch_date']) {
    if (input[f] === undefined) continue;
    const v = input[f] || null;
    if (v && !isDate(v)) c.fail(f, 'Use a valid date');
    else if (v !== l[f]) next[f] = v;
  }
  if (input.estimate_unknown !== undefined && Boolean(bool(input.estimate_unknown)) !== Boolean(l.estimate_unknown)) next.estimate_unknown = bool(input.estimate_unknown) ? 1 : 0;
  if (next.estimate_unknown === 1) next.forecast_dispatch_date = null;
  else if (next.forecast_dispatch_date && l.estimate_unknown) next.estimate_unknown = 0;
  const ready = next.forecast_ready_date !== undefined ? next.forecast_ready_date : l.forecast_ready_date;
  const dispatchF = next.forecast_dispatch_date !== undefined ? next.forecast_dispatch_date : l.forecast_dispatch_date;
  if (ready && dispatchF && dispatchF < ready) {
    if (input.forecast_dispatch_date !== undefined && input.forecast_dispatch_date) c.fail('forecast_dispatch_date', 'The dispatch forecast cannot be before the expected ready date');
    else next.forecast_dispatch_date = ready; // cannot dispatch before ready: move the forecast with it
  }

  if (input.ready_qty !== undefined && input.ready_qty !== null && input.ready_qty !== '') {
    const r = Number(input.ready_qty);
    if (!Number.isFinite(r) || r < 0) c.fail('ready_qty', 'Enter the total quantity currently ready');
    else {
      const max = round3(q.confirmed - q.cancelled);
      if (r > max + 0.0005) c.fail('ready_qty', `Ready cannot exceed the ordered quantity still required (${max})`);
      else if (r < q.dispatched - 0.0005) c.fail('ready_qty', `Ready total includes what is already dispatched (${q.dispatched}); it cannot be lower`);
      else if (l.ready_qty !== null && r < l.ready_qty - 0.0005 && !str(input.ready_reduction_reason)) c.fail('ready_reduction_reason', 'A lower ready total needs a correction or rework reason');
      else if (l.ready_qty === null || Math.abs(r - l.ready_qty) > 0.0005) next.ready_qty = round3(r);
    }
  }

  const action = input.action && (input.action.owner_id || input.action.due_date) ? input.action : null;
  if (action) {
    requireActiveUser(c, 'action.owner_id', intId(action.owner_id), 'Action owner');
    c.date('action.due_date', action.due_date, { required: true, message: 'Action date is required' });
    c.text('action.purpose', action.purpose, { max: 200, label: 'Action' });
  }
  const openAction = get("SELECT id FROM tasks WHERE line_id = ? AND status = 'open' AND kind = 'internal' LIMIT 1", l.id);
  if (newIssue && !action && !openAction) c.fail('action.owner_id', 'A new blocker needs a named action owner and date');
  if (next.estimate_unknown === 1 && !action && !openAction) c.fail('action.owner_id', 'Estimate unknown needs someone to obtain the estimate, with a date');
  c.throwIfAny();

  const changes = diff(l, { ...l, ...next }, Object.keys(next));
  const still = bool(input.still_on_track);
  if (!Object.keys(changes).length && !still && !action) {
    return { line_id: l.id, unchanged: true, message: 'Nothing changed — this save does not count as fresh production information' };
  }

  return tx(() => {
    const stamp = nowIso();
    const forecastChanged = changes.forecast_dispatch_date || changes.estimate_unknown;
    const readyNow = next.ready_qty !== undefined ? next.ready_qty : l.ready_qty;
    const phaseNow = next.phase ?? l.phase;
    const waiting = readyNow !== null ? isPositive(round3(readyNow - q.dispatched)) : phaseNow === 'ready';
    const fields = {
      ...next,
      ready_as_of: next.ready_qty !== undefined ? asOf : undefined,
      ready_since: waiting ? (l.ready_since || asOf) : null,
      source_update_at: asOf,
      source_update_basis: basis,
      last_reported_by_id: reporter.reported_by_id,
      last_reported_by_name: reporter.reported_by_name,
      updated_at: stamp,
    };
    if (!updateVersioned('order_lines', l.id, l.version, fields)) throw conflict('Someone else updated this line. Review the latest values before saving.', { code: 'version_conflict', current: loadLine(l.id) });

    let taskId = null;
    if (action) {
      const issueLabel = optionLabel('delay_reason', next.issue_code ?? l.issue_code);
      taskId = createTask({
        line_id: l.id, purpose: str(action.purpose, 200) || (next.estimate_unknown ? 'Obtain revised estimate' : `Resolve: ${issueLabel || 'blocker'}${(next.stage_note ?? l.stage_note) ? ` — ${next.stage_note ?? l.stage_note}` : ''}`),
        purpose_code: next.estimate_unknown ? 'obtain_estimate' : 'blocker_action', owner_id: intId(action.owner_id), due_date: action.due_date, kind: 'internal', source: 'production_update',
      }, user, { validated: true });
    }
    if (changes.issue_code) {
      const open = get('SELECT * FROM line_issues WHERE line_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', l.id);
      if (open) run('UPDATE line_issues SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?', asOf, user.id, next.issue_code ? 'changed' : 'resolved', open.id);
      if (next.issue_code) {
        insert('line_issues', {
          line_id: l.id, order_id: l.order_id, issue_code: next.issue_code, note: next.stage_note ?? l.stage_note, reported_at: asOf, ...reporter,
          action_task_id: taskId || openAction?.id || null, entered_by: user.id, created_at: stamp,
        });
        if (next.issue_code === 'payment_hold') {
          const approver = get("SELECT id FROM users WHERE role IN ('accounts','management','super_admin') AND active = 1 ORDER BY CASE role WHEN 'accounts' THEN 0 WHEN 'management' THEN 1 ELSE 2 END, id LIMIT 1")?.id;
          if (approver) {
            createTask({
              line_id: l.id, purpose: `Authorise release of payment hold — ${l.order_code}`, purpose_code: 'release_hold', owner_id: approver,
              due_date: addWorkingDays(today(), 1, calendar()), kind: 'internal', source: 'payment_hold', alert_key: `release_hold:${l.order_id}`,
            }, user, { validated: true });
          }
        }
      }
    } else if (taskId) {
      run('UPDATE line_issues SET action_task_id = ? WHERE line_id = ? AND resolved_at IS NULL', taskId, l.id);
    }
    if (changes.forecast_ready_date) {
      insert('commitment_changes', { line_id: l.id, order_id: l.order_id, kind: 'forecast_ready', old_date: changes.forecast_ready_date[0], new_date: changes.forecast_ready_date[1], reason: str(input.note, 300) || optionLabel('delay_reason', next.issue_code ?? l.issue_code), actor_id: user.id, occurred_at: asOf, created_at: stamp });
    }
    if (forecastChanged) {
      const newForecast = next.forecast_dispatch_date !== undefined ? next.forecast_dispatch_date : l.forecast_dispatch_date;
      insert('commitment_changes', {
        line_id: l.id, order_id: l.order_id, kind: 'forecast_dispatch', old_date: l.forecast_dispatch_date, new_date: newForecast, estimate_unknown: next.estimate_unknown ?? l.estimate_unknown,
        reason: str(input.note, 300) || optionLabel('delay_reason', next.issue_code ?? l.issue_code), comm_required: needsCommunication(l, newForecast) ? 1 : 0,
        actor_id: user.id, occurred_at: asOf, created_at: stamp,
      });
      if (next.estimate_unknown === 1) {
        createTask({
          line_id: l.id, purpose: `Obtain revised estimate — ${l.order_code} line ${l.line_no}`, purpose_code: 'obtain_estimate', owner_id: intId(action?.owner_id) || defaultCoordinatorId(),
          due_date: action?.due_date || addWorkingDays(today(), 1, calendar()), kind: 'internal', source: 'estimate_unknown', alert_key: `estimate:${l.id}`,
        }, user, { validated: true });
      }
    }
    if (changes.forecast_dispatch_date && !next.estimate_unknown && l.estimate_unknown === 0) { /* recorded above */ }
    if (next.estimate_unknown === 0 && changes.estimate_unknown) {
      const t = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `estimate:${l.id}`);
      if (t) cancelTask(t.id, { reason: 'Estimate received' }, user, { system: true });
    }
    const kind = bool(input.correction) ? 'correction' : !Object.keys(changes).length && still ? 'still_on_track' : changes.issue_code ? 'issue' : 'progress';
    const uid = insert('order_updates', {
      order_id: l.order_id, line_id: l.id, kind, changes: JSON.stringify(changes), note: str(input.note || input.ready_reduction_reason, 1000), occurred_at: asOf, basis,
      customer_visible: bool(input.share_with_customer) && str(input.note) ? 1 : 0,
      entered_at: stamp, entered_by: user.id, ...reporter, substantive: 1, historical: 0, record_version: l.version + 1, bulk_id: bulkId,
      request_id: null,
    });
    refreshCustomerUpdateTask(l.order_id, user);
    audit('order_line', l.id, kind, { changes, as_of: asOf, basis, reported_by: reporter.reported_by_name, action_task_id: taskId });
    return { line_id: l.id, update_id: uid, changes, unchanged: false };
  });
}

class PreviewRollback extends Error {}

/** Validates the same change for each selected line without saving anything. */
export function bulkPreview(input, user) {
  const ids = (input.line_ids || []).map(intId).filter(Boolean);
  if (!ids.length) throw badRequest('Select at least one line');
  const out = [];
  for (const id of ids) {
    const l = get('SELECT l.*, o.code AS order_code, o.status AS order_status, COALESCE(p.code, l.description) AS product FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN products p ON p.id = l.product_id WHERE l.id = ?', id);
    if (!l) {
      out.push({ line_id: id, ok: false, error: 'Line not found' });
      continue;
    }
    if (!isPositive(lineQty(l).remaining) && !bool(input.include_closed)) {
      out.push({ line_id: id, order_code: l.order_code, product: l.product, ok: false, skipped: true, error: 'Closed line — excluded' });
      continue;
    }
    try {
      tx(() => {
        const r = quickUpdate(id, { ...input.changes, reported_by_id: input.reported_by_id, reported_by_name: input.reported_by_name, as_of: input.as_of }, user);
        out.push({ line_id: id, order_code: l.order_code, line_no: l.line_no, product: l.product, ok: true, unchanged: r.unchanged, changes: r.changes || {} });
        throw new PreviewRollback();
      });
    } catch (err) {
      if (err instanceof PreviewRollback) continue;
      out.push({ line_id: id, order_code: l.order_code, line_no: l.line_no, product: l.product, ok: false, error: err.message, fields: err.details?.fields });
    }
  }
  return { results: out, valid: out.filter((r) => r.ok && !r.unchanged).length };
}

/** Applies the previewed change line by line; every line reports success or failure — nothing silent. */
export function bulkApply(input, user) {
  const ids = (input.line_ids || []).map(intId).filter(Boolean);
  if (!ids.length) throw badRequest('Select at least one line');
  const bulkId = `bulk-${Date.now().toString(36)}`;
  const results = [];
  for (const id of ids) {
    const l = get('SELECT l.*, o.code AS order_code, COALESCE(p.code, l.description) AS product FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN products p ON p.id = l.product_id WHERE l.id = ?', id);
    if (!l) {
      results.push({ line_id: id, ok: false, error: 'Line not found' });
      continue;
    }
    if (!isPositive(lineQty(l).remaining) && !bool(input.include_closed)) {
      results.push({ line_id: id, order_code: l.order_code, product: l.product, ok: false, skipped: true, error: 'Closed line — excluded' });
      continue;
    }
    try {
      const r = quickUpdate(id, { ...input.changes, reported_by_id: input.reported_by_id, reported_by_name: input.reported_by_name, as_of: input.as_of }, user, { bulkId });
      results.push({ line_id: id, order_code: l.order_code, line_no: l.line_no, product: l.product, ok: true, unchanged: r.unchanged });
    } catch (err) {
      results.push({ line_id: id, order_code: l.order_code, line_no: l.line_no, product: l.product, ok: false, error: err.message, fields: err.details?.fields });
    }
  }
  audit('order_line', null, 'bulk_update', { bulk_id: bulkId, lines: ids.length, ok: results.filter((r) => r.ok).length, changes: input.changes });
  return { bulk_id: bulkId, results, applied: results.filter((r) => r.ok && !r.unchanged).length, failed: results.filter((r) => !r.ok && !r.skipped).length };
}

// ------------------------------------------------------------------ customer communication
/**
 * "Customer informed" always links to a recorded contact and the specific date revision. A later forecast
 * change opens a new revision, which is uninformed until another contact is recorded.
 */
export function recordCommunication(orderId, input, user) {
  const o = loadOrder(orderId);
  if (o.status !== 'confirmed') throw conflict('Confirm the order first');
  const c = new Check();
  checkOption(c, 'channel', 'channel', input.channel, { note: input.note });
  if (input.channel === 'internal') c.fail('channel', 'An internal note does not inform the customer — choose how they were contacted');
  checkOption(c, 'outcome', 'customer_update_outcome', input.outcome, { note: input.note });
  c.note('note', input.note);
  if (input.outcome === 'accepted_revised_date') c.date('agreed_date', input.agreed_date, { required: true, message: 'Enter the date the customer agreed' });
  else if (input.agreed_date) c.date('agreed_date', input.agreed_date);
  const allLines = all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_no', orderId).filter((l) => isPositive(lineQty(l).remaining));
  const lineIds = (input.line_ids || []).map(intId).filter(Boolean);
  const lines = lineIds.length ? allLines.filter((l) => lineIds.includes(l.id)) : allLines.filter((l) => commStateForLine(l.id).state === 'pending');
  if (!lines.length) c.fail('line_ids', 'Choose the order lines this conversation covered');
  c.throwIfAny();
  return tx(() => {
    const activityId = recordActivity({
      customer_id: o.customer_id, order_id: orderId, contact_id: input.contact_id, channel: input.channel, outcome: input.outcome, outcome_category: 'customer_update_outcome',
      note: input.note, occurred_at: input.occurred_at, reported_by_id: input.reported_by_id, reported_by_name: input.reported_by_name, kind: 'contact',
    }, user);
    const occurred = get('SELECT occurred_at FROM activities WHERE id = ?', activityId).occurred_at;
    const stamp = nowIso();
    for (const l of lines) {
      let rev = get("SELECT * FROM commitment_changes WHERE line_id = ? AND kind IN ('forecast_dispatch','missed') ORDER BY id DESC LIMIT 1", l.id);
      if (!rev) {
        const rid = insert('commitment_changes', { line_id: l.id, order_id: orderId, kind: 'forecast_dispatch', old_date: l.forecast_dispatch_date, new_date: l.forecast_dispatch_date, comm_required: 0, actor_id: user.id, created_at: stamp, occurred_at: occurred });
        rev = get('SELECT * FROM commitment_changes WHERE id = ?', rid);
      }
      run('UPDATE commitment_changes SET informed_at = ?, informed_activity_id = ?, informed_by = ?, customer_response = ?, agreed_date = ? WHERE id = ?',
        occurred, activityId, user.id, input.outcome, input.agreed_date || null, rev.id);
      insert('communication_confirmations', {
        order_id: orderId, line_id: l.id, commitment_change_id: rev.id, activity_id: activityId, contact_id: intId(input.contact_id), channel: input.channel,
        occurred_at: occurred, response_code: input.outcome, agreed_date: input.agreed_date || null, note: str(input.note, 1000), entered_by: user.id, created_at: stamp,
      });
      if (input.agreed_date && input.outcome === 'accepted_revised_date' && input.agreed_date !== l.agreed_commitment_date) {
        insert('commitment_changes', { line_id: l.id, order_id: orderId, kind: 'agreed', old_date: l.agreed_commitment_date, new_date: input.agreed_date, activity_id: activityId, reason: 'Customer agreed revised date', actor_id: user.id, occurred_at: occurred, created_at: stamp });
        update('order_lines', l.id, { agreed_commitment_date: input.agreed_date, updated_at: stamp, version: l.version + 1 });
        history('order', orderId, 'date_change', { customerId: o.customer_id, occurredAt: occurred, data: { code: o.code, label: `customer agreed a revised date of ${input.agreed_date} for line ${l.line_no} (original ${l.original_commitment_date || 'not committed'} kept)` } });
      }
    }
    history('order', orderId, 'customer_informed', { customerId: o.customer_id, occurredAt: occurred, data: { code: o.code, lines: lines.map((l) => l.line_no) } });
    const open = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `customer_update:order:${orderId}`);
    if (open) {
      const stillPending = all('SELECT id FROM order_lines WHERE order_id = ?', orderId).some((x) => commStateForLine(x.id).state === 'pending');
      if (!stillPending) {
        run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, completion_activity_id = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          occurred, user.id, occurred, activityId, stamp, open.id);
      }
    }
    audit('order', orderId, 'customer_informed', { activity_id: activityId, lines: lines.map((l) => l.id), outcome: input.outcome, agreed_date: input.agreed_date });
    return { activity_id: activityId, lines: lines.map((l) => l.id) };
  });
}

// ------------------------------------------------------------------ quantities: recalculation from events
export function recalcLine(lineId) {
  const l = get('SELECT * FROM order_lines WHERE id = ?', lineId);
  const dispatched = round3(get("SELECT COALESCE(SUM(dl.qty), 0) AS q FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = ? AND d.status = 'posted'", lineId).q);
  const cancelled = round3(get('SELECT COALESCE(SUM(qty), 0) AS q FROM cancellations WHERE line_id = ? AND reversed_at IS NULL', lineId).q);
  const remaining = round3(l.confirmed_qty - dispatched - cancelled);
  if (remaining < -0.0005) throw conflict('This change would make the remaining quantity negative', { code: 'negative_balance' });
  const ready = l.ready_qty === null ? null : Math.max(l.ready_qty, dispatched);
  const closed = remaining <= 0.0005;
  let phase = l.phase;
  if (closed && dispatched > 0) phase = 'dispatched';
  else if (!closed && l.phase === 'dispatched') phase = 'ready';
  const waiting = !closed && (ready !== null ? ready - dispatched > 0.0005 : phase === 'ready');
  update('order_lines', lineId, {
    dispatched_qty: dispatched, cancelled_qty: cancelled, ready_qty: ready, phase,
    work_status: !closed && l.phase === 'dispatched' ? 'phase_complete' : l.work_status,
    closed_at: closed ? l.closed_at || nowIso() : null, ready_since: waiting ? l.ready_since || nowIso() : null, updated_at: nowIso(), version: l.version + 1,
  });
  return { dispatched, cancelled, remaining };
}

export function recalcOrder(orderId, user) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  const lines = all('SELECT * FROM order_lines WHERE order_id = ?', orderId);
  const open = lines.some((l) => isPositive(lineQty(l).remaining));
  const sum = orderSummary(o, lines, today());
  if (!open && !o.closed_at && o.status === 'confirmed') {
    update('orders', orderId, { closed_at: nowIso(), updated_at: nowIso(), version: o.version + 1 });
    history('order', orderId, 'closed', { customerId: o.customer_id, data: { code: o.code, outcome: sum.outcome.map((x) => x.replace(/_/g, ' ')).join(', ') } });
  } else if (open && o.closed_at) {
    update('orders', orderId, { closed_at: null, updated_at: nowIso(), version: o.version + 1 });
    history('order', orderId, 'reopened', { customerId: o.customer_id, data: { code: o.code } });
  }
  refreshAdvance(orderId);
  refreshCustomerUpdateTask(orderId, user);
}

/** Compares the current-state quantities with the dispatch and cancellation events. */
export function reconcileQuantities() {
  return all(`SELECT l.id, l.order_id, l.dispatched_qty, l.cancelled_qty,
      (SELECT COALESCE(SUM(dl.qty), 0) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted') AS ev_dispatched,
      (SELECT COALESCE(SUM(qty), 0) FROM cancellations WHERE line_id = l.id AND reversed_at IS NULL) AS ev_cancelled
    FROM order_lines l`).filter((r) => Math.abs(r.dispatched_qty - r.ev_dispatched) > 0.0005 || Math.abs(r.cancelled_qty - r.ev_cancelled) > 0.0005);
}

// ------------------------------------------------------------------ dispatch
/**
 * Posts an actual dispatch. Quantities are allocated to order lines; nothing above the unfulfilled balance
 * is accepted, and dispatching more than is recorded ready needs an authorised reason.
 */
const TRANSPORT_FIELDS = ['reference', 'carrier', 'tracking_no', 'invoice_ref', 'vehicle_number', 'eway_bill'];

function checkTransport(c, input) {
  if (input.expected_arrival) c.date('expected_arrival', input.expected_arrival);
  for (const f of TRANSPORT_FIELDS) c.text(f, input[f], { max: 80, label: 'This field' });
  if (input.tracking_url && !/^https?:\/\//i.test(String(input.tracking_url))) c.fail('tracking_url', 'Tracking links must start with http:// or https://');
  if (input.boxes !== undefined && input.boxes !== null && input.boxes !== '' && (!Number.isInteger(Number(input.boxes)) || Number(input.boxes) < 0)) c.fail('boxes', 'Enter the number of boxes');
  if (input.weight_kg !== undefined && input.weight_kg !== null && input.weight_kg !== '' && (num(input.weight_kg) === null || num(input.weight_kg) < 0)) c.fail('weight_kg', 'Enter the weight in kg');
  c.note('notes', input.notes);
}

function transportFields(input) {
  const out = {};
  for (const f of TRANSPORT_FIELDS) if (input[f] !== undefined) out[f] = str(input[f], 80);
  if (input.tracking_url !== undefined) out.tracking_url = str(input.tracking_url, 500);
  if (input.expected_arrival !== undefined) out.expected_arrival = input.expected_arrival || null;
  if (input.boxes !== undefined) out.boxes = input.boxes === '' || input.boxes === null ? null : Number(input.boxes);
  if (input.weight_kg !== undefined) out.weight_kg = input.weight_kg === '' || input.weight_kg === null ? null : num(input.weight_kg);
  if (input.notes !== undefined) out.notes = str(input.notes, 1000);
  return out;
}

/** Loads and checks dispatch rows: same customer, confirmed orders, no over-dispatch; flags quantity not recorded ready. */
function checkDispatchRows(rows, { planned = false } = {}) {
  const loaded = rows.map((x, i) => ({ i, l: loadLine(intId(x.line_id)), qty: round3(Number(x.qty)) }));
  const customers = new Set(loaded.map((x) => x.l.customer_id));
  if (customers.size > 1) throw badRequest('One dispatch can only include lines for the same customer');
  const fields = {};
  let override = false;
  for (const { i, l, qty } of loaded) {
    if (l.order_status !== 'confirmed') fields[`lines.${i}.qty`] = `${l.order_code} is still a draft — confirm it first`;
    if (!(qty > 0)) fields[`lines.${i}.qty`] = 'Dispatched quantity must be greater than zero';
    const q = lineQty(l);
    if (qty > q.remaining + 0.0005) fields[`lines.${i}.qty`] = `Over-dispatch rejected: ${l.order_code} line ${l.line_no} has only ${q.remaining} ${l.unit} remaining`;
    if (l.unit === 'pcs' && !Number.isInteger(qty)) fields[`lines.${i}.qty`] = 'Whole pieces only';
    const readyAvailable = q.ready === null ? 0 : q.readyNotDispatched;
    if (!planned && qty > readyAvailable + 0.0005) override = true;
  }
  if (Object.keys(fields).length) {
    const over = Object.values(fields).some((m) => m.startsWith('Over-dispatch'));
    throw new HttpError(over ? 409 : 400, over ? 'Over-dispatch rejected — the quantity is above the remaining balance' : 'Please correct the highlighted fields', { fields, code: over ? 'over_dispatch' : undefined });
  }
  return { loaded, override };
}

/** Writes the allocations of an actual dispatch and recalculates every affected line and order from events. */
function applyPosting(id, loaded, user, stamp) {
  const code = get('SELECT code FROM dispatches WHERE id = ?', id).code;
  const orders = new Set();
  for (const { l, qty } of loaded) {
    const q = lineQty(l);
    insert('dispatch_lines', { dispatch_id: id, order_id: l.order_id, line_id: l.id, qty, not_ready_override: qty > (q.ready === null ? 0 : q.readyNotDispatched) + 0.0005 ? 1 : 0 });
    const after = recalcLine(l.id);
    insert('order_updates', {
      order_id: l.order_id, line_id: l.id, kind: 'dispatch', changes: JSON.stringify({ dispatched_qty: [q.dispatched, after.dispatched] }), note: `Dispatch ${code}`,
      occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1,
    });
    orders.add(l.order_id);
  }
  for (const oid of orders) recalcOrder(oid, user);
  return [...orders];
}

/**
 * Posts an actual dispatch. Quantities are allocated to order lines; nothing above the unfulfilled balance
 * is accepted, and dispatching more than is recorded ready needs an authorised reason. With `planned`, the
 * shipment is only planned: it reserves nothing and changes no quantity until it is posted.
 */
export function postDispatch(input, user, { importBatchId = null, allowUnknownDate = false } = {}) {
  const c = new Check();
  const planned = bool(input.planned);
  const rows = Array.isArray(input.lines) ? input.lines.filter((x) => x && num(x.qty) !== null && Number(x.qty) !== 0) : [];
  if (!rows.length) c.fail('lines', planned ? 'Enter the planned quantity for at least one line' : 'Enter the dispatched quantity for at least one line');
  const unknownDate = allowUnknownDate && bool(input.date_unknown);
  if (planned) c.date('planned_date', input.planned_date, { required: true, message: 'Enter the planned dispatch date' });
  else if (!unknownDate) {
    c.date('dispatch_date', input.dispatch_date, { required: true, message: 'Enter the actual dispatch date' });
    if (input.dispatch_date && input.dispatch_date > today()) c.fail('dispatch_date', 'A future date is a plan, not a dispatch. Save it as a planned dispatch, and post it once it has actually left.');
  }
  checkTransport(c, input);
  c.throwIfAny();

  return tx(() => {
    const { loaded, override } = checkDispatchRows(rows, { planned });
    if (override) {
      if (!str(input.override_reason)) throw badRequest('Some quantity is not recorded as ready. Give a reason to dispatch anyway.', { override_reason: 'Reason required: quantity not recorded as ready', code: 'not_ready' });
      if (!hasPerm(user, 'dispatch.override')) throw forbidden('Only the coordinator or management can dispatch quantity that is not recorded as ready');
    }
    const stamp = nowIso();
    const id = insert('dispatches', {
      code: nextCode('DSP'), customer_id: loaded[0].l.customer_id, dispatch_date: planned || unknownDate ? null : input.dispatch_date, planned_date: planned ? input.planned_date : null,
      date_unknown: unknownDate ? 1 : 0, ...transportFields(input), document_id: intId(input.document_id), pod_document_id: intId(input.pod_document_id),
      override_reason: override ? str(input.override_reason, 300) : null, status: planned ? 'planned' : 'posted', posted_at: planned ? null : stamp,
      notify_state: planned ? 'not_required' : 'pending', import_batch_id: importBatchId, created_by: user.id, created_at: stamp, updated_at: stamp,
    });
    let orders;
    if (planned) {
      for (const { l, qty } of loaded) insert('dispatch_lines', { dispatch_id: id, order_id: l.order_id, line_id: l.id, qty, not_ready_override: 0 });
      orders = [...new Set(loaded.map((x) => x.l.order_id))];
    } else orders = applyPosting(id, loaded, user, stamp);
    if (input.document_id) linkAttachment(intId(input.document_id), 'dispatch', id, user);
    if (input.pod_document_id) linkAttachment(intId(input.pod_document_id), 'dispatch', id, user);
    if (!planned && input.feedback_task?.owner_id && input.feedback_task?.due_date) {
      createTask({ order_id: loaded[0].l.order_id, purpose: input.feedback_task.purpose || 'Delivery / feedback follow-up', owner_id: input.feedback_task.owner_id, due_date: input.feedback_task.due_date, kind: 'customer', source: 'dispatch' }, user);
    }
    audit('dispatch', id, planned ? 'plan' : 'post', { lines: loaded.map(({ l, qty }) => ({ line_id: l.id, qty })), dispatch_date: input.dispatch_date, planned_date: input.planned_date, override_reason: override ? input.override_reason : null });
    return { id, code: get('SELECT code FROM dispatches WHERE id = ?', id).code, orders, status: planned ? 'planned' : 'posted' };
  });
}

/** Posts a planned dispatch once it has actually left (quantities can be adjusted to what really shipped). */
export function postPlannedDispatch(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (d.status !== 'planned') throw conflict(d.status === 'posted' ? 'This dispatch has already been posted' : 'This plan is no longer open');
  const c = new Check();
  c.date('dispatch_date', input.dispatch_date, { required: true, message: 'Enter the actual dispatch date' });
  if (input.dispatch_date && input.dispatch_date > today()) c.fail('dispatch_date', 'Post it once it has actually left');
  checkTransport(c, input);
  const planLines = all('SELECT * FROM dispatch_lines WHERE dispatch_id = ?', id);
  const qtys = input.qtys || {};
  const rows = planLines.map((dl) => ({ line_id: dl.line_id, qty: qtys[dl.id] !== undefined ? qtys[dl.id] : dl.qty })).filter((x) => num(x.qty) !== null && Number(x.qty) > 0);
  if (!rows.length) c.fail('lines', 'Nothing left to dispatch on this plan — cancel the plan instead');
  c.throwIfAny();
  return tx(() => {
    const { loaded, override } = checkDispatchRows(rows);
    if (override) {
      if (!str(input.override_reason)) throw badRequest('Some quantity is not recorded as ready. Give a reason to dispatch anyway.', { override_reason: 'Reason required: quantity not recorded as ready', code: 'not_ready' });
      if (!hasPerm(user, 'dispatch.override')) throw forbidden('Only the coordinator or management can dispatch quantity that is not recorded as ready');
    }
    const stamp = nowIso();
    run('DELETE FROM dispatch_lines WHERE dispatch_id = ?', id); // plan allocations are replaced by the actual ones
    update('dispatches', id, {
      ...transportFields(input), status: 'posted', dispatch_date: input.dispatch_date, posted_at: stamp, notify_state: 'pending',
      override_reason: override ? str(input.override_reason, 300) : null, updated_at: stamp, version: d.version + 1,
    });
    const orders = applyPosting(id, loaded, user, stamp);
    audit('dispatch', id, 'post_planned', { planned_date: d.planned_date, dispatch_date: input.dispatch_date, lines: loaded.map(({ l, qty }) => ({ line_id: l.id, qty })) });
    return { id, code: d.code, orders, status: 'posted' };
  });
}

/** A plan that will not happen is cancelled (kept for the record); an actual dispatch is reversed instead. */
export function cancelPlannedDispatch(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (d.status !== 'planned') throw conflict('Only a planned dispatch can be cancelled — reverse an actual dispatch instead');
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  update('dispatches', id, { status: 'cancelled', reversal_reason: str(input.reason, 300), reversed_at: nowIso(), reversed_by: user.id, updated_at: nowIso(), version: d.version + 1 });
  audit('dispatch', id, 'cancel_plan', { reason: input.reason });
  return { id };
}

/** Transport details can be completed after posting (they never change quantities). */
export function updateDispatchDetails(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (['reversed', 'cancelled'].includes(d.status)) throw conflict('This dispatch is no longer active');
  const c = new Check();
  checkTransport(c, input);
  if (input.planned_date !== undefined && d.status === 'planned') c.date('planned_date', input.planned_date, { required: true });
  c.throwIfAny();
  const fields = transportFields(input);
  if (input.planned_date !== undefined && d.status === 'planned') fields.planned_date = input.planned_date;
  if (input.pod_document_id !== undefined) fields.pod_document_id = intId(input.pod_document_id);
  const changes = diff(d, { ...d, ...fields }, Object.keys(fields));
  if (!Object.keys(changes).length) return { id, unchanged: true };
  update('dispatches', id, { ...fields, updated_at: nowIso(), version: d.version + 1 });
  if (fields.pod_document_id) linkAttachment(fields.pod_document_id, 'dispatch', id, user);
  audit('dispatch', id, 'update_details', changes);
  return { id };
}

/** Dispatch register: planned, in transit (posted, not delivered), delivered, reversed. */
export function listDispatches(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = orderScope(user, 'o');
  if (scope) where.push(`EXISTS (SELECT 1 FROM dispatch_lines dl0 JOIN orders o ON o.id = dl0.order_id WHERE dl0.dispatch_id = d.id AND ${scope})`);
  const view = query.view || 'recent';
  if (view === 'planned') where.push("d.status = 'planned'");
  else if (view === 'in_transit') where.push("d.status = 'posted' AND d.delivered_at IS NULL");
  else if (view === 'delivered') where.push("d.status = 'posted' AND d.delivered_at IS NOT NULL");
  else if (view === 'not_informed') where.push("d.status = 'posted' AND d.notify_state = 'pending'");
  else if (view === 'reversed') where.push("d.status IN ('reversed','cancelled')");
  else where.push("d.status <> 'cancelled'");
  if (intId(query.customer_id)) {
    where.push('d.customer_id = ?');
    params.push(intId(query.customer_id));
  }
  if (query.from) {
    where.push('COALESCE(d.dispatch_date, d.planned_date) >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('COALESCE(d.dispatch_date, d.planned_date) <= ?');
    params.push(query.to);
  }
  if (query.q) {
    where.push(`(d.code LIKE ? OR d.tracking_no LIKE ? OR d.invoice_ref LIKE ? OR d.reference LIKE ? OR c.company_name LIKE ?
      OR EXISTS (SELECT 1 FROM dispatch_lines dl1 JOIN orders o1 ON o1.id = dl1.order_id WHERE dl1.dispatch_id = d.id AND (o1.code LIKE ? OR o1.po_reference LIKE ?)))`);
    const like = likeTerm(query.q);
    params.push(like, like, like, like, like, like, like);
  }
  const rows = all(`SELECT d.*, c.company_name, u.name AS created_by_name FROM dispatches d JOIN customers c ON c.id = d.customer_id LEFT JOIN users u ON u.id = d.created_by
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(d.dispatch_date, d.planned_date) DESC, d.id DESC LIMIT 500`, ...params);
  const lines = rows.length ? all(`SELECT dl.id, dl.line_id, dl.dispatch_id, dl.qty, l.unit, l.line_no, o.code AS order_code, o.id AS order_id, COALESCE(p.code, l.description) AS product
    FROM dispatch_lines dl JOIN order_lines l ON l.id = dl.line_id JOIN orders o ON o.id = dl.order_id LEFT JOIN products p ON p.id = l.product_id
    WHERE dl.dispatch_id IN (${placeholders(rows.map((r) => r.id))})`, rows.map((r) => r.id)) : [];
  const dispatchPayments = paymentStatusByOrder(lines.map((l) => l.order_id));
  const counts = get(`SELECT SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END) AS planned,
      SUM(CASE WHEN status = 'posted' AND delivered_at IS NULL THEN 1 ELSE 0 END) AS in_transit,
      SUM(CASE WHEN status = 'posted' AND notify_state = 'pending' THEN 1 ELSE 0 END) AS not_informed FROM dispatches`);
  return {
    rows: rows.map((d) => {
      const own = lines.filter((l) => l.dispatch_id === d.id);
      return { ...d, status_label: labelOf(DISPATCH_STATUSES, d.status), lines: own.map((l) => ({ ...l, payment: dispatchPayments.get(l.order_id) ? { code: dispatchPayments.get(l.order_id).code, label: dispatchPayments.get(l.order_id).label, tone: dispatchPayments.get(l.order_id).tone } : null })) };
    }),
    counts: { planned: counts.planned || 0, in_transit: counts.in_transit || 0, not_informed: counts.not_informed || 0 },
  };
}

/** Production board: every active line by broad phase, with its status, blocker, forecast and freshness. */
export function productionBoard(query, user) {
  const where = ["o.status = 'confirmed'", 'o.closed_at IS NULL'];
  const params = [];
  if (intId(query.factory_id)) {
    where.push('(o.factory_id = ? OR o.factory_id IS NULL)');
    params.push(intId(query.factory_id));
  }
  if (query.priority) {
    where.push('o.priority = ?');
    params.push(query.priority);
  }
  const data = loadOrdersWithLines(where, params, user);
  const payments = paymentStatusByOrder(data.map((d) => d.order.id));
  const columns = SELECTABLE_PHASES.map((p) => ({ phase: p, label: labelOf(PHASES, p), lines: [] }));
  for (const { order, lines } of data) {
    for (const raw of lines) {
      const l = decorateLine(raw, order.status);
      if (!l.status.active) continue;
      if (query.state === 'delayed' && !l.status.delayed) continue;
      if (query.state === 'issue' && !l.issue_code) continue;
      if (query.state === 'stale' && !l.freshness?.stale) continue;
      const col = columns.find((x) => x.phase === l.phase) || columns[0];
      col.lines.push({
        id: l.id, order_id: order.id, order_code: order.code, customer_name: order.customer_name, priority: order.priority, factory_id: order.factory_id, line_no: l.line_no,
        product: l.product, unit: l.unit, quantities: l.quantities, work_status: l.work_status, work_status_label: l.work_status_label, state: l.status.state, days_late: l.status.daysLate,
        original_commitment_date: l.original_commitment_date, forecast_ready_date: l.forecast_ready_date, forecast_dispatch_date: l.forecast_dispatch_date, estimate_unknown: Boolean(l.estimate_unknown),
        issue_code: l.issue_code, issue_label: l.issue_label, stage_note: l.stage_note, qc_summary: l.qc_summary, stale: Boolean(l.freshness?.stale), freshness: l.freshness,
        needs_clarification: Boolean(l.needs_clarification), action_task_id: l.action_task_id, version: l.version, phase: l.phase,
        ready_qty: l.ready_qty, hold_review_date: l.hold_review_date,
        payment: payments.has(order.id) ? { code: payments.get(order.id).code, label: payments.get(order.id).label, tone: payments.get(order.id).tone } : null,
      });
    }
  }
  const rank = (x) => (x.state === 'overdue' ? 0 : x.state === 'at_risk' ? 1 : x.priority === 'urgent' ? 2 : x.priority === 'high' ? 3 : 4);
  for (const col of columns) col.lines.sort((a, b) => rank(a) - rank(b) || String(a.original_commitment_date || '9999').localeCompare(String(b.original_commitment_date || '9999')));
  return { columns, total: columns.reduce((s, c) => s + c.lines.length, 0) };
}

/** Customer tracking link: broad progress, promised and agreed dates, dispatches and shared notes — no internal data. */
export function orderTracking(trackingToken) {
  const o = get('SELECT * FROM orders WHERE tracking_token = ? AND status = ?', String(trackingToken || ''), 'confirmed');
  if (!o) throw notFound('Order');
  const c = get('SELECT company_name, city FROM customers WHERE id = ?', o.customer_id);
  const owner = get('SELECT name, email, phone FROM users WHERE id = ?', o.owner_id);
  const lines = all(`${LINE_SELECT} WHERE l.order_id = ? ORDER BY l.line_no`, o.id).map((l) => {
    const d = decorateLine(l, o.status);
    return {
      line_no: l.line_no, product: d.product, description: l.description, unit: l.unit, quantities: { confirmed: d.quantities.confirmed, dispatched: d.quantities.dispatched, cancelled: d.quantities.cancelled, remaining: d.quantities.remaining },
      phase_label: d.phase_label, promised_date: l.commitment_state === 'committed' ? l.original_commitment_date : null, agreed_date: l.agreed_commitment_date,
    };
  });
  const dispatches = all(`SELECT d.code, d.dispatch_date, d.carrier, d.tracking_no, d.tracking_url, d.expected_arrival, d.delivered_at,
      (SELECT string_agg(COALESCE(p.code::text, l.description) || ' × ' || dl.qty, ', ') FROM dispatch_lines dl JOIN order_lines l ON l.id = dl.line_id LEFT JOIN products p ON p.id = l.product_id WHERE dl.dispatch_id = d.id) AS items
    FROM dispatches d WHERE d.status = 'posted' AND d.id IN (SELECT dispatch_id FROM dispatch_lines WHERE order_id = ?) ORDER BY d.dispatch_date`, o.id);
  const notes = all('SELECT note, occurred_at FROM order_updates WHERE order_id = ? AND customer_visible = 1 ORDER BY occurred_at DESC LIMIT 20', o.id);
  const sum = orderSummary(o, all('SELECT * FROM order_lines WHERE order_id = ?', o.id), today());
  return {
    code: o.code, po_reference: o.po_reference, received_date: o.received_date, customer: c, owner, lines, dispatches, notes,
    phase: sum.phase, outcome: sum.outcome, closed: Boolean(o.closed_at),
    company: (({ name, address, phone, email, website }) => ({ name, address, phone, email, website }))(settings().company),
  };
}

/** Corrects a wrong dispatch through a reversal event. The original record stays visible. */
export function reverseDispatch(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (d.status === 'reversed') throw conflict('This dispatch has already been reversed');
  if (d.status !== 'posted') throw conflict('Only an actual (posted) dispatch can be reversed — cancel a plan instead');
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    update('dispatches', id, { status: 'reversed', reversed_at: stamp, reversed_by: user.id, reversal_reason: str(input.reason, 300), updated_at: stamp, version: d.version + 1 });
    const lines = all('SELECT * FROM dispatch_lines WHERE dispatch_id = ?', id);
    const orders = new Set();
    for (const dl of lines) {
      const before = get('SELECT dispatched_qty, version FROM order_lines WHERE id = ?', dl.line_id);
      const after = recalcLine(dl.line_id);
      insert('order_updates', {
        order_id: dl.order_id, line_id: dl.line_id, kind: 'dispatch_reversal', changes: JSON.stringify({ dispatched_qty: [before.dispatched_qty, after.dispatched] }),
        note: `Reversed ${d.code}: ${str(input.reason, 300)}`, occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: before.version + 1,
      });
      orders.add(dl.order_id);
    }
    for (const oid of orders) recalcOrder(oid, user);
    audit('dispatch', id, 'reverse', { reason: input.reason, lines: lines.map((x) => ({ line_id: x.line_id, qty: x.qty })) });
    return { id };
  });
}

/** After posting, the customer notification stays pending until a real contact is recorded. */
export function recordDispatchNotice(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (input.not_required) {
    update('dispatches', id, { notify_state: 'not_required', updated_at: nowIso() });
    audit('dispatch', id, 'notify_not_required', { reason: input.reason });
    return { id };
  }
  const orderId = get('SELECT order_id FROM dispatch_lines WHERE dispatch_id = ? LIMIT 1', id).order_id;
  return tx(() => {
    const activityId = recordActivity({
      customer_id: d.customer_id, order_id: orderId, contact_id: input.contact_id, channel: input.channel, outcome: input.outcome || 'requirement_confirmed',
      note: input.note || `Dispatch ${d.code} details shared${d.tracking_no ? ` (tracking ${d.tracking_no})` : ''}`, occurred_at: input.occurred_at,
    }, user);
    update('dispatches', id, { notify_state: 'recorded', notify_activity_id: activityId, updated_at: nowIso() });
    return { id, activity_id: activityId };
  });
}

/** Actual delivery is a separate optional event (proof of delivery, who received it). */
export function markDelivered(id, input, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', id);
  if (!d) throw notFound('Dispatch');
  if (d.status !== 'posted') throw conflict('Only an actual dispatch can be marked delivered');
  const c = new Check();
  c.date('delivered_at', input.delivered_at, { required: true });
  if (input.delivered_at && d.dispatch_date && input.delivered_at < d.dispatch_date) c.fail('delivered_at', 'Delivery cannot be before dispatch');
  if (input.delivered_at && input.delivered_at > today()) c.fail('delivered_at', 'Delivery cannot be in the future');
  c.text('received_by_name', input.received_by_name, { max: 120, label: 'Received by' });
  c.throwIfAny();
  update('dispatches', id, {
    delivered_at: input.delivered_at, delivery_note: str(input.note, 300), received_by_name: str(input.received_by_name, 120),
    pod_document_id: intId(input.pod_document_id) || d.pod_document_id, updated_at: nowIso(),
  });
  if (input.pod_document_id) linkAttachment(intId(input.pod_document_id), 'dispatch', id, user);
  audit('dispatch', id, 'delivered', { delivered_at: input.delivered_at, received_by: input.received_by_name });
  return { id };
}

// ------------------------------------------------------------------ cancellation
/** Cancels part or all of the remaining balance. Dispatched quantity can never be cancelled. */
export function cancelQuantity(lineId, input, user) {
  const l = loadLine(lineId);
  if (l.order_status !== 'confirmed') throw conflict('Draft orders are edited, not cancelled');
  checkVersion(l, input.version, 'order line');
  const q = lineQty(l);
  const c = new Check();
  c.positive('qty', input.qty, { label: 'Quantity to cancel' });
  const qtyN = round3(Number(input.qty));
  if (qtyN > q.remaining + 0.0005) c.fail('qty', `Only the remaining ${q.remaining} ${l.unit} can be cancelled — dispatched quantity cannot`);
  checkOption(c, 'reason_code', 'cancel_reason', input.reason_code, { note: input.note });
  c.note('note', input.note);
  if (input.requested_source && !['customer', 'internal'].includes(input.requested_source)) c.fail('requested_source', 'Choose customer or internal');
  c.date('effective_date', input.effective_date || today(), { required: true });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const id = insert('cancellations', {
      order_id: l.order_id, line_id: l.id, qty: qtyN, reason_code: input.reason_code, note: str(input.note, 1000), requested_source: input.requested_source || 'customer',
      requested_by_name: str(input.requested_by_name, 120), effective_date: input.effective_date || today(), activity_id: intId(input.activity_id), created_by: user.id, created_at: stamp,
    });
    const after = recalcLine(l.id);
    insert('order_updates', {
      order_id: l.order_id, line_id: l.id, kind: 'cancellation', changes: JSON.stringify({ cancelled_qty: [q.cancelled, after.cancelled] }), note: `${optionLabel('cancel_reason', input.reason_code)}${input.note ? ` — ${input.note}` : ''}`,
      occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1,
    });
    recalcOrder(l.order_id, user);
    audit('order_line', l.id, 'cancel_qty', { qty: qtyN, reason: input.reason_code, cancellation_id: id });
    return { id, remaining: after.remaining };
  });
}

export function reverseCancellation(id, input, user) {
  const k = get('SELECT * FROM cancellations WHERE id = ?', id);
  if (!k) throw notFound('Cancellation');
  if (k.reversed_at) throw conflict('Already reversed');
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    update('cancellations', id, { reversed_at: stamp, reversed_by: user.id, reversal_reason: str(input.reason, 300) });
    const before = get('SELECT cancelled_qty, version FROM order_lines WHERE id = ?', k.line_id);
    const after = recalcLine(k.line_id);
    insert('order_updates', {
      order_id: k.order_id, line_id: k.line_id, kind: 'cancellation_reversal', changes: JSON.stringify({ cancelled_qty: [before.cancelled_qty, after.cancelled] }), note: str(input.reason, 300),
      occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: before.version + 1,
    });
    recalcOrder(k.order_id, user);
    audit('cancellation', id, 'reverse', { reason: input.reason });
    return { id };
  });
}

// ------------------------------------------------------------------ amendments & commitments
/** Amending confirmed quantity/specification needs a reason; the original baseline is kept. */
export function amendLine(lineId, input, user) {
  const l = loadLine(lineId);
  if (l.order_status !== 'confirmed') throw conflict('Edit draft orders directly');
  checkVersion(l, input.version, 'order line');
  const q = lineQty(l);
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason for the amendment' });
  const next = {};
  if (input.confirmed_qty !== undefined && Number(input.confirmed_qty) !== l.confirmed_qty) {
    c.positive('confirmed_qty', input.confirmed_qty);
    const v = round3(Number(input.confirmed_qty));
    if (v < q.dispatched + q.cancelled - 0.0005) c.fail('confirmed_qty', `Cannot go below what is already dispatched or cancelled (${round3(q.dispatched + q.cancelled)})`);
    next.confirmed_qty = v;
  }
  if (input.spec !== undefined && (str(input.spec) || null) !== l.spec) next.spec = str(input.spec, 300);
  if (input.description !== undefined && str(input.description) && input.description !== l.description) next.description = str(input.description, 300);
  if (input.unit_price !== undefined) {
    const p = input.unit_price === '' || input.unit_price === null ? null : toMinor(input.unit_price);
    if (Number.isNaN(p)) c.fail('unit_price', 'Enter a valid price');
    else if (p !== l.unit_price_minor) next.unit_price_minor = p;
  }
  c.throwIfAny();
  if (!Object.keys(next).length) return { line_id: l.id, unchanged: true };
  return tx(() => {
    const stamp = nowIso();
    const changes = diff(l, { ...l, ...next }, Object.keys(next));
    if (!updateVersioned('order_lines', l.id, l.version, { ...next, updated_at: stamp })) throw conflict('Someone else updated this line.', { code: 'version_conflict' });
    recalcLine(l.id);
    insert('order_updates', { order_id: l.order_id, line_id: l.id, kind: 'amend', changes: JSON.stringify(changes), note: str(input.reason, 300), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1 });
    recalcOrder(l.order_id, user);
    audit('order_line', l.id, 'amend', { changes, reason: input.reason });
    return { line_id: l.id };
  });
}

/** Records specification clarification so the line can be released to production. */
export function clarifySpec(lineId, input, user) {
  const l = loadLine(lineId);
  const c = new Check();
  c.text('spec', input.spec, { required: true, max: 300, label: 'Specification' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const changes = diff(l, { ...l, spec: str(input.spec, 300), needs_clarification: 0 }, ['spec', 'needs_clarification']);
    update('order_lines', l.id, { spec: str(input.spec, 300), needs_clarification: 0, product_id: intId(input.product_id) || l.product_id, updated_at: stamp, version: l.version + 1 });
    insert('order_updates', { order_id: l.order_id, line_id: l.id, kind: 'clarified', changes: JSON.stringify(changes), note: str(input.note, 300), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1 });
    const t = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `clarify_spec:${l.id}`);
    if (t) run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?", stamp, user.id, stamp, stamp, t.id);
    audit('order_line', l.id, 'clarify_spec', changes);
    return { line_id: l.id };
  });
}

/**
 * Sets the committed dispatch date of an uncommitted line (agreeing it), or — with authorisation — corrects
 * a wrong original commitment. Customer-agreed revisions never overwrite the original promise.
 */
export function setCommitment(lineId, input, user) {
  const l = loadLine(lineId);
  const c = new Check();
  c.date('original_commitment_date', input.original_commitment_date, { required: true });
  const correcting = l.commitment_state === 'committed';
  if (correcting) {
    if (!hasPerm(user, 'orders.authorise')) throw forbidden('Only management can correct an original commitment. Record a customer-agreed revision instead.');
    c.text('reason', input.reason, { required: true, max: 300, label: 'Reason for the correction' });
  }
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    update('order_lines', l.id, {
      commitment_state: 'committed', original_commitment_date: input.original_commitment_date,
      forecast_dispatch_date: l.forecast_dispatch_date && correcting ? l.forecast_dispatch_date : input.original_commitment_date, updated_at: stamp, version: l.version + 1,
    });
    insert('commitment_changes', {
      line_id: l.id, order_id: l.order_id, kind: correcting ? 'original_correction' : 'original', old_date: l.original_commitment_date, new_date: input.original_commitment_date,
      reason: str(input.reason, 300), actor_id: user.id, created_at: stamp, occurred_at: stamp,
    });
    insert('order_updates', { order_id: l.order_id, line_id: l.id, kind: correcting ? 'commitment_correction' : 'commitment_set', changes: JSON.stringify({ original_commitment_date: [l.original_commitment_date, input.original_commitment_date] }), note: str(input.reason, 300), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1 });
    const t = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `agree_commitment:${l.id}`);
    if (t) run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?", stamp, user.id, stamp, stamp, t.id);
    audit('order_line', l.id, correcting ? 'correct_commitment' : 'set_commitment', { from: l.original_commitment_date, to: input.original_commitment_date, reason: input.reason });
    return { line_id: l.id };
  });
}

/** A new requirement on a confirmed order becomes a new line with its own commitment. */
export function addLine(orderId, input, user) {
  const o = loadOrder(orderId);
  if (o.status !== 'confirmed') throw conflict('Edit draft orders directly');
  const c = new Check();
  const [line] = validateLines(c, [input], { confirming: true });
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const lineNo = (get('SELECT MAX(line_no) AS n FROM order_lines WHERE order_id = ?', orderId).n || 0) + 1;
    const id = insert('order_lines', {
      order_id: orderId, line_no: lineNo, ...line, original_qty: line.confirmed_qty, forecast_dispatch_date: line.original_commitment_date,
      source_update_at: stamp, source_update_basis: 'entry_time', created_at: stamp, updated_at: stamp,
    });
    if (line.original_commitment_date) insert('commitment_changes', { line_id: id, order_id: orderId, kind: 'original', new_date: line.original_commitment_date, actor_id: user.id, created_at: stamp, occurred_at: stamp });
    if (line.commitment_state === 'uncommitted') {
      createTask({ line_id: id, purpose: `Agree dispatch commitment for ${o.code} line ${lineNo}`, purpose_code: 'agree_commitment', owner_id: o.owner_id, due_date: addWorkingDays(today(), 1, calendar()), kind: 'customer', source: 'line_added', alert_key: `agree_commitment:${id}` }, user, { validated: true });
    }
    insert('order_updates', { order_id: orderId, line_id: id, kind: 'add_line', changes: JSON.stringify({ line: [null, `${line.confirmed_qty} × ${line.description}`] }), note: str(input.reason, 300), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0 });
    if (o.closed_at) recalcOrder(orderId, user);
    audit('order', orderId, 'add_line', { line_id: id, reason: input.reason });
    return { line_id: id };
  });
}

/** Splits a line into a separate delivery schedule with its own commitment (the chosen schedule model). */
export function splitLine(lineId, input, user) {
  const l = loadLine(lineId);
  const q = lineQty(l);
  const c = new Check();
  c.positive('qty', input.qty, { label: 'Quantity to split off' });
  const qtyN = round3(Number(input.qty));
  if (qtyN >= q.remaining) c.fail('qty', `Split off less than the remaining ${q.remaining}`);
  c.date('original_commitment_date', input.original_commitment_date, { required: true });
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const lineNo = (get('SELECT MAX(line_no) AS n FROM order_lines WHERE order_id = ?', l.order_id).n || 0) + 1;
    update('order_lines', l.id, { confirmed_qty: round3(l.confirmed_qty - qtyN), original_qty: l.original_qty === null ? null : round3(l.original_qty - qtyN), updated_at: stamp, version: l.version + 1 });
    const id = insert('order_lines', {
      order_id: l.order_id, line_no: lineNo, product_id: l.product_id, description: l.description, spec: l.spec, needs_clarification: l.needs_clarification, unit: l.unit,
      confirmed_qty: qtyN, original_qty: l.order_status === 'confirmed' ? qtyN : null, unit_price_minor: l.unit_price_minor, enquiry_line_id: l.enquiry_line_id, quote_line_index: l.quote_line_index,
      commitment_state: 'committed', original_commitment_date: input.original_commitment_date, forecast_dispatch_date: input.original_commitment_date,
      phase: l.phase, work_status: l.work_status, source_update_at: stamp, source_update_basis: 'entry_time', created_at: stamp, updated_at: stamp,
    });
    if (l.order_status === 'confirmed') insert('commitment_changes', { line_id: id, order_id: l.order_id, kind: 'original', new_date: input.original_commitment_date, reason: `Split from line ${l.line_no}: ${str(input.reason, 200)}`, actor_id: user.id, created_at: stamp, occurred_at: stamp });
    insert('order_updates', { order_id: l.order_id, line_id: l.id, kind: 'split', changes: JSON.stringify({ confirmed_qty: [l.confirmed_qty, round3(l.confirmed_qty - qtyN)], new_line: [null, lineNo] }), note: str(input.reason, 300), occurred_at: stamp, entered_at: stamp, entered_by: user.id, substantive: 0, record_version: l.version + 1 });
    audit('order_line', l.id, 'split', { qty: qtyN, new_line_id: id, reason: input.reason });
    return { line_id: id };
  });
}

export function orderLineOptions(user, query = {}) {
  const where = ["o.status = 'confirmed'", 'o.closed_at IS NULL'];
  const params = [];
  if (intId(query.customer_id)) {
    where.push('o.customer_id = ?');
    params.push(intId(query.customer_id));
  }
  if (query.q) {
    where.push('(o.code LIKE ? OR o.po_reference LIKE ? OR c.company_name LIKE ? OR p.code LIKE ? OR l.description LIKE ?)');
    const like = likeTerm(query.q);
    params.push(like, like, like, like, like);
  }
  const scope = orderScope(user, 'o');
  if (scope) where.push(scope);
  return all(`SELECT l.*, o.code AS order_code, o.customer_id, o.status AS order_status, c.company_name AS customer_name, p.code AS product_code
    FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN products p ON p.id = l.product_id
    WHERE ${where.join(' AND ')} ORDER BY o.code, l.line_no LIMIT 200`, ...params)
    .filter((l) => isPositive(lineQty(l).remaining))
    .map((l) => ({ ...decorateLine(l, 'confirmed'), order_code: l.order_code, customer_name: l.customer_name }));
}
