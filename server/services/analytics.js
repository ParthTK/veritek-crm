// Sales dashboard: the company-wide numbers the earlier dashboard showed — enquiries, pipeline, quotations,
// orders, production, dispatch, receivables, salespeople, region and source split, target vs achievement —
// rebuilt on the specification's records. Values stay per currency; definitions are stated with the data.
import { all, get } from '../db.js';
import { today, tz, settings, intId, outstandingSql } from '../util.js';
import { addDays, localDate } from '../../shared/dates.js';
import {
  ENQUIRY_STAGES, PIPELINE_STAGES, OPEN_ENQUIRY_STAGES, PHASES, SELECTABLE_PHASES, labelOf, can,
} from '../../shared/constants.js';
import { lineQty, lineStatus, isPositive, lineValueMinor } from '../../shared/rules.js';
import { enquiryScope, quotationScope, orderScope, customerScope, taskScope } from '../access.js';
import { fyMonths } from './team.js';

const and = (s) => (s ? `AND ${s}` : '');
const OPEN = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
const add = (map, cur, v) => {
  if (v) map[cur || 'INR'] = (map[cur || 'INR'] || 0) + v;
};

export function periodRange(period, day = today()) {
  if (period === 'month') return [`${day.slice(0, 8)}01`, day];
  const months = fyMonths(day);
  if (period === 'quarter') {
    const idx = months.indexOf(day.slice(0, 7));
    return [`${months[Math.floor(idx / 3) * 3]}-01`, day];
  }
  return [`${months[0]}-01`, day];
}

const instant = (date) => `${date}T00:00:00.000Z`;

