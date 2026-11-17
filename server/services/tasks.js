// Tasks are actions to perform; activities record what actually happened. Completing a task records an
// activity and (normally) creates the next task in the same transaction.
import { all, get, insert, run, tx, updateVersioned } from '../db.js';
import {
  Check, badRequest, conflict, notFound, now, nowIso, today, tz, str, intId, bool, checkOption, audit, history, optionLabel, placeholders,
} from '../util.js';
import { overdueAt, dueState, localDate, isInstant } from '../../shared/dates.js';
import { OPEN_ENQUIRY_STAGES } from '../../shared/constants.js';
import { requireActiveUser, resolveReporter } from './people.js';
import { linkAttachment } from './attachments.js';
import { taskScope } from '../access.js';

/** Fills in customer/enquiry/order links from whichever specific record a task or activity points at. */
export function resolveLinks(input) {
  const out = {
    customer_id: intId(input.customer_id),
    enquiry_id: intId(input.enquiry_id),
    order_id: intId(input.order_id),
    line_id: intId(input.line_id),
    reactivation_case_id: intId(input.reactivation_case_id),
    complaint_id: intId(input.complaint_id),
    invoice_id: intId(input.invoice_id),
    quotation_id: intId(input.quotation_id),
  };
  if (out.quotation_id && (!out.enquiry_id || !out.customer_id)) {
    const q = get('SELECT enquiry_id, customer_id FROM quotations WHERE id = ?', out.quotation_id);
    out.enquiry_id ||= q?.enquiry_id ?? null;
    out.customer_id ||= q?.customer_id ?? null;
  }
  if (out.line_id && !out.order_id) out.order_id = get('SELECT order_id FROM order_lines WHERE id = ?', out.line_id)?.order_id ?? null;
  if (out.order_id && !out.customer_id) out.customer_id = get('SELECT customer_id FROM orders WHERE id = ?', out.order_id)?.customer_id ?? null;
  if (out.enquiry_id && !out.customer_id) out.customer_id = get('SELECT customer_id FROM enquiries WHERE id = ?', out.enquiry_id)?.customer_id ?? null;
  if (out.reactivation_case_id && !out.customer_id) out.customer_id = get('SELECT customer_id FROM reactivation_cases WHERE id = ?', out.reactivation_case_id)?.customer_id ?? null;
  if (out.complaint_id && !out.customer_id) out.customer_id = get('SELECT customer_id FROM complaints WHERE id = ?', out.complaint_id)?.customer_id ?? null;
  if (out.invoice_id && !out.customer_id) out.customer_id = get('SELECT customer_id FROM invoices WHERE id = ?', out.invoice_id)?.customer_id ?? null;
  const specific = [['line', out.line_id], ['order', out.order_id], ['quotation', out.quotation_id], ['enquiry', out.enquiry_id], ['complaint', out.complaint_id], ['invoice', out.invoice_id], ['reactivation', out.reactivation_case_id], ['customer', out.customer_id]]
    .find(([, v]) => v);
  out.entity_type = specific?.[0] ?? null;
  out.entity_id = specific?.[1] ?? null;
  return out;
}

const PURPOSE_CODES = {
  'respond to enquiry': 'respond_enquiry', 'send quotation': 'send_quotation', 'send revised offer': 'revised_offer', 'follow up quotation': 'quote_followup',
  'confirm purchase decision': 'quote_followup', 'reconnect with customer': 'reactivation', 'ask why they did not proceed': 'ask_feedback',
  'obtain revised estimate': 'obtain_estimate', 'agree dispatch commitment': 'agree_commitment', 'collect payment': 'collection',
  'collect purchase order': 'po_followup', 'sample feedback': 'sample_feedback', 'repeat order check': 'repeat_order', 'site visit': 'site_visit',
  'share datasheet': 'share_datasheet',
};
/** Stable code for well-known purposes, so automation can recognise a task whatever form created it. */
export const purposeCode = (purpose) => PURPOSE_CODES[String(purpose || '').trim().toLowerCase()] || null;

