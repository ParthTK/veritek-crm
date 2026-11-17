// Team view: people with their workload, monthly sales targets against confirmed orders, and performance
// shown together with workload and outcome scope (activity counts are not sales output).
import { all, get, run, tx } from '../db.js';
import {
  Check, forbidden, nowIso, today, tz, settings, intId, audit, placeholders,
} from '../util.js';
import { localDate, addDays } from '../../shared/dates.js';
import { OPEN_ENQUIRY_STAGES, groupOf, labelOf, ROLES } from '../../shared/constants.js';
import { toMinor } from '../../shared/rules.js';

const OPEN = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
const SALES_ROLES = ['sales_head', 'regional_manager', 'sales_executive', 'commercial'];

function regionLimit(user, alias = 'u') {
  return user.scope === 'region' ? ` AND (${alias}.region_id = ${Number(user.region_id) || 0} OR ${alias}.id = ${Number(user.id)})` : '';
}

/** Financial-year months (April start by default) containing the given date. */
export function fyMonths(ref = today()) {
  const startMonth = settings().company.fiscalYearStartMonth || 4;
  const [y, m] = ref.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const mm = ((startMonth - 1 + i) % 12) + 1;
    const yy = startYear + Math.floor((startMonth - 1 + i) / 12);
    return `${yy}-${String(mm).padStart(2, '0')}`;
  });
}

export function teamMembers(user) {
  const day = today();
  return all(`SELECT u.id, u.name, u.email, u.role, u.department, u.designation, u.phone, u.region_id, u.factory_id, u.manager_id, u.active, u.login_enabled, u.last_login_at,
      rg.name AS region_name, f.name AS factory_name, m.name AS manager_name,
      (SELECT COUNT(*) FROM enquiries e WHERE e.owner_id = u.id AND e.stage IN (${OPEN})) AS open_enquiries,
      (SELECT COUNT(*) FROM customers c WHERE c.owner_id = u.id AND c.merged_into_id IS NULL AND c.archived_at IS NULL) AS customers,
      (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id AND t.status = 'open') AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id AND t.status = 'open' AND t.due_date < ?) AS overdue_tasks,
      (SELECT COUNT(*) FROM orders o WHERE o.owner_id = u.id AND o.status = 'confirmed' AND o.closed_at IS NULL) AS active_orders
    FROM users u LEFT JOIN regions rg ON rg.id = u.region_id LEFT JOIN factories f ON f.id = u.factory_id LEFT JOIN users m ON m.id = u.manager_id
    WHERE 1 = 1 ${regionLimit(user)} ORDER BY u.active DESC, u.name`, day)
    .map((u) => ({ ...u, group: groupOf(u.role), role_label: labelOf(ROLES, u.role) }));
}

/** Confirmed order value (before tax, net of cancellations) by owner and month of confirmation, per currency. */
function achievedByOwner(fromMonth, toMonth) {
  const rows = all(`SELECT o.owner_id, o.currency, o.confirmed_at,
      (SELECT SUM(CASE WHEN l.unit_price_minor IS NULL THEN NULL ELSE ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) FROM order_lines l WHERE l.order_id = o.id) AS value_minor,
      (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.unit_price_minor IS NULL) AS unpriced
    FROM orders o WHERE o.status = 'confirmed' AND o.confirmed_at IS NOT NULL AND o.confirmed_at >= ?`, `${addDays(`${fromMonth}-01`, -1)}T00:00:00Z`);
  const out = {};
  for (const r of rows) {
    const month = localDate(new Date(r.confirmed_at), tz()).slice(0, 7);
    if (month < fromMonth || month > toMonth) continue;
    const k = `${r.owner_id}|${month}|${r.currency || 'INR'}`;
    out[k] ||= { value_minor: 0, orders: 0, unpriced: 0 };
    out[k].orders++;
    out[k].value_minor += r.value_minor || 0;
    if (r.unpriced) out[k].unpriced++;
  }
  return out;
}

