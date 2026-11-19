// Management overview: exceptions first. Every count is computed from the same records the drill-down
// list shows, cards are not added into a grand total, and missing data is shown as a notice rather than
// a reassuring zero.
import { all, get } from '../db.js';
import { now, today, tz, calendar, settings, intId, optionLabel, placeholders } from '../util.js';
import { addDays, addWorkingDays, localDate, zonedToUtc } from '../../shared/dates.js';
import { OPEN_ENQUIRY_STAGES, SELECTABLE_PHASES, PHASES, COUNTRIES, labelOf } from '../../shared/constants.js';
import { customerScope, enquiryScope, orderScope, quotationScope, taskScope } from '../access.js';
import { hasPerm } from '../auth.js';
import { loadOrdersWithLines, orderListRow } from './orders.js';
import { TASK_COLUMNS, decorateTask } from './tasks.js';
import { pastCustomers } from './reactivation.js';

function orderFilters(q) {
  const where = ["o.status = 'confirmed'", 'o.closed_at IS NULL'];
  const params = [];
  if (intId(q.owner)) {
    where.push('o.owner_id = ?');
    params.push(intId(q.owner));
  }
  if (intId(q.customer_id)) {
    where.push('o.customer_id = ?');
    params.push(intId(q.customer_id));
  }
  if (q.segment) {
    where.push('COALESCE(o.segment, c.segment) = ?');
    params.push(q.segment);
  }
  if (q.country) {
    where.push('c.country_code = ?');
    params.push(q.country);
  }
  if (q.family) {
    where.push('EXISTS (SELECT 1 FROM order_lines l2 JOIN products p2 ON p2.id = l2.product_id WHERE l2.order_id = o.id AND p2.family = ?)');
    params.push(q.family);
  }
  return { where, params };
}

