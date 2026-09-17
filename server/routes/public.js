// Customer-facing links (no login): view/respond to a quotation and track an order.
import { Router } from 'express';
import { all, get, getSetting } from '../db.js';
import { DEFAULT_SETTINGS, ORDER_STAGES, stageIndex } from '../../shared/constants.js';
import { notFound, badRequest, strOrNull, HttpError } from '../util.js';
import { setQuotationStatus, loadQuotation } from '../services/quotes.js';
import { loadOrderRow } from '../services/orders.js';

const r = Router();

const hits = new Map();
r.use((req, _res, next) => {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (list.length > 60) return next(new HttpError(429, 'Too many requests'));
  list.push(now);
  hits.set(req.ip, list);
  next();
});

const company = () => ({ ...DEFAULT_SETTINGS.company, ...getSetting('company', {}) });

r.get('/quotations/:token', (req, res) => {
  const row = get('SELECT id, status FROM quotations WHERE public_token = ?', req.params.token);
  if (!row || ['draft', 'approval_pending', 'approved'].includes(row.status)) throw notFound('Quotation');
  if (row.status === 'sent' && !req.query.preview) setQuotationStatus(row.id, { status: 'viewed' }, null);
  const q = loadQuotation(row.id);
  const v = q.current;
  res.json({
    company: company(),
    number: q.number, subject: q.subject, status: q.status, version: v.version_no, valid_until: q.valid_until, sent_at: q.sent_at,
    customer: { name: q.customer_name, gstin: q.customer_gstin, billing_address: q.billing_address, city: q.city, state: q.state },
    contact: { name: q.contact_name, designation: q.contact_designation },
    owner: { name: q.owner_name, email: q.owner_email, phone: q.owner_phone },
    terms: { payment: v.payment_terms, delivery: v.delivery_terms, warranty: v.warranty_terms, notes: v.notes },
    items: v.items.map((it) => ({
      description: it.description, specs: it.specs, sku: it.sku, hsn: it.hsn, unit: it.unit, qty: it.qty, unit_price: it.unit_price,
      discount_pct: it.discount_pct, gst_rate: it.gst_rate, taxable: it.taxable, tax: it.tax, total: it.total,
    })),
    totals: {
      subtotal: v.subtotal, discount_total: v.discount_total, freight: v.freight, installation: v.installation,
      taxable_total: v.taxable_total, tax_total: v.tax_total, grand_total: v.grand_total,
    },
    can_respond: ['sent', 'viewed', 'responded', 'negotiation'].includes(q.status) && (!q.valid_until || q.valid_until >= new Date().toISOString().slice(0, 10)),
    customer_feedback: q.customer_feedback,
  });
});

r.post('/quotations/:token/respond', (req, res) => {
  const row = get('SELECT id, status FROM quotations WHERE public_token = ?', req.params.token);
  if (!row) throw notFound('Quotation');
  const name = strOrNull(req.body.name);
  const message = strOrNull(req.body.message);
  if (!name) throw badRequest('Please enter your name');
  const map = { accept: 'accepted', revision: 'revision_requested', comment: 'responded' };
  const status = map[req.body.action];
  if (!status) throw badRequest('Unknown response');
  if ((status === 'revision_requested' || status === 'responded') && !message) throw badRequest('Please tell us what you need');
  setQuotationStatus(row.id, { status, note: `${name}: ${message || 'Accepted the quotation'}` }, null);
  res.json({ ok: true, status });
});

r.get('/orders/:token', (req, res) => {
  const row = get('SELECT id FROM sales_orders WHERE tracking_token = ?', req.params.token);
  if (!row) throw notFound('Order');
  const o = loadOrderRow(row.id);
  const p = get('SELECT planned_completion, revised_completion, actual_completion, qc_status FROM production WHERE order_id = ?', o.id);
  const milestones = [
    { key: 'confirmed', label: 'Order confirmed', done: stageIndex(ORDER_STAGES, o.stage) >= stageIndex(ORDER_STAGES, 'order_confirmed') },
    { key: 'production', label: 'In production', done: stageIndex(ORDER_STAGES, o.stage) >= stageIndex(ORDER_STAGES, 'production_scheduled') },
    { key: 'quality', label: 'Quality checked', done: stageIndex(ORDER_STAGES, o.stage) >= stageIndex(ORDER_STAGES, 'packing') },
    { key: 'dispatched', label: 'Dispatched', done: o.qty_dispatched > 0, partial: o.dispatch_status === 'partial' },
    { key: 'delivered', label: 'Delivered', done: stageIndex(ORDER_STAGES, o.stage) >= stageIndex(ORDER_STAGES, 'delivered') },
  ];
  res.json({
    company: company(),
    number: o.number, customer_po_number: o.customer_po_number, customer_name: o.customer_name, order_date: o.order_date,
    stage: o.stage, stage_label: ORDER_STAGES.find((s) => s.value === o.stage)?.label, status: o.status,
    expected_delivery_date: o.delivery_date, revised: Boolean(o.revised_delivery_date), planned_completion: p?.revised_completion || p?.planned_completion,
    milestones,
    items: all(
      `SELECT oi.description, oi.qty, oi.unit, oi.qty_produced, (SELECT COALESCE(SUM(di.qty), 0) FROM dispatch_items di WHERE di.order_item_id = oi.id) AS qty_dispatched
       FROM order_items oi WHERE oi.order_id = ?`,
      o.id,
    ),
    updates: all('SELECT note, created_at FROM production_updates WHERE order_id = ? AND visible_to_customer = 1 ORDER BY created_at DESC LIMIT 30', o.id),
    dispatches: all(
      `SELECT number, dispatch_type, status, dispatch_date, expected_delivery_date, delivered_date, transporter, vehicle_number, lr_number, boxes, tracking_url
       FROM dispatches WHERE order_id = ? ORDER BY dispatch_date DESC`,
      o.id,
    ),
  });
});

export default r;
