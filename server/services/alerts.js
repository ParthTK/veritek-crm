// Scheduled evaluator. One alert per rule + record + unresolved condition: running twice (or retrying a
// failed run) never creates duplicates. Alerts can be acknowledged without marking the business issue
// resolved; they resolve themselves when the condition clears. Reminders create internal tasks only —
// they never prove the customer was contacted.
import { all, get, insert, run, tx, update } from '../db.js';
import { now, nowIso, today, tz, calendar, settings, notify, audit, optionLabel, withContext, outstandingSql } from '../util.js';
import { addDays, workingDaysBetween, localDate } from '../../shared/dates.js';
import { createTask, decorateTask } from './tasks.js';
import { loadOrdersWithLines, decorateLine, refreshCustomerUpdateTask } from './orders.js';
import { EFFECTIVE_LAST_ORDER_SQL } from './customers.js';
import { escalationManagerFor, defaultCoordinatorId } from './people.js';
import { openCaseFor } from './reactivation.js';

export const SYSTEM_USER = { id: null, name: 'System', role: 'super_admin', group: 'admin', scope: 'all', permissions: ['values.view', 'margin.view', 'finance.full'], values_access: true };

class AlertSet {
  constructor(rule) {
    this.rule = rule;
    this.seen = new Set();
    this.created = 0;
    this.open = 0;
  }

  upsert(key, fields) {
    this.seen.add(key);
    this.open++;
    const stamp = nowIso();
    const existing = get('SELECT id FROM alerts WHERE alert_key = ? AND resolved_at IS NULL', key);
    if (existing) {
      update('alerts', existing.id, { title: fields.title, detail: fields.detail ?? null, severity: fields.severity || 'warning', owner_id: fields.owner_id ?? null, last_seen_at: stamp });
      return existing.id;
    }
    this.created++;
    return insert('alerts', { rule: this.rule, alert_key: key, ...fields, first_seen_at: stamp, last_seen_at: stamp });
  }

  resolveRest() {
    let resolved = 0;
    for (const a of all('SELECT id, alert_key FROM alerts WHERE rule = ? AND resolved_at IS NULL', this.rule)) {
      if (this.seen.has(a.alert_key)) continue;
      update('alerts', a.id, { resolved_at: nowIso(), resolution: 'Condition cleared' });
      resolved++;
    }
    return { open: this.open, created: this.created, resolved };
  }
}

function activeLines() {
  const out = [];
  for (const { order, lines } of loadOrdersWithLines(["o.status = 'confirmed'", 'o.closed_at IS NULL'])) {
    for (const l of lines) {
      const d = decorateLine(l, 'confirmed');
      if (d.status.active) out.push({ ...d, order });
    }
  }
  return out;
}

const lineTitle = (l) => `${l.order.code} · ${l.order.customer_name} · ${l.product}`;

function ruleEnquiryNoResponse() {
  const set = new AlertSet('enquiry_no_response');
  const nowStr = now().toISOString();
  for (const e of all(`SELECT e.*, c.company_name,
      (SELECT MIN(t.overdue_at) FROM tasks t WHERE t.enquiry_id = e.id AND t.purpose_code = 'respond_enquiry') AS response_due
    FROM enquiries e JOIN customers c ON c.id = e.customer_id
    WHERE e.first_response_at IS NULL AND e.stage IN ('new','clarification','quote_to_prepare') AND e.received_at IS NOT NULL`)) {
    const due = e.response_due || addDays(localDate(new Date(e.received_at), tz()), 2);
    if (nowStr < due) continue;
    set.upsert(`no_response:enquiry:${e.id}`, {
      entity_type: 'enquiry', entity_id: e.id, enquiry_id: e.id, customer_id: e.customer_id, owner_id: e.owner_id, severity: 'warning',
      title: `${e.code} · ${e.company_name}: no response recorded yet`, detail: `Received ${e.received_at}`,
    });
  }
  return set.resolveRest();
}