export function validateTaskInput(c, input, prefix = '') {
  c.text(`${prefix}purpose`, input?.purpose, { required: true, max: 200, label: 'Next action' });
  requireActiveUser(c, `${prefix}owner_id`, intId(input?.owner_id), 'Owner');
  c.date(`${prefix}due_date`, input?.due_date, { required: true, message: 'Choose a due date' });
  c.time(`${prefix}due_time`, input?.due_time);
  c.note(`${prefix}note`, input?.note);
}

/**
 * Creates a task. Scheduler-made tasks pass an alert_key so a re-run refreshes the existing open task
 * instead of creating a duplicate.
 */
export function createTask(input, user, { validated = false } = {}) {
  if (!validated) {
    const c = new Check();
    validateTaskInput(c, input);
    c.throwIfAny();
  }
  if (input.alert_key) {
    const existing = get("SELECT id FROM tasks WHERE alert_key = ? AND status = 'open'", input.alert_key);
    if (existing) {
      if (input.refresh_purpose) run('UPDATE tasks SET purpose = ?, updated_at = ? WHERE id = ?', input.purpose, nowIso(), existing.id);
      return existing.id;
    }
  }
  const links = resolveLinks(input);
  const dueTime = str(input.due_time) || null;
  const stamp = nowIso();
  const id = insert('tasks', {
    ...links,
    purpose: str(input.purpose, 200),
    purpose_code: input.purpose_code || purposeCode(input.purpose),
    kind: input.kind === 'internal' ? 'internal' : 'customer',
    priority: ['low', 'normal', 'high', 'urgent'].includes(input.priority) ? input.priority : 'normal',
    customer_promise: bool(input.customer_promise) ? 1 : 0,
    owner_id: intId(input.owner_id),
    due_date: input.due_date,
    due_time: dueTime,
    overdue_at: overdueAt(input.due_date, dueTime, tz()),
    original_due_date: input.due_date,
    original_due_time: dueTime,
    status: 'open',
    source: input.source || 'manual',
    alert_key: input.alert_key || null,
    note: str(input.note, 1000),
    created_by: user?.id ?? null,
    created_at: stamp,
    updated_at: stamp,
  });
  audit('task', id, 'create', { purpose: input.purpose, owner_id: input.owner_id, due_date: input.due_date, source: input.source || 'manual' });
  return id;
}

function loadOpenTask(taskId, version) {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) throw notFound('Task');
  if (t.status !== 'open') throw conflict(`This task is already ${t.status === 'done' ? 'completed' : 'cancelled'}.`, { code: 'not_open', current: t });
  if (version !== undefined && version !== null && Number(version) !== t.version) {
    throw conflict('Someone else changed this task. Review the latest version before saving.', { code: 'version_conflict', current: t });
  }
  return t;
}

// ------------------------------------------------------------------ activities
function checkOccurredAt(c, value, field = 'occurred_at') {
  if (!value) return;
  if (!isInstant(value)) c.fail(field, 'Use a valid date and time');
  else if (Date.parse(value) > now().getTime() + 10 * 60000) c.fail(field, 'This cannot be in the future');
}

/**
 * Records what actually happened. Internal notes are never customer communications; a "no answer"
 * attempt is recorded as an attempt and does not count as a meaningful response.
 */