export function salesDashboard(query, user) {
  const day = today();
  const period = ['month', 'quarter', 'fy'].includes(query.period) ? query.period : 'fy';
  const [from, to] = periodRange(period, day);
  const fromI = instant(addDays(from, -1)); // local-date filtering below is exact; this only bounds the scan
  const toI = instant(addDays(to, 1));
  const inPeriod = (iso) => {
    if (!iso) return false;
    const d = iso.length > 10 ? localDate(new Date(iso), tz()) : iso;
    return d >= from && d <= to;
  };
  const owner = intId(query.owner);
  const region = intId(query.region_id);
  const filt = (alias, ownerCol) => [owner ? `${alias}.${ownerCol} = ${owner}` : '', region ? `${alias}.customer_id IN (SELECT id FROM customers WHERE region_id = ${region})` : ''].filter(Boolean).join(' AND ');
  const es = [enquiryScope(user, 'e'), filt('e', 'owner_id')].filter(Boolean).join(' AND ');
  const qs = [quotationScope(user, 'q'), filt('q', 'owner_id')].filter(Boolean).join(' AND ');
  const os = [orderScope(user, 'o'), filt('o', 'owner_id')].filter(Boolean).join(' AND ');
  const cs = [customerScope(user, 'c'), region ? `c.region_id = ${region}` : '', owner ? `c.owner_id = ${owner}` : ''].filter(Boolean).join(' AND ');
  const out = { period, from, to, generated_at: new Date().toISOString(), timezone: tz() };

  // ---------------------------------------------------------------- enquiries & pipeline
  if (can(user.role, 'enquiries.view')) {
    const enq = all(`SELECT e.id, e.stage, e.received_at, e.decided_at, e.source_code, e.est_value_minor, e.est_currency, e.probability, e.owner_id,
        (SELECT r.total_minor FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_minor,
        (SELECT r.currency FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_currency
      FROM enquiries e WHERE (e.stage IN (${OPEN}) OR e.received_at >= ? OR e.decided_at >= ?) ${and(es)}`, fromI, fromI);
    const pipelineValue = {};
    const weighted = {};
    const stageRows = PIPELINE_STAGES.map((s) => ({ stage: s, label: labelOf(ENQUIRY_STAGES, s), count: 0, value_by_currency: {} }));
    for (const e of enq.filter((x) => OPEN_ENQUIRY_STAGES.includes(x.stage))) {
      const v = e.quoted_minor ?? e.est_value_minor;
      const cur = e.quoted_minor !== null && e.quoted_minor !== undefined ? e.quoted_currency : e.est_currency;
      const p = e.probability ?? ENQUIRY_STAGES.find((s) => s.value === e.stage)?.probability ?? 0;
      add(pipelineValue, cur, v);
      add(weighted, cur, v ? Math.round((v * p) / 100) : 0);
      const row = stageRows.find((r) => r.stage === e.stage);
      if (row) {
        row.count++;
        add(row.value_by_currency, cur, v);
      }
    }
    out.enquiries = {
      received: enq.filter((e) => inPeriod(e.received_at)).length,
      received_this_month: enq.filter((e) => e.received_at && localDate(new Date(e.received_at), tz()) >= `${day.slice(0, 8)}01`).length,
      open: enq.filter((e) => OPEN_ENQUIRY_STAGES.includes(e.stage)).length,
      won: enq.filter((e) => e.stage === 'won' && inPeriod(e.decided_at)).length,
      lost: enq.filter((e) => e.stage === 'lost' && inPeriod(e.decided_at)).length,
      pipeline_value: pipelineValue,
      weighted_value: weighted,
      unvalued_open: enq.filter((e) => OPEN_ENQUIRY_STAGES.includes(e.stage) && (e.quoted_minor ?? e.est_value_minor) == null).length,
    };
    out.pipeline = stageRows;
    const bySource = {};
    for (const e of enq.filter((x) => inPeriod(x.received_at))) bySource[e.source_code] = (bySource[e.source_code] || 0) + 1;
    out.enquiry_sources = bySource;
  }

  // ---------------------------------------------------------------- quotations
  if (can(user.role, 'quotes.view')) {
    const revs = all(`SELECT r.status, r.currency, r.total_minor, r.sent_at, r.decided_at, r.validity_date, r.approval_status FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id
      WHERE (r.sent_at >= ? OR r.decided_at >= ? OR r.status IN ('issued','draft')) ${and(qs)}`, fromI, fromI);
    const sentValue = {};
    const awaitingValue = {};
    for (const r of revs) {
      if (inPeriod(r.sent_at)) add(sentValue, r.currency, r.total_minor);
      if (r.status === 'issued') add(awaitingValue, r.currency, r.total_minor);
    }
    out.quotations = {
      issued: revs.filter((r) => inPeriod(r.sent_at)).length,
      accepted: revs.filter((r) => r.status === 'accepted' && inPeriod(r.decided_at)).length,
      rejected: revs.filter((r) => r.status === 'rejected' && inPeriod(r.decided_at)).length,
      awaiting: revs.filter((r) => r.status === 'issued').length,
      expiring_soon: revs.filter((r) => r.status === 'issued' && r.validity_date >= day && r.validity_date <= addDays(day, 7)).length,
      approval_pending: revs.filter((r) => r.status === 'draft' && r.approval_status === 'pending').length,
      issued_value: sentValue,
      awaiting_value: awaitingValue,
    };
  }

  // ---------------------------------------------------------------- orders, production & dispatch
  const orders = all(`SELECT o.id, o.status, o.currency, o.owner_id, o.confirmed_at, o.closed_at, o.customer_id, o.enquiry_id, c.region_id, e.source_code
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN enquiries e ON e.id = o.enquiry_id
    WHERE o.status = 'confirmed' AND o.archived_at IS NULL AND (o.closed_at IS NULL OR o.confirmed_at >= ? OR o.closed_at >= ?) ${and(os)}`, fromI, fromI);
  const ids = orders.map((o) => o.id);
  const lines = ids.length ? all(`SELECT l.*, o.status AS order_status FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.order_id IN (${ids.join(',')})`) : [];
  const linesBy = new Map(ids.map((i) => [i, []]));
  for (const l of lines) linesBy.get(l.order_id).push(l);
  const orderValue = (o) => (linesBy.get(o.id) || []).reduce((s, l) => s + (lineValueMinor(l.confirmed_qty - l.cancelled_qty, l.unit_price_minor) || 0), 0);
  const confirmedInPeriod = orders.filter((o) => inPeriod(o.confirmed_at));
  const valueInPeriod = {};
  for (const o of confirmedInPeriod) add(valueInPeriod, o.currency, orderValue(o));
  const phaseCounts = Object.fromEntries(SELECTABLE_PHASES.map((p) => [p, 0]));
  let delayed = 0;
  let overdueLines = 0;
  let readyWaiting = 0;
  for (const l of lines) {
    const st = lineStatus(l, day, 'confirmed');
    if (!st.active) continue;
    phaseCounts[l.phase] = (phaseCounts[l.phase] || 0) + 1;
    if (st.overdue) overdueLines++;
    const q = lineQty(l);
    if ((q.ready !== null ? isPositive(q.readyNotDispatched) : l.phase === 'ready')) readyWaiting++;
  }
  const active = orders.filter((o) => !o.closed_at);
  for (const o of active) if ((linesBy.get(o.id) || []).some((l) => lineStatus(l, day, 'confirmed').delayed)) delayed++;
  const dispatches = get(`SELECT COUNT(DISTINCT d.id) AS n FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id JOIN orders o ON o.id = dl.order_id
    WHERE d.status = 'posted' AND d.dispatch_date BETWEEN ? AND ? ${and(os)}`, from, to).n;
  const inTransit = get(`SELECT COUNT(DISTINCT d.id) AS n FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id JOIN orders o ON o.id = dl.order_id
    WHERE d.status = 'posted' AND d.delivered_at IS NULL AND d.dispatch_date >= ? ${and(os)}`, addDays(day, -30)).n;
  out.orders = {
    confirmed: confirmedInPeriod.length,
    value_by_currency: valueInPeriod,
    active: active.length,
    delayed,
    overdue_lines: overdueLines,
    ready_waiting_lines: readyWaiting,
    dispatches,
    in_transit: inTransit,
    by_phase: SELECTABLE_PHASES.map((p) => ({ phase: p, label: labelOf(PHASES, p), lines: phaseCounts[p] || 0 })),
  };

  // Monthly confirmed order value (12 months, per currency).
  const monthly = new Map();
  const yearBack = addDays(`${day.slice(0, 8)}01`, -334);
  const trendOrders = all(`SELECT o.id, o.currency, o.confirmed_at FROM orders o WHERE o.status = 'confirmed' AND o.confirmed_at >= ? ${and(os)}`, instant(yearBack));
  const trendLines = trendOrders.length ? all(`SELECT order_id, confirmed_qty, cancelled_qty, unit_price_minor FROM order_lines WHERE order_id IN (${trendOrders.map((o) => o.id).join(',')})`) : [];
  for (const o of trendOrders) {
    const m = localDate(new Date(o.confirmed_at), tz()).slice(0, 7);
    const v = trendLines.filter((l) => l.order_id === o.id).reduce((s, l) => s + (lineValueMinor(l.confirmed_qty - l.cancelled_qty, l.unit_price_minor) || 0), 0);
    const row = monthly.get(m) || { month: m, orders: 0, value_by_currency: {} };
    row.orders++;
    add(row.value_by_currency, o.currency, v);
    monthly.set(m, row);
  }
  out.order_trend = [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month));

  // ---------------------------------------------------------------- receivables
  if (can(user.role, 'finance.view')) {
    const inv = all(`SELECT i.currency, i.due_date, ${outstandingSql('i')} AS outstanding FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE 1 = 1 ${and(cs)}`);
    const outstanding = {};
    const overdue = {};
    for (const i of inv.filter((x) => x.outstanding > 0)) {
      add(outstanding, i.currency, i.outstanding);
      if (i.due_date && i.due_date < day) add(overdue, i.currency, i.outstanding);
    }
    const collected = {};
    for (const r of all(`SELECT COALESCE(r.currency, 'INR') AS currency, SUM(r.amount_minor) AS v FROM receipts r JOIN customers c ON c.id = r.customer_id
      WHERE r.reversed_at IS NULL AND r.kind <> 'credit' AND r.effective_date BETWEEN ? AND ? ${and(cs)} GROUP BY 1`, from, to)) collected[r.currency] = r.v;
    out.receivables = { outstanding, overdue, collected, invoices_recorded: inv.length, note: 'From the invoice register only — missing invoices are unknown, not zero.' };
  }

  // ---------------------------------------------------------------- follow-ups
  const ts = taskScope(user, 't');
  const mine = can(user.role, 'tasks.manage_any') || user.group === 'viewer' ? '' : `t.owner_id = ${Number(user.id)}`;
  const fu = get(`SELECT SUM(CASE WHEN t.due_date = ? AND t.overdue_at > ? THEN 1 ELSE 0 END) AS due_today, SUM(CASE WHEN t.overdue_at <= ? THEN 1 ELSE 0 END) AS overdue, COUNT(*) AS open
    FROM tasks t WHERE t.status = 'open' ${and(ts)} ${and(mine)} ${owner ? `AND t.owner_id = ${owner}` : ''}`, day, new Date().toISOString(), new Date().toISOString());
  out.followups = { due_today: fu.due_today || 0, overdue: fu.overdue || 0, open: fu.open || 0 };

  // ---------------------------------------------------------------- breakdowns
  const regions = all('SELECT id, name FROM regions ORDER BY sort_order, name');
  out.by_region = regions.map((rg) => {
    const list = confirmedInPeriod.filter((o) => o.region_id === rg.id);
    const v = {};
    for (const o of list) add(v, o.currency, orderValue(o));
    return { region: rg.name, region_id: rg.id, orders: list.length, value_by_currency: v };
  }).filter((x) => x.orders > 0);
  const sources = {};
  for (const o of confirmedInPeriod) {
    const k = o.source_code || (o.enquiry_id ? 'unknown' : 'direct_order');
    sources[k] ||= { source: k, orders: 0, value_by_currency: {} };
    sources[k].orders++;
    add(sources[k].value_by_currency, o.currency, orderValue(o));
  }
  out.by_source = Object.values(sources).sort((a, b) => b.orders - a.orders);

  // Salespeople (scope-limited) with targets for the period in the company currency.
  const currency = settings().company.currency || 'INR';
  const people = all(`SELECT u.id, u.name, u.role, rg.name AS region FROM users u LEFT JOIN regions rg ON rg.id = u.region_id
    WHERE u.active = 1 AND u.role IN ('sales_executive','regional_manager','sales_head')
    ${user.scope === 'region' ? `AND (u.region_id = ${Number(user.region_id) || 0} OR u.id = ${user.id})` : user.scope === 'own' && user.group === 'sales' ? `AND u.id = ${user.id}` : ''}
    ${region ? `AND u.region_id = ${region}` : ''} ORDER BY u.name`);
  const months = fyMonths(day).filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7));
  const targets = months.length ? all(`SELECT user_id, SUM(amount_minor) AS t FROM sales_targets WHERE currency = ? AND month IN (${months.map(() => '?').join(',')}) GROUP BY user_id`, currency, ...months) : [];
  out.salespeople = people.map((p) => {
    const own = confirmedInPeriod.filter((o) => o.owner_id === p.id);
    const v = {};
    for (const o of own) add(v, o.currency, orderValue(o));
    const target = targets.find((t) => t.user_id === p.id)?.t ?? null;
    const enqOpen = get(`SELECT COUNT(*) AS n FROM enquiries WHERE owner_id = ? AND stage IN (${OPEN})`, p.id).n;
    const won = get('SELECT COUNT(*) AS n FROM enquiries WHERE owner_id = ? AND stage = ? AND decided_at >= ?', p.id, 'won', fromI).n;
    const lost = get('SELECT COUNT(*) AS n FROM enquiries WHERE owner_id = ? AND stage = ? AND decided_at >= ?', p.id, 'lost', fromI).n;
    return {
      id: p.id, name: p.name, region: p.region, role: p.role, orders: own.length, value_by_currency: v, open_enquiries: enqOpen, won, lost,
      win_rate_pct: won + lost ? Math.round((won / (won + lost)) * 100) : null, target_minor: target, currency,
      achievement_pct: target ? Math.round(((v[currency] || 0) / target) * 100) : null,
      overdue_followups: get('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status = ? AND overdue_at <= ?', p.id, 'open', new Date().toISOString()).n,
    };
  }).sort((a, b) => (b.value_by_currency[currency] || 0) - (a.value_by_currency[currency] || 0));

  // Monthly target vs achievement (company currency) across the financial year.
  const fy = fyMonths(day);
  const userIds = out.salespeople.map((p) => p.id);
  const monthlyTargets = userIds.length ? all(`SELECT month, SUM(amount_minor) AS t FROM sales_targets WHERE currency = ? AND user_id IN (${userIds.join(',')}) GROUP BY month`, currency) : [];
  out.target_vs_achievement = fy.map((m) => ({
    month: m,
    target_minor: monthlyTargets.find((x) => x.month === m)?.t ?? null,
    achieved_minor: monthly.get(m)?.value_by_currency?.[currency] ?? 0,
    future: m > day.slice(0, 7),
  }));
  out.target_currency = currency;
  return out;
}