function ruleCommitmentOverdue(ctx) {
  const set = new AlertSet('commitment_overdue');
  const day = today();
  for (const l of ctx.lines) {
    if (!l.status.overdue) continue;
    set.upsert(`overdue:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.owner_id, severity: 'critical',
      title: `${lineTitle(l)}: dispatch overdue by ${l.status.daysLate} day${l.status.daysLate === 1 ? '' : 's'}`,
      detail: `Original commitment ${l.original_commitment_date}; ${l.quantities.remaining} ${l.unit} outstanding`,
    });
    // A missed commitment needs the customer told — unless they already know a date that has not passed.
    const expected = l.agreed_commitment_date || l.original_commitment_date;
    if (day > expected && l.comm.state !== 'pending') {
      const latest = get("SELECT * FROM commitment_changes WHERE line_id = ? AND kind IN ('forecast_dispatch','missed') ORDER BY id DESC LIMIT 1", l.id);
      const knownFuture = latest?.informed_at && (latest.agreed_date || latest.new_date) && (latest.agreed_date || latest.new_date) >= day;
      const already = get("SELECT id FROM commitment_changes WHERE line_id = ? AND kind = 'missed' AND new_date = ?", l.id, expected);
      if (!knownFuture && !already) {
        const stamp = nowIso();
        insert('commitment_changes', { line_id: l.id, order_id: l.order_id, kind: 'missed', old_date: expected, new_date: expected, comm_required: 1, reason: 'Commitment date passed with balance outstanding', created_at: stamp, occurred_at: stamp });
        ctx.refresh.add(l.order_id);
      }
    }
  }
  return set.resolveRest();
}

function ruleForecastLate(ctx) {
  const set = new AlertSet('forecast_late');
  for (const l of ctx.lines) {
    if (!l.status.atRisk) continue;
    set.upsert(`forecast_late:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.owner_id, severity: 'warning',
      title: `${lineTitle(l)}: forecast ${l.forecast_dispatch_date} is after the commitment ${l.original_commitment_date}`,
      detail: l.issue_label ? `${l.issue_label}${l.stage_note ? ` — ${l.stage_note}` : ''}` : null,
    });
    if (l.comm.state === 'pending') ctx.refresh.add(l.order_id);
  }
  return set.resolveRest();
}

function ruleStale(ctx) {
  const set = new AlertSet('update_stale');
  const coordinator = defaultCoordinatorId();
  for (const l of ctx.lines) {
    if (!l.freshness?.stale) continue;
    set.upsert(`stale:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.coordinator_id || coordinator, severity: 'info',
      title: `${lineTitle(l)}: no production update for ${l.freshness.working_days ?? '?'} working days`,
      detail: l.freshness.as_of ? `Last source update ${l.freshness.as_of}${l.freshness.basis === 'entry_time' ? ' (entry-time based)' : ''}` : 'No source update recorded',
    });
  }
  return set.resolveRest();
}

function ruleReadyWaiting(ctx) {
  const set = new AlertSet('ready_not_dispatched');
  const grace = settings().rules.readyGraceWorkingDays;
  for (const l of ctx.lines) {
    if (!l.ready_waiting || !l.ready_since) continue;
    const wd = workingDaysBetween(localDate(new Date(l.ready_since), tz()), today(), calendar());
    if (wd < grace) continue;
    set.upsert(`ready_waiting:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.coordinator_id || defaultCoordinatorId(), severity: 'warning',
      title: `${lineTitle(l)}: ready but not dispatched for ${wd} working day${wd === 1 ? '' : 's'}`,
      detail: l.quantities.readyNotDispatched !== null ? `${l.quantities.readyNotDispatched} ${l.unit} ready and waiting` : 'Marked ready for dispatch',
    });
  }
  return set.resolveRest();
}

