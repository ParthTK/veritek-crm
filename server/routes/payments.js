import { Router } from 'express';
import { all, get } from '../db.js';
import { allow } from '../auth.js';
import { can } from '../../shared/constants.js';
import { today, addDays, whereClause, notFound } from '../util.js';
import { customerScope, assertCustomer, assertOrder, redact } from '../access.js';
import { createInvoice, recordPayment, createCreditNote, ageingBucket } from '../services/orders.js';

const r = Router();

/** Receivables overview: totals, ageing buckets and customer-wise outstanding. */
r.get('/payments/overview', allow('payments.view'), (req, res) => {
  const t = today();
  const cs = customerScope(req.user, 'c');
  const invoices = all(
    `SELECT i.*, c.name AS customer_name, c.code AS customer_code, c.assigned_to, c.credit_limit, c.payment_terms_days, u.name AS owner_name, o.number AS order_number
     FROM invoice_balances i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = c.assigned_to LEFT JOIN sales_orders o ON o.id = i.order_id
     WHERE i.balance > 1 ${cs ? `AND ${cs}` : ''}`,
  );
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const byCustomer = new Map();
  let overdue = 0;
  for (const i of invoices) {
    const b = ageingBucket(i.invoice_date);
    buckets[b] += i.balance;
    if (i.due_date < t) overdue += i.balance;
    const row = byCustomer.get(i.customer_id) || {
      customer_id: i.customer_id, customer_name: i.customer_name, customer_code: i.customer_code, owner_name: i.owner_name, credit_limit: i.credit_limit,
      invoices: 0, balance: 0, overdue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, oldest_due: i.due_date,
    };
    row.invoices++;
    row.balance += i.balance;
    row[b] += i.balance;
    if (i.due_date < t) row.overdue += i.balance;
    if (i.due_date < row.oldest_due) row.oldest_due = i.due_date;
    byCustomer.set(i.customer_id, row);
  }
  const scopeAnd = cs ? `AND p.customer_id IN (SELECT c.id FROM customers c WHERE ${cs})` : '';
  const monthStart = `${t.slice(0, 8)}01`;
  const collected = get(`SELECT COALESCE(SUM(amount), 0) AS month FROM payments p WHERE payment_date >= ? ${scopeAnd}`, monthStart).month;
  const advances = all(
    `SELECT o.id, o.number, o.advance_required, c.name AS customer_name, o.stage,
            (SELECT COALESCE(SUM(amount + tds_amount + other_deduction), 0) FROM payments WHERE order_id = o.id AND type = 'advance') AS advance_received
     FROM sales_orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'active' AND o.advance_required > 0 ${cs ? `AND ${cs}` : ''}`,
  ).filter((o) => o.advance_received < o.advance_required - 1);
  const dueSoon = invoices.filter((i) => i.due_date >= t && i.due_date <= addDays(t, 7));
  const trend = all(
    `SELECT substr(payment_date, 1, 7) AS month, COALESCE(SUM(amount), 0) AS received FROM payments p
     WHERE payment_date >= ? ${scopeAnd} GROUP BY 1 ORDER BY 1`,
    addDays(monthStart, -330),
  );
  res.json(redact(req.user, {
    outstanding: invoices.reduce((s, i) => s + i.balance, 0),
    overdue,
    collected_this_month: collected,
    due_this_week: dueSoon.reduce((s, i) => s + i.balance, 0),
    buckets,
    customers: [...byCustomer.values()].sort((a, b) => b.balance - a.balance),
    advances_pending: advances,
    trend,
  }));
});

r.get('/invoices', allow('payments.view'), (req, res) => {
  const q = req.query;
  const t = today();
  const w = [customerScope(req.user, 'c')];
  const p = [];
  if (q.customer_id) {
    w.push('i.customer_id = ?');
    p.push(q.customer_id);
  }
  if (q.order_id) {
    w.push('i.order_id = ?');
    p.push(q.order_id);
  }
  if (q.status === 'outstanding') w.push('i.balance > 1');
  if (q.status === 'overdue') w.push(`i.balance > 1 AND i.due_date < '${t}'`);
  if (q.status === 'paid') w.push('i.balance <= 1');
  if (q.q) {
    w.push('(i.number LIKE ? OR c.name LIKE ? OR o.number LIKE ?)');
    p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const rows = all(
    `SELECT i.*, c.name AS customer_name, o.number AS order_number, CAST(julianday('${t}') - julianday(i.due_date) AS INTEGER) AS days_overdue,
            CAST(julianday('${t}') - julianday(i.invoice_date) AS INTEGER) AS age_days,
            (SELECT MAX(activity_date) FROM activities a WHERE a.customer_id = i.customer_id AND a.type IN ('call','email','whatsapp') AND a.activity_date >= i.due_date) AS last_collection_contact
     FROM invoice_balances i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders o ON o.id = i.order_id
     ${whereClause(w)} ORDER BY i.balance > 1 DESC, i.due_date ASC LIMIT 500`,
    ...p,
  );
  res.json(redact(req.user, rows.map((i) => ({ ...i, bucket: ageingBucket(i.invoice_date) }))));
});

r.post('/invoices', allow('payments.edit'), (req, res) => {
  if (req.body.order_id) assertOrder(req.user, req.body.order_id);
  res.status(201).json({ id: createInvoice(req.body, req.user) });
});

r.get('/payments', allow('payments.view'), (req, res) => {
  const q = req.query;
  const w = [customerScope(req.user, 'c')];
  const p = [];
  for (const k of ['customer_id', 'order_id', 'invoice_id', 'type']) {
    if (q[k]) {
      w.push(`p.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.from) {
    w.push('p.payment_date >= ?');
    p.push(q.from);
  }
  if (q.to) {
    w.push('p.payment_date <= ?');
    p.push(q.to);
  }
  const rows = all(
    `SELECT p.*, c.name AS customer_name, i.number AS invoice_number, o.number AS order_number, u.name AS recorded_by_name
     FROM payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN invoices i ON i.id = p.invoice_id
     LEFT JOIN sales_orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.recorded_by
     ${whereClause(w)} ORDER BY p.payment_date DESC, p.id DESC LIMIT 500`,
    ...p,
  );
  res.json(redact(req.user, rows));
});

r.post('/payments', allow('payments.edit'), (req, res) => {
  if (req.body.order_id) assertOrder(req.user, req.body.order_id);
  if (req.body.customer_id) assertCustomer(req.user, req.body.customer_id);
  if (req.body.invoice_id && !get('SELECT id FROM invoices WHERE id = ?', req.body.invoice_id)) throw notFound('Invoice');
  res.status(201).json({ id: recordPayment(req.body, req.user) });
});

r.get('/credit-notes', allow('finance.full'), (req, res) => {
  const cs = customerScope(req.user, 'c');
  res.json(all(
    `SELECT cn.*, c.name AS customer_name, i.number AS invoice_number, u.name AS created_by_name
     FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id LEFT JOIN invoices i ON i.id = cn.invoice_id LEFT JOIN users u ON u.id = cn.created_by
     ${cs ? `WHERE ${cs}` : ''} ORDER BY cn.note_date DESC LIMIT 500`,
  ));
});

r.post('/credit-notes', allow('payments.edit'), (req, res) => {
  if (!can(req.user.role, 'finance.full')) throw notFound('Route');
  res.status(201).json({ id: createCreditNote(req.body, req.user) });
});

export default r;
