// P1: complaint register and service desk. The reported symptom is kept apart from the confirmed root
// cause, and returns/replacements reference the original transaction instead of altering it.
// Service extras: severity, warranty status (inferred from the product warranty), site visits, customer
// feedback rating, and a quality view of repeated product issues (rates only with a real denominator).
import { all, get, insert, run, tx, updateVersioned } from '../db.js';
import {
  Check, conflict, notFound, nowIso, today, calendar, str, intId, checkOption, optionLabel, nextCode, audit, history, notify, notifyRoles, likeTerm,
} from '../util.js';
import { addDays, addWorkingDays, daysBetween } from '../../shared/dates.js';
import { COMPLAINT_STATUSES, COMPLAINT_SEVERITIES, WARRANTY_STATUSES, labelOf } from '../../shared/constants.js';
import { requireActiveUser } from './people.js';
import { createTask, tasksWhere, activitiesWhere } from './tasks.js';
import { linkAttachment, attachmentsFor } from './attachments.js';
import { complaintScope } from '../access.js';

const isOpen = (s) => COMPLAINT_STATUSES.find((x) => x.value === s)?.open ?? true;
const SEVERITY_ORDER = "CASE k.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

const SELECT = `SELECT k.*, c.company_name, c.city, u.name AS owner_name, o.code AS order_code, COALESCE(p.code, k.model) AS product, p.name AS product_name,
    ct.name AS contact_name, ct.phone_raw AS contact_phone,
    (SELECT MIN(t.due_date) FROM tasks t WHERE t.complaint_id = k.id AND t.status = 'open') AS next_due
  FROM complaints k JOIN customers c ON c.id = k.customer_id JOIN users u ON u.id = k.owner_id LEFT JOIN orders o ON o.id = k.order_id
  LEFT JOIN products p ON p.id = k.product_id LEFT JOIN contacts ct ON ct.id = k.contact_id`;

function decorate(k) {
  const day = today();
  return {
    ...k,
    category: optionLabel('complaint_category', k.category_code),
    status_label: labelOf(COMPLAINT_STATUSES, k.status),
    severity_label: labelOf(COMPLAINT_SEVERITIES, k.severity),
    warranty_label: labelOf(WARRANTY_STATUSES, k.warranty_status),
    open: isOpen(k.status),
    age_days: daysBetween(k.received_date, k.resolved_date || day),
    response_overdue: isOpen(k.status) && k.next_due && k.next_due < day,
  };
}

export function listComplaints(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = complaintScope(user, 'k');
  if (scope) where.push(scope);
  if (query.state === 'open') where.push("k.status NOT IN ('resolved','closed')");
  else if (query.state === 'closed') where.push("k.status IN ('resolved','closed')");
  if (query.q) {
    where.push('(k.code LIKE ? OR c.company_name LIKE ? OR k.serial_batch LIKE ? OR k.description LIKE ?)');
    params.push(...Array(4).fill(likeTerm(query.q)));
  }
  for (const [k, col] of [['status', 'k.status'], ['category', 'k.category_code'], ['severity', 'k.severity'], ['warranty', 'k.warranty_status']]) {
    if (query[k]) {
      where.push(`${col} = ?`);
      params.push(query[k]);
    }
  }
  for (const [k, col] of [['customer_id', 'k.customer_id'], ['owner', 'k.owner_id'], ['product_id', 'k.product_id'], ['order_id', 'k.order_id']]) {
    if (intId(query[k])) {
      where.push(`${col} = ?`);
      params.push(intId(query[k]));
    }
  }
  if (query.mine) {
    where.push('k.owner_id = ?');
    params.push(user.id);
  }
  return all(`${SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN k.status IN ('resolved','closed') THEN 1 ELSE 0 END, ${SEVERITY_ORDER}, k.received_date DESC LIMIT 500`, ...params).map(decorate);
}

/**
 * Quality view: repeated issues by product, categories, monthly trend, resolution time and satisfaction.
 * A rate per 100 units is shown only where dispatched units are known; otherwise complaint counts only.
 */