function ruleNoAction(ctx) {
  const set = new AlertSet('delayed_no_action');
  for (const l of ctx.lines) {
    if (!(l.status.delayed || l.issue_code) || l.action_task_id) continue;
    set.upsert(`no_action:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.coordinator_id || defaultCoordinatorId(), severity: 'warning',
      title: `${lineTitle(l)}: delayed without a next action`, detail: l.issue_label || null,
    });
  }
  return set.resolveRest();
}

function ruleNotInformed(ctx) {
  const set = new AlertSet('customer_not_informed');
  for (const l of ctx.lines) {
    if (l.comm.state !== 'pending') continue;
    set.upsert(`not_informed:line:${l.id}`, {
      entity_type: 'order_line', entity_id: l.id, order_id: l.order_id, line_id: l.id, customer_id: l.order.customer_id, owner_id: l.order.owner_id, severity: 'warning',
      title: `${lineTitle(l)}: customer not informed of the date change`, detail: l.comm.new_date ? `Current expectation ${l.comm.new_date}` : 'Commitment missed',
    });
    ctx.refresh.add(l.order_id);
  }
  return set.resolveRest();
}

function ruleBlockerOverdue() {
  const set = new AlertSet('blocker_overdue');
  const nowStr = now().toISOString();
  const after = settings().rules.escalateAfterWorkingDays;
  for (const t of all(`SELECT t.*, u.name AS owner_name, o.code AS order_code FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.status = 'open' AND t.kind = 'internal' AND t.purpose_code IN ('blocker_action','obtain_estimate','release_hold') AND t.overdue_at <= ?`, nowStr)) {
    const id = set.upsert(`blocker_overdue:task:${t.id}`, {
      entity_type: 'task', entity_id: t.id, task_id: t.id, order_id: t.order_id, line_id: t.line_id, customer_id: t.customer_id, owner_id: t.owner_id, severity: 'critical',
      title: `${t.order_code ? `${t.order_code}: ` : ''}${t.purpose} — overdue (${t.owner_name})`, detail: `Due ${t.due_date}`,
    });
    const wd = workingDaysBetween(t.due_date, today(), calendar());
    if (wd >= after && !t.escalated_at) {
      const manager = escalationManagerFor(t.owner_id);
      if (manager && manager !== t.owner_id) {
        const stamp = nowIso();
        update('tasks', t.id, { escalated_at: stamp, escalated_to: manager });
        const sent = notify(manager, {
          title: 'Escalation: blocker action overdue', message: `${t.order_code ? `${t.order_code}: ` : ''}${t.purpose} — ${t.owner_name}, due ${t.due_date}`,
          link: t.order_id ? `/orders/${t.order_id}` : '/followups', severity: 'danger', dedupeKey: `escalation:task:${t.id}`, alertId: id,
        });
        run('UPDATE alerts SET escalated_at = ?, escalated_to = ?, notify_attempts = notify_attempts + 1, last_notify_at = ? WHERE id = ?', stamp, manager, stamp, id);
        if (!sent) run("UPDATE alerts SET last_notify_error = 'already notified' WHERE id = ?", id);
      }
    }
  }
  return set.resolveRest();
}

/** Customers past the inactivity threshold get a reactivation case and a reconnect task (capped per owner per day). */
function ruleCustomerInactive() {
  const r = settings().rules;
  const cutoff = addDays(today(), -r.dormantDays);
  const startOfDay = `${today()}`;
  const created = {};
  let made = 0;
  for (const c of all(`SELECT c.id, c.owner_id, c.company_name, ${EFFECTIVE_LAST_ORDER_SQL('c')} AS last_order
    FROM customers c WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL AND c.do_not_contact = 0 AND c.owner_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM reactivation_cases rc WHERE rc.customer_id = c.id AND (rc.closed_at IS NULL OR (rc.review_date IS NOT NULL AND rc.review_date > ?) OR (rc.status = 'not_pursuing' AND rc.review_date IS NULL)))
    ORDER BY last_order`, today())) {
    if (!c.last_order || c.last_order >= cutoff) continue;
    const owner = get('SELECT id, active FROM users WHERE id = ?', c.owner_id);
    if (!owner?.active) continue;
    if (created[c.owner_id] === undefined) {
      created[c.owner_id] = get("SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND source = 'scheduler:inactive' AND substr(created_at, 1, 10) >= ?", c.owner_id, addDays(startOfDay, -1)).n;
    }
    if (created[c.owner_id] >= r.reactivationDailyCapPerOwner) continue;
    const rc = openCaseFor(c.id, SYSTEM_USER, 'inactivity');
    const taskId = createTask({
      customer_id: c.id, reactivation_case_id: rc.id, purpose: 'Reconnect with customer', purpose_code: 'reactivation', owner_id: c.owner_id,
      due_date: today(), kind: 'customer', source: 'scheduler:inactive', alert_key: `inactive:customer:${c.id}:${c.last_order}`,
    }, SYSTEM_USER, { validated: true });
    update('reactivation_cases', rc.id, { task_id: taskId });
    created[c.owner_id]++;
    made++;
  }
  return { created: made };
}

function ruleInvoices() {
  const set = new AlertSet('invoice_overdue');
  const promises = new AlertSet('promise_broken');
  const day = today();
  const accounts = get("SELECT id FROM users WHERE role = 'accounts' AND active = 1 ORDER BY id LIMIT 1")?.id || defaultCoordinatorId();
  for (const i of all(`SELECT i.*, c.company_name, c.owner_id AS customer_owner,
      ${outstandingSql('i')} AS outstanding
    FROM invoices i JOIN customers c ON c.id = i.customer_id`)) {
    if (i.outstanding <= 0) continue;
    if (i.due_date && i.due_date < day) {
      set.upsert(`invoice_overdue:${i.id}`, {
        entity_type: 'invoice', entity_id: i.id, customer_id: i.customer_id, order_id: i.order_id, owner_id: i.owner_id || accounts, severity: 'warning',
        title: `${i.company_name}: invoice ${i.invoice_ref} overdue since ${i.due_date}`, detail: `${i.currency} ${(i.outstanding / 100).toFixed(2)} outstanding`,
      });
      createTask({ invoice_id: i.id, customer_id: i.customer_id, purpose: `Collect payment — ${i.invoice_ref}`, purpose_code: 'collection', owner_id: i.owner_id || accounts, due_date: day, kind: 'customer', source: 'scheduler:receivable', alert_key: `collect:invoice:${i.id}` }, SYSTEM_USER, { validated: true });
    }
    if (i.promise_date && i.promise_date < day) {
      promises.upsert(`promise_broken:${i.id}:${i.promise_date}`, {
        entity_type: 'invoice', entity_id: i.id, customer_id: i.customer_id, owner_id: i.owner_id || accounts, severity: 'warning',
        title: `${i.company_name}: payment promised for ${i.promise_date} not received (${i.invoice_ref})`,
      });
    }
  }
  return { overdue: set.resolveRest(), promises: promises.resolveRest() };
}

function ruleComplaints() {
  const set = new AlertSet('complaint_response');
  const nowStr = now().toISOString();
  for (const k of all(`SELECT k.*, c.company_name, (SELECT MIN(t.overdue_at) FROM tasks t WHERE t.complaint_id = k.id AND t.status = 'open') AS next_due
    FROM complaints k JOIN customers c ON c.id = k.customer_id WHERE k.status NOT IN ('resolved','closed')`)) {
    const late = (!k.first_response_at && workingDaysBetween(k.received_date, today(), calendar()) >= 1) || (k.next_due && k.next_due <= nowStr);
    if (!late) continue;
    set.upsert(`complaint:${k.id}`, {
      entity_type: 'complaint', entity_id: k.id, customer_id: k.customer_id, owner_id: k.owner_id, severity: 'warning',
      title: `${k.code} · ${k.company_name}: ${k.first_response_at ? 'next response overdue' : 'first response overdue'}`, detail: optionLabel('complaint_category', k.category_code),
    });
  }
  return set.resolveRest();
}

// ------------------------------------------------------------------ reminders carried over from the earlier module
/** Issued quotations close to their validity date: an internal task to follow up before they lapse. */
function ruleQuoteExpiring() {
  const set = new AlertSet('quote_expiring');
  const day = today();
  const warn = addDays(day, settings().reminders.quotationExpiryWarnDays ?? 3);
  for (const r of all(`SELECT r.id, r.validity_date, r.revision_no, q.id AS quotation_id, q.number, q.enquiry_id, q.customer_id, q.owner_id, c.company_name
    FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id JOIN customers c ON c.id = q.customer_id
    WHERE r.status = 'issued' AND r.validity_date IS NOT NULL AND r.validity_date BETWEEN ? AND ?`, day, warn)) {
    set.upsert(`quote_expiring:${r.id}`, {
      entity_type: 'quote_revision', entity_id: r.id, customer_id: r.customer_id, enquiry_id: r.enquiry_id, owner_id: r.owner_id, severity: 'info',
      title: `${r.number} rev ${r.revision_no} · ${r.company_name}: valid until ${r.validity_date}`, detail: 'Follow up before the offer lapses, or revise it',
    });
    if (r.owner_id && get('SELECT active FROM users WHERE id = ?', r.owner_id)?.active) {
      createTask({ quotation_id: r.quotation_id, enquiry_id: r.enquiry_id, customer_id: r.customer_id, purpose: `Quotation ${r.number} expires on ${r.validity_date} — follow up`, purpose_code: 'quote_followup', owner_id: r.owner_id, due_date: day, kind: 'customer', source: 'scheduler:quote_expiring', alert_key: `quote_expiring:${r.id}` }, SYSTEM_USER, { validated: true });
    }
  }
  return set.resolveRest();
}

/** A sample or catalogue shared with no later customer contact after N days: ask for feedback. */
function ruleSampleFeedback() {
  const days = settings().reminders.sampleFeedbackDays ?? 5;
  const cutoff = new Date(now().getTime() - days * 86400000).toISOString();
  let made = 0;
  for (const a of all(`SELECT a.id, a.customer_id, a.enquiry_id, a.occurred_at, a.entered_by, c.owner_id FROM activities a JOIN customers c ON c.id = a.customer_id
    WHERE a.outcome = 'sample_shared' AND a.occurred_at <= ? AND a.occurred_at >= ? AND c.do_not_contact = 0
      AND NOT EXISTS (SELECT 1 FROM activities b WHERE b.customer_id = a.customer_id AND b.customer_contact = 1 AND b.occurred_at > a.occurred_at)`, cutoff, addDays(today(), -90))) {
    const owner = [a.owner_id, a.entered_by].find((uid) => uid && get('SELECT active FROM users WHERE id = ?', uid)?.active);
    if (!owner) continue;
    const before = get('SELECT COUNT(*) AS n FROM tasks WHERE alert_key = ?', `sample_feedback:${a.id}`).n;
    if (before) continue;
    createTask({ customer_id: a.customer_id, enquiry_id: a.enquiry_id, purpose: 'Sample feedback — ask how the sample / catalogue was received', purpose_code: 'sample_feedback', owner_id: owner, due_date: today(), kind: 'customer', source: 'scheduler:sample', alert_key: `sample_feedback:${a.id}` }, SYSTEM_USER, { validated: true });
    made++;
  }
  return { created: made };
}

/**
 * Repeat-order suggestions: a customer who has ordered regularly and whose usual reorder interval has
 * passed, with nothing open, gets a "repeat order check" task for the owner (never an automatic message).
 */
function ruleRepeatOrder() {
  const cfg = settings().reminders;
  if (!cfg.repeatOrderEnabled) return { skipped: true };
  const day = today();
  let made = 0;
  for (const c of all(`SELECT c.id, c.owner_id, c.company_name FROM customers c WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL AND c.do_not_contact = 0 AND c.owner_id IS NOT NULL
      AND (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed') >= ?
      AND NOT EXISTS (SELECT 1 FROM enquiries e WHERE e.customer_id = c.id AND e.stage IN ('new','clarification','quote_to_prepare','quote_sent','awaiting_decision','on_hold'))
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed' AND o.closed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND t.status = 'open')`, cfg.repeatOrderMinOrders || 2)) {
    const dates = all("SELECT received_date FROM orders WHERE customer_id = ? AND status = 'confirmed' AND received_date IS NOT NULL ORDER BY received_date", c.id).map((r) => r.received_date);
    if (dates.length < (cfg.repeatOrderMinOrders || 2)) continue;
    const gaps = dates.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(dates[i])) / 86400000)).filter((g) => g > 0);
    if (!gaps.length) continue;
    const avg = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    const last = dates.at(-1);
    const due = addDays(last, avg);
    if (due > day || addDays(last, settings().rules.dormantDays) <= day) continue; // dormant customers are handled by reactivation
    if (!get('SELECT active FROM users WHERE id = ?', c.owner_id)?.active) continue;
    if (get('SELECT id FROM tasks WHERE alert_key = ?', `repeat_order:${c.id}:${last}`)) continue;
    createTask({ customer_id: c.id, purpose: `Repeat order check — usually orders every ~${avg} days (last ${last})`, purpose_code: 'repeat_order', owner_id: c.owner_id, due_date: day, kind: 'customer', source: 'scheduler:repeat', alert_key: `repeat_order:${c.id}:${last}` }, SYSTEM_USER, { validated: true });
    made++;
  }
  return { created: made };
}

