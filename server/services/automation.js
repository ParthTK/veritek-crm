import { get, all, run, insert, getSetting, setSetting } from '../db.js';
import { DEFAULT_SETTINGS, QUOTE_AWAITING } from '../../shared/constants.js';
import { nowIso, today, addDays, daysBetween, notify, managersOf, fyStart } from '../util.js';
import { customerScope, leadScope, quotationScope, orderScope } from '../access.js';
import { pickAssignee, syncLeadFollowup } from './leads.js';
import { ORDER_ROLLUP, decorateOrder } from './orders.js';
import { setQuotationStatus } from './quotes.js';

const settingsOf = (key) => ({ ...DEFAULT_SETTINGS[key], ...getSetting(key, {}) });
const and = (s) => (s ? `AND ${s}` : '');
const inr = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;

// ======================================================================= reminders
/**
 * Smart reminders shown on the Follow-Ups page and used by automation.
 * `user` limits results to the user's scope; `mine` further limits to items they own.
 */
export function computeReminders(user, { mine = false } = {}) {
  const fs = settingsOf('followups');
  const cs = settingsOf('customers');
  const t = today();
  const owner = (col) => (mine && user ? `AND ${col} = ${Number(user.id)}` : '');
  const ls = user ? leadScope(user, 'l') : '';
  const qs = user ? quotationScope(user, 'q') : '';
  const cus = user ? customerScope(user, 'c') : '';
  const os = user ? orderScope(user, 'o') : '';

  const noNextAction = all(
    `SELECT l.id, l.code, l.title, l.assigned_to, u.name AS owner_name, c.name AS customer_name, l.estimated_value
     FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.status = 'open' AND (l.next_action IS NULL OR l.next_follow_up_date IS NULL) ${and(ls)} ${owner('l.assigned_to')}`,
  );

  const noResponse = all(
    `SELECT q.id, q.number, q.subject, q.owner_id, q.sent_at, c.name AS customer_name, u.name AS owner_name, v.grand_total,
            (SELECT MAX(a.activity_date) FROM activities a WHERE a.customer_id = q.customer_id) AS last_activity
     FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id
     JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
     WHERE q.status IN ('sent','viewed') AND q.sent_at <= ? ${and(qs)} ${owner('q.owner_id')}`,
    addDays(t, -fs.noResponseDays),
  ).filter((q) => !q.last_activity || q.last_activity < q.sent_at)
    .map((q) => ({ ...q, days: daysBetween(q.sent_at, t) }));

  const silentLeads = all(
    `SELECT l.id, l.code, l.title, l.assigned_to, u.name AS owner_name, c.name AS customer_name, l.estimated_value, l.temperature,
            COALESCE((SELECT MAX(a.activity_date) FROM activities a WHERE a.lead_id = l.id), l.created_at) AS last_touch
     FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.status = 'open' ${and(ls)} ${owner('l.assigned_to')}`,
  ).filter((l) => l.last_touch < addDays(t, -fs.noResponseDays))
    .map((l) => ({ ...l, days: daysBetween(l.last_touch, t) }));

  const expiring = all(
    `SELECT q.id, q.number, q.subject, q.valid_until, q.owner_id, q.status, c.name AS customer_name, u.name AS owner_name, v.grand_total
     FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id
     JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
     WHERE q.status IN (${QUOTE_AWAITING.map((s) => `'${s}'`).join(',')}) AND q.valid_until BETWEEN ? AND ? ${and(qs)} ${owner('q.owner_id')}
     ORDER BY q.valid_until`,
    t, addDays(t, fs.quotationExpiryWarnDays),
  ).map((q) => ({ ...q, days: daysBetween(t, q.valid_until) }));

  const sampleFeedback = all(
    `SELECT a.id, a.customer_id, a.lead_id, a.activity_date, a.summary, a.created_by, c.name AS customer_name, u.name AS owner_name, l.code AS lead_code
     FROM activities a JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.created_by LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.type = 'sample_delivery' AND a.activity_date <= ?
       AND NOT EXISTS (SELECT 1 FROM activities b WHERE b.customer_id = a.customer_id AND b.activity_date > a.activity_date AND b.type <> 'note')
       AND (a.lead_id IS NULL OR EXISTS (SELECT 1 FROM leads l2 WHERE l2.id = a.lead_id AND l2.status = 'open'))
       ${and(cus)} ${owner('a.created_by')}`,
    addDays(t, -fs.sampleFeedbackDays),
  ).map((a) => ({ ...a, days: daysBetween(a.activity_date, t) }));

  const poPromised = [
    ...all(
      `SELECT l.id, l.code, l.title, l.expected_close_date, l.assigned_to, c.name AS customer_name, u.name AS owner_name, l.estimated_value
       FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.status = 'open' AND l.stage = 'po_expected' AND l.expected_close_date < ? ${and(ls)} ${owner('l.assigned_to')}`,
      t,
    ).map((l) => ({ ...l, kind: 'lead', days: daysBetween(l.expected_close_date, t) })),
    ...all(
      `SELECT q.id, q.number AS code, q.subject AS title, q.decided_at, q.owner_id AS assigned_to, c.name AS customer_name, u.name AS owner_name, v.grand_total AS estimated_value
       FROM quotations q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id
       JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
       WHERE q.status = 'accepted' AND q.decided_at <= ? ${and(qs)} ${owner('q.owner_id')}`,
      addDays(t, -2),
    ).map((q) => ({ ...q, kind: 'quotation', days: daysBetween(q.decided_at, t) })),
  ];

  // Customers with order history: dormant (no order in N days) and due for repeat (past their usual reorder cycle).
  const history = all(
    `SELECT c.id, c.name, c.code, c.assigned_to, c.status, u.name AS owner_name, COUNT(o.id) AS orders, MIN(o.order_date) AS first_order,
            MAX(o.order_date) AS last_order, SUM(o.grand_total) AS lifetime_value
     FROM customers c JOIN sales_orders o ON o.customer_id = c.id AND o.status <> 'cancelled' LEFT JOIN users u ON u.id = c.assigned_to
     WHERE c.status NOT IN ('blocked', 'lost') ${and(cus)} ${owner('c.assigned_to')}
     GROUP BY c.id`,
  );
  const openLeadCustomers = new Set(all("SELECT DISTINCT customer_id FROM leads WHERE status = 'open'").map((r) => r.customer_id));
  const dormant = [];
  const repeat = [];
  for (const c of history) {
    const since = daysBetween(c.last_order, t);
    if (since >= cs.dormantAfterDays) {
      dormant.push({ ...c, days: since, has_open_lead: openLeadCustomers.has(c.id) });
      continue;
    }
    if (c.orders >= 2) {
      const cycle = Math.round(daysBetween(c.first_order, c.last_order) / (c.orders - 1));
      if (cycle >= 20 && since >= cycle * 0.85 && !openLeadCustomers.has(c.id)) {
        repeat.push({ ...c, days: since, cycle, due_in: cycle - since });
      }
    }
  }

  return {
    no_next_action: noNextAction,
    no_response: [...noResponse.map((q) => ({ ...q, kind: 'quotation' })), ...silentLeads.map((l) => ({ ...l, kind: 'lead' }))],
    quotation_expiring: expiring,
    sample_feedback: sampleFeedback,
    po_promised: poPromised,
    dormant_customers: dormant.sort((a, b) => b.lifetime_value - a.lifetime_value),
    repeat_opportunities: repeat.sort((a, b) => a.due_in - b.due_in),
  };
}

