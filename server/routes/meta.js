import { Router } from 'express';
import { all, get, run } from '../db.js';
import { now, today, tz, settings, dropdowns, intId, nowIso, forbidden, notFound } from '../util.js';
import { ENV } from '../db.js';
import { allow, hasPerm } from '../auth.js';
import { globalSearch } from '../services/queue.js';
import { listAlerts, acknowledgeAlert } from '../services/alerts.js';
import { activePeople } from '../services/people.js';
import { assertCustomer, assertOrder } from '../access.js';
import { h } from './helpers.js';

const r = Router();

r.get('/meta', h((req) => {
  const s = settings();
  return {
    user: req.user,
    env: ENV,
    now: now().toISOString(),
    today: today(),
    timezone: tz(),
    settings: {
      modules: s.modules, company: s.company, calendar: s.calendar, rules: s.rules, reminders: s.reminders, quotation: s.quotation, objects: s.objects,
      approvals: { enabled: s.approvals.enabled, discountManagerPct: s.approvals.discountManagerPct, discountHeadPct: s.approvals.discountHeadPct, minMarginPct: s.approvals.minMarginPct, requireBeforeIssue: s.approvals.requireBeforeIssue },
      access: { salesScope: s.access.salesScope, coordinatorMode: s.access.coordinatorMode, dncPolicy: s.access.dncPolicy, autoAssignEnquiries: s.access.autoAssignEnquiries }, finance: s.finance,
    },
    dropdowns: Object.fromEntries(Object.entries(dropdowns()).map(([k, v]) => [k, v.map((o) => ({ code: o.code, label: o.label, active: Boolean(o.active), requires_note: Boolean(o.requires_note) }))])),
    products: all(`SELECT id, code, name, model, family, category_id, default_unit, integer_qty, spec_hint, hsn, gst_rate, price_currency,
        standard_price_minor, dealer_price_minor, distributor_price_minor, lead_time_days, stock_type, active,
        (SELECT COUNT(*) FROM product_options po WHERE po.product_id = products.id AND po.active = 1) AS option_count
      FROM products ORDER BY active DESC, family, code`),
    families: all('SELECT DISTINCT family FROM products WHERE family IS NOT NULL ORDER BY family').map((f) => f.family),
    categories: all('SELECT id, name, active FROM product_categories ORDER BY sort_order, name'),
    regions: all('SELECT id, name, active FROM regions ORDER BY sort_order, name'),
    factories: all('SELECT id, name, location, active FROM factories ORDER BY name'),
    tags: all('SELECT id, name, color FROM tags ORDER BY name'),
    campaigns: all("SELECT id, name, type, start_date, end_date, status FROM campaigns ORDER BY COALESCE(start_date, created_at) DESC"),
    people: activePeople(),
  };
}));

r.get('/search', h((req) => globalSearch(req.query.q, req.user)));

r.get('/notifications', h((req) => {
  const rows = all(`SELECT * FROM notifications WHERE user_id = ? ${req.query.unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, req.user.id, Math.min(Number(req.query.limit) || 40, 200));
  const unread = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).n;
  return { rows, unread };
}));

r.post('/notifications/read', h((req) => {
  const ids = (req.body?.ids || []).map(intId).filter(Boolean);
  if (ids.length) run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, nowIso(), req.user.id, ...ids);
  else run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  return { ok: true };
}));

// Managers pin important customers and orders to the top of their overview.
r.post('/pins', allow('pins.manage'), h((req) => {
  const type = req.body?.entity_type;
  const id = intId(req.body?.entity_id);
  if (!['customer', 'order'].includes(type) || !id) throw notFound('Record');
  if (type === 'customer') assertCustomer(req.user, id);
  else assertOrder(req.user, id);
  if (req.body?.pinned === false) run('DELETE FROM pins WHERE user_id = ? AND entity_type = ? AND entity_id = ?', req.user.id, type, id);
  else run('INSERT INTO pins (user_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', req.user.id, type, id, nowIso());
  return { ok: true };
}));

r.get('/alerts', h((req) => {
  if (!hasPerm(req.user, 'dashboard.view')) throw forbidden();
  return listAlerts({ rule: req.query.rule, owner: intId(req.query.owner) });
}));

r.post('/alerts/:id/ack', h((req) => {
  if (req.user.group === 'viewer') throw forbidden();
  return acknowledgeAlert(intId(req.params.id), req.user) || {};
}));

export default r;
