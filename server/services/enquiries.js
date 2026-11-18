// Enquiries: fast capture, pipeline transitions with their rules, line outcomes and partial wins.
import { all, get, insert, run, tx, update, updateVersioned } from '../db.js';
import {
  Check, badRequest, conflict, notFound, nowIso, now, today, tz, calendar, settings, str, intId, bool, checkOption, optionLabel,
  nextCode, audit, history, diff, likeTerm, placeholders, normPhone, normEmail,
} from '../util.js';
import { addWorkingDays, isInstant, localDate, addDays, daysBetween } from '../../shared/dates.js';
import { ENQUIRY_STAGES, OPEN_ENQUIRY_STAGES, PIPELINE_STAGES, CURRENCIES, labelOf } from '../../shared/constants.js';
import { round3, toMinor } from '../../shared/rules.js';
import { enquiryScope, assertCustomer } from '../access.js';
import { requireActiveUser } from './people.js';
import { linkVisitToEnquiry } from './campaigns.js';
import { createCustomer } from './customers.js';
import { createTask, cancelOpenTasksFor, tasksWhere, activitiesWhere, validateTaskInput, decorateTask, TASK_COLUMNS } from './tasks.js';
import { linkAttachment, attachmentsFor } from './attachments.js';

const isOpen = (stage) => OPEN_ENQUIRY_STAGES.includes(stage);

function validateLines(c, lines, { requireQty = false } = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    c.fail('lines', 'Add at least one product or requirement');
    return [];
  }
  return lines.map((l, i) => {
    const productId = intId(l.product_id);
    const product = productId ? get('SELECT * FROM products WHERE id = ?', productId) : null;
    if (productId && !product) c.fail(`lines.${i}.product_id`, 'Choose a product from the list');
    if (!productId && !str(l.requirement)) c.fail(`lines.${i}.requirement`, 'Choose a product, or describe the requirement ("Unspecified / needs clarification")');
    c.text(`lines.${i}.requirement`, l.requirement, { max: 300, label: 'Requirement' });
    c.text(`lines.${i}.spec`, l.spec, { max: 300, label: 'Specification' });
    const q = l.qty === '' || l.qty === null || l.qty === undefined ? null : Number(l.qty);
    if (q !== null && (!Number.isFinite(q) || q <= 0)) c.fail(`lines.${i}.qty`, 'Quantity must be greater than zero, or leave it blank if unknown');
    if (requireQty && q === null) c.fail(`lines.${i}.qty`, 'Quantity is required');
    if (q !== null && product?.integer_qty && !Number.isInteger(q)) c.fail(`lines.${i}.qty`, 'Whole pieces only for this product');
    const categoryId = intId(l.category_id) || product?.category_id || null;
    if (intId(l.category_id) && !get('SELECT id FROM product_categories WHERE id = ?', intId(l.category_id))) c.fail(`lines.${i}.category_id`, 'Choose a product family');
    return {
      product_id: productId,
      category_id: categoryId,
      requirement: str(l.requirement, 300),
      spec: str(l.spec, 300),
      qty: q === null ? null : round3(q),
      unit: q === null ? (str(l.unit, 20) || product?.default_unit || null) : (str(l.unit, 20) || product?.default_unit || 'pcs'),
    };
  });
}

/** What still has to be filled in before a quotation or order can be confirmed (shown, never invented). */
export function missingDetails(e, lines, customer, contact) {
  const out = [];
  lines.forEach((l, i) => {
    const n = lines.length > 1 ? `Line ${i + 1}: ` : '';
    if (!l.product_id) out.push(`${n}product not specified (needs clarification)`);
    if (l.qty === null || l.qty === undefined) out.push(`${n}quantity unknown`);
  });
  if (customer?.provisional) out.push('Customer is provisional — confirm company details before an order');
  if (customer && !customer.country_code) out.push('Country unknown (needed for export reporting)');
  if (!contact || (!contact.phone_raw && !contact.email_raw)) out.push('No contact phone or email');
  if (e.received_unknown) out.push('Received date unknown (historical record)');
  return out;
}

// ------------------------------------------------------------------ opportunity details & ownership
/**
 * Optional opportunity details carried over from the lead pipeline: title, campaign, estimated value (with
 * its currency), probability and expected decision date. None of them blocks a fast capture.
 */
function opportunityFields(c, input, current = {}) {
  const out = {};
  if (input.title !== undefined) {
    c.text('title', input.title, { max: 160, label: 'Title' });
    out.title = str(input.title, 160);
  }
  if (input.campaign_id !== undefined) {
    const cid = intId(input.campaign_id);
    if (cid && !get('SELECT id FROM campaigns WHERE id = ?', cid)) c.fail('campaign_id', 'Choose a campaign');
    out.campaign_id = cid;
  }
  if (input.est_value !== undefined) {
    const m = toMinor(input.est_value);
    if (Number.isNaN(m) || (m !== null && m < 0)) c.fail('est_value', 'Enter a valid amount');
    else out.est_value_minor = m;
    const cur = input.est_currency || current.est_currency || 'INR';
    if (m !== null && !CURRENCIES.includes(cur)) c.fail('est_currency', 'Choose a currency');
    out.est_currency = m === null ? null : cur;
  }
  if (input.probability !== undefined) {
    const p = input.probability === '' || input.probability === null ? null : Number(input.probability);
    if (p !== null && (!Number.isInteger(p) || p < 0 || p > 100)) c.fail('probability', 'Use a whole percentage from 0 to 100');
    else out.probability = p;
  }
  if (input.expected_decision_date !== undefined) {
    c.date('expected_decision_date', input.expected_decision_date);
    out.expected_decision_date = input.expected_decision_date || null;
  }
  return out;
}

