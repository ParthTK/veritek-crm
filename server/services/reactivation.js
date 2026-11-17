// Past customers and lost prospects: why business did not happen, and what Veritek is doing next.
// A reason recorded here belongs to this reactivation case; it never becomes a permanent customer label.
import { all, get, insert, run, tx, update } from '../db.js';
import {
  Check, conflict, forbidden, notFound, nowIso, today, tz, settings, str, intId, bool, checkOption, optionLabel, audit, history, placeholders,
} from '../util.js';
import { addDays, overdueAt } from '../../shared/dates.js';
import { OPEN_ENQUIRY_STAGES } from '../../shared/constants.js';
import { customerScope } from '../access.js';
import { requireActiveUser } from './people.js';
import { createTask, decorateTask, TASK_COLUMNS } from './tasks.js';
import { createEnquiry } from './enquiries.js';
import { EFFECTIVE_LAST_ORDER_SQL, HAS_ORDERS_SQL, LAST_ENQUIRY_SQL } from './customers.js';

const OPEN_STAGES_SQL = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');

/**
 * Past buyers: at least one confirmed historical order and no confirmed order within the threshold (or an
 * unknown last-order date). Lost prospects: a lost opportunity and never a purchase. A customer can appear
 * here while also having current work.
 */
export function pastCustomers(query, user) {
  const threshold = Number(query.threshold) > 0 ? Number(query.threshold) : settings().rules.dormantDays;
  const cutoff = addDays(today(), -threshold);
  const where = ['c.merged_into_id IS NULL', 'c.archived_at IS NULL'];
  const params = [];
  const scope = customerScope(user, 'c');
  if (scope) where.push(scope);
  if (!bool(query.include_dnc)) where.push('c.do_not_contact = 0');
  if (intId(query.owner)) {
    where.push('c.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (query.segment_filter || query.market) {
    where.push('c.segment = ?');
    params.push(query.segment_filter || query.market);
  }
  if (query.country) {
    where.push('c.country_code = ?');
    params.push(query.country);
  }
  if (query.q) {
    where.push('(c.company_name LIKE ? OR c.code LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  const pastBuyer = `(${HAS_ORDERS_SQL('c')} AND (${EFFECTIVE_LAST_ORDER_SQL('c')} IS NULL OR ${EFFECTIVE_LAST_ORDER_SQL('c')} < '${cutoff}'))`;
  const lostProspect = `(NOT ${HAS_ORDERS_SQL('c')} AND EXISTS (SELECT 1 FROM enquiries e WHERE e.customer_id = c.id AND e.stage = 'lost'))`;
  const openCase = "EXISTS (SELECT 1 FROM reactivation_cases rc WHERE rc.customer_id = c.id AND rc.closed_at IS NULL)";
  const segment = query.segment || 'all';
  if (segment === 'past_buyers') where.push(pastBuyer);
  else if (segment === 'lost_prospects') where.push(lostProspect);
  else where.push(`(${pastBuyer} OR ${lostProspect} OR ${openCase})`);

  const rows = all(`SELECT c.id, c.code, c.company_name, c.country_code, c.city, c.segment, c.owner_id, c.do_not_contact, c.dnc_reason, c.legacy_source,
      u.name AS owner_name,
      ${EFFECTIVE_LAST_ORDER_SQL('c')} AS last_order_date,
      ${HAS_ORDERS_SQL('c')} AS has_orders,
      ${LAST_ENQUIRY_SQL('c')} AS last_enquiry_at,
      (SELECT COUNT(*) FROM enquiries e WHERE e.customer_id = c.id AND e.stage IN (${OPEN_STAGES_SQL})) AS open_enquiries,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed' AND o.closed_at IS NULL) AS active_orders,
      (SELECT e.id FROM enquiries e WHERE e.customer_id = c.id AND e.stage = 'lost' ORDER BY e.decided_at DESC LIMIT 1) AS lost_enquiry_id
    FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE ${where.join(' AND ')}`, ...params);
  if (!rows.length) return { rows: [], counts: {}, threshold, cutoff, metrics: reactivationMetrics(user) };

  const ids = rows.map((r) => r.id);
  const lostIds = rows.map((r) => r.lost_enquiry_id).filter(Boolean);
  const lost = lostIds.length ? Object.fromEntries(all(`SELECT id, code, lost_reason_code, lost_note, decided_at FROM enquiries WHERE id IN (${placeholders(lostIds)})`, lostIds).map((e) => [e.id, e])) : {};
  const cases = Object.fromEntries(all(`SELECT rc.*, ru.name AS reason_recorded_by_name FROM reactivation_cases rc LEFT JOIN users ru ON ru.id = rc.reason_recorded_by
    WHERE rc.customer_id IN (${placeholders(ids)}) ORDER BY rc.closed_at IS NOT NULL DESC, rc.id`, ids).map((rc) => [rc.customer_id, rc]));
  const contacts = Object.fromEntries(all(`SELECT a.customer_id, a.occurred_at, a.outcome, a.channel, u.name AS by_name, a.reported_by_name
    FROM activities a LEFT JOIN users u ON u.id = a.entered_by WHERE a.id IN (
      SELECT (SELECT a2.id FROM activities a2 WHERE a2.customer_id = x.id AND a2.customer_contact = 1 ORDER BY a2.occurred_at DESC LIMIT 1) FROM customers x WHERE x.id IN (${placeholders(ids)}))`, ids)
    .map((a) => [a.customer_id, a]));
  const nextTasks = Object.fromEntries(all(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.id IN (SELECT (SELECT t2.id FROM tasks t2 WHERE t2.customer_id = x.id AND t2.status = 'open' ORDER BY t2.reactivation_case_id IS NULL, t2.overdue_at LIMIT 1) FROM customers x WHERE x.id IN (${placeholders(ids)}))`, ids)
    .map((t) => [t.customer_id, decorateTask(t)]));

  let out = rows.map((r) => {
    const rc = cases[r.id];
    const caseOpen = rc && !rc.closed_at;
    const isPast = Boolean(r.has_orders);
    const lostE = r.lost_enquiry_id ? lost[r.lost_enquiry_id] : null;
    const contact = contacts[r.id];
    const next = nextTasks[r.id] || null;
    return {
      ...r,
      kind: isPast ? 'past_buyer' : 'lost_prospect',
      last_order_unknown: isPast && !r.last_order_date,
      days_since_order: r.last_order_date ? Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${r.last_order_date}T00:00:00Z`)) / 86400000) : null,
      lost_enquiry: lostE ? { ...lostE, reason: optionLabel('lost_reason', lostE.lost_reason_code) } : null,
      case: rc ? { ...rc, reason: optionLabel('lost_reason', rc.reason_code), open: caseOpen } : null,
      status: caseOpen ? rc.status : rc?.status === 'won_back' || rc?.status === 'not_pursuing' ? rc.status : 'not_reviewed',
      why: rc?.reason_code ? { source: 'case', code: rc.reason_code, label: optionLabel('lost_reason', rc.reason_code), note: rc.reason_note, at: rc.reason_recorded_at, by: rc.reason_recorded_by_name }
        : lostE ? { source: 'enquiry', code: lostE.lost_reason_code, label: optionLabel('lost_reason', lostE.lost_reason_code), note: lostE.lost_note, at: lostE.decided_at, enquiry_id: lostE.id, enquiry_code: lostE.code }
          : null,
      last_contact: contact ? { ...contact, outcome_label: optionLabel('contact_outcome', contact.outcome) ?? optionLabel('customer_update_outcome', contact.outcome) } : null,
      next_action: next,
    };
  });
  const counts = {
    all: out.length,
    past_buyers: out.filter((r) => r.kind === 'past_buyer').length,
    lost_prospects: out.filter((r) => r.kind === 'lost_prospect').length,
    followup_due: out.filter((r) => ['today', 'overdue'].includes(r.next_action?.due_state)).length,
    not_reviewed: out.filter((r) => r.status === 'not_reviewed').length,
    date_unknown: out.filter((r) => r.last_order_unknown).length,
  };
  if (query.filter === 'followup_due') out = out.filter((r) => ['today', 'overdue'].includes(r.next_action?.due_state));
  else if (query.filter === 'not_reviewed') out = out.filter((r) => r.status === 'not_reviewed');
  else if (query.filter === 'date_unknown') out = out.filter((r) => r.last_order_unknown);
  else if (query.status) out = out.filter((r) => r.status === query.status);
  const dueRank = { overdue: 0, today: 1, upcoming: 2 };
  out.sort((a, b) => (dueRank[a.next_action?.due_state] ?? 3) - (dueRank[b.next_action?.due_state] ?? 3)
    || String(a.next_action?.overdue_at || '').localeCompare(String(b.next_action?.overdue_at || ''))
    || String(a.last_order_date || '0000').localeCompare(String(b.last_order_date || '0000')));
  return { rows: out, counts, threshold, cutoff, metrics: reactivationMetrics(user) };
}