// ======================================================================= rules
function assignLeads() {
  let n = 0;
  for (const lead of all("SELECT * FROM leads WHERE assigned_to IS NULL AND status = 'open'")) {
    const userId = pickAssignee(lead);
    if (!userId) continue;
    run('UPDATE leads SET assigned_to = ?, updated_at = ? WHERE id = ?', userId, nowIso(), lead.id);
    syncLeadFollowup(lead.id);
    notify(userId, { type: 'lead_assigned', title: `New lead assigned: ${lead.title}`, message: 'Auto-assigned by region / product rules', link: `/leads/${lead.id}`, dedupeKey: `lead_assigned:${lead.id}:${userId}` });
    n++;
  }
  return n;
}

function dueTodayDigest() {
  const t = today();
  let n = 0;
  for (const row of all(
    `SELECT assigned_to, SUM(due_date = ?) AS today_count, SUM(due_date < ?) AS overdue_count
     FROM followups WHERE status = 'pending' AND assigned_to IS NOT NULL GROUP BY assigned_to HAVING today_count > 0 OR overdue_count > 0`,
    t, t,
  )) {
    n += notify(row.assigned_to, {
      type: 'followups_due', title: `${row.today_count} follow-up${row.today_count === 1 ? '' : 's'} due today${row.overdue_count ? `, ${row.overdue_count} overdue` : ''}`,
      link: '/followups', severity: row.overdue_count ? 'warning' : 'info', dedupeKey: `due_digest:${t}`,
    });
  }
  return n;
}

