import { all } from '../db.js';
import { ACTIVITY_TYPES, LEAD_STAGES, ORDER_STAGES, PRODUCTION_STAGE_KEYS, labelOf, COMPLAINT_CATEGORIES } from '../../shared/constants.js';

const QUOTE_EVENT_TEXT = {
  created: 'Quotation drafted', edited: 'Quotation edited', revised: 'Quotation revised', submitted: 'Submitted for approval',
  auto_approved: 'Approved (within policy)', approved: 'Approved internally', approval_rejected: 'Approval rejected', withdrawn: 'Withdrawn from approval',
  sent: 'Quotation sent', resent: 'Quotation re-sent', viewed: 'Customer viewed quotation', responded: 'Customer responded',
  revision_requested: 'Customer requested revision', negotiation: 'Negotiation', accepted: 'Quotation accepted',
  rejected: 'Quotation rejected', expired: 'Quotation expired', converted: 'Converted to sales order',
};

/**
 * Chronological relationship history assembled from every module.
 * Filter by one of customerId / leadId / orderId.
 */
export function buildTimeline({ customerId, leadId, orderId }) {
  const items = [];
  const f = (col) => {
    if (customerId) return [`${col.customer} = ?`, customerId];
    if (leadId && col.lead) return [`${col.lead} = ?`, leadId];
    if (orderId && col.order) return [`${col.order} = ?`, orderId];
    return null;
  };

  let w = f({ customer: 'a.customer_id', lead: 'a.lead_id', order: 'a.order_id' });
  if (w) {
    const acts = all(
      `SELECT a.*, u.name AS user_name, ct.name AS contact_name, l.code AS lead_code, q.number AS quotation_number, o.number AS order_number
       FROM activities a LEFT JOIN users u ON u.id = a.created_by LEFT JOIN contacts ct ON ct.id = a.contact_id
       LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN quotations q ON q.id = a.quotation_id LEFT JOIN sales_orders o ON o.id = a.order_id
       WHERE ${w[0]}`,
      w[1],
    );
    const files = acts.length
      ? all(`SELECT id, entity_id, original_name, mime, kind, size FROM attachments WHERE entity = 'activity' AND entity_id IN (${acts.map(() => '?').join(',')})`, acts.map((a) => a.id))
      : [];
    for (const a of acts) {
      items.push({
        key: `act-${a.id}`, kind: a.type === 'sample_delivery' ? 'sample' : a.type === 'requirement' ? 'requirement' : 'communication',
        type: a.type, at: a.activity_date,
        title: a.subject || `${labelOf(ACTIVITY_TYPES, a.type)}${a.contact_name ? ` with ${a.contact_name}` : ''}`,
        detail: a.summary, customer_response: a.customer_response, objections: a.objections, products_discussed: a.products_discussed,
        next_action: a.next_action, follow_up_date: a.follow_up_date, user: a.user_name,
        refs: [a.lead_code && { label: a.lead_code, link: `/leads/${a.lead_id}` }, a.quotation_number && { label: a.quotation_number, link: `/quotations/${a.quotation_id}` }, a.order_number && { label: a.order_number, link: `/orders/${a.order_id}` }].filter(Boolean),
        attachments: files.filter((x) => x.entity_id === a.id),
      });
    }
  }

  w = f({ customer: 'l.customer_id', lead: 'l.id' });
  if (w) {
    for (const h of all(
      `SELECT h.*, l.code, l.title, l.id AS lead_id, l.win_loss_reason, u.name AS user_name
       FROM lead_stage_history h JOIN leads l ON l.id = h.lead_id LEFT JOIN users u ON u.id = h.changed_by WHERE ${w[0]}`,
      w[1],
    )) {
      let title;
      if (!h.from_stage && !h.from_status) title = `Enquiry received: ${h.title}`;
      else if (h.to_status !== h.from_status && h.to_status !== 'open') title = `Lead ${h.to_status === 'on_hold' ? 'put on hold' : h.to_status}: ${h.title}`;
      else title = `Lead moved to ${labelOf(LEAD_STAGES, h.to_stage)}`;
      items.push({
        key: `lead-${h.id}`, kind: 'lead', type: h.to_status === 'won' ? 'won' : h.to_status === 'lost' ? 'lost' : 'stage', at: h.changed_at, title,
        detail: h.to_status === 'lost' || h.to_status === 'won' ? [h.note, h.win_loss_reason].filter(Boolean).join(' · ') : h.note,
        user: h.user_name || 'System', refs: [{ label: h.code, link: `/leads/${h.lead_id}` }],
      });
    }
  }

  w = f({ customer: 'q.customer_id', lead: 'q.lead_id', order: 'q.order_id' });
  if (w) {
    for (const e of all(
      `SELECT e.*, q.number, q.id AS qid, v.grand_total, u.name AS user_name
       FROM quotation_events e JOIN quotations q ON q.id = e.quotation_id
       LEFT JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = e.version_no
       LEFT JOIN users u ON u.id = e.user_id
       WHERE ${w[0]} AND e.event NOT IN ('edited')`,
      w[1],
    )) {
      items.push({
        key: `qe-${e.id}`, kind: 'quotation', type: e.event, at: e.created_at,
        title: `${QUOTE_EVENT_TEXT[e.event] || e.event}: ${e.number} v${e.version_no}`, detail: e.note, amount: e.grand_total,
        user: e.user_name || (['viewed', 'accepted', 'revision_requested', 'responded'].includes(e.event) ? 'Customer portal' : 'System'),
        refs: [{ label: e.number, link: `/quotations/${e.qid}` }],
      });
    }
  }

  w = f({ customer: 'o.customer_id', order: 'o.id' });
  if (w) {
    for (const h of all(
      `SELECT h.*, o.number, o.id AS oid, o.grand_total, o.customer_po_number, u.name AS user_name
       FROM order_stage_history h JOIN sales_orders o ON o.id = h.order_id LEFT JOIN users u ON u.id = h.changed_by WHERE ${w[0]}`,
      w[1],
    )) {
      const production = PRODUCTION_STAGE_KEYS.includes(h.to_stage);
      const placed = !h.from_stage && h.to_stage === 'po_received';
      items.push({
        key: `osh-${h.id}`, kind: production ? 'production' : 'order', type: h.to_stage, at: h.changed_at,
        title: placed ? `Order placed: ${h.number} (PO ${h.customer_po_number})` : h.from_stage === h.to_stage ? `${h.number}: ${h.note}` : `${h.number} → ${labelOf(ORDER_STAGES, h.to_stage)}`,
        detail: placed || h.from_stage === h.to_stage ? null : h.note, amount: placed ? h.grand_total : undefined,
        user: h.user_name || 'System', refs: [{ label: h.number, link: `/orders/${h.oid}` }],
      });
    }
    for (const p of all(
      `SELECT pu.*, o.number, o.id AS oid, u.name AS user_name FROM production_updates pu JOIN sales_orders o ON o.id = pu.order_id
       LEFT JOIN users u ON u.id = pu.created_by
       WHERE ${w[0]} AND pu.stage NOT IN ('dispatched') AND pu.note NOT IN ('Order confirmed and sent to production planning')`,
      w[1],
    )) {
      if (items.some((i) => i.kind !== 'communication' && i.at?.slice(0, 16) === p.created_at.slice(0, 16) && i.type === p.stage)) continue;
      items.push({
        key: `pu-${p.id}`, kind: 'production', type: 'update', at: p.created_at, title: `Production update · ${p.number}`,
        detail: p.note, user: p.user_name || 'System', refs: [{ label: p.number, link: `/orders/${p.oid}` }],
      });
    }
    for (const d of all(
      `SELECT d.*, o.number AS order_number, o.id AS oid FROM dispatches d JOIN sales_orders o ON o.id = d.order_id WHERE ${w[0]}`,
      w[1],
    )) {
      items.push({
        key: `dsp-${d.id}`, kind: 'dispatch', type: d.dispatch_type, at: `${d.dispatch_date}T18:00:00.000Z`,
        title: `${d.dispatch_type === 'partial' ? 'Partial dispatch' : 'Dispatched'} ${d.number} · ${d.order_number}`,
        detail: [d.transporter, d.vehicle_number, d.lr_number && `LR ${d.lr_number}`, d.boxes && `${d.boxes} boxes`, d.invoice_number && `Inv ${d.invoice_number}`].filter(Boolean).join(' · '),
        refs: [{ label: d.order_number, link: `/orders/${d.oid}` }],
      });
      if (d.delivered_date) {
        items.push({
          key: `dlv-${d.id}`, kind: 'dispatch', type: 'delivered', at: `${d.delivered_date}T18:30:00.000Z`,
          title: `Delivered ${d.number}`, detail: d.received_by ? `Received by ${d.received_by}` : null, refs: [{ label: d.order_number, link: `/orders/${d.oid}` }],
        });
      }
    }
    for (const i of all(
      `SELECT i.*, o.number AS order_number FROM invoice_balances i LEFT JOIN sales_orders o ON o.id = i.order_id
       WHERE ${w[0].replace('o.customer_id', 'i.customer_id').replace('o.id', 'i.order_id')}`,
      w[1],
    )) {
      items.push({
        key: `inv-${i.id}`, kind: 'payment', type: 'invoice', at: `${i.invoice_date}T19:00:00.000Z`, title: `Invoice ${i.number} raised`,
        detail: `Due ${i.due_date}${i.balance > 1 ? '' : ' · settled'}`, amount: i.total, refs: i.order_number ? [{ label: i.order_number, link: `/orders/${i.order_id}` }] : [],
      });
    }
    for (const p of all(
      `SELECT p.*, i.number AS invoice_number, o.number AS order_number, u.name AS user_name FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN sales_orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.recorded_by
       WHERE ${w[0].replace('o.customer_id', 'p.customer_id').replace('o.id', 'p.order_id')}`,
      w[1],
    )) {
      items.push({
        key: `pay-${p.id}`, kind: 'payment', type: p.type, at: `${p.payment_date}T19:30:00.000Z`,
        title: `${p.type === 'advance' ? 'Advance received' : 'Payment received'}${p.invoice_number ? ` against ${p.invoice_number}` : p.order_number ? ` for ${p.order_number}` : ''}`,
        detail: [p.mode?.toUpperCase(), p.tds_amount > 0 && `TDS ₹${Math.round(p.tds_amount).toLocaleString('en-IN')}`].filter(Boolean).join(' · '),
        amount: p.amount, tds_amount: p.tds_amount, user: p.user_name,
      });
    }
  }

  w = f({ customer: 'k.customer_id', order: 'k.order_id' });
  if (w) {
    for (const k of all(
      `SELECT k.*, p.name AS product_name, u.name AS user_name FROM complaints k LEFT JOIN products p ON p.id = k.product_id
       LEFT JOIN users u ON u.id = k.created_by WHERE ${w[0]}`,
      w[1],
    )) {
      items.push({
        key: `cmp-${k.id}`, kind: 'complaint', type: 'registered', at: k.created_at,
        title: `Complaint ${k.number}: ${labelOf(COMPLAINT_CATEGORIES, k.category)}`, detail: [k.product_name, k.description].filter(Boolean).join(' · '),
        user: k.user_name, refs: [{ label: k.number, link: `/complaints/${k.id}` }],
      });
      if (k.resolved_at) {
        items.push({
          key: `cmpr-${k.id}`, kind: 'complaint', type: 'resolved', at: k.resolved_at, title: `Complaint ${k.number} resolved`,
          detail: [k.root_cause && `Root cause: ${k.root_cause}`, k.resolution_notes].filter(Boolean).join(' · '), refs: [{ label: k.number, link: `/complaints/${k.id}` }],
        });
      }
    }
  }

  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