export function recordActivity(input, user, { validated = false } = {}) {
  const channel = input.channel || 'phone';
  const internal = channel === 'internal' || input.kind === 'internal';
  if (!validated) {
    const c = new Check();
    checkOption(c, 'channel', 'channel', channel, { note: input.note });
    if (!internal && !input.system_outcome) checkOption(c, 'outcome', input.outcome_category || 'contact_outcome', input.outcome, { note: input.note });
    c.note('note', input.note, { required: internal && !input.outcome, requiredMessage: 'Add the note' });
    checkOccurredAt(c, input.occurred_at);
    resolveReporter(input, user, c);
    c.throwIfAny();
  }
  const links = resolveLinks(input);
  if (!links.customer_id && !internal) throw badRequest('Choose the customer this contact was with', { customer_id: 'Required' });
  const reporter = resolveReporter(input, user, new Check());
  const stamp = nowIso();
  const occurred = input.occurred_at ? new Date(input.occurred_at).toISOString() : stamp;
  const outcome = internal ? (input.outcome || 'note') : input.outcome;
  const customerContact = internal ? 0 : 1;
  const meaningful = customerContact && outcome !== 'no_answer' ? 1 : 0;
  const id = insert('activities', {
    ...links,
    contact_id: intId(input.contact_id),
    quote_revision_id: intId(input.quote_revision_id),
    kind: internal ? 'internal' : input.kind || 'contact',
    channel,
    outcome,
    note: str(input.note, 1000),
    duration_minutes: Number.isInteger(Number(input.duration_minutes)) && Number(input.duration_minutes) > 0 ? Number(input.duration_minutes) : null,
    campaign_id: intId(input.campaign_id),
    customer_contact: customerContact,
    meaningful,
    occurred_at: occurred,
    entered_at: stamp,
    entered_by: user?.id ?? null,
    ...reporter,
    technical_issue: bool(input.technical_issue) ? 1 : 0,
    task_id: intId(input.task_id),
    created_at: stamp,
  });
  for (const aid of input.attachment_ids || []) linkAttachment(intId(aid), 'activity', id, user);

  // First meaningful human response on an enquiry (opening a record or assigning an owner never counts).
  if (meaningful && links.enquiry_id) {
    const e = get('SELECT id, first_response_at, received_at FROM enquiries WHERE id = ?', links.enquiry_id);
    if (e && !e.first_response_at && (!e.received_at || occurred >= e.received_at)) {
      run('UPDATE enquiries SET first_response_at = ?, first_response_activity_id = ?, updated_at = ? WHERE id = ?', occurred, id, stamp, e.id);
      history('enquiry', e.id, 'first_response', { customerId: links.customer_id, data: { activity_id: id }, occurredAt: occurred });
    }
  }
  if (meaningful && links.complaint_id) {
    run('UPDATE complaints SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?', occurred, stamp, links.complaint_id);
  }
  // Reactivation progress follows actual contact.
  if (links.reactivation_case_id && customerContact) {
    const rc = get('SELECT * FROM reactivation_cases WHERE id = ?', links.reactivation_case_id);
    if (rc && !rc.closed_at) {
      const status = meaningful && ['not_reviewed', 'to_contact'].includes(rc.status) ? 'contacted' : rc.status;
      run('UPDATE reactivation_cases SET last_outcome = ?, last_contact_at = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?', outcome, occurred, status, stamp, rc.id);
    }
  }
  audit('activity', id, 'create', { channel, outcome, occurred_at: occurred, ...links });
  return id;
}

// ------------------------------------------------------------------ completion, reschedule, reassign, cancel
/**
 * One save: record the actual outcome, close the task and (normally) create the next action.
 * An open enquiry must keep a next action or a recorded reason for no follow-up.
 */