function escalateOverdue() {
  const fs = settingsOf('followups');
  const cutoff = addDays(today(), -fs.escalateAfterDays);
  let n = 0;
  for (const f of all(
    `SELECT f.*, u.name AS owner_name, c.name AS customer_name, l.title AS lead_title, l.estimated_value
     FROM followups f LEFT JOIN users u ON u.id = f.assigned_to LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN leads l ON l.id = f.lead_id
     WHERE f.status = 'pending' AND f.escalated_at IS NULL AND f.due_date < ?`,
    cutoff,
  )) {
    const managers = managersOf(f.assigned_to);
    if (!managers.length) continue;
    run('UPDATE followups SET escalated_at = ?, priority = ? WHERE id = ?', nowIso(), 'high', f.id);
    notify(managers, {
      type: 'escalation', title: `Overdue follow-up escalated: ${f.owner_name}`,
      message: `${f.title} · ${f.customer_name || ''} · due ${f.due_date}`, link: f.lead_id ? `/leads/${f.lead_id}` : '/followups',
      severity: 'warning', dedupeKey: `escalate:${f.id}`,
    });
    n++;
  }
  return n;
}

function expireQuotations() {
  let n = 0;
  for (const q of all(`SELECT id FROM quotations WHERE status IN (${QUOTE_AWAITING.map((s) => `'${s}'`).join(',')}) AND valid_until < ?`, today())) {
    setQuotationStatus(q.id, { status: 'expired', note: 'Validity period ended' }, null);
    n++;
  }
  return n;
}

function reminderNotifications() {
  const r = computeReminders(null);
  const t = today();
  let n = 0;
  for (const q of r.quotation_expiring) {
    n += notify(q.owner_id, { type: 'quote_expiring', title: `${q.number} expires ${q.days === 0 ? 'today' : `in ${q.days} day${q.days === 1 ? '' : 's'}`}`, message: q.customer_name, link: `/quotations/${q.id}`, severity: 'warning', dedupeKey: `expiring:${q.id}:${q.valid_until}` });
  }
  for (const q of r.no_response) {
    const ownerId = q.kind === 'quotation' ? q.owner_id : q.assigned_to;
    const label = q.kind === 'quotation' ? q.number : q.code;
    n += notify(ownerId, { type: 'no_response', title: `No response for ${q.days} days: ${label}`, message: q.customer_name, link: q.kind === 'quotation' ? `/quotations/${q.id}` : `/leads/${q.id}`, dedupeKey: `no_response:${q.kind}:${q.id}:${t}` });
  }
  for (const a of r.sample_feedback) {
    n += notify(a.created_by, { type: 'sample_feedback', title: `Sample feedback pending: ${a.customer_name}`, message: `Delivered ${a.days} days ago`, link: a.lead_id ? `/leads/${a.lead_id}` : `/customers/${a.customer_id}`, dedupeKey: `sample:${a.id}` });
  }
  for (const p of r.po_promised) {
    n += notify(p.assigned_to, { type: 'po_promised', title: `PO promised but not received: ${p.code}`, message: `${p.customer_name} · ${p.days} days late`, link: p.kind === 'lead' ? `/leads/${p.id}` : `/quotations/${p.id}`, severity: 'warning', dedupeKey: `po_promised:${p.kind}:${p.id}:${t}` });
  }
  for (const l of r.no_next_action) {
    n += notify(l.assigned_to, { type: 'no_next_action', title: `Lead without next action: ${l.code}`, message: l.customer_name, link: `/leads/${l.id}`, severity: 'warning', dedupeKey: `no_next:${l.id}:${t}` });
  }
  return n;
}