export function complaintInsights(query) {
  const since = query.from || addDays(today(), -365);
  const byProduct = all(`SELECT p.id, p.code, p.name, COUNT(*) AS complaints, COUNT(DISTINCT k.customer_id) AS customers,
      SUM(CASE WHEN k.status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS open,
      GROUP_CONCAT(DISTINCT k.category_code) AS categories,
      (SELECT COALESCE(SUM(dl.qty), 0) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id JOIN order_lines l ON l.id = dl.line_id
        WHERE d.status = 'posted' AND l.product_id = p.id) AS units_dispatched
    FROM complaints k JOIN products p ON p.id = k.product_id WHERE k.received_date >= ? GROUP BY p.id ORDER BY complaints DESC`, since)
    .map((x) => ({
      ...x,
      categories: (x.categories || '').split(',').filter(Boolean).map((c) => optionLabel('complaint_category', c)),
      repeated: x.complaints >= 3 || (x.customers >= 2 && x.complaints >= 2),
      rate_per_100: x.units_dispatched > 0 ? Math.round((x.complaints / x.units_dispatched) * 1000) / 10 : null,
    }));
  const byCategory = all('SELECT category_code, COUNT(*) AS count FROM complaints WHERE received_date >= ? GROUP BY category_code ORDER BY count DESC', since)
    .map((x) => ({ ...x, category: optionLabel('complaint_category', x.category_code) }));
  const byCause = all("SELECT root_cause_code, COUNT(*) AS count FROM complaints WHERE received_date >= ? AND root_cause_code IS NOT NULL GROUP BY root_cause_code ORDER BY count DESC", since)
    .map((x) => ({ ...x, cause: optionLabel('complaint_root_cause', x.root_cause_code) }));
  const byMonth = all(`SELECT substr(received_date, 1, 7) AS month, COUNT(*) AS opened, SUM(CASE WHEN resolved_date IS NOT NULL THEN 1 ELSE 0 END) AS resolved
    FROM complaints WHERE received_date >= ? GROUP BY 1 ORDER BY 1`, since);
  const stats = get(`SELECT COUNT(*) AS count, SUM(CASE WHEN status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN severity = 'critical' AND status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS critical_open,
      AVG(CASE WHEN resolved_date IS NOT NULL THEN julianday(resolved_date) - julianday(received_date) END) AS avg_resolution_days,
      AVG(feedback_rating) AS avg_rating, COUNT(feedback_rating) AS rated, SUM(CASE WHEN warranty_status = 'in_warranty' THEN 1 ELSE 0 END) AS in_warranty
    FROM complaints WHERE received_date >= ?`, since);
  const overdueResponses = get(`SELECT COUNT(DISTINCT t.complaint_id) AS n FROM tasks t JOIN complaints k ON k.id = t.complaint_id
    WHERE t.status = 'open' AND t.due_date < ? AND k.status NOT IN ('resolved','closed')`, today()).n;
  const repeatSerials = all(`SELECT k.serial_batch, COUNT(*) AS count, MAX(c.company_name) AS company_name FROM complaints k JOIN customers c ON c.id = k.customer_id
    WHERE k.serial_batch IS NOT NULL GROUP BY k.serial_batch HAVING count > 1 ORDER BY count DESC LIMIT 20`);
  const repeatCustomers = all(`SELECT c.id, c.company_name, COUNT(*) AS count FROM complaints k JOIN customers c ON c.id = k.customer_id
    WHERE k.received_date >= ? GROUP BY c.id HAVING count > 1 ORDER BY count DESC LIMIT 20`, since);
  return {
    since, stats: { ...stats, overdue_responses: overdueResponses }, by_product: byProduct, by_category: byCategory, by_cause: byCause, by_month: byMonth,
    repeat_serials: repeatSerials, repeat_customers: repeatCustomers,
    note: 'Rates per 100 units use dispatched quantities recorded in this system; where none are recorded only complaint counts are shown.',
  };
}

