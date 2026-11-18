import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { all, get, run, insert } from './db.js';
import { DEFAULT_SETTINGS } from '../shared/constants.js';
import { localDate, isDate, isInstant, isTime } from '../shared/dates.js';
import { round3 } from '../shared/rules.js';

// ------------------------------------------------------------------ errors
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
/** 400 with field-level messages the form can show next to each input. */
export const badRequest = (message, fields) => new HttpError(400, message, fields ? { fields } : undefined);
export const conflict = (message, details) => new HttpError(409, message, details);
export const forbidden = (message = 'You do not have permission for this action') => new HttpError(403, message);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

// ------------------------------------------------------------------ request context
// Carries the acting user, request id and source into services so audit rows are complete.
export const context = new AsyncLocalStorage();
export const ctx = () => context.getStore() || {};
export function withContext(values, fn) {
  return context.run({ ...ctx(), ...values }, fn);
}

// ------------------------------------------------------------------ clock
// The demo-data generator pins the clock; otherwise it is real time.
let pinned = null;
export function setClock(value) {
  pinned = value ? new Date(value).getTime() : null;
}
export const now = () => (pinned !== null ? new Date(pinned) : new Date());
export function nowIso() {
  if (pinned === null) return new Date().toISOString();
  pinned += 1000; // keep simulated events strictly ordered
  return new Date(pinned).toISOString();
}

// ------------------------------------------------------------------ settings
let settingsCache = null;
function loadSettings() {
  const stored = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) out[k] = { ...def, ...(stored[k] || {}) };
  return out;
}
export function settings() {
  if (!settingsCache) settingsCache = loadSettings();
  return settingsCache;
}
export function setSetting(key, value, userId) {
  run(
    'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    key, JSON.stringify(value), nowIso(), userId ?? null,
  );
  settingsCache = null;
}
export const resetSettingsCache = () => {
  settingsCache = null;
};
export const tz = () => settings().calendar.timezone || 'Asia/Kolkata';
export const calendar = () => settings().calendar;
export const today = () => localDate(now(), tz());

// ------------------------------------------------------------------ validation
/** Collects field errors and throws one 400 with all of them, so the form can mark every field at once. */
export class Check {
  constructor() {
    this.fields = {};
  }

  fail(field, message) {
    if (!this.fields[field]) this.fields[field] = message;
    return this;
  }

  required(field, value, message = 'Required') {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) this.fail(field, message);
    return this;
  }

  date(field, value, { required = false, message } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.fail(field, message || 'Choose a date');
    } else if (!isDate(value)) this.fail(field, 'Use a valid date (YYYY-MM-DD)');
    return this;
  }

  time(field, value) {
    if (value && !isTime(value)) this.fail(field, 'Use a valid time (HH:MM)');
    return this;
  }

  instant(field, value, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required) this.fail(field, 'Required');
    } else if (!isInstant(value)) this.fail(field, 'Use a valid date and time');
    return this;
  }

  text(field, value, { max = 200, min = 0, required = false, label = 'This field' } = {}) {
    const s = value === undefined || value === null ? '' : String(value).trim();
    if (!s) {
      if (required) this.fail(field, `${label} is required`);
    } else if (s.length < min) this.fail(field, `${label} needs at least ${min} characters`);
    else if (s.length > max) this.fail(field, `${label} must be ${max} characters or fewer`);
    return this;
  }

  note(field, value, { required = false, requiredMessage } = {}) {
    const max = settings().rules.noteMaxLength || 1000;
    const s = value === undefined || value === null ? '' : String(value).trim();
    if (!s && required) this.fail(field, requiredMessage || 'Add a short note');
    if (s.length > max) this.fail(field, `Keep notes under ${max.toLocaleString('en-IN')} characters — attach longer documents instead`);
    return this;
  }

  positive(field, value, { required = true, label = 'Quantity', allowUnknown = false } = {}) {
    if (value === undefined || value === null || value === '') {
      if (required && !allowUnknown) this.fail(field, `${label} is required`);
      return this;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) this.fail(field, `${label} must be greater than zero`);
    return this;
  }

  get ok() {
    return !Object.keys(this.fields).length;
  }

  throwIfAny(message = 'Please correct the highlighted fields') {
    if (!this.ok) throw badRequest(message, this.fields);
  }
}

