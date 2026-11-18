// P1: lightweight invoice/outstanding register — an operational mirror of the accounting system, not a
// ledger. A promised payment is never a receipt; payment and dispatch completion are independent.
//
// Outstanding = invoice gross − advance adjusted − valid receipts − TDS − other deductions − credit notes.
// Advances are received against an order before invoicing and can later be adjusted against an invoice.
import { all, get, insert, run, tx, update } from '../db.js';
import {
  Check, badRequest, conflict, notFound, nowIso, today, str, intId, audit, history, setSetting, settings, outstandingSql, placeholders,
} from '../util.js';
import { CURRENCIES, PAYMENT_MODES } from '../../shared/constants.js';
import { addDays, daysBetween } from '../../shared/dates.js';
import { toMinor, lineValueMinor } from '../../shared/rules.js';
import { requireActiveUser } from './people.js';
import { createTask } from './tasks.js';
import { linkAttachment } from './attachments.js';
import { customerScope } from '../access.js';

export const OUTSTANDING = outstandingSql;

/** Ageing by days past the due date (not the invoice date), so "not yet due" is never shown as late. */
export function ageingBucket(dueDate, day = today()) {
  if (!dueDate || dueDate >= day) return 'current';
  const n = daysBetween(dueDate, day);
  if (n <= 30) return 'd0_30';
  if (n <= 60) return 'd31_60';
  if (n <= 90) return 'd61_90';
  return 'd90_plus';
}

function stateOf(i, day) {
  if (i.outstanding_minor < 0) return 'overpaid';
  if (i.outstanding_minor === 0) return 'paid';
  if (i.due_date && i.due_date < day) return 'overdue';
  return i.outstanding_minor < i.gross_minor - i.advance_adjusted_minor ? 'part_paid' : 'not_due';
}

export function listInvoices(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = customerScope(user, 'c');
  if (scope) where.push(scope);
  for (const [k, col] of [['customer_id', 'i.customer_id'], ['order_id', 'i.order_id'], ['invoice', 'i.id']]) {
    if (intId(query[k])) {
      where.push(`${col} = ?`);
      params.push(intId(query[k]));
    }
  }
  if (query.q) {
    where.push('(i.invoice_ref LIKE ? OR c.company_name LIKE ? OR o.code LIKE ?)');
    params.push(...Array(3).fill(`%${String(query.q).trim()}%`));
  }
  if (query.currency) {
    where.push('i.currency = ?');
    params.push(query.currency);
  }
  const day = today();
  let rows = all(`SELECT i.*, c.company_name, c.code AS customer_code, o.code AS order_code, u.name AS owner_name, ${OUTSTANDING()} AS outstanding_minor,
      (SELECT MAX(effective_date) FROM receipts r WHERE r.invoice_id = i.id AND r.reversed_at IS NULL) AS last_receipt_date,
      (SELECT COALESCE(SUM(r.tds_minor), 0) FROM receipts r WHERE r.invoice_id = i.id AND r.reversed_at IS NULL) AS tds_minor,
      (SELECT COALESCE(SUM(r.other_deduction_minor), 0) FROM receipts r WHERE r.invoice_id = i.id AND r.reversed_at IS NULL) AS other_deduction_minor,
      (SELECT MAX(a.occurred_at) FROM activities a WHERE a.invoice_id = i.id AND a.customer_contact = 1) AS last_collection_contact
    FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN users u ON u.id = i.owner_id
    WHERE ${where.join(' AND ')} ORDER BY i.due_date`, ...params).map((i) => ({
    ...i,
    state: stateOf(i, day),
    bucket: i.outstanding_minor > 0 ? ageingBucket(i.due_date, day) : null,
    days_overdue: i.outstanding_minor > 0 && i.due_date && i.due_date < day ? daysBetween(i.due_date, day) : 0,
    promise_broken: Boolean(i.promise_date && i.promise_date < day && i.outstanding_minor > 0),
  }));
  if (query.state && query.state !== 'all') rows = rows.filter((r) => r.state === query.state || (query.state === 'open' && r.outstanding_minor > 0) || (query.state === 'broken' && r.promise_broken));
  if (query.bucket) rows = rows.filter((r) => r.bucket === query.bucket);
  const byCurrency = {};
  for (const r of rows) {
    const t = (byCurrency[r.currency] ||= {
      currency: r.currency, outstanding_minor: 0, overdue_minor: 0, invoices: 0, overpaid_minor: 0,
      current_minor: 0, d0_30_minor: 0, d31_60_minor: 0, d61_90_minor: 0, d90_plus_minor: 0,
    });
    t.invoices++;
    if (r.outstanding_minor > 0) {
      t.outstanding_minor += r.outstanding_minor;
      t[`${r.bucket}_minor`] += r.outstanding_minor;
    }
    if (r.outstanding_minor < 0) t.overpaid_minor += -r.outstanding_minor;
    if (r.state === 'overdue') t.overdue_minor += r.outstanding_minor;
  }
  const holds = all(`SELECT h.*, o.code AS order_code, c.company_name, u.name AS authorised_by_name FROM payment_holds h JOIN orders o ON o.id = h.order_id JOIN customers c ON c.id = h.customer_id
    LEFT JOIN users u ON u.id = h.authorised_by WHERE h.released_at IS NULL ${scope ? `AND ${scope}` : ''} ORDER BY h.held_at`);
  return { rows, totals: Object.values(byCurrency), holds, broken_promises: rows.filter((r) => r.promise_broken).length, as_of: settings().finance };
}

