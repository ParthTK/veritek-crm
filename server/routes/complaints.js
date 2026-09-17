import { Router } from 'express';
import { all, get, run, insert, update, tx } from '../db.js';
import { allow } from '../auth.js';

import { nowIso, today, addDays, badRequest, notFound, strOrNull, intOrNull, nextNumber, notify, whereClause, daysBetween, audit } from '../util.js';
import { complaintScope, assertCustomer, redact } from '../access.js';

const r = Router();

const SELECT = `
  SELECT k.*, c.name AS customer_name, c.city, ct.name AS contact_name, ct.phone AS contact_phone, p.name AS product_name, p.sku, pc.name AS category_name,
         o.number AS order_number, u.name AS assigned_to_name, cb.name AS created_by_name
  FROM complaints k JOIN customers c ON c.id = k.customer_id LEFT JOIN contacts ct ON ct.id = k.contact_id
  LEFT JOIN products p ON p.id = k.product_id LEFT JOIN product_categories pc ON pc.id = p.category_id
  LEFT JOIN sales_orders o ON o.id = k.order_id LEFT JOIN users u ON u.id = k.assigned_to LEFT JOIN users cb ON cb.id = k.created_by`;

r.get('/complaints', allow('complaints.view'), (req, res) => {
  const q = req.query;
  const w = [complaintScope(req.user, 'k')];
  const p = [];
  if (q.q) {
    w.push('(k.number LIKE ? OR c.name LIKE ? OR k.serial_number LIKE ? OR k.description LIKE ?)');
    p.push(...Array(4).fill(`%${q.q}%`));
  }
  if (q.status === 'open') w.push("k.status NOT IN ('resolved', 'closed')");
  else if (q.status) {
    w.push('k.status = ?');
    p.push(q.status);
  }
  for (const k of ['category', 'severity', 'assigned_to', 'product_id', 'customer_id', 'warranty_status']) {
    if (q[k]) {
      w.push(`k.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.mine === '1') w.push(`k.assigned_to = ${req.user.id}`);
  const t = today();
  const rows = all(`${SELECT} ${whereClause(w)} ORDER BY k.status IN ('resolved','closed'), CASE k.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, k.created_at DESC LIMIT 500`, ...p)
    .map((k) => ({ ...k, age_days: daysBetween(k.created_at, k.resolved_at || t) }));
  res.json(rows);
});

/** Management and quality view: repeated product issues, categories, resolution times, satisfaction. */
r.get('/complaints/insights', allow('complaints.view'), (req, res) => {
  const since = req.query.from || addDays(today(), -365);
  const byProduct = all(
    `SELECT p.id, p.name, p.sku, COUNT(*) AS complaints, COUNT(DISTINCT k.customer_id) AS customers,
            SUM(k.status NOT IN ('resolved','closed')) AS open,
            GROUP_CONCAT(DISTINCT k.category) AS categories,
            (SELECT COALESCE(SUM(oi.qty), 0) FROM order_items oi JOIN sales_orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status <> 'cancelled') AS units_sold
     FROM complaints k JOIN products p ON p.id = k.product_id WHERE substr(k.created_at, 1, 10) >= ?
     GROUP BY p.id ORDER BY complaints DESC`,
    since,
  ).map((x) => ({ ...x, repeated: x.complaints >= 3 || x.customers >= 2 && x.complaints >= 2, rate_per_100: x.units_sold ? Math.round((x.complaints / x.units_sold) * 1000) / 10 : null }));
  const byCategory = all(`SELECT category, COUNT(*) AS count FROM complaints WHERE substr(created_at, 1, 10) >= ? GROUP BY category ORDER BY count DESC`, since);
  const byMonth = all(`SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS opened, SUM(resolved_at IS NOT NULL) AS resolved FROM complaints WHERE substr(created_at, 1, 10) >= ? GROUP BY 1 ORDER BY 1`, since);
  const stats = get(
    `SELECT COUNT(*) AS count, SUM(status NOT IN ('resolved','closed')) AS open, SUM(severity = 'critical' AND status NOT IN ('resolved','closed')) AS critical_open,
            AVG(CASE WHEN resolved_at IS NOT NULL THEN julianday(resolved_at) - julianday(created_at) END) AS avg_resolution_days,
            AVG(feedback_rating) AS avg_rating, SUM(warranty_status = 'in_warranty') AS in_warranty
     FROM complaints WHERE substr(created_at, 1, 10) >= ?`,
    since,
  );
  const repeatSerials = all(
    `SELECT serial_number, COUNT(*) AS count, MAX(c.name) AS customer_name FROM complaints k JOIN customers c ON c.id = k.customer_id
     WHERE serial_number IS NOT NULL GROUP BY serial_number HAVING count > 1 ORDER BY count DESC LIMIT 20`,
  );
  res.json({ by_product: byProduct, by_category: byCategory, by_month: byMonth, stats, repeat_serials: repeatSerials });
});

function complaintData(b) {
  const d = {};
  for (const k of ['serial_number', 'invoice_number', 'invoice_date', 'installation_date', 'warranty_status', 'category', 'severity', 'description', 'status',
    'site_visit_date', 'site_visit_notes', 'root_cause', 'resolution_type', 'resolution_notes', 'feedback_comment']) {
    if (b[k] !== undefined) d[k] = strOrNull(b[k]);
  }
  for (const k of ['customer_id', 'contact_id', 'order_id', 'product_id', 'assigned_to', 'feedback_rating']) if (b[k] !== undefined) d[k] = intOrNull(b[k]);
  if (d.feedback_rating && (d.feedback_rating < 1 || d.feedback_rating > 5)) throw badRequest('Rating must be between 1 and 5');
  return d;
}

/** Warranty from product warranty months counted from installation (or invoice) date. */
function inferWarranty(d) {
  if (d.warranty_status || !d.product_id) return d.warranty_status;
  const start = d.installation_date || d.invoice_date;
  if (!start) return 'in_warranty';
  const months = get('SELECT warranty_months FROM products WHERE id = ?', d.product_id)?.warranty_months || 12;
  return addDays(start, Math.round(months * 30.4)) >= today() ? 'in_warranty' : 'out_of_warranty';
}

r.post('/complaints', allow('complaints.edit'), (req, res) => {
  const d = complaintData(req.body);
  if (!d.customer_id) throw badRequest('Select the customer');
  if (!d.description) throw badRequest('Describe the issue');
  assertCustomer(req.user, d.customer_id);
  if (d.order_id && !d.invoice_number) {
    const inv = get('SELECT number, invoice_date FROM invoices WHERE order_id = ? ORDER BY invoice_date DESC LIMIT 1', d.order_id);
    if (inv) {
      d.invoice_number = inv.number;
      d.invoice_date ||= inv.invoice_date;
    }
  }
  d.warranty_status = inferWarranty(d);
  const id = tx(() => {
    const cid = insert('complaints', { ...d, number: nextNumber('CMP'), status: d.assigned_to ? 'assigned' : 'open', created_by: req.user.id, created_at: nowIso(), updated_at: nowIso() });
    for (const aid of req.body.attachment_ids || []) run("UPDATE attachments SET entity = 'complaint', entity_id = ? WHERE id = ? AND entity = 'pending'", cid, aid);
    const number = get('SELECT number FROM complaints WHERE id = ?', cid).number;
    const customer = get('SELECT name, assigned_to FROM customers WHERE id = ?', d.customer_id);
    if (d.assigned_to) notify(d.assigned_to, { type: 'complaint_assigned', title: `Complaint assigned: ${number}`, message: customer.name, link: `/complaints/${cid}`, severity: d.severity === 'critical' ? 'danger' : 'warning', dedupeKey: `complaint:${cid}:${d.assigned_to}` });
    else notify({ roles: ['service'] }, { type: 'complaint_new', title: `New complaint ${number}`, message: customer.name, link: `/complaints/${cid}`, severity: 'warning', dedupeKey: `complaint_new:${cid}` });
    notify(customer.assigned_to, { type: 'complaint_new', title: `Your customer raised a complaint: ${number}`, message: customer.name, link: `/complaints/${cid}`, dedupeKey: `complaint_sales:${cid}` });
    if (d.product_id) {
      const recent = get("SELECT COUNT(*) AS n FROM complaints WHERE product_id = ? AND created_at >= ?", d.product_id, addDays(today(), -90)).n;
      if (recent >= 3) {
        const product = get('SELECT name FROM products WHERE id = ?', d.product_id);
        notify({ roles: ['quality', 'management'] }, {
          type: 'repeat_complaint', title: `Repeated complaints: ${product.name}`, message: `${recent} complaints in the last 90 days`,
          link: '/complaints?tab=insights', severity: 'danger', dedupeKey: `repeat_product:${d.product_id}:${today().slice(0, 7)}`,
        });
      }
    }
    return cid;
  });
  res.status(201).json({ id });
});

r.get('/complaints/:id', allow('complaints.view'), (req, res) => {
  const scope = complaintScope(req.user, 'k');
  const k = get(`${SELECT} WHERE k.id = ? ${scope ? `AND ${scope}` : ''}`, req.params.id);
  if (!k) throw notFound('Complaint');
  k.attachments = all("SELECT id, kind, original_name, mime, size, created_at FROM attachments WHERE entity = 'complaint' AND entity_id = ? ORDER BY created_at", k.id);
  k.activities = all('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.complaint_id = ? ORDER BY a.activity_date DESC', k.id);
  k.history = all("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'complaint' AND a.entity_id = ? ORDER BY a.created_at DESC", k.id)
    .map((h) => ({ ...h, details: JSON.parse(h.details || '{}') }));
  k.same_product = k.product_id ? all('SELECT k2.id, k2.number, k2.category, k2.status, k2.created_at, c.name AS customer_name FROM complaints k2 JOIN customers c ON c.id = k2.customer_id WHERE k2.product_id = ? AND k2.id <> ? ORDER BY k2.created_at DESC LIMIT 10', k.product_id, k.id) : [];
  k.contacts = all('SELECT id, name, phone FROM contacts WHERE customer_id = ?', k.customer_id);
  k.orders = all('SELECT id, number, order_date FROM sales_orders WHERE customer_id = ? ORDER BY order_date DESC', k.customer_id);
  res.json(redact(req.user, k));
});

r.put('/complaints/:id', allow('complaints.edit'), (req, res) => {
  const k = get('SELECT * FROM complaints WHERE id = ?', req.params.id);
  if (!k) throw notFound('Complaint');
  const d = complaintData(req.body);
  delete d.customer_id;
  const to = d.status || k.status;
  if (['resolved', 'closed'].includes(to) && !['resolved', 'closed'].includes(k.status)) {
    if (!(d.root_cause ?? k.root_cause) || !(d.resolution_type ?? k.resolution_type)) throw badRequest('Record the root cause and resolution before resolving');
    d.resolved_at = k.resolved_at || nowIso();
  }
  if (to === 'closed' && !k.closed_at) d.closed_at = nowIso();
  if (d.assigned_to && d.assigned_to !== k.assigned_to && to === 'open') d.status = 'assigned';
  if (d.site_visit_date && !k.site_visit_date && ['open', 'assigned'].includes(to)) d.status = 'site_visit';
  tx(() => {
    update('complaints', k.id, { ...d, updated_at: nowIso() });
    for (const aid of req.body.attachment_ids || []) run("UPDATE attachments SET entity = 'complaint', entity_id = ? WHERE id = ? AND entity = 'pending'", k.id, aid);
    const changed = Object.fromEntries(Object.entries(d).filter(([key, v]) => v !== k[key] && !['resolved_at', 'closed_at'].includes(key)));
    if (Object.keys(changed).length) audit(req.user.id, 'complaint', k.id, 'update', changed);
    if (d.assigned_to && d.assigned_to !== k.assigned_to) {
      notify(d.assigned_to, { type: 'complaint_assigned', title: `Complaint assigned: ${k.number}`, link: `/complaints/${k.id}`, severity: 'warning', dedupeKey: `complaint:${k.id}:${d.assigned_to}` });
    }
    if (d.resolved_at && !k.resolved_at) {
      const c = get('SELECT assigned_to, name FROM customers WHERE id = ?', k.customer_id);
      notify(c.assigned_to, { type: 'complaint_resolved', title: `Complaint ${k.number} resolved`, message: `${c.name} · collect customer feedback`, link: `/complaints/${k.id}`, severity: 'success', dedupeKey: `complaint_resolved:${k.id}` });
    }
  });
  res.json({ ok: true });
});

export default r;