/** Daily and weekly management summaries, stored once per period (re-runs do not duplicate them). */
function ruleSummaries() {
  if (!settings().reminders.managementSummaries) return { skipped: true };
  const day = today();
  const yesterday = addDays(day, -1);
  const made = [];
  const build = (from, to) => {
    const fromI = `${from}T00:00:00.000Z`;
    const toI = `${addDays(to, 1)}T00:00:00.000Z`;
    const n = (sql, ...p) => get(sql, ...p).n;
    return {
      from, to,
      enquiries: n('SELECT COUNT(*) AS n FROM enquiries WHERE received_at >= ? AND received_at < ?', fromI, toI),
      quotations_issued: n('SELECT COUNT(*) AS n FROM quote_revisions WHERE sent_at >= ? AND sent_at < ?', fromI, toI),
      orders_confirmed: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed' AND confirmed_at >= ? AND confirmed_at < ?", fromI, toI),
      dispatches: n("SELECT COUNT(*) AS n FROM dispatches WHERE status = 'posted' AND dispatch_date BETWEEN ? AND ?", from, to),
      won: n("SELECT COUNT(*) AS n FROM enquiries WHERE stage = 'won' AND decided_at >= ? AND decided_at < ?", fromI, toI),
      lost: n("SELECT COUNT(*) AS n FROM enquiries WHERE stage = 'lost' AND decided_at >= ? AND decided_at < ?", fromI, toI),
      complaints: n('SELECT COUNT(*) AS n FROM complaints WHERE received_date BETWEEN ? AND ?', from, to),
      overdue_tasks_now: n("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND overdue_at <= ?", now().toISOString()),
      open_alerts_now: n('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL'),
    };
  };
  const save = (period, key, data, title) => {
    const res = run('INSERT INTO summaries (period, period_key, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', period, key, JSON.stringify(data), nowIso());
    if (Number(res.changes)) {
      made.push(`${period}:${key}`);
      for (const u of all("SELECT id FROM users WHERE role IN ('management','super_admin','sales_head','viewer') AND active = 1 AND login_enabled = 1")) {
        notify(u.id, { title, message: `${data.enquiries} enquiries · ${data.quotations_issued} quotations · ${data.orders_confirmed} orders · ${data.dispatches} dispatches`, link: '/reports?r=activity_summary', dedupeKey: `summary:${period}:${key}` });
      }
    }
  };
  save('day', yesterday, build(yesterday, yesterday), `Daily summary for ${yesterday}`);
  if (new Date(`${day}T12:00:00Z`).getUTCDay() === 1) {
    const from = addDays(day, -7);
    save('week', from, build(from, yesterday), `Weekly summary ${from} – ${yesterday}`);
  }
  return { created: made };
}

