import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, run, EPHEMERAL } from './db.js';
import { HttpError, nowIso, token, forbidden } from './util.js';
import { can, ROLES } from '../shared/constants.js';

const SESSION_DAYS = 14;
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sessions are rows in the database, so they can be revoked (password change, disabled user).
 * On serverless hosting each instance has its own copy of the database, so a session row written
 * by one instance is invisible to the next — there we sign the token instead and keep no state.
 * The signing key comes from CRM_TOKEN_SECRET, falling back to a digest of the bundled demo
 * snapshot, which is identical on every instance of the same deployment.
 */
function signingSecret() {
  if (process.env.CRM_TOKEN_SECRET) return process.env.CRM_TOKEN_SECRET;
  const snapshot = path.join(here, '..', 'seed', 'crm-seed.sqlite');
  if (fs.existsSync(snapshot)) {
    return crypto.createHash('sha256').update(fs.readFileSync(snapshot).subarray(0, 1 << 20)).digest('hex');
  }
  return null;
}

const SECRET = EPHEMERAL ? signingSecret() : null;
const STATELESS = Boolean(SECRET);
if (EPHEMERAL && !STATELESS) {
  console.warn('Serverless mode without CRM_TOKEN_SECRET: sign-ins will not survive across instances.');
}

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function createSession(userId) {
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), userId);
  if (STATELESS) {
    const payload = Buffer.from(JSON.stringify({ u: userId, e: expires })).toString('base64url');
    return { token: `s1.${payload}.${sign(payload)}`, expires_at: expires };
  }
  const t = token(32);
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', t, userId, nowIso(), expires);
  return { token: t, expires_at: expires };
}

export function destroySession(t) {
  if (!t?.startsWith('s1.')) run('DELETE FROM sessions WHERE token = ?', t);
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
    if (!claims?.u || !claims.e || claims.e < nowIso()) return null;
    return get('SELECT * FROM users WHERE id = ? AND active = 1', claims.u);
  }
  return get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    t, nowIso(),
  );
}

export function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...rest } = u;
  return { ...rest, scope: ROLES.find((r) => r.value === u.role)?.scope || 'own' };
}

/** Express middleware: resolves the bearer token to req.user or rejects. */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const t = header.startsWith('Bearer ') ? header.slice(7) : req.query.access_token;
  if (!t) return next(new HttpError(401, 'Sign in required'));
  const row = userForToken(String(t));
  if (!row) return next(new HttpError(401, 'Session expired, please sign in again'));
  req.user = publicUser(row);
  req.token = t;
  next();
}

/** Route guard for a permission key from shared/constants PERMISSIONS. */
export const allow = (...permissions) => (req, _res, next) => {
  if (permissions.some((p) => can(req.user.role, p))) return next();
  next(forbidden());
};
