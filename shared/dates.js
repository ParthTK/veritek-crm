// Date handling shared by the server and the browser.
//
// - Instants (when something happened) are ISO-8601 UTC strings: "2026-11-17T04:30:00.000Z".
// - Business dates (commitments, due dates) are plain "YYYY-MM-DD" strings. They are never converted
//   through midnight timestamps, so they cannot shift by a day between time zones.
// - "Today" and "overdue" are always evaluated in the configured local zone (default Asia/Kolkata).

export const DEFAULT_TZ = 'Asia/Kolkata';

const formatters = new Map();
function partsFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(instant, tz = DEFAULT_TZ) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** The local calendar date ("YYYY-MM-DD") of an instant. */
export function localDate(instant = new Date(), tz = DEFAULT_TZ) {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The local wall-clock time ("HH:MM") of an instant. */
export function localTime(instant = new Date(), tz = DEFAULT_TZ) {
  const p = zonedParts(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function offsetMs(instantMs, tz) {
  const p = zonedParts(new Date(instantMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The UTC instant (ISO string) of a local date and wall-clock time in a zone. */
export function zonedToUtc(dateStr, timeStr = '00:00', tz = DEFAULT_TZ) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = String(timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  let ts = guess - offsetMs(guess, tz);
  const corrected = guess - offsetMs(ts, tz); // second pass handles DST transitions
  if (corrected !== ts) ts = corrected;
  return new Date(ts).toISOString();
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function isInstant(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

// ------------------------------------------------------------------ working calendar
// cal = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-08', …] }. Never assume Monday–Friday.

export function isWorkingDay(dateStr, cal) {
  const days = cal?.workingDays?.length ? cal.workingDays : [1, 2, 3, 4, 5, 6];
  return days.includes(weekday(dateStr)) && !(cal?.holidays || []).includes(dateStr);
}

/** The n-th working day after dateStr (n = 0 returns dateStr itself). */
export function addWorkingDays(dateStr, n, cal) {
  let d = dateStr;
  let left = Number(n) || 0;
  let guard = 0;
  while (left > 0 && guard++ < 3660) {
    d = addDays(d, 1);
    if (isWorkingDay(d, cal)) left--;
  }
  return d;
}

/** dateStr itself if it is a working day, otherwise the next working day. */
export function onOrNextWorkingDay(dateStr, cal) {
  let d = dateStr;
  let guard = 0;
  while (!isWorkingDay(d, cal) && guard++ < 60) d = addDays(d, 1);
  return d;
}

/** Working days strictly after `from` up to and including `to` (0 when `to` is not later). */
export function workingDaysBetween(from, to, cal) {
  if (!from || !to || to <= from) return 0;
  let n = 0;
  let d = from;
  let guard = 0;
  while (d < to && guard++ < 3660) {
    d = addDays(d, 1);
    if (isWorkingDay(d, cal)) n++;
  }
  return n;
}

// ------------------------------------------------------------------ task due logic
/**
 * The instant at which a task becomes overdue: a date-only task at the end of its local date,
 * a time-specific task at its due time.
 */
export function overdueAt(dueDate, dueTime, tz = DEFAULT_TZ) {
  return dueTime ? zonedToUtc(dueDate, dueTime, tz) : zonedToUtc(addDays(dueDate, 1), '00:00', tz);
}

/** 'overdue' | 'today' | 'upcoming' for an open task, null otherwise. */
export function dueState(task, nowInstant = new Date(), tz = DEFAULT_TZ) {
  if (!task || (task.status && task.status !== 'open')) return null;
  const nowMs = nowInstant instanceof Date ? nowInstant.getTime() : Date.parse(nowInstant);
  const at = Date.parse(task.overdue_at || overdueAt(task.due_date, task.due_time, tz));
  if (nowMs >= at) return 'overdue';
  return task.due_date === localDate(new Date(nowMs), tz) ? 'today' : 'upcoming';
}

/** Due-date presets offered next to every date field. */
export function datePresets(today, cal) {
  return [
    { label: 'Today', value: today },
    { label: 'Next working day', value: addWorkingDays(today, 1, cal) },
    { label: '+2 working days', value: addWorkingDays(today, 2, cal) },
    { label: '+1 week', value: onOrNextWorkingDay(addDays(today, 7), cal) },
    { label: '+2 weeks', value: onOrNextWorkingDay(addDays(today, 14), cal) },
  ];
}