export const RULES = [
  { key: 'enquiry_no_response', label: 'New enquiry lacks response', fn: ruleEnquiryNoResponse },
  { key: 'commitment_overdue', label: 'Active balance past commitment', fn: ruleCommitmentOverdue },
  { key: 'forecast_late', label: 'Order forecast beyond commitment', fn: ruleForecastLate },
  { key: 'update_stale', label: 'Order update stale', fn: ruleStale },
  { key: 'ready_not_dispatched', label: 'Ready but not dispatched', fn: ruleReadyWaiting },
  { key: 'delayed_no_action', label: 'Delayed without next action', fn: ruleNoAction },
  { key: 'customer_not_informed', label: 'Customer not informed', fn: ruleNotInformed },
  { key: 'blocker_overdue', label: 'Blocker action overdue (escalation)', fn: ruleBlockerOverdue },
  { key: 'customer_inactive', label: 'Customer inactive', fn: ruleCustomerInactive, module: 'pastCustomers' },
  { key: 'receivables', label: 'Overdue receivables & broken promises (P1)', fn: ruleInvoices, module: 'payments' },
  { key: 'complaints', label: 'Complaint responses (P1)', fn: ruleComplaints, module: 'complaints' },
  { key: 'quote_expiring', label: 'Quotation close to expiry', fn: ruleQuoteExpiring },
  { key: 'sample_feedback', label: 'Sample / catalogue feedback due', fn: ruleSampleFeedback },
  { key: 'repeat_order', label: 'Repeat-order check', fn: ruleRepeatOrder },
  { key: 'summaries', label: 'Daily / weekly management summary', fn: ruleSummaries },
];