/** Receivables overview: per-currency outstanding, ageing, customer-wise balances, pending advances and collections. */
export function financeOverview(user) {
  const day = today();
  const { rows, totals, holds, broken_promises: brokenPromises, as_of: asOf } = listInvoices({}, user);
  const scope = customerScope(user, 'c');
  const open = rows.filter((r) => r.outstanding_minor > 0);
  const byCustomer = new Map();
  for (const i of open) {
    const key = `${i.customer_id}:${i.currency}`;
    const row = byCustomer.get(key) || {
      customer_id: i.customer_id, company_name: i.company_name, customer_code: i.customer_code, currency: i.currency,
      invoices: 0, outstanding_minor: 0, overdue_minor: 0, oldest_due: i.due_date, d90_plus_minor: 0,
    };
    row.invoices++;
    row.outstanding_minor += i.outstanding_minor;
    if (i.state === 'overdue') row.overdue_minor += i.outstanding_minor;
    if (i.bucket === 'd90_plus') row.d90_plus_minor += i.outstanding_minor;
    if (i.due_date && (!row.oldest_due || i.due_date < row.oldest_due)) row.oldest_due = i.due_date;
    byCustomer.set(key, row);
  }
  const monthStart = `${day.slice(0, 8)}01`;
  const scopeAnd = scope ? `AND r.customer_id IN (SELECT c.id FROM customers c WHERE ${scope})` : '';
  const collected = all(`SELECT COALESCE(r.currency, i.currency, o.currency) AS currency, SUM(r.amount_minor) AS amount_minor FROM receipts r
    LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN orders o ON o.id = r.order_id
    WHERE r.reversed_at IS NULL AND r.kind <> 'credit' AND r.effective_date >= ? ${scopeAnd} GROUP BY 1`, monthStart);
  const trend = all(`SELECT substr(r.effective_date, 1, 7) AS month, COALESCE(r.currency, i.currency, o.currency) AS currency, SUM(r.amount_minor) AS amount_minor FROM receipts r
    LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN orders o ON o.id = r.order_id
    WHERE r.reversed_at IS NULL AND r.kind <> 'credit' AND r.effective_date >= ? ${scopeAnd} GROUP BY 1, 2 ORDER BY 1`, addDays(monthStart, -330));
  const dueThisWeek = {};
  for (const i of open.filter((x) => x.due_date >= day && x.due_date <= addDays(day, 7))) dueThisWeek[i.currency] = (dueThisWeek[i.currency] || 0) + i.outstanding_minor;
  return {
    as_of: asOf, totals, holds, broken_promises: brokenPromises,
    collected_this_month: collected, due_this_week: Object.entries(dueThisWeek).map(([currency, amount_minor]) => ({ currency, amount_minor })),
    customers: [...byCustomer.values()].sort((a, b) => b.overdue_minor - a.overdue_minor || b.outstanding_minor - a.outstanding_minor).slice(0, 50),
    advances_pending: pendingAdvances(user),
    trend,
    unknown_note: 'Only invoices recorded here are included. Missing invoices are unknown — not zero outstanding.',
  };
}

