import { Router } from 'express';
import { get, run } from '../db.js';
import { Check, HttpError, audit, nowIso, str, withContext } from '../util.js';
import {
  login, requireAuth, destroySession, destroyUserSessions, createSession, hashPassword, verifyPassword, passwordProblem, publicUser, newTotpSecret, verifyTotp,
} from '../auth.js';
import { h } from './helpers.js';

const r = Router();

r.post('/auth/login', h((req) => {
  const res = login(req.body?.email, req.body?.password, req.body?.mfa_code);
  withContext({ userId: res.user.id, source: 'web', ip: req.ip }, () => audit('user', res.user.id, 'sign_in', {}));
  return res;
}));

r.get('/auth/me', requireAuth, h((req) => publicUser(req.user.raw)));

// Public and says nothing about the installation: lets a monitor (or the tests) see that the server is up.
r.get('/auth/info', h(() => ({ ok: true })));

r.post('/auth/logout', requireAuth, h((req) => {
  destroySession(req.token);
  return { ok: true };
}));

r.post('/auth/password', requireAuth, h((req) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const c = new Check();
  if (!verifyPassword(req.body?.current, u.password_hash)) c.fail('current', 'Your current password is not correct');
  const problem = passwordProblem(req.body?.next, u.email);
  if (problem) c.fail('next', problem);
  if (req.body?.next && req.body.next === req.body.current) c.fail('next', 'Choose a different password');
  c.throwIfAny();
  run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hashPassword(req.body.next), nowIso(), u.id);
  destroyUserSessions(u.id);
  withContext({ userId: u.id, source: 'web' }, () => audit('user', u.id, 'password_change', {}));
  const session = createSession(u.id);
  return { ...session, user: publicUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
}));

r.post('/auth/mfa/setup', requireAuth, h((req) => {
  const secret = newTotpSecret();
  const label = encodeURIComponent(`Veritek CRM:${req.user.email}`);
  return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Veritek%20CRM&digits=6&period=30` };
}));

r.post('/auth/mfa/enable', requireAuth, h((req) => {
  const secret = str(req.body?.secret, 64);
  if (!secret || !verifyTotp(secret, req.body?.code)) throw new HttpError(400, 'That code did not match. Check the time on your phone and try the current code.', { fields: { code: 'Code did not match' } });
  run('UPDATE users SET mfa_secret = ?, mfa_enabled = 1, updated_at = ? WHERE id = ?', secret, nowIso(), req.user.id);
  withContext({ userId: req.user.id }, () => audit('user', req.user.id, 'mfa_enable', {}));
  return { ok: true };
}));

r.post('/auth/mfa/disable', requireAuth, h((req) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(req.body?.password, u.password_hash)) throw new HttpError(400, 'Password is not correct', { fields: { password: 'Not correct' } });
  run('UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, updated_at = ? WHERE id = ?', nowIso(), u.id);
  withContext({ userId: u.id }, () => audit('user', u.id, 'mfa_disable', {}));
  return { ok: true };
}));

export default r;