export function getComplaint(id) {
  const k = get(`${SELECT.replace('FROM complaints k', ', d.code AS dispatch_code, ro.code AS replacement_order_code FROM complaints k')}
    LEFT JOIN dispatches d ON d.id = k.original_dispatch_id LEFT JOIN orders ro ON ro.id = k.replacement_order_id WHERE k.id = ?`, id);
  if (!k) throw notFound('Complaint');
  return {
    complaint: {
      ...decorate(k),
      root_cause: optionLabel('complaint_root_cause', k.root_cause_code), resolution: optionLabel('complaint_resolution', k.resolution_code),
    },
    tasks: tasksWhere('complaint_id', id),
    activities: activitiesWhere('complaint_id', id),
    history: all(`SELECT h.*, u.name AS actor_name FROM history_events h LEFT JOIN users u ON u.id = h.actor_id WHERE h.entity_type = 'complaint' AND h.entity_id = ? ORDER BY h.id DESC`, id),
    attachments: attachmentsFor('complaint', id),
    same_product: k.product_id ? all(`SELECT k2.id, k2.code, k2.category_code, k2.status, k2.received_date, c.company_name FROM complaints k2 JOIN customers c ON c.id = k2.customer_id
      WHERE k2.product_id = ? AND k2.id <> ? ORDER BY k2.received_date DESC LIMIT 10`, k.product_id, id).map((x) => ({ ...x, category: optionLabel('complaint_category', x.category_code) })) : [],
    contacts: all('SELECT id, name, phone_raw, email_raw FROM contacts WHERE customer_id = ? AND active = 1 ORDER BY is_primary DESC, name', k.customer_id),
    orders: all("SELECT id, code, received_date FROM orders WHERE customer_id = ? AND status = 'confirmed' ORDER BY received_date DESC LIMIT 50", k.customer_id),
  };
}

/** Warranty from the product's warranty months counted from installation (else invoice) date. Unknown when not derivable. */
function inferWarranty(productId, installationDate, invoiceDate) {
  if (!productId) return 'unknown';
  const start = installationDate || invoiceDate;
  if (!start) return 'unknown';
  const months = get('SELECT warranty_months FROM products WHERE id = ?', productId)?.warranty_months;
  if (!months) return 'unknown';
  return addDays(start, Math.round(months * 30.44)) >= today() ? 'in_warranty' : 'out_of_warranty';
}

/** Intake: serial/batch is optional (customers often cannot provide it). An owner and next response date are required. */
export function createComplaint(input, user) {
  const c = new Check();
  const customerId = intId(input.customer_id);
  if (!customerId || !get('SELECT id FROM customers WHERE id = ?', customerId)) c.fail('customer_id', 'Choose the customer');
  const orderId = intId(input.order_id);
  if (orderId && !get('SELECT id FROM orders WHERE id = ? AND customer_id = ?', orderId, customerId)) c.fail('order_id', 'Choose an order of this customer');
  if (input.contact_id && !get('SELECT id FROM contacts WHERE id = ? AND customer_id = ?', intId(input.contact_id), customerId)) c.fail('contact_id', 'Choose a contact of this customer');
  c.date('received_date', input.received_date || today(), { required: true });
  checkOption(c, 'category_code', 'complaint_category', input.category_code, { note: input.description, noteField: 'description' });
  c.text('description', input.description, { required: true, max: 1000, label: 'Description' });
  if (input.severity && !COMPLAINT_SEVERITIES.some((s) => s.value === input.severity)) c.fail('severity', 'Choose a severity');
  if (input.warranty_status && !WARRANTY_STATUSES.some((s) => s.value === input.warranty_status)) c.fail('warranty_status', 'Choose a warranty status');
  c.date('installation_date', input.installation_date);
  c.date('invoice_date', input.invoice_date);
  requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Owner');
  c.date('next_response_date', input.next_response_date, { required: true, message: 'Set the next response date' });
  c.throwIfAny();
  let invoiceRef = str(input.invoice_ref, 60);
  let invoiceDate = input.invoice_date || null;
  if (orderId && !invoiceRef) {
    const inv = get('SELECT invoice_ref, invoice_date FROM invoices WHERE order_id = ? ORDER BY invoice_date DESC LIMIT 1', orderId);
    if (inv) {
      invoiceRef = inv.invoice_ref;
      invoiceDate ||= inv.invoice_date;
    }
  }
  const productId = intId(input.product_id) || (intId(input.line_id) ? get('SELECT product_id FROM order_lines WHERE id = ?', intId(input.line_id))?.product_id : null);
  const warranty = input.warranty_status || inferWarranty(productId, input.installation_date, invoiceDate);
  return tx(() => {
    const stamp = nowIso();
    const code = nextCode('CMP');
    const severity = input.severity || 'medium';
    const id = insert('complaints', {
      code, customer_id: customerId, contact_id: intId(input.contact_id), order_id: orderId, line_id: intId(input.line_id), product_id: productId, model: str(input.model, 80),
      serial_batch: str(input.serial_batch, 120), invoice_ref: invoiceRef, invoice_date: invoiceDate, installation_date: input.installation_date || null, warranty_status: warranty,
      severity, received_date: input.received_date || today(), category_code: input.category_code, description: str(input.description, 1000),
      owner_id: intId(input.owner_id), status: 'new', original_dispatch_id: intId(input.original_dispatch_id), source_activity_id: intId(input.source_activity_id),
      created_by: user.id, created_at: stamp, updated_at: stamp,
    });
    createTask({ complaint_id: id, customer_id: customerId, purpose: `Respond to complaint ${code}`, purpose_code: 'complaint_response', owner_id: intId(input.owner_id), due_date: input.next_response_date, kind: 'customer', source: 'complaint', priority: ['critical', 'high'].includes(severity) ? 'high' : 'normal' }, user, { validated: true });
    if (input.source_activity_id) run('UPDATE activities SET complaint_converted_id = ? WHERE id = ?', id, intId(input.source_activity_id));
    for (const aid of input.attachment_ids || []) linkAttachment(intId(aid), 'complaint', id, user);
    history('complaint', id, 'created', { customerId, data: { code } });
    const customer = get('SELECT company_name, owner_id FROM customers WHERE id = ?', customerId);
    const link = `/complaints/${id}`;
    if (intId(input.owner_id) !== user.id) notify(intId(input.owner_id), { title: `Complaint assigned: ${code}`, message: customer.company_name, link, severity: severity === 'critical' ? 'danger' : 'warning', dedupeKey: `complaint:${id}:${input.owner_id}` });
    if (customer.owner_id && customer.owner_id !== intId(input.owner_id)) notify(customer.owner_id, { title: `Your customer raised a complaint: ${code}`, message: customer.company_name, link, dedupeKey: `complaint_sales:${id}` });
    notifyRoles(['service'], { title: `New complaint ${code}`, message: `${customer.company_name} — ${optionLabel('complaint_category', input.category_code)}`, link, severity: 'warning', dedupeKey: `complaint_new:${id}` });
    if (productId) {
      const recent = get('SELECT COUNT(*) AS n FROM complaints WHERE product_id = ? AND received_date >= ?', productId, addDays(today(), -90)).n;
      if (recent >= 3) {
        const p = get('SELECT code FROM products WHERE id = ?', productId);
        notifyRoles(['quality', 'management'], { title: `Repeated complaints: ${p.code}`, message: `${recent} complaints in the last 90 days`, link: '/complaints?tab=insights', severity: 'danger', dedupeKey: `repeat_product:${productId}:${today().slice(0, 7)}` });
      }
    }
    audit('complaint', id, 'create', { customer_id: customerId, category: input.category_code, severity });
    return { id, code };
  });
}