/** Orders whose required advance has not been fully received (advance receipts against the order). */
export function pendingAdvances(user) {
  const scope = customerScope(user, 'c');
  return all(`SELECT o.id, o.code, o.currency, o.advance_required_minor, o.advance_pct, c.company_name, o.customer_id,
      (SELECT COALESCE(SUM(r.amount_minor + r.tds_minor + r.other_deduction_minor), 0) FROM receipts r WHERE r.order_id = o.id AND r.kind = 'advance' AND r.reversed_at IS NULL) AS advance_received_minor,
      (SELECT COUNT(*) FROM payment_holds h WHERE h.order_id = o.id AND h.released_at IS NULL) AS on_hold
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'confirmed' AND o.closed_at IS NULL AND o.advance_required_minor > 0 ${scope ? `AND ${scope}` : ''}
    ORDER BY o.received_date`).filter((o) => o.advance_received_minor < o.advance_required_minor);
}

/**
 * One plain payment status per order, for order lists, the production board and the sales pipeline. The checks
 * run from most to least urgent. Amounts are in the order's currency and are hidden from roles without values.
 */
export function paymentStatusByOrder(orderIds) {
  const out = new Map();
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (!ids.length) return out;
  const ph = placeholders(ids);
  const day = today();
  const advances = new Map(all(`SELECT order_id, SUM(amount_minor + tds_minor + other_deduction_minor) AS n FROM receipts WHERE order_id IN (${ph}) AND kind = 'advance' AND reversed_at IS NULL GROUP BY order_id`, ids).map((r) => [r.order_id, r.n]));
  const holds = new Map(all(`SELECT order_id, reason FROM payment_holds WHERE order_id IN (${ph}) AND released_at IS NULL`, ids).map((h) => [h.order_id, h.reason]));
  const invoices = all(`SELECT i.order_id, i.gross_minor, i.due_date, ${OUTSTANDING()} AS outstanding_minor FROM invoices i WHERE i.order_id IN (${ph})`, ids);
  for (const o of all(`SELECT id, currency, advance_required_minor FROM orders WHERE id IN (${ph})`, ids)) {
    const mine = invoices.filter((i) => i.order_id === o.id);
    const outstanding = mine.reduce((s, i) => s + Math.max(0, i.outstanding_minor), 0);
    const overdue = mine.some((i) => i.outstanding_minor > 0 && i.due_date && i.due_date < day);
    const required = o.advance_required_minor || 0;
    const received = advances.get(o.id) || 0;
    let state = ['not_invoiced', 'Not invoiced yet', 'slate'];
    if (holds.has(o.id)) state = ['on_hold', 'Payment hold', 'red'];
    else if (overdue) state = ['overdue', 'Payment overdue', 'red'];
    else if (required > received && !mine.length) state = ['advance_pending', 'Advance pending', 'amber'];
    else if (mine.length) state = outstanding > 0 ? ['invoiced', 'Invoice unpaid', 'blue'] : ['paid', 'Paid', 'green'];
    else if (required > 0) state = ['advance_received', 'Advance received', 'green'];
    out.set(o.id, {
      code: state[0], label: state[1], tone: state[2], hold_reason: holds.get(o.id) ?? null, currency: o.currency,
      advance_required_minor: required, advance_received_minor: received, invoiced_minor: mine.reduce((s, i) => s + i.gross_minor, 0), outstanding_minor: outstanding,
    });
  }
  return out;
}

