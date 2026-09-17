import { Router } from 'express';
import { all, get } from '../db.js';
import { allow } from '../auth.js';
import { QUOTE_AWAITING, roleRank, can } from '../../shared/constants.js';
import { today, addDays, paginate, sortClause, whereClause, badRequest, intOrNull } from '../util.js';
import { quotationScope, assertQuotation, assertCustomer, assertOrder, redact } from '../access.js';
import {
  createQuotation, updateQuotation, submitQuotation, withdrawQuotation, decideApproval, sendQuotation,
  setQuotationStatus, loadQuotation, normalizeItems, computeQuote, priceListForCustomer,
} from '../services/quotes.js';
import { convertQuotationToOrder } from '../services/orders.js';

const r = Router();

r.get('/quotations', allow('quotations.view'), (req, res) => {
  const q = req.query;
  const t = today();
  const w = [quotationScope(req.user, 'q')];
  const p = [];
  if (q.q) {
    w.push('(q.number LIKE ? OR q.subject LIKE ? OR c.name LIKE ?)');
    p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.status === 'awaiting') w.push(`q.status IN (${QUOTE_AWAITING.map((s) => `'${s}'`).join(',')})`);
  else if (q.status === 'won') w.push("q.status IN ('accepted', 'converted')");
  else if (q.status) {
    w.push('q.status = ?');
    p.push(q.status);
  }
  for (const k of ['customer_id', 'owner_id', 'lead_id']) {
    if (q[k]) {
      w.push(`q.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.region_id) {
    w.push('c.region_id = ?');
    p.push(q.region_id);
  }
  if (q.expiring === '1') w.push(`q.status IN (${QUOTE_AWAITING.map((s) => `'${s}'`).join(',')}) AND q.valid_until BETWEEN '${t}' AND '${addDays(t, 7)}'`);
  if (q.needs_approval === '1') w.push('v.approval_role IS NOT NULL');
  if (q.from) {
    w.push('substr(q.created_at, 1, 10) >= ?');
    p.push(q.from);
  }
  if (q.to) {
    w.push('substr(q.created_at, 1, 10) <= ?');
    p.push(q.to);
  }
  const where = whereClause(w);
  const { limit, offset } = paginate(q);
  const order = sortClause(q, {
    number: 'q.id', customer: 'c.name', status: 'q.status', value: 'v.grand_total', discount: 'v.discount_pct', margin: 'v.margin_pct',
    sent: 'q.sent_at', valid: 'q.valid_until', owner: 'u.name', created: 'q.created_at',
  }, 'q.updated_at DESC');
  const from = `FROM quotations q JOIN customers c ON c.id = q.customer_id
    JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
    LEFT JOIN users u ON u.id = q.owner_id LEFT JOIN leads l ON l.id = q.lead_id`;
  const rows = all(
    `SELECT q.*, c.name AS customer_name, c.city, u.name AS owner_name, l.code AS lead_code,
            v.grand_total, v.taxable_total, v.discount_pct, v.margin_pct, v.approval_role
     ${from} ${where} ${order} LIMIT ? OFFSET ?`,
    ...p, limit, offset,
  );
  const count = get(`SELECT COUNT(*) AS n ${from} ${where}`, ...p).n;
  const summary = all(`SELECT q.status, COUNT(*) AS n, COALESCE(SUM(v.grand_total), 0) AS value ${from} ${whereClause([quotationScope(req.user, 'q')])} GROUP BY q.status`);
  res.json(redact(req.user, { rows, count, summary }));
});

/** Price, tax, margin and approval preview for the quotation builder without saving. */
r.post('/quotations/preview', allow('quotations.edit'), (req, res) => {
  const customer = req.body.customer_id ? get('SELECT * FROM customers WHERE id = ?', req.body.customer_id) : null;
  const priceList = req.body.price_list || priceListForCustomer(customer);
  if (!Array.isArray(req.body.items) || !req.body.items.length) return res.json({ lines: [], totals: null, approval_reasons: [] });
  const lines = normalizeItems(req.body.items, priceList);
  const calc = computeQuote(lines, req.body);
  res.json(redact(req.user, { ...calc, price_list: priceList }));
});

r.post('/quotations', allow('quotations.edit'), (req, res) => {
  assertCustomer(req.user, req.body.customer_id);
  res.status(201).json({ id: createQuotation(req.body, req.user) });
});

r.get('/quotations/:id', allow('quotations.view'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  const q = loadQuotation(Number(req.params.id));
  const pending = q.approvals.find((a) => a.status === 'pending');
  q.can_decide = Boolean(pending && can(req.user.role, 'approvals.decide') && roleRank(req.user.role) >= roleRank(pending.required_role)
    && (req.user.role !== 'regional_manager' || q.region_id === req.user.region_id));
  q.contacts = all('SELECT id, name, designation, email, phone FROM contacts WHERE customer_id = ?', q.customer_id);
  res.json(redact(req.user, q));
});

r.put('/quotations/:id', allow('quotations.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  res.json(updateQuotation(Number(req.params.id), req.body, req.user));
});

r.post('/quotations/:id/submit', allow('quotations.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  res.json({ status: submitQuotation(Number(req.params.id), req.user) });
});

r.post('/quotations/:id/withdraw', allow('quotations.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  withdrawQuotation(Number(req.params.id), req.user);
  res.json({ ok: true });
});

r.post('/quotations/:id/send', allow('quotations.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  sendQuotation(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

r.post('/quotations/:id/status', allow('quotations.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  setQuotationStatus(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

r.post('/quotations/:id/convert', allow('orders.edit'), (req, res) => {
  assertQuotation(req.user, req.params.id);
  const q = get('SELECT status FROM quotations WHERE id = ?', req.params.id);
  if (q.status !== 'accepted') setQuotationStatus(Number(req.params.id), { status: 'accepted', note: 'Purchase order received' }, req.user);
  res.status(201).json({ id: convertQuotationToOrder(Number(req.params.id), req.body, req.user) });
});

/** Start a new quotation from an existing quotation or a past order (repeat business). */
r.post('/quotations/duplicate', allow('quotations.edit'), (req, res) => {
  let items;
  let customerId;
  let header = {};
  let subject;
  if (req.body.order_id) {
    assertOrder(req.user, req.body.order_id);
    const o = get('SELECT * FROM sales_orders WHERE id = ?', req.body.order_id);
    customerId = o.customer_id;
    // Catalogue items are re-priced from today's price master; custom lines keep their last price.
    items = all('SELECT product_id, description, qty, discount_pct, config, unit, gst_rate, cost_price, sku, unit_price FROM order_items WHERE order_id = ?', o.id)
      .map((it) => ({ ...it, unit_price: it.product_id ? undefined : it.unit_price }));
    subject = `Repeat order (ref ${o.number})`;
  } else if (req.body.quotation_id) {
    assertQuotation(req.user, req.body.quotation_id);
    const src = loadQuotation(Number(req.body.quotation_id));
    customerId = intOrNull(req.body.customer_id) || src.customer_id;
    items = src.current.items.map((it) => ({ ...it, unit_price: it.product_id ? undefined : it.unit_price }));
    header = { payment_terms: src.current.payment_terms, delivery_terms: src.current.delivery_terms, warranty_terms: src.current.warranty_terms, freight: src.current.freight, installation: src.current.installation };
    subject = src.subject;
  } else throw badRequest('Nothing to copy');
  assertCustomer(req.user, customerId);
  const id = createQuotation({ ...header, customer_id: customerId, subject, items, lead_id: req.body.lead_id }, req.user);
  res.status(201).json({ id });
});

// ------------------------------------------------------------------ approvals
r.get('/approvals', allow('quotations.view'), (req, res) => {
  const status = req.query.status || 'pending';
  const scope = quotationScope(req.user, 'q');
  const rows = all(
    `SELECT a.*, q.id AS quotation_id, q.number, q.subject, q.status AS quotation_status, c.name AS customer_name, c.region_id, rg.name AS region_name,
            ru.name AS requested_by_name, du.name AS decided_by_name, v.version_no, v.grand_total, v.taxable_total, v.discount_pct, v.max_line_discount_pct,
            v.margin_pct, v.below_min_price
     FROM approvals a JOIN quotations q ON q.id = a.entity_id AND a.entity = 'quotation' JOIN customers c ON c.id = q.customer_id
     LEFT JOIN regions rg ON rg.id = c.region_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
     LEFT JOIN quotation_versions v ON v.id = a.version_id
     WHERE ${status === 'all' ? '1 = 1' : 'a.status = ?'} ${scope ? `AND ${scope}` : ''}
     ORDER BY a.requested_at DESC LIMIT 200`,
    ...(status === 'all' ? [] : [status]),
  ).map((a) => ({
    ...a,
    reasons: JSON.parse(a.reasons || '[]'),
    can_decide: a.status === 'pending' && can(req.user.role, 'approvals.decide') && roleRank(req.user.role) >= roleRank(a.required_role)
      && (req.user.role !== 'regional_manager' || a.region_id === req.user.region_id),
  }));
  res.json(redact(req.user, rows));
});

r.post('/approvals/:id/decide', allow('approvals.decide'), (req, res) => {
  decideApproval(Number(req.params.id), req.body.decision, req.body.comments, req.user);
  res.json({ ok: true });
});

export default r;