/** Default owner from the assignment rules (region, product family, market), most specific match first. */
export function defaultOwnerFor(customerId, lines = []) {
  if (!settings().access.autoAssignEnquiries) return null;
  const cust = customerId ? get('SELECT region_id, segment, owner_id FROM customers WHERE id = ?', customerId) : null;
  const categories = new Set(lines.map((l) => l.category_id || (l.product_id ? get('SELECT category_id FROM products WHERE id = ?', l.product_id)?.category_id : null)).filter(Boolean));
  const rules = all('SELECT r.* FROM assignment_rules r JOIN users u ON u.id = r.user_id WHERE r.active = 1 AND u.active = 1 ORDER BY r.priority, r.id');
  let best = null;
  let bestScore = -1;
  for (const r of rules) {
    if (r.region_id && r.region_id !== cust?.region_id) continue;
    if (r.segment && r.segment !== cust?.segment) continue;
    if (r.category_id && !categories.has(r.category_id)) continue;
    const score = (r.region_id ? 2 : 0) + (r.category_id ? 2 : 0) + (r.segment ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best?.user_id ?? null;
}

// ------------------------------------------------------------------ create
/**
 * Single-page capture. Unknown quantities and unspecified products are allowed; the system fills in the
 * enquiry number, entry time, customer history link, initial status and the first follow-up task.
 */
/** An enquiry that came from an exhibition must name the exhibition, so it counts towards that event. */
function checkExhibitionLink(c, sourceCode, campaignId) {
  if (sourceCode !== 'exhibition') return;
  const campaign = campaignId ? get('SELECT type FROM campaigns WHERE id = ?', campaignId) : null;
  if (!campaign) c.fail('campaign_id', 'Choose the exhibition this enquiry came from');
  else if (campaign.type !== 'exhibition') c.fail('campaign_id', 'Choose an exhibition');
}

export function createEnquiry(input, user, { importBatchId = null, sourceConfidence = null, allowUnknownReceived = false, requireExhibitionLink = false } = {}) {
  const c = new Check();
  let customerId = intId(input.customer_id);
  if (!customerId && !input.new_customer) c.fail('customer_id', 'Find the customer, or add a new company');
  if (customerId) {
    const cust = get('SELECT id, merged_into_id, archived_at FROM customers WHERE id = ?', customerId);
    if (!cust) c.fail('customer_id', 'Customer not found');
    else if (cust.merged_into_id) c.fail('customer_id', 'This profile was merged — choose the surviving customer');
    else assertCustomer(user, customerId);
  }
  const lines = validateLines(c, input.lines);
  checkOption(c, 'source_code', 'enquiry_source', input.source_code, { note: input.source_event, noteField: 'source_event' });
  c.text('source_event', input.source_event, { max: 120, label: 'Event name' });
  const ownerId = intId(input.owner_id)
    || (customerId ? get('SELECT owner_id FROM customers WHERE id = ? AND owner_id IN (SELECT id FROM users WHERE active = 1)', customerId)?.owner_id : null)
    || defaultOwnerFor(customerId, lines)
    || (user.group === 'sales' ? user.id : null);
  requireActiveUser(c, 'owner_id', ownerId, 'Owner');
  const opp = opportunityFields(c, input);
  if (requireExhibitionLink) checkExhibitionLink(c, input.source_code, opp.campaign_id);
  if (opp.campaign_id && !input.source_event) opp.source_event = get('SELECT name FROM campaigns WHERE id = ?', opp.campaign_id)?.name ?? null;
  c.note('requirement_note', input.requirement_note);
  const unknownReceived = allowUnknownReceived && bool(input.received_unknown);
  if (!unknownReceived && input.received_at) {
    if (!isInstant(input.received_at)) c.fail('received_at', 'Use a valid date and time');
    else if (Date.parse(input.received_at) > now().getTime() + 10 * 60000) c.fail('received_at', 'The received time cannot be in the future');
  }
  const next = {
    purpose: str(input.next?.purpose) || 'Respond to enquiry',
    owner_id: intId(input.next?.owner_id) || ownerId,
    due_date: input.next?.due_date || addWorkingDays(today(), settings().rules.enquiryResponseWorkingDays, calendar()),
    due_time: input.next?.due_time || null,
  };
  if (!input.skip_task) validateTaskInput(c, next, 'next.');
  if (input.contact_id && customerId && !get('SELECT id FROM contacts WHERE id = ? AND customer_id = ?', intId(input.contact_id), customerId)) c.fail('contact_id', 'Choose a contact of this customer');
  c.throwIfAny();

  return tx(() => {
    if (!customerId) customerId = createCustomer({ ...input.new_customer, owner_id: input.new_customer.owner_id || ownerId }, user);
    let contactId = intId(input.contact_id);
    if (!contactId && input.new_contact && (str(input.new_contact.name) || str(input.new_contact.phone) || str(input.new_contact.email))) {
      const country = get('SELECT country_code FROM customers WHERE id = ?', customerId)?.country_code;
      const stamp = nowIso();
      contactId = insert('contacts', {
        customer_id: customerId, name: str(input.new_contact.name, 120), role: str(input.new_contact.role, 120), phone_raw: str(input.new_contact.phone, 40),
        phone_norm: normPhone(input.new_contact.phone, country), email_raw: str(input.new_contact.email, 160),
        email_norm: normEmail(input.new_contact.email), is_primary: get('SELECT id FROM contacts WHERE customer_id = ? AND is_primary = 1', customerId) ? 0 : 1,
        active: 1, created_at: stamp, updated_at: stamp,
      });
    }
    if (!contactId) contactId = get('SELECT id FROM contacts WHERE customer_id = ? AND active = 1 ORDER BY is_primary DESC, id LIMIT 1', customerId)?.id ?? null;
    const stamp = nowIso();
    const receivedAt = unknownReceived ? null : input.received_at ? new Date(input.received_at).toISOString() : stamp;
    const id = insert('enquiries', {
      code: nextCode('ENQ'),
      customer_id: customerId,
      contact_id: contactId,
      owner_id: ownerId,
      received_at: receivedAt,
      received_unknown: unknownReceived ? 1 : 0,
      source_code: input.source_code,
      ...opp,
      source_event: str(input.source_event, 120) || opp.source_event || null,
      stage: 'new',
      requirement_note: str(input.requirement_note, 1000),
      parent_enquiry_id: intId(input.parent_enquiry_id),
      reactivation_case_id: intId(input.reactivation_case_id),
      import_batch_id: importBatchId,
      external_id: str(input.external_id, 80),
      source_confidence: sourceConfidence,
      created_by: user.id,
      created_at: stamp,
      updated_at: stamp,
    });
    lines.forEach((l, i) => insert('enquiry_lines', { enquiry_id: id, ...l, sort: i, created_at: stamp, updated_at: stamp }));
    let taskId = null;
    if (!input.skip_task) {
      taskId = createTask({ enquiry_id: id, customer_id: customerId, ...next, purpose_code: next.purpose === 'Respond to enquiry' ? 'respond_enquiry' : null, kind: 'customer', source: 'enquiry_created' }, user, { validated: true });
    }
    for (const aid of input.attachment_ids || []) linkAttachment(intId(aid), 'enquiry', id, user);
    history('enquiry', id, 'created', { customerId, occurredAt: receivedAt, data: { source: input.source_code, lines: lines.length } });
    audit('enquiry', id, 'create', { customer_id: customerId, owner_id: ownerId, source: input.source_code, lines: lines.length, received_at: receivedAt });
    if (opp.campaign_id) linkVisitToEnquiry({ campaignId: opp.campaign_id, customerId, contactId, enquiryId: id, receivedAt: receivedAt || stamp }, user);
    return { id, customer_id: customerId, task_id: taskId };
  });
}

// ------------------------------------------------------------------ read
export function getEnquiry(id, user) {
  const e = get(`SELECT e.*, u.name AS owner_name, c.company_name AS customer_name, c.code AS customer_code, c.provisional AS customer_provisional,
      c.country_code, c.do_not_contact, c.region_id, c.segment, ct.name AS contact_name, ct.phone_raw AS contact_phone, ct.email_raw AS contact_email, p.code AS parent_code, d.code AS duplicate_of_code,
      cp.name AS campaign_name
    FROM enquiries e JOIN users u ON u.id = e.owner_id JOIN customers c ON c.id = e.customer_id LEFT JOIN contacts ct ON ct.id = e.contact_id
    LEFT JOIN enquiries p ON p.id = e.parent_enquiry_id LEFT JOIN enquiries d ON d.id = e.duplicate_of_id LEFT JOIN campaigns cp ON cp.id = e.campaign_id WHERE e.id = ?`, id);
  if (!e) throw notFound('Enquiry');
  const lines = all(`SELECT el.*, p.code AS product_code, p.name AS product_name, p.family, pc.name AS category_name,
      (SELECT COALESCE(SUM(COALESCE(ol.original_qty, ol.confirmed_qty)), 0) FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.enquiry_line_id = el.id AND o.archived_at IS NULL) AS ordered_qty
    FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id LEFT JOIN product_categories pc ON pc.id = el.category_id WHERE el.enquiry_id = ? ORDER BY el.sort, el.id`, id);
  const customer = get('SELECT * FROM customers WHERE id = ?', e.customer_id);
  const contact = e.contact_id ? get('SELECT * FROM contacts WHERE id = ?', e.contact_id) : null;
  const quotations = all('SELECT q.*, u.name AS prepared_by_name FROM quotations q LEFT JOIN users u ON u.id = q.prepared_by WHERE q.enquiry_id = ? ORDER BY q.id', id).map((q) => ({
    ...q,
    revisions: all(`SELECT r.*, u.name AS issued_by_name FROM quote_revisions r LEFT JOIN users u ON u.id = r.issued_by WHERE r.quotation_id = ? ORDER BY r.revision_no DESC`, q.id)
      .map((r) => ({ ...r, lines: JSON.parse(r.lines || '[]'), approval_reasons: JSON.parse(r.approval_reasons || '[]'), expired: r.validity_date ? r.validity_date < today() : false, attachments: attachmentsFor('quote_revision', r.id) })),
  }));
  const orders = all(`SELECT o.id, o.code, o.status, o.received_date, o.po_reference, o.closed_at, o.quote_revision_id FROM orders o WHERE o.enquiry_id = ? ORDER BY o.id`, id);
  const hist = all(`SELECT h.*, u.name AS actor_name FROM history_events h LEFT JOIN users u ON u.id = h.actor_id WHERE h.entity_type = 'enquiry' AND h.entity_id = ? ORDER BY h.created_at DESC`, id)
    .map((h) => ({ ...h, data: JSON.parse(h.data || 'null') }));
  const children = all('SELECT id, code, stage, received_at FROM enquiries WHERE parent_enquiry_id = ? ORDER BY id', id);
  return {
    enquiry: {
      ...e,
      stage_label: labelOf(ENQUIRY_STAGES, e.stage),
      open: isOpen(e.stage),
      source_label: optionLabel('enquiry_source', e.source_code),
      lost_reason: optionLabel('lost_reason', e.lost_reason_code),
      cancel_reason: optionLabel('enquiry_cancel_reason', e.cancel_reason_code),
      probability_effective: e.probability ?? ENQUIRY_STAGES.find((s) => s.value === e.stage)?.probability ?? null,
    },
    lines: lines.map((l) => ({ ...l, open_qty: l.qty === null ? null : Math.max(0, round3(l.qty - l.won_qty - l.lost_qty)) })),
    missing: missingDetails(e, lines, customer, contact),
    quotations,
    orders,
    children,
    tasks: tasksWhere('enquiry_id', id),
    activities: activitiesWhere('enquiry_id', id),
    history: hist,
    attachments: attachmentsFor('enquiry', id),
  };
}

export function listEnquiries(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = enquiryScope(user, 'e');
  if (scope) where.push(scope);
  const stage = query.stage || 'open';
  if (stage === 'open') where.push(`e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')})`);
  else if (stage === 'closed') where.push("e.stage IN ('won','lost','cancelled')");
  else if (stage !== 'all') {
    where.push('e.stage = ?');
    params.push(stage);
  }
  if (query.owner === 'me') {
    where.push('e.owner_id = ?');
    params.push(user.id);
  } else if (intId(query.owner)) {
    where.push('e.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (query.source) {
    where.push('e.source_code = ?');
    params.push(query.source);
  }
  if (intId(query.customer_id)) {
    where.push('e.customer_id = ?');
    params.push(intId(query.customer_id));
  }
  if (query.segment) {
    where.push('c.segment = ?');
    params.push(query.segment);
  }
  if (query.country) {
    where.push('c.country_code = ?');
    params.push(query.country);
  }
  if (query.family) {
    where.push('EXISTS (SELECT 1 FROM enquiry_lines el JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id AND p.family = ?)');
    params.push(query.family);
  }
  if (query.from) {
    where.push('e.received_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('e.received_at < ?');
    params.push(query.to);
  }
  if (query.lost_reason) {
    where.push('e.lost_reason_code = ?');
    params.push(query.lost_reason);
  }
  if (intId(query.campaign_id)) {
    where.push('e.campaign_id = ?');
    params.push(intId(query.campaign_id));
  }
  if (intId(query.region_id)) {
    where.push('c.region_id = ?');
    params.push(intId(query.region_id));
  }
  if (intId(query.category_id)) {
    where.push('EXISTS (SELECT 1 FROM enquiry_lines el WHERE el.enquiry_id = e.id AND el.category_id = ?)');
    params.push(intId(query.category_id));
  }
  if (query.ids) {
    const ids = String(query.ids).split(',').map(intId).filter(Boolean);
    where.push(ids.length ? `e.id IN (${placeholders(ids)})` : '1 = 0');
    params.push(...ids);
  }
  if (bool(query.no_response) || query.reply === 'unreplied') where.push('e.first_response_at IS NULL');
  if (query.reply === 'replied') where.push('e.first_response_at IS NOT NULL');
  if (bool(query.no_next)) where.push("NOT EXISTS (SELECT 1 FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open') AND e.no_followup_reason IS NULL");
  if (query.q) {
    where.push('(e.code LIKE ? OR c.company_name LIKE ? OR e.requirement_note LIKE ? OR EXISTS (SELECT 1 FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id AND (p.code LIKE ? OR el.requirement LIKE ?)))');
    const like = likeTerm(query.q);
    params.push(like, like, like, like, like);
  }
  const base = `FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id WHERE ${where.join(' AND ')}`;
  const count = get(`SELECT COUNT(*) AS n ${base}`, ...params).n;
  const pageSize = Math.min(Number(query.pageSize) || 100, 1000);
  const page = Math.max(Number(query.page) || 1, 1);
  const sorts = { received: 'e.received_at', due: 'next_overdue_at', stage: 'e.stage', customer: 'c.company_name' };
  const sortCol = sorts[query.sort] || 'next_overdue_at';
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const rows = all(`SELECT e.id, e.code, e.title, e.est_value_minor, e.est_currency, e.probability, e.expected_decision_date, e.campaign_id, e.stage, e.received_at, e.received_unknown, e.first_response_at, e.source_code, e.source_event, e.owner_id, e.lost_reason_code, e.decided_at, e.no_followup_reason,
      c.id AS customer_id, c.company_name AS customer_name, c.code AS customer_code, c.country_code, c.segment, c.do_not_contact, u.name AS owner_name,
      (SELECT COALESCE(p.code, el.requirement, 'Unspecified') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort, el.id LIMIT 1) AS product,
      (SELECT COUNT(*) FROM enquiry_lines el WHERE el.enquiry_id = e.id) AS line_count,
      (SELECT el.qty FROM enquiry_lines el WHERE el.enquiry_id = e.id ORDER BY el.sort, el.id LIMIT 1) AS qty,
      (SELECT el.unit FROM enquiry_lines el WHERE el.enquiry_id = e.id ORDER BY el.sort, el.id LIMIT 1) AS unit,
      (SELECT COUNT(*) FROM enquiry_lines el WHERE el.enquiry_id = e.id AND (el.qty IS NULL OR el.product_id IS NULL)) AS missing_lines,
      (SELECT t.id FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1) AS next_task_id,
      (SELECT t.overdue_at FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1) AS next_overdue_at,
      (SELECT r.status FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id ORDER BY r.id DESC LIMIT 1) AS quote_status,
      (SELECT q.number || ' rev ' || r.revision_no FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id ORDER BY r.id DESC LIMIT 1) AS quote_ref
    ${base} ORDER BY ${sortCol} ${dir} NULLS LAST, e.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
  const taskIds = rows.map((r) => r.next_task_id).filter(Boolean);
  const tasks = taskIds.length ? Object.fromEntries(all(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id WHERE t.id IN (${placeholders(taskIds)})`, taskIds).map((t) => [t.id, decorateTask(t)])) : {};
  const replyCounts = get(`SELECT COALESCE(SUM(CASE WHEN e.first_response_at IS NULL THEN 0 ELSE 1 END), 0) AS replied, COALESCE(SUM(CASE WHEN e.first_response_at IS NULL THEN 1 ELSE 0 END), 0) AS unreplied
    FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')}) ${scope ? `AND ${scope}` : ''}`);
  const stageCounts = Object.fromEntries(all(`SELECT e.stage, COUNT(*) AS n FROM enquiries e JOIN customers c ON c.id = e.customer_id ${scope ? `WHERE ${scope}` : ''} GROUP BY e.stage`).map((r) => [r.stage, r.n]));
  return {
    rows: rows.map((r) => ({
      ...r,
      stage_label: labelOf(ENQUIRY_STAGES, r.stage),
      source_label: optionLabel('enquiry_source', r.source_code),
      lost_reason: optionLabel('lost_reason', r.lost_reason_code),
      next_task: r.next_task_id ? tasks[r.next_task_id] : null,
    })),
    count,
    page,
    pageSize,
    stage_counts: stageCounts,
    reply_counts: replyCounts,
  };
}

// ------------------------------------------------------------------ update
export function updateEnquiry(id, input, user, { requireExhibitionLink = false } = {}) {
  const e = get('SELECT * FROM enquiries WHERE id = ?', id);
  if (!e) throw notFound('Enquiry');
  const c = new Check();
  const next = {};
  if (input.owner_id !== undefined) {
    requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Owner');
    next.owner_id = intId(input.owner_id);
  }
  if (input.contact_id !== undefined) {
    if (input.contact_id && !get('SELECT id FROM contacts WHERE id = ? AND customer_id = ?', intId(input.contact_id), e.customer_id)) c.fail('contact_id', 'Choose a contact of this customer');
    next.contact_id = intId(input.contact_id);
  }
  if (input.source_code !== undefined) {
    checkOption(c, 'source_code', 'enquiry_source', input.source_code, { note: input.source_event ?? e.source_event, noteField: 'source_event' });
    next.source_code = input.source_code;
  }
  if (input.source_event !== undefined) next.source_event = str(input.source_event, 120);
  if (input.requirement_note !== undefined) {
    c.note('requirement_note', input.requirement_note);
    next.requirement_note = str(input.requirement_note, 1000);
  }
  Object.assign(next, opportunityFields(c, input, e));
  const sourceChanged = next.source_code !== undefined && next.source_code !== e.source_code;
  const campaignChanged = next.campaign_id !== undefined && next.campaign_id !== e.campaign_id;
  if (requireExhibitionLink && (sourceChanged || campaignChanged)) checkExhibitionLink(c, next.source_code ?? e.source_code, next.campaign_id !== undefined ? next.campaign_id : e.campaign_id);
  let lines = null;
  if (input.lines !== undefined) {
    if (!isOpen(e.stage)) c.fail('lines', 'Reopen the enquiry before changing its lines');
    lines = validateLines(c, input.lines);
  }
  c.throwIfAny();
  return tx(() => {
    const changes = diff(e, { ...e, ...next }, Object.keys(next));
    if (Object.keys(next).length && !updateVersioned('enquiries', id, Number(input.version ?? e.version), { ...next, updated_at: nowIso() })) {
      throw conflict('Someone else updated this enquiry. Review their changes before saving again.', { code: 'version_conflict', current: getEnquiry(id, user) });
    }
    if (lines) {
      const existing = all('SELECT * FROM enquiry_lines WHERE enquiry_id = ? ORDER BY sort, id', id);
      const stamp = nowIso();
      (input.lines || []).forEach((raw, i) => {
        const l = lines[i];
        const lid = intId(raw.id);
        if (lid && existing.some((x) => x.id === lid)) update('enquiry_lines', lid, { ...l, sort: i, updated_at: stamp });
        else insert('enquiry_lines', { enquiry_id: id, ...l, sort: i, created_at: stamp, updated_at: stamp });
      });
      const keep = new Set((input.lines || []).map((r) => intId(r.id)).filter(Boolean));
      for (const x of existing) {
        if (keep.has(x.id)) continue;
        if (get('SELECT id FROM order_lines WHERE enquiry_line_id = ? LIMIT 1', x.id)) throw conflict('A line already converted to an order cannot be removed. Mark it lost or cancelled instead.');
        run('DELETE FROM enquiry_lines WHERE id = ?', x.id);
      }
      if (!Object.keys(next).length) run('UPDATE enquiries SET version = version + 1, updated_at = ? WHERE id = ?', stamp, id);
      changes.lines = ['updated', `${lines.length} line(s)`];
    }
    if (campaignChanged && next.campaign_id) linkVisitToEnquiry({ campaignId: next.campaign_id, customerId: e.customer_id, contactId: e.contact_id, enquiryId: id, receivedAt: e.received_at || nowIso() }, user);
    if (changes.owner_id) history('enquiry', id, 'owner_changed', { customerId: e.customer_id, data: { from: changes.owner_id[0], to: changes.owner_id[1] } });
    if (Object.keys(changes).length) audit('enquiry', id, 'update', changes);
    return { id };
  });
}

/** Marks the unconverted remainder of a line lost (partial win) or the whole line lost/cancelled. */
export function setLineOutcome(lineId, input, user) {
  const l = get('SELECT el.*, e.stage, e.customer_id FROM enquiry_lines el JOIN enquiries e ON e.id = el.enquiry_id WHERE el.id = ?', lineId);
  if (!l) throw notFound('Enquiry line');
  const c = new Check();
  const outcome = input.outcome;
  if (!['lost', 'cancelled', 'open'].includes(outcome)) c.fail('outcome', 'Choose lost, cancelled or open');
  if (outcome === 'lost') checkOption(c, 'reason_code', 'lost_reason', input.reason_code, { note: input.note });
  c.note('note', input.note);
  c.throwIfAny();
  return tx(() => {
    const remaining = l.qty === null ? null : round3(l.qty - l.won_qty);
    const next = outcome === 'open'
      ? { outcome: 'open', lost_qty: 0, lost_reason_code: null, outcome_note: null }
      : {
        outcome: l.won_qty > 0 ? 'partial' : outcome,
        lost_qty: remaining === null ? 0 : Math.max(0, remaining),
        lost_reason_code: outcome === 'lost' ? input.reason_code : null,
        outcome_note: str(input.note, 1000),
      };
    update('enquiry_lines', lineId, { ...next, updated_at: nowIso() });
    history('enquiry', l.enquiry_id, 'line_outcome', { customerId: l.customer_id, data: { line_id: lineId, ...next } });
    audit('enquiry_line', lineId, 'outcome', next);
    maybeMarkWon(l.enquiry_id, user);
    return { id: lineId };
  });
}

/** Moves an enquiry to Won only when a linked confirmed order covers the accepted scope. */
export function maybeMarkWon(enquiryId, user) {
  if (!enquiryId) return false;
  const e = get('SELECT * FROM enquiries WHERE id = ?', enquiryId);
  if (!e || !isOpen(e.stage)) return false;
  const confirmedOrder = get("SELECT id FROM orders WHERE enquiry_id = ? AND status = 'confirmed' LIMIT 1", enquiryId);
  if (!confirmedOrder) return false;
  const lines = all('SELECT * FROM enquiry_lines WHERE enquiry_id = ?', enquiryId);
  const open = lines.filter((l) => l.outcome === 'open' && !(l.won_qty > 0 && (l.qty === null || l.won_qty >= l.qty - 0.0005)));
  if (open.length) return false;
  for (const l of lines) {
    if (l.outcome === 'open') update('enquiry_lines', l.id, { outcome: 'won', updated_at: nowIso() });
  }
  const stamp = nowIso();
  run("UPDATE enquiries SET stage = 'won', decided_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", stamp, stamp, enquiryId);
  history('enquiry', enquiryId, 'stage_changed', { customerId: e.customer_id, data: { from: e.stage, to: 'won', order_id: confirmedOrder.id } });
  cancelOpenTasksFor('enquiry_id', enquiryId, 'Enquiry won — order confirmed', user);
  audit('enquiry', enquiryId, 'stage', { from: e.stage, to: 'won', automatic: true });
  return true;
}

/** Records converted quantities on the enquiry lines an order came from. */
export function applyConvertedQuantities(orderLines) {
  for (const ol of orderLines) {
    if (!ol.enquiry_line_id) continue;
    const el = get('SELECT * FROM enquiry_lines WHERE id = ?', ol.enquiry_line_id);
    if (!el) continue;
    const won = round3(el.won_qty + ol.qty);
    const outcome = el.qty === null || won >= el.qty - 0.0005 ? 'won' : 'open';
    update('enquiry_lines', el.id, { won_qty: won, outcome, updated_at: nowIso() });
  }
}

// ------------------------------------------------------------------ stage transitions
/**
 * Pipeline rules: Awaiting decision keeps a next follow-up; On hold needs a review date; Lost needs a
 * reason (Other needs a note); Cancelled separates withdrawn/duplicate/invalid from a commercial loss;
 * Quotation sent needs an issued quotation; Won needs a confirmed order covering the accepted scope;
 * reopening a closed enquiry needs a reason and leaves a history event.
 */
export function changeStage(id, input, user) {
  const e = get('SELECT * FROM enquiries WHERE id = ?', id);
  if (!e) throw notFound('Enquiry');
  if (input.version !== undefined && input.version !== null && Number(input.version) !== e.version) {
    throw conflict('Someone else updated this enquiry. Review the latest state before changing it.', { code: 'version_conflict' });
  }
  const to = input.stage;
  if (!ENQUIRY_STAGES.some((s) => s.value === to)) throw badRequest('Choose a valid stage', { stage: 'Choose a stage' });
  if (to === e.stage) return { id, unchanged: true };
  if (!isOpen(e.stage) && isOpen(to)) return reopenEnquiry(id, input, user);
  if (!isOpen(e.stage) && !isOpen(to)) throw conflict('This enquiry is already closed. Reopen it first if the decision changed.');

  const c = new Check();
  const openTasks = get("SELECT COUNT(*) AS n FROM tasks WHERE enquiry_id = ? AND status = 'open'", id).n;
  const next = input.next && (input.next.purpose || input.next.due_date) ? input.next : null;
  if (next) validateTaskInput(c, next, 'next.');
  const fields = { stage: to, updated_at: nowIso() };

  if (to === 'quote_sent') {
    const issued = get("SELECT r.id FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = ? AND r.status IN ('issued','accepted') LIMIT 1", id);
    if (!issued) c.fail('stage', 'Record the issued quotation first — a draft quotation does not count as sent');
  }
  if (to === 'awaiting_decision' && !openTasks && !next) c.fail('next.purpose', 'Awaiting decision needs a next follow-up: set the next action and date');
  if (to === 'on_hold') {
    c.date('hold_review_date', input.hold_review_date, { required: true, message: 'On hold needs a review date' });
    if (input.hold_review_date && input.hold_review_date < today()) c.fail('hold_review_date', 'The review date cannot be in the past');
    c.text('hold_reason', input.hold_reason, { max: 300, label: 'Reason' });
    Object.assign(fields, { hold_review_date: input.hold_review_date, hold_reason: str(input.hold_reason, 300) });
  }
  if (to === 'lost') {
    checkOption(c, 'lost_reason_code', 'lost_reason', input.lost_reason_code, { note: input.lost_note, noteField: 'lost_note' });
    c.note('lost_note', input.lost_note);
    c.text('competitor', input.competitor, { max: 120, label: 'Competitor' });
    Object.assign(fields, { lost_reason_code: input.lost_reason_code, lost_note: str(input.lost_note, 1000), competitor: str(input.competitor, 120), decision_evidence: str(input.decision_evidence, 300), decided_at: nowIso() });
  }
  if (to === 'cancelled') {
    checkOption(c, 'cancel_reason_code', 'enquiry_cancel_reason', input.cancel_reason_code, { note: input.cancel_note, noteField: 'cancel_note' });
    c.note('cancel_note', input.cancel_note);
    if (input.duplicate_of_id && !get('SELECT id FROM enquiries WHERE id = ?', intId(input.duplicate_of_id))) c.fail('duplicate_of_id', 'Choose the original enquiry');
    Object.assign(fields, { cancel_reason_code: input.cancel_reason_code, cancel_note: str(input.cancel_note, 1000), duplicate_of_id: intId(input.duplicate_of_id), decided_at: nowIso() });
  }
  if (to === 'won') {
    if (!get("SELECT id FROM orders WHERE enquiry_id = ? AND status = 'confirmed' LIMIT 1", id)) c.fail('stage', 'Won needs a linked confirmed order. Convert the accepted quotation, or enter the order first.');
    const open = all("SELECT el.*, p.code FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = ? AND el.outcome = 'open'", id)
      .filter((l) => !(l.won_qty > 0 && (l.qty === null || l.won_qty >= l.qty - 0.0005)));
    if (open.length) c.fail('stage', `Some scope is not converted (${open.map((l) => l.code || l.requirement).join(', ')}). Mark the remainder lost, or keep the enquiry open.`);
    fields.decided_at = nowIso();
  }
  if (isOpen(to) && !['awaiting_decision', 'on_hold'].includes(to) && !openTasks && !next && !str(input.no_followup_reason)) {
    c.fail('next.purpose', 'An open enquiry needs a next action (or a recorded reason for no follow-up)');
  }
  c.throwIfAny();

  return tx(() => {
    if (!updateVersioned('enquiries', id, e.version, fields)) throw conflict('Someone else updated this enquiry.', { code: 'version_conflict' });
    if (next) {
      createTask({ enquiry_id: id, customer_id: e.customer_id, ...next, kind: next.kind || 'customer', source: 'stage_change' }, user, { validated: true });
      run('UPDATE enquiries SET no_followup_reason = NULL WHERE id = ?', id);
    } else if (str(input.no_followup_reason)) {
      run('UPDATE enquiries SET no_followup_reason = ? WHERE id = ?', str(input.no_followup_reason, 300), id);
    }
    if (to === 'on_hold' && !next) {
      createTask({ enquiry_id: id, customer_id: e.customer_id, purpose: 'Review on-hold enquiry', purpose_code: 'hold_review', owner_id: e.owner_id, due_date: input.hold_review_date, kind: 'internal', source: 'stage_change', alert_key: `enquiry_hold:${id}` }, user, { validated: true });
    }
    if (to === 'lost' || to === 'cancelled') {
      const stamp = nowIso();
      for (const l of all("SELECT * FROM enquiry_lines WHERE enquiry_id = ? AND outcome = 'open'", id)) {
        update('enquiry_lines', l.id, {
          outcome: l.won_qty > 0 ? 'partial' : to,
          lost_qty: l.qty === null ? 0 : Math.max(0, round3(l.qty - l.won_qty)),
          lost_reason_code: to === 'lost' ? input.lost_reason_code : null,
          updated_at: stamp,
        });
      }
      cancelOpenTasksFor('enquiry_id', id, to === 'lost' ? 'Enquiry closed as lost' : 'Enquiry cancelled', user);
      // A quotation still waiting on the customer ends with its enquiry; it must not stay "sent" for ever.
      run(`UPDATE quote_revisions SET status = 'rejected', decided_at = ?, rejection_reason_code = ?, decision_note = ?, updated_at = ?, version = version + 1
        WHERE status = 'issued' AND quotation_id IN (SELECT id FROM quotations WHERE enquiry_id = ?)`, nowIso(), to === 'lost' ? input.lost_reason_code : null,
      str(input.lost_note || input.cancel_note, 1000) || (to === 'lost' ? 'Enquiry closed as lost' : 'Enquiry cancelled'), nowIso(), id);
      if (to === 'lost' && input.lost_reason_code === 'unknown') {
        // An unknown reason prompts a feedback task rather than a guessed explanation.
        createTask({
          enquiry_id: id, customer_id: e.customer_id, purpose: 'Ask why they did not proceed', purpose_code: 'ask_feedback', owner_id: e.owner_id,
          due_date: addWorkingDays(today(), 3, calendar()), kind: 'customer', source: 'lost_unknown',
        }, user, { validated: true });
      }
    }
    history('enquiry', id, 'stage_changed', {
      customerId: e.customer_id,
      data: { from: e.stage, to, reason: to === 'lost' ? optionLabel('lost_reason', input.lost_reason_code) : to === 'cancelled' ? optionLabel('enquiry_cancel_reason', input.cancel_reason_code) : to === 'on_hold' ? str(input.hold_reason) : null },
      note: str(input.lost_note || input.cancel_note || input.hold_reason, 1000),
    });
    audit('enquiry', id, 'stage', { from: e.stage, to, ...diff(e, { ...e, ...fields }, Object.keys(fields).filter((k) => k !== 'updated_at')) });
    return { id };
  });
}

export function reopenEnquiry(id, input, user) {
  const e = get('SELECT * FROM enquiries WHERE id = ?', id);
  if (!e) throw notFound('Enquiry');
  if (isOpen(e.stage)) throw conflict('This enquiry is already open');
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason for reopening' });
  const to = isOpen(input.stage) ? input.stage : 'new';
  const next = input.next || {};
  validateTaskInput(c, { purpose: next.purpose || 'Follow up reopened enquiry', owner_id: next.owner_id || e.owner_id, due_date: next.due_date }, 'next.');
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const previous = { stage: e.stage, lost_reason_code: e.lost_reason_code, lost_note: e.lost_note, cancel_reason_code: e.cancel_reason_code, decided_at: e.decided_at };
    if (!updateVersioned('enquiries', id, e.version, {
      stage: to, reopened_count: e.reopened_count + 1, lost_reason_code: null, lost_note: null, cancel_reason_code: null, cancel_note: null,
      decided_at: null, no_followup_reason: null, updated_at: stamp,
    })) throw conflict('Someone else updated this enquiry.', { code: 'version_conflict' });
    for (const l of all("SELECT * FROM enquiry_lines WHERE enquiry_id = ? AND outcome IN ('lost','cancelled','partial')", id)) {
      update('enquiry_lines', l.id, { outcome: 'open', lost_qty: 0, lost_reason_code: null, updated_at: stamp });
    }
    createTask({ enquiry_id: id, customer_id: e.customer_id, purpose: next.purpose || 'Follow up reopened enquiry', owner_id: next.owner_id || e.owner_id, due_date: next.due_date, kind: 'customer', source: 'reopened' }, user, { validated: true });
    history('enquiry', id, 'reopened', { customerId: e.customer_id, data: { previous, to }, note: str(input.reason, 300) });
    audit('enquiry', id, 'reopen', { previous, to, reason: input.reason });
    return { id };
  });
}

// ------------------------------------------------------------------ pipeline board & forecast
/**
 * Open enquiries by stage with values per currency (the latest issued quotation, else the estimate).
 * Weighted value = value × probability (recorded, else the stage default). The 30/60/90-day forecast uses
 * the expected decision date; enquiries without a value or date are counted separately, never guessed.
 */
export function pipelineBoard(query, user) {
  const where = [`e.stage IN (${PIPELINE_STAGES.map((s) => `'${s}'`).join(',')})`];
  const params = [];
  const scope = enquiryScope(user, 'e');
  if (scope) where.push(scope);
  if (query.owner === 'me') {
    where.push('e.owner_id = ?');
    params.push(user.id);
  } else if (intId(query.owner)) {
    where.push('e.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (query.segment) {
    where.push('c.segment = ?');
    params.push(query.segment);
  }
  if (intId(query.region_id)) {
    where.push('c.region_id = ?');
    params.push(intId(query.region_id));
  }
  const rows = all(`SELECT e.id, e.code, e.title, e.stage, e.owner_id, e.est_value_minor, e.est_currency, e.probability, e.expected_decision_date, e.received_at, e.version,
      c.id AS customer_id, c.company_name AS customer_name, c.city, u.name AS owner_name,
      (SELECT COALESCE(p.code, el.requirement, 'Unspecified') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort, el.id LIMIT 1) AS product,
      (SELECT r.total_minor FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_minor,
      (SELECT r.currency FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_currency,
      (SELECT t.due_date FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1) AS next_due,
      (SELECT t.purpose FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1) AS next_purpose
    FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id WHERE ${where.join(' AND ')}
    ORDER BY e.expected_decision_date IS NULL, e.expected_decision_date, e.id DESC`, ...params);
  const day = today();
  const columns = PIPELINE_STAGES.map((stage) => ({ stage, label: labelOf(ENQUIRY_STAGES, stage), cards: [], value_by_currency: {}, weighted_by_currency: {} }));
  const forecast = { d30: {}, d60: {}, d90: {}, later: {}, undated: 0, unvalued: 0 };
  for (const r of rows) {
    const quoted = r.quoted_minor !== null && r.quoted_minor !== undefined;
    const value = quoted ? r.quoted_minor : r.est_value_minor;
    const currency = quoted ? r.quoted_currency : r.est_currency;
    const probability = r.probability ?? ENQUIRY_STAGES.find((s) => s.value === r.stage)?.probability ?? 0;
    const weighted = value === null || value === undefined ? null : Math.round((value * probability) / 100);
    const col = columns.find((x) => x.stage === r.stage);
    col.cards.push({
      ...r, value_minor: value ?? null, currency: currency || null, value_basis: quoted ? 'quoted' : value !== null && value !== undefined ? 'estimate' : null,
      probability_effective: probability, weighted_minor: weighted, overdue_decision: Boolean(r.expected_decision_date && r.expected_decision_date < day),
    });
    if (value !== null && value !== undefined && currency) {
      col.value_by_currency[currency] = (col.value_by_currency[currency] || 0) + value;
      col.weighted_by_currency[currency] = (col.weighted_by_currency[currency] || 0) + weighted;
      if (!r.expected_decision_date) forecast.undated++;
      else {
        const n = daysBetween(day, r.expected_decision_date);
        const bucket = n <= 30 ? 'd30' : n <= 60 ? 'd60' : n <= 90 ? 'd90' : 'later';
        forecast[bucket][currency] = (forecast[bucket][currency] || 0) + weighted;
      }
    } else forecast.unvalued++;
  }
  return { columns, forecast, total: rows.length, as_of: day, horizon: { d30: addDays(day, 30), d60: addDays(day, 60), d90: addDays(day, 90) } };
}

export function enquiryCodes(ids) {
  if (!ids.length) return {};
  return Object.fromEntries(all(`SELECT id, code FROM enquiries WHERE id IN (${placeholders(ids)})`, ids).map((r) => [r.id, r.code]));
}

export { localDate, tz };
