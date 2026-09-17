import { Router } from 'express';
import { all, get, run, insert, update, tx } from '../db.js';
import { allow, hashPassword } from '../auth.js';
import { ROLES } from '../../shared/constants.js';
import { nowIso, today, fyStart, badRequest, forbidden, notFound, strOrNull, intOrNull, num, audit } from '../util.js';

const r = Router();

r.get('/users', allow('team.view'), (req, res) => {
  const rows = all(
    `SELECT u.id, u.name, u.email, u.role, u.designation, u.phone, u.branch, u.region_id, u.factory_id, u.manager_id, u.active, u.last_login_at, u.created_at,
            rg.name AS region_name, f.name AS factory_name, m.name AS manager_name,
            (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'open') AS open_leads,
            (SELECT COUNT(*) FROM customers c WHERE c.assigned_to = u.id) AS customers,
            (SELECT COUNT(*) FROM followups fu WHERE fu.assigned_to = u.id AND fu.status = 'pending' AND fu.due_date < ?) AS overdue_followups
     FROM users u LEFT JOIN regions rg ON rg.id = u.region_id LEFT JOIN factories f ON f.id = u.factory_id LEFT JOIN users m ON m.id = u.manager_id
     ${req.user.scope === 'region' ? `WHERE u.region_id = ${Number(req.user.region_id)}` : ''}
     ORDER BY u.active DESC, u.role, u.name`,
    today(),
  );
  res.json(rows);
});

function userData(b) {
  const d = {};
  for (const k of ['name', 'email', 'designation', 'phone', 'branch']) if (b[k] !== undefined) d[k] = strOrNull(b[k]);
  for (const k of ['region_id', 'factory_id', 'manager_id']) if (b[k] !== undefined) d[k] = intOrNull(b[k]);
  if (b.role !== undefined) {
    if (!ROLES.some((x) => x.value === b.role)) throw badRequest('Unknown role');
    d.role = b.role;
  }
  if (b.active !== undefined) d.active = b.active ? 1 : 0;
  if (d.email) d.email = d.email.toLowerCase();
  return d;
}

r.post('/users', allow('team.edit'), (req, res) => {
  const d = userData(req.body);
  if (!d.name || !d.email || !d.role) throw badRequest('Name, email and role are required');
  if (String(req.body.password || '').length < 8) throw badRequest('Initial password must be at least 8 characters');
  if (d.role === 'regional_manager' && !d.region_id) throw badRequest('Regional managers need a region');
  const id = insert('users', { ...d, active: 1, password_hash: hashPassword(req.body.password), created_at: nowIso() });
  audit(req.user.id, 'user', id, 'create', { email: d.email, role: d.role });
  res.status(201).json({ id });
});

r.put('/users/:id', allow('team.edit'), (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw notFound('User');
  const d = userData(req.body);
  if (u.id === req.user.id && (d.active === 0 || (d.role && d.role !== u.role))) throw forbidden('You cannot deactivate or change the role of your own account');
  tx(() => {
    update('users', u.id, d);
    if (d.active === 0) run('DELETE FROM sessions WHERE user_id = ?', u.id);
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw badRequest('Password must be at least 8 characters');
      run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), u.id);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
    }
    audit(req.user.id, 'user', u.id, 'update', { ...d, password_reset: Boolean(req.body.password) });
  });
  res.json({ ok: true });
});

/** Transfer open leads, customers and pending follow-ups when someone leaves or changes territory. */
r.post('/users/:id/transfer', allow('team.edit'), (req, res) => {
  const to = intOrNull(req.body.to_user_id);
  if (!to || to === Number(req.params.id)) throw badRequest('Choose who takes over');
  const moved = tx(() => ({
    leads: Number(run("UPDATE leads SET assigned_to = ? WHERE assigned_to = ? AND status = 'open'", to, req.params.id).changes),
    customers: Number(run('UPDATE customers SET assigned_to = ? WHERE assigned_to = ?', to, req.params.id).changes),
    followups: Number(run("UPDATE followups SET assigned_to = ? WHERE assigned_to = ? AND status = 'pending'", to, req.params.id).changes),
    quotations: Number(run("UPDATE quotations SET owner_id = ? WHERE owner_id = ? AND status NOT IN ('converted','rejected','expired')", to, req.params.id).changes),
  }));
  audit(req.user.id, 'user', Number(req.params.id), 'transfer', { to, ...moved });
  res.json(moved);
});

// ------------------------------------------------------------------ targets
r.get('/targets', allow('team.view'), (req, res) => {
  const start = req.query.fy_start || fyStart(today());
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(`${start}T00:00:00`);
    d.setMonth(d.getMonth() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const users = all(
    `SELECT u.id, u.name, u.role, rg.name AS region_name FROM users u LEFT JOIN regions rg ON rg.id = u.region_id
     WHERE u.active = 1 AND u.role IN ('sales_executive', 'regional_manager')
     ${req.user.scope === 'region' ? `AND u.region_id = ${Number(req.user.region_id)}` : ''} ORDER BY rg.name, u.name`,
  );
  const targets = all(`SELECT * FROM sales_targets WHERE month BETWEEN ? AND ?`, months[0], months[11]);
  const achieved = all(
    `SELECT sales_owner_id AS user_id, substr(order_date, 1, 7) AS month, SUM(taxable_total) AS value FROM sales_orders
     WHERE status <> 'cancelled' AND order_date BETWEEN ? AND ? GROUP BY 1, 2`,
    `${months[0]}-01`, `${months[11]}-31`,
  );
  res.json({
    months,
    users: users.map((u) => ({
      ...u,
      targets: Object.fromEntries(months.map((m) => [m, targets.find((t) => t.user_id === u.id && t.month === m)?.amount || 0])),
      achieved: Object.fromEntries(months.map((m) => [m, achieved.find((a) => a.user_id === u.id && a.month === m)?.value || 0])),
    })),
  });
});

r.put('/targets', allow('team.view'), (req, res) => {
  if (!['super_admin', 'management', 'sales_head'].includes(req.user.role)) throw forbidden('Only the Sales Head or management can set targets');
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  tx(() => {
    for (const e of entries) {
      if (!/^\d{4}-\d{2}$/.test(e.month)) continue;
      run(
        'INSERT INTO sales_targets (user_id, month, amount) VALUES (?, ?, ?) ON CONFLICT(user_id, month) DO UPDATE SET amount = excluded.amount',
        Number(e.user_id), e.month, Math.max(0, num(e.amount)),
      );
    }
  });
  audit(req.user.id, 'targets', null, 'update', { entries: entries.length });
  res.json({ ok: true });
});

export default r;