export function completeTask(taskId, input, user) {
  const t = loadOpenTask(taskId, input.version);
  const c = new Check();
  const internal = t.kind === 'internal' || input.channel === 'internal';
  const channel = internal ? 'internal' : input.channel || 'phone';
  checkOption(c, 'channel', 'channel', channel, { note: input.note });
  if (!internal) checkOption(c, 'outcome', 'contact_outcome', input.outcome, { note: input.note });
  c.note('note', input.note);
  checkOccurredAt(c, input.occurred_at);
  resolveReporter(input, user, c);
  const next = input.next && (input.next.purpose || input.next.due_date) ? input.next : null;
  if (next) validateTaskInput(c, next, 'next.');
  if (t.enquiry_id && !next) {
    const e = get('SELECT stage FROM enquiries WHERE id = ?', t.enquiry_id);
    const others = get("SELECT COUNT(*) AS n FROM tasks WHERE enquiry_id = ? AND status = 'open' AND id <> ?", t.enquiry_id, t.id).n;
    if (e && OPEN_ENQUIRY_STAGES.includes(e.stage) && !others && !str(input.no_followup_reason)) {
      c.fail('next.purpose', 'This enquiry is still open — set the next action, or record why no follow-up is needed');
    }
  }
  c.throwIfAny();

  return tx(() => {
    const activityId = recordActivity({
      customer_id: t.customer_id, enquiry_id: t.enquiry_id, order_id: t.order_id, line_id: t.line_id,
      reactivation_case_id: t.reactivation_case_id, complaint_id: t.complaint_id, invoice_id: t.invoice_id,
      contact_id: input.contact_id, channel, outcome: internal ? 'done' : input.outcome, note: input.note,
      occurred_at: input.occurred_at, reported_by_id: input.reported_by_id, reported_by_name: input.reported_by_name,
      kind: internal ? 'internal' : 'contact', task_id: t.id, attachment_ids: input.attachment_ids,
      technical_issue: input.technical_issue,
    }, user, { validated: true });
    const occurred = get('SELECT occurred_at FROM activities WHERE id = ?', activityId).occurred_at;
    const late = Date.parse(occurred) >= Date.parse(t.overdue_at) ? 1 : 0;
    const stamp = nowIso();
    if (!updateVersioned('tasks', t.id, t.version, {
      status: 'done', completed_at: occurred, completed_by: user.id, completed_late: late, completion_activity_id: activityId, updated_at: stamp,
    })) throw conflict('Someone else changed this task. Review the latest version before saving.', { code: 'version_conflict' });
    let nextId = null;
    if (next) {
      nextId = createTask({
        customer_id: t.customer_id, enquiry_id: t.enquiry_id, order_id: t.order_id, line_id: t.line_id,
        reactivation_case_id: t.reactivation_case_id, complaint_id: t.complaint_id, invoice_id: t.invoice_id,
        purpose: next.purpose, owner_id: next.owner_id, due_date: next.due_date, due_time: next.due_time,
        kind: next.kind || t.kind, customer_promise: next.customer_promise, source: 'completion_next', note: next.note,
      }, user, { validated: true });
      if (t.enquiry_id) run('UPDATE enquiries SET no_followup_reason = NULL WHERE id = ?', t.enquiry_id);
      if (t.reactivation_case_id) run('UPDATE reactivation_cases SET task_id = ? WHERE id = ?', nextId, t.reactivation_case_id);
    } else if (t.enquiry_id && str(input.no_followup_reason)) {
      run('UPDATE enquiries SET no_followup_reason = ?, updated_at = ? WHERE id = ?', str(input.no_followup_reason, 300), stamp, t.enquiry_id);
      history('enquiry', t.enquiry_id, 'no_followup', { customerId: t.customer_id, note: str(input.no_followup_reason, 300) });
    }
    audit('task', t.id, 'complete', { activity_id: activityId, late: Boolean(late), next_task_id: nextId });
    return { task_id: t.id, activity_id: activityId, next_task_id: nextId, completed_late: Boolean(late) };
  });
}

/** Moves the due date with a reason. The original schedule and every change stay reportable. */
export function rescheduleTask(taskId, input, user) {
  const t = loadOpenTask(taskId, input.version);
  const c = new Check();
  c.date('due_date', input.due_date, { required: true });
  c.time('due_time', input.due_time);
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  if (input.due_date === t.due_date && (str(input.due_time) || null) === t.due_time) throw badRequest('The new due date is the same as the current one', { due_date: 'Choose a different date' });
  return tx(() => {
    const dueTime = str(input.due_time) || null;
    const wasOverdue = dueState(t, now(), tz()) === 'overdue' ? 1 : 0;
    const stamp = nowIso();
    if (!updateVersioned('tasks', t.id, t.version, {
      due_date: input.due_date, due_time: dueTime, overdue_at: overdueAt(input.due_date, dueTime, tz()), reschedule_count: t.reschedule_count + 1, updated_at: stamp,
    })) throw conflict('Someone else changed this task. Review the latest version before saving.', { code: 'version_conflict' });
    insert('task_changes', {
      task_id: t.id, field: 'due', old_value: `${t.due_date}${t.due_time ? ` ${t.due_time}` : ''}`, new_value: `${input.due_date}${dueTime ? ` ${dueTime}` : ''}`,
      reason: str(input.reason, 300), was_overdue: wasOverdue, actor_id: user.id, created_at: stamp,
    });
    audit('task', t.id, 'reschedule', { from: t.due_date, to: input.due_date, reason: input.reason, was_overdue: Boolean(wasOverdue) });
    return { task_id: t.id };
  });
}