/** Customers contacted, responses, opportunities reopened and orders won back (value per currency). */
export function reactivationMetrics(user, { from, to } = {}) {
  const start = from || addDays(today(), -90);
  const end = to || addDays(today(), 1);
  const cases = all(`SELECT rc.* FROM reactivation_cases rc WHERE rc.opened_at < ? AND (rc.closed_at IS NULL OR rc.closed_at >= ?)`, `${end}T00:00:00Z`, `${start}T00:00:00Z`);
  const ids = cases.map((c) => c.id);
  const contacted = ids.length ? get(`SELECT COUNT(DISTINCT reactivation_case_id) AS n FROM activities WHERE reactivation_case_id IN (${placeholders(ids)}) AND customer_contact = 1 AND occurred_at >= ?`, ...ids, `${start}T00:00:00Z`).n : 0;
  const responses = ids.length ? get(`SELECT COUNT(DISTINCT reactivation_case_id) AS n FROM activities WHERE reactivation_case_id IN (${placeholders(ids)}) AND meaningful = 1 AND occurred_at >= ?`, ...ids, `${start}T00:00:00Z`).n : 0;
  const reopened = cases.filter((c) => c.enquiry_id).length;
  const won = cases.filter((c) => c.status === 'won_back' && c.order_id);
  const value = {};
  for (const c of won) {
    const o = get('SELECT currency FROM orders WHERE id = ?', c.order_id);
    const v = get('SELECT SUM(confirmed_qty * unit_price_minor) AS v FROM order_lines WHERE order_id = ? AND unit_price_minor IS NOT NULL', c.order_id)?.v;
    if (v) value[o.currency || 'INR'] = (value[o.currency || 'INR'] || 0) + Math.round(v);
  }
  const reasons = all(`SELECT reason_code, COUNT(*) AS n FROM reactivation_cases WHERE reason_code IS NOT NULL GROUP BY reason_code ORDER BY n DESC`)
    .map((r) => ({ ...r, label: optionLabel('lost_reason', r.reason_code) }));
  return { from: start, to: end, cases: cases.length, contacted, responses, reopened, won_back: won.length, won_back_value: value, reasons };
}

