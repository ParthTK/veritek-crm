import { Router } from 'express';
import { all, get, run, tx } from '../db.js';
import { allow } from '../auth.js';
import { LEAD_STAGES, stageIndex, OPPORTUNITY_FROM_STAGE } from '../../shared/constants.js';
import { today, addDays, paginate, sortClause, whereClause, forbidden } from '../util.js';
import { leadScope, assertLead, assertCustomer, redact } from '../access.js';
import { createLead, updateLead, moveLead, tagsFor } from '../services/leads.js';
import { buildTimeline } from '../services/timeline.js';

const r = Router();

function leadFilters(req, q = req.query) {
  const t = today();
  const w = [leadScope(req.user, 'l')];
  const p = [];
  const eq = (col, v) => {
    if (v !== undefined && v !== '') {
      w.push(`${col} = ?`);
      p.push(v);
    }
  };
  if (q.q) {
    w.push('(l.title LIKE ? OR l.code LIKE ? OR c.name LIKE ? OR l.requirement LIKE ?)');
    p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  eq('l.stage', q.stage);
  eq('l.status', q.status);
  eq('l.temperature', q.temperature);
  eq('l.source', q.source);
  eq('l.campaign_id', q.campaign_id);
  eq('l.assigned_to', q.assigned_to);
  eq('l.category_id', q.category_id);
  eq('c.region_id', q.region_id);
  eq('l.customer_id', q.customer_id);
  if (q.mine === '1') eq('l.assigned_to', req.user.id);
  if (q.followup === 'overdue') w.push(`l.status = 'open' AND l.next_follow_up_date < '${t}'`);
  if (q.followup === 'today') w.push(`l.status = 'open' AND l.next_follow_up_date = '${t}'`);
  if (q.followup === 'none') w.push("l.status = 'open' AND (l.next_action IS NULL OR l.next_follow_up_date IS NULL)");
  if (q.opportunity === '1') {
    const from = stageIndex(LEAD_STAGES, OPPORTUNITY_FROM_STAGE);
    w.push(`l.stage IN (${LEAD_STAGES.slice(from).map((s) => `'${s.value}'`).join(',')})`);
  }
  if (q.closing === '30') w.push(`l.status = 'open' AND l.expected_close_date BETWEEN '${t}' AND '${addDays(t, 30)}'`);
  if (q.from) {
    w.push('substr(l.created_at, 1, 10) >= ?');
    p.push(q.from);
  }
  if (q.to) {
    w.push('substr(l.created_at, 1, 10) <= ?');
    p.push(q.to);
  }
  if (q.tag) {
    w.push("l.id IN (SELECT tg.entity_id FROM taggings tg JOIN tags t ON t.id = tg.tag_id WHERE tg.entity = 'lead' AND t.name = ?)");
    p.push(q.tag);
  }
  return { where: whereClause(w), params: p };
}

const LEAD_SELECT = `
  SELECT l.*, c.name AS customer_name, c.city, c.state, c.region_id, c.customer_type, ct.name AS contact_name, ct.phone AS contact_phone,
         u.name AS owner_name, pc.name AS category_name, pr.name AS product_name, cp.name AS campaign_name, r.name AS region_name
  FROM leads l
  JOIN customers c ON c.id = l.customer_id
  LEFT JOIN contacts ct ON ct.id = l.contact_id
  LEFT JOIN users u ON u.id = l.assigned_to
  LEFT JOIN product_categories pc ON pc.id = l.category_id
  LEFT JOIN products pr ON pr.id = l.product_id
  LEFT JOIN campaigns cp ON cp.id = l.campaign_id
  LEFT JOIN regions r ON r.id = c.region_id`;

r.get('/leads', allow('leads.view'), (req, res) => {
  const { where, params } = leadFilters(req);
  const { limit, offset } = paginate(req.query);
  const order = sortClause(req.query, {
    code: 'l.id', title: 'l.title', customer: 'c.name', stage: 'l.stage', value: 'l.estimated_value', temperature: 'l.temperature',
    follow_up: 'l.next_follow_up_date', close: 'l.expected_close_date', owner: 'u.name', created: 'l.created_at', probability: 'l.probability',
  }, "l.status = 'open' DESC, l.next_follow_up_date ASC NULLS LAST, l.id DESC");
  const rows = all(`${LEAD_SELECT} ${where} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const count = get(`SELECT COUNT(*) AS n FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to ${where}`, ...params).n;
  const sums = get(
    `SELECT COALESCE(SUM(l.estimated_value), 0) AS value, COALESCE(SUM(l.estimated_value * l.probability / 100.0), 0) AS weighted_value
     FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to ${where}`,
    ...params,
  );
  const tags = tagsFor('lead', rows.map((x) => x.id));
  res.json(redact(req.user, { rows: rows.map((x) => ({ ...x, tags: tags[x.id] || [] })), count, sums }));
});

/** Open opportunities grouped by stage for the kanban board, plus a 30/60/90-day forecast. */
r.get('/leads/pipeline', allow('leads.view'), (req, res) => {
  const { where, params } = leadFilters(req, { ...req.query, status: 'open' });
  const rows = all(`${LEAD_SELECT} ${where} ORDER BY l.estimated_value DESC`, ...params);
  const tags = tagsFor('lead', rows.map((x) => x.id));
  const t = today();
  const stages = LEAD_STAGES.slice(0, -1).map((s) => {
    const items = rows.filter((x) => x.stage === s.value).map((x) => ({ ...x, tags: tags[x.id] || [], overdue: x.next_follow_up_date && x.next_follow_up_date < t }));
    // `stage`, not `...s`: the money total must not overwrite the stage's own value key.
    return {
      stage: s.value, label: s.label, color: s.color, count: items.length,
      value: items.reduce((a, x) => a + x.estimated_value, 0),
      weighted_value: items.reduce((a, x) => a + (x.estimated_value * x.probability) / 100, 0), items,
    };
  });
  const forecast = [30, 60, 90].map((d) => {
    const within = rows.filter((x) => x.expected_close_date && x.expected_close_date <= addDays(t, d));
    return { days: d, count: within.length, value: within.reduce((a, x) => a + x.estimated_value, 0), weighted_value: within.reduce((a, x) => a + (x.estimated_value * x.probability) / 100, 0) };
  });
  res.json(redact(req.user, { stages, forecast }));
});

r.post('/leads', allow('leads.edit'), (req, res) => {
  if (req.body.customer_id) assertCustomer(req.user, req.body.customer_id);
  const id = createLead(req.body, req.user);
  res.status(201).json({ id });
});

r.get('/leads/:id', allow('leads.view'), (req, res) => {
  assertLead(req.user, req.params.id);
  const lead = get(`${LEAD_SELECT} WHERE l.id = ?`, req.params.id);
  lead.tags = tagsFor('lead', [lead.id])[lead.id] || [];
  const contacts = all('SELECT * FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, name', lead.customer_id);
  const history = all(
    `SELECT h.*, u.name AS user_name FROM lead_stage_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.lead_id = ? ORDER BY h.changed_at DESC, h.id DESC`,
    lead.id,
  );
  const followups = all(
    `SELECT f.*, u.name AS owner_name FROM followups f LEFT JOIN users u ON u.id = f.assigned_to
     WHERE f.lead_id = ? OR (f.quotation_id IN (SELECT id FROM quotations WHERE lead_id = ?)) ORDER BY f.status = 'pending' DESC, f.due_date DESC LIMIT 30`,
    lead.id, lead.id,
  );
  const quotations = all(
    `SELECT q.id, q.number, q.status, q.current_version, q.sent_at, q.valid_until, v.grand_total, v.discount_pct, v.margin_pct
     FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
     WHERE q.lead_id = ? ORDER BY q.created_at DESC`,
    lead.id,
  );
  const orders = all('SELECT id, number, stage, status, grand_total, order_date FROM sales_orders WHERE lead_id = ?', lead.id);
  const days_in_stage = lead.stage_changed_at ? Math.max(0, Math.round((Date.now() - new Date(lead.stage_changed_at)) / 86400000)) : null;
  res.json(redact(req.user, { ...lead, days_in_stage, contacts, history, followups, quotations, orders, timeline: buildTimeline({ leadId: lead.id }) }));
});

r.put('/leads/:id', allow('leads.edit'), (req, res) => {
  assertLead(req.user, req.params.id);
  if (req.user.role === 'sales_executive' && req.body.assigned_to && Number(req.body.assigned_to) !== req.user.id) {
    const current = get('SELECT assigned_to FROM leads WHERE id = ?', req.params.id);
    if (Number(req.body.assigned_to) !== current.assigned_to) throw forbidden('Ask your manager to reassign leads');
  }
  updateLead(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

r.post('/leads/:id/move', allow('leads.edit'), (req, res) => {
  assertLead(req.user, req.params.id);
  moveLead(Number(req.params.id), req.body, req.user);
  res.json({ ok: true });
});

r.post('/leads/bulk-assign', allow('leads.edit'), (req, res) => {
  if (!['super_admin', 'management', 'sales_head', 'regional_manager'].includes(req.user.role)) throw forbidden();
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  tx(() => {
    for (const id of ids) {
      assertLead(req.user, id);
      updateLead(id, { assigned_to: req.body.assigned_to }, req.user);
    }
  });
  res.json({ updated: ids.length });
});

r.delete('/leads/:id', allow('leads.edit'), (req, res) => {
  if (!['super_admin', 'management'].includes(req.user.role)) throw forbidden('Only administrators can delete leads. Mark it lost instead.');
  if (get('SELECT id FROM quotations WHERE lead_id = ?', req.params.id)) throw forbidden('Lead has quotations; mark it lost instead');
  tx(() => {
    run('DELETE FROM followups WHERE lead_id = ?', req.params.id);
    run('UPDATE activities SET lead_id = NULL WHERE lead_id = ?', req.params.id);
    run("DELETE FROM taggings WHERE entity = 'lead' AND entity_id = ?", req.params.id);
    run('DELETE FROM leads WHERE id = ?', req.params.id);
  });
  res.json({ ok: true });
});

export default r;
