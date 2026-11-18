// The sales pipeline: every live deal at its one current step of the journey
// enquiry → quotation → confirmation → payment → production → dispatch, with the reasons it is stuck there.
// Nothing is stored here: each deal is worked out from the enquiry, quotation, order, payment and production
// records, so the pipeline can never disagree with them.
import { all, get } from '../db.js';
import {
  now, today, tz, calendar, settings, optionLabel, intId, placeholders, notFound,
} from '../util.js';
import {
  JOURNEY_STAGES, ENQUIRY_STAGES, OPEN_ENQUIRY_STAGES, QUOTE_TRACKING, quoteTracking, labelOf,
} from '../../shared/constants.js';
import { daysBetween, localDate, workingDaysBetween } from '../../shared/dates.js';
import { enquiryScope, quotationScope } from '../access.js';
import { hasPerm } from '../auth.js';
import { loadOrdersWithLines, orderListRow } from './orders.js';
import { paymentStatusByOrder } from './finance.js';

const OPEN = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
const STAGE_INDEX = Object.fromEntries(JOURNEY_STAGES.map((s, i) => [s.value, i]));
const SEVERITY_RANK = { red: 0, amber: 1 };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const why = (code, severity, text) => ({ code, severity, text });

function context() {
  return { day: today(), nowIso: now().toISOString(), cal: calendar(), rules: settings().rules, zone: tz() };
}
const dayOf = (v, C) => (!v ? null : v.length === 10 ? v : localDate(new Date(v), C.zone));
const age = (v, C) => (v ? Math.max(0, daysBetween(dayOf(v, C), C.day)) : 0);
const workAge = (v, C) => (v ? workingDaysBetween(dayOf(v, C), C.day, C.cal) : 0);

// ------------------------------------------------------------------ loading
const ENQUIRY_SQL = `SELECT e.id, e.code, e.title, e.stage, e.customer_id, e.owner_id, e.received_at, e.first_response_at, e.source_code, e.source_event, e.campaign_id,
    e.hold_reason, e.hold_review_date, e.no_followup_reason, e.est_value_minor, e.est_currency, e.created_at,
    c.company_name AS customer_name, u.name AS owner_name, cp.name AS campaign_name, cp.type AS campaign_type,
    (SELECT COALESCE(p.code, el.requirement, 'Unspecified') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort LIMIT 1) AS product,
    (SELECT COUNT(*) FROM enquiry_lines el WHERE el.enquiry_id = e.id) AS line_count
  FROM enquiries e JOIN customers c ON c.id = e.customer_id LEFT JOIN users u ON u.id = e.owner_id LEFT JOIN campaigns cp ON cp.id = e.campaign_id`;

const QUOTE_SQL = `SELECT q.id, q.number, q.subject, q.enquiry_id, q.customer_id, q.owner_id, c.company_name AS customer_name, u.name AS owner_name,
    r.id AS revision_id, r.revision_no, r.status, r.approval_status, r.sent_at, r.validity_date, r.decided_at, r.created_at AS revision_created_at, r.total_minor, r.currency,
    (SELECT COUNT(*) FROM orders o JOIN quote_revisions rr ON rr.id = o.quote_revision_id WHERE rr.quotation_id = q.id AND o.archived_at IS NULL) AS orders
  FROM quotations q JOIN quote_revisions r ON r.quotation_id = q.id AND r.revision_no = (SELECT MAX(r2.revision_no) FROM quote_revisions r2 WHERE r2.quotation_id = q.id)
  JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id`;

/** The first open follow-up of each record, keyed by enquiry or order id. */
function nextTasks(column, ids) {
  if (!ids.length) return new Map();
  return new Map(all(`SELECT DISTINCT ON (t.${column}) t.${column} AS ref, t.id, t.purpose, t.due_date, t.overdue_at, u.name AS owner_name
    FROM tasks t LEFT JOIN users u ON u.id = t.owner_id WHERE t.status = 'open' AND t.${column} IN (${placeholders(ids)}) ORDER BY t.${column}, t.overdue_at`, ids).map((t) => [t.ref, t]));
}
const nextAction = (t) => (t ? { id: t.id, purpose: t.purpose, due_date: t.due_date, owner_name: t.owner_name } : null);

