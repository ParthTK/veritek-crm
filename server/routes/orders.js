import { Router } from 'express';
import { all, get } from '../db.js';
import { allow } from '../auth.js';
import { can, ORDER_STAGES, stageIndex } from '../../shared/constants.js';
import { today, addDays, paginate, whereClause, notFound, parseJson } from '../util.js';
import { orderScope, assertOrder, redact } from '../access.js';
import { ORDER_ROLLUP, decorateOrder, changeOrderStage, updateOrder, updateProduction, createDispatch, updateDispatch } from '../services/orders.js';
import { buildTimeline } from '../services/timeline.js';

const r = Router();

const ORDER_FROM = `FROM sales_orders o JOIN customers c ON c.id = o.customer_id
  LEFT JOIN users su ON su.id = o.sales_owner_id LEFT JOIN factories f ON f.id = o.factory_id
  LEFT JOIN production p ON p.order_id = o.id LEFT JOIN regions rg ON rg.id = c.region_id`;
const ORDER_COLS = `o.*, c.name AS customer_name, c.city, c.region_id, rg.name AS region_name, su.name AS sales_owner_name, f.name AS factory_name,
  p.planned_start, p.planned_completion, p.actual_start, p.actual_completion, p.revised_completion, p.material_status, p.material_constraint,
  p.qc_status, p.qc_remarks, p.updated_at AS production_updated_at, ${ORDER_ROLLUP}`;

