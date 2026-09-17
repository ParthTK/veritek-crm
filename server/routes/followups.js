import { Router } from 'express';
import { all, get, run, insert, update } from '../db.js';
import { allow } from '../auth.js';
import { roleRank } from '../../shared/constants.js';
import { today, addDays, nowIso, badRequest, forbidden, notFound, strOrNull, intOrNull, whereClause } from '../util.js';
import { assertCustomer, assertLead, customerScope, redact } from '../access.js';
import { logActivity } from '../services/leads.js';
import { computeReminders } from '../services/automation.js';

const r = Router();

r.post('/activities', allow('activities.edit', 'leads.edit'), (req, res) => {
  if (req.body.lead_id) assertLead(req.user, req.body.lead_id);
  else if (req.body.customer_id) assertCustomer(req.user, req.body.customer_id);
  const id = logActivity(req.body, req.user);
  res.status(201).json({ id });
});

r.get('/activities', (req, res) => {
  const q = req.query;
  const w = [customerScope(req.user, 'c')];
  const p = [];
  for (const k of ['customer_id', 'lead_id', 'quotation_id', 'order_id', 'complaint_id', 'type', 'created_by']) {
    if (q[k]) {
      w.push(`a.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.mine === '1') w.push(`a.created_by = ${req.user.id}`);
  const rows = all(
    `SELECT a.*, c.name AS customer_name, ct.name AS contact_name, u.name AS user_name, l.code AS lead_code
     FROM activities a JOIN customers c ON c.id = a.customer_id LEFT JOIN contacts ct ON ct.id = a.contact_id
     LEFT JOIN users u ON u.id = a.created_by LEFT JOIN leads l ON l.id = a.lead_id
     ${whereClause(w)} ORDER BY a.activity_date DESC LIMIT ?`,
    ...p, Math.min(Number(q.limit) || 100, 500),
  );
  res.json(rows);
});

/** Who's follow-ups the user may see: their own, or their team's for managers. */
function followupScope(user, view) {
  if (view === 'mine' || roleRank(user.role) < 2) return `f.assigned_to = ${Number(user.id)}`;
  if (user.scope === 'region') return `(f.assigned_to = ${Number(user.id)} OR f.assigned_to IN (SELECT id FROM users WHERE region_id = ${Number(user.region_id)}))`;
  return '';
}

r.get('/followups', (req, res) => {
  const q = req.query;
  const t = today();
  const w = [followupScope(req.user, q.view || 'mine')];
  const p = [];
  const status = q.status || 'pending';
  if (status !== 'all') {
    w.push('f.status = ?');
    p.push(status);
  }
  if (q.bucket === 'overdue') w.push(`f.due_date < '${t}'`);
  if (q.bucket === 'today') w.push(`f.due_date = '${t}'`);
  if (q.bucket === 'upcoming') w.push(`f.due_date > '${t}'`);
  if (q.bucket === 'week') w.push(`f.due_date BETWEEN '${t}' AND '${addDays(t, 7)}'`);
  if (q.type) {
    w.push('f.type = ?');
    p.push(q.type);
  }
  if (q.assigned_to) {
    w.push('f.assigned_to = ?');
    p.push(q.assigned_to);
  }
  if (q.customer_id) {
    w.push('f.customer_id = ?');
    p.push(q.customer_id);
  }
  const rows = all(
    `SELECT f.*, c.name AS customer_name, u.name AS owner_name, l.code AS lead_code, l.title AS lead_title, l.stage AS lead_stage, l.temperature,
            l.estimated_value, q.number AS quotation_number, o.number AS order_number, i.number AS invoice_number,
            k.number AS complaint_number, cb.name AS completed_by_name,
            (SELECT ct.name FROM contacts ct WHERE ct.customer_id = f.customer_id ORDER BY ct.is_primary DESC LIMIT 1) AS contact_name,
            (SELECT ct.phone FROM contacts ct WHERE ct.customer_id = f.customer_id ORDER BY ct.is_primary DESC LIMIT 1) AS contact_phone,
            (SELECT ct.whatsapp FROM contacts ct WHERE ct.customer_id = f.customer_id ORDER BY ct.is_primary DESC LIMIT 1) AS contact_whatsapp
     FROM followups f
     LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN users u ON u.id = f.assigned_to LEFT JOIN leads l ON l.id = f.lead_id
     LEFT JOIN quotations q ON q.id = f.quotation_id LEFT JOIN sales_orders o ON o.id = f.order_id LEFT JOIN invoices i ON i.id = f.invoice_id
     LEFT JOIN complaints k ON k.id = f.complaint_id LEFT JOIN users cb ON cb.id = f.completed_by
     ${whereClause(w)}
     ORDER BY ${status === 'pending' ? "f.due_date ASC, f.priority = 'high' DESC" : 'f.completed_at DESC'} LIMIT ?`,
    ...p, Math.min(Number(q.limit) || 300, 1000),
  );
  const counts = get(
    `SELECT SUM(f.due_date < ?) AS overdue, SUM(f.due_date = ?) AS today, SUM(f.due_date > ?) AS upcoming, COUNT(*) AS pending
     FROM followups f WHERE f.status = 'pending' ${followupScope(req.user, q.view || 'mine') ? `AND ${followupScope(req.user, q.view || 'mine')}` : ''}`,
    t, t, t,
  );
  res.json(redact(req.user, { rows, counts }));
});

r.post('/followups', (req, res) => {
  const b = req.body;
  if (!strOrNull(b.title)) throw badRequest('What needs to be done?');
  if (!strOrNull(b.due_date)) throw badRequest('Set a due date');
  if (b.customer_id) assertCustomer(req.user, b.customer_id);
  const assignee = intOrNull(b.assigned_to) || req.user.id;
  if (assignee !== req.user.id && roleRank(req.user.role) < 2 && !['commercial', 'accounts'].includes(req.user.role)) {
    throw forbidden('You can only create follow-ups for yourself');
  }
  const id = insert('followups', {
    title: strOrNull(b.title), type: b.type || 'call', customer_id: intOrNull(b.customer_id), lead_id: intOrNull(b.lead_id),
    quotation_id: intOrNull(b.quotation_id), order_id: intOrNull(b.order_id), invoice_id: intOrNull(b.invoice_id), complaint_id: intOrNull(b.complaint_id),
    assigned_to: assignee, due_date: b.due_date, priority: b.priority || 'normal', status: 'pending', notes: strOrNull(b.notes),
    created_by: req.user.id, created_at: nowIso(),
  });
  res.status(201).json({ id });
});

function assertFollowupAccess(user, f) {
  if (!f) throw notFound('Follow-up');
  if (f.assigned_to === user.id || f.created_by === user.id) return;
  if (roleRank(user.role) >= 3) return;
  if (user.role === 'regional_manager') {
    const owner = get('SELECT region_id FROM users WHERE id = ?', f.assigned_to);
    if (owner?.region_id === user.region_id) return;
  }
  throw forbidden('This follow-up belongs to someone else');
}

r.put('/followups/:id', (req, res) => {
  const f = get('SELECT * FROM followups WHERE id = ?', req.params.id);
  assertFollowupAccess(req.user, f);
  const patch = {};
  for (const k of ['title', 'due_date', 'priority', 'notes', 'type']) if (req.body[k] !== undefined) patch[k] = strOrNull(req.body[k]);
  if (req.body.assigned_to !== undefined) {
    if (roleRank(req.user.role) < 2) throw forbidden('Only managers can reassign follow-ups');
    patch.assigned_to = intOrNull(req.body.assigned_to);
  }
  if (patch.due_date && f.lead_id && f.auto_key === `lead:${f.lead_id}`) {
    run('UPDATE leads SET next_follow_up_date = ? WHERE id = ?', patch.due_date, f.lead_id);
    if (patch.title) run('UPDATE leads SET next_action = ? WHERE id = ?', patch.title, f.lead_id);
  }
  if (patch.due_date && patch.due_date !== f.due_date) patch.escalated_at = null;
  update('followups', f.id, patch);
  res.json({ ok: true });
});

r.post('/followups/:id/complete', (req, res) => {
  const f = get('SELECT * FROM followups WHERE id = ?', req.params.id);
  assertFollowupAccess(req.user, f);
  if (f.status !== 'pending') throw badRequest('Follow-up is already closed');
  if (f.lead_id && f.auto_key === `lead:${f.lead_id}`) {
    const lead = get('SELECT status FROM leads WHERE id = ?', f.lead_id);
    if (lead?.status === 'open') throw badRequest('Log the interaction with a next action to close a lead follow-up');
  }
  const status = req.body.cancel ? 'cancelled' : 'done';
  update('followups', f.id, { status, completed_at: nowIso(), completed_by: req.user.id, outcome: strOrNull(req.body.outcome) });
  res.json({ ok: true });
});

r.get('/reminders', (req, res) => {
  const mine = req.query.view !== 'team' || roleRank(req.user.role) < 2;
  res.json(redact(req.user, computeReminders(req.user, { mine })));
});

export default r;