/** Money side of one order: value from lines, advance, invoices and receipts — all in the order currency. */
export function orderFinance(orderId) {
  const o = get('SELECT id, currency, advance_pct, advance_required_minor, freight_minor, installation_minor FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const lines = all('SELECT confirmed_qty, cancelled_qty, unit_price_minor, gst_rate FROM order_lines WHERE order_id = ?', orderId);
  const known = lines.every((l) => l.unit_price_minor !== null);
  const value = known ? lines.reduce((s, l) => s + lineValueMinor(l.confirmed_qty - l.cancelled_qty, l.unit_price_minor), 0) + (o.freight_minor || 0) + (o.installation_minor || 0) : null;
  const invoices = all(`SELECT i.id, i.invoice_ref, i.invoice_date, i.due_date, i.currency, i.gross_minor, i.advance_adjusted_minor, ${OUTSTANDING()} AS outstanding_minor FROM invoices i WHERE i.order_id = ? ORDER BY i.invoice_date`, orderId);
  const advance = get("SELECT COALESCE(SUM(amount_minor + tds_minor + other_deduction_minor), 0) AS n FROM receipts WHERE order_id = ? AND kind = 'advance' AND reversed_at IS NULL", orderId).n;
  const receipts = all(`SELECT r.*, i.invoice_ref FROM receipts r LEFT JOIN invoices i ON i.id = r.invoice_id
    WHERE (r.order_id = ? OR r.invoice_id IN (SELECT id FROM invoices WHERE order_id = ?)) ORDER BY r.effective_date, r.id`, orderId, orderId);
  const hold = get('SELECT h.*, u.name AS authorised_by_name FROM payment_holds h LEFT JOIN users u ON u.id = h.authorised_by WHERE h.order_id = ? AND h.released_at IS NULL', orderId);
  return {
    currency: o.currency,
    value_minor: value,
    advance_pct: o.advance_pct,
    advance_required_minor: o.advance_required_minor,
    advance_received_minor: advance,
    invoiced_minor: invoices.reduce((s, i) => s + i.gross_minor, 0),
    outstanding_minor: invoices.reduce((s, i) => s + Math.max(0, i.outstanding_minor), 0),
    invoices,
    receipts,
    hold,
  };
}

export function invoiceDetail(id) {
  const i = get(`SELECT i.*, c.company_name, o.code AS order_code, d.code AS dispatch_code, ${OUTSTANDING()} AS outstanding_minor FROM invoices i JOIN customers c ON c.id = i.customer_id
    LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN dispatches d ON d.id = i.dispatch_id WHERE i.id = ?`, id);
  if (!i) throw notFound('Invoice');
  return {
    invoice: { ...i, bucket: i.outstanding_minor > 0 ? ageingBucket(i.due_date) : null },
    receipts: all('SELECT r.*, u.name AS created_by_name, ru.name AS reversed_by_name FROM receipts r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users ru ON ru.id = r.reversed_by WHERE r.invoice_id = ? ORDER BY r.effective_date, r.id', id),
  };
}

const money = (c, field, v, { required = false, label = 'Amount', allowZero = true } = {}) => {
  const m = toMinor(v);
  if (m === null) {
    if (required) c.fail(field, `${label} is required`);
    return null;
  }
  if (Number.isNaN(m) || m < 0 || (!allowZero && m === 0)) {
    c.fail(field, `Enter a valid ${label.toLowerCase()} (up to 2 decimals)`);
    return null;
  }
  return m;
};

export function createInvoice(input, user) {
  const c = new Check();
  c.text('invoice_ref', input.invoice_ref, { required: true, max: 60, label: 'Invoice reference' });
  const customerId = intId(input.customer_id) || (input.order_id ? get('SELECT customer_id FROM orders WHERE id = ?', intId(input.order_id))?.customer_id : null);
  if (!customerId || !get('SELECT id FROM customers WHERE id = ?', customerId)) c.fail('customer_id', 'Choose the customer');
  const order = input.order_id ? get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', intId(input.order_id), customerId) : null;
  if (input.order_id && !order) c.fail('order_id', 'Choose an order of this customer');
  if (input.dispatch_id && !get('SELECT id FROM dispatches WHERE id = ? AND customer_id = ?', intId(input.dispatch_id), customerId)) c.fail('dispatch_id', 'Choose a dispatch of this customer');
  c.date('invoice_date', input.invoice_date, { required: true });
  c.date('due_date', input.due_date, { required: true });
  if (input.invoice_date && input.due_date && input.due_date < input.invoice_date) c.fail('due_date', 'The due date cannot be before the invoice date');
  const currency = input.currency || order?.currency;
  if (!CURRENCIES.includes(currency)) c.fail('currency', 'Choose the currency');
  if (order?.currency && currency && order.currency !== currency) c.fail('currency', `The order is in ${order.currency}`);
  const gross = money(c, 'gross_amount', input.gross_amount, { required: true, label: 'Invoice amount' });
  const taxable = money(c, 'taxable_amount', input.taxable_amount, { label: 'Taxable value' });
  const tax = money(c, 'tax_amount', input.tax_amount, { label: 'Tax' });
  const adjust = money(c, 'advance_adjusted', input.advance_adjusted, { label: 'Advance adjusted' }) || 0;
  if (gross !== null && adjust > gross) c.fail('advance_adjusted', 'Cannot adjust more advance than the invoice amount');
  if (order && adjust > 0) {
    const available = get("SELECT COALESCE(SUM(amount_minor + tds_minor + other_deduction_minor), 0) AS n FROM receipts WHERE order_id = ? AND kind = 'advance' AND reversed_at IS NULL", order.id).n
      - get('SELECT COALESCE(SUM(advance_adjusted_minor), 0) AS n FROM invoices WHERE order_id = ?', order.id).n;
    if (adjust > available) c.fail('advance_adjusted', `Only ${(available / 100).toFixed(2)} of advance is available to adjust on this order`);
  } else if (adjust > 0) c.fail('advance_adjusted', 'Link the order to adjust its advance');
  if (input.owner_id) requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Collection owner');
  c.throwIfAny();
  if (get('SELECT id FROM invoices WHERE customer_id = ? AND invoice_ref = ?', customerId, str(input.invoice_ref, 60))) throw conflict('This invoice reference already exists for the customer');
  const stamp = nowIso();
  const id = insert('invoices', {
    invoice_ref: str(input.invoice_ref, 60), customer_id: customerId, order_id: order?.id ?? null, dispatch_id: intId(input.dispatch_id), invoice_date: input.invoice_date, due_date: input.due_date,
    currency, taxable_minor: taxable, tax_minor: tax, gross_minor: gross, advance_adjusted_minor: adjust, source: str(input.source, 60) || 'manual', external_ref: str(input.external_ref, 80),
    owner_id: intId(input.owner_id) || order?.accounts_owner_id || null, notes: str(input.notes, 500), created_by: user.id, created_at: stamp, updated_at: stamp,
  });
  audit('invoice', id, 'create', { invoice_ref: input.invoice_ref, gross_minor: gross, currency, advance_adjusted_minor: adjust });
  return { id };
}

function closeCollectionTasks(invoiceId, user) {
  for (const t of all("SELECT id FROM tasks WHERE invoice_id = ? AND status = 'open'", invoiceId)) {
    run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?", nowIso(), user.id, nowIso(), nowIso(), t.id);
  }
}

/**
 * A receipt (cash received, plus TDS and other deductions) or a credit note against an invoice.
 * Corrections are reversals with a reason, never edits.
 */
export function recordReceipt(invoiceId, input, user) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw notFound('Invoice');
  const c = new Check();
  const kind = input.kind || 'receipt';
  if (!['receipt', 'credit'].includes(kind)) c.fail('kind', 'Choose receipt or credit note');
  const amount = money(c, 'amount', input.amount, { required: true, label: kind === 'credit' ? 'Credit amount' : 'Amount received' }) ?? 0;
  const tds = kind === 'credit' ? 0 : money(c, 'tds_amount', input.tds_amount, { label: 'TDS' }) || 0;
  const other = kind === 'credit' ? 0 : money(c, 'other_deduction', input.other_deduction, { label: 'Other deduction' }) || 0;
  if (amount + tds + other <= 0) c.fail('amount', 'Enter the amount received');
  if (other > 0 && !str(input.deduction_note)) c.fail('deduction_note', 'Explain the deduction');
  c.date('effective_date', input.effective_date, { required: true });
  if (input.effective_date && input.effective_date > today()) c.fail('effective_date', 'A receipt cannot be in the future — a promise is not a receipt');
  if (input.mode && !PAYMENT_MODES.some((m) => m.value === input.mode)) c.fail('mode', 'Choose the payment mode');
  c.text('reference', input.reference, { max: 80, label: 'Reference', required: kind === 'credit' });
  if (kind === 'credit') c.text('note', input.note, { required: true, max: 500, label: 'Reason for the credit note' });
  c.throwIfAny();
  return tx(() => {
    const id = insert('receipts', {
      invoice_id: invoiceId, order_id: inv.order_id, customer_id: inv.customer_id, kind, currency: inv.currency, amount_minor: amount, tds_minor: tds, other_deduction_minor: other,
      deduction_note: str(input.deduction_note, 300), mode: input.mode || null, effective_date: input.effective_date, reference: str(input.reference, 80),
      source: str(input.source, 60) || 'manual', note: str(input.note, 500), created_by: user.id, created_at: nowIso(),
    });
    const outstanding = get(`SELECT ${OUTSTANDING()} AS o FROM invoices i WHERE i.id = ?`, invoiceId).o;
    if (outstanding <= 0) {
      update('invoices', invoiceId, { promise_date: null, updated_at: nowIso() });
      closeCollectionTasks(invoiceId, user);
    }
    audit('receipt', id, 'create', { invoice_id: invoiceId, kind, amount_minor: amount, tds_minor: tds, other_deduction_minor: other });
    return { id, outstanding_minor: outstanding };
  });
}