export function targetsView(query, user) {
  const months = fyMonths(query.ref || today());
  const currency = query.currency || settings().company.currency || 'INR';
  const people = all(`SELECT u.id, u.name, u.role, rg.name AS region_name FROM users u LEFT JOIN regions rg ON rg.id = u.region_id
    WHERE u.active = 1 AND u.role IN (${SALES_ROLES.map(() => '?').join(',')}) ${regionLimit(user)} ORDER BY rg.name, u.name`, ...SALES_ROLES);
  const targets = all('SELECT * FROM sales_targets WHERE month BETWEEN ? AND ? AND currency = ?', months[0], months[11], currency);
  const achieved = achievedByOwner(months[0], months[11]);
  const otherCurrencies = {};
  for (const [k, v] of Object.entries(achieved)) {
    const [, , cur] = k.split('|');
    if (cur !== currency) otherCurrencies[cur] = (otherCurrencies[cur] || 0) + v.value_minor;
  }
  return {
    months,
    currency,
    users: people.map((u) => ({
      ...u,
      role_label: labelOf(ROLES, u.role),
      targets: Object.fromEntries(months.map((m) => [m, targets.find((t) => t.user_id === u.id && t.month === m)?.amount_minor ?? null])),
      achieved: Object.fromEntries(months.map((m) => [m, achieved[`${u.id}|${m}|${currency}`]?.value_minor ?? 0])),
      unpriced_orders: months.reduce((s, m) => s + (achieved[`${u.id}|${m}|${currency}`]?.unpriced || 0), 0),
    })),
    other_currencies: otherCurrencies,
    note: `Achievement = confirmed orders in ${currency} (value before tax, net of cancellations) by month of confirmation. Orders in other currencies are not converted.`,
  };
}