function delayedOrders() {
  const t = today();
  let n = 0;
  const rows = all(`SELECT o.*, c.name AS customer_name, p.planned_completion, p.revised_completion, p.actual_completion, ${ORDER_ROLLUP}
    FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN production p ON p.order_id = o.id WHERE o.status = 'active'`).map(decorateOrder);
  for (const o of rows) {
    const recipients = [o.sales_owner_id, o.production_owner_id].filter(Boolean);
    if (o.is_delayed) {
      n += notify(recipients.length ? recipients : { roles: ['sales_head'] }, {
        type: 'order_delayed', title: `${o.number} is ${o.delay_days} day${o.delay_days === 1 ? '' : 's'} past delivery date`,
        message: `${o.customer_name}${o.delay_reason ? ` · ${o.delay_reason}` : ' · add a delay reason'}`, link: `/orders/${o.id}`, severity: 'danger',
        dedupeKey: `delayed:${o.id}:${t}`,
      });
      continue;
    }
    const completion = o.revised_completion || o.planned_completion;
    if (!o.actual_completion && completion && o.delivery_date && completion > o.delivery_date) {
      n += notify(recipients, {
        type: 'delivery_risk', title: `${o.number} at risk: production completes after committed delivery`,
        message: `Completion ${completion} vs delivery ${o.delivery_date}`, link: `/orders/${o.id}`, severity: 'warning', dedupeKey: `risk:${o.id}:${completion}`,
      });
    }
  }
  return n;
}

function overduePayments() {
  const t = today();
  let n = 0;
  for (const i of all(
    `SELECT i.*, c.name AS customer_name, c.assigned_to, o.number AS order_number, o.sales_owner_id, o.accounts_owner_id
     FROM invoice_balances i JOIN customers c ON c.id = i.customer_id LEFT JOIN sales_orders o ON o.id = i.order_id
     WHERE i.balance > 1 AND i.due_date < ?`,
    t,
  )) {
    const days = daysBetween(i.due_date, t);
    const accountsUser = i.accounts_owner_id || get("SELECT id FROM users WHERE role = 'accounts' AND active = 1 ORDER BY id LIMIT 1")?.id;
    const key = `collect:${i.id}`;
    if (!get("SELECT id FROM followups WHERE auto_key = ? AND status = 'pending'", key) && accountsUser) {
      insert('followups', {
        title: `Collect ${inr(i.balance)} against ${i.number}`, type: 'payment', customer_id: i.customer_id, order_id: i.order_id, invoice_id: i.id,
        assigned_to: accountsUser, due_date: t, priority: days > 60 ? 'high' : 'normal', status: 'pending', auto_key: key, created_at: nowIso(),
      });
      n++;
    }
    // Weekly nudge so reminders keep coming without flooding.
    const week = Math.floor(days / 7);
    n += notify([accountsUser, i.sales_owner_id || i.assigned_to], {
      type: 'payment_overdue', title: `Payment overdue ${days} days: ${i.customer_name}`,
      message: `${i.number} · balance ${inr(i.balance)}`, link: `/payments?customer=${i.customer_id}`, severity: days > 60 ? 'danger' : 'warning',
      dedupeKey: `overdue:${i.id}:w${week}`,
    });
  }
  return n;
}

// Cap on automatically created re-engagement / repeat-order tasks per salesperson per day,
// so a backlog of dormant accounts trickles in instead of flooding someone's list.
const DAILY_TASK_CAP = 3;
function createdToday(userId, type) {
  return get("SELECT COUNT(*) AS n FROM followups WHERE assigned_to = ? AND type = ? AND auto_key IS NOT NULL AND substr(created_at, 1, 10) = ?", userId, type, today()).n;
}

