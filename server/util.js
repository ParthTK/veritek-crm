import crypto from 'node:crypto';
import { get, run, all, insert } from './db.js';
import { ROLES } from '../shared/constants.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have access to this action') => new HttpError(403, msg);

// ------------------------------------------------------------------ dates
const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// The clock can be pinned (used by the demo-data simulation); otherwise it is real time.
let clock = null;
export function setClock(value) {
  clock = value ? new Date(value) : null;
}
export const now = () => (clock ? new Date(clock) : new Date());
export const today = () => fmtDate(now());
export function nowIso() {
  if (!clock) return new Date().toISOString();
  clock = new Date(clock.getTime() + 7000); // keep simulated events strictly ordered
  return clock.toISOString();
}
export function addDays(dateStr, days) {
  const d = dateStr ? new Date(`${dateStr.slice(0, 10)}T00:00:00`) : now();
  d.setDate(d.getDate() + Number(days || 0));
  return fmtDate(d);
}
export function daysBetween(a, b) {
  const da = new Date(`${String(a).slice(0, 10)}T00:00:00`);
  const dbb = new Date(`${String(b).slice(0, 10)}T00:00:00`);
  return Math.round((dbb - da) / 86400000);
}
export const monthKey = (dateStr) => String(dateStr).slice(0, 7);

/** Indian financial year label for a date, e.g. 2026-09-17 -> "26-27". */
export function fyLabel(dateStr = today()) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}
export function fyStart(dateStr = today()) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

// ------------------------------------------------------------------ numbers
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const num = (v, fallback = 0) => {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number.parseInt(v, 10) || null);
export const strOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/** Sequential document numbers per prefix and financial year: QT/26-27/0042 */
export function nextNumber(prefix, dateStr = today()) {
  const fy = fyLabel(dateStr);
  const key = `${prefix}/${fy}`;
  run('INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1', key);
  const n = get('SELECT value FROM counters WHERE key = ?', key).value;
  return `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
}

export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// ------------------------------------------------------------------ audit & notifications
export function audit(userId, entity, entityId, action, details) {
  insert('audit_log', { user_id: userId ?? null, entity, entity_id: entityId ?? null, action, details: details ?? null, created_at: nowIso() });
}

/**
 * Notify users. `to` may be a user id, an array of ids, or { roles: [...] }.
 * A dedupeKey makes the notification idempotent per user.
 */
export function notify(to, { type, title, message, link, severity = 'info', dedupeKey }) {
  let ids = [];
  if (Array.isArray(to)) ids = to;
  else if (to && typeof to === 'object' && to.roles) {
    ids = all(`SELECT id FROM users WHERE active = 1 AND role IN (${to.roles.map(() => '?').join(',')})`, to.roles).map((u) => u.id);
  } else if (to) ids = [to];
  const unique = [...new Set(ids.filter(Boolean))];
  let created = 0;
  for (const userId of unique) {
    const res = run(
      `INSERT OR IGNORE INTO notifications (user_id, type, title, message, link, severity, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, type, title, message ?? null, link ?? null, severity, dedupeKey ?? null, nowIso(),
    );
    created += Number(res.changes);
  }
  return created;
}

export const roleLabel = (role) => ROLES.find((r) => r.value === role)?.label || role;

/** Managers who should hear about a salesperson's items: direct manager, regional manager of region, sales heads. */
export function managersOf(userId) {
  const u = get('SELECT id, manager_id, region_id FROM users WHERE id = ?', userId);
  const ids = new Set();
  if (u?.manager_id) ids.add(u.manager_id);
  if (u?.region_id) {
    for (const m of all("SELECT id FROM users WHERE role = 'regional_manager' AND region_id = ? AND active = 1", u.region_id)) ids.add(m.id);
  }
  ids.delete(userId);
  return [...ids];
}

export function parseJson(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

/** Build a "WHERE a AND b" clause from optional fragments. */
export function whereClause(parts) {
  const clean = parts.filter(Boolean);
  return clean.length ? `WHERE ${clean.join(' AND ')}` : '';
}

export function paginate(query) {
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || 50, 1), 500);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}

export function sortClause(query, allowed, fallback) {
  const key = query.sort;
  const col = allowed[key];
  if (!col) return `ORDER BY ${fallback}`;
  const dir = String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${dir} NULLS LAST`;
}