/** Stored daily / weekly summaries, newest first. */
export function listSummaries(period = 'day', limit = 30) {
  return all('SELECT * FROM summaries WHERE period = ? ORDER BY period_key DESC LIMIT ?', period, limit).map((s) => ({ ...s, data: JSON.parse(s.data) }));
}

let running = false;
/** Runs every rule in its own transaction; a failing rule is recorded and monitored, the rest still run. */
export function runEvaluator({ trigger = 'scheduler' } = {}) {
  if (running) return { skipped: true, reason: 'A run is already in progress' };
  running = true;
  const started = nowIso();
  const runId = insert('scheduler_runs', { trigger, started_at: started, status: 'running' });
  const summary = {};
  const errors = [];
  try {
    return withContext({ source: 'scheduler', userId: null }, () => {
      const ctx = { lines: activeLines(), refresh: new Set() };
      for (const rule of RULES) {
        if (rule.module && !settings().modules[rule.module]) continue; // that module is switched off
        try {
          summary[rule.key] = tx(() => rule.fn(ctx));
        } catch (err) {
          errors.push({ rule: rule.key, message: err.message });
          summary[rule.key] = { error: err.message };
          insert('error_log', { at: nowIso(), method: 'SCHEDULER', path: rule.key, message: err.message, stack: err.stack?.slice(0, 4000) });
        }
      }
      try {
        tx(() => {
          for (const oid of ctx.refresh) refreshCustomerUpdateTask(oid, SYSTEM_USER);
        });
      } catch (err) {
        errors.push({ rule: 'customer_update_tasks', message: err.message });
      }
      const status = errors.length ? (errors.length === RULES.length ? 'failed' : 'partial') : 'ok';
      update('scheduler_runs', runId, { finished_at: nowIso(), status, summary: JSON.stringify(summary), error: errors.length ? JSON.stringify(errors) : null });
      if (errors.length) {
        for (const a of all("SELECT id FROM users WHERE role IN ('management','super_admin') AND active = 1")) {
          notify(a.id, { title: 'Reminder job had failures', message: errors.map((e) => `${e.rule}: ${e.message}`).join('; '), link: '/settings?tab=system', severity: 'danger', dedupeKey: `scheduler_fail:${today()}` });
        }
      }
      return { run_id: runId, status, summary, errors };
    });
  } finally {
    running = false;
  }
}

