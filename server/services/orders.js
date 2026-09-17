import { get, all, run, insert, update, tx } from '../db.js';
import { ORDER_STAGES, stageIndex, can, roleRank, labelOf } from '../../shared/constants.js';
import {
  badRequest, forbidden, nowIso, today, addDays, daysBetween, round2, num, intOrNull, strOrNull, nextNumber, token,
  notify, audit,
} from '../util.js';
import { moveLead } from './leads.js';

const idx = (stage) => stageIndex(ORDER_STAGES, stage);
const stageLabel = (stage) => labelOf(ORDER_STAGES, stage);

// SQL column list that enriches an order row (alias o) with production, dispatch and payment totals.
export const ORDER_ROLLUP = `
  (SELECT COALESCE(SUM(qty), 0) FROM order_items WHERE order_id = o.id) AS qty_ordered,
  (SELECT COALESCE(SUM(qty_produced), 0) FROM order_items WHERE order_id = o.id) AS qty_produced,
  (SELECT COALESCE(SUM(di.qty), 0) FROM dispatch_items di JOIN dispatches d ON d.id = di.dispatch_id WHERE d.order_id = o.id) AS qty_dispatched,
  (SELECT COUNT(*) FROM dispatches d WHERE d.order_id = o.id) AS dispatch_count,
  (SELECT COUNT(*) FROM dispatches d WHERE d.order_id = o.id AND d.status = 'delivered') AS delivered_count,
  (SELECT COALESCE(SUM(amount + tds_amount + other_deduction), 0) FROM payments WHERE order_id = o.id AND type = 'advance') AS advance_received,
  (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE order_id = o.id) AS invoiced,
  (SELECT COALESCE(SUM(amount + tds_amount + other_deduction), 0) FROM payments WHERE order_id = o.id) AS received,
  (SELECT COALESCE(SUM(cn.amount), 0) FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE i.order_id = o.id) AS credited,
  (SELECT MIN(i.due_date) FROM invoice_balances i WHERE i.order_id = o.id AND i.balance > 1) AS earliest_due`;

/** Derive payment, dispatch and delay status from rollup columns. */
export function decorateOrder(o) {
  const t = today();
  const deliveryDate = o.revised_delivery_date || o.expected_delivery_date;
  const open = o.status === 'active' && idx(o.stage) < idx('delivered');
  const delayDays = open && deliveryDate && deliveryDate < t ? daysBetween(deliveryDate, t) : 0;
  const settled = num(o.received) + num(o.credited);
  const outstanding = Math.max(0, round2(num(o.invoiced) - settled));
  let paymentStatus;
  if (num(o.invoiced) <= 0) {
    if (num(o.advance_required) > 0) {
      paymentStatus = num(o.advance_received) >= num(o.advance_required) - 1 ? 'advance_received' : num(o.advance_received) > 0 ? 'advance_partial' : 'advance_pending';
    } else paymentStatus = 'not_invoiced';
  } else if (outstanding <= 1) {
    paymentStatus = num(o.invoiced) >= num(o.grand_total) - 1 ? 'paid' : 'invoiced_paid';
  } else if (o.earliest_due && o.earliest_due < t) paymentStatus = 'overdue';
  else paymentStatus = settled > 0 ? 'partially_paid' : 'unpaid';

  let dispatchStatus = 'not_dispatched';
  if (num(o.qty_dispatched) > 0) {
    dispatchStatus = num(o.qty_dispatched) >= num(o.qty_ordered) ? 'dispatched' : 'partial';
    if (dispatchStatus === 'dispatched' && o.dispatch_count > 0 && o.delivered_count === o.dispatch_count) dispatchStatus = 'delivered';
  }
  return {
    ...o,
    delivery_date: deliveryDate,
    is_delayed: delayDays > 0,
    delay_days: delayDays,
    outstanding,
    payment_status: paymentStatus,
    dispatch_status: dispatchStatus,
    qty_pending_dispatch: Math.max(0, num(o.qty_ordered) - num(o.qty_dispatched)),
  };
}

export const PAYMENT_STATUS_LABELS = {
  not_invoiced: ['Not invoiced', 'slate'], advance_pending: ['Advance pending', 'amber'], advance_partial: ['Advance partial', 'amber'],
  advance_received: ['Advance received', 'teal'], unpaid: ['Unpaid', 'amber'], partially_paid: ['Partially paid', 'blue'],
  overdue: ['Overdue', 'red'], paid: ['Paid', 'green'], invoiced_paid: ['Invoices paid', 'green'],
};