function orderQuery(req, extra = []) {
  const q = req.query;
  const w = [orderScope(req.user, 'o'), ...extra];
  const p = [];
  if (q.q) {
    w.push('(o.number LIKE ? OR o.customer_po_number LIKE ? OR c.name LIKE ?)');
    p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.stage) {
    w.push('o.stage = ?');
    p.push(q.stage);
  }
  if (q.status) {
    w.push('o.status = ?');
    p.push(q.status);
  } else if (!q.include_closed) w.push("o.status IN ('active', 'on_hold')");
  for (const k of ['customer_id', 'factory_id', 'priority', 'sales_owner_id']) {
    if (q[k]) {
      w.push(`o.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.region_id) {
    w.push('c.region_id = ?');
    p.push(q.region_id);
  }
  if (q.group === 'commercial') w.push("o.stage IN ('po_received', 'commercial_verification', 'advance_pending')");
  if (q.group === 'production') w.push("o.stage IN ('order_confirmed', 'material_check', 'production_scheduled', 'under_production', 'quality_check', 'packing')");
  if (q.group === 'dispatch') w.push("o.stage IN ('packing', 'ready_for_dispatch', 'dispatched')");
  if (q.from) {
    w.push('o.order_date >= ?');
    p.push(q.from);
  }
  if (q.to) {
    w.push('o.order_date <= ?');
    p.push(q.to);
  }
  return { where: whereClause(w), params: p };
}

r.get('/orders', allow('orders.view'), (req, res) => {
  const { where, params } = orderQuery(req);
  let rows = all(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${where} ORDER BY o.order_date DESC, o.id DESC`, ...params).map(decorateOrder);
  const q = req.query;
  if (q.delayed === '1') rows = rows.filter((o) => o.is_delayed);
  if (q.payment_status) rows = rows.filter((o) => o.payment_status === q.payment_status);
  if (q.dispatch_status) rows = rows.filter((o) => o.dispatch_status === q.dispatch_status);
  const stageCounts = ORDER_STAGES.map((s) => ({ stage: s.value, count: rows.filter((o) => o.stage === s.value).length }));
  const totals = { count: rows.length, value: rows.reduce((s, o) => s + o.grand_total, 0), delayed: rows.filter((o) => o.is_delayed).length, outstanding: rows.reduce((s, o) => s + o.outstanding, 0) };
  const { limit, offset } = paginate(q);
  res.json(redact(req.user, { rows: rows.slice(offset, offset + limit), count: rows.length, stage_counts: stageCounts, totals }));
});

r.get('/orders/:id', allow('orders.view'), (req, res) => {
  assertOrder(req.user, req.params.id);
  const id = Number(req.params.id);
  const o = decorateOrder(get(`SELECT ${ORDER_COLS}, q.number AS quotation_number, v.version_no AS quotation_version, l.code AS lead_code,
      ct.name AS contact_name, ct.phone AS contact_phone, ct.email AS contact_email,
      cu.name AS commercial_owner_name, pu.name AS production_owner_name, du.name AS dispatch_owner_name, au.name AS accounts_owner_name,
      c.gstin AS customer_gstin, c.payment_terms_days
    ${ORDER_FROM}
    LEFT JOIN quotations q ON q.id = o.quotation_id LEFT JOIN quotation_versions v ON v.id = o.quotation_version_id LEFT JOIN leads l ON l.id = o.lead_id
    LEFT JOIN contacts ct ON ct.id = o.contact_id LEFT JOIN users cu ON cu.id = o.commercial_owner_id LEFT JOIN users pu ON pu.id = o.production_owner_id
    LEFT JOIN users du ON du.id = o.dispatch_owner_id LEFT JOIN users au ON au.id = o.accounts_owner_id
    WHERE o.id = ?`, id));
  const items = all(
    `SELECT oi.*, p.name AS product_name, p.lead_time_days,
            (SELECT COALESCE(SUM(di.qty), 0) FROM dispatch_items di WHERE di.order_item_id = oi.id) AS qty_dispatched
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id`,
    id,
  ).map((it) => ({ ...it, config: parseJson(it.config) }));
  const history = all(`SELECT h.*, u.name AS user_name FROM order_stage_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = ? ORDER BY h.changed_at DESC, h.id DESC`, id);
  const updates = all(`SELECT pu.*, u.name AS user_name FROM production_updates pu LEFT JOIN users u ON u.id = pu.created_by WHERE pu.order_id = ? ORDER BY pu.created_at DESC`, id);
  const dispatches = all(`SELECT d.*, u.name AS created_by_name FROM dispatches d LEFT JOIN users u ON u.id = d.created_by WHERE d.order_id = ? ORDER BY d.dispatch_date DESC, d.id DESC`, id);
  for (const d of dispatches) {
    d.items = all('SELECT di.*, oi.description, oi.unit FROM dispatch_items di JOIN order_items oi ON oi.id = di.order_item_id WHERE di.dispatch_id = ?', d.id);
    d.pod = d.pod_attachment_id ? get('SELECT id, original_name, mime FROM attachments WHERE id = ?', d.pod_attachment_id) : null;
  }
  const finance = can(req.user.role, 'payments.view');
  const invoices = finance ? all('SELECT * FROM invoice_balances WHERE order_id = ? ORDER BY invoice_date', id) : [];
  const payments = finance ? all('SELECT p.*, i.number AS invoice_number, u.name AS recorded_by_name FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN users u ON u.id = p.recorded_by WHERE p.order_id = ? ORDER BY p.payment_date', id) : [];
  const credit_notes = can(req.user.role, 'finance.full') ? all('SELECT cn.* FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE i.order_id = ?', id) : [];
  const attachments = all("SELECT a.id, a.kind, a.original_name, a.mime, a.size, a.created_at, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.entity = 'order' AND a.entity_id = ? ORDER BY a.created_at DESC", id);
  const complaints = all('SELECT id, number, status, category, severity, created_at FROM complaints WHERE order_id = ?', id);
  const activities = buildTimeline({ orderId: id }).filter((i) => i.kind === 'communication');
  res.json(redact(req.user, { ...o, items, history, updates, dispatches, invoices, payments, credit_notes, attachments, complaints, activities }));
});

r.put('/orders/:id', allow('orders.edit', 'production.edit'), (req, res) => {
  assertOrder(req.user, req.params.id);
  const body = can(req.user.role, 'orders.edit') ? req.body : { revised_delivery_date: req.body.revised_delivery_date, delay_reason: req.body.delay_reason };
  updateOrder(Number(req.params.id), body, req.user);
  res.json({ ok: true });
});

r.post('/orders/:id/stage', allow('orders.view'), (req, res) => {
  assertOrder(req.user, req.params.id);
  changeOrderStage(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ production
r.get('/production', allow('production.view'), (req, res) => {
  const { where, params } = orderQuery(req, ["o.stage IN ('order_confirmed', 'material_check', 'production_scheduled', 'under_production', 'quality_check', 'packing', 'ready_for_dispatch')", "o.status = 'active'"]);
  const t = today();
  const rows = all(`SELECT ${ORDER_COLS} ${ORDER_FROM} ${where} ORDER BY CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, COALESCE(o.revised_delivery_date, o.expected_delivery_date)`, ...params)
    .map(decorateOrder)
    .map((o) => {
      const completion = o.revised_completion || o.planned_completion;
      return {
        ...o,
        items: all('SELECT id, description, qty, qty_produced, unit FROM order_items WHERE order_id = ?', o.id),
        production_delayed: !o.actual_completion && completion && completion < t,
        at_risk: !o.actual_completion && completion && o.delivery_date && completion > o.delivery_date,
        progress_pct: o.qty_ordered ? Math.round((o.qty_produced / o.qty_ordered) * 100) : 0,
      };
    });
  const stageOrder = (s) => stageIndex(ORDER_STAGES, s);
  const summary = {
    count: rows.length,
    delayed: rows.filter((o) => o.production_delayed || o.is_delayed).length,
    at_risk: rows.filter((o) => o.at_risk).length,
    shortage: rows.filter((o) => o.material_status === 'shortage').length,
    qc_pending: rows.filter((o) => o.stage === 'quality_check').length,
    due_this_week: rows.filter((o) => (o.revised_completion || o.planned_completion) && (o.revised_completion || o.planned_completion) <= addDays(t, 7)).length,
  };
  res.json(redact(req.user, { rows: rows.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || 0), summary }));
});

r.put('/orders/:id/production', allow('production.edit'), (req, res) => {
  assertOrder(req.user, req.params.id);
  updateProduction(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ dispatch
r.get('/dispatches', allow('dispatch.view'), (req, res) => {
  const q = req.query;
  const w = [orderScope(req.user, 'o')];
  const p = [];
  if (q.q) {
    w.push('(d.number LIKE ? OR o.number LIKE ? OR c.name LIKE ? OR d.lr_number LIKE ? OR d.invoice_number LIKE ? OR d.vehicle_number LIKE ?)');
    p.push(...Array(6).fill(`%${q.q}%`));
  }
  if (q.status) {
    w.push('d.status = ?');
    p.push(q.status);
  }
  if (q.pending_pod === '1') w.push("d.status = 'delivered' AND d.pod_attachment_id IS NULL");
  if (q.in_transit === '1') w.push("d.status IN ('dispatched', 'in_transit')");
  const rows = all(
    `SELECT d.*, o.number AS order_number, c.name AS customer_name, c.city,
            (SELECT COALESCE(SUM(di.qty), 0) FROM dispatch_items di WHERE di.dispatch_id = d.id) AS qty
     FROM dispatches d JOIN sales_orders o ON o.id = d.order_id JOIN customers c ON c.id = d.customer_id
     ${whereClause(w)} ORDER BY d.dispatch_date DESC, d.id DESC LIMIT 500`,
    ...p,
  );
  const t = today();
  const ready = all(`SELECT ${ORDER_COLS} ${ORDER_FROM} WHERE o.status = 'active' AND o.stage IN ('packing', 'ready_for_dispatch', 'dispatched') ${orderScope(req.user, 'o') ? `AND ${orderScope(req.user, 'o')}` : ''}`)
    .map(decorateOrder).filter((o) => o.qty_pending_dispatch > 0);
  res.json(redact(req.user, {
    rows: rows.map((d) => ({ ...d, overdue_delivery: d.status !== 'delivered' && d.expected_delivery_date && d.expected_delivery_date < t })),
    ready,
  }));
});

r.post('/orders/:id/dispatches', allow('dispatch.edit'), (req, res) => {
  assertOrder(req.user, req.params.id);
  res.status(201).json({ id: createDispatch(Number(req.params.id), req.body, req.user) });
});

r.put('/dispatches/:id', allow('dispatch.edit', 'orders.edit'), (req, res) => {
  const d = get('SELECT order_id FROM dispatches WHERE id = ?', req.params.id);
  if (!d) throw notFound('Dispatch');
  assertOrder(req.user, d.order_id);
  updateDispatch(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

export default r;
