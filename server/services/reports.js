// Reports with explicit definitions. Each report first collects its records, then derives every summary
// number from those same records — so drill-downs, list views and exports always reconcile.
import { all, get } from '../db.js';
import { now, today, tz, intId, optionLabel, placeholders, settings, calendar, outstandingSql } from '../util.js';
import { addDays, isDate, zonedToUtc, localDate, daysBetween, workingDaysBetween } from '../../shared/dates.js';
import { OPEN_ENQUIRY_STAGES, labelOf, COMPLAINT_STATUSES } from '../../shared/constants.js';
import { lineQty, lineStatus, isPositive, formatMoney } from '../../shared/rules.js';
import { enquiryScope, orderScope, taskScope, customerScope, quotationScope } from '../access.js';
import { loadOrdersWithLines, orderListRow } from './orders.js';

const median = (arr) => {
  const v = arr.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

export function parseFilters(q) {
  const to = isDate(q.to) ? q.to : today();
  const from = isDate(q.from) ? q.from : addDays(to, -89);
  return {
    from, to, owner: intId(q.owner), country: q.country || null, segment: q.segment || null, family: q.family || null, source: q.source || null,
    group: q.group || null, basis: q.basis || null, kind: q.kind || null,
    fromUtc: zonedToUtc(from, '00:00', tz()), toUtc: zonedToUtc(addDays(to, 1), '00:00', tz()),
  };
}

function enquiryWhere(f, user, alias = 'e') {
  const w = [];
  const p = [];
  const scope = enquiryScope(user, alias);
  if (scope) w.push(scope);
  if (f.owner) w.push(`${alias}.owner_id = ${f.owner}`);
  if (f.country) {
    w.push('c.country_code = ?');
    p.push(f.country);
  }
  if (f.segment) {
    w.push('c.segment = ?');
    p.push(f.segment);
  }
  if (f.source) {
    w.push(`${alias}.source_code = ?`);
    p.push(f.source);
  }
  if (f.family) {
    w.push(`EXISTS (SELECT 1 FROM enquiry_lines el JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = ${alias}.id AND p.family = ?)`);
    p.push(f.family);
  }
  return { w, p };
}

const firstFamily = (alias = 'e') => `(SELECT p.family FROM enquiry_lines el JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = ${alias}.id ORDER BY el.sort LIMIT 1)`;

function groupRows(records, keyFn, metricsFn) {
  const groups = new Map();
  for (const r of records) {
    const k = keyFn(r) ?? 'Unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, ...metricsFn(rows) })).sort((a, b) => (b.total ?? b.count ?? 0) - (a.total ?? a.count ?? 0));
}

function valueText(byCurrency) {
  const parts = Object.entries(byCurrency).filter(([, v]) => v).map(([c, v]) => formatMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
}

// ------------------------------------------------------------------ definitions
const REPORTS = {
  enquiry_conversion: {
    title: 'Enquiry conversion',
    definition: 'Won enquiries divided by all enquiries received in the selected period (received-date cohort). Open, partly won and cancelled outcomes are shown, not hidden. Decision-period results (won ÷ decided in the period) are a separate measure.',
    groups: ['source', 'owner', 'month', 'country', 'family'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      const rows = all(`SELECT e.id, e.code, e.stage, e.received_at, e.decided_at, e.source_code, c.company_name, c.country_code, u.name AS owner, ${firstFamily()} AS family,
          (SELECT COUNT(*) FROM enquiry_lines el WHERE el.enquiry_id = e.id AND el.outcome = 'partial') AS partial_lines
        FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p);
      return rows.map((r) => ({
        ...r, received_date: localDate(new Date(r.received_at), tz()), source: optionLabel('enquiry_source', r.source_code),
        outcome: r.stage === 'won' ? (r.partial_lines ? 'won_partial' : 'won') : ['lost', 'cancelled'].includes(r.stage) ? r.stage : 'open',
      }));
    },
    metrics: {
      total: { label: 'Enquiries received', test: () => true },
      won: { label: 'Won', test: (r) => r.outcome === 'won' || r.outcome === 'won_partial' },
      won_partial: { label: 'of which partly won', test: (r) => r.outcome === 'won_partial' },
      lost: { label: 'Lost', test: (r) => r.outcome === 'lost' },
      cancelled: { label: 'Cancelled (not a commercial loss)', test: (r) => r.outcome === 'cancelled' },
      open: { label: 'Still open', test: (r) => r.outcome === 'open' },
    },
    summary(records, f, user) {
      const won = records.filter(this.metrics.won.test).length;
      const { w, p } = enquiryWhere(f, user);
      const decided = all(`SELECT e.stage FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.decided_at >= ? AND e.decided_at < ? AND e.stage IN ('won','lost') ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p);
      const dWon = decided.filter((d) => d.stage === 'won').length;
      const unknown = get(`SELECT COUNT(*) AS n FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.received_unknown = 1 ${w.length ? `AND ${w.join(' AND ')}` : ''}`, ...p).n;
      return {
        headline: { label: 'Cohort conversion', value: pct(won, records.length), unit: '%', numerator: won, denominator: records.length },
        extra: [{ label: 'Decision-period win rate (won ÷ won + lost decided in period)', value: pct(dWon, decided.length), unit: '%', numerator: dWon, denominator: decided.length }],
        exclusions: [{ label: 'Historical enquiries with an unknown received date (not in any cohort)', count: unknown }],
      };
    },
    table(records, f) {
      const key = { source: (r) => r.source, owner: (r) => r.owner, month: (r) => r.received_date.slice(0, 7), country: (r) => r.country_code || 'Unknown', family: (r) => r.family || 'Unspecified' }[f.group || 'source'];
      return groupRows(records, key, (rows) => {
        const won = rows.filter((r) => r.outcome.startsWith('won')).length;
        return { total: rows.length, won, lost: rows.filter((r) => r.outcome === 'lost').length, cancelled: rows.filter((r) => r.outcome === 'cancelled').length, open: rows.filter((r) => r.outcome === 'open').length, conversion: pct(won, rows.length) };
      });
    },
    tableColumns: [['group', 'Group'], ['total', 'Received'], ['won', 'Won'], ['lost', 'Lost'], ['cancelled', 'Cancelled'], ['open', 'Open'], ['conversion', 'Conversion %']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['received_date', 'Received (local date)'], ['source', 'Source'], ['owner', 'Owner'], ['outcome', 'Outcome']],
    link: (r) => `/enquiries/${r.id}`,
  },

  first_response: {
    title: 'First response time',
    definition: 'First meaningful human response (a customer contact other than "no answer", or an issued quotation) minus the actual received time. Median and count; enquiries with unknown timestamps or no response yet are excluded and listed.',
    groups: ['owner', 'source'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.received_at, e.first_response_at, e.source_code, c.company_name, u.name AS owner FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p)
        .map((r) => ({ ...r, source: optionLabel('enquiry_source', r.source_code), hours: r.first_response_at ? r1((Date.parse(r.first_response_at) - Date.parse(r.received_at)) / 3600000) : null }));
    },
    metrics: {
      measured: { label: 'Responded (measured)', test: (r) => r.hours !== null && r.hours >= 0 },
      no_response: { label: 'No response recorded yet (excluded)', test: (r) => !r.first_response_at },
      invalid: { label: 'Response before received time (excluded — check data)', test: (r) => r.hours !== null && r.hours < 0 },
    },
    summary(records) {
      const measured = records.filter(this.metrics.measured.test);
      return {
        headline: { label: 'Median first response', value: r1(median(measured.map((r) => r.hours))), unit: 'hours', denominator: measured.length },
        extra: [{ label: 'Within 24 hours', value: pct(measured.filter((r) => r.hours <= 24).length, measured.length), unit: '%', numerator: measured.filter((r) => r.hours <= 24).length, denominator: measured.length }],
        exclusions: [
          { label: 'No response recorded yet', count: records.filter(this.metrics.no_response.test).length, metric: 'no_response' },
          { label: 'Response time earlier than received time', count: records.filter(this.metrics.invalid.test).length, metric: 'invalid' },
        ],
      };
    },
    table(records, f) {
      const key = f.group === 'source' ? (r) => r.source : (r) => r.owner;
      return groupRows(records.filter((r) => r.hours !== null && r.hours >= 0), key, (rows) => ({ count: rows.length, median_hours: r1(median(rows.map((r) => r.hours))) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Measured'], ['median_hours', 'Median hours']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['received_at', 'Received (UTC)'], ['first_response_at', 'First response (UTC)'], ['hours', 'Hours'], ['owner', 'Owner']],
    link: (r) => `/enquiries/${r.id}`,
  },

  quote_turnaround: {
    title: 'Quotation turnaround',
    definition: 'First issued quotation minus the chosen basis: the enquiry received time (default) or the first "quotation requested" contact. Drafts never count. Enquiries with no issued quotation, or no basis time, are excluded and listed.',
    bases: ['received', 'requested'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.received_at, c.company_name, u.name AS owner,
          (SELECT MIN(r.sent_at) FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL) AS first_issued_at,
          (SELECT MIN(a.occurred_at) FROM activities a WHERE a.enquiry_id = e.id AND a.outcome = 'quotation_requested') AS requested_at
        FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p)
        .map((r) => {
          const basisAt = f.basis === 'requested' ? r.requested_at : r.received_at;
          return { ...r, basis_at: basisAt, days: r.first_issued_at && basisAt ? r1((Date.parse(r.first_issued_at) - Date.parse(basisAt)) / 86400000) : null };
        });
    },
    metrics: {
      measured: { label: 'Quoted (measured)', test: (r) => r.days !== null && r.days >= 0 },
      not_quoted: { label: 'No quotation issued (excluded)', test: (r) => !r.first_issued_at },
      no_basis: { label: 'No basis time (excluded)', test: (r) => r.first_issued_at && !r.basis_at },
    },
    summary(records, f) {
      const m = records.filter(this.metrics.measured.test);
      return {
        headline: { label: `Median turnaround from ${f.basis === 'requested' ? 'quotation request' : 'enquiry received'}`, value: r1(median(m.map((r) => r.days))), unit: 'days', denominator: m.length },
        extra: [],
        exclusions: [
          { label: 'No quotation issued yet', count: records.filter(this.metrics.not_quoted.test).length, metric: 'not_quoted' },
          { label: 'No basis time recorded', count: records.filter(this.metrics.no_basis.test).length, metric: 'no_basis' },
        ],
      };
    },
    table(records) {
      return groupRows(records.filter((r) => r.days !== null && r.days >= 0), (r) => r.owner, (rows) => ({ count: rows.length, median_days: r1(median(rows.map((r) => r.days))) }));
    },
    tableColumns: [['group', 'Owner'], ['count', 'Quoted'], ['median_days', 'Median days']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['basis_at', 'Basis time (UTC)'], ['first_issued_at', 'First issued (UTC)'], ['days', 'Days'], ['owner', 'Owner']],
    link: (r) => `/enquiries/${r.id}`,
  },

  lost_reasons: {
    title: 'Lost reasons',
    definition: 'Opportunities closed as lost in the period, by recorded reason. "Unknown" stays visible. Value is the latest issued quotation, per currency — never combined across currencies.',
    groups: ['reason', 'family', 'source', 'country'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.decided_at, e.lost_reason_code, e.lost_note, e.competitor, e.source_code, c.company_name, c.country_code, ${firstFamily()} AS family,
          (SELECT r.total_minor FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL ORDER BY r.sent_at DESC LIMIT 1) AS value_minor,
          (SELECT r.currency FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL ORDER BY r.sent_at DESC LIMIT 1) AS currency
        FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.stage = 'lost' AND e.decided_at >= ? AND e.decided_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p)
        .map((r) => ({ ...r, reason: optionLabel('lost_reason', r.lost_reason_code) || 'Unknown', source: optionLabel('enquiry_source', r.source_code), decided_date: localDate(new Date(r.decided_at), tz()) }));
    },
    metrics: {
      total: { label: 'Lost opportunities', test: () => true },
      unknown: { label: 'Reason unknown', test: (r) => !r.lost_reason_code || r.lost_reason_code === 'unknown' },
      no_value: { label: 'No quoted value recorded', test: (r) => r.value_minor === null },
    },
    summary(records) {
      return {
        headline: { label: 'Lost opportunities', value: records.length, unit: '' },
        extra: [{ label: 'Reason unknown', value: records.filter(this.metrics.unknown.test).length, unit: '', denominator: records.length }],
        exclusions: [{ label: 'Without a quoted value (counted, not valued)', count: records.filter(this.metrics.no_value.test).length, metric: 'no_value' }],
      };
    },
    table(records, f) {
      const key = { reason: (r) => r.reason, family: (r) => r.family || 'Unspecified', source: (r) => r.source, country: (r) => r.country_code || 'Unknown' }[f.group || 'reason'];
      return groupRows(records, key, (rows) => {
        const v = {};
        for (const r of rows) if (r.value_minor !== null) v[r.currency] = (v[r.currency] || 0) + r.value_minor;
        return { count: rows.length, value: valueText(v) };
      });
    },
    tableColumns: [['group', 'Group'], ['count', 'Count'], ['value', 'Quoted value (per currency)']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['decided_date', 'Decided'], ['reason', 'Reason'], ['competitor', 'Competitor'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => `/enquiries/${r.id}`,
  },

  followup_performance: {
    title: 'Follow-up performance',
    definition: 'Tasks originally due in the period, by owner: completed on time, completed late, still overdue, cancelled and rescheduled. Internal actions are separate from customer contact. Calls logged are activity, not sales output — compare people only with their workload shown.',
    kinds: ['customer', 'internal'],
    collect(f, user) {
      const w = ['t.original_due_date >= ?', 't.original_due_date <= ?'];
      const p = [f.from, f.to];
      const scope = taskScope(user, 't');
      if (scope) w.push(scope);
      if (f.owner) w.push(`t.owner_id = ${f.owner}`);
      if (f.kind) {
        w.push('t.kind = ?');
        p.push(f.kind);
      }
      const nowStr = now().toISOString();
      return all(`SELECT t.id, t.purpose, t.kind, t.status, t.original_due_date, t.due_date, t.completed_at, t.completed_late, t.reschedule_count, t.overdue_at, t.customer_id, u.name AS owner, c.company_name
        FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id WHERE ${w.join(' AND ')}`, ...p)
        .map((t) => ({ ...t, result: t.status === 'done' ? (t.completed_late ? 'completed_late' : 'completed_on_time') : t.status === 'cancelled' ? 'cancelled' : t.overdue_at <= nowStr ? 'open_overdue' : 'open_not_due' }));
    },
    metrics: {
      total: { label: 'Tasks due', test: () => true },
      completed_on_time: { label: 'Completed on time', test: (r) => r.result === 'completed_on_time' },
      completed_late: { label: 'Completed late', test: (r) => r.result === 'completed_late' },
      open_overdue: { label: 'Still overdue', test: (r) => r.result === 'open_overdue' },
      cancelled: { label: 'Cancelled (not a contact)', test: (r) => r.result === 'cancelled' },
      rescheduled: { label: 'Rescheduled at least once', test: (r) => r.reschedule_count > 0 },
    },
    summary(records) {
      const done = records.filter((r) => r.result.startsWith('completed'));
      const ontime = records.filter(this.metrics.completed_on_time.test).length;
      return {
        headline: { label: 'Completed on time', value: pct(ontime, records.length), unit: '%', numerator: ontime, denominator: records.length },
        extra: [{ label: 'On time among completed', value: pct(ontime, done.length), unit: '%', numerator: ontime, denominator: done.length }],
        exclusions: [],
      };
    },
    table(records) {
      return groupRows(records, (r) => r.owner, (rows) => ({
        total: rows.length, on_time: rows.filter((r) => r.result === 'completed_on_time').length, late: rows.filter((r) => r.result === 'completed_late').length,
        overdue: rows.filter((r) => r.result === 'open_overdue').length, not_due: rows.filter((r) => r.result === 'open_not_due').length,
        cancelled: rows.filter((r) => r.result === 'cancelled').length, rescheduled: rows.filter((r) => r.reschedule_count > 0).length,
      }));
    },
    tableColumns: [['group', 'Owner'], ['total', 'Due (workload)'], ['on_time', 'On time'], ['late', 'Late'], ['overdue', 'Still overdue'], ['not_due', 'Open, not yet due'], ['cancelled', 'Cancelled'], ['rescheduled', 'Rescheduled']],
    recordColumns: [['purpose', 'Task'], ['company_name', 'Customer'], ['owner', 'Owner'], ['kind', 'Kind'], ['original_due_date', 'Originally due'], ['due_date', 'Due now'], ['result', 'Result'], ['reschedule_count', 'Reschedules']],
    link: (r) => (r.customer_id ? `/customers/${r.customer_id}` : '/followups'),
  },

  order_ageing: {
    title: 'Active order ageing',
    definition: 'Outstanding lines on confirmed, active orders: days since the order was received, and days past the ORIGINAL committed dispatch date for overdue lines. Lines without a commitment are shown separately.',
    collect(f, user) {
      const where = ["o.status = 'confirmed'", 'o.closed_at IS NULL'];
      const params = [];
      if (f.owner) where.push(`o.owner_id = ${f.owner}`);
      if (f.country) {
        where.push('c.country_code = ?');
        params.push(f.country);
      }
      if (f.segment) {
        where.push('COALESCE(o.segment, c.segment) = ?');
        params.push(f.segment);
      }
      const day = today();
      const out = [];
      for (const { order, lines } of loadOrdersWithLines(where, params, user)) {
        for (const l of lines) {
          if (f.family && l.family !== f.family) continue;
          const st = lineStatus(l, day, 'confirmed');
          if (!st.active) continue;
          out.push({
            order_id: order.id, order_code: order.code, company_name: order.customer_name, product: l.product_code || l.description, received_date: order.received_date,
            days_since_received: order.received_date ? daysBetween(order.received_date, day) : null, original_commitment_date: l.original_commitment_date,
            days_past_commitment: st.overdue ? st.daysLate : 0, remaining: lineQty(l).remaining, unit: l.unit, committed: l.commitment_state === 'committed',
          });
        }
      }
      return out;
    },
    metrics: {
      total: { label: 'Active lines', test: () => true },
      overdue: { label: 'Past original commitment', test: (r) => r.days_past_commitment > 0 },
      uncommitted: { label: 'No committed date', test: (r) => !r.committed },
      over_60: { label: 'Received more than 60 days ago', test: (r) => r.days_since_received > 60 },
    },
    summary(records) {
      return {
        headline: { label: 'Median days since received', value: median(records.map((r) => r.days_since_received)), unit: 'days', denominator: records.filter((r) => r.days_since_received !== null).length },
        extra: [{ label: 'Lines past original commitment', value: records.filter(this.metrics.overdue.test).length, unit: '', denominator: records.length }],
        exclusions: [{ label: 'Lines without a committed date (no lateness measured)', count: records.filter(this.metrics.uncommitted.test).length, metric: 'uncommitted' }],
      };
    },
    table(records) {
      const bucket = (d) => (d === null ? 'Unknown' : d <= 15 ? '0–15 days' : d <= 30 ? '16–30 days' : d <= 60 ? '31–60 days' : 'Over 60 days');
      return groupRows(records, (r) => bucket(r.days_since_received), (rows) => ({ count: rows.length, overdue: rows.filter((r) => r.days_past_commitment > 0).length, max_late: Math.max(0, ...rows.map((r) => r.days_past_commitment)) }));
    },
    tableColumns: [['group', 'Since received'], ['count', 'Lines'], ['overdue', 'Past commitment'], ['max_late', 'Max days late']],
    recordColumns: [['order_code', 'Order'], ['company_name', 'Customer'], ['product', 'Product'], ['received_date', 'Received'], ['days_since_received', 'Days since received'], ['original_commitment_date', 'Original commitment'], ['days_past_commitment', 'Days past commitment'], ['remaining', 'Remaining'], ['unit', 'Unit']],
    link: (r) => `/orders/${r.order_id}`,
  },

  dispatch_timeliness: {
    title: 'Dispatch timeliness',
    definition: 'Eligible completed lines on time ÷ eligible completed lines. A line is on time only if its whole non-cancelled quantity was dispatched by its ORIGINAL committed date. This measures dispatch, not customer delivery. Unknown commitments are excluded and counted; fully cancelled lines and currently overdue open lines are reported separately.',
    collect(f, user) {
      const w = ["o.status = 'confirmed'"];
      const p = [];
      const scope = orderScope(user, 'o');
      if (scope) w.push(scope);
      if (f.owner) w.push(`o.owner_id = ${f.owner}`);
      if (f.country) {
        w.push('c.country_code = ?');
        p.push(f.country);
      }
      if (f.segment) {
        w.push('COALESCE(o.segment, c.segment) = ?');
        p.push(f.segment);
      }
      if (f.family) {
        w.push('pr.family = ?');
        p.push(f.family);
      }
      const day = today();
      return all(`SELECT l.*, o.code AS order_code, o.id AS order_id, c.company_name, COALESCE(pr.code, l.description) AS product, 'confirmed' AS order_status,
          (SELECT MAX(d.dispatch_date) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted') AS last_dispatch_date,
          (SELECT MAX(d.date_unknown) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted') AS date_unknown,
          (SELECT MAX(k.effective_date) FROM cancellations k WHERE k.line_id = l.id AND k.reversed_at IS NULL) AS cancelled_on,
          (SELECT COUNT(*) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted' AND d.dispatch_date > l.original_commitment_date) AS late_shipments
        FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN products pr ON pr.id = l.product_id WHERE ${w.join(' AND ')}`, ...p)
        .map((l) => {
          const q = lineQty(l);
          const closed = !isPositive(q.remaining);
          let category = null;
          if (!closed) category = lineStatus(l, day, 'confirmed').overdue ? 'open_overdue' : null;
          else if (!isPositive(q.dispatched)) category = l.cancelled_on && l.cancelled_on >= f.from && l.cancelled_on <= f.to ? 'cancelled' : null;
          else if (l.last_dispatch_date && (l.last_dispatch_date < f.from || l.last_dispatch_date > f.to)) category = null;
          else if (l.commitment_state !== 'committed' || !l.original_commitment_date || !l.last_dispatch_date || l.date_unknown) category = l.last_dispatch_date || l.date_unknown ? 'excluded' : null;
          else category = l.last_dispatch_date <= l.original_commitment_date ? 'on_time' : 'late';
          return {
            order_id: l.order_id, order_code: l.order_code, company_name: l.company_name, product: l.product, original_commitment_date: l.original_commitment_date,
            completed_on: l.last_dispatch_date, dispatched: q.dispatched, cancelled: q.cancelled, unit: l.unit, category, late_shipments: l.late_shipments,
            days_late: l.last_dispatch_date && l.original_commitment_date ? Math.max(0, daysBetween(l.original_commitment_date, l.last_dispatch_date)) : null,
          };
        }).filter((r) => r.category);
    },
    metrics: {
      eligible: { label: 'Eligible completed lines', test: (r) => r.category === 'on_time' || r.category === 'late' },
      on_time: { label: 'On time', test: (r) => r.category === 'on_time' },
      late: { label: 'Late', test: (r) => r.category === 'late' },
      excluded: { label: 'Excluded: commitment or dispatch date unknown', test: (r) => r.category === 'excluded' },
      cancelled: { label: 'Fully cancelled lines (separate scope)', test: (r) => r.category === 'cancelled' },
      open_overdue: { label: 'Open lines currently overdue (separate)', test: (r) => r.category === 'open_overdue' },
    },
    summary(records) {
      const eligible = records.filter(this.metrics.eligible.test).length;
      const onTime = records.filter(this.metrics.on_time.test).length;
      return {
        headline: { label: 'Dispatched on time (vs original commitment)', value: pct(onTime, eligible), unit: '%', numerator: onTime, denominator: eligible },
        extra: [{ label: 'Late partial shipments on eligible lines', value: records.filter((r) => r.late_shipments > 0 && this.metrics.eligible.test(r)).length, unit: '' }],
        exclusions: [
          { label: 'Commitment or dispatch date unknown', count: records.filter(this.metrics.excluded.test).length, metric: 'excluded' },
          { label: 'Fully cancelled lines', count: records.filter(this.metrics.cancelled.test).length, metric: 'cancelled' },
          { label: 'Open lines currently overdue', count: records.filter(this.metrics.open_overdue.test).length, metric: 'open_overdue' },
        ],
      };
    },
    table(records) {
      return groupRows(records.filter((r) => ['on_time', 'late'].includes(r.category)), (r) => r.completed_on?.slice(0, 7) || 'Unknown', (rows) => {
        const ot = rows.filter((r) => r.category === 'on_time').length;
        return { count: rows.length, on_time: ot, late: rows.length - ot, rate: pct(ot, rows.length) };
      }).sort((a, b) => String(a.group).localeCompare(String(b.group)));
    },
    tableColumns: [['group', 'Month completed'], ['count', 'Eligible lines'], ['on_time', 'On time'], ['late', 'Late'], ['rate', 'On-time %']],
    recordColumns: [['order_code', 'Order'], ['company_name', 'Customer'], ['product', 'Product'], ['original_commitment_date', 'Original commitment'], ['completed_on', 'Completed (last dispatch)'], ['days_late', 'Days late'], ['category', 'Result']],
    link: (r) => `/orders/${r.order_id}`,
  },

  delayed_reasons: {
    title: 'Delayed order reasons',
    definition: 'Current primary reason on active delayed lines (overdue or forecast late), counted once per line. Historic delay events reported in the period are a separate table so nothing is double counted.',
    collect(f, user) {
      const day = today();
      const out = [];
      const where = ["o.status = 'confirmed'", 'o.closed_at IS NULL'];
      if (f.owner) where.push(`o.owner_id = ${f.owner}`);
      for (const { order, lines } of loadOrdersWithLines(where, [], user)) {
        for (const l of lines) {
          const st = lineStatus(l, day, 'confirmed');
          if (!st.active || !st.delayed) continue;
          out.push({ order_id: order.id, order_code: order.code, company_name: order.customer_name, product: l.product_code || l.description, reason: optionLabel('delay_reason', l.issue_code) || 'No reason recorded', note: l.stage_note, state: st.state, days_late: st.daysLate });
        }
      }
      return out;
    },
    metrics: { total: { label: 'Delayed lines now', test: () => true }, no_reason: { label: 'No reason recorded', test: (r) => r.reason === 'No reason recorded' } },
    summary(records, f) {
      const hist = all(`SELECT li.issue_code, li.reported_at, li.resolved_at FROM line_issues li WHERE li.reported_at >= ? AND li.reported_at < ?`, f.fromUtc, f.toUtc);
      return {
        headline: { label: 'Active delayed lines', value: records.length, unit: '' },
        extra: [{ label: 'Delay events reported in the period (historic, separate)', value: hist.length, unit: '' }],
        exclusions: [{ label: 'Delayed lines with no reason recorded', count: records.filter(this.metrics.no_reason.test).length, metric: 'no_reason' }],
        secondary: {
          title: 'Historic delay events in the period',
          columns: [['group', 'Reason'], ['count', 'Events'], ['resolved', 'Resolved'], ['median_days', 'Median days open']],
          rows: groupRows(hist, (h) => optionLabel('delay_reason', h.issue_code), (rows) => ({
            count: rows.length, resolved: rows.filter((r) => r.resolved_at).length,
            median_days: r1(median(rows.filter((r) => r.resolved_at).map((r) => (Date.parse(r.resolved_at) - Date.parse(r.reported_at)) / 86400000))),
          })),
        },
      };
    },
    table(records) {
      return groupRows(records, (r) => r.reason, (rows) => ({ count: rows.length, overdue: rows.filter((r) => r.state === 'overdue').length, at_risk: rows.filter((r) => r.state === 'at_risk').length }));
    },
    tableColumns: [['group', 'Current reason'], ['count', 'Lines'], ['overdue', 'Overdue'], ['at_risk', 'Forecast late']],
    recordColumns: [['order_code', 'Order'], ['company_name', 'Customer'], ['product', 'Product'], ['reason', 'Reason'], ['note', 'Note'], ['state', 'State'], ['days_late', 'Days late']],
    link: (r) => `/orders/${r.order_id}`,
  },

  reactivation_output: {
    title: 'Reactivation output',
    definition: 'Reactivation cases active in the period: dormant customers contacted (an actual contact, not a reminder), responses received, opportunities reopened as linked enquiries, and orders won back with value per currency.',
    collect(f, user) {
      const scope = customerScope(user, 'c');
      return all(`SELECT rc.*, c.company_name, u.name AS owner,
          (SELECT COUNT(*) FROM activities a WHERE a.reactivation_case_id = rc.id AND a.customer_contact = 1 AND a.occurred_at >= ? AND a.occurred_at < ?) AS contacts,
          (SELECT COUNT(*) FROM activities a WHERE a.reactivation_case_id = rc.id AND a.meaningful = 1 AND a.occurred_at >= ? AND a.occurred_at < ?) AS responses,
          (SELECT o.currency FROM orders o WHERE o.id = rc.order_id) AS currency,
          (SELECT SUM(l.confirmed_qty * l.unit_price_minor) FROM order_lines l WHERE l.order_id = rc.order_id AND l.unit_price_minor IS NOT NULL) AS won_value
        FROM reactivation_cases rc JOIN customers c ON c.id = rc.customer_id LEFT JOIN users u ON u.id = rc.owner_id
        WHERE rc.opened_at < ? AND (rc.closed_at IS NULL OR rc.closed_at >= ?) ${scope ? `AND ${scope}` : ''} ${f.owner ? `AND rc.owner_id = ${f.owner}` : ''}`,
      f.fromUtc, f.toUtc, f.fromUtc, f.toUtc, f.toUtc, f.fromUtc).map((r) => ({ ...r, status_label: r.status.replace(/_/g, ' '), reason: optionLabel('lost_reason', r.reason_code) }));
    },
    metrics: {
      cases: { label: 'Cases in the period', test: () => true },
      contacted: { label: 'Customers contacted', test: (r) => r.contacts > 0 },
      responded: { label: 'Responses received', test: (r) => r.responses > 0 },
      reopened: { label: 'Opportunities reopened', test: (r) => Boolean(r.enquiry_id) },
      won_back: { label: 'Won back (linked confirmed order)', test: (r) => r.status === 'won_back' && r.order_id },
    },
    summary(records) {
      const value = {};
      for (const r of records.filter(this.metrics.won_back.test)) if (r.won_value) value[r.currency || 'INR'] = (value[r.currency || 'INR'] || 0) + Math.round(r.won_value);
      return {
        headline: { label: 'Won back', value: records.filter(this.metrics.won_back.test).length, unit: '', denominator: records.length },
        extra: [{ label: 'Won-back order value', value: valueText(value), unit: '' }],
        exclusions: [],
      };
    },
    table(records) {
      return groupRows(records, (r) => r.reason || 'No reason recorded', (rows) => ({ count: rows.length, contacted: rows.filter((r) => r.contacts > 0).length, reopened: rows.filter((r) => r.enquiry_id).length, won_back: rows.filter((r) => r.status === 'won_back').length }));
    },
    tableColumns: [['group', 'Reason recorded'], ['count', 'Cases'], ['contacted', 'Contacted'], ['reopened', 'Reopened'], ['won_back', 'Won back']],
    recordColumns: [['company_name', 'Customer'], ['owner', 'Owner'], ['status_label', 'Status'], ['reason', 'Reason'], ['contacts', 'Contacts'], ['responses', 'Responses']],
    link: (r) => `/customers/${r.customer_id}`,
  },

  source_country_product: {
    title: 'Source, country & product',
    definition: 'Enquiries received, quotations issued, orders confirmed and repeat orders in the period, grouped by source, country or product family. Order values are per currency. A repeat order is a confirmed order from a customer with an earlier confirmed order.',
    groups: ['source', 'country', 'family'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      const enquiries = all(`SELECT e.id, e.code, e.source_code, c.country_code, ${firstFamily()} AS family, 'enquiry' AS kind, NULL AS currency, NULL AS value_minor, c.company_name, e.received_at AS at
        FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p);
      const quotes = all(`SELECT e.id, q.number AS code, e.source_code, c.country_code, ${firstFamily()} AS family, 'quotation' AS kind, r.currency, r.total_minor AS value_minor, c.company_name, r.sent_at AS at
        FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id JOIN enquiries e ON e.id = q.enquiry_id JOIN customers c ON c.id = e.customer_id
        WHERE r.revision_no = (SELECT MIN(r2.revision_no) FROM quote_revisions r2 WHERE r2.quotation_id = q.id AND r2.sent_at IS NOT NULL) AND r.sent_at >= ? AND r.sent_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p);
      const ow = ["o.status = 'confirmed'", 'o.received_date >= ?', 'o.received_date <= ?'];
      const op = [f.from, f.to];
      const oscope = orderScope(user, 'o');
      if (oscope) ow.push(oscope);
      if (f.owner) ow.push(`o.owner_id = ${f.owner}`);
      if (f.country) {
        ow.push('c.country_code = ?');
        op.push(f.country);
      }
      if (f.segment) {
        ow.push('COALESCE(o.segment, c.segment) = ?');
        op.push(f.segment);
      }
      const orders = all(`SELECT o.id, o.code, COALESCE(e.source_code, 'direct:' || COALESCE(o.source_code, 'other')) AS source_code, c.country_code,
          (SELECT p.family FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = o.id ORDER BY l.line_no LIMIT 1) AS family, 'order' AS kind, o.currency,
          (SELECT CASE WHEN COUNT(*) = COUNT(l.unit_price_minor) THEN SUM(l.confirmed_qty * l.unit_price_minor) END FROM order_lines l WHERE l.order_id = o.id) AS value_minor, c.company_name, o.received_date AS at,
          EXISTS (SELECT 1 FROM orders o2 WHERE o2.customer_id = o.customer_id AND o2.status = 'confirmed' AND o2.received_date < o.received_date) AS repeat_order
        FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN enquiries e ON e.id = o.enquiry_id WHERE ${ow.join(' AND ')}`, ...op)
        .filter((o) => !f.family || o.family === f.family).filter((o) => !f.source || o.source_code === f.source);
      return [...enquiries, ...quotes, ...orders].map((r) => ({
        ...r, value_minor: r.value_minor === null ? null : Math.round(r.value_minor),
        source: String(r.source_code).startsWith('direct:') ? `Direct: ${optionLabel('order_source', String(r.source_code).slice(7))}` : optionLabel('enquiry_source', r.source_code),
      }));
    },
    metrics: {
      enquiries: { label: 'Enquiries', test: (r) => r.kind === 'enquiry' },
      quotations: { label: 'Quotations issued', test: (r) => r.kind === 'quotation' },
      orders: { label: 'Orders confirmed', test: (r) => r.kind === 'order' },
      repeat: { label: 'Repeat orders', test: (r) => r.kind === 'order' && r.repeat_order },
      orders_no_value: { label: 'Orders without full prices (not valued)', test: (r) => r.kind === 'order' && r.value_minor === null },
    },
    summary(records) {
      const orders = records.filter((r) => r.kind === 'order');
      const v = {};
      for (const o of orders) if (o.value_minor !== null) v[o.currency || 'INR'] = (v[o.currency || 'INR'] || 0) + o.value_minor;
      return {
        headline: { label: 'Orders confirmed', value: orders.length, unit: '' },
        extra: [{ label: 'Order value (per currency; not revenue or margin)', value: valueText(v), unit: '' }],
        exclusions: [{ label: 'Orders without full prices (counted, not valued)', count: records.filter(this.metrics.orders_no_value.test).length, metric: 'orders_no_value' }],
      };
    },
    table(records, f) {
      const key = { source: (r) => r.source, country: (r) => r.country_code || 'Unknown', family: (r) => r.family || 'Unspecified' }[f.group || 'source'];
      return groupRows(records, key, (rows) => {
        const v = {};
        for (const o of rows.filter((r) => r.kind === 'order' && r.value_minor !== null)) v[o.currency || 'INR'] = (v[o.currency || 'INR'] || 0) + o.value_minor;
        return { total: rows.length, enquiries: rows.filter((r) => r.kind === 'enquiry').length, quotations: rows.filter((r) => r.kind === 'quotation').length, orders: rows.filter((r) => r.kind === 'order').length, repeat: rows.filter((r) => r.kind === 'order' && r.repeat_order).length, value: valueText(v) };
      });
    },
    tableColumns: [['group', 'Group'], ['enquiries', 'Enquiries'], ['quotations', 'Quotations'], ['orders', 'Orders'], ['repeat', 'Repeat orders'], ['value', 'Order value']],
    recordColumns: [['kind', 'Record'], ['code', 'Reference'], ['company_name', 'Customer'], ['source', 'Source'], ['country_code', 'Country'], ['family', 'Product family'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => (r.kind === 'order' ? `/orders/${r.id}` : `/enquiries/${r.id}`),
  },

  receivables: {
    title: 'Receivables (P1)',
    p1: true,
    definition: 'Outstanding invoice amounts by due-date age and currency, from the invoice register (an operational mirror of accounting). A promised payment is not a receipt. Customers with no invoice data are not shown as zero.',
    collect(f) {
      const day = today();
      return all(`SELECT i.*, c.company_name, ${outstandingSql('i')} AS outstanding_minor
        FROM invoices i JOIN customers c ON c.id = i.customer_id`).filter((i) => i.outstanding_minor !== 0).map((i) => {
        const late = i.due_date && i.due_date < day ? daysBetween(i.due_date, day) : 0;
        return { ...i, days_overdue: late, bucket: i.outstanding_minor < 0 ? 'Overpaid / credit' : !late ? 'Not yet due' : late <= 30 ? '1–30 days' : late <= 60 ? '31–60 days' : late <= 90 ? '61–90 days' : 'Over 90 days', promise_broken: Boolean(i.promise_date && i.promise_date < day && i.outstanding_minor > 0) };
      }).filter((i) => !f.owner || i.owner_id === f.owner);
    },
    metrics: {
      outstanding: { label: 'Invoices with a balance', test: (r) => r.outstanding_minor > 0 },
      overdue: { label: 'Overdue', test: (r) => r.days_overdue > 0 && r.outstanding_minor > 0 },
      promise_broken: { label: 'Broken payment promises', test: (r) => r.promise_broken },
      overpaid: { label: 'Overpaid (credit balance)', test: (r) => r.outstanding_minor < 0 },
    },
    summary(records) {
      const v = {};
      for (const r of records.filter((x) => x.days_overdue > 0 && x.outstanding_minor > 0)) v[r.currency] = (v[r.currency] || 0) + r.outstanding_minor;
      const fin = settings().finance;
      return {
        headline: { label: 'Overdue amount', value: valueText(v), unit: '' },
        extra: [{ label: `Data as of ${fin.asOf || 'not recorded'} · ${fin.reconciliation === 'reconciled' ? 'reconciled' : 'not reconciled'} · source: ${fin.source}`, value: '', unit: '' }],
        exclusions: [{ label: 'Overpaid invoices (shown separately)', count: records.filter(this.metrics.overpaid.test).length, metric: 'overpaid' }],
      };
    },
    table(records) {
      const rows = [];
      for (const r of records) {
        const key = `${r.bucket}|${r.currency}`;
        let row = rows.find((x) => x.key === key);
        if (!row) rows.push(row = { key, group: r.bucket, currency: r.currency, count: 0, amount_minor: 0 });
        row.count++;
        row.amount_minor += r.outstanding_minor;
      }
      return rows.map((r) => ({ ...r, amount: formatMoney(r.amount_minor, r.currency) }));
    },
    tableColumns: [['group', 'Age'], ['currency', 'Currency'], ['count', 'Invoices'], ['amount', 'Outstanding']],
    recordColumns: [['invoice_ref', 'Invoice'], ['company_name', 'Customer'], ['invoice_date', 'Invoice date'], ['due_date', 'Due date'], ['currency', 'Currency'], ['outstanding_minor', 'Outstanding (minor units)'], ['days_overdue', 'Days overdue'], ['promise_date', 'Promise date']],
    link: (r) => `/payments?invoice=${r.id}`,
  },

  complaints: {
    title: 'Complaints (P1)',
    p1: true,
    definition: 'Complaints received in the period: open by age and owner, overdue first responses, time to resolution, reported issue categories by product and confirmed root causes. Without installed or sold unit counts, these are complaint counts — not failure rates.',
    groups: ['category', 'product', 'owner', 'root_cause', 'customer'],
    collect(f) {
      return all(`SELECT k.*, c.company_name, u.name AS owner, COALESCE(p.code, k.model) AS product FROM complaints k JOIN customers c ON c.id = k.customer_id JOIN users u ON u.id = k.owner_id LEFT JOIN products p ON p.id = k.product_id
        WHERE k.received_date >= ? AND k.received_date <= ? ${f.owner ? `AND k.owner_id = ${f.owner}` : ''}`, f.from, f.to)
        .map((k) => ({
          ...k, category: optionLabel('complaint_category', k.category_code), root_cause: optionLabel('complaint_root_cause', k.root_cause_code) || 'Not established',
          open: COMPLAINT_STATUSES.find((s) => s.value === k.status)?.open ?? true, status_label: labelOf(COMPLAINT_STATUSES, k.status),
          age_days: daysBetween(k.received_date, today()), resolution_days: k.resolved_date ? daysBetween(k.received_date, k.resolved_date) : null,
          first_response_overdue: !k.first_response_at && workingDaysBetween(k.received_date, today(), calendar()) >= 1,
        }));
    },
    metrics: {
      total: { label: 'Complaints received', test: () => true },
      open: { label: 'Open', test: (r) => r.open },
      first_response_overdue: { label: 'First response overdue', test: (r) => r.first_response_overdue && r.open },
      resolved: { label: 'Resolved', test: (r) => r.resolution_days !== null },
    },
    summary(records) {
      const res = records.filter((r) => r.resolution_days !== null);
      const repeat = Object.values(records.reduce((m, r) => ({ ...m, [r.customer_id]: (m[r.customer_id] || 0) + 1 }), {})).filter((n) => n > 1).length;
      return {
        headline: { label: 'Median days to resolution', value: median(res.map((r) => r.resolution_days)), unit: 'days', denominator: res.length },
        extra: [{ label: 'Customers with repeat complaints', value: repeat, unit: '' }],
        exclusions: [],
      };
    },
    table(records, f) {
      const key = { category: (r) => r.category, product: (r) => r.product || 'Unknown product', owner: (r) => r.owner, root_cause: (r) => r.root_cause, customer: (r) => r.company_name }[f.group || 'category'];
      return groupRows(records, key, (rows) => ({ count: rows.length, open: rows.filter((r) => r.open).length, resolved: rows.filter((r) => r.resolution_days !== null).length, median_days: median(rows.filter((r) => r.resolution_days !== null).map((r) => r.resolution_days)) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Complaints'], ['open', 'Open'], ['resolved', 'Resolved'], ['median_days', 'Median days to resolve']],
    recordColumns: [['code', 'Complaint'], ['company_name', 'Customer'], ['product', 'Product'], ['category', 'Category'], ['status_label', 'Status'], ['received_date', 'Received'], ['age_days', 'Age (days)'], ['root_cause', 'Root cause']],
    link: (r) => `/complaints/${r.id}`,
  },

  // ---------------------------------------------------------------- sales & marketing (from the earlier report set)
  campaign_roi: {
    title: 'Exhibition & campaign ROI',
    definition: 'Per campaign: enquiries linked to it, quotations issued, confirmed orders and their value (before tax, per currency), against the recorded cost. ROI (order value ÷ cost) is shown only when cost and orders are in the same currency. Campaigns are included when they started in the period.',
    groups: ['campaign', 'type'],
    collect(f, user) {
      const scope = enquiryScope(user, 'e');
      return all(`SELECT e.id, e.code, e.stage, e.received_at, cp.id AS campaign_id, cp.name AS campaign, cp.type, cp.cost_minor, cp.cost_currency, cp.start_date, c.company_name,
          (SELECT COUNT(*) FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL) AS quotes,
          (SELECT o.currency FROM orders o WHERE o.enquiry_id = e.id AND o.status = 'confirmed' LIMIT 1) AS currency,
          (SELECT SUM((SELECT SUM(ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor)) FROM order_lines l WHERE l.order_id = o.id)) FROM orders o WHERE o.enquiry_id = e.id AND o.status = 'confirmed') AS value_minor
        FROM enquiries e JOIN campaigns cp ON cp.id = e.campaign_id JOIN customers c ON c.id = e.customer_id
        WHERE COALESCE(cp.start_date, substr(cp.created_at, 1, 10)) BETWEEN ? AND ? ${scope ? `AND ${scope}` : ''} ${f.owner ? `AND e.owner_id = ${f.owner}` : ''}`, f.from, f.to)
        .map((r) => ({ ...r, type_label: String(r.type).replace(/_/g, ' '), won: r.stage === 'won' }));
    },
    metrics: {
      enquiries: { label: 'Enquiries from campaigns', test: () => true },
      quoted: { label: 'Quoted', test: (r) => r.quotes > 0 },
      won: { label: 'Won', test: (r) => r.won },
    },
    summary(records) {
      const v = {};
      for (const r of records) if (r.value_minor) v[r.currency || 'INR'] = (v[r.currency || 'INR'] || 0) + r.value_minor;
      return {
        headline: { label: 'Campaign enquiries converted', value: pct(records.filter((r) => r.won).length, records.length), unit: '%', numerator: records.filter((r) => r.won).length, denominator: records.length },
        extra: [{ label: 'Order value from campaign enquiries', value: valueText(v), unit: '' }],
        exclusions: [],
      };
    },
    groupKeys: { campaign: (r) => r.campaign, type: (r) => r.type_label },
    table(records, f) {
      const key = f.group === 'type' ? (r) => r.type_label : (r) => r.campaign;
      return groupRows(records, key, (rows) => {
        const v = {};
        for (const r of rows) if (r.value_minor) v[r.currency || 'INR'] = (v[r.currency || 'INR'] || 0) + r.value_minor;
        const cost = f.group === 'type' ? null : rows[0]?.cost_minor;
        const cur = rows[0]?.cost_currency || 'INR';
        return {
          count: rows.length, quoted: rows.filter((r) => r.quotes > 0).length, won: rows.filter((r) => r.won).length, value: valueText(v),
          cost: cost ? formatMoney(cost, cur) : '—', roi: cost && v[cur] ? `${Math.round((v[cur] / cost) * 10) / 10}×` : '—',
        };
      });
    },
    tableColumns: [['group', 'Campaign'], ['count', 'Enquiries'], ['quoted', 'Quoted'], ['won', 'Won'], ['value', 'Order value'], ['cost', 'Cost'], ['roi', 'ROI']],
    recordColumns: [['code', 'Enquiry'], ['campaign', 'Campaign'], ['company_name', 'Customer'], ['stage', 'Stage'], ['quotes', 'Quotations'], ['currency', 'Currency'], ['value_minor', 'Order value (minor units)']],
    link: (r) => `/enquiries/${r.id}`,
  },

  salesperson_conversion: {
    title: 'Salesperson conversion',
    definition: 'Per owner: enquiries received in the period (cohort), how many were quoted, won and lost, with open workload alongside. Calls logged are activity, not sales output; compare people only with their workload and outcome scope visible.',
    groups: ['owner'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.stage, e.received_at, e.owner_id, u.name AS owner, c.company_name,
          (SELECT COUNT(*) FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL) AS quotes,
          (SELECT COUNT(*) FROM enquiries e2 WHERE e2.owner_id = e.owner_id AND e2.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')})) AS open_workload
        FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p);
    },
    metrics: {
      total: { label: 'Enquiries received', test: () => true },
      quoted: { label: 'Quoted', test: (r) => r.quotes > 0 },
      won: { label: 'Won', test: (r) => r.stage === 'won' },
      lost: { label: 'Lost', test: (r) => r.stage === 'lost' },
    },
    summary(records) {
      const won = records.filter((r) => r.stage === 'won').length;
      return {
        headline: { label: 'Team cohort conversion', value: pct(won, records.length), unit: '%', numerator: won, denominator: records.length },
        extra: [{ label: 'Quoted share', value: pct(records.filter((r) => r.quotes > 0).length, records.length), unit: '%', numerator: records.filter((r) => r.quotes > 0).length, denominator: records.length }],
        exclusions: [],
      };
    },
    table(records) {
      return groupRows(records, (r) => r.owner, (rows) => {
        const won = rows.filter((r) => r.stage === 'won').length;
        const lost = rows.filter((r) => r.stage === 'lost').length;
        return { total: rows.length, quoted: rows.filter((r) => r.quotes > 0).length, won, lost, conversion: pct(won, rows.length), win_rate: pct(won, won + lost), open_workload: rows[0]?.open_workload ?? 0 };
      });
    },
    tableColumns: [['group', 'Owner'], ['total', 'Received'], ['quoted', 'Quoted'], ['won', 'Won'], ['lost', 'Lost'], ['conversion', 'Conversion %'], ['win_rate', 'Win rate % (decided)'], ['open_workload', 'Open enquiries now']],
    recordColumns: [['code', 'Enquiry'], ['owner', 'Owner'], ['company_name', 'Customer'], ['stage', 'Stage'], ['quotes', 'Quotations issued']],
    link: (r) => `/enquiries/${r.id}`,
  },

  quote_to_order: {
    title: 'Quotation to order',
    definition: 'Quotations first issued in the period and what became of them: accepted and converted into an order, rejected, superseded or still awaiting a decision. Value is the latest issued revision before tax, per currency.',
    groups: ['owner', 'month'],
    collect(f, user) {
      const scope = quotationScope(user, 'q');
      return all(`SELECT q.id, q.number, q.enquiry_id, c.company_name, u.name AS owner, MIN(r.sent_at) AS first_sent_at,
          (SELECT r2.status FROM quote_revisions r2 WHERE r2.quotation_id = q.id ORDER BY r2.revision_no DESC LIMIT 1) AS latest_status,
          (SELECT r2.currency FROM quote_revisions r2 WHERE r2.quotation_id = q.id AND r2.sent_at IS NOT NULL ORDER BY r2.revision_no DESC LIMIT 1) AS currency,
          (SELECT r2.total_minor FROM quote_revisions r2 WHERE r2.quotation_id = q.id AND r2.sent_at IS NOT NULL ORDER BY r2.revision_no DESC LIMIT 1) AS value_minor,
          (SELECT COUNT(*) FROM orders o JOIN quote_revisions r3 ON r3.id = o.quote_revision_id WHERE r3.quotation_id = q.id AND o.status = 'confirmed') AS orders,
          (SELECT COUNT(*) FROM quote_revisions r4 WHERE r4.quotation_id = q.id AND r4.sent_at IS NOT NULL) AS revisions
        FROM quotations q JOIN quote_revisions r ON r.quotation_id = q.id AND r.sent_at IS NOT NULL JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id
        WHERE 1 = 1 ${scope ? `AND ${scope}` : ''} ${f.owner ? `AND q.owner_id = ${f.owner}` : ''} GROUP BY q.id HAVING MIN(r.sent_at) >= ? AND MIN(r.sent_at) < ?`, f.fromUtc, f.toUtc)
        .map((r) => ({ ...r, month: localDate(new Date(r.first_sent_at), tz()).slice(0, 7), outcome: r.orders > 0 ? 'converted' : r.latest_status === 'accepted' ? 'accepted_not_converted' : r.latest_status }));
    },
    metrics: {
      total: { label: 'Quotations issued', test: () => true },
      converted: { label: 'Converted to an order', test: (r) => r.outcome === 'converted' },
      accepted_not_converted: { label: 'Accepted, no order yet', test: (r) => r.outcome === 'accepted_not_converted' },
      rejected: { label: 'Rejected', test: (r) => r.outcome === 'rejected' },
      awaiting: { label: 'Awaiting decision', test: (r) => ['issued', 'draft'].includes(r.outcome) },
    },
    summary(records) {
      const conv = records.filter((r) => r.outcome === 'converted').length;
      return {
        headline: { label: 'Quotation-to-order rate', value: pct(conv, records.length), unit: '%', numerator: conv, denominator: records.length },
        extra: [{ label: 'Median revisions per quotation', value: median(records.map((r) => r.revisions)), unit: '' }],
        exclusions: [],
      };
    },
    groupKeys: { owner: (r) => r.owner, month: (r) => r.month },
    table(records, f) {
      return groupRows(records, f.group === 'month' ? (r) => r.month : (r) => r.owner, (rows) => {
        const v = {};
        for (const r of rows.filter((x) => x.outcome === 'converted' && x.value_minor)) v[r.currency || 'INR'] = (v[r.currency || 'INR'] || 0) + r.value_minor;
        return { total: rows.length, converted: rows.filter((r) => r.outcome === 'converted').length, rejected: rows.filter((r) => r.outcome === 'rejected').length, rate: pct(rows.filter((r) => r.outcome === 'converted').length, rows.length), value: valueText(v) };
      });
    },
    tableColumns: [['group', 'Group'], ['total', 'Issued'], ['converted', 'Converted'], ['rejected', 'Rejected'], ['rate', 'Conversion %'], ['value', 'Converted value']],
    recordColumns: [['number', 'Quotation'], ['company_name', 'Customer'], ['owner', 'Owner'], ['first_sent_at', 'First issued (UTC)'], ['outcome', 'Outcome'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => `/quotations/${r.id}`,
  },

  sales_cycle: {
    title: 'Sales cycle',
    definition: 'Days from the enquiry being received to it being won, for enquiries won in the period. Enquiries with an unknown received date are excluded and counted.',
    groups: ['family', 'source', 'owner'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.received_at, e.decided_at, e.received_unknown, e.source_code, u.name AS owner, c.company_name, ${firstFamily()} AS family
        FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.stage = 'won' AND e.decided_at >= ? AND e.decided_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p)
        .map((r) => ({ ...r, source: optionLabel('enquiry_source', r.source_code), days: r.received_at ? r1((Date.parse(r.decided_at) - Date.parse(r.received_at)) / 86400000) : null }));
    },
    metrics: {
      measured: { label: 'Won with a known received date', test: (r) => r.days !== null },
      unknown: { label: 'Received date unknown (excluded)', test: (r) => r.days === null },
    },
    summary(records) {
      const m = records.filter((r) => r.days !== null);
      return { headline: { label: 'Median days to win', value: r1(median(m.map((r) => r.days))), unit: 'days', denominator: m.length }, extra: [], exclusions: [{ label: 'Received date unknown', count: records.length - m.length, metric: 'unknown' }] };
    },
    table(records, f) {
      const key = { family: (r) => r.family || 'Unspecified', source: (r) => r.source, owner: (r) => r.owner }[f.group || 'family'];
      return groupRows(records.filter((r) => r.days !== null), key, (rows) => ({ count: rows.length, median_days: r1(median(rows.map((r) => r.days))) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Won'], ['median_days', 'Median days']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['received_at', 'Received (UTC)'], ['decided_at', 'Won (UTC)'], ['days', 'Days'], ['owner', 'Owner']],
    link: (r) => `/enquiries/${r.id}`,
  },

  discount_margin: {
    title: 'Discount & margin',
    definition: 'Quotation revisions issued in the period: overall discount against the price list, and margin where every line has a recorded cost. Revisions that needed approval are counted. Margin is visible only to roles allowed to see cost.',
    groups: ['owner', 'family'],
    collect(f, user) {
      const scope = quotationScope(user, 'q');
      return all(`SELECT r.id, q.id AS quotation_id, q.number, r.revision_no, r.currency, r.total_minor, r.discount_pct, r.max_line_discount_pct, r.margin_pct, r.approval_role, r.approval_status, r.below_min_price,
          c.company_name, u.name AS owner, ${firstFamily('e')} AS family
        FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.owner_id LEFT JOIN enquiries e ON e.id = q.enquiry_id
        WHERE r.sent_at >= ? AND r.sent_at < ? ${scope ? `AND ${scope}` : ''} ${f.owner ? `AND q.owner_id = ${f.owner}` : ''}`, f.fromUtc, f.toUtc)
        .map((r) => ({ ...r, needed_approval: Boolean(r.approval_role) }));
    },
    metrics: {
      total: { label: 'Revisions issued', test: () => true },
      needed_approval: { label: 'Needed approval', test: (r) => r.needed_approval },
      below_min: { label: 'Priced below minimum', test: (r) => Boolean(r.below_min_price) },
      no_margin: { label: 'Margin unknown (cost missing)', test: (r) => r.margin_pct === null },
    },
    summary(records, f, user) {
      const showMargin = (user.permissions || []).includes('margin.view');
      const m = records.filter((r) => r.margin_pct !== null);
      return {
        headline: { label: 'Median overall discount', value: r1(median(records.map((r) => r.discount_pct))), unit: '%', denominator: records.length },
        extra: showMargin ? [{ label: 'Median margin (revisions with full cost)', value: r1(median(m.map((r) => r.margin_pct))), unit: '%', denominator: m.length }] : [],
        exclusions: showMargin ? [{ label: 'Margin unknown (cost missing)', count: records.length - m.length, metric: 'no_margin' }] : [],
      };
    },
    table(records, f) {
      const key = f.group === 'family' ? (r) => r.family || 'Unspecified' : (r) => r.owner;
      return groupRows(records, key, (rows) => ({
        count: rows.length, discount_median: r1(median(rows.map((r) => r.discount_pct))), max_line_discount: r1(Math.max(0, ...rows.map((r) => r.max_line_discount_pct || 0))),
        margin_pct_median: r1(median(rows.filter((r) => r.margin_pct !== null).map((r) => r.margin_pct))), approvals: rows.filter((r) => r.needed_approval).length,
      }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Revisions'], ['discount_median', 'Median discount %'], ['max_line_discount', 'Largest line discount %'], ['margin_pct_median', 'Median margin %'], ['approvals', 'Needed approval']],
    recordColumns: [['number', 'Quotation'], ['revision_no', 'Revision'], ['company_name', 'Customer'], ['owner', 'Owner'], ['discount_pct', 'Discount %'], ['margin_pct', 'Margin %'], ['approval_status', 'Approval']],
    link: (r) => `/quotations/${r.quotation_id}`,
  },

  pipeline_forecast: {
    title: 'Pipeline forecast',
    definition: 'Open enquiries by expected decision month: value (latest issued quotation, else the estimate) and weighted value (× probability — the recorded one, else the stage default), per currency. Enquiries without a value or expected date are counted separately rather than guessed.',
    groups: ['month', 'owner', 'stage'],
    collect(f, user) {
      const { w, p } = enquiryWhere(f, user);
      return all(`SELECT e.id, e.code, e.stage, e.expected_decision_date, e.probability, e.est_value_minor, e.est_currency, u.name AS owner, c.company_name,
          (SELECT r.total_minor FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_minor,
          (SELECT r.currency FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.status IN ('issued','accepted') ORDER BY r.id DESC LIMIT 1) AS quoted_currency
        FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
        WHERE e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')}) ${w.length ? `AND ${w.join(' AND ')}` : ''}`, ...p)
        .map((r) => {
          const quoted = r.quoted_minor !== null && r.quoted_minor !== undefined;
          const value = quoted ? r.quoted_minor : r.est_value_minor;
          const probability = r.probability ?? { new: 10, clarification: 15, quote_to_prepare: 30, quote_sent: 45, awaiting_decision: 60, on_hold: 20 }[r.stage] ?? 0;
          return {
            ...r, value_minor: value, currency: quoted ? r.quoted_currency : r.est_currency, probability_effective: probability,
            weighted_minor: value === null || value === undefined ? null : Math.round((value * probability) / 100),
            month: r.expected_decision_date ? r.expected_decision_date.slice(0, 7) : 'No expected date', stage_label: String(r.stage).replace(/_/g, ' '),
          };
        });
    },
    metrics: {
      total: { label: 'Open enquiries', test: () => true },
      valued: { label: 'With a value', test: (r) => r.value_minor !== null && r.value_minor !== undefined },
      undated: { label: 'No expected decision date', test: (r) => !r.expected_decision_date },
    },
    summary(records) {
      const w = {};
      for (const r of records) if (r.weighted_minor) w[r.currency || 'INR'] = (w[r.currency || 'INR'] || 0) + r.weighted_minor;
      return {
        headline: { label: 'Weighted pipeline', value: valueText(w), unit: '' },
        extra: [],
        exclusions: [{ label: 'Without a value (not forecast)', count: records.filter((r) => r.value_minor === null || r.value_minor === undefined).length }, { label: 'Without an expected decision date', count: records.filter((r) => !r.expected_decision_date).length, metric: 'undated' }],
      };
    },
    groupKeys: { month: (r) => r.month, owner: (r) => r.owner, stage: (r) => r.stage_label },
    table(records, f) {
      const key = { month: (r) => r.month, owner: (r) => r.owner, stage: (r) => r.stage_label }[f.group || 'month'];
      const rows = groupRows(records, key, (rs) => {
        const v = {};
        const w = {};
        for (const r of rs) {
          if (r.value_minor) v[r.currency || 'INR'] = (v[r.currency || 'INR'] || 0) + r.value_minor;
          if (r.weighted_minor) w[r.currency || 'INR'] = (w[r.currency || 'INR'] || 0) + r.weighted_minor;
        }
        return { count: rs.length, value: valueText(v), weighted: valueText(w) };
      });
      return (f.group || 'month') === 'month' ? rows.sort((a, b) => String(a.group).localeCompare(String(b.group))) : rows;
    },
    tableColumns: [['group', 'Group'], ['count', 'Enquiries'], ['value', 'Value'], ['weighted', 'Weighted value']],
    recordColumns: [['code', 'Enquiry'], ['company_name', 'Customer'], ['stage_label', 'Stage'], ['expected_decision_date', 'Expected decision'], ['probability_effective', 'Probability %'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)'], ['owner', 'Owner']],
    link: (r) => `/enquiries/${r.id}`,
  },

  region_revenue: {
    title: 'Orders by region',
    definition: 'Orders confirmed in the period by customer region (before tax, net of cancellations, per currency). Order value is not revenue or margin; orders without full prices are counted but not valued.',
    groups: ['region', 'owner', 'month'],
    collect(f, user) {
      return confirmedOrders(f, user);
    },
    metrics: {
      total: { label: 'Orders confirmed', test: () => true },
      unpriced: { label: 'Without full prices', test: (r) => r.value_minor === null },
    },
    summary(records) {
      return { headline: { label: 'Order value', value: valueText(sumByCurrency(records)), unit: '' }, extra: [], exclusions: [{ label: 'Orders without full prices (counted, not valued)', count: records.filter((r) => r.value_minor === null).length, metric: 'unpriced' }] };
    },
    groupKeys: { region: (r) => r.region || 'No region', owner: (r) => r.owner, month: (r) => r.month },
    table(records, f) {
      const key = { region: (r) => r.region || 'No region', owner: (r) => r.owner, month: (r) => r.month }[f.group || 'region'];
      return groupRows(records, key, (rows) => ({ count: rows.length, customers: new Set(rows.map((r) => r.customer_id)).size, value: valueText(sumByCurrency(rows)) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Orders'], ['customers', 'Customers'], ['value', 'Order value']],
    recordColumns: [['code', 'Order'], ['company_name', 'Customer'], ['region', 'Region'], ['confirmed_date', 'Confirmed'], ['owner', 'Owner'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => `/orders/${r.id}`,
  },

  product_demand: {
    title: 'Product demand',
    definition: 'Per product: quantity and value on orders confirmed in the period (net of cancellations), with enquiries received for it in the same period. Values are per currency and before tax.',
    groups: ['product', 'family'],
    collect(f, user) {
      const orders = confirmedOrders(f, user);
      if (!orders.length) return [];
      const lines = all(`SELECT l.order_id, l.confirmed_qty - l.cancelled_qty AS qty, l.unit, l.unit_price_minor, COALESCE(p.code, l.description) AS product, p.family
        FROM order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.order_id IN (${orders.map((o) => o.id).join(',')})`);
      const byId = new Map(orders.map((o) => [o.id, o]));
      return lines.map((l) => {
        const o = byId.get(l.order_id);
        return { id: o.id, code: o.code, company_name: o.company_name, product: l.product, family: l.family || 'Unspecified', qty: l.qty, unit: l.unit, currency: o.currency, value_minor: l.unit_price_minor === null ? null : Math.round(l.qty * l.unit_price_minor) };
      });
    },
    metrics: { total: { label: 'Order lines', test: () => true } },
    summary(records) {
      return { headline: { label: 'Products ordered', value: new Set(records.map((r) => r.product)).size, unit: '' }, extra: [{ label: 'Order value', value: valueText(sumByCurrency(records)), unit: '' }], exclusions: [] };
    },
    groupKeys: { product: (r) => r.product, family: (r) => r.family },
    table(records, f) {
      const key = f.group === 'family' ? (r) => r.family : (r) => r.product;
      return groupRows(records, key, (rows) => ({ count: rows.length, qty: Math.round(rows.reduce((s, r) => s + r.qty, 0) * 1000) / 1000, customers: new Set(rows.map((r) => r.company_name)).size, value: valueText(sumByCurrency(rows)) }))
        .sort((a, b) => b.qty - a.qty);
    },
    tableColumns: [['group', 'Product'], ['qty', 'Quantity'], ['count', 'Order lines'], ['customers', 'Customers'], ['value', 'Value']],
    recordColumns: [['code', 'Order'], ['company_name', 'Customer'], ['product', 'Product'], ['qty', 'Quantity'], ['unit', 'Unit'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => `/orders/${r.id}`,
  },

  top_customers: {
    title: 'Top customers',
    definition: 'Customers ranked by confirmed order value in the period (before tax, net of cancellations), per currency — the ranking uses each customer\'s largest currency total and never adds currencies together.',
    groups: ['customer'],
    collect(f, user) {
      return confirmedOrders(f, user);
    },
    metrics: { total: { label: 'Orders confirmed', test: () => true } },
    summary(records) {
      return { headline: { label: 'Customers ordering', value: new Set(records.map((r) => r.customer_id)).size, unit: '' }, extra: [], exclusions: [] };
    },
    groupKeys: { customer: (r) => r.company_name },
    table(records) {
      return groupRows(records, (r) => r.company_name, (rows) => {
        const v = sumByCurrency(rows);
        return { count: rows.length, value: valueText(v), total: Math.max(0, ...Object.values(v)) };
      }).slice(0, 50);
    },
    tableColumns: [['group', 'Customer'], ['count', 'Orders'], ['value', 'Order value']],
    recordColumns: [['code', 'Order'], ['company_name', 'Customer'], ['confirmed_date', 'Confirmed'], ['currency', 'Currency'], ['value_minor', 'Value (minor units)']],
    link: (r) => `/orders/${r.id}`,
  },

  repeat_order_rate: {
    title: 'Repeat-order rate',
    definition: 'Of the customers who placed a confirmed order in the period, how many had already ordered before the period (repeat customers) and how many ordered more than once within it. Imported historical orders count as earlier orders.',
    groups: ['owner', 'region'],
    collect(f, user) {
      const orders = confirmedOrders(f, user);
      const byCustomer = new Map();
      for (const o of orders) {
        const c = byCustomer.get(o.customer_id) || { id: o.customer_id, company_name: o.company_name, owner: o.customer_owner, region: o.region || 'No region', orders: 0 };
        c.orders++;
        byCustomer.set(o.customer_id, c);
      }
      return [...byCustomer.values()].map((c) => {
        const before = get(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'confirmed' AND received_date < ?`, c.id, f.from).n;
        const legacy = get('SELECT legacy_last_order_date, legacy_order_count FROM customers WHERE id = ?', c.id);
        return { ...c, repeat_customer: before > 0 || Boolean(legacy?.legacy_order_count) || Boolean(legacy?.legacy_last_order_date && legacy.legacy_last_order_date < f.from), multiple_in_period: c.orders > 1 };
      });
    },
    metrics: {
      total: { label: 'Customers who ordered', test: () => true },
      repeat: { label: 'Had ordered before', test: (r) => r.repeat_customer },
      multiple: { label: 'Ordered more than once in the period', test: (r) => r.multiple_in_period },
    },
    summary(records) {
      const rep = records.filter((r) => r.repeat_customer).length;
      return { headline: { label: 'Repeat customers', value: pct(rep, records.length), unit: '%', numerator: rep, denominator: records.length }, extra: [{ label: 'Ordered more than once in the period', value: records.filter((r) => r.multiple_in_period).length, unit: '' }], exclusions: [] };
    },
    groupKeys: { owner: (r) => r.owner || 'Unassigned', region: (r) => r.region },
    table(records, f) {
      const key = f.group === 'region' ? (r) => r.region : (r) => r.owner || 'Unassigned';
      return groupRows(records, key, (rows) => ({ count: rows.length, repeat: rows.filter((r) => r.repeat_customer).length, rate: pct(rows.filter((r) => r.repeat_customer).length, rows.length) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Customers ordering'], ['repeat', 'Repeat customers'], ['rate', 'Repeat %']],
    recordColumns: [['company_name', 'Customer'], ['orders', 'Orders in period'], ['repeat_customer', 'Ordered before'], ['owner', 'Owner'], ['region', 'Region']],
    link: (r) => `/customers/${r.id}`,
  },

  dormant_customers: {
    title: 'Dormant customers',
    definition: `Past buyers whose last confirmed order (recorded or imported) is older than the configured inactivity threshold, with the latest reconnect status. Customers whose last order date is unknown are listed separately — never guessed.`,
    groups: ['owner', 'region', 'status'],
    collect(f, user) {
      const threshold = settings().rules.dormantDays;
      const cutoff = addDays(today(), -threshold);
      const scope = customerScope(user, 'c');
      return all(`SELECT c.id, c.company_name, c.country_code, c.do_not_contact, u.name AS owner, rg.name AS region,
          (SELECT MAX(o.received_date) FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed') AS last_recorded, c.legacy_last_order_date, c.legacy_order_count,
          (SELECT rc.status FROM reactivation_cases rc WHERE rc.customer_id = c.id ORDER BY rc.id DESC LIMIT 1) AS reactivation_status
        FROM customers c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN regions rg ON rg.id = c.region_id
        WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL ${scope ? `AND ${scope}` : ''} ${f.owner ? `AND c.owner_id = ${f.owner}` : ''}`)
        .map((c) => {
          const last = [c.last_recorded, c.legacy_last_order_date].filter(Boolean).sort().at(-1) || null;
          const buyer = Boolean(last) || Boolean(c.legacy_order_count);
          return { ...c, last_order: last, buyer, unknown_date: buyer && !last, days_since: last ? daysBetween(last, today()) : null, status: c.reactivation_status ? String(c.reactivation_status).replace(/_/g, ' ') : 'not reviewed', threshold };
        })
        .filter((c) => c.buyer && (c.unknown_date || c.last_order < cutoff));
    },
    metrics: {
      total: { label: 'Dormant past buyers', test: () => true },
      unknown: { label: 'Last order date unknown', test: (r) => r.unknown_date },
      dnc: { label: 'Do not contact', test: (r) => Boolean(r.do_not_contact) },
    },
    summary(records) {
      return { headline: { label: `Past buyers with no order for ${records[0]?.threshold ?? settings().rules.dormantDays}+ days`, value: records.filter((r) => !r.unknown_date).length, unit: '' }, extra: [], exclusions: [{ label: 'Last order date unknown (listed, not aged)', count: records.filter((r) => r.unknown_date).length, metric: 'unknown' }] };
    },
    groupKeys: { owner: (r) => r.owner || 'Unassigned', region: (r) => r.region || 'No region', status: (r) => r.status },
    table(records, f) {
      const key = { owner: (r) => r.owner || 'Unassigned', region: (r) => r.region || 'No region', status: (r) => r.status }[f.group || 'owner'];
      return groupRows(records, key, (rows) => ({ count: rows.length, median_days: median(rows.map((r) => r.days_since)) }));
    },
    tableColumns: [['group', 'Group'], ['count', 'Dormant customers'], ['median_days', 'Median days since last order']],
    recordColumns: [['company_name', 'Customer'], ['last_order', 'Last order'], ['days_since', 'Days since'], ['status', 'Reconnect status'], ['owner', 'Owner'], ['region', 'Region']],
    link: (r) => `/customers/${r.id}`,
  },

  activity_summary: {
    title: 'Daily / weekly summary',
    definition: 'What was recorded each day or week of the period: enquiries received, quotations issued, orders confirmed, dispatches posted, receipts and complaints. Counts what has been entered — it does not prove the work was done if nobody recorded it.',
    groups: ['day', 'week'],
    collect(f, user) {
      const zone = tz();
      const out = [];
      const pushRows = (kind, rows, dateOf) => rows.forEach((r) => out.push({ kind, ...r, date: dateOf(r) }));
      const { w, p } = enquiryWhere(f, user);
      pushRows('Enquiry received', all(`SELECT e.id, e.code AS ref, e.received_at AS at FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.received_at >= ? AND e.received_at < ? ${w.length ? `AND ${w.join(' AND ')}` : ''}`, f.fromUtc, f.toUtc, ...p), (r) => localDate(new Date(r.at), zone));
      const qscope = quotationScope(user, 'q');
      pushRows('Quotation issued', all(`SELECT q.id, q.number || ' rev ' || r.revision_no AS ref, r.sent_at AS at FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE r.sent_at >= ? AND r.sent_at < ? ${qscope ? `AND ${qscope}` : ''}`, f.fromUtc, f.toUtc), (r) => localDate(new Date(r.at), zone));
      const oscope = orderScope(user, 'o');
      pushRows('Order confirmed', all(`SELECT o.id, o.code AS ref, o.confirmed_at AS at FROM orders o WHERE o.status = 'confirmed' AND o.confirmed_at >= ? AND o.confirmed_at < ? ${oscope ? `AND ${oscope}` : ''}`, f.fromUtc, f.toUtc), (r) => localDate(new Date(r.at), zone));
      pushRows('Dispatch posted', all(`SELECT d.id, d.code AS ref, d.dispatch_date AS at FROM dispatches d WHERE d.status = 'posted' AND d.dispatch_date BETWEEN ? AND ?`, f.from, f.to), (r) => r.at);
      if ((user.permissions || []).includes('finance.view')) pushRows('Receipt recorded', all(`SELECT r.id, COALESCE(r.reference, 'Receipt') AS ref, r.effective_date AS at FROM receipts r WHERE r.reversed_at IS NULL AND r.kind <> 'credit' AND r.effective_date BETWEEN ? AND ?`, f.from, f.to), (r) => r.at);
      pushRows('Complaint received', all('SELECT k.id, k.code AS ref, k.received_date AS at FROM complaints k WHERE k.received_date BETWEEN ? AND ?', f.from, f.to), (r) => r.at);
      return out.map((r) => {
        const d = new Date(`${r.date}T12:00:00Z`);
        const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
        return { ...r, week: `Week of ${monday}` };
      });
    },
    metrics: {
      enquiries: { label: 'Enquiries received', test: (r) => r.kind === 'Enquiry received' },
      quotes: { label: 'Quotations issued', test: (r) => r.kind === 'Quotation issued' },
      orders: { label: 'Orders confirmed', test: (r) => r.kind === 'Order confirmed' },
      dispatches: { label: 'Dispatches posted', test: (r) => r.kind === 'Dispatch posted' },
      complaints: { label: 'Complaints received', test: (r) => r.kind === 'Complaint received' },
    },
    summary(records) {
      return { headline: { label: 'Records entered in the period', value: records.length, unit: '' }, extra: [], exclusions: [] };
    },
    groupKeys: { day: (r) => r.date, week: (r) => r.week },
    table(records, f) {
      const key = f.group === 'week' ? (r) => r.week : (r) => r.date;
      const count = (rows, k) => rows.filter((r) => r.kind === k).length;
      return groupRows(records, key, (rows) => ({
        count: rows.length, enquiries: count(rows, 'Enquiry received'), quotes: count(rows, 'Quotation issued'), orders: count(rows, 'Order confirmed'),
        dispatches: count(rows, 'Dispatch posted'), receipts: count(rows, 'Receipt recorded'), complaints: count(rows, 'Complaint received'),
      })).sort((a, b) => String(b.group).localeCompare(String(a.group)));
    },
    tableColumns: [['group', 'Day / week'], ['enquiries', 'Enquiries'], ['quotes', 'Quotations'], ['orders', 'Orders'], ['dispatches', 'Dispatches'], ['receipts', 'Receipts'], ['complaints', 'Complaints']],
    recordColumns: [['date', 'Date'], ['kind', 'Event'], ['ref', 'Reference']],
    link: (r) => (r.kind === 'Enquiry received' ? `/enquiries/${r.id}` : r.kind === 'Quotation issued' ? `/quotations/${r.id}` : r.kind === 'Order confirmed' ? `/orders/${r.id}` : r.kind === 'Complaint received' ? `/complaints/${r.id}` : r.kind === 'Dispatch posted' ? '/dispatches' : '/payments'),
  },
};

/** Confirmed orders in the period with their value (before tax, net of cancellations; null when any line is unpriced). */
function confirmedOrders(f, user) {
  const ow = ["o.status = 'confirmed'", 'o.confirmed_at >= ?', 'o.confirmed_at < ?'];
  const op = [f.fromUtc, f.toUtc];
  const oscope = orderScope(user, 'o');
  if (oscope) ow.push(oscope);
  if (f.owner) ow.push(`o.owner_id = ${f.owner}`);
  if (f.country) {
    ow.push('c.country_code = ?');
    op.push(f.country);
  }
  if (f.segment) {
    ow.push('COALESCE(o.segment, c.segment) = ?');
    op.push(f.segment);
  }
  if (f.family) {
    ow.push('EXISTS (SELECT 1 FROM order_lines l2 JOIN products p2 ON p2.id = l2.product_id WHERE l2.order_id = o.id AND p2.family = ?)');
    op.push(f.family);
  }
  return all(`SELECT o.id, o.code, o.customer_id, o.currency, o.confirmed_at, c.company_name, rg.name AS region, u.name AS owner, cu.name AS customer_owner,
      (SELECT CASE WHEN COUNT(*) = COUNT(l.unit_price_minor) THEN SUM(ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor)) END FROM order_lines l WHERE l.order_id = o.id) AS value_minor
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN regions rg ON rg.id = c.region_id LEFT JOIN users u ON u.id = o.owner_id LEFT JOIN users cu ON cu.id = c.owner_id
    WHERE ${ow.join(' AND ')}`, ...op)
    .map((o) => {
      const d = localDate(new Date(o.confirmed_at), tz());
      return { ...o, confirmed_date: d, month: d.slice(0, 7) };
    });
}

function sumByCurrency(rows) {
  const v = {};
  for (const r of rows) if (r.value_minor !== null && r.value_minor !== undefined) v[r.currency || 'INR'] = (v[r.currency || 'INR'] || 0) + r.value_minor;
  return v;
}

export function reportList() {
  return Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, definition: r.definition, groups: r.groups || [], bases: r.bases || null, kinds: r.kinds || null, p1: Boolean(r.p1) }));
}

export function runReport(key, query, user) {
  const def = REPORTS[key];
  if (!def) return null;
  const f = parseFilters(query);
  const records = def.collect(f, user);
  const metrics = Object.entries(def.metrics).map(([k, m]) => ({ key: k, label: m.label, count: records.filter(m.test).length }));
  return {
    key, title: def.title, definition: def.definition, filters: f, generated_at: now().toISOString(), timezone: tz(),
    groups: def.groups || [], bases: def.bases || null, kinds: def.kinds || null,
    metrics, ...def.summary(records, f, user),
    table: { columns: def.tableColumns.map(([k, label]) => ({ key: k, label })), rows: def.table(records, f) },
    record_count: records.length,
  };
}

/** The exact records behind a metric (or all records), with the same filters and definitions as the summary. */
export function reportRecords(key, query, user) {
  const def = REPORTS[key];
  if (!def) return null;
  const f = parseFilters(query);
  let records = def.collect(f, user);
  if (query.metric && def.metrics[query.metric]) records = records.filter(def.metrics[query.metric].test);
  if (query.group_value !== undefined && def.table) {
    const groupKey = query.group_value;
    const g = f.group || def.groups?.[0];
    const keyFn = def.groupKeys?.[g] || {
      source: (r) => r.source, owner: (r) => r.owner, month: (r) => r.received_date?.slice(0, 7), country: (r) => r.country_code || 'Unknown', family: (r) => r.family || 'Unspecified',
      reason: (r) => r.reason, category: (r) => r.category, product: (r) => r.product || 'Unknown product', root_cause: (r) => r.root_cause, customer: (r) => r.company_name,
    }[g];
    if (keyFn) records = records.filter((r) => String(keyFn(r) ?? 'Unknown') === String(groupKey));
  }
  return {
    columns: def.recordColumns.map(([k, label]) => ({ key: k, label })),
    rows: records.map((r) => ({ ...r, _link: def.link(r) })),
    count: records.length,
    filters: f,
    title: def.title,
    definition: def.definition,
  };
}

export { REPORTS, placeholders };