export function loadOrderRow(id) {
  const o = get(
    `SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.payment_terms_days, f.name AS factory_name,
            ${ORDER_ROLLUP}
     FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN factories f ON f.id = o.factory_id
     WHERE o.id = ?`,
    id,
  );
  return o ? decorateOrder(o) : null;
}

// ------------------------------------------------------------------ conversion
export function convertQuotationToOrder(quotationId, body, user) {
  const q = get('SELECT * FROM quotations WHERE id = ?', quotationId);
  if (q.status === 'converted') throw badRequest('This quotation has already been converted');
  if (!['accepted', 'negotiation', 'responded', 'viewed', 'sent'].includes(q.status)) {
    throw badRequest('Only a sent or accepted quotation can be converted to an order');
  }
  if (!strOrNull(body.customer_po_number)) throw badRequest('Enter the customer purchase order number');
  const v = get('SELECT * FROM quotation_versions WHERE quotation_id = ? AND version_no = ?', q.id, q.current_version);
  const items = all(
    `SELECT qi.*, p.lead_time_days FROM quotation_items qi LEFT JOIN products p ON p.id = qi.product_id
     WHERE qi.version_id = ? ORDER BY qi.sort_order`,
    v.id,
  );
  const customer = get('SELECT * FROM customers WHERE id = ?', q.customer_id);
  const maxLead = Math.max(14, ...items.map((i) => num(i.lead_time_days, 14)));
  const expected = strOrNull(body.expected_delivery_date) || addDays(today(), maxLead + 7);
  const advancePct = Math.min(100, Math.max(0, num(body.advance_pct)));
  const factoryId = intOrNull(body.factory_id) ?? get('SELECT id FROM factories ORDER BY id LIMIT 1')?.id ?? null;

  return tx(() => {
    const id = insert('sales_orders', {
      number: nextNumber('SO'),
      customer_id: q.customer_id,
      contact_id: q.contact_id,
      quotation_id: q.id,
      quotation_version_id: v.id,
      lead_id: q.lead_id,
      customer_po_number: strOrNull(body.customer_po_number),
      po_date: strOrNull(body.po_date) || today(),
      po_attachment_id: intOrNull(body.po_attachment_id),
      stage: 'po_received',
      status: 'active',
      order_date: today(),
      expected_delivery_date: expected,
      priority: body.priority || 'normal',
      factory_id: factoryId,
      sales_owner_id: q.owner_id,
      commercial_owner_id: intOrNull(body.commercial_owner_id),
      production_owner_id: intOrNull(body.production_owner_id),
      dispatch_owner_id: intOrNull(body.dispatch_owner_id),
      accounts_owner_id: intOrNull(body.accounts_owner_id),
      payment_terms: v.payment_terms,
      advance_pct: advancePct,
      advance_required: round2((v.grand_total * advancePct) / 100),
      subtotal: v.subtotal,
      discount_total: v.discount_total,
      taxable_total: v.taxable_total,
      tax_total: v.tax_total,
      freight: v.freight,
      installation: v.installation,
      grand_total: v.grand_total,
      billing_address: customer.billing_address,
      shipping_address: strOrNull(body.shipping_address) || customer.shipping_address || customer.billing_address,
      internal_notes: strOrNull(body.internal_notes),
      tracking_token: token(18),
      stage_changed_at: nowIso(),
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    for (const it of items) {
      insert('order_items', {
        order_id: id, product_id: it.product_id, sku: it.sku, description: it.description, unit: it.unit, qty: it.qty,
        unit_price: it.unit_price, discount_pct: it.discount_pct, gst_rate: it.gst_rate, cost_price: it.cost_price,
        taxable: it.taxable, tax: it.tax, total: it.total, config: it.config,
      });
    }
    insert('production', {
      order_id: id, factory_id: factoryId, planned_completion: addDays(expected, -4), updated_by: user.id, updated_at: nowIso(),
    });
    insert('order_stage_history', { order_id: id, to_stage: 'po_received', note: `PO ${body.customer_po_number} against ${q.number} v${v.version_no}`, changed_by: user.id, changed_at: nowIso() });
    if (body.po_attachment_id) run("UPDATE attachments SET entity = 'order', entity_id = ?, kind = 'po' WHERE id = ?", id, body.po_attachment_id);

    update('quotations', q.id, { status: 'converted', order_id: id, decided_at: q.decided_at || nowIso(), updated_at: nowIso() });
    insert('quotation_events', { quotation_id: q.id, version_no: v.version_no, event: 'converted', from_status: q.status, to_status: 'converted', note: `Sales order created`, user_id: user.id, created_at: nowIso() });
    run("UPDATE followups SET status = 'done', completed_at = ?, completed_by = ?, outcome = 'PO received' WHERE auto_key = ? AND status = 'pending'", nowIso(), user.id, `quote:${q.id}`);

    if (q.lead_id) {
      const lead = get('SELECT status FROM leads WHERE id = ?', q.lead_id);
      if (lead && lead.status !== 'won') {
        moveLead(q.lead_id, { status: 'won', win_loss_reason: strOrNull(body.win_reason) || undefined, note: `Converted to order`, next_action: null, next_follow_up_date: null }, user, { system: true });
      }
    }
    if (['prospect', 'inactive', 'lost'].includes(customer.status)) update('customers', customer.id, { status: 'active', updated_at: nowIso() });

    const number = get('SELECT number FROM sales_orders WHERE id = ?', id).number;
    notify({ roles: ['commercial'] }, {
      type: 'order_received', title: `New PO received: ${number} (${customer.name})`,
      message: 'Commercial verification required', link: `/orders/${id}`, dedupeKey: `order_received:${id}`,
    });
    if (advancePct > 0) {
      notify({ roles: ['accounts'] }, {
        type: 'advance_due', title: `Advance of ${advancePct}% expected for ${number}`,
        message: `₹${Math.round((v.grand_total * advancePct) / 100).toLocaleString('en-IN')} from ${customer.name}`,
        link: `/orders/${id}`, dedupeKey: `advance_due:${id}`,
      });
    }
    audit(user.id, 'order', id, 'create', { from_quotation: q.number, grand_total: v.grand_total });
    return id;
  });
}

// ------------------------------------------------------------------ stage workflow
function canMoveTo(user, stage) {
  const i = idx(stage);
  if (['super_admin', 'management'].includes(user.role)) return true;
  if (i <= idx('order_confirmed')) return can(user.role, 'orders.edit') || (stage === 'advance_pending' && can(user.role, 'payments.edit'));
  if (i <= idx('quality_check')) return can(user.role, 'production.edit');
  if (i <= idx('ready_for_dispatch')) return can(user.role, 'production.edit') || can(user.role, 'dispatch.edit');
  if (i <= idx('delivered')) return can(user.role, 'dispatch.edit') || can(user.role, 'orders.edit');
  return can(user.role, 'orders.edit') || user.role === 'service';
}

/**
 * Move an order to a new stage with business checks and department notifications.
 * `system` skips permission checks for automation-triggered moves.
 */
export function changeOrderStage(orderId, body, user, { system = false } = {}) {
  const o = loadOrderRow(orderId);
  const to = body.stage;
  if (idx(to) < 0) throw badRequest('Unknown stage');
  if (o.status === 'cancelled') throw badRequest('Order is cancelled');
  if (to === o.stage) return;
  if (!system && !canMoveTo(user, to)) throw forbidden(`Your role cannot move orders to "${stageLabel(to)}"`);

  const production = get('SELECT * FROM production WHERE order_id = ?', orderId);
  const senior = system || roleRank(user.role) >= 3;
  if (idx(to) >= idx('order_confirmed') && idx(o.stage) < idx('order_confirmed')) {
    if (num(o.advance_required) > 0 && num(o.advance_received) < num(o.advance_required) - 1 && !senior) {
      throw badRequest(`Advance of ₹${Math.round(o.advance_required).toLocaleString('en-IN')} not yet received. A Sales Head can override.`);
    }
  }
  if (idx(to) >= idx('packing') && idx(o.stage) < idx('packing') && production?.qc_status !== 'passed' && !senior) {
    throw badRequest('Quality check must be marked as passed before packing');
  }
  if (to === 'dispatched' && num(o.qty_dispatched) < num(o.qty_ordered)) {
    throw badRequest('Record dispatches for all items first (Dispatches tab)');
  }

  tx(() => {
    const patch = { stage: to, stage_changed_at: nowIso(), updated_at: nowIso() };
    if (to === 'order_confirmed' && !o.confirmed_at) patch.confirmed_at = nowIso();
    if (to === 'delivered' && !o.delivered_at) patch.delivered_at = nowIso();
    if (to === 'closed') {
      patch.closed_at = nowIso();
      patch.status = 'closed';
    } else if (o.status === 'closed') patch.status = 'active';
    if (body.delay_reason !== undefined) patch.delay_reason = strOrNull(body.delay_reason);
    if (body.revised_delivery_date) patch.revised_delivery_date = body.revised_delivery_date;
    update('sales_orders', orderId, patch);
    insert('order_stage_history', { order_id: orderId, from_stage: o.stage, to_stage: to, note: strOrNull(body.note), changed_by: system ? null : user.id, changed_at: nowIso() });

    if (production) {
      const p = { updated_by: system ? null : user.id, updated_at: nowIso() };
      if (to === 'under_production' && !production.actual_start) p.actual_start = today();
      if (to === 'quality_check' && production.qc_status === 'pending') p.qc_status = 'in_progress';
      if (idx(to) >= idx('ready_for_dispatch') && !production.actual_completion) p.actual_completion = today();
      if (to === 'production_scheduled' && !production.planned_start) p.planned_start = addDays(today(), 1);
      update('production', production.id, p);
    }
    if (idx(to) >= idx('ready_for_dispatch')) {
      run('UPDATE order_items SET qty_produced = qty WHERE order_id = ? AND qty_produced < qty', orderId);
    }

    const customerVisible = {
      order_confirmed: 'Order confirmed and sent to production planning',
      production_scheduled: 'Production scheduled',
      under_production: 'Manufacturing in progress',
      quality_check: 'Units under quality inspection',
      packing: 'Quality approved, packing in progress',
      ready_for_dispatch: 'Ready for dispatch',
      delivered: 'Delivered',
      installation: 'Installation and commissioning in progress',
    };
    if (customerVisible[to]) {
      insert('production_updates', { order_id: orderId, stage: to, note: strOrNull(body.note) || customerVisible[to], visible_to_customer: 1, created_by: system ? null : user.id, created_at: nowIso() });
    }

    const link = `/orders/${orderId}`;
    if (to === 'advance_pending') {
      notify({ roles: ['accounts'] }, { type: 'advance_due', title: `${o.number}: advance payment pending`, message: o.customer_name, link, dedupeKey: `advance_pending:${orderId}` });
    }
    if (to === 'order_confirmed') {
      const prodUsers = all("SELECT id FROM users WHERE active = 1 AND role IN ('production','quality') AND (factory_id IS NULL OR factory_id = ?)", o.factory_id).map((u) => u.id);
      notify(prodUsers, {
        type: 'order_confirmed', title: `Confirmed order for production: ${o.number}`,
        message: `${o.customer_name} · ${o.priority} priority · deliver by ${o.delivery_date}`, link, severity: o.priority === 'urgent' ? 'warning' : 'info',
        dedupeKey: `order_confirmed:${orderId}`,
      });
      notify(o.sales_owner_id, { type: 'order_confirmed', title: `${o.number} confirmed`, message: 'Released to production', link, dedupeKey: `order_confirmed_sales:${orderId}` });
    }
    if (to === 'ready_for_dispatch') {
      notify({ roles: ['dispatch'] }, { type: 'ready_dispatch', title: `${o.number} ready for dispatch`, message: o.customer_name, link, dedupeKey: `ready_dispatch:${orderId}` });
      notify([o.sales_owner_id, o.accounts_owner_id], { type: 'ready_dispatch', title: `${o.number} is ready for dispatch`, message: `Check balance payment before release`, link, dedupeKey: `ready_dispatch_sales:${orderId}` });
    }
    if (to === 'delivered') {
      notify(o.sales_owner_id, { type: 'delivered', title: `${o.number} delivered to ${o.customer_name}`, link, severity: 'success', dedupeKey: `delivered:${orderId}` });
    }
  });
}

export function updateOrder(orderId, body, user) {
  const o = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  const patch = {};
  for (const k of ['customer_po_number', 'po_date', 'priority', 'delay_reason', 'internal_notes', 'shipping_address', 'payment_terms']) {
    if (body[k] !== undefined) patch[k] = strOrNull(body[k]);
  }
  for (const k of ['factory_id', 'sales_owner_id', 'commercial_owner_id', 'production_owner_id', 'dispatch_owner_id', 'accounts_owner_id']) {
    if (body[k] !== undefined) patch[k] = intOrNull(body[k]);
  }
  if (body.expected_delivery_date !== undefined) patch.expected_delivery_date = strOrNull(body.expected_delivery_date);
  if (body.revised_delivery_date !== undefined) {
    patch.revised_delivery_date = strOrNull(body.revised_delivery_date);
    if (patch.revised_delivery_date && patch.revised_delivery_date !== o.revised_delivery_date && !strOrNull(body.delay_reason ?? o.delay_reason)) {
      throw badRequest('Give a delay reason when revising the delivery date');
    }
  }
  if (body.advance_pct !== undefined) {
    patch.advance_pct = Math.min(100, Math.max(0, num(body.advance_pct)));
    patch.advance_required = round2((o.grand_total * patch.advance_pct) / 100);
  }
  if (body.status !== undefined && ['active', 'on_hold', 'cancelled'].includes(body.status)) patch.status = body.status;
  tx(() => {
    update('sales_orders', orderId, { ...patch, updated_at: nowIso() });
    if (patch.factory_id) run('UPDATE production SET factory_id = ? WHERE order_id = ?', patch.factory_id, orderId);
    if (patch.revised_delivery_date && patch.revised_delivery_date !== o.revised_delivery_date) {
      insert('production_updates', { order_id: orderId, stage: o.stage, note: `Delivery date revised to ${patch.revised_delivery_date}`, visible_to_customer: 1, created_by: user.id, created_at: nowIso() });
      notify([o.sales_owner_id], { type: 'delivery_revised', title: `${o.number}: delivery revised to ${patch.revised_delivery_date}`, message: patch.delay_reason || o.delay_reason, link: `/orders/${orderId}`, severity: 'warning', dedupeKey: `revised:${orderId}:${patch.revised_delivery_date}` });
    }
    audit(user.id, 'order', orderId, 'update', patch);
  });
}

// ------------------------------------------------------------------ production
export function updateProduction(orderId, body, user) {
  const o = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  let p = get('SELECT * FROM production WHERE order_id = ?', orderId);
  if (!p) {
    insert('production', { order_id: orderId, factory_id: o.factory_id, updated_at: nowIso() });
    p = get('SELECT * FROM production WHERE order_id = ?', orderId);
  }
  const patch = {};
  for (const k of ['planned_start', 'planned_completion', 'actual_start', 'actual_completion', 'revised_completion', 'material_constraint', 'delay_reason']) {
    if (body[k] !== undefined) patch[k] = strOrNull(body[k]);
  }
  if (body.material_status) patch.material_status = body.material_status;
  if (body.qc_status && body.qc_status !== p.qc_status) {
    if (!can(user.role, 'quality.edit') && !['super_admin', 'management'].includes(user.role)) throw forbidden('Only the quality team can change QC status');
    patch.qc_status = body.qc_status;
    patch.qc_by = user.id;
    patch.qc_at = nowIso();
  }
  if (body.qc_remarks !== undefined) patch.qc_remarks = strOrNull(body.qc_remarks);
  if (patch.revised_completion && patch.revised_completion !== p.revised_completion && !(patch.delay_reason || p.delay_reason)) {
    throw badRequest('Give a delay reason when revising the completion date');
  }

  tx(() => {
    update('production', p.id, { ...patch, updated_by: user.id, updated_at: nowIso() });
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        const row = get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', it.id, orderId);
        if (!row) continue;
        const produced = Math.min(row.qty, Math.max(0, num(it.qty_produced)));
        run('UPDATE order_items SET qty_produced = ? WHERE id = ?', produced, row.id);
      }
    }
    if (patch.delay_reason && patch.delay_reason !== o.delay_reason) run('UPDATE sales_orders SET delay_reason = ? WHERE id = ?', patch.delay_reason, orderId);
    if (strOrNull(body.update_note)) {
      insert('production_updates', { order_id: orderId, stage: o.stage, note: body.update_note, visible_to_customer: body.visible_to_customer === false ? 0 : 1, created_by: user.id, created_at: nowIso() });
    }
    if (patch.material_status === 'shortage' && p.material_status !== 'shortage') {
      notify([o.sales_owner_id, ...all("SELECT id FROM users WHERE role IN ('management') AND active = 1").map((u) => u.id)], {
        type: 'material_shortage', title: `Material shortage on ${o.number}`, message: patch.material_constraint || body.material_constraint,
        link: `/orders/${orderId}`, severity: 'warning', dedupeKey: `shortage:${orderId}:${today()}`,
      });
    }
    if (patch.qc_status === 'failed') {
      notify([o.sales_owner_id, o.production_owner_id], {
        type: 'qc_failed', title: `QC failed on ${o.number}`, message: patch.qc_remarks, link: `/orders/${orderId}`, severity: 'danger', dedupeKey: `qc_failed:${orderId}:${nowIso().slice(0, 13)}`,
      });
    }
    if (patch.revised_completion && patch.revised_completion !== p.revised_completion) {
      const delivery = o.revised_delivery_date || o.expected_delivery_date;
      if (delivery && patch.revised_completion > addDays(delivery, -2)) {
        notify(o.sales_owner_id, {
          type: 'delivery_risk', title: `${o.number}: production now completes ${patch.revised_completion}`,
          message: `Committed delivery is ${delivery}. Reason: ${patch.delay_reason || p.delay_reason}`, link: `/orders/${orderId}`, severity: 'warning',
          dedupeKey: `prod_revised:${orderId}:${patch.revised_completion}`,
        });
      }
    }
  });
  if (body.stage && body.stage !== o.stage) changeOrderStage(orderId, { stage: body.stage, note: body.update_note }, user);
}

