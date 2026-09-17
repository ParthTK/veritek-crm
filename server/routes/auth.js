import { Router } from 'express';
import { get, run } from '../db.js';
import { badRequest, HttpError } from '../util.js';
import { verifyPassword, createSession, destroySession, requireAuth, publicUser, hashPassword } from '../auth.js';
import { PERMISSIONS } from '../../shared/constants.js';

const r = Router();

const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60000);
  if (list.length >= 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
  list.push(now);
  attempts.set(key, list);
}

export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));
}

function withContext(user) {
  const region = user.region_id ? get('SELECT name FROM regions WHERE id = ?', user.region_id)?.name : null;
  const factory = user.factory_id ? get('SELECT name FROM factories WHERE id = ?', user.factory_id)?.name : null;
  return { ...user, region_name: region, factory_name: factory, permissions: permissionsFor(user.role) };
}

r.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !req.body.password) throw badRequest('Enter your email and password');
  throttle(`${req.ip}:${email}`);
  const user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(req.body.password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  if (!user.active) throw new HttpError(403, 'Your account is disabled. Contact the administrator.');
  attempts.delete(`${req.ip}:${email}`);
  const session = createSession(user.id);
  res.json({ ...session, user: withContext(publicUser(user)) });
});

r.post('/logout', requireAuth, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

r.get('/me', requireAuth, (req, res) => {
  res.json(withContext(req.user));
});

r.post('/password', requireAuth, (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(req.body.current || '', user.password_hash)) throw badRequest('Current password is incorrect');
  if (String(req.body.next || '').length < 8) throw badRequest('New password must be at least 8 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.next), user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', user.id, req.token);
  res.json({ ok: true });
});

export default r;
