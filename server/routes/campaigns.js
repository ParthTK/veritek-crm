import { Router } from 'express';
import { all, get, insert, update } from '../db.js';
import { allow } from '../auth.js';
import { LEAD_STAGES, stageIndex } from '../../shared/constants.js';
import { nowIso, badRequest, notFound, strOrNull, intOrNull, num } from '../util.js';
import { redact, leadScope } from '../access.js';

const r = Router();

/** Funnel and ROI metrics for one campaign (or all when id is null). */
function metrics(campaignId, user) {
  const scope = leadScope(user, 'l');
  const leads = all(
    `SELECT l.id, l.stage, l.status, l.assigned_to, l.estimated_value, l.customer_id, l.created_at, l.closed_at
     FROM leads l WHERE l.campaign_id = ? ${scope ? `AND ${scope}` : ''}`,
    campaignId,
  );
  const ids = leads.map((l) => l.id);
  const inIds = ids.length ? ids.join(',') : '0';
  const meetings = get(`SELECT COUNT(DISTINCT lead_id) AS n FROM activities WHERE lead_id IN (${inIds}) AND type IN ('meeting','video','factory_visit')`).n;
  const contacted = get(`SELECT COUNT(DISTINCT lead_id) AS n FROM activities WHERE lead_id IN (${inIds}) AND type <> 'note'`).n;
  const quotes = get(`SELECT COUNT(*) AS n, COUNT(DISTINCT lead_id) AS leads, COALESCE(SUM(v.grand_total), 0) AS value
    FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
    WHERE q.lead_id IN (${inIds}) AND q.sent_at IS NOT NULL`);
  const orders = get(`SELECT COUNT(*) AS n, COALESCE(SUM(taxable_total), 0) AS revenue FROM sales_orders WHERE lead_id IN (${inIds}) AND status <> 'cancelled'`);
  // Follow-on business from customers first met at this campaign, after the event.
  const campaign = get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  const customerIds = [...new Set(leads.map((l) => l.customer_id))];
  const influenced = customerIds.length
    ? get(`SELECT COALESCE(SUM(taxable_total), 0) AS v FROM sales_orders WHERE customer_id IN (${customerIds.join(',')}) AND status <> 'cancelled' AND order_date >= ? AND (lead_id IS NULL OR lead_id NOT IN (${inIds}))`, campaign?.start_date || '0000').v
    : 0;
  const quotedFrom = stageIndex(LEAD_STAGES, 'quotation_sent');
  const cost = campaign?.cost || 0;
  return {
    leads: leads.length,
    assigned: leads.filter((l) => l.assigned_to).length,
    contacted,
    meetings,
    qualified: leads.filter((l) => stageIndex(LEAD_STAGES, l.stage) >= stageIndex(LEAD_STAGES, 'requirement_identified')).length,
    quotations: quotes.n,
    quoted_leads: Math.max(quotes.leads, leads.filter((l) => stageIndex(LEAD_STAGES, l.stage) >= quotedFrom).length),
    quoted_value: quotes.value,
    orders: orders.n,
    won: leads.filter((l) => l.status === 'won').length,
    lost: leads.filter((l) => l.status === 'lost').length,
    open: leads.filter((l) => l.status === 'open').length,
    pipeline_value: leads.filter((l) => l.status === 'open').reduce((s, l) => s + l.estimated_value, 0),
    revenue: orders.revenue,
    influenced_revenue: influenced,
    conversion_pct: leads.length ? Math.round((leads.filter((l) => l.status === 'won').length / leads.length) * 1000) / 10 : 0,
    cost,
    roi_multiple: cost ? Math.round((orders.revenue / cost) * 10) / 10 : null,
    cost_per_lead: leads.length && cost ? Math.round(cost / leads.length) : null,
  };
}

r.get('/campaigns', allow('campaigns.view'), (req, res) => {
  const rows = all('SELECT c.*, u.name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id ORDER BY c.start_date DESC');
  res.json(redact(req.user, rows.map((c) => ({ ...c, metrics: metrics(c.id, req.user) }))));
});

r.get('/campaigns/:id', allow('campaigns.view'), (req, res) => {
  const c = get('SELECT c.*, u.name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', req.params.id);
  if (!c) throw notFound('Campaign');
  const scope = leadScope(req.user, 'l');
  const leads = all(
    `SELECT l.*, cu.name AS customer_name, cu.city, u.name AS owner_name,
            (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) AS activity_count,
            (SELECT COUNT(*) FROM quotations q WHERE q.lead_id = l.id AND q.sent_at IS NOT NULL) AS quotation_count
     FROM leads l JOIN customers cu ON cu.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.campaign_id = ? ${scope ? `AND ${scope}` : ''} ORDER BY l.created_at DESC`,
    c.id,
  );
  const bySalesperson = Object.values(leads.reduce((acc, l) => {
    const key = l.owner_name || 'Unassigned';
    acc[key] ||= { name: key, leads: 0, contacted: 0, quoted: 0, won: 0, value: 0 };
    acc[key].leads++;
    if (l.activity_count) acc[key].contacted++;
    if (l.quotation_count) acc[key].quoted++;
    if (l.status === 'won') {
      acc[key].won++;
      acc[key].value += l.estimated_value;
    }
    return acc;
  }, {}));
  res.json(redact(req.user, { ...c, metrics: metrics(c.id, req.user), leads, by_salesperson: bySalesperson }));
});

function campaignData(b) {
  return {
    name: strOrNull(b.name), type: b.type || 'exhibition', location: strOrNull(b.location), start_date: strOrNull(b.start_date),
    end_date: strOrNull(b.end_date), cost: num(b.cost), target_leads: intOrNull(b.target_leads), stall: strOrNull(b.stall),
    status: b.status || 'planned', description: strOrNull(b.description), owner_id: intOrNull(b.owner_id),
  };
}

r.post('/campaigns', allow('campaigns.edit'), (req, res) => {
  const d = campaignData(req.body);
  if (!d.name) throw badRequest('Campaign name is required');
  res.status(201).json({ id: insert('campaigns', { ...d, created_at: nowIso() }) });
});

r.put('/campaigns/:id', allow('campaigns.edit'), (req, res) => {
  const d = campaignData(req.body);
  if (!d.name) throw badRequest('Campaign name is required');
  update('campaigns', req.params.id, d);
  res.json({ ok: true });
});

export default r;
