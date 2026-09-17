import { Router } from 'express';
import { all, get, run, insert, update, tx, getSetting } from '../db.js';
import { allow } from '../auth.js';
import { can, DEFAULT_SETTINGS, CUSTOMER_STATUSES } from '../../shared/constants.js';
import { today, addDays, nowIso, paginate, sortClause, whereClause, badRequest, forbidden, notFound, strOrNull, intOrNull, num, nextNumber, audit } from '../util.js';
import { customerScope, assertCustomer, redact } from '../access.js';
import { setTags, tagsFor } from '../services/leads.js';
import { buildTimeline } from '../services/timeline.js';
import { ORDER_ROLLUP, decorateOrder } from '../services/orders.js';

const r = Router();

const dormantCutoff = () => addDays(today(), -({ ...DEFAULT_SETTINGS.customers, ...getSetting('customers', {}) }).dormantAfterDays);

function customerFilters(req) {
  const q = req.query;
  const w = [customerScope(req.user, 'c')];
  const p = [];
  const eq = (col, v) => {
    if (v !== undefined && v !== '') {
      w.push(`${col} = ?`);
      p.push(v);
    }
  };
  if (q.q) {
    w.push('(c.name LIKE ? OR c.code LIKE ? OR c.gstin LIKE ? OR c.city LIKE ? OR c.id IN (SELECT customer_id FROM contacts WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?))');
    p.push(...Array(7).fill(`%${q.q}%`));
  }
  eq('c.customer_type', q.customer_type);
  eq('c.industry', q.industry);
  eq('c.value_category', q.value_category);
  eq('c.region_id', q.region_id);
  eq('c.state', q.state);
  eq('c.city', q.city);
  eq('c.source', q.source);
  eq('c.assigned_to', q.assigned_to);
  if (q.status === 'dormant') {
    w.push("c.status = 'active' AND COALESCE((SELECT MAX(order_date) FROM sales_orders so WHERE so.customer_id = c.id AND so.status <> 'cancelled'), '0000') < ?");
    p.push(dormantCutoff());
  } else eq('c.status', q.status);
  if (q.campaign_id) {
    w.push('(c.campaign_id = ? OR c.id IN (SELECT customer_id FROM leads WHERE campaign_id = ?))');
    p.push(q.campaign_id, q.campaign_id);
  }
  if (q.category_id) {
    w.push('(c.id IN (SELECT customer_id FROM customer_interests WHERE category_id = ?) OR c.id IN (SELECT customer_id FROM leads WHERE category_id = ?))');
    p.push(q.category_id, q.category_id);
  }
  if (q.tag) {
    w.push("c.id IN (SELECT tg.entity_id FROM taggings tg JOIN tags t ON t.id = tg.tag_id WHERE tg.entity = 'customer' AND t.name = ?)");
    p.push(q.tag);
  }
  if (q.outstanding === '1') w.push('c.id IN (SELECT customer_id FROM invoice_balances WHERE balance > 1)');
  return { where: whereClause(w), params: p };
}

const CUSTOMER_SELECT = `
  SELECT c.*, u.name AS owner_name, r.name AS region_name, cp.name AS campaign_name,
    (SELECT COUNT(*) FROM leads WHERE customer_id = c.id AND status = 'open') AS open_leads,
    (SELECT COUNT(*) FROM sales_orders WHERE customer_id = c.id AND status <> 'cancelled') AS order_count,
    (SELECT COALESCE(SUM(grand_total), 0) FROM sales_orders WHERE customer_id = c.id AND status <> 'cancelled') AS lifetime_value,
    (SELECT MAX(order_date) FROM sales_orders WHERE customer_id = c.id AND status <> 'cancelled') AS last_order_date,
    (SELECT COALESCE(SUM(balance), 0) FROM invoice_balances WHERE customer_id = c.id AND balance > 1) AS outstanding,
    (SELECT MAX(activity_date) FROM activities WHERE customer_id = c.id) AS last_activity,
    (SELECT name FROM contacts WHERE customer_id = c.id ORDER BY is_primary DESC, id LIMIT 1) AS primary_contact,
    (SELECT phone FROM contacts WHERE customer_id = c.id ORDER BY is_primary DESC, id LIMIT 1) AS primary_phone
  FROM customers c
  LEFT JOIN users u ON u.id = c.assigned_to
  LEFT JOIN regions r ON r.id = c.region_id
  LEFT JOIN campaigns cp ON cp.id = c.campaign_id`;