function dncGuard(customer, input) {
  if (!customer.do_not_contact) return;
  if (settings().access.dncPolicy === 'block') throw forbidden(`${customer.company_name} is marked do-not-contact (${customer.dnc_reason || 'no reason recorded'}). Outreach is blocked.`);
  if (!bool(input.override_dnc)) throw conflict(`${customer.company_name} is marked do-not-contact (${customer.dnc_reason || 'no reason recorded'}). Confirm you have a valid reason to contact them.`, { code: 'do_not_contact' });
}

function openCaseFor(customerId, user, basis) {
  const existing = get('SELECT * FROM reactivation_cases WHERE customer_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', customerId);
  if (existing) return existing;
  const c = get('SELECT * FROM customers WHERE id = ?', customerId);
  const stamp = nowIso();
  const id = insert('reactivation_cases', {
    customer_id: customerId, status: 'not_reviewed', basis, threshold_days: settings().rules.dormantDays, opened_at: stamp, owner_id: c.owner_id,
    created_by: user?.id ?? null, created_at: stamp, updated_at: stamp,
  });
  audit('reactivation', id, 'open', { customer_id: customerId, basis });
  return get('SELECT * FROM reactivation_cases WHERE id = ?', id);
}

/**
 * "Record a simple update": why no purchase, an optional note, and the next action with a date and a named
 * owner — one save, one reminder. The follow-up date shown everywhere comes from this same task.
 */