/** Advance received against a confirmed order before invoicing (releases nothing automatically). */
export function recordAdvance(orderId, input, user) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order');
  const c = new Check();
  const amount = money(c, 'amount', input.amount, { required: true, label: 'Advance received', allowZero: false });
  const tds = money(c, 'tds_amount', input.tds_amount, { label: 'TDS' }) || 0;
  c.date('effective_date', input.effective_date, { required: true });
  if (input.effective_date && input.effective_date > today()) c.fail('effective_date', 'A receipt cannot be in the future');
  if (input.mode && !PAYMENT_MODES.some((m) => m.value === input.mode)) c.fail('mode', 'Choose the payment mode');
  c.text('reference', input.reference, { max: 80, label: 'Reference' });
  if (!o.currency) c.fail('amount', 'Set the order currency first (enter prices on the order)');
  c.throwIfAny();
  const id = insert('receipts', {
    order_id: orderId, customer_id: o.customer_id, kind: 'advance', currency: o.currency, amount_minor: amount, tds_minor: tds, other_deduction_minor: 0, mode: input.mode || null,
    effective_date: input.effective_date, reference: str(input.reference, 80), source: str(input.source, 60) || 'manual', note: str(input.note, 500), created_by: user.id, created_at: nowIso(),
  });
  history('order', orderId, 'advance_received', { customerId: o.customer_id, data: { amount_minor: amount, currency: o.currency, reference: input.reference } });
  audit('receipt', id, 'advance', { order_id: orderId, amount_minor: amount });
  return { id };
}