function interestsFor(ids) {
  if (!ids.length) return {};
  const map = {};
  for (const row of all(
    `SELECT ci.customer_id, pc.id, pc.name FROM customer_interests ci JOIN product_categories pc ON pc.id = ci.category_id
     WHERE ci.customer_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )) (map[row.customer_id] ||= []).push({ id: row.id, name: row.name });
  return map;
}

r.get('/customers', allow('customers.view'), (req, res) => {
  const { where, params } = customerFilters(req);
  const { limit, offset } = paginate(req.query);
  const order = sortClause(req.query, {
    name: 'c.name', code: 'c.id', type: 'c.customer_type', city: 'c.city', status: 'c.status', owner: 'u.name',
    value: 'lifetime_value', outstanding: 'outstanding', last_order: 'last_order_date', last_activity: 'last_activity', created: 'c.created_at',
  }, 'c.name ASC');
  const rows = all(`${CUSTOMER_SELECT} ${where} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const count = get(`SELECT COUNT(*) AS n FROM customers c ${where}`, ...params).n;
  const ids = rows.map((x) => x.id);
  const tags = tagsFor('customer', ids);
  const interests = interestsFor(ids);
  const cutoff = dormantCutoff();
  res.json(redact(req.user, {
    rows: rows.map((x) => ({
      ...x, tags: tags[x.id] || [], interests: interests[x.id] || [],
      dormant: x.status === 'active' && (!x.last_order_date || x.last_order_date < cutoff),
    })),
    count,
  }));
});

/** Counts by each segmentation dimension for the current scope (drives the segment filter panel). */
r.get('/customers/segments', allow('customers.view'), (req, res) => {
  const scope = customerScope(req.user, 'c');
  const w = scope ? `WHERE ${scope}` : '';
  const group = (col, join = '') => all(`SELECT ${col} AS key, COUNT(*) AS count FROM customers c ${join} ${w} GROUP BY 1 ORDER BY 2 DESC`);
  const cutoff = dormantCutoff();
  res.json({
    customer_type: group('c.customer_type'),
    industry: group('c.industry'),
    status: [
      ...group('c.status'),
      { key: 'dormant', count: get(`SELECT COUNT(*) AS n FROM customers c WHERE c.status = 'active' AND COALESCE((SELECT MAX(order_date) FROM sales_orders so WHERE so.customer_id = c.id AND so.status <> 'cancelled'), '0000') < ? ${scope ? `AND ${scope}` : ''}`, cutoff).n },
    ],
    value_category: group('c.value_category'),
    region_id: group('c.region_id'),
    state: group('c.state'),
    source: group('c.source'),
    campaign_id: all(`SELECT cp.id AS key, COUNT(DISTINCT c.id) AS count FROM campaigns cp JOIN customers c ON c.campaign_id = cp.id OR c.id IN (SELECT customer_id FROM leads WHERE campaign_id = cp.id) ${w} GROUP BY cp.id ORDER BY 2 DESC`),
    category_id: all(`SELECT ci.category_id AS key, COUNT(*) AS count FROM customer_interests ci JOIN customers c ON c.id = ci.customer_id ${w} GROUP BY 1 ORDER BY 2 DESC`),
    tag: all(`SELECT t.name AS key, COUNT(*) AS count FROM taggings tg JOIN tags t ON t.id = tg.tag_id JOIN customers c ON c.id = tg.entity_id AND tg.entity = 'customer' ${w} GROUP BY 1 ORDER BY 2 DESC`),
  });
});

function normalizeCustomer(body) {
  const out = {};
  for (const k of ['name', 'customer_type', 'industry', 'gstin', 'website', 'billing_address', 'shipping_address', 'city', 'state', 'country', 'pincode', 'payment_terms', 'status', 'value_category', 'source', 'notes']) {
    if (body[k] !== undefined) out[k] = strOrNull(body[k]);
  }
  for (const k of ['region_id', 'assigned_to', 'campaign_id']) if (body[k] !== undefined) out[k] = intOrNull(body[k]);
  if (body.credit_limit !== undefined) out.credit_limit = num(body.credit_limit);
  if (body.payment_terms_days !== undefined) out.payment_terms_days = Math.max(0, num(body.payment_terms_days, 30));
  if (out.gstin) {
    out.gstin = out.gstin.toUpperCase();
    if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(out.gstin)) throw badRequest('GST number should be 15 characters, e.g. 27AAHCV4521K1ZQ');
  }
  if (out.status && !CUSTOMER_STATUSES.some((s) => s.value === out.status)) throw badRequest('Unknown customer status');
  return out;
}