export function saveTargets(input, user) {
  if (!['super_admin', 'management', 'sales_head'].includes(user.role)) throw forbidden('Only the sales head or management can set targets');
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const currency = input.currency || settings().company.currency || 'INR';
  const c = new Check();
  entries.forEach((e, i) => {
    if (!/^\d{4}-\d{2}$/.test(e.month)) c.fail(`entries.${i}.month`, 'Use YYYY-MM');
    const m = e.amount === '' || e.amount === null || e.amount === undefined ? null : toMinor(e.amount);
    if (Number.isNaN(m) || (m !== null && m < 0)) c.fail(`entries.${i}.amount`, 'Enter a valid amount');
    if (!get('SELECT id FROM users WHERE id = ?', intId(e.user_id))) c.fail(`entries.${i}.user_id`, 'Unknown person');
  });
  c.throwIfAny();
  tx(() => {
    for (const e of entries) {
      const m = e.amount === '' || e.amount === null || e.amount === undefined ? null : toMinor(e.amount);
      if (m === null) run('DELETE FROM sales_targets WHERE user_id = ? AND month = ? AND currency = ?', intId(e.user_id), e.month, currency);
      else {
        run(`INSERT INTO sales_targets (user_id, month, currency, amount_minor, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, month, currency) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        intId(e.user_id), e.month, currency, m, nowIso(), user.id);
      }
    }
  });
  audit('targets', null, 'update', { entries: entries.length, currency });
  return { ok: true };
}

/**
 * Performance with its scope: workload (open enquiries, customers, open tasks) next to outcomes (quotes
 * issued, orders, wins and losses decided in the period) and follow-up discipline. Calls logged are activity.
 */
export function performance(query, user) {
  const to = query.to || today();
  const from = query.from || addDays(to, -89);
  const people = all(`SELECT u.id, u.name, u.role, rg.name AS region_name FROM users u LEFT JOIN regions rg ON rg.id = u.region_id
    WHERE u.role IN (${SALES_ROLES.map(() => '?').join(',')}) ${regionLimit(user)} ORDER BY u.active DESC, u.name`, ...SALES_ROLES);
  if (!people.length) return { from, to, rows: [] };
  const ids = people.map((p) => p.id);
  const fromI = `${from}T00:00:00.000Z`;
  const toI = `${addDays(to, 1)}T00:00:00.000Z`;
  const count = (sql, ...params) => Object.fromEntries(all(sql, ...params).map((r) => [r.k, r.n]));
  const received = count(`SELECT owner_id AS k, COUNT(*) AS n FROM enquiries WHERE owner_id IN (${placeholders(ids)}) AND received_at >= ? AND received_at < ? GROUP BY owner_id`, ...ids, fromI, toI);
  const won = count(`SELECT owner_id AS k, COUNT(*) AS n FROM enquiries WHERE owner_id IN (${placeholders(ids)}) AND stage = 'won' AND decided_at >= ? AND decided_at < ? GROUP BY owner_id`, ...ids, fromI, toI);
  const lost = count(`SELECT owner_id AS k, COUNT(*) AS n FROM enquiries WHERE owner_id IN (${placeholders(ids)}) AND stage = 'lost' AND decided_at >= ? AND decided_at < ? GROUP BY owner_id`, ...ids, fromI, toI);
  const quotes = count(`SELECT q.owner_id AS k, COUNT(*) AS n FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.owner_id IN (${placeholders(ids)}) AND r.sent_at >= ? AND r.sent_at < ? GROUP BY q.owner_id`, ...ids, fromI, toI);
  const contacts = count(`SELECT entered_by AS k, COUNT(*) AS n FROM activities WHERE entered_by IN (${placeholders(ids)}) AND customer_contact = 1 AND occurred_at >= ? AND occurred_at < ? GROUP BY entered_by`, ...ids, fromI, toI);
  const doneTasks = all(`SELECT owner_id AS k, COUNT(*) AS n, SUM(CASE WHEN completed_late = 0 THEN 1 ELSE 0 END) AS on_time FROM tasks
    WHERE owner_id IN (${placeholders(ids)}) AND status = 'done' AND completed_at >= ? AND completed_at < ? GROUP BY owner_id`, ...ids, fromI, toI);
  const orderRows = all(`SELECT o.owner_id, o.currency, COUNT(*) AS n,
      SUM((SELECT SUM(CASE WHEN l.unit_price_minor IS NULL THEN 0 ELSE ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) FROM order_lines l WHERE l.order_id = o.id)) AS value_minor
    FROM orders o WHERE o.owner_id IN (${placeholders(ids)}) AND o.status = 'confirmed' AND o.confirmed_at >= ? AND o.confirmed_at < ? GROUP BY o.owner_id, o.currency`, ...ids, fromI, toI);
  const members = Object.fromEntries(teamMembers(user).map((m) => [m.id, m]));
  return {
    from, to,
    note: 'Outcomes are shown with workload. Contacts logged are activity, not sales output; order value is before tax and is not revenue or margin.',
    rows: people.map((p) => {
      const t = doneTasks.find((x) => x.k === p.id);
      const decided = (won[p.id] || 0) + (lost[p.id] || 0);
      const orders = orderRows.filter((o) => o.owner_id === p.id);
      return {
        ...p,
        role_label: labelOf(ROLES, p.role),
        workload: { open_enquiries: members[p.id]?.open_enquiries ?? 0, customers: members[p.id]?.customers ?? 0, open_tasks: members[p.id]?.open_tasks ?? 0, overdue_tasks: members[p.id]?.overdue_tasks ?? 0 },
        enquiries_received: received[p.id] || 0,
        quotes_issued: quotes[p.id] || 0,
        won: won[p.id] || 0,
        lost: lost[p.id] || 0,
        win_rate_pct: decided ? Math.round(((won[p.id] || 0) / decided) * 1000) / 10 : null,
        decided,
        orders: orders.reduce((s, o) => s + o.n, 0),
        order_value_by_currency: Object.fromEntries(orders.map((o) => [o.currency || 'INR', o.value_minor || 0])),
        contacts_logged: contacts[p.id] || 0,
        tasks_done: t?.n || 0,
        tasks_on_time_pct: t?.n ? Math.round((t.on_time / t.n) * 1000) / 10 : null,
      };
    }),
  };
}