export const str = (v, max = 2000) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
export const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
export const qty = (v) => (num(v) === null ? null : round3(num(v)));
export const intId = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
export function parseJson(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ dropdown values
let dropdownCache = null;
export function dropdowns() {
  if (!dropdownCache) {
    dropdownCache = {};
    for (const r of all('SELECT * FROM dropdown_options ORDER BY category, sort_order, id')) {
      (dropdownCache[r.category] ||= []).push(r);
    }
  }
  return dropdownCache;
}
export const resetDropdownCache = () => {
  dropdownCache = null;
};
export function optionLabel(category, code) {
  if (!code) return null;
  return dropdowns()[category]?.find((o) => o.code === code)?.label || String(code).replace(/_/g, ' ');
}
/** Validates a dropdown code: it must exist and be active for new selections; "Other"-type values need a note. */
export function checkOption(check, field, category, code, { required = true, note, noteField = 'note', allowInactive = false } = {}) {
  if (!code) {
    if (required) check.fail(field, 'Choose an option');
    return null;
  }
  const opt = dropdowns()[category]?.find((o) => o.code === code);
  if (!opt || (!opt.active && !allowInactive)) {
    check.fail(field, 'Choose a value from the list');
    return null;
  }
  if (opt.requires_note && !str(note)) check.fail(noteField, `Add a short note for "${opt.label}"`);
  return opt;
}

// ------------------------------------------------------------------ normalisation & matching
const LEGAL_WORDS = /\b(pvt|private|ltd|limited|llc|llp|inc|incorporated|corp|corporation|co|company|fze|fzc|fzco|plc|gmbh|the|and|est|establishment|trading|enterprises|enterprise|industries|intl|international)\b/g;
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function normEmail(s) {
  const e = String(s || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
const DIAL = {
  IN: '91', AE: '971', SA: '966', OM: '968', QA: '974', KW: '965', BH: '973', KE: '254', NG: '234', TZ: '255', EG: '20', ZA: '27',
  BD: '880', LK: '94', NP: '977', SG: '65', MY: '60', GB: '44', US: '1', DE: '49',
};
/** International format when the country is known; digits only (no guessed code) when it is not. */
export function normPhone(raw, country) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 6) return null;
  if (s.startsWith('+') || s.startsWith('00')) return `+${digits}`;
  const cc = DIAL[country];
  if (!cc) return digits;
  digits = digits.replace(/^0+/, '');
  if (digits.startsWith(cc) && digits.length > cc.length + 7) return `+${digits}`;
  return `+${cc}${digits}`;
}
/** Phone keys for matching regardless of how the number was typed (last 9 digits). */
export const phoneKey = (norm) => (norm ? norm.replace(/\D/g, '').slice(-9) : null);

function bigrams(s) {
  const t = ` ${s} `;
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
/** Dice similarity of two normalised names (0..1). */
export function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) || 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

// ------------------------------------------------------------------ codes
/** Readable sequential codes: CUS-0042, ENQ-1288, Q-2041, SO-1042. Immutable once issued. */
export function nextCode(prefix, width = 4) {
  const n = get('INSERT INTO counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = counters.value + 1 RETURNING value', prefix).value;
  return `${prefix}-${String(n).padStart(width, '0')}`;
}
export function setCounter(prefix, value) {
  run('INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', prefix, value);
}

export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A per-installation secret kept in the database (created once), for signing short-lived public tokens. */
let installSecretCache = null;
export function installSecret() {
  if (process.env.CRM_TOKEN_SECRET) return process.env.CRM_TOKEN_SECRET;
  if (installSecretCache) return installSecretCache;
  let row = get("SELECT value FROM settings WHERE key = 'install_secret'");
  if (!row) {
    run("INSERT INTO settings (key, value) VALUES ('install_secret', ?) ON CONFLICT DO NOTHING", JSON.stringify(token(32)));
    row = get("SELECT value FROM settings WHERE key = 'install_secret'");
  }
  installSecretCache = JSON.parse(row.value);
  return installSecretCache;
}

// ------------------------------------------------------------------ audit & history
const SECRET_KEYS = /password|secret|token|mfa/i;
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[protected]' : scrub(v);
    return out;
  }
  return value;
}

