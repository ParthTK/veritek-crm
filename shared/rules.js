// Pure business rules shared by the server (which enforces them) and the UI (which explains them).
import { daysBetween } from './dates.js';
import { PHASES } from './constants.js';

export const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const EPS = 0.0005;

// ------------------------------------------------------------------ quantities
/**
 * Line-level quantity model:
 *   remaining = confirmed − valid dispatched − cancelled
 * Ready is an operational readiness total (including what has already been dispatched from it);
 * it is never added to dispatch as if it were a separate sale.
 */
export function lineQty(l) {
  const confirmed = round3(l.confirmed_qty);
  const dispatched = round3(l.dispatched_qty);
  const cancelled = round3(l.cancelled_qty);
  const remaining = round3(confirmed - dispatched - cancelled);
  const ready = l.ready_qty === null || l.ready_qty === undefined ? null : round3(l.ready_qty);
  return {
    confirmed,
    dispatched,
    cancelled,
    remaining,
    ready,
    readyNotDispatched: ready === null ? null : Math.max(0, round3(ready - dispatched)),
    notReady: ready === null ? null : Math.max(0, round3(confirmed - cancelled - ready)),
  };
}

export const isPositive = (n) => Number(n) > EPS;

// ------------------------------------------------------------------ delay classification
/**
 * Classifies one order line. Issue reported, forecast late and commitment overdue are kept separate,
 * and lateness is always measured against the ORIGINAL commitment. A customer-agreed revised date is
 * reported alongside (pastAgreed) but never rewrites the original promise.
 */
export function lineStatus(l, today, orderStatus) {
  const q = lineQty(l);
  const status = orderStatus ?? l.order_status;
  const out = {
    state: 'on_track', active: false, remaining: q.remaining, overdue: false, atRisk: false, dueToday: false,
    issue: Boolean(l.issue_code), uncommitted: false, pastAgreed: false, estimateUnknown: Boolean(l.estimate_unknown), daysLate: 0,
  };
  if (status === 'draft') return { ...out, state: 'draft' };
  if (!isPositive(q.remaining)) return { ...out, state: 'closed', issue: false };
  out.active = true;
  const original = l.commitment_state === 'committed' ? l.original_commitment_date : null;
  if (!original) {
    out.uncommitted = true;
  } else {
    if (today > original) {
      out.overdue = true;
      out.daysLate = daysBetween(original, today);
    } else if (today === original) {
      out.dueToday = true;
    }
    if (!out.overdue && l.forecast_dispatch_date && l.forecast_dispatch_date > original) out.atRisk = true;
    if (l.agreed_commitment_date && today > l.agreed_commitment_date) out.pastAgreed = true;
  }
  out.state = out.overdue ? 'overdue' : out.atRisk ? 'at_risk' : out.issue ? 'issue' : out.uncommitted ? 'uncommitted' : 'on_track';
  out.delayed = out.overdue || out.atRisk;
  return out;
}

/** Derived fulfilment outcome tags, shown alongside the broad phase. */
export function fulfilmentOutcome({ dispatched, cancelled, remaining }) {
  const d = isPositive(dispatched);
  const c = isPositive(cancelled);
  if (isPositive(remaining)) {
    return [d ? 'partially_dispatched' : 'not_dispatched', ...(c ? ['partially_cancelled'] : [])];
  }
  if (!c) return ['fully_dispatched'];
  if (!d) return ['fully_cancelled'];
  return ['partially_dispatched', 'partially_cancelled'];
}

const phaseIndex = (p) => PHASES.findIndex((x) => x.value === p);

/** Header phase: the common phase of outstanding lines, or "mixed". */
export function headerPhase(lines) {
  const outstanding = lines.filter((l) => isPositive(lineQty(l).remaining));
  if (!outstanding.length) {
    return lines.some((l) => isPositive(l.dispatched_qty)) ? 'dispatched' : 'closed';
  }
  const phases = [...new Set(outstanding.map((l) => l.phase))];
  return phases.length === 1 ? phases[0] : 'mixed';
}

export function isBackwardMove(from, to) {
  return phaseIndex(to) < phaseIndex(from);
}

/** Totals and derived header facts for an order, computed from its lines (one definition everywhere). */
export function orderSummary(order, lines, today) {
  const totals = { confirmed: 0, dispatched: 0, cancelled: 0, remaining: 0 };
  let earliest = null;
  let latest = null;
  const states = {};
  for (const l of lines) {
    const q = lineQty(l);
    totals.confirmed = round3(totals.confirmed + q.confirmed);
    totals.dispatched = round3(totals.dispatched + q.dispatched);
    totals.cancelled = round3(totals.cancelled + q.cancelled);
    totals.remaining = round3(totals.remaining + q.remaining);
    const s = lineStatus(l, today, order.status);
    states[s.state] = (states[s.state] || 0) + 1;
    if (s.active && l.commitment_state === 'committed' && l.original_commitment_date) {
      if (!earliest || l.original_commitment_date < earliest) earliest = l.original_commitment_date;
      if (!latest || l.original_commitment_date > latest) latest = l.original_commitment_date;
    }
  }
  const active = order.status === 'confirmed' && isPositive(totals.remaining);
  const overdue = (states.overdue || 0) > 0;
  const atRisk = !overdue && (states.at_risk || 0) > 0;
  return {
    totals,
    active,
    phase: order.status === 'draft' ? 'draft' : headerPhase(lines),
    outcome: order.status === 'draft' ? [] : fulfilmentOutcome(totals),
    earliest_due: earliest,
    latest_due: latest,
    line_states: states,
    overdue,
    at_risk: atRisk,
    delayed: overdue || (states.at_risk || 0) > 0,
    issue: (states.issue || 0) > 0 || lines.some((l) => l.issue_code && isPositive(lineQty(l).remaining)),
    uncommitted: (states.uncommitted || 0) > 0,
  };
}

// ------------------------------------------------------------------ money (integer minor units)
/** "1,250.50" -> 125050. Returns null for empty input and NaN for invalid input. */
export function toMinor(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : Number.NaN;
  const s = String(v).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  return (neg ? -1 : 1) * (Number(i) * 100 + Number(`${f}00`.slice(0, 2)));
}

export function fromMinor(m) {
  if (m === null || m === undefined) return null;
  const neg = m < 0;
  const abs = Math.abs(m);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatMoney(minor, currency = 'INR') {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${currency} ${fromMinor(minor)}`;
  }
}

/** Line value in minor units, or null when the price is unknown (missing price is not zero sales). */
export function lineValueMinor(qty, unitPriceMinor) {
  if (unitPriceMinor === null || unitPriceMinor === undefined) return null;
  return Math.round(Number(qty) * unitPriceMinor);
}
