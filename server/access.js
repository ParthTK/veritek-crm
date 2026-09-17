// Row-level scoping (region / assigned salesperson / factory) and field-level redaction.
import { can } from '../shared/constants.js';
import { get } from './db.js';
import { forbidden, notFound } from './util.js';

const id = (v) => Number(v) || 0;

/** SQL predicate limiting customers (alias `c`) to what the user may see, or '' for everything. */
export function customerScope(user, c = 'c') {
  switch (user.scope) {
    case 'region':
      return `(${c}.region_id = ${id(user.region_id)} OR ${c}.assigned_to = ${id(user.id)})`;
    case 'own':
      return `(${c}.assigned_to = ${id(user.id)} OR ${c}.id IN (SELECT customer_id FROM leads WHERE assigned_to = ${id(user.id)}))`;
    case 'factory':
      return user.factory_id
        ? `${c}.id IN (SELECT customer_id FROM sales_orders WHERE factory_id = ${id(user.factory_id)})`
        : '';
    default:
      return '';
  }
}

export function leadScope(user, l = 'l') {
  switch (user.scope) {
    case 'region':
      return `(${l}.assigned_to = ${id(user.id)} OR ${l}.customer_id IN (SELECT id FROM customers WHERE region_id = ${id(user.region_id)}))`;
    case 'own':
      return `(${l}.assigned_to = ${id(user.id)} OR ${l}.customer_id IN (SELECT id FROM customers WHERE assigned_to = ${id(user.id)}))`;
    case 'factory':
      return '1 = 0';
    default:
      return '';
  }
}

export function quotationScope(user, q = 'q') {
  switch (user.scope) {
    case 'region':
      return `(${q}.owner_id = ${id(user.id)} OR ${q}.customer_id IN (SELECT id FROM customers WHERE region_id = ${id(user.region_id)}))`;
    case 'own':
      return `(${q}.owner_id = ${id(user.id)} OR ${q}.customer_id IN (SELECT id FROM customers WHERE assigned_to = ${id(user.id)}))`;
    case 'factory':
      return '1 = 0';
    default:
      return '';
  }
}

export function orderScope(user, o = 'o') {
  switch (user.scope) {
    case 'region':
      return `(${o}.sales_owner_id = ${id(user.id)} OR ${o}.customer_id IN (SELECT id FROM customers WHERE region_id = ${id(user.region_id)}))`;
    case 'own':
      return `(${o}.sales_owner_id = ${id(user.id)} OR ${o}.customer_id IN (SELECT id FROM customers WHERE assigned_to = ${id(user.id)}))`;
    case 'factory':
      return user.factory_id ? `${o}.factory_id = ${id(user.factory_id)}` : '';
    default:
      return '';
  }
}

/** Complaints follow customer visibility, plus anything assigned to the user. */
export function complaintScope(user, k = 'k') {
  if (user.role === 'service' || user.role === 'quality') return '';
  const cs = customerScope(user, 'cs');
  if (!cs) return '';
  return `(${k}.assigned_to = ${id(user.id)} OR ${k}.customer_id IN (SELECT cs.id FROM customers cs WHERE ${cs}))`;
}

function assertVisible(table, alias, scopeFn, user, rowId, label) {
  const scope = scopeFn(user, alias);
  const row = get(`SELECT ${alias}.id FROM ${table} ${alias} WHERE ${alias}.id = ? ${scope ? `AND ${scope}` : ''}`, rowId);
  if (!row) {
    const exists = get(`SELECT id FROM ${table} WHERE id = ?`, rowId);
    throw exists ? forbidden(`This ${label} is outside your access scope`) : notFound(label);
  }
}

export const assertCustomer = (user, cid) => assertVisible('customers', 'c', customerScope, user, cid, 'customer');
export const assertLead = (user, lid) => assertVisible('leads', 'l', leadScope, user, lid, 'lead');
export const assertQuotation = (user, qid) => assertVisible('quotations', 'q', quotationScope, user, qid, 'quotation');
export const assertOrder = (user, oid) => assertVisible('sales_orders', 'o', orderScope, user, oid, 'order');

const VALUE_FIELDS = [
  'estimated_value', 'grand_total', 'subtotal', 'taxable_total', 'tax_total', 'discount_total', 'list_total',
  'freight', 'installation', 'unit_price', 'list_price', 'taxable', 'tax', 'total', 'advance_required',
  'order_value', 'invoiced', 'received', 'outstanding', 'amount', 'value', 'revenue', 'advance_received',
  'standard_price', 'dealer_price', 'distributor_price', 'min_price', 'lifetime_value', 'balance', 'paid',
  'weighted_value', 'pipeline_value', 'won_value', 'quoted_value', 'credit_limit',
];
const MARGIN_FIELDS = ['cost_price', 'cost_total', 'margin_pct', 'margin', 'cost_delta', 'min_price'];
const FULL_FINANCE_FIELDS = ['tds_amount', 'other_deduction', 'deduction_note', 'reference', 'credit_limit', 'credits', 'deductions'];

/** Remove fields the user's role should not see. Works on objects, arrays and nested arrays. */
export function redact(user, data) {
  const hideValues = !can(user.role, 'finance.values');
  const hideMargin = !can(user.role, 'margin.view');
  const hideFull = !can(user.role, 'finance.full');
  if (!hideValues && !hideMargin && !hideFull) return data;
  const strip = (obj) => {
    if (Array.isArray(obj)) return obj.map(strip);
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (hideValues && VALUE_FIELDS.includes(k)) continue;
      if (hideMargin && MARGIN_FIELDS.includes(k)) continue;
      if (hideFull && FULL_FINANCE_FIELDS.includes(k)) continue;
      out[k] = v && typeof v === 'object' ? strip(v) : v;
    }
    return out;
  };
  return strip(data);
}