// ------------------------------------------------------------------ dispatch
export function createDispatch(orderId, body, user) {
  const o = loadOrderRow(orderId);
  if (idx(o.stage) < idx('packing') && roleRank(user.role) < 3) throw badRequest('Order must be packed or ready for dispatch before dispatching');
  const orderItems = all(
    `SELECT oi.*, (SELECT COALESCE(SUM(di.qty), 0) FROM dispatch_items di WHERE di.order_item_id = oi.id) AS dispatched
     FROM order_items oi WHERE oi.order_id = ?`,
    orderId,
  );
  const lines = (body.items || []).map((l) => ({ ...l, qty: num(l.qty) })).filter((l) => l.qty > 0);
  if (!lines.length) throw badRequest('Enter the quantity being dispatched');
  for (const l of lines) {
    const oi = orderItems.find((x) => x.id === Number(l.order_item_id));
    if (!oi) throw badRequest('Item does not belong to this order');
    if (l.qty > oi.qty - oi.dispatched + 1e-9) throw badRequest(`${oi.description}: only ${oi.qty - oi.dispatched} pending`);
  }
  if (!strOrNull(body.dispatch_date)) throw badRequest('Dispatch date is required');

  return tx(() => {
    const complete = orderItems.every((oi) => {
      const now = lines.filter((l) => Number(l.order_item_id) === oi.id).reduce((s, l) => s + l.qty, 0);
      return oi.dispatched + now >= oi.qty - 1e-9;
    });
    const dispatchId = insert('dispatches', {
      number: nextNumber('DSP'),
      order_id: orderId,
      customer_id: o.customer_id,
      status: body.status || 'dispatched',
      dispatch_type: complete ? 'complete' : 'partial',
      invoice_number: strOrNull(body.invoice_number),
      eway_bill: strOrNull(body.eway_bill),
      transporter: strOrNull(body.transporter),
      vehicle_number: strOrNull(body.vehicle_number),
      lr_number: strOrNull(body.lr_number),
      boxes: intOrNull(body.boxes),
      weight_kg: body.weight_kg ? num(body.weight_kg) : null,
      dispatch_date: body.dispatch_date,
      expected_delivery_date: strOrNull(body.expected_delivery_date),
      tracking_url: strOrNull(body.tracking_url),
      remarks: strOrNull(body.remarks),
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    for (const l of lines) insert('dispatch_items', { dispatch_id: dispatchId, order_item_id: Number(l.order_item_id), qty: l.qty });
    const number = get('SELECT number FROM dispatches WHERE id = ?', dispatchId).number;

    if (body.create_invoice) {
      let taxable = 0; let tax = 0;
      for (const l of lines) {
        const oi = orderItems.find((x) => x.id === Number(l.order_item_id));
        const lineTaxable = l.qty * oi.unit_price * (1 - oi.discount_pct / 100);
        taxable += lineTaxable;
        tax += (lineTaxable * oi.gst_rate) / 100;
      }
      if (complete) {
        const extra = num(o.freight) + num(o.installation);
        taxable += extra;
        tax += extra * 0.18;
      }
      const invoiceId = createInvoice({
        order_id: orderId, dispatch_id: dispatchId, invoice_date: body.dispatch_date, taxable: round2(taxable), tax: round2(tax),
        notes: `Against ${number}`,
      }, user);
      const inv = get('SELECT number FROM invoices WHERE id = ?', invoiceId);
      update('dispatches', dispatchId, { invoice_id: invoiceId, invoice_number: strOrNull(body.invoice_number) || inv.number });
    }

    if (complete) {
      if (idx(o.stage) < idx('dispatched')) {
        update('sales_orders', orderId, { stage: 'dispatched', stage_changed_at: nowIso(), updated_at: nowIso() });
        insert('order_stage_history', { order_id: orderId, from_stage: o.stage, to_stage: 'dispatched', note: `Final dispatch ${number}`, changed_by: user.id, changed_at: nowIso() });
      }
    } else {
      insert('order_stage_history', { order_id: orderId, from_stage: o.stage, to_stage: o.stage, note: `Partial dispatch ${number}`, changed_by: user.id, changed_at: nowIso() });
    }
    const via = [body.transporter, body.lr_number && `LR ${body.lr_number}`].filter(Boolean).join(', ');
    insert('production_updates', {
      order_id: orderId, stage: 'dispatched', note: `${complete ? 'Dispatched' : 'Partial shipment dispatched'}${via ? ` via ${via}` : ''}`,
      visible_to_customer: 1, created_by: user.id, created_at: nowIso(),
    });
    notify([o.sales_owner_id], {
      type: 'dispatched', title: `${o.number} ${complete ? 'dispatched' : 'partially dispatched'} (${number})`,
      message: `${o.customer_name}${via ? ` · ${via}` : ''}`, link: `/orders/${orderId}`, severity: 'success', dedupeKey: `dispatched:${dispatchId}`,
    });
    notify({ roles: ['accounts'] }, {
      type: 'dispatched', title: `Dispatch ${number} for ${o.customer_name}`, message: body.create_invoice ? 'Invoice raised in CRM' : 'Raise invoice if not already done',
      link: `/orders/${orderId}`, dedupeKey: `dispatched_acc:${dispatchId}`,
    });
    audit(user.id, 'dispatch', dispatchId, 'create', { order: o.number, complete });
    return dispatchId;
  });
}

export function updateDispatch(dispatchId, body, user) {
  const d = get('SELECT * FROM dispatches WHERE id = ?', dispatchId);
  const patch = {};
  for (const k of ['invoice_number', 'eway_bill', 'transporter', 'vehicle_number', 'lr_number', 'dispatch_date', 'expected_delivery_date', 'delivered_date', 'tracking_url', 'remarks', 'received_by']) {
    if (body[k] !== undefined) patch[k] = strOrNull(body[k]);
  }
  if (body.boxes !== undefined) patch.boxes = intOrNull(body.boxes);
  if (body.pod_attachment_id !== undefined) patch.pod_attachment_id = intOrNull(body.pod_attachment_id);
  if (body.status) patch.status = body.status;
  if (body.received_confirmed !== undefined) {
    patch.received_confirmed = body.received_confirmed ? 1 : 0;
    if (body.received_confirmed && !d.received_at) patch.received_at = nowIso();
  }
  if (patch.status === 'delivered' && !patch.delivered_date && !d.delivered_date) patch.delivered_date = today();
  tx(() => {
    update('dispatches', dispatchId, { ...patch, updated_at: nowIso() });
    if (body.pod_attachment_id) run("UPDATE attachments SET entity = 'dispatch', entity_id = ?, kind = 'pod' WHERE id = ?", dispatchId, body.pod_attachment_id);
    if (patch.status === 'delivered' && d.status !== 'delivered') {
      const o = loadOrderRow(d.order_id);
      if (o.dispatch_status === 'delivered' && idx(o.stage) < idx('delivered')) {
        changeOrderStage(d.order_id, { stage: 'delivered', note: `All shipments delivered (${d.number})` }, user, { system: true });
      } else {
        insert('production_updates', { order_id: d.order_id, stage: o.stage, note: `Shipment ${d.number} delivered`, visible_to_customer: 1, created_by: user.id, created_at: nowIso() });
      }
    }
  });
}

// ------------------------------------------------------------------ invoices & payments
export function createInvoice(body, user) {
  const order = body.order_id ? get('SELECT * FROM sales_orders WHERE id = ?', body.order_id) : null;
  const customerId = order?.customer_id ?? intOrNull(body.customer_id);
  if (!customerId) throw badRequest('Invoice needs an order or customer');
  const customer = get('SELECT * FROM customers WHERE id = ?', customerId);
  const taxable = round2(num(body.taxable));
  const tax = round2(num(body.tax));
  const total = round2(taxable + tax);
  if (total <= 0) throw badRequest('Invoice amount must be greater than zero');
  const invoiceDate = strOrNull(body.invoice_date) || today();
  let advanceAdjusted = 0;
  if (order && body.adjust_advance !== false) {
    const adv = get(`SELECT COALESCE(SUM(amount + tds_amount + other_deduction), 0) AS v FROM payments WHERE order_id = ? AND type = 'advance'`, order.id).v;
    const used = get('SELECT COALESCE(SUM(advance_adjusted), 0) AS v FROM invoices WHERE order_id = ?', order.id).v;
    advanceAdjusted = round2(Math.max(0, Math.min(adv - used, total)));
  }
  const id = insert('invoices', {
    number: strOrNull(body.number) || nextNumber('INV', invoiceDate),
    order_id: order?.id ?? null,
    customer_id: customerId,
    dispatch_id: intOrNull(body.dispatch_id),
    invoice_date: invoiceDate,
    due_date: strOrNull(body.due_date) || addDays(invoiceDate, customer.payment_terms_days || 30),
    taxable, tax, total,
    advance_adjusted: advanceAdjusted,
    notes: strOrNull(body.notes),
    created_by: user.id,
    created_at: nowIso(),
  });
  audit(user.id, 'invoice', id, 'create', { total, advance_adjusted: advanceAdjusted });
  return id;
}

export function recordPayment(body, user) {
  const invoice = body.invoice_id ? get('SELECT * FROM invoice_balances WHERE id = ?', body.invoice_id) : null;
  const orderId = invoice?.order_id ?? intOrNull(body.order_id);
  const order = orderId ? get('SELECT * FROM sales_orders WHERE id = ?', orderId) : null;
  const customerId = invoice?.customer_id ?? order?.customer_id ?? intOrNull(body.customer_id);
  if (!customerId) throw badRequest('Select the invoice, order or customer this payment is for');
  const amount = round2(num(body.amount));
  const tds = round2(num(body.tds_amount));
  const other = round2(num(body.other_deduction));
  if (amount <= 0) throw badRequest('Amount received must be greater than zero');
  if (invoice && amount + tds + other > invoice.balance + 1) {
    throw badRequest(`Exceeds invoice balance of ₹${Math.round(invoice.balance).toLocaleString('en-IN')}`);
  }
  if ((tds > 0 || other > 0) && !can(user.role, 'finance.full')) throw forbidden('Only accounts can record deductions');
  const type = invoice ? 'invoice' : order ? 'advance' : 'on_account';

  return tx(() => {
    const id = insert('payments', {
      customer_id: customerId, order_id: orderId, invoice_id: invoice?.id ?? null, type, amount, tds_amount: tds, other_deduction: other,
      deduction_note: strOrNull(body.deduction_note), payment_date: strOrNull(body.payment_date) || today(), mode: body.mode || 'neft',
      reference: strOrNull(body.reference), notes: strOrNull(body.notes), recorded_by: user.id, created_at: nowIso(),
    });
    if (invoice) {
      run("UPDATE followups SET status = 'done', completed_at = ?, completed_by = ?, outcome = 'Payment received' WHERE invoice_id = ? AND status = 'pending' AND ? >= ?",
        nowIso(), user.id, invoice.id, amount + tds + other, invoice.balance - 1);
    }
    if (order) {
      const o = loadOrderRow(order.id);
      notify(order.sales_owner_id, {
        type: 'payment_received', title: `Payment ₹${Math.round(amount).toLocaleString('en-IN')} received for ${order.number}`,
        message: o.customer_name, link: `/orders/${order.id}`, severity: 'success', dedupeKey: `payment:${id}`,
      });
      if (type === 'advance' && order.stage === 'advance_pending' && num(o.advance_received) >= num(o.advance_required) - 1) {
        changeOrderStage(order.id, { stage: 'order_confirmed', note: 'Advance received, order confirmed automatically' }, user, { system: true });
      }
    }
    audit(user.id, 'payment', id, 'create', { amount, tds, other, invoice: invoice?.number });
    return id;
  });
}

export function createCreditNote(body, user) {
  const invoice = body.invoice_id ? get('SELECT * FROM invoice_balances WHERE id = ?', body.invoice_id) : null;
  const customerId = invoice?.customer_id ?? intOrNull(body.customer_id);
  if (!customerId) throw badRequest('Select an invoice or customer');
  const amount = round2(num(body.amount));
  if (amount <= 0) throw badRequest('Credit note amount must be greater than zero');
  if (!strOrNull(body.reason)) throw badRequest('Reason is required for a credit note');
  if (invoice && amount > invoice.balance + 1) throw badRequest('Credit note exceeds the invoice balance');
  const id = insert('credit_notes', {
    number: nextNumber('CN'), customer_id: customerId, invoice_id: invoice?.id ?? null, amount, reason: strOrNull(body.reason),
    note_date: strOrNull(body.note_date) || today(), created_by: user.id, created_at: nowIso(),
  });
  audit(user.id, 'credit_note', id, 'create', { amount, invoice: invoice?.number });
  return id;
}

export function ageingBucket(invoiceDate) {
  const d = daysBetween(invoiceDate, today());
  if (d <= 30) return 'd0_30';
  if (d <= 60) return 'd31_60';
  if (d <= 90) return 'd61_90';
  return 'd90_plus';
}
