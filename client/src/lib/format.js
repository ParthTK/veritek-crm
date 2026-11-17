// Display formatting. Instants are shown in the configured zone (default Asia/Kolkata); business dates
// are shown as calendar dates without any time-zone conversion.
import { localDate, daysBetween, addDays } from '@shared/dates.js';
import { formatMoney } from '@shared/rules.js';

let zone = 'Asia/Kolkata';
let serverToday = null;
export function setZone(tz, today) {
  zone = tz || zone;
  serverToday = today || null;
}
export const tz = () => zone;
/** Today in the business time zone (not the browser's). */
export const todayLocal = () => localDate(new Date(), zone) || serverToday;

const isNum = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));

export function date(s, { year = 'auto' } = {}) {
  if (!s) return '—';
  const d = String(s).slice(0, 10);
  const dt = new Date(`${d}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return '—';
  const showYear = year === true || (year === 'auto' && d.slice(0, 4) !== todayLocal().slice(0, 4));
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(showYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function dateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = localDate(d, zone).slice(0, 4) === todayLocal().slice(0, 4);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit', timeZone: zone });
}

export function time(s) {
  if (!s) return '';
  return new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: zone });
}

/** "Today", "Tomorrow", "Yesterday", "3 days ago", "in 5 days" for business dates. */
export function relDay(s) {
  if (!s) return '—';
  const n = daysBetween(todayLocal(), String(s).slice(0, 10));
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0 && n > -14) return `${-n} days ago`;
  if (n > 0 && n < 14) return `in ${n} days`;
  return date(s);
}

export function dayCount(s) {
  return s ? daysBetween(todayLocal(), String(s).slice(0, 10)) : null;
}

export function timeAgo(s) {
  if (!s) return '—';
  const mins = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 45) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export const qty = (n, unit) => (isNum(n) ? `${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${unit && unit !== 'pcs' ? ` ${unit}` : ''}` : '—');
export const number = (n, decimals = 0) => (isNum(n) ? Number(n).toLocaleString('en-IN', { maximumFractionDigits: decimals }) : '—');
export const pct = (n) => (isNum(n) ? `${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%` : '—');
export const money = (minor, currency) => formatMoney(minor, currency);

/** Separate totals per currency — never summed across currencies. */
export function moneyByCurrency(map) {
  const parts = Object.entries(map || {}).filter(([, v]) => v).map(([c, v]) => formatMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
}

const CURRENCY_SYMBOL = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', SAR: 'SAR ' };
const trimNum = (v, digits) => Number(v.toFixed(digits)).toLocaleString('en-IN', { maximumFractionDigits: digits });

/** Short money label for charts and tiles: ₹12.5 L, ₹1.2 Cr, $45K. Input is minor units. */
export function compactMoney(minor, currency = 'INR') {
  if (!isNum(minor)) return '—';
  const v = Number(minor) / 100;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const sym = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  if (currency === 'INR') {
    if (abs >= 1e7) return `${sign}${sym}${trimNum(abs / 1e7, 2)} Cr`;
    if (abs >= 1e5) return `${sign}${sym}${trimNum(abs / 1e5, 2)} L`;
  } else if (abs >= 1e6) return `${sign}${sym}${trimNum(abs / 1e6, 2)}M`;
  if (abs >= 1e3) return `${sign}${sym}${trimNum(abs / 1e3, 1)}K`;
  return `${sign}${sym}${Math.round(abs)}`;
}

/** Per-currency totals in compact form, never summed across currencies. */
export function compactByCurrency(map) {
  const parts = Object.entries(map || {}).filter(([, v]) => v).map(([c, v]) => compactMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
}

export const monthLabel = (ym) => {
  if (!ym) return '—';
  const d = new Date(`${String(ym).slice(0, 7)}-01T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? ym : d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

/**
 * Chart/tooltip value formatting. `money` (minor units, INR) or `money:USD`; `pct`; `days`; `number`.
 */
export function formatValue(value, format) {
  if (typeof format === 'string' && format.startsWith('money')) return compactMoney(value, format.split(':')[1] || 'INR');
  switch (format) {
    case 'number': return number(value);
    case 'decimal': return number(value, 1);
    case 'pct': return pct(value);
    case 'days': return isNum(value) ? `${number(value)} d` : '—';
    case 'date': return date(value);
    case 'month': return monthLabel(value);
    default: return value ?? '—';
  }
}

/** Builds and downloads a CSV in the browser. columns: [{ key, label }] (key may be a function). */
export function downloadCsv(filename, columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(typeof c.key === 'function' ? c.key(r) : r[c.key])).join(','))];
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export function fileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/** Local datetime-input value ("YYYY-MM-DDTHH:MM") for an instant, in the business zone. */
export function toLocalInput(instant = new Date()) {
  const d = new Date(instant);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export { addDays };