/** Technical audit trail: actor, server time, source, request id and changed fields (secrets protected). */
export function audit(entityType, entityId, action, changes) {
  const c = ctx();
  insert('audit_events', {
    entity_type: entityType,
    entity_id: entityId ?? null,
    action,
    actor_id: c.userId ?? null,
    source: c.source || 'system',
    request_id: c.requestId || null,
    changes: changes ? JSON.stringify(scrub(changes)) : null,
    ip: c.ip || null,
    created_at: nowIso(),
  });
}

/** Business history shown on records (stage changes, merges, reopenings…). */
export function history(entityType, entityId, kind, { customerId, data, note, occurredAt } = {}) {
  insert('history_events', {
    entity_type: entityType,
    entity_id: entityId,
    customer_id: customerId ?? null,
    kind,
    data: data ? JSON.stringify(data) : null,
    note: note ?? null,
    actor_id: ctx().userId ?? null,
    occurred_at: occurredAt ?? null,
    created_at: nowIso(),
  });
}

/** { field: [before, after] } for the fields that actually changed. */
export function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before?.[f] ?? null;
    const b = after?.[f] ?? null;
    if (String(a) !== String(b)) out[f] = [a, b];
  }
  return out;
}

/** Notify a user in-app. A dedupe key makes the notification idempotent per user. */
export function notify(userId, { title, message, link, severity = 'info', dedupeKey, alertId }) {
  if (!userId) return 0;
  const res = run(
    `INSERT INTO notifications (user_id, alert_id, title, message, link, severity, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    userId, alertId ?? null, title, message ?? null, link ?? null, severity, dedupeKey ?? null, nowIso(),
  );
  return Number(res.changes);
}

/** Notify every active user holding one of the roles (dedupe key per user keeps it idempotent). */
export function notifyRoles(roles, payload) {
  const ids = all(`SELECT id FROM users WHERE active = 1 AND login_enabled = 1 AND role IN (${roles.map(() => '?').join(', ')})`, ...roles).map((u) => u.id);
  let n = 0;
  for (const id of ids) n += notify(id, payload);
  return n;
}

// ------------------------------------------------------------------ listing helpers
export function paginate(query, { max = 500, fallback = 50 } = {}) {
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || fallback, 1), max);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}
export function whereSql(parts) {
  const clean = parts.filter(Boolean);
  return clean.length ? `WHERE ${clean.join(' AND ')}` : '';
}
export function sortSql(query, allowed, fallback) {
  const col = allowed[query.sort];
  if (!col) return `ORDER BY ${fallback}`;
  return `ORDER BY ${col} ${String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
}
/** SQL for an invoice's outstanding balance: gross − advance adjusted − valid receipts, TDS, deductions and credits. */
export const outstandingSql = (alias = 'i') => `(${alias}.gross_minor - ${alias}.advance_adjusted_minor - (SELECT COALESCE(SUM(r.amount_minor + r.tds_minor + r.other_deduction_minor), 0) FROM receipts r WHERE r.invoice_id = ${alias}.id AND r.reversed_at IS NULL))`;

export const likeTerm = (q) => `%${String(q).trim().replace(/[%_]/g, '')}%`;
export const placeholders = (arr) => arr.map(() => '?').join(', ');