/**
 * Status changes: while open a next action/date/owner is required unless waiting with a review date;
 * resolving needs the action taken, a summary and the resolved date. Root cause is recorded separately.
 */
export function updateComplaint(id, input, user) {
  const k = get('SELECT * FROM complaints WHERE id = ?', id);
  if (!k) throw notFound('Complaint');
  const c = new Check();
  const next = {};
  const to = input.status || k.status;
  if (!COMPLAINT_STATUSES.some((s) => s.value === to)) c.fail('status', 'Choose a status');
  if (to !== k.status) next.status = to;
  if (input.root_cause_code !== undefined) {
    if (input.root_cause_code) checkOption(c, 'root_cause_code', 'complaint_root_cause', input.root_cause_code, { note: input.root_cause_note, noteField: 'root_cause_note' });
    next.root_cause_code = input.root_cause_code || null;
    next.root_cause_note = str(input.root_cause_note, 1000);
  }
  if (input.severity !== undefined) {
    if (!COMPLAINT_SEVERITIES.some((s) => s.value === input.severity)) c.fail('severity', 'Choose a severity');
    else next.severity = input.severity;
  }
  if (input.warranty_status !== undefined) {
    if (!WARRANTY_STATUSES.some((s) => s.value === input.warranty_status)) c.fail('warranty_status', 'Choose a warranty status');
    else next.warranty_status = input.warranty_status;
  }
  if (input.owner_id !== undefined && intId(input.owner_id) !== k.owner_id) {
    if (requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Owner')) next.owner_id = intId(input.owner_id);
  }
  if (input.contact_id !== undefined) next.contact_id = intId(input.contact_id);
  for (const f of ['site_visit_date', 'installation_date']) {
    if (input[f] !== undefined) {
      c.date(f, input[f]);
      next[f] = input[f] || null;
    }
  }
  if (input.site_visit_notes !== undefined) next.site_visit_notes = str(input.site_visit_notes, 1000);
  if (input.feedback_rating !== undefined && input.feedback_rating !== null && input.feedback_rating !== '') {
    const n = Number(input.feedback_rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) c.fail('feedback_rating', 'Rating must be 1 to 5');
    else next.feedback_rating = n;
  }
  if (input.customer_feedback !== undefined) next.customer_feedback = str(input.customer_feedback, 1000);
  if (to === 'awaiting_customer') {
    c.date('review_date', input.review_date ?? k.review_date, { required: true, message: 'Waiting needs a review date' });
    next.review_date = input.review_date ?? k.review_date;
  }
  if (to === 'resolved' || to === 'closed') {
    const code = input.resolution_code ?? k.resolution_code;
    checkOption(c, 'resolution_code', 'complaint_resolution', code, { note: input.resolution_summary ?? k.resolution_summary, noteField: 'resolution_summary' });
    c.text('resolution_summary', input.resolution_summary ?? k.resolution_summary, { required: true, max: 1000, label: 'Resolution summary' });
    c.date('resolved_date', input.resolved_date ?? k.resolved_date ?? today(), { required: true });
    Object.assign(next, { resolution_code: code, resolution_summary: str(input.resolution_summary ?? k.resolution_summary, 1000), resolved_date: input.resolved_date ?? k.resolved_date ?? today() });
    if (to === 'closed') next.closed_at = nowIso();
  }
  for (const f of ['return_reference']) if (input[f] !== undefined) next[f] = str(input[f], 120);
  if (input.replacement_order_id !== undefined) next.replacement_order_id = intId(input.replacement_order_id);
  if (!k.first_response_at && (to !== 'new' || input.site_visit_date)) next.first_response_at = nowIso();
  const nextTask = input.next && (input.next.due_date || input.next.purpose) ? input.next : null;
  if (nextTask) {
    requireActiveUser(c, 'next.owner_id', intId(nextTask.owner_id), 'Owner');
    c.date('next.due_date', nextTask.due_date, { required: true });
  }
  const stillOpen = isOpen(to) && to !== 'awaiting_customer';
  if (stillOpen && !nextTask && !get("SELECT id FROM tasks WHERE complaint_id = ? AND status = 'open'", id)) c.fail('next.due_date', 'An open complaint needs a next action, date and owner');
  c.throwIfAny();
  return tx(() => {
    if (Object.keys(next).length && !updateVersioned('complaints', id, Number(input.version ?? k.version), { ...next, updated_at: nowIso() })) {
      throw conflict('Someone else updated this complaint.', { code: 'version_conflict' });
    }
    if (input.site_visit_date && input.site_visit_date !== k.site_visit_date) {
      createTask({ complaint_id: id, customer_id: k.customer_id, purpose: `Site visit for ${k.code}`, purpose_code: 'site_visit', owner_id: next.owner_id || k.owner_id, due_date: input.site_visit_date, kind: 'customer', source: 'complaint' }, user, { validated: true });
    }
    if (nextTask) createTask({ complaint_id: id, customer_id: k.customer_id, purpose: nextTask.purpose || `Follow up complaint ${k.code}`, owner_id: intId(nextTask.owner_id), due_date: nextTask.due_date, kind: nextTask.kind || 'customer', source: 'complaint' }, user, { validated: true });
    if (!isOpen(to)) {
      for (const t of all("SELECT id FROM tasks WHERE complaint_id = ? AND status = 'open'", id)) {
        run("UPDATE tasks SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = 'Complaint resolved', updated_at = ?, version = version + 1 WHERE id = ?", nowIso(), user.id, nowIso(), t.id);
      }
    }
    if (next.owner_id) notify(next.owner_id, { title: `Complaint assigned: ${k.code}`, link: `/complaints/${id}`, severity: 'warning', dedupeKey: `complaint:${id}:${next.owner_id}` });
    if (next.status === 'resolved') {
      const cust = get('SELECT owner_id, company_name FROM customers WHERE id = ?', k.customer_id);
      if (cust.owner_id) notify(cust.owner_id, { title: `Complaint ${k.code} resolved`, message: `${cust.company_name} · collect customer feedback`, link: `/complaints/${id}`, severity: 'success', dedupeKey: `complaint_resolved:${id}` });
    }
    if (next.status) history('complaint', id, 'status_changed', { customerId: k.customer_id, data: { from: k.status, to } });
    audit('complaint', id, 'update', next);
    return { id };
  });
}

export { addWorkingDays, calendar };