/** Reassignment keeps the previous owner in history and never resets a missed due date. */
export function reassignTask(taskId, input, user) {
  const t = loadOpenTask(taskId, input.version);
  const c = new Check();
  const owner = requireActiveUser(c, 'owner_id', intId(input.owner_id), 'New owner');
  c.text('reason', input.reason, { max: 300 });
  c.throwIfAny();
  if (owner.id === t.owner_id) return { task_id: t.id, unchanged: true };
  return tx(() => {
    const stamp = nowIso();
    if (!updateVersioned('tasks', t.id, t.version, { owner_id: owner.id, updated_at: stamp })) throw conflict('Someone else changed this task.', { code: 'version_conflict' });
    insert('task_changes', { task_id: t.id, field: 'owner', old_value: String(t.owner_id), new_value: String(owner.id), reason: str(input.reason, 300), actor_id: user.id, created_at: stamp });
    audit('task', t.id, 'reassign', { from: t.owner_id, to: owner.id });
    return { task_id: t.id };
  });
}

/** Cancellation needs a reason, stays visible and never counts as a completed customer contact. */
export function cancelTask(taskId, input, user, { system = false } = {}) {
  const t = loadOpenTask(taskId, system ? undefined : input.version);
  const c = new Check();
  c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  const stamp = nowIso();
  run("UPDATE tasks SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?", stamp, user?.id ?? null, str(input.reason, 300), stamp, t.id);
  insert('task_changes', { task_id: t.id, field: 'status', old_value: 'open', new_value: 'cancelled', reason: str(input.reason, 300), actor_id: user?.id ?? null, created_at: stamp });
  audit('task', t.id, 'cancel', { reason: input.reason });
  return { task_id: t.id };
}

/** Cancels the open tasks of a record that has been closed (e.g. an enquiry marked lost). */
export function cancelOpenTasksFor(column, id, reason, user, { exceptPurposeCodes = [] } = {}) {
  const rows = all(`SELECT id, purpose_code FROM tasks WHERE ${column} = ? AND status = 'open'`, id);
  for (const r of rows) if (!exceptPurposeCodes.includes(r.purpose_code)) cancelTask(r.id, { reason }, user, { system: true });
  return rows.length;
}

// ------------------------------------------------------------------ listing
export const TASK_COLUMNS = `
  t.*, u.name AS owner_name, u.department AS owner_department, u.active AS owner_active,
  c.company_name AS customer_name, c.code AS customer_code, c.do_not_contact,
  e.code AS enquiry_code, e.stage AS enquiry_stage, o.code AS order_code,
  (SELECT COALESCE(p.code, el.requirement) FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = t.enquiry_id ORDER BY el.sort, el.id LIMIT 1) AS enquiry_product,
  (SELECT COALESCE(p.code, ol.description) FROM order_lines ol LEFT JOIN products p ON p.id = ol.product_id WHERE ol.id = COALESCE(t.line_id, (SELECT MIN(id) FROM order_lines WHERE order_id = t.order_id))) AS order_product,
  (SELECT a.outcome FROM activities a WHERE a.customer_id = t.customer_id AND a.customer_contact = 1 ORDER BY a.occurred_at DESC LIMIT 1) AS last_outcome,
  (SELECT a.occurred_at FROM activities a WHERE a.customer_id = t.customer_id AND a.customer_contact = 1 ORDER BY a.occurred_at DESC LIMIT 1) AS last_outcome_at`;

export function decorateTask(t, nowAt = now()) {
  return {
    ...t,
    due_state: dueState(t, nowAt, tz()),
    product: t.enquiry_product || t.order_product || null,
    last_outcome_label: t.last_outcome ? optionLabel('contact_outcome', t.last_outcome) || optionLabel('customer_update_outcome', t.last_outcome) : null,
  };
}