function dormantAndRepeat() {
  const r = computeReminders(null);
  const t = today();
  let n = 0;
  for (const c of r.dormant_customers) {
    if (c.has_open_lead || !c.assigned_to) continue;
    if (createdToday(c.assigned_to, 'reengage') >= DAILY_TASK_CAP) continue;
    const key = `reengage:${c.id}`;
    if (get("SELECT id FROM followups WHERE auto_key = ? AND status = 'pending'", key)) continue;
    if (get("SELECT id FROM followups WHERE auto_key = ? AND completed_at > ?", key, addDays(t, -60))) continue;
    insert('followups', {
      title: `Re-engage dormant customer (no order for ${c.days} days)`, type: 'reengage', customer_id: c.id, assigned_to: c.assigned_to,
      due_date: addDays(t, 2), priority: c.lifetime_value > 2000000 ? 'high' : 'normal', status: 'pending', auto_key: key, created_at: nowIso(),
    });
    notify(c.assigned_to, { type: 'dormant_customer', title: `${c.name} has gone quiet`, message: `Last order ${c.last_order} · lifetime ${inr(c.lifetime_value)}`, link: `/customers/${c.id}`, severity: 'warning', dedupeKey: `dormant:${c.id}:${c.last_order}` });
    n++;
  }
  for (const c of r.repeat_opportunities) {
    if (!c.assigned_to) continue;
    if (createdToday(c.assigned_to, 'repeat_order') >= DAILY_TASK_CAP) continue;
    const key = `repeat:${c.id}:${c.last_order}`;
    if (get('SELECT id FROM followups WHERE auto_key = ?', key)) continue;
    insert('followups', {
      title: `Repeat order due: usually orders every ${c.cycle} days`, type: 'repeat_order', customer_id: c.id, assigned_to: c.assigned_to,
      due_date: t, priority: 'normal', status: 'pending', auto_key: key, created_at: nowIso(),
    });
    notify(c.assigned_to, { type: 'repeat_opportunity', title: `Repeat order opportunity: ${c.name}`, message: `Reorders every ~${c.cycle} days; last order ${c.days} days ago`, link: `/customers/${c.id}`, severity: 'success', dedupeKey: key });
    n++;
  }
  return n;
}