export function listReceipts(query, user) {
  const where = ['1 = 1'];
  const params = [];
  const scope = customerScope(user, 'c');
  if (scope) where.push(scope);
  for (const k of ['customer_id', 'order_id', 'invoice_id']) {
    if (intId(query[k])) {
      where.push(`r.${k} = ?`);
      params.push(intId(query[k]));
    }
  }
  if (query.kind) {
    where.push('r.kind = ?');
    params.push(query.kind);
  }
  if (query.from) {
    where.push('r.effective_date >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('r.effective_date <= ?');
    params.push(query.to);
  }
  return all(`SELECT r.*, c.company_name, i.invoice_ref, o.code AS order_code, u.name AS created_by_name
    FROM receipts r JOIN customers c ON c.id = r.customer_id LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = r.created_by
    WHERE ${where.join(' AND ')} ORDER BY r.effective_date DESC, r.id DESC LIMIT 500`, ...params);
}

export function reverseReceipt(receiptId, input, user) {
  const r = get('SELECT * FROM receipts WHERE id = ?', receiptId);
  if (!r) throw notFound('Receipt');
  if (r.reversed_at) throw conflict('Already reversed');
  if (!str(input.reason)) throw badRequest('Give a reason for the correction', { reason: 'Required' });
  if (r.kind === 'advance') {
    const adjusted = get('SELECT COALESCE(SUM(advance_adjusted_minor), 0) AS n FROM invoices WHERE order_id = ?', r.order_id).n;
    const remaining = get("SELECT COALESCE(SUM(amount_minor + tds_minor + other_deduction_minor), 0) AS n FROM receipts WHERE order_id = ? AND kind = 'advance' AND reversed_at IS NULL AND id <> ?", r.order_id, r.id).n;
    if (adjusted > remaining) throw conflict('This advance has already been adjusted against an invoice — correct the invoice first');
  }
  update('receipts', receiptId, { reversed_at: nowIso(), reversed_by: user.id, reversal_reason: str(input.reason, 300) });
  audit('receipt', receiptId, 'reverse', { reason: input.reason });
  return { id: receiptId };
}

/** Records the customer's payment promise as a follow-up — not as money received. */
export function setPromise(invoiceId, input, user) {
  const inv = get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw notFound('Invoice');
  const c = new Check();
  c.date('promise_date', input.promise_date, { required: true });
  c.note('note', input.note);
  c.throwIfAny();
  return tx(() => {
    update('invoices', invoiceId, { promise_date: input.promise_date, promise_note: str(input.note, 500), updated_at: nowIso(), version: inv.version + 1 });
    const owner = inv.owner_id || user.id;
    createTask({ invoice_id: invoiceId, customer_id: inv.customer_id, purpose: `Check payment promised for ${input.promise_date} — ${inv.invoice_ref}`, owner_id: owner, due_date: input.promise_date, kind: 'internal', source: 'payment_promise' }, user, { validated: true });
    history('customer', inv.customer_id, 'payment_promise', { customerId: inv.customer_id, data: { invoice: inv.invoice_ref, promise_date: input.promise_date }, note: str(input.note, 500) });
    audit('invoice', invoiceId, 'promise', { promise_date: input.promise_date });
    return { id: invoiceId };
  });
}

export function placeHold(orderId, input, user) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) throw notFound('Order');
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Hold reason' });
  c.throwIfAny();
  if (get('SELECT id FROM payment_holds WHERE order_id = ? AND released_at IS NULL', orderId)) throw conflict('This order already has an active payment hold');
  const stamp = nowIso();
  const id = insert('payment_holds', { order_id: orderId, customer_id: o.customer_id, reason: str(input.reason, 300), authorised_by: user.id, held_at: stamp, created_by: user.id, created_at: stamp });
  history('order', orderId, 'payment_hold', { customerId: o.customer_id, data: { code: o.code }, note: str(input.reason, 300) });
  audit('payment_hold', id, 'place', { order_id: orderId, reason: input.reason });
  return { id };
}

