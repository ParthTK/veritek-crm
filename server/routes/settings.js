import { Router } from 'express';
import { all, get, run, insert, update, getSetting, setSetting } from '../db.js';
import { allow } from '../auth.js';
import { DEFAULT_SETTINGS, PERMISSIONS, ROLES } from '../../shared/constants.js';
import { badRequest, strOrNull, intOrNull, audit, nowIso } from '../util.js';
import { RULES, runAutomation, startScheduler } from '../services/automation.js';

const r = Router();
const EDITABLE = ['company', 'approvals', 'followups', 'customers', 'quotation', 'automation'];

r.get('/settings', allow('settings.edit', 'team.view'), (_req, res) => {
  const out = {};
  for (const key of EDITABLE) out[key] = { ...DEFAULT_SETTINGS[key], ...getSetting(key, {}) };
  res.json(out);
});

r.put('/settings/:key', allow('settings.edit'), (req, res) => {
  const { key } = req.params;
  if (!EDITABLE.includes(key)) throw badRequest('Unknown settings group');
  const defaults = DEFAULT_SETTINGS[key];
  const next = {};
  for (const [k, def] of Object.entries(defaults)) {
    if (req.body[k] === undefined) continue;
    if (typeof def === 'number') {
      const n = Number(req.body[k]);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${k} must be a positive number`);
      next[k] = n;
    } else if (typeof def === 'boolean') next[k] = Boolean(req.body[k]);
    else next[k] = String(req.body[k]);
  }
  if (key === 'approvals' && (next.discountHeadPct ?? 0) < (next.discountManagerPct ?? 0)) {
    throw badRequest('Sales Head discount threshold must be higher than the Regional Manager threshold');
  }
  const merged = { ...getSetting(key, {}), ...next };
  setSetting(key, merged);
  audit(req.user.id, 'settings', null, key, next);
  if (key === 'automation') startScheduler();
  res.json({ ...defaults, ...merged });
});

r.get('/roles', allow('team.view'), (_req, res) => {
  res.json({ roles: ROLES, permissions: PERMISSIONS });
});

// ------------------------------------------------------------------ masters
r.post('/regions', allow('settings.edit'), (req, res) => {
  if (!strOrNull(req.body.name)) throw badRequest('Region name is required');
  res.status(201).json({ id: insert('regions', { name: strOrNull(req.body.name), states: strOrNull(req.body.states) }) });
});
r.put('/regions/:id', allow('settings.edit'), (req, res) => {
  update('regions', req.params.id, { name: strOrNull(req.body.name), states: strOrNull(req.body.states) });
  res.json({ ok: true });
});
r.post('/factories', allow('settings.edit'), (req, res) => {
  if (!strOrNull(req.body.name)) throw badRequest('Factory name is required');
  res.status(201).json({ id: insert('factories', { name: strOrNull(req.body.name), location: strOrNull(req.body.location) }) });
});
r.put('/factories/:id', allow('settings.edit'), (req, res) => {
  update('factories', req.params.id, { name: strOrNull(req.body.name), location: strOrNull(req.body.location) });
  res.json({ ok: true });
});
r.put('/tags/:id', allow('settings.edit'), (req, res) => {
  update('tags', req.params.id, { name: strOrNull(req.body.name), color: req.body.color || 'slate' });
  res.json({ ok: true });
});
r.delete('/tags/:id', allow('settings.edit'), (req, res) => {
  run('DELETE FROM tags WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.get('/assignment-rules', allow('team.view', 'settings.edit'), (_req, res) => {
  res.json(all(
    `SELECT ar.*, rg.name AS region_name, pc.name AS category_name, u.name AS user_name FROM lead_assignment_rules ar
     LEFT JOIN regions rg ON rg.id = ar.region_id LEFT JOIN product_categories pc ON pc.id = ar.category_id LEFT JOIN users u ON u.id = ar.user_id
     ORDER BY ar.active DESC, ar.priority, rg.name`,
  ));
});
r.post('/assignment-rules', allow('settings.edit'), (req, res) => {
  const d = { region_id: intOrNull(req.body.region_id), category_id: intOrNull(req.body.category_id), user_id: intOrNull(req.body.user_id), priority: intOrNull(req.body.priority) ?? 10, active: 1 };
  if (!d.user_id) throw badRequest('Choose the salesperson');
  if (!d.region_id && !d.category_id) throw badRequest('A rule needs a region, a product category, or both');
  res.status(201).json({ id: insert('lead_assignment_rules', d) });
});
r.put('/assignment-rules/:id', allow('settings.edit'), (req, res) => {
  const d = {};
  for (const k of ['region_id', 'category_id', 'user_id', 'priority']) if (req.body[k] !== undefined) d[k] = intOrNull(req.body[k]);
  if (req.body.active !== undefined) d.active = req.body.active ? 1 : 0;
  update('lead_assignment_rules', req.params.id, d);
  res.json({ ok: true });
});
r.delete('/assignment-rules/:id', allow('settings.edit'), (req, res) => {
  run('DELETE FROM lead_assignment_rules WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ automation & audit
r.get('/automation', allow('team.view', 'settings.edit'), (_req, res) => {
  const log = all('SELECT * FROM automation_log ORDER BY run_at DESC, id DESC LIMIT 120');
  res.json({
    rules: RULES.map((x) => ({ key: x.key, label: x.label, setting: x.setting, last: log.find((l) => l.rule === x.key) || null })),
    last_run: getSetting('automation_last_run', null),
    log,
  });
});

r.post('/automation/run', allow('settings.edit', 'approvals.decide'), (req, res) => {
  const results = runAutomation({ only: req.body.rules, force: true });
  audit(req.user.id, 'automation', null, 'run', { rules: req.body.rules || 'all' });
  res.json({ results, ran_at: nowIso() });
});

r.get('/audit', allow('audit.view'), (req, res) => {
  const w = [];
  const p = [];
  if (req.query.entity) {
    w.push('a.entity = ?');
    p.push(req.query.entity);
  }
  if (req.query.user_id) {
    w.push('a.user_id = ?');
    p.push(req.query.user_id);
  }
  res.json(all(
    `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ...p, Math.min(Number(req.query.limit) || 200, 1000),
  ).map((a) => ({ ...a, details: JSON.parse(a.details || 'null') })));
});

export default r;