/** The first day of the financial year that today falls in (April by default). */
export function financialYearStart(day = today()) {
  const startMonth = settings().company.fiscalYearStartMonth || 4;
  const [y, m] = day.split('-').map(Number);
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`;
}

/**
 * Where this financial year's enquiries and sales come from, by the customer's country and, for India, state.
 * Enquiries: received this year, cancelled ones left out. Sales: confirmed orders received this year, with their
 * value before tax and net of cancellations, per currency (never added across currencies; lines without a price
 * are not counted, and the orders that have them are counted instead). Each user sees only their own scope.
 */
export function salesMap(user) {
  const from = financialYearStart();
  const eScope = enquiryScope(user, 'e');
  const oScope = orderScope(user, 'o');
  const enquiries = hasPerm(user, 'enquiries.view') ? all(`SELECT c.id, c.company_name, c.country_code, c.state, COUNT(*) AS n
    FROM enquiries e JOIN customers c ON c.id = e.customer_id
    WHERE e.stage <> 'cancelled' AND COALESCE(e.received_at, e.created_at) >= ? ${eScope ? `AND ${eScope}` : ''}
    GROUP BY c.id, c.company_name, c.country_code, c.state`, zonedToUtc(from, '00:00', tz())) : [];
  const orders = hasPerm(user, 'orders.view') ? all(`SELECT c.id, c.company_name, c.country_code, c.state, o.currency,
      (SELECT SUM(CASE WHEN l.unit_price_minor IS NULL THEN NULL ELSE ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) FROM order_lines l WHERE l.order_id = o.id) AS value_minor,
      (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id AND l.unit_price_minor IS NULL AND l.confirmed_qty - l.cancelled_qty > 0) AS unpriced
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'confirmed' AND o.archived_at IS NULL AND o.received_date >= ?
      AND EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.confirmed_qty - l.cancelled_qty > 0) ${oScope ? `AND ${oScope}` : ''}`, from) : [];

  const tally = () => ({ enquiries: 0, sales: 0, value_by_currency: {} });
  const countries = new Map();
  const add = (map, key, make) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key);
  };
  const country = (code) => add(countries, code || null, () => ({ code: code || null, ...tally(), customers: new Map(), states: new Map() }));
  const targets = (r) => {
    const c = country(r.country_code);
    const out = [c, add(c.customers, r.id, () => ({ id: r.id, name: r.company_name, ...tally() }))];
    if (r.country_code === 'IN') out.push(add(c.states, r.state || null, () => ({ name: r.state || null, ...tally() })));
    return out;
  };
  let unpriced = 0;
  for (const r of enquiries) for (const t of targets(r)) t.enquiries += r.n;
  for (const r of orders) {
    if (r.unpriced) unpriced++;
    for (const t of targets(r)) {
      t.sales++;
      if (r.value_minor !== null) t.value_by_currency[r.currency] = (t.value_by_currency[r.currency] || 0) + r.value_minor;
    }
  }
  const byActivity = (a, b) => b.enquiries + b.sales - (a.enquiries + a.sales) || String(a.name).localeCompare(String(b.name));
  const unknown = countries.get(null) || tally();
  const list = [...countries.values()].filter((c) => c.code).map((c) => ({
    code: c.code, name: labelOf(COUNTRIES, c.code) || c.code, enquiries: c.enquiries, sales: c.sales, value_by_currency: c.value_by_currency,
    customers: [...c.customers.values()].sort(byActivity).slice(0, 8),
    ...(c.code === 'IN' ? { states: [...c.states.values()].sort((a, b) => (a.name === null) - (b.name === null) || byActivity(a, b)) } : {}),
  })).sort(byActivity);
  return {
    from, to: today(),
    countries: list,
    unknown: { enquiries: unknown.enquiries, sales: unknown.sales },
    totals: { enquiries: enquiries.reduce((n, r) => n + r.n, 0), sales: orders.length, unpriced },
  };
}

function taskRows(user, q, bucketSql, bucketParams, limit = 12) {
  const where = ["t.status = 'open'"];
  const params = [];
  const scope = taskScope(user, 't');
  if (scope) where.push(scope);
  if (intId(q.owner)) {
    where.push('t.owner_id = ?');
    params.push(intId(q.owner));
  }
  if (intId(q.customer_id)) {
    where.push('t.customer_id = ?');
    params.push(intId(q.customer_id));
  }
  if (q.segment) {
    where.push('c.segment = ?');
    params.push(q.segment);
  }
  if (q.country) {
    where.push('c.country_code = ?');
    params.push(q.country);
  }
  const base = `FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN enquiries e ON e.id = t.enquiry_id
    LEFT JOIN orders o ON o.id = t.order_id WHERE ${where.join(' AND ')} AND ${bucketSql}`;
  const count = get(`SELECT COUNT(*) AS n ${base}`, ...params, ...bucketParams).n;
  const rows = all(`SELECT ${TASK_COLUMNS} ${base} ORDER BY t.overdue_at LIMIT ${limit}`, ...params, ...bucketParams);
  return { count, rows: rows.map((r) => decorateTask(r)) };
}

export function dashboard(q, user) {
  const nowStr = now().toISOString();
  const day = today();
  const { where, params } = orderFilters(q);
  const pinnedOrders = new Set(all("SELECT entity_id FROM pins WHERE user_id = ? AND entity_type = 'order'", user.id).map((r) => r.entity_id));
  const orders = loadOrdersWithLines(where, params, user).map(({ order, lines }) => orderListRow(order, lines, pinnedOrders));

  const lineRows = [];
  for (const o of orders) for (const l of o.lines) if (l.quantities.remaining > 0) lineRows.push({ ...l, order: o });
  const pick = (fn, sort, limit = 8) => {
    const rows = lineRows.filter(fn);
    if (sort) rows.sort(sort);
    return { count: rows.length, rows: rows.slice(0, limit).map((l) => ({
      order_id: l.order.id, order_code: l.order.code, customer_id: l.order.customer_id, customer_name: l.order.customer_name, line_id: l.id, line_no: l.line_no,
      product: l.product, qty: l.quantities.remaining, unit: l.unit, original: l.original_commitment_date, forecast: l.forecast_dispatch_date, agreed: l.agreed_commitment_date,
      days_late: l.days_late, issue: l.issue_label, note: l.stage_note, comm_state: l.comm_state, state: l.state, freshness: l.freshness, estimate_unknown: l.estimate_unknown,
    })) };
  };
  const byLate = (a, b) => b.days_late - a.days_late;
  const byForecast = (a, b) => String(a.forecast_dispatch_date).localeCompare(String(b.forecast_dispatch_date));
  const soon = addWorkingDays(day, 5, calendar());

  const delayedOrders = orders.filter((o) => o.delayed);
  const overdueOrders = orders.filter((o) => o.overdue);
  const atRiskOnly = orders.filter((o) => !o.overdue && o.lines.some((l) => l.state === 'at_risk'));

  // Enquiries
  const eWhere = [`e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')})`];
  const eParams = [];
  const eScope = enquiryScope(user, 'e');
  if (eScope) eWhere.push(eScope);
  if (intId(q.owner)) {
    eWhere.push('e.owner_id = ?');
    eParams.push(intId(q.owner));
  }
  if (intId(q.customer_id)) {
    eWhere.push('e.customer_id = ?');
    eParams.push(intId(q.customer_id));
  }
  if (q.segment) {
    eWhere.push('c.segment = ?');
    eParams.push(q.segment);
  }
  if (q.country) {
    eWhere.push('c.country_code = ?');
    eParams.push(q.country);
  }
  if (q.family) {
    eWhere.push('EXISTS (SELECT 1 FROM enquiry_lines el JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id AND p.family = ?)');
    eParams.push(q.family);
  }
  const eBase = `FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE ${eWhere.join(' AND ')}`;
  const openEnquiries = get(`SELECT COUNT(*) AS n ${eBase}`, ...eParams).n;
  const enquiriesNoNext = get(`SELECT COUNT(*) AS n ${eBase} AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open') AND e.no_followup_reason IS NULL`, ...eParams).n;
  const enquiriesNoResponse = get(`SELECT COUNT(*) AS n ${eBase} AND e.first_response_at IS NULL AND e.received_at IS NOT NULL`, ...eParams).n;

  // The daily picture: enquiries received per day (and whether each has been replied to), quotations waiting,
  // and how the active order lines are spread across production.
  const anyStage = eWhere.slice(1);
  const firstDay = addDays(day, -13);
  const yesterday = addDays(day, -1);
  const received = all(`SELECT e.received_at, e.first_response_at FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.received_at >= ? ${anyStage.length ? `AND ${anyStage.join(' AND ')}` : ''}`, zonedToUtc(firstDay, '00:00', tz()), ...eParams);
  const perDay = new Map(Array.from({ length: 14 }, (_, i) => [addDays(firstDay, i), { day: addDays(firstDay, i), replied: 0, not_replied: 0 }]));
  for (const r of received) {
    const bucket = perDay.get(localDate(new Date(r.received_at), tz()));
    if (bucket) bucket[r.first_response_at ? 'replied' : 'not_replied'] += 1;
  }
  const dayTotal = (d) => (perDay.get(d)?.replied || 0) + (perDay.get(d)?.not_replied || 0);
  const qScope = quotationScope(user, 'q');
  const quoteFilters = [qScope, intId(q.owner) ? `q.owner_id = ${intId(q.owner)}` : null, intId(q.customer_id) ? `q.customer_id = ${intId(q.customer_id)}` : null].filter(Boolean);
  const quotes = get(`SELECT COALESCE(SUM(CASE WHEN r.status = 'draft' THEN 1 ELSE 0 END), 0) AS not_sent,
      COALESCE(SUM(CASE WHEN r.status = 'draft' AND r.approval_status IN ('required','pending') THEN 1 ELSE 0 END), 0) AS awaiting_approval,
      COALESCE(SUM(CASE WHEN r.status = 'issued' THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN r.status = 'issued' AND r.validity_date < ? THEN 1 ELSE 0 END), 0) AS expired
    FROM quotations q JOIN quote_revisions r ON r.quotation_id = q.id AND r.revision_no = (SELECT MAX(r2.revision_no) FROM quote_revisions r2 WHERE r2.quotation_id = q.id)
    JOIN customers c ON c.id = q.customer_id ${quoteFilters.length ? `WHERE ${quoteFilters.join(' AND ')}` : ''}`, day);
  const production = SELECTABLE_PHASES.map((phase) => {
    const here = lineRows.filter((l) => l.phase === phase);
    return { phase, label: labelOf(PHASES, phase), lines: here.length, delayed: here.filter((l) => ['overdue', 'at_risk'].includes(l.state)).length };
  });
  const flow = {
    enquiries_today: dayTotal(day), enquiries_yesterday: dayTotal(yesterday), daily_enquiries: [...perDay.values()],
    replied: openEnquiries - enquiriesNoResponse, not_replied: enquiriesNoResponse, quotations: quotes, production,
  };

  // Reactivation: distinct customers with an open reactivation task due today or overdue.
  const reconnectQuery = taskRows(user, q, "t.reactivation_case_id IS NOT NULL AND (t.overdue_at <= ? OR t.due_date = ?)", [nowStr, day], 50);
  const reconnectCustomers = new Set(reconnectQuery.rows.map((t) => t.customer_id));
  const reconnectCount = get(`SELECT COUNT(DISTINCT t.customer_id) AS n FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.status = 'open' AND t.reactivation_case_id IS NOT NULL AND (t.overdue_at <= ? OR t.due_date = ?) ${taskScope(user, 't') ? `AND ${taskScope(user, 't')}` : ''}
    ${intId(q.owner) ? `AND t.owner_id = ${intId(q.owner)}` : ''} ${q.segment ? 'AND c.segment = ?' : ''} ${q.country ? 'AND c.country_code = ?' : ''}`,
  nowStr, day, ...(q.segment ? [q.segment] : []), ...(q.country ? [q.country] : [])).n;

  const overdueTasks = taskRows(user, q, 't.overdue_at <= ?', [nowStr]);
  const todayTasks = taskRows(user, q, 't.overdue_at > ? AND t.due_date = ?', [nowStr, day]);
  const promises = taskRows(user, q, 't.customer_promise = 1 AND t.overdue_at <= ?', [nowStr], 8);

  const past = q.customer_id ? { rows: [] } : pastCustomers({ owner: q.owner, market: q.segment, country: q.country, filter: 'followup_due' }, user);
  const opportunities = past.rows.slice(0, 6).map((r) => ({
    customer_id: r.id, customer_name: r.company_name, kind: r.kind, last_order_date: r.last_order_date, days_since_order: r.days_since_order,
    why: r.why, next_action: r.next_action, status: r.status, lost_enquiry: r.lost_enquiry,
  }));

  const staleLines = lineRows.filter((l) => l.stale);
  const staleOrders = new Set(staleLines.map((l) => l.order.id));
  const unknownCommitments = lineRows.filter((l) => l.commitment_state !== 'committed').length;
  const totalCustomers = get('SELECT COUNT(*) AS n FROM customers WHERE merged_into_id IS NULL').n;
  const totalOrders = get('SELECT COUNT(*) AS n FROM orders').n;
  const lastRun = get("SELECT * FROM scheduler_runs WHERE status IN ('ok','partial') ORDER BY id DESC LIMIT 1");

  const notices = [];
  if (enquiriesNoNext) notices.push({ code: 'no_next_action', text: `${enquiriesNoNext} open enquir${enquiriesNoNext === 1 ? 'y has' : 'ies have'} no next action`, link: '/enquiries?no_next=1' });
  if (staleOrders.size) notices.push({ code: 'stale', text: `${staleOrders.size} order${staleOrders.size === 1 ? ' needs' : 's need'} a fresh production update`, link: '/orders?state=stale' });
  const noAction = lineRows.filter((l) => (l.state === 'overdue' || l.state === 'at_risk' || l.issue_code) && !l.action_task_id).length;
  if (noAction) notices.push({ code: 'no_action', text: `${noAction} delayed line${noAction === 1 ? ' has' : 's have'} no named action owner`, link: '/orders?state=no_action' });
  if (unknownCommitments) notices.push({ code: 'uncommitted', text: `${unknownCommitments} active line${unknownCommitments === 1 ? ' has' : 's have'} no committed dispatch date (excluded from timeliness)`, link: '/orders?state=uncommitted' });

  const pinned = all(`SELECT p.entity_type, p.entity_id FROM pins p WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 12`, user.id).map((p) => {
    if (p.entity_type === 'order') {
      const o = orders.find((x) => x.id === p.entity_id) || get('SELECT id, code, closed_at, customer_id, (SELECT company_name FROM customers WHERE id = orders.customer_id) AS customer_name FROM orders WHERE id = ?', p.entity_id);
      return o ? { type: 'order', id: o.id, label: `${o.code} · ${o.customer_name}`, state: o.overdue ? 'Overdue' : o.at_risk ? 'Forecast late' : o.closed_at ? 'Closed' : o.active === false ? 'Closed' : 'Active', tone: o.overdue ? 'red' : o.at_risk ? 'amber' : 'green', link: `/orders/${o.id}` } : null;
    }
    const c = get('SELECT id, company_name FROM customers WHERE id = ?', p.entity_id);
    if (!c) return null;
    const open = get("SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ? AND status = 'open' AND overdue_at <= ?", c.id, nowStr).n;
    return { type: 'customer', id: c.id, label: c.company_name, state: open ? `${open} overdue follow-up${open === 1 ? '' : 's'}` : 'No overdue follow-ups', tone: open ? 'red' : 'green', link: `/customers/${c.id}` };
  }).filter(Boolean);

  return {
    refreshed_at: nowStr,
    today: day,
    flow,
    timezone: tz(),
    last_scheduler_run: lastRun ? { at: lastRun.finished_at, status: lastRun.status } : null,
    empty: { customers: totalCustomers === 0, orders: totalOrders === 0 },
    notices,
    tiles: {
      reconnect: { count: reconnectCount, link: '/past-customers?filter=followup_due' },
      open_enquiries: { count: openEnquiries, no_response: enquiriesNoResponse, link: '/enquiries?stage=open' },
      active_orders: { count: orders.length, link: '/orders' },
      delayed: {
        count: delayedOrders.length, overdue: overdueOrders.length, at_risk: atRiskOnly.length, link: '/orders?state=delayed',
        explanation: `${delayedOrders.length} of the ${orders.length} active orders are delayed (counted once each, even with several late lines): ${overdueOrders.length} past the original commitment, ${atRiskOnly.length} forecast late. They are also included in the active-order count.`,
      },
    },
    order_alerts: {
      overdue: pick((l) => l.state === 'overdue', byLate),
      forecast_late: pick((l) => l.state === 'at_risk', byForecast),
      no_action: pick((l) => (l.state === 'overdue' || l.state === 'at_risk' || l.issue_code) && !l.action_task_id, byLate),
      ready_waiting: pick((l) => l.ready_waiting),
      not_informed: pick((l) => l.comm_state === 'pending', byLate),
      estimate_unknown: pick((l) => l.estimate_unknown),
    },
    followups: { overdue: overdueTasks, today: todayTasks },
    promises_overdue: promises,
    missing_updates: pick((l) => l.stale, (a, b) => (b.freshness?.working_days ?? 99) - (a.freshness?.working_days ?? 99), 10),
    upcoming_commitments: pick((l) => l.state !== 'overdue' && l.state !== 'at_risk' && l.original_commitment_date && l.original_commitment_date <= soon, (a, b) => String(a.original_commitment_date).localeCompare(String(b.original_commitment_date))),
    customer_opportunities: opportunities,
    reconnect_customers: reconnectCustomers.size,
    pinned,
  };
}

export { optionLabel, settings, customerScope, placeholders };