function followUpReasons(task, enquiry, C, out) {
  if (task) {
    if (task.overdue_at && task.overdue_at <= C.nowIso) out.push(why('followup_overdue', 'red', `Follow-up overdue by ${plural(Math.max(1, age(task.due_date, C)), 'day')}: ${task.purpose}${task.owner_name ? ` (${task.owner_name})` : ''}`));
  } else if (enquiry && !enquiry.no_followup_reason) {
    out.push(why('no_next_action', 'amber', 'No next follow-up planned'));
  }
}

// ------------------------------------------------------------------ the journey steps
function stepDetail(key, d, state) {
  const { enquiry: e, quotation: q, order: o, payment: p } = d;
  switch (key) {
    case 'enquiry': return e ? { detail: `${e.code} · ${e.replied ? 'replied' : 'not replied'}`, link: `/enquiries/${e.id}` } : { detail: 'Direct order' };
    case 'quotation': return q ? { detail: `${q.number} · ${q.tracking_label}`, link: `/quotations/${q.id}` } : { detail: state === 'done' ? 'No quotation' : 'Not created yet' };
    case 'confirmation': return o ? { detail: `${o.code} · ${o.status === 'draft' ? 'draft' : 'confirmed'}`, link: `/orders/${o.id}` } : { detail: state === 'current' ? 'Order not created' : '' };
    case 'payment': return { detail: p ? p.label : '' };
    case 'production': return { detail: o && o.status !== 'draft' ? `${o.progress_pct}% ready` : '' };
    case 'dispatch': return { detail: o && o.status !== 'draft' ? `${o.dispatched_pct}% dispatched` : '' };
    default: return {};
  }
}

function finish(deal) {
  const current = STAGE_INDEX[deal.stage];
  const steps = JOURNEY_STAGES.map((s, i) => {
    let state = 'todo';
    if (deal.status === 'completed' || i < current) state = 'done';
    else if (i === current) state = deal.status === 'active' ? 'current' : 'closed';
    return { key: s.value, label: s.label, state, ...stepDetail(s.value, deal, state) };
  });
  const seen = new Set();
  const reasons = deal.reasons.filter((r) => !seen.has(r.text) && seen.add(r.text)).sort((a, b) => (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2));
  const severity = reasons.find((r) => SEVERITY_RANK[r.severity] !== undefined)?.severity ?? null;
  return { ...deal, stage_label: labelOf(JOURNEY_STAGES, deal.stage), reasons, severity, stuck: deal.status === 'active' && Boolean(severity), steps };
}

function enquiryBrief(e) {
  return e ? {
    id: e.id, code: e.code, stage: e.stage, stage_label: labelOf(ENQUIRY_STAGES, e.stage), received_at: e.received_at, first_response_at: e.first_response_at, replied: Boolean(e.first_response_at),
  } : null;
}
function quoteBrief(q) {
  if (!q) return null;
  const tracking = quoteTracking(q.status);
  return { id: q.id, number: q.number, revision_no: q.revision_no, status: q.status, approval_status: q.approval_status, tracking, tracking_label: labelOf(QUOTE_TRACKING, tracking), sent_at: q.sent_at, validity_date: q.validity_date };
}
const sourceOf = (e) => (e ? {
  source_label: optionLabel('enquiry_source', e.source_code), exhibition: e.campaign_id && e.campaign_type === 'exhibition' ? { id: e.campaign_id, name: e.campaign_name } : null, campaign_id: e.campaign_id ?? null,
} : { source_label: null, exhibition: null, campaign_id: null });