export function recordUpdate(customerId, input, user) {
  const customer = get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!customer) throw notFound('Customer');
  const c = new Check();
  if (input.reason_code) checkOption(c, 'reason_code', 'lost_reason', input.reason_code, { note: input.note });
  c.note('note', input.note);
  const action = input.action_type ? checkOption(c, 'action_type', 'reactivation_action', input.action_type, { note: input.note }) : null;
  const ownerId = intId(input.owner_id) || customer.owner_id;
  requireActiveUser(c, 'owner_id', ownerId, 'Owner');
  c.date('due_date', input.due_date, { required: true, message: 'Choose the follow-up date' });
  c.throwIfAny();
  dncGuard(customer, input);
  return tx(() => {
    const isPast = get(`SELECT ${HAS_ORDERS_SQL('c')} AS h FROM customers c WHERE c.id = ?`, customerId).h;
    const rc = openCaseFor(customerId, user, isPast ? 'inactivity' : 'lost_prospect');
    const stamp = nowIso();
    const fields = { updated_at: stamp, owner_id: ownerId, status: rc.status === 'not_reviewed' ? 'to_contact' : rc.status };
    if (input.reason_code) Object.assign(fields, { reason_code: input.reason_code, reason_note: str(input.note, 1000), reason_recorded_at: stamp, reason_recorded_by: user.id });
    update('reactivation_cases', rc.id, { ...fields, version: rc.version + 1 });
    const purpose = str(input.purpose, 200) || (action ? {
      call: 'Call customer', email: 'Email customer', revised_quote: 'Send revised offer', product_update: 'Share product update', ask_feedback: 'Ask why they did not proceed', other: str(input.note, 120) || 'Reconnect with customer',
    }[action.code] || action.label : 'Reconnect with customer');
    const open = rc.task_id ? get("SELECT * FROM tasks WHERE id = ? AND status = 'open'", rc.task_id) : null;
    let taskId;
    if (open) {
      taskId = open.id;
      const changes = [];
      if (open.due_date !== input.due_date) changes.push(['due', open.due_date, input.due_date]);
      if (open.owner_id !== ownerId) changes.push(['owner', String(open.owner_id), String(ownerId)]);
      if (changes.length || open.purpose !== purpose) {
        run(`UPDATE tasks SET purpose = ?, owner_id = ?, due_date = ?, overdue_at = ?, reschedule_count = reschedule_count + ?, updated_at = ?, version = version + 1 WHERE id = ?`,
          purpose, ownerId, input.due_date, overdueAt(input.due_date, open.due_time, tz()), changes.some((x) => x[0] === 'due') ? 1 : 0, stamp, open.id);
        for (const [field, a, b] of changes) insert('task_changes', { task_id: open.id, field, old_value: a, new_value: b, reason: 'Updated from past customers', actor_id: user.id, created_at: stamp });
      }
    } else {
      taskId = createTask({ customer_id: customerId, reactivation_case_id: rc.id, purpose, purpose_code: 'reactivation', owner_id: ownerId, due_date: input.due_date, kind: 'customer', source: 'reactivation' }, user, { validated: true });
      update('reactivation_cases', rc.id, { task_id: taskId });
    }
    history('customer', customerId, 'reactivation_update', { customerId, data: { case_id: rc.id, reason: input.reason_code, action: input.action_type }, note: str(input.note, 1000) });
    audit('reactivation', rc.id, 'update', { reason_code: input.reason_code, due_date: input.due_date, owner_id: ownerId, task_id: taskId });
    return { case_id: rc.id, task_id: taskId };
  });
}

