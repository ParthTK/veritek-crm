const isNum = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));

export function inr(n, decimals = 0) {
  if (!isNum(n)) return '—';
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** Indian compact currency: ₹4.2 Cr, ₹18.5 L, ₹42K. */
export function inrCompact(n) {
  if (!isNum(n)) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7, abs >= 1e9 ? 0 : 2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5, abs >= 1e6 ? 1 : 2)} L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3, 1)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

function trim(v, digits) {
  return Number(v.toFixed(digits)).toLocaleString('en-IN', { maximumFractionDigits: digits });
}

export const number = (n, decimals = 0) => (isNum(n) ? Number(n).toLocaleString('en-IN', { maximumFractionDigits: decimals }) : '—');
export const pct = (n, decimals = 1) => (isNum(n) ? `${Number(Number(n).toFixed(decimals))}%` : '—');

function toDate(s) {
  if (!s) return null;
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function date(s) {
  const d = toDate(s);
  return d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}
export function dateShort(s) {
  const d = toDate(s);
  return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
}
export function dateTime(s) {
  const d = toDate(s);
  return d ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}
export function monthLabel(ym) {
  if (!ym) return '';
  const d = new Date(`${ym}-01T00:00:00`);
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

const pad = (n) => String(n).padStart(2, '0');
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDaysStr(s, days) {
  const d = toDate(s) || new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function daysFromToday(s) {
  const d = toDate(String(s).slice(0, 10));
  if (!d) return null;
  const t = toDate(todayStr());
  return Math.round((d - t) / 86400000);
}

/** "today", "tomorrow", "in 4 days", "3 days ago" for date-only values. */
export function relativeDay(s) {
  const n = daysFromToday(s);
  if (n === null) return '—';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export function timeAgo(s) {
  const d = toDate(s);
  if (!d) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} d ago`;
  return date(s);
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

export function formatValue(value, format) {
  switch (format) {
    case 'currency': return inrCompact(value);
    case 'currency_full': return inr(value);
    case 'number': return number(value);
    case 'decimal': return number(value, 1);
    case 'pct': return pct(value);
    case 'days': return isNum(value) ? `${number(value)} d` : '—';
    case 'multiple': return isNum(value) ? `${number(value, 1)}×` : '—';
    case 'date': return date(value);
    case 'month': return monthLabel(value);
    case 'bool': return value ? 'Yes' : 'No';
    default: return value ?? '—';
  }
}

export function downloadCsv(filename, columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(c.csv ? c.csv(r) : r[c.key])).join(','))];
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