r.post('/customers', allow('customers.edit'), (req, res) => {
  const data = normalizeCustomer(req.body);
  if (!data.name) throw badRequest('Company name is required');
  if (!can(req.user.role, 'finance.full')) delete data.credit_limit;
  if (req.user.role === 'sales_executive') data.assigned_to = req.user.id;
  const dupe = get('SELECT id, name FROM customers WHERE lower(name) = lower(?) OR (gstin IS NOT NULL AND gstin = ?)', data.name, data.gstin ?? '');
  if (dupe && !req.body.allow_duplicate) throw badRequest(`${dupe.name} already exists`, { duplicate_id: dupe.id });
  const id = tx(() => {
    const cid = insert('customers', { ...data, code: nextNumber('CU'), status: data.status || 'prospect', created_by: req.user.id, created_at: nowIso(), updated_at: nowIso() });
    for (const c of req.body.contacts || []) {
      if (!strOrNull(c.name)) continue;
      insert('contacts', { ...contactData(c), customer_id: cid, created_at: nowIso() });
    }
    if (Array.isArray(req.body.interests)) setInterests(cid, req.body.interests);
    if (req.body.tags) setTags('customer', cid, req.body.tags);
    audit(req.user.id, 'customer', cid, 'create', { name: data.name });
    return cid;
  });
  res.status(201).json({ id });
});

function setInterests(customerId, ids) {
  run('DELETE FROM customer_interests WHERE customer_id = ?', customerId);
  for (const cid of ids.map(Number).filter(Boolean)) run('INSERT OR IGNORE INTO customer_interests (customer_id, category_id) VALUES (?, ?)', customerId, cid);
}

r.get('/customers/:id', allow('customers.view'), (req, res) => {
  assertCustomer(req.user, req.params.id);
  const id = Number(req.params.id);
  const c = get(`${CUSTOMER_SELECT} WHERE c.id = ?`, id);
  c.tags = tagsFor('customer', [id])[id] || [];
  c.interests = interestsFor([id])[id] || [];
  c.dormant = c.status === 'active' && (!c.last_order_date || c.last_order_date < dormantCutoff());
  const contacts = all('SELECT * FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, name', id);
  const u = req.user;
  const leads = can(u.role, 'leads.view')
    ? all(`SELECT l.id, l.code, l.title, l.stage, l.status, l.temperature, l.estimated_value, l.probability, l.next_follow_up_date, l.next_action, l.created_at, u.name AS owner_name
           FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.customer_id = ? ORDER BY l.status = 'open' DESC, l.created_at DESC`, id)
    : [];
  const quotations = can(u.role, 'quotations.view')
    ? all(`SELECT q.id, q.number, q.subject, q.status, q.current_version, q.sent_at, q.valid_until, q.created_at, v.grand_total, v.discount_pct
           FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version WHERE q.customer_id = ? ORDER BY q.created_at DESC`, id)
    : [];
  const orders = all(`SELECT o.*, ${ORDER_ROLLUP} FROM sales_orders o WHERE o.customer_id = ? ORDER BY o.order_date DESC`, id).map(decorateOrder);
  const finance = can(u.role, 'payments.view');
  const invoices = finance ? all('SELECT i.*, o.number AS order_number FROM invoice_balances i LEFT JOIN sales_orders o ON o.id = i.order_id WHERE i.customer_id = ? ORDER BY i.invoice_date DESC', id) : [];
  const payments = finance ? all('SELECT p.*, i.number AS invoice_number, o.number AS order_number FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN sales_orders o ON o.id = p.order_id WHERE p.customer_id = ? ORDER BY p.payment_date DESC', id) : [];
  const complaints = all(`SELECT k.id, k.number, k.category, k.severity, k.status, k.created_at, k.resolved_at, p.name AS product_name
    FROM complaints k LEFT JOIN products p ON p.id = k.product_id WHERE k.customer_id = ? ORDER BY k.created_at DESC`, id);
  const followups = all(`SELECT f.*, u.name AS owner_name FROM followups f LEFT JOIN users u ON u.id = f.assigned_to
    WHERE f.customer_id = ? AND f.status = 'pending' ORDER BY f.due_date`, id);
  const t = today();
  const stats = {
    lifetime_value: c.lifetime_value,
    order_count: c.order_count,
    open_pipeline: leads.filter((l) => l.status === 'open').reduce((s, l) => s + l.estimated_value, 0),
    outstanding: c.outstanding,
    overdue: invoices.filter((i) => i.balance > 1 && i.due_date < t).reduce((s, i) => s + i.balance, 0),
    credit_available: c.credit_limit ? c.credit_limit - c.outstanding : null,
    open_complaints: complaints.filter((k) => !['resolved', 'closed'].includes(k.status)).length,
    avg_payment_days: finance ? get(`SELECT AVG(julianday(p.payment_date) - julianday(i.invoice_date)) AS d FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = ?`, id).d : null,
    won_leads: leads.filter((l) => l.status === 'won').length,
    lost_leads: leads.filter((l) => l.status === 'lost').length,
  };
  res.json(redact(u, { ...c, contacts, leads, quotations, orders, invoices, payments, complaints, followups, stats }));
});