export function releaseHold(holdId, input, user) {
  const h = get('SELECT * FROM payment_holds WHERE id = ?', holdId);
  if (!h) throw notFound('Hold');
  if (h.released_at) throw conflict('Already released');
  const c = new Check();
  c.text('evidence', input.evidence, { required: true, max: 500, label: 'Release evidence' });
  c.throwIfAny();
  return tx(() => {
    update('payment_holds', holdId, { release_evidence: str(input.evidence, 500), release_document_id: intId(input.document_id), released_at: nowIso(), released_by: user.id });
    if (input.document_id) linkAttachment(intId(input.document_id), 'payment_hold', holdId, user);
    const t = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", `release_hold:${h.order_id}`);
    if (t) run("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, completed_late = CASE WHEN ? >= overdue_at THEN 1 ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?", nowIso(), user.id, nowIso(), nowIso(), t.id);
    history('order', h.order_id, 'payment_hold_released', { customerId: h.customer_id, note: str(input.evidence, 500) });
    audit('payment_hold', holdId, 'release', { evidence: input.evidence });
    return { id: holdId };
  });
}

export function setFinanceAsOf(input, user) {
  const c = new Check();
  c.date('as_of', input.as_of, { required: true });
  if (!['reconciled', 'not_reconciled'].includes(input.reconciliation)) c.fail('reconciliation', 'Choose the reconciliation status');
  c.throwIfAny();
  setSetting('finance', { asOf: input.as_of, reconciliation: input.reconciliation, source: str(input.source, 80) || 'Manual entry' }, user.id);
  audit('settings', null, 'finance_as_of', input);
  return settings().finance;
}