export function buildSummary(from, to) {
  const count = (sql, ...p) => get(sql, ...p)?.n || 0;
  const orders = get("SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS v FROM sales_orders WHERE order_date BETWEEN ? AND ? AND status <> 'cancelled'", from, to);
  const collections = get('SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE payment_date BETWEEN ? AND ?', from, to).v;
  const quotes = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(v.grand_total), 0) AS v FROM quotation_events e JOIN quotation_versions v ON v.quotation_id = e.quotation_id AND v.version_no = e.version_no
     WHERE e.event = 'sent' AND substr(e.created_at, 1, 10) BETWEEN ? AND ?`, from, to,
  );
  const delayed = all(`SELECT o.*, ${ORDER_ROLLUP} FROM sales_orders o WHERE o.status = 'active'`).map(decorateOrder).filter((o) => o.is_delayed).length;
  return {
    from, to,
    new_leads: count('SELECT COUNT(*) AS n FROM leads WHERE substr(created_at, 1, 10) BETWEEN ? AND ?', from, to),
    leads_won: count("SELECT COUNT(*) AS n FROM leads WHERE status = 'won' AND substr(closed_at, 1, 10) BETWEEN ? AND ?", from, to),
    leads_lost: count("SELECT COUNT(*) AS n FROM leads WHERE status = 'lost' AND substr(closed_at, 1, 10) BETWEEN ? AND ?", from, to),
    quotations_sent: quotes.n,
    quotations_value: quotes.v,
    orders_booked: orders.n,
    order_value: orders.v,
    dispatches: count('SELECT COUNT(*) AS n FROM dispatches WHERE dispatch_date BETWEEN ? AND ?', from, to),
    collections,
    complaints_opened: count('SELECT COUNT(*) AS n FROM complaints WHERE substr(created_at, 1, 10) BETWEEN ? AND ?', from, to),
    complaints_resolved: count('SELECT COUNT(*) AS n FROM complaints WHERE substr(resolved_at, 1, 10) BETWEEN ? AND ?', from, to),
    overdue_followups: count("SELECT COUNT(*) AS n FROM followups WHERE status = 'pending' AND due_date < ?", to),
    delayed_orders: delayed,
    outstanding: get('SELECT COALESCE(SUM(balance), 0) AS v FROM invoice_balances WHERE balance > 1').v,
    overdue_receivables: get('SELECT COALESCE(SUM(balance), 0) AS v FROM invoice_balances WHERE balance > 1 AND due_date < ?', to).v,
    fy_order_value: get("SELECT COALESCE(SUM(grand_total), 0) AS v FROM sales_orders WHERE order_date >= ? AND status <> 'cancelled'", fyStart(to)).v,
  };
}

function summaries() {
  const t = today();
  let n = 0;
  const yesterday = addDays(t, -1);
  if (!get("SELECT id FROM summaries WHERE period = 'daily' AND period_key = ?", yesterday)) {
    const data = buildSummary(yesterday, yesterday);
    insert('summaries', { period: 'daily', period_key: yesterday, data, created_at: nowIso() });
    notify({ roles: ['management', 'sales_head'] }, {
      type: 'summary', title: `Daily summary for ${yesterday}`,
      message: `${data.new_leads} new leads · ${data.orders_booked} orders (${inr(data.order_value)}) · collected ${inr(data.collections)}`,
      link: '/reports?report=summaries', dedupeKey: `summary:daily:${yesterday}`,
    });
    n++;
  }
  const d = new Date(`${t}T00:00:00`);
  const monday = addDays(t, -((d.getDay() + 6) % 7));
  const lastWeekStart = addDays(monday, -7);
  if (!get("SELECT id FROM summaries WHERE period = 'weekly' AND period_key = ?", lastWeekStart)) {
    const data = buildSummary(lastWeekStart, addDays(monday, -1));
    insert('summaries', { period: 'weekly', period_key: lastWeekStart, data, created_at: nowIso() });
    notify({ roles: ['management', 'sales_head'] }, {
      type: 'summary', title: `Weekly summary: week of ${lastWeekStart}`,
      message: `${data.orders_booked} orders (${inr(data.order_value)}) · ${data.quotations_sent} quotations · ${data.delayed_orders} delayed orders`,
      link: '/reports?report=summaries', dedupeKey: `summary:weekly:${lastWeekStart}`,
    });
    n++;
  }
  return n;
}

export const RULES = [
  { key: 'assign_leads', label: 'Assign leads by region or product', setting: 'autoAssignLeads', fn: assignLeads },
  { key: 'followup_digest', label: 'Follow-ups due today digest', fn: dueTodayDigest },
  { key: 'escalate_overdue', label: 'Escalate overdue follow-ups to managers', setting: 'escalateOverdue', fn: escalateOverdue },
  { key: 'expire_quotations', label: 'Expire quotations past validity', fn: expireQuotations },
  { key: 'sales_reminders', label: 'Quotation expiry, no response, sample feedback, PO promised', fn: reminderNotifications },
  { key: 'delayed_orders', label: 'Warn about delayed or at-risk deliveries', setting: 'delayWarnings', fn: delayedOrders },
  { key: 'overdue_payments', label: 'Remind accounts about overdue payments', setting: 'paymentReminders', fn: overduePayments },
  { key: 'dormant_repeat', label: 'Identify dormant customers and repeat-order opportunities', setting: 'dormantDetection', fn: dormantAndRepeat },
  { key: 'summaries', label: 'Daily and weekly management summaries', setting: 'managementSummaries', fn: summaries },
];

export function runAutomation({ only, force = false } = {}) {
  const cfg = settingsOf('automation');
  const results = [];
  if (!cfg.enabled && !force) return results;
  for (const rule of RULES) {
    if (only && !only.includes(rule.key)) continue;
    if (rule.setting && cfg[rule.setting] === false && !force) continue;
    try {
      const affected = rule.fn();
      results.push({ rule: rule.key, label: rule.label, affected });
      insert('automation_log', { rule: rule.key, message: `${affected} action${affected === 1 ? '' : 's'}`, affected, run_at: nowIso() });
    } catch (err) {
      console.error(`[automation] ${rule.key} failed`, err);
      results.push({ rule: rule.key, label: rule.label, error: err.message });
      insert('automation_log', { rule: rule.key, message: `Error: ${err.message}`, affected: 0, run_at: nowIso() });
    }
  }
  setSetting('automation_last_run', nowIso());
  return results;
}

let timer = null;
export function startScheduler() {
  const cfg = settingsOf('automation');
  const minutes = Math.max(1, Number(cfg.intervalMinutes) || 15);
  clearInterval(timer);
  setTimeout(() => runAutomation(), 3000);
  timer = setInterval(() => runAutomation(), minutes * 60000);
  timer.unref?.();
}