r.put('/customers/:id', allow('customers.edit'), (req, res) => {
  assertCustomer(req.user, req.params.id);
  const data = normalizeCustomer(req.body);
  if (data.name === null) throw badRequest('Company name is required');
  if (!can(req.user.role, 'finance.full')) {
    delete data.credit_limit;
    delete data.payment_terms_days;
    if (data.status === 'blocked') throw forbidden('Only accounts or management can block a customer');
  }
  if (req.user.role === 'sales_executive') delete data.assigned_to;
  tx(() => {
    update('customers', req.params.id, { ...data, updated_at: nowIso() });
    if (Array.isArray(req.body.interests)) setInterests(Number(req.params.id), req.body.interests);
    if (req.body.tags !== undefined) setTags('customer', Number(req.params.id), req.body.tags);
    audit(req.user.id, 'customer', Number(req.params.id), 'update', data);
  });
  res.json({ ok: true });
});

r.get('/customers/:id/timeline', allow('customers.view'), (req, res) => {
  assertCustomer(req.user, req.params.id);
  let items = buildTimeline({ customerId: Number(req.params.id) });
  if (!can(req.user.role, 'leads.view')) items = items.filter((i) => !['lead', 'quotation'].includes(i.kind));
  if (!can(req.user.role, 'payments.view')) items = items.filter((i) => i.kind !== 'payment');
  res.json(redact(req.user, items));
});

// ------------------------------------------------------------------ contacts
function contactData(b) {
  return {
    name: strOrNull(b.name), contact_role: b.contact_role || 'other', designation: strOrNull(b.designation), phone: strOrNull(b.phone),
    whatsapp: strOrNull(b.whatsapp), email: strOrNull(b.email), preferred_channel: b.preferred_channel || 'phone',
    is_primary: b.is_primary ? 1 : 0, notes: strOrNull(b.notes),
  };
}

r.get('/contacts', allow('customers.view'), (req, res) => {
  const q = req.query;
  const w = [customerScope(req.user, 'c')];
  const p = [];
  if (q.q) {
    w.push('(ct.name LIKE ? OR ct.phone LIKE ? OR ct.email LIKE ? OR c.name LIKE ? OR ct.designation LIKE ?)');
    p.push(...Array(5).fill(`%${q.q}%`));
  }
  if (q.contact_role) {
    w.push('ct.contact_role = ?');
    p.push(q.contact_role);
  }
  if (q.customer_type) {
    w.push('c.customer_type = ?');
    p.push(q.customer_type);
  }
  if (q.region_id) {
    w.push('c.region_id = ?');
    p.push(q.region_id);
  }
  const where = whereClause(w);
  const { limit, offset } = paginate(q);
  const rows = all(
    `SELECT ct.*, c.name AS customer_name, c.city, c.customer_type, c.status AS customer_status, u.name AS owner_name,
            (SELECT MAX(activity_date) FROM activities a WHERE a.contact_id = ct.id) AS last_contacted
     FROM contacts ct JOIN customers c ON c.id = ct.customer_id LEFT JOIN users u ON u.id = c.assigned_to
     ${where} ORDER BY ${q.sort === 'last_contacted' ? 'last_contacted DESC NULLS LAST' : 'ct.name'} LIMIT ? OFFSET ?`,
    ...p, limit, offset,
  );
  const count = get(`SELECT COUNT(*) AS n FROM contacts ct JOIN customers c ON c.id = ct.customer_id ${where}`, ...p).n;
  res.json({ rows, count });
});

r.post('/customers/:id/contacts', allow('customers.edit', 'activities.edit'), (req, res) => {
  assertCustomer(req.user, req.params.id);
  const data = contactData(req.body);
  if (!data.name) throw badRequest('Contact name is required');
  if (!data.phone && !data.email && !data.whatsapp) throw badRequest('Add at least a phone, WhatsApp or email');
  const id = tx(() => {
    if (data.is_primary) run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', req.params.id);
    return insert('contacts', { ...data, customer_id: Number(req.params.id), created_at: nowIso() });
  });
  res.status(201).json({ id });
});

r.put('/contacts/:id', allow('customers.edit', 'activities.edit'), (req, res) => {
  const ct = get('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!ct) throw notFound('Contact');
  assertCustomer(req.user, ct.customer_id);
  const data = contactData({ ...ct, ...req.body });
  tx(() => {
    if (data.is_primary) run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', ct.customer_id);
    update('contacts', ct.id, data);
  });
  res.json({ ok: true });
});

r.delete('/contacts/:id', allow('customers.edit'), (req, res) => {
  const ct = get('SELECT * FROM contacts WHERE id = ?', req.params.id);
  if (!ct) throw notFound('Contact');
  assertCustomer(req.user, ct.customer_id);
  run('DELETE FROM contacts WHERE id = ?', ct.id);
  res.json({ ok: true });
});

export default r;