/** A fresh requirement found while reconnecting becomes a linked new enquiry; the original source stays. */
export function openLinkedEnquiry(customerId, input, user) {
  const customer = get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!customer) throw notFound('Customer');
  dncGuard(customer, input);
  return tx(() => {
    const rc = openCaseFor(customerId, user, 'manual');
    const lastLost = get("SELECT id FROM enquiries WHERE customer_id = ? AND stage = 'lost' ORDER BY decided_at DESC LIMIT 1", customerId);
    const res = createEnquiry({
      ...input, customer_id: customerId, source_code: input.source_code || 'outbound', reactivation_case_id: rc.id, parent_enquiry_id: input.parent_enquiry_id || lastLost?.id || null,
    }, user);
    update('reactivation_cases', rc.id, { enquiry_id: res.id, status: 'opportunity_reopened', updated_at: nowIso(), version: rc.version + 1 });
    audit('reactivation', rc.id, 'enquiry_opened', { enquiry_id: res.id });
    return { ...res, case_id: rc.id };
  });
}

/** Won back only with a linked confirmed order; not pursuing needs a reason and may set a review date. */
export function closeCase(caseId, input, user) {
  const rc = get('SELECT * FROM reactivation_cases WHERE id = ?', caseId);
  if (!rc) throw notFound('Reactivation case');
  if (rc.closed_at) throw conflict('This case is already closed');
  const c = new Check();
  if (input.status === 'won_back') {
    const o = intId(input.order_id) ? get("SELECT * FROM orders WHERE id = ? AND customer_id = ? AND status = 'confirmed'", intId(input.order_id), rc.customer_id) : null;
    if (!o) c.fail('order_id', 'Won back needs a confirmed order for this customer');
    else if (o.confirmed_at && o.confirmed_at < rc.opened_at) c.fail('order_id', 'Choose an order confirmed after reconnecting started');
  } else if (input.status === 'not_pursuing') {
    checkOption(c, 'reason_code', 'reactivation_close_reason', input.reason_code, { note: input.note });
    if (input.review_date) c.date('review_date', input.review_date);
  } else c.fail('status', 'Choose won back or not pursuing');
  c.note('note', input.note);
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    update('reactivation_cases', caseId, {
      status: input.status, order_id: input.status === 'won_back' ? intId(input.order_id) : rc.order_id, closure_reason_code: input.reason_code || null,
      closure_note: str(input.note, 1000), review_date: input.review_date || null, closed_at: stamp, updated_at: stamp, version: rc.version + 1,
    });
    for (const t of all("SELECT id FROM tasks WHERE reactivation_case_id = ? AND status = 'open'", caseId)) {
      run("UPDATE tasks SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        stamp, user.id, input.status === 'won_back' ? 'Customer won back' : 'Not pursuing', stamp, t.id);
    }
    history('customer', rc.customer_id, input.status === 'won_back' ? 'won_back' : 'reactivation_closed', { customerId: rc.customer_id, data: { case_id: caseId, order_id: input.order_id, reason: input.reason_code }, note: str(input.note, 1000) });
    audit('reactivation', caseId, 'close', { status: input.status, reason: input.reason_code, review_date: input.review_date });
    return { case_id: caseId };
  });
}

export function caseForCustomer(customerId) {
  return get('SELECT * FROM reactivation_cases WHERE customer_id = ? ORDER BY closed_at IS NOT NULL, id DESC LIMIT 1', customerId);
}

export { openCaseFor };