// ------------------------------------------------------------------ deals still before an order
function enquiryDeal(e, q, task, C) {
  const tracking = q ? quoteTracking(q.status) : null;
  const status = e?.stage === 'lost' ? 'lost' : e?.stage === 'cancelled' ? 'cancelled' : 'active';
  const stage = tracking === 'approved' ? 'confirmation' : tracking ? 'quotation' : 'enquiry';
  const R = C.rules;
  const reasons = [];
  let since = e?.received_at || e?.created_at;
  if (stage === 'enquiry' && e && status === 'active') {
    if (!e.first_response_at && e.received_at) {
      const n = workAge(e.received_at, C);
      if (n >= R.enquiryResponseWorkingDays) reasons.push(why('not_replied', 'red', `Not replied for ${plural(n, 'working day')}`));
    }
    if (e.stage === 'clarification') reasons.push(why('clarification', 'amber', 'Waiting for clarification from the customer'));
    if (e.stage === 'on_hold') reasons.push(why('on_hold', 'amber', `On hold${e.hold_reason ? `: ${e.hold_reason}` : ''}${e.hold_review_date ? ` (review ${e.hold_review_date})` : ''}`));
    if (e.stage === 'quote_to_prepare' && workAge(e.received_at, C) >= R.pipelineQuoteDraftWorkingDays) reasons.push(why('quote_not_prepared', 'amber', `Quotation not prepared for ${plural(workAge(e.received_at, C), 'working day')}`));
  }
  if (stage === 'quotation' && status === 'active') {
    since = q.sent_at || q.revision_created_at;
    if (tracking === 'pending') {
      const n = workAge(q.revision_created_at, C);
      if (q.approval_status === 'rejected') reasons.push(why('approval_rejected', 'red', 'Internal approval rejected — revise the quotation'));
      else if (['pending', 'required'].includes(q.approval_status)) reasons.push(why('awaiting_approval', n >= R.pipelineQuoteDraftWorkingDays ? 'red' : 'amber', `Waiting for internal approval for ${plural(n, 'working day')}`));
      else if (n >= R.pipelineQuoteDraftWorkingDays) reasons.push(why('not_sent', 'amber', `Prepared but not sent for ${plural(n, 'working day')}`));
    } else if (tracking === 'sent') {
      const n = workAge(q.sent_at, C);
      if (q.validity_date && q.validity_date < C.day) reasons.push(why('expired', 'red', `Quotation expired on ${q.validity_date} with no decision`));
      else if (n >= R.pipelineQuoteDecisionWorkingDays) reasons.push(why('no_decision', 'amber', `No customer decision for ${plural(n, 'working day')}`));
    } else if (tracking === 'rejected') {
      reasons.push(why('rejected', 'red', 'Customer rejected the quotation — revise it or close the enquiry'));
    }
  }
  if (stage === 'confirmation' && status === 'active') {
    since = q.decided_at || q.sent_at;
    const n = workAge(since, C);
    if (n >= R.pipelineConfirmationWorkingDays) reasons.push(why('order_not_created', n >= R.pipelineConfirmationWorkingDays * 2 ? 'red' : 'amber', `Customer approved ${plural(n, 'working day')} ago — order not created`));
  }
  if (status === 'active' && stage !== 'confirmation') followUpReasons(task, e, C, reasons);
  return finish({
    key: e ? `enquiry:${e.id}` : `quotation:${q.id}`, stage, status,
    code: q && stage !== 'enquiry' ? q.number : e?.code, customer_id: e?.customer_id ?? q.customer_id, customer_name: e?.customer_name ?? q.customer_name,
    title: e ? `${e.title ? `${e.title} · ` : ''}${e.product || 'Requirement to clarify'}${e.line_count > 1 ? ` +${e.line_count - 1}` : ''}` : q.subject || q.number,
    owner_id: e?.owner_id ?? q.owner_id, owner_name: e?.owner_name ?? q.owner_name,
    enquiry: enquiryBrief(e), quotation: quoteBrief(q), order: null, payment: null,
    value_minor: q?.total_minor ?? e?.est_value_minor ?? null, currency: q?.currency ?? e?.est_currency ?? null,
    ...sourceOf(e), days_in_stage: age(since, C), reasons, next_action: nextAction(task),
    link: stage === 'enquiry' || !q ? `/enquiries/${e.id}` : `/quotations/${q.id}`,
  });
}