export function listTasks(query, user) {
  const nowAt = now();
  const nowIsoStr = nowAt.toISOString();
  const day = today();
  const where = ["t.status = 'open'"];
  const params = [];
  const scope = taskScope(user, 't');
  if (scope) where.push(scope);
  if (query.owner === 'me') {
    where.push('t.owner_id = ?');
    params.push(user.id);
  } else if (intId(query.owner)) {
    where.push('t.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (query.kind) {
    where.push('t.kind = ?');
    params.push(query.kind);
  }
  if (bool(query.promise)) where.push('t.customer_promise = 1');
  for (const col of ['customer_id', 'enquiry_id', 'order_id']) {
    if (intId(query[col])) {
      where.push(`t.${col} = ?`);
      params.push(intId(query[col]));
    }
  }
  if (query.q) {
    where.push('(c.company_name LIKE ? OR t.purpose LIKE ? OR e.code LIKE ? OR o.code LIKE ?)');
    const like = `%${String(query.q).trim()}%`;
    params.push(like, like, like, like);
  }
  const base = `FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id WHERE ${where.join(' AND ')}`;
  const counts = get(
    `SELECT SUM(CASE WHEN t.overdue_at <= ? THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN t.overdue_at > ? AND t.due_date = ? THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN t.due_date > ? THEN 1 ELSE 0 END) AS upcoming ${base}`,
    nowIsoStr, nowIsoStr, day, day, ...params,
  );
  const bucket = query.bucket || 'overdue';
  const bucketSql = { overdue: 't.overdue_at <= ?', today: 't.overdue_at > ? AND t.due_date = ?', upcoming: 't.due_date > ?', open: '1 = 1' }[bucket] || '1 = 1';
  const bucketParams = { overdue: [nowIsoStr], today: [nowIsoStr, day], upcoming: [day], open: [] }[bucket] || [];
  const limit = Math.min(Number(query.limit) || 300, 1000);
  const rows = all(`SELECT ${TASK_COLUMNS} ${base} AND ${bucketSql} ORDER BY t.overdue_at, t.id LIMIT ${limit}`, ...params, ...bucketParams);
  return {
    counts: { overdue: counts.overdue || 0, today: counts.today || 0, upcoming: counts.upcoming || 0 },
    rows: rows.map((r) => decorateTask(r, nowAt)),
    now: nowIsoStr,
    today: day,
  };
}

export function taskDetail(id) {
  const t = get(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id WHERE t.id = ?`, id);
  if (!t) throw notFound('Task');
  const changes = all(`SELECT tc.*, u.name AS actor_name FROM task_changes tc LEFT JOIN users u ON u.id = tc.actor_id WHERE tc.task_id = ? ORDER BY tc.id`, id);
  return { ...decorateTask(t), changes };
}

/** Open tasks for a set of ids, for embedding in record pages. */
export function tasksWhere(column, id, { includeClosed = true } = {}) {
  const rows = all(
    `SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
     LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.${column} = ? ${includeClosed ? '' : "AND t.status = 'open'"} ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.overdue_at DESC LIMIT 200`,
    id,
  );
  const nowAt = now();
  return rows.map((r) => decorateTask(r, nowAt));
}

export const ACTIVITY_COLUMNS = `a.*, u.name AS entered_by_name, ct.name AS contact_name, e.code AS enquiry_code, o.code AS order_code`;
export function activitiesWhere(column, id, limit = 200) {
  return all(
    `SELECT ${ACTIVITY_COLUMNS} FROM activities a LEFT JOIN users u ON u.id = a.entered_by LEFT JOIN contacts ct ON ct.id = a.contact_id
     LEFT JOIN enquiries e ON e.id = a.enquiry_id LEFT JOIN orders o ON o.id = a.order_id
     WHERE a.${column} = ? ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${Number(limit)}`,
    id,
  ).map(decorateActivity);
}

export function decorateActivity(a) {
  const backdated = a.occurred_at && a.entered_at && Date.parse(a.entered_at) - Date.parse(a.occurred_at) > 6 * 3600000;
  const label = a.kind === 'quotation' ? 'Quotation sent'
    : a.kind === 'internal' ? 'Internal note'
      : optionLabel('contact_outcome', a.outcome) ?? optionLabel('customer_update_outcome', a.outcome);
  return { ...a, backdated: Boolean(backdated), outcome_label: label, channel_label: optionLabel('channel', a.channel), local_date: a.occurred_at ? localDate(new Date(a.occurred_at), tz()) : null };
}

export function taskCountsForIds(ids) {
  if (!ids.length) return {};
  const rows = all(`SELECT customer_id, COUNT(*) AS n FROM tasks WHERE status = 'open' AND customer_id IN (${placeholders(ids)}) GROUP BY customer_id`, ids);
  return Object.fromEntries(rows.map((r) => [r.customer_id, r.n]));
}