export function acknowledgeAlert(id, user) {
  const a = get('SELECT * FROM alerts WHERE id = ?', id);
  if (!a) return null;
  update('alerts', id, { acknowledged_at: nowIso(), acknowledged_by: user.id });
  audit('alert', id, 'acknowledge', { rule: a.rule });
  return { id };
}

export function listAlerts(query = {}) {
  const where = ['a.resolved_at IS NULL'];
  const params = [];
  if (query.rule) {
    where.push('a.rule = ?');
    params.push(query.rule);
  }
  if (query.owner) {
    where.push('a.owner_id = ?');
    params.push(query.owner);
  }
  return all(`SELECT a.*, u.name AS owner_name, eu.name AS escalated_to_name FROM alerts a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN users eu ON eu.id = a.escalated_to
    WHERE ${where.join(' AND ')} ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.first_seen_at LIMIT 500`, ...params);
}

export function lastRun() {
  return get('SELECT * FROM scheduler_runs ORDER BY id DESC LIMIT 1');
}

let timer = null;
export function startScheduler(extraTick) {
  stopScheduler();
  const { enabled, intervalMinutes } = settings().scheduler;
  if (!enabled) return;
  const tick = () => {
    try {
      runEvaluator({ trigger: 'scheduler' });
      extraTick?.();
    } catch (err) {
      console.error('Scheduler run failed', err);
    }
  };
  setTimeout(tick, 4000).unref?.();
  timer = setInterval(tick, Math.max(1, Number(intervalMinutes) || 15) * 60000);
  timer.unref?.();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { decorateTask };