function loadEnquiryDeals(busyEnquiries, C, user) {
  const scope = enquiryScope(user, 'e');
  const enquiries = all(`${ENQUIRY_SQL} WHERE (e.stage IN (${OPEN}) OR (e.stage = 'won' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.enquiry_id = e.id AND o.archived_at IS NULL))) ${scope ? `AND ${scope}` : ''}`)
    .filter((e) => !busyEnquiries.has(e.id));
  const ids = enquiries.map((e) => e.id);
  const quotes = new Map(ids.length ? all(`${QUOTE_SQL} WHERE q.enquiry_id IN (${placeholders(ids)}) ORDER BY q.id`, ids).map((q) => [q.enquiry_id, q]) : []);
  const tasks = nextTasks('enquiry_id', ids);
  const recentlyApproved = addDaysAgo(C, 90);
  const deals = [];
  for (const e of enquiries) {
    const q = quotes.get(e.id) || null;
    const approved = q && quoteTracking(q.status) === 'approved';
    if (approved && q.orders > 0) continue; // its order has already been delivered; nothing is waiting
    if (e.stage === 'won' && !(approved && dayOf(q.decided_at || q.sent_at, C) >= recentlyApproved)) continue;
    deals.push(enquiryDeal(e, q, tasks.get(e.id), C));
  }
  const qScope = quotationScope(user, 'q');
  for (const q of all(`${QUOTE_SQL} WHERE q.enquiry_id IS NULL AND r.status IN ('draft','issued','accepted') ${qScope ? `AND ${qScope}` : ''}`)) {
    if (!q.orders) deals.push(enquiryDeal(null, q, null, C));
  }
  return deals;
}
function addDaysAgo(C, n) {
  return localDate(new Date(Date.parse(`${C.day}T12:00:00Z`) - n * 86400000), 'UTC');
}

// ------------------------------------------------------------------ deals with an order
function orderStage(r, pay) {
  if (r.status === 'draft') return 'confirmation';
  const open = r.lines.filter((l) => l.quantities.remaining > 0);
  if (!open.length) return 'dispatch';
  const started = r.lines.some((l) => l.quantities.dispatched > 0 || l.phase !== 'received' || l.work_status !== 'not_started');
  if (!started && ['advance_pending', 'on_hold'].includes(pay?.code)) return 'payment';
  return open.some((l) => l.phase !== 'ready') ? 'production' : 'dispatch';
}

function lineReasons(r, stage) {
  const out = [];
  for (const l of r.lines.filter((x) => x.quantities.remaining > 0)) {
    const issue = l.issue_label ? ` — ${l.issue_label}${l.stage_note ? `: ${l.stage_note}` : ''}` : '';
    if (l.state === 'overdue') out.push(why('overdue', 'red', `${l.product}: ${plural(l.days_late || 0, 'day')} past the promised date${issue}`));
    else if (l.state === 'at_risk') out.push(why('at_risk', 'amber', `${l.product}: forecast is later than promised${issue}`));
    else if (l.issue_code) out.push(why('issue', 'amber', `${l.product}${issue}`));
    if (l.work_status === 'on_hold') out.push(why('work_on_hold', 'amber', `${l.product}: work is on hold`));
    if (l.needs_clarification) out.push(why('clarification', 'amber', `${l.product}: specification to be clarified`));
    if (l.estimate_unknown && stage === 'production') out.push(why('no_forecast', 'amber', `${l.product}: no forecast date`));
    if (l.stale && stage === 'production') {
      // A short gap is worth a note; only a long silence counts as stuck.
      const n = l.freshness?.working_days;
      out.push(why('stale', n && n >= (l.freshness?.threshold || 2) * 2 ? 'amber' : 'info', `${l.product}: no production update${n ? ` for ${plural(n, 'working day')}` : ' yet'}`));
    }
    if (l.ready_waiting) out.push(why('ready_waiting', 'amber', `${l.product}: ready but not dispatched`));
  }
  return out;
}

