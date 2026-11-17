import crypto from 'node:crypto';
import fs from 'node:fs';
import { get, run, EPHEMERAL, SNAPSHOT } from './db.js';
import { HttpError, forbidden, nowIso, now, settings, sha256, token } from './util.js';
import { can, permissionsFor, groupOf, scopeOf } from '../shared/constants.js';

const IDLE_HOURS = 10;
const ABSOLUTE_DAYS = 7;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

/**
 * Sessions are rows keyed by a hash of the token, so they can be revoked (password change, deactivation)
 * and a leaked database does not leak live tokens. On serverless hosting each instance has its own copy
 * of the database, so there the token is signed instead (CRM_TOKEN_SECRET) and carries its own expiry.
 */
function signingSecret() {
  if (process.env.CRM_TOKEN_SECRET) return process.env.CRM_TOKEN_SECRET;
  if (fs.existsSync(SNAPSHOT)) return sha256(fs.readFileSync(SNAPSHOT).subarray(0, 1 << 20));
  return null;
}
const SECRET = EPHEMERAL ? signingSecret() : null;
const STATELESS = Boolean(SECRET);
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

// ------------------------------------------------------------------ passwords
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Password policy: at least 8 characters with a letter and a number, and not the email address. */
export function passwordProblem(password, email) {
  const p = String(password || '');
  if (p.length < 8) return 'Use at least 8 characters';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Include at least one letter and one number';
  if (email && p.toLowerCase() === String(email).toLowerCase()) return 'The password cannot be your email address';
  return null;
}

// ------------------------------------------------------------------ TOTP (optional MFA for admins)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[Number.parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s) {
  let bits = '';
  for (const c of String(s).replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret, timeMs = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString();
  return code.padStart(6, '0');
}
export function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return false;
  const t = Date.now();
  return [-1, 0, 1].some((w) => totp(secret, t + w * 30000) === c);
}

// ------------------------------------------------------------------ sessions
export function createSession(userId) {
  const created = now();
  const expires = new Date(created.getTime() + ABSOLUTE_DAYS * 86400000).toISOString();
  run('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', nowIso(), userId);
  if (STATELESS) {
    const payload = Buffer.from(JSON.stringify({ u: userId, e: new Date(created.getTime() + IDLE_HOURS * 3600000).toISOString() })).toString('base64url');
    return { token: `s1.${payload}.${sign(payload)}`, expires_at: expires };
  }
  const t = token(32);
  run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', sha256(t), userId, created.toISOString(), expires, created.toISOString());
  return { token: t, expires_at: expires };
}

export function destroySession(t) {
  if (t && !t.startsWith('s1.')) run('DELETE FROM sessions WHERE token_hash = ?', sha256(t));
}

export function destroyUserSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function userForToken(t) {
  if (t.startsWith('s1.')) {
    if (!STATELESS) return null;
    const [, payload, signature] = t.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      return null;
    }
    if (!claims?.u || !claims.e || claims.e < new Date().toISOString()) return null;
    return get('SELECT * FROM users WHERE id = ? AND active = 1 AND login_enabled = 1', claims.u);
  }
  const hash = sha256(t);
  const row = get(
    `SELECT u.*, s.last_seen_at AS session_seen, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND u.active = 1 AND u.login_enabled = 1`,
    hash,
  );
  if (!row) return null;
  const nowMs = Date.now();
  if (row.session_expires < new Date(nowMs).toISOString() || nowMs - Date.parse(row.session_seen) > IDLE_HOURS * 3600000) {
    run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  if (nowMs - Date.parse(row.session_seen) > 5 * 60000) run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', new Date(nowMs).toISOString(), hash);
  return row;
}

/** Whether a shop-floor user may see commercial values (role default, per-user grant or global setting). */
export function seesValues(u) {
  if (can(u.role, 'values.view')) return true;
  return ['production', 'service'].includes(groupOf(u.role)) && (Boolean(u.values_access) || Boolean(settings().access.productionSeesValues));
}

export function publicUser(u) {
  if (!u) return null;
  const values = seesValues(u);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    group: groupOf(u.role),
    scope: scopeOf(u.role),
    region_id: u.region_id ?? null,
    factory_id: u.factory_id ?? null,
    department: u.department,
    must_change_password: Boolean(u.must_change_password),
    mfa_enabled: Boolean(u.mfa_enabled),
    values_access: values,
    permissions: [...permissionsFor(u.role), ...(values && !can(u.role, 'values.view') ? ['values.view'] : [])],
  };
}

// ------------------------------------------------------------------ login
export function login(email, password, mfaCode) {
  const u = get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', String(email || '').trim());
  const generic = new HttpError(401, 'Email or password is incorrect');
  if (!u || !u.login_enabled || !u.password_hash) {
    verifyPassword(password, 'scrypt$00$00'); // equalise timing
    throw generic;
  }
  if (!u.active) throw new HttpError(401, 'This account has been deactivated. Ask an administrator.');
  if (u.locked_until && u.locked_until > new Date().toISOString()) {
    throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!verifyPassword(password, u.password_hash)) {
    const failed = (u.failed_logins || 0) + 1;
    const lock = failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : failed, lock, u.id);
    throw generic;
  }
  if (u.mfa_enabled) {
    if (!mfaCode) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', { mfa_required: true });
    if (!verifyTotp(u.mfa_secret, mfaCode)) throw new HttpError(401, 'That code did not match. Try the current code.', { mfa_required: true });
  }
  const session = createSession(u.id);
  return { ...session, user: publicUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
}

// ------------------------------------------------------------------ middleware
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const t = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!t) return next(new HttpError(401, 'Sign in required'));
  const row = userForToken(t);
  if (!row) return next(new HttpError(401, 'Your session has ended. Please sign in again.'));
  req.user = { ...publicUser(row), raw: row };
  req.token = t;
  next();
}

/** Route guard: the user needs at least one of the listed permissions. */
export const allow = (...permissions) => (req, _res, next) => {
  if (permissions.some((p) => req.user.permissions.includes(p))) return next();
  next(forbidden());
};

export function hasPerm(user, permission) {
  return user.permissions.includes(permission);
}

export function assertPerm(user, permission, message) {
  if (!hasPerm(user, permission)) throw forbidden(message);
}
