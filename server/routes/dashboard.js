import { Router } from 'express';
import { all, get } from '../db.js';
import { can, roleRank, QUOTE_AWAITING, LEAD_STAGES, LEAD_SOURCES } from '../../shared/constants.js';
import { today, addDays, fyStart, monthKey } from '../util.js';
import { customerScope, leadScope, quotationScope, orderScope, redact } from '../access.js';
import { ORDER_ROLLUP, decorateOrder } from '../services/orders.js';

const r = Router();
const and = (s) => (s ? `AND ${s}` : '');
const inList = (arr) => arr.map((s) => `'${s}'`).join(',');

function periodRange(period) {
  const t = today();
  if (period === 'month') return [`${t.slice(0, 8)}01`, t];
  if (period === 'quarter') {
    const m = Number(t.slice(5, 7));
    const fyMonth = (m + 8) % 12; // Apr = 0
    const qStartFy = fyMonth - (fyMonth % 3);
    const startMonth = ((qStartFy + 3) % 12) + 1;
    const year = startMonth > m ? Number(t.slice(0, 4)) - 1 : Number(t.slice(0, 4));
    return [`${year}-${String(startMonth).padStart(2, '0')}-01`, t];
  }
  return [fyStart(t), t];
}

r.get('/dashboard', (req, res) => {
  const u = req.user;
  const t = today();
  const period = ['month', 'quarter', 'fy'].includes(req.query.period) ? req.query.period : 'fy';
  const [from, to] = periodRange(period);
  const monthStart = `${t.slice(0, 8)}01`;

  // Optional drill-down filters for managers.
  const ownerFilter = req.query.owner && roleRank(u.role) >= 2 ? Number(req.query.owner) : null;
  const regionFilter = req.query.region_id && ['all'].includes(u.scope) ? Number(req.query.region_id) : null;
  const extraLead = [ownerFilter && `l.assigned_to = ${ownerFilter}`, regionFilter && `l.customer_id IN (SELECT id FROM customers WHERE region_id = ${regionFilter})`].filter(Boolean).join(' AND ');
  const extraQuote = [ownerFilter && `q.owner_id = ${ownerFilter}`, regionFilter && `q.customer_id IN (SELECT id FROM customers WHERE region_id = ${regionFilter})`].filter(Boolean).join(' AND ');
  const extraOrder = [ownerFilter && `o.sales_owner_id = ${ownerFilter}`, regionFilter && `o.customer_id IN (SELECT id FROM customers WHERE region_id = ${regionFilter})`].filter(Boolean).join(' AND ');
  const extraCustomer = [ownerFilter && `c.assigned_to = ${ownerFilter}`, regionFilter && `c.region_id = ${regionFilter}`].filter(Boolean).join(' AND ');

  const ls = [leadScope(u, 'l'), extraLead].filter(Boolean).join(' AND ');
  const qs = [quotationScope(u, 'q'), extraQuote].filter(Boolean).join(' AND ');
  const os = [orderScope(u, 'o'), extraOrder].filter(Boolean).join(' AND ');
  const cs = [customerScope(u, 'c'), extraCustomer].filter(Boolean).join(' AND ');
  const out = { period, from, to, generated_at: new Date().toISOString() };

  // ---------------------------------------------------------------- sales KPIs
  if (can(u.role, 'leads.view')) {
    out.leads = get(
      `SELECT COUNT(*) AS count,
              SUM(created_at >= ?) AS new_this_month,
              SUM(status = 'open') AS open_count,
              COALESCE(SUM(CASE WHEN status = 'open' THEN estimated_value END), 0) AS pipeline_value,
              COALESCE(SUM(CASE WHEN status = 'open' THEN estimated_value * probability / 100.0 END), 0) AS weighted_value,
              SUM(status = 'open' AND temperature = 'hot') AS hot,
              SUM(status = 'won' AND substr(closed_at, 1, 10) BETWEEN ? AND ?) AS won,
              SUM(status = 'lost' AND substr(closed_at, 1, 10) BETWEEN ? AND ?) AS lost
       FROM leads l WHERE 1 = 1 ${and(ls)}`,
      monthStart, from, to, from, to,
    );
    out.pipeline = all(
      `SELECT stage, COUNT(*) AS count, COALESCE(SUM(estimated_value), 0) AS value FROM leads l
       WHERE status = 'open' ${and(ls)} GROUP BY stage`,
    );
    out.pipeline = LEAD_STAGES.slice(0, -1).map((s) => ({ stage: s.value, label: s.label, ...(out.pipeline.find((p) => p.stage === s.value) || { count: 0, value: 0 }) }));
  }

  // Individual contributors see their own follow-ups; managers see their team's.
  const fuScope = roleRank(u.role) < 2 ? `f.assigned_to = ${u.id}` : ownerFilter ? `f.assigned_to = ${ownerFilter}` : u.scope === 'region' ? `(f.assigned_to IN (SELECT id FROM users WHERE region_id = ${Number(u.region_id)}) OR f.assigned_to = ${u.id})` : '';
  out.followups = get(
    `SELECT COALESCE(SUM(due_date = ?), 0) AS due_today, COALESCE(SUM(due_date < ?), 0) AS overdue, COUNT(*) AS pending
     FROM followups f WHERE status = 'pending' ${and(fuScope)}`,
    t, t,
  );

  if (can(u.role, 'quotations.view')) {
    out.quotations = get(
      `SELECT SUM(q.sent_at IS NOT NULL AND substr(q.sent_at, 1, 10) BETWEEN ? AND ?) AS sent,
              SUM(q.status IN ('accepted', 'converted') AND substr(q.decided_at, 1, 10) BETWEEN ? AND ?) AS accepted,
              SUM(q.status = 'rejected' AND substr(q.decided_at, 1, 10) BETWEEN ? AND ?) AS rejected,
              SUM(q.status IN (${inList(QUOTE_AWAITING)})) AS awaiting,
              SUM(q.status = 'approval_pending') AS approval_pending,
              COALESCE(SUM(CASE WHEN q.sent_at IS NOT NULL AND substr(q.sent_at, 1, 10) BETWEEN ? AND ? THEN v.grand_total END), 0) AS sent_value,
              COALESCE(SUM(CASE WHEN q.status IN (${inList(QUOTE_AWAITING)}) THEN v.grand_total END), 0) AS awaiting_value
       FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
       WHERE 1 = 1 ${and(qs)}`,
      from, to, from, to, from, to, from, to,
    );
  }

  // ---------------------------------------------------------------- orders & operations
  const orders = all(
    `SELECT o.*, c.name AS customer_name, c.region_id, p.planned_completion, p.revised_completion, p.material_status, p.qc_status, ${ORDER_ROLLUP}
     FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN production p ON p.order_id = o.id
     WHERE o.status <> 'cancelled' ${and(os)}`,
  ).map(decorateOrder);
  const active = orders.filter((o) => o.status === 'active');
  const inPeriod = orders.filter((o) => o.order_date >= from && o.order_date <= to);
  const prodStages = ['order_confirmed', 'material_check', 'production_scheduled', 'under_production', 'quality_check', 'packing'];
  out.orders = {
    confirmed_count: inPeriod.length,
    order_value: inPeriod.reduce((s, o) => s + o.grand_total, 0),
    under_production: active.filter((o) => prodStages.includes(o.stage)).length,
    under_production_value: active.filter((o) => prodStages.includes(o.stage)).reduce((s, o) => s + o.grand_total, 0),
    ready_for_dispatch: active.filter((o) => o.stage === 'ready_for_dispatch').length,
    ready_value: active.filter((o) => o.stage === 'ready_for_dispatch').reduce((s, o) => s + o.grand_total, 0),
    delayed: active.filter((o) => o.is_delayed).length,
    awaiting_commercial: active.filter((o) => ['po_received', 'commercial_verification', 'advance_pending'].includes(o.stage)).length,
    in_transit: active.filter((o) => o.stage === 'dispatched').length,
  };

  if (can(u.role, 'payments.view')) {
    const ageing = get(
      `SELECT COALESCE(SUM(balance), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN due_date < ? THEN balance END), 0) AS overdue,
              COUNT(*) AS invoices,
              COALESCE(SUM(CASE WHEN julianday(?) - julianday(invoice_date) <= 30 THEN balance END), 0) AS d0_30,
              COALESCE(SUM(CASE WHEN julianday(?) - julianday(invoice_date) BETWEEN 31 AND 60 THEN balance END), 0) AS d31_60,
              COALESCE(SUM(CASE WHEN julianday(?) - julianday(invoice_date) BETWEEN 61 AND 90 THEN balance END), 0) AS d61_90,
              COALESCE(SUM(CASE WHEN julianday(?) - julianday(invoice_date) > 90 THEN balance END), 0) AS d90_plus
       FROM invoice_balances i WHERE balance > 1 AND i.customer_id IN (SELECT c.id FROM customers c WHERE 1 = 1 ${and(cs)})`,
      t, t, t, t, t,
    );
    const collected = get(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM payments p WHERE payment_date BETWEEN ? AND ? AND p.customer_id IN (SELECT c.id FROM customers c WHERE 1 = 1 ${and(cs)})`,
      from, to,
    ).v;
    out.payments = { ...ageing, collected };
  }

  // ---------------------------------------------------------------- breakdowns
  if (can(u.role, 'leads.view')) {
    const regions = all('SELECT id, name FROM regions ORDER BY name');
    out.by_region = regions.map((reg) => {
      const list = inPeriod.filter((o) => o.region_id === reg.id);
      return { region: reg.name, orders: list.length, value: list.reduce((s, o) => s + o.grand_total, 0) };
    }).filter((x) => x.orders > 0 || u.scope === 'all');

    const sourceRows = all(
      `SELECT COALESCE(l.source, 'existing_customer') AS source, COUNT(o.id) AS orders, COALESCE(SUM(o.grand_total), 0) AS value
       FROM sales_orders o LEFT JOIN leads l ON l.id = o.lead_id
       WHERE o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(os)} GROUP BY 1`,
      from, to,
    );
    const leadSources = all(
      `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS leads FROM leads l WHERE substr(created_at, 1, 10) BETWEEN ? AND ? ${and(ls)} GROUP BY 1`,
      from, to,
    );
    out.by_source = LEAD_SOURCES.map((s) => ({
      source: s.label,
      leads: leadSources.find((x) => x.source === s.value)?.leads || 0,
      orders: sourceRows.find((x) => x.source === s.value)?.orders || 0,
      value: sourceRows.find((x) => x.source === s.value)?.value || 0,
    })).filter((x) => x.leads || x.orders);

    // Salesperson performance within visible scope.
    const people = all(
      `SELECT u.id, u.name, u.role, r.name AS region FROM users u LEFT JOIN regions r ON r.id = u.region_id
       WHERE u.active = 1 AND u.role IN ('sales_executive', 'regional_manager')
       ${u.scope === 'region' ? `AND u.region_id = ${Number(u.region_id)}` : u.scope === 'own' ? `AND u.id = ${u.id}` : ''}
       ${regionFilter ? `AND u.region_id = ${regionFilter}` : ''}
       ORDER BY u.name`,
    );
    const leadStats = all(
      `SELECT assigned_to, COUNT(*) AS leads, SUM(status = 'open') AS open_leads,
              COALESCE(SUM(CASE WHEN status = 'open' THEN estimated_value END), 0) AS pipeline_value,
              SUM(status = 'won' AND substr(closed_at, 1, 10) BETWEEN ? AND ?) AS won,
              SUM(status = 'lost' AND substr(closed_at, 1, 10) BETWEEN ? AND ?) AS lost
       FROM leads GROUP BY assigned_to`,
      from, to, from, to,
    );
    const quoteStats = all(
      `SELECT owner_id, COUNT(*) AS sent FROM quotations WHERE sent_at IS NOT NULL AND substr(sent_at, 1, 10) BETWEEN ? AND ? GROUP BY owner_id`,
      from, to,
    );
    const targets = all('SELECT user_id, COALESCE(SUM(amount), 0) AS target FROM sales_targets WHERE month BETWEEN ? AND ? GROUP BY user_id', monthKey(from), monthKey(to));
    const followOver = all("SELECT assigned_to, COUNT(*) AS n FROM followups WHERE status = 'pending' AND due_date < ? GROUP BY assigned_to", t);
    out.salespeople = people.map((p) => {
      const ls2 = leadStats.find((x) => x.assigned_to === p.id) || {};
      const won = orders.filter((o) => o.sales_owner_id === p.id && o.order_date >= from && o.order_date <= to);
      const wonValue = won.reduce((s, o) => s + o.taxable_total, 0);
      const target = targets.find((x) => x.user_id === p.id)?.target || 0;
      const closed = (ls2.won || 0) + (ls2.lost || 0);
      return {
        id: p.id, name: p.name, region: p.region, role: p.role,
        leads: ls2.leads || 0, open_leads: ls2.open_leads || 0, pipeline_value: ls2.pipeline_value || 0,
        quotes_sent: quoteStats.find((x) => x.owner_id === p.id)?.sent || 0,
        orders: won.length, won_value: wonValue, target, achievement_pct: target ? Math.round((wonValue / target) * 100) : null,
        conversion_pct: closed ? Math.round(((ls2.won || 0) / closed) * 100) : null,
        overdue_followups: followOver.find((x) => x.assigned_to === p.id)?.n || 0,
      };
    }).sort((a, b) => b.won_value - a.won_value);

    // Monthly target vs achievement across the financial year (taxable order value).
    const fy = fyStart(t);
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(`${fy}T00:00:00`);
      d.setMonth(d.getMonth() + i);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
    const targetUsers = out.salespeople.map((p) => p.id);
    const monthlyTargets = targetUsers.length
      ? all(`SELECT month, SUM(amount) AS target FROM sales_targets WHERE user_id IN (${targetUsers.join(',')}) GROUP BY month`)
      : [];
    out.monthly = months.map((m) => ({
      month: m,
      target: monthlyTargets.find((x) => x.month === m)?.target || 0,
      achieved: orders.filter((o) => o.order_date.startsWith(m)).reduce((s, o) => s + o.taxable_total, 0),
      future: m > t.slice(0, 7),
    }));
  }

  // ---------------------------------------------------------------- action required
  const actions = { overdue_followups: [], expiring_quotations: [], delayed_production: [], pending_approvals: [], unpaid_invoices: [] };
  actions.overdue_followups = all(
    `SELECT f.id, f.title, f.due_date, f.type, f.lead_id, f.customer_id, f.quotation_id, f.order_id, f.escalated_at, c.name AS customer_name, u.name AS owner_name
     FROM followups f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN users u ON u.id = f.assigned_to
     WHERE f.status = 'pending' AND f.due_date < ? ${and(fuScope)} ORDER BY f.due_date LIMIT 25`,
    t,
  );
  if (can(u.role, 'quotations.view')) {
    actions.expiring_quotations = all(
      `SELECT q.id, q.number, q.subject, q.valid_until, q.status, c.name AS customer_name, v.grand_total, u.name AS owner_name
       FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
       LEFT JOIN users u ON u.id = q.owner_id
       WHERE q.status IN (${inList(QUOTE_AWAITING)}) AND q.valid_until BETWEEN ? AND ? ${and(qs)} ORDER BY q.valid_until LIMIT 25`,
      t, addDays(t, 7),
    );
    const approvalWhere = can(u.role, 'approvals.decide')
      ? `a.required_role IN (${inList(['regional_manager', 'sales_head', 'management', 'super_admin'].filter((r2) => roleRank(r2) <= roleRank(u.role)))})`
      : `a.requested_by = ${u.id}`;
    actions.pending_approvals = all(
      `SELECT a.id, a.required_role, a.reasons, a.amount, a.requested_at, q.id AS quotation_id, q.number, c.name AS customer_name, ru.name AS requested_by_name, v.discount_pct, v.margin_pct
       FROM approvals a JOIN quotations q ON q.id = a.entity_id AND a.entity = 'quotation' JOIN customers c ON c.id = q.customer_id
       LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN quotation_versions v ON v.id = a.version_id
       WHERE a.status = 'pending' AND ${approvalWhere} ${and(qs)} ORDER BY a.requested_at LIMIT 25`,
    ).map((a) => ({ ...a, reasons: JSON.parse(a.reasons || '[]') }));
  }
  actions.delayed_production = active
    .filter((o) => o.is_delayed || (idxProd(o) && (o.revised_completion || o.planned_completion) && (o.revised_completion || o.planned_completion) < t) || o.material_status === 'shortage' || o.qc_status === 'failed')
    .sort((a, b) => b.delay_days - a.delay_days)
    .slice(0, 25)
    .map((o) => ({
      id: o.id, number: o.number, customer_name: o.customer_name, stage: o.stage, delivery_date: o.delivery_date, delay_days: o.delay_days,
      delay_reason: o.delay_reason, planned_completion: o.revised_completion || o.planned_completion, material_status: o.material_status, qc_status: o.qc_status,
      grand_total: o.grand_total, priority: o.priority,
    }));
  if (can(u.role, 'payments.view')) {
    actions.unpaid_invoices = all(
      `SELECT i.id, i.number, i.invoice_date, i.due_date, i.balance, i.order_id, c.id AS customer_id, c.name AS customer_name,
              CAST(julianday(?) - julianday(i.due_date) AS INTEGER) AS days_overdue
       FROM invoice_balances i JOIN customers c ON c.id = i.customer_id
       WHERE i.balance > 1 AND i.due_date < ? ${and(cs)} ORDER BY i.due_date LIMIT 25`,
      t, t,
    );
  }
  out.actions = actions;
  res.json(redact(u, out));
});

function idxProd(o) {
  return ['order_confirmed', 'material_check', 'production_scheduled', 'under_production', 'quality_check'].includes(o.stage);
}

export default r;