function orderDeal(r, pay, e, q, task, C) {
  const completed = r.status === 'confirmed' && !r.active;
  const stage = orderStage(r, pay);
  const reasons = [];
  let since = r.confirmed_at || r.received_date;
  if (!completed) {
    if (stage === 'confirmation') {
      since = r.received_date;
      const n = workAge(since, C);
      if (n >= C.rules.pipelineConfirmationWorkingDays) reasons.push(why('draft_order', 'amber', `Order draft not confirmed for ${plural(n, 'working day')}`));
    } else {
      reasons.push(...lineReasons(r, stage));
      if (r.comm_pending) reasons.push(why('customer_not_informed', 'amber', 'Customer not told about the revised date'));
      if (r.no_action) reasons.push(why('no_action_owner', 'amber', `${plural(r.no_action, 'delayed line')} without a named action owner`));
    }
    if (pay?.code === 'on_hold') reasons.push(why('payment_hold', 'red', `Payment hold${pay.hold_reason ? `: ${pay.hold_reason}` : ''}`));
    if (pay?.code === 'advance_pending' && stage !== 'confirmation') {
      const n = workAge(r.confirmed_at || r.received_date, C);
      if (stage === 'payment') {
        if (n >= C.rules.pipelineAdvanceWorkingDays) reasons.push(why('advance_pending', n >= C.rules.pipelineAdvanceWorkingDays * 2 ? 'red' : 'amber', `Advance not received for ${plural(n, 'working day')}`));
      } else reasons.push(why('advance_pending', 'amber', 'Advance still not received, though work has started'));
    }
    if (pay?.code === 'overdue') reasons.push(why('payment_overdue', 'amber', 'Invoice payment is overdue'));
    if (stage === 'dispatch') since = r.last_update_at || since;
  }
  return finish({
    key: `order:${r.id}`, stage, status: completed ? 'completed' : 'active', code: r.code, customer_id: r.customer_id, customer_name: r.customer_name,
    title: `${r.lines[0]?.product || 'Order'}${r.lines.length > 1 ? ` +${r.lines.length - 1}` : ''}`, owner_id: r.owner_id, owner_name: r.owner_name,
    enquiry: enquiryBrief(e), quotation: quoteBrief(q),
    order: {
      id: r.id, code: r.code, status: r.status, phase: r.phase, po_reference: r.po_reference, earliest_due: r.earliest_due, delayed: r.delayed, progress_pct: r.progress.ready_pct, dispatched_pct: r.progress.dispatched_pct,
    },
    payment: pay ? { code: pay.code, label: pay.label, tone: pay.tone } : null,
    value_minor: Object.values(r.remaining_value_by_currency || {})[0] ?? null, currency: r.currency,
    ...sourceOf(e), days_in_stage: age(since, C), reasons, next_action: nextAction(task), link: `/orders/${r.id}`,
  });
}

function orderDeals(rows, C) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const pay = paymentStatusByOrder(ids);
  const tasks = nextTasks('order_id', ids);
  const enquiryIds = [...new Set(rows.map((r) => r.enquiry_id).filter(Boolean))];
  const enquiries = new Map(enquiryIds.length ? all(`${ENQUIRY_SQL} WHERE e.id IN (${placeholders(enquiryIds)})`, enquiryIds).map((e) => [e.id, e]) : []);
  const revisionIds = [...new Set(rows.map((r) => r.quote_revision_id).filter(Boolean))];
  const quotes = new Map(revisionIds.length ? all(`SELECT q.id, q.number, r.id AS revision_id, r.revision_no, r.status, r.approval_status, r.sent_at, r.validity_date FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE r.id IN (${placeholders(revisionIds)})`, revisionIds).map((q) => [q.revision_id, q]) : []);
  return rows.map((r) => orderDeal(r, pay.get(r.id), enquiries.get(r.enquiry_id) || null, quotes.get(r.quote_revision_id) || null, tasks.get(r.id), C));
}

