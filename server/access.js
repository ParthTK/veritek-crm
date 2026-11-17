// Row-level visibility and field redaction. Every list and detail query goes through these, so a
// hidden button is never the only protection.
//
// Scope comes from the role (shared/constants.js ROLES): all, region (the user's region plus anything they
// own), own (customers and work the user owns) or factory (confirmed orders at the user's factory).
import { get } from './db.js';
import { forbidden, notFound, settings } from './util.js';

const id = (v) => Number(v) || 0;

/** The effective scope: sales executives see everything when the configured sales scope is "all". */
export function effectiveScope(user) {
  if (user.scope === 'own' && user.group === 'sales' && settings().access.salesScope === 'all') return 'all';
  return user.scope || 'own';
}

/** True when the user is limited to their own customers (used by a few write rules). */
export function salesRestricted(user) {
  return user.group === 'sales' && effectiveScope(user) === 'own';
}

const ownCustomers = (u) => `(SELECT id FROM customers WHERE owner_id = ${u})`;
const regionCustomers = (u, r) => `(SELECT id FROM customers WHERE region_id = ${r} OR owner_id = ${u})`;
const factoryOrders = (user, o = 'o') => (user.factory_id
  ? `(${o}.status = 'confirmed' AND (${o}.factory_id = ${id(user.factory_id)} OR ${o}.factory_id IS NULL))`
  : `${o}.status = 'confirmed'`);

/** SQL predicate limiting customers (alias c), or '' for full visibility. */
export function customerScope(user, c = 'c') {
  const scope = effectiveScope(user);
  if (scope === 'all') return '';
  const u = id(user.id);
  if (scope === 'region') {
    return `(${c}.region_id = ${id(user.region_id)} OR ${c}.owner_id = ${u}
      OR ${c}.id IN (SELECT customer_id FROM enquiries WHERE owner_id = ${u})
      OR ${c}.id IN (SELECT customer_id FROM orders WHERE owner_id = ${u}))`;
  }
  if (scope === 'factory') return `${c}.id IN (SELECT o.customer_id FROM orders o WHERE ${factoryOrders(user)})`;
  return `(${c}.owner_id = ${u}
    OR ${c}.id IN (SELECT customer_id FROM enquiries WHERE owner_id = ${u})
    OR ${c}.id IN (SELECT customer_id FROM orders WHERE owner_id = ${u})
    OR ${c}.id IN (SELECT customer_id FROM tasks WHERE owner_id = ${u} AND status = 'open' AND customer_id IS NOT NULL))`;
}

export function enquiryScope(user, e = 'e') {
  const scope = effectiveScope(user);
  if (scope === 'all') return '';
  const u = id(user.id);
  if (scope === 'region') return `(${e}.owner_id = ${u} OR ${e}.customer_id IN ${regionCustomers(u, id(user.region_id))})`;
  if (scope === 'factory') return '1 = 0';
  return `(${e}.owner_id = ${u} OR ${e}.customer_id IN ${ownCustomers(u)})`;
}

export function quotationScope(user, q = 'q') {
  const scope = effectiveScope(user);
  if (scope === 'all') return '';
  const u = id(user.id);
  if (scope === 'region') return `(${q}.owner_id = ${u} OR ${q}.prepared_by = ${u} OR ${q}.customer_id IN ${regionCustomers(u, id(user.region_id))})`;
  if (scope === 'factory') return '1 = 0';
  return `(${q}.owner_id = ${u} OR ${q}.prepared_by = ${u} OR ${q}.customer_id IN ${ownCustomers(u)}
    OR ${q}.enquiry_id IN (SELECT id FROM enquiries WHERE owner_id = ${u}))`;
}

export function orderScope(user, o = 'o') {
  const scope = effectiveScope(user);
  if (scope === 'all') return '';
  const u = id(user.id);
  if (scope === 'region') return `(${o}.owner_id = ${u} OR ${o}.customer_id IN ${regionCustomers(u, id(user.region_id))})`;
  if (scope === 'factory') return factoryOrders(user, o);
  return `(${o}.owner_id = ${u} OR ${o}.customer_id IN ${ownCustomers(u)})`;
}

export function taskScope(user, t = 't') {
  const scope = effectiveScope(user);
  if (scope === 'all') return '';
  const u = id(user.id);
  if (scope === 'factory') return `(${t}.owner_id = ${u} OR (${t}.order_id IS NOT NULL AND ${t}.kind = 'internal'))`;
  return `(${t}.owner_id = ${u} OR ${t}.customer_id IN (SELECT c.id FROM customers c WHERE ${customerScope(user, 'c')}))`;
}

/** Complaints: service and quality handle every complaint; others follow customer visibility plus their own. */
export function complaintScope(user, k = 'k') {
  if (user.group === 'service' || user.role === 'quality') return '';
  const cs = customerScope(user, 'cs');
  if (!cs) return '';
  return `(${k}.owner_id = ${id(user.id)} OR ${k}.customer_id IN (SELECT cs.id FROM customers cs WHERE ${cs}))`;
}

function assertVisible(table, alias, scope, rowId, label) {
  const row = get(`SELECT ${alias}.id FROM ${table} ${alias} WHERE ${alias}.id = ? ${scope ? `AND ${scope}` : ''}`, rowId);
  if (!row) {
    const exists = get(`SELECT id FROM ${table} WHERE id = ?`, rowId);
    throw exists ? forbidden(`This ${label} is outside your access`) : notFound(label);
  }
}

export const assertCustomer = (user, cid) => assertVisible('customers', 'c', customerScope(user, 'c'), cid, 'customer');
export const assertEnquiry = (user, eid) => assertVisible('enquiries', 'e', enquiryScope(user, 'e'), eid, 'enquiry');
export const assertQuotation = (user, qid) => assertVisible('quotations', 'q', quotationScope(user, 'q'), qid, 'quotation');
export const assertOrder = (user, oid) => assertVisible('orders', 'o', orderScope(user, 'o'), oid, 'order');
export const assertTask = (user, tid) => assertVisible('tasks', 't', taskScope(user, 't'), tid, 'task');
export const assertComplaint = (user, kid) => assertVisible('complaints', 'k', complaintScope(user, 'k'), kid, 'complaint');

// Commercial values: money in minor units and per-currency totals.
const VALUE_KEY = /(_minor$|^value_by_currency$|^totals_by_currency$|^currency_totals$|^won_back_value$|^by_currency$|^weighted$|^pipeline$|^quoted_value$|^revenue$|^influenced_revenue$|^roi_multiple$)/;
// Cost and margin: hidden from everyone without margin access (even when they see selling prices).
const MARGIN_KEY = /^(cost_price|cost_delta|cost_total|margin_pct|margin_minor|min_price)/;
// Full finance: TDS, deductions, bank references and credit limits.
const FINANCE_KEY = /^(tds_minor|other_deduction_minor|deduction_note|credit_limit_minor|bank_reference)$/;

/** Strips values the user may not see. Works on nested objects and arrays. */
export function redact(user, data) {
  const perms = user.permissions || [];
  const hideValues = !user.values_access;
  const hideMargin = !perms.includes('margin.view');
  const hideFinance = !perms.includes('finance.full');
  if (!hideValues && !hideMargin && !hideFinance) return data;
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (hideMargin && MARGIN_KEY.test(k)) continue;
      if (hideFinance && FINANCE_KEY.test(k)) continue;
      if (hideValues && VALUE_KEY.test(k)) continue;
      out[k] = x && typeof x === 'object' ? strip(x) : x;
    }
    return out;
  };
  return strip(data);
}