const orderRows = (where, params, user) => loadOrdersWithLines(where, params, user).map(({ order, lines }) => orderListRow(order, lines));

// ------------------------------------------------------------------ public API
/** All live deals, with a count per stage. Each user sees only the enquiries and orders in their scope. */
export function salesPipeline(query, user) {
  const C = context();
  const rows = hasPerm(user, 'orders.view') ? orderRows(['o.closed_at IS NULL', "o.status IN ('draft','confirmed')"], [], user).filter((r) => r.status === 'draft' || r.active) : [];
  const busy = new Set(rows.map((r) => r.enquiry_id).filter(Boolean));
  let deals = [...orderDeals(rows, C), ...(hasPerm(user, 'enquiries.view') ? loadEnquiryDeals(busy, C, user) : [])];
  const owner = intId(query.owner);
  const customer = intId(query.customer_id);
  const campaign = intId(query.campaign_id);
  const text = String(query.q || '').trim().toLowerCase();
  deals = deals.filter((d) => (!owner || d.owner_id === owner) && (!customer || d.customer_id === customer) && (!campaign || d.campaign_id === campaign)
    && (!text || [d.customer_name, d.code, d.title, d.enquiry?.code, d.quotation?.number, d.order?.code, d.order?.po_reference].some((v) => String(v || '').toLowerCase().includes(text))));
  const stages = JOURNEY_STAGES.map((s) => {
    const here = deals.filter((d) => d.stage === s.value);
    return { value: s.value, label: s.label, count: here.length, stuck: here.filter((d) => d.stuck).length };
  });
  const shown = deals.filter((d) => (!query.stage || d.stage === query.stage) && (!(query.stuck === '1' || query.stuck === 'true') || d.stuck));
  shown.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2) || b.days_in_stage - a.days_in_stage);
  return { today: C.day, stages, total: deals.length, stuck: deals.filter((d) => d.stuck).length, count: shown.length, items: shown };
}

/** The journey of one enquiry, quotation or order, including finished and lost ones. Null when out of scope. */
export function journeyFor(query, user) {
  const C = context();
  let orderId = intId(query.order_id);
  let enquiryId = intId(query.enquiry_id);
  const quotationId = intId(query.quotation_id);
  let quotation = null;
  if (quotationId) {
    quotation = get(`${QUOTE_SQL} WHERE q.id = ?`, quotationId);
    if (!quotation) throw notFound('Quotation');
    enquiryId = enquiryId || quotation.enquiry_id;
    orderId = orderId || get(`SELECT o.id FROM orders o JOIN quote_revisions r ON r.id = o.quote_revision_id WHERE r.quotation_id = ? AND o.archived_at IS NULL ORDER BY o.closed_at IS NULL DESC, o.id DESC LIMIT 1`, quotationId)?.id;
  }
  if (enquiryId && !orderId) orderId = get('SELECT id FROM orders WHERE enquiry_id = ? AND archived_at IS NULL ORDER BY closed_at IS NULL DESC, id DESC LIMIT 1', enquiryId)?.id;
  if (orderId && hasPerm(user, 'orders.view')) {
    const rows = orderRows(['o.id = ?'], [orderId], user);
    if (rows.length) return orderDeals(rows, C)[0];
  }
  if (enquiryId && hasPerm(user, 'enquiries.view')) {
    const scope = enquiryScope(user, 'e');
    const e = get(`${ENQUIRY_SQL} WHERE e.id = ? ${scope ? `AND ${scope}` : ''}`, enquiryId);
    if (e) {
      const q = quotation || all(`${QUOTE_SQL} WHERE q.enquiry_id = ? ORDER BY q.id DESC LIMIT 1`, enquiryId)[0] || null;
      return enquiryDeal(e, q, nextTasks('enquiry_id', [e.id]).get(e.id), C);
    }
  }
  if (quotation && !quotation.enquiry_id && hasPerm(user, 'quotes.view')) return enquiryDeal(null, quotation, null, C);
  return null;
}
