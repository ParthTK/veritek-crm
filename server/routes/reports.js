import { Router } from 'express';
import { all, get } from '../db.js';
import { allow } from '../auth.js';
import { LEAD_SOURCES, CUSTOMER_TYPES, COMPLAINT_CATEGORIES, labelOf, QUOTE_AWAITING } from '../../shared/constants.js';
import { today, addDays, fyStart, daysBetween, badRequest } from '../util.js';
import { leadScope, quotationScope, orderScope, customerScope, redact } from '../access.js';
import { ORDER_ROLLUP, decorateOrder, ageingBucket } from '../services/orders.js';
import { computeReminders } from '../services/automation.js';

const r = Router();
const and = (s) => (s ? `AND ${s}` : '');
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const col = (key, label, format = 'text') => ({ key, label, format });

export const REPORTS = [
  { key: 'lead_sources', group: 'Sales', label: 'Lead source conversion' },
  { key: 'exhibition_roi', group: 'Sales', label: 'Exhibition & campaign ROI' },
  { key: 'salesperson_conversion', group: 'Sales', label: 'Salesperson-wise conversion' },
  { key: 'quote_to_order', group: 'Sales', label: 'Quotation-to-order conversion' },
  { key: 'sales_cycle', group: 'Sales', label: 'Average sales cycle' },
  { key: 'lost_reasons', group: 'Sales', label: 'Lost-order reasons' },
  { key: 'discount_margin', group: 'Sales', label: 'Discount & margin analysis' },
  { key: 'forecast', group: 'Sales', label: 'Sales forecast (30/60/90 days)' },
  { key: 'region_revenue', group: 'Revenue', label: 'Region-wise revenue' },
  { key: 'product_demand', group: 'Revenue', label: 'Product-wise demand & revenue' },
  { key: 'top_customers', group: 'Customers', label: 'Top customers' },
  { key: 'repeat_orders', group: 'Customers', label: 'Repeat-order rate' },
  { key: 'dormant_customers', group: 'Customers', label: 'Dormant customers' },
  { key: 'payment_ageing', group: 'Operations', label: 'Customer payment ageing' },
  { key: 'order_delays', group: 'Operations', label: 'Order delay analysis' },
  { key: 'complaint_trends', group: 'Operations', label: 'Customer complaint trends' },
  { key: 'summaries', group: 'Management', label: 'Daily & weekly summaries' },
];

const builders = {
  lead_sources({ from, to, user }) {
    const rows = all(
      `SELECT COALESCE(l.source, 'unknown') AS source, COUNT(*) AS leads,
              SUM(l.stage NOT IN ('new_enquiry', 'contact_attempted')) AS qualified,
              SUM(EXISTS (SELECT 1 FROM quotations q WHERE q.lead_id = l.id AND q.sent_at IS NOT NULL)) AS quoted,
              SUM(l.status = 'won') AS won, SUM(l.status = 'lost') AS lost,
              COALESCE((SELECT SUM(o.taxable_total) FROM sales_orders o JOIN leads l2 ON l2.id = o.lead_id WHERE COALESCE(l2.source, 'unknown') = COALESCE(l.source, 'unknown') AND substr(l2.created_at, 1, 10) BETWEEN ? AND ? AND o.status <> 'cancelled'), 0) AS won_value
       FROM leads l WHERE substr(l.created_at, 1, 10) BETWEEN ? AND ? ${and(leadScope(user, 'l'))} GROUP BY 1 ORDER BY leads DESC`,
      from, to, from, to,
    ).map((x) => ({ ...x, source_label: labelOf(LEAD_SOURCES, x.source), conversion_pct: pct(x.won, x.leads), win_rate_pct: pct(x.won, x.won + x.lost) }));
    return {
      kpis: [
        { label: 'Leads', value: rows.reduce((s, x) => s + x.leads, 0), format: 'number' },
        { label: 'Won', value: rows.reduce((s, x) => s + x.won, 0), format: 'number' },
        { label: 'Overall conversion', value: pct(rows.reduce((s, x) => s + x.won, 0), rows.reduce((s, x) => s + x.leads, 0)), format: 'pct' },
        { label: 'Won value', value: rows.reduce((s, x) => s + x.won_value, 0), format: 'currency' },
      ],
      chart: { type: 'bar', x: 'source_label', series: [{ key: 'leads', label: 'Leads' }, { key: 'won', label: 'Won' }] },
      columns: [col('source_label', 'Source'), col('leads', 'Leads', 'number'), col('qualified', 'Qualified', 'number'), col('quoted', 'Quoted', 'number'), col('won', 'Won', 'number'), col('lost', 'Lost', 'number'), col('conversion_pct', 'Conversion', 'pct'), col('win_rate_pct', 'Win rate', 'pct'), col('won_value', 'Won value', 'currency')],
      rows,
    };
  },

  exhibition_roi({ from, to, user }) {
    const ls = leadScope(user, 'l');
    const rows = all(`SELECT * FROM campaigns WHERE COALESCE(start_date, '') <= ? AND COALESCE(end_date, start_date, '9999') >= ? ORDER BY start_date DESC`, to, from).map((c) => {
      const leads = all(`SELECT l.id, l.status FROM leads l WHERE l.campaign_id = ? ${and(ls)}`, c.id);
      const ids = leads.map((l) => l.id).join(',') || '0';
      const quotes = get(`SELECT COUNT(*) AS n FROM quotations WHERE lead_id IN (${ids}) AND sent_at IS NOT NULL`).n;
      const orders = get(`SELECT COUNT(*) AS n, COALESCE(SUM(taxable_total), 0) AS v FROM sales_orders WHERE lead_id IN (${ids}) AND status <> 'cancelled'`);
      const meetings = get(`SELECT COUNT(DISTINCT lead_id) AS n FROM activities WHERE lead_id IN (${ids}) AND type IN ('meeting','video','factory_visit')`).n;
      return {
        name: c.name, type: c.type, start_date: c.start_date, cost: c.cost, leads: leads.length, meetings, quotations: quotes, orders: orders.n, revenue: orders.v,
        conversion_pct: pct(leads.filter((l) => l.status === 'won').length, leads.length), roi_multiple: c.cost ? Math.round((orders.v / c.cost) * 10) / 10 : null,
        cost_per_lead: leads.length ? Math.round(c.cost / leads.length) : null,
      };
    });
    const cost = rows.reduce((s, x) => s + x.cost, 0);
    const revenue = rows.reduce((s, x) => s + x.revenue, 0);
    return {
      kpis: [
        { label: 'Campaigns', value: rows.length, format: 'number' }, { label: 'Total cost', value: cost, format: 'currency' },
        { label: 'Revenue generated', value: revenue, format: 'currency' }, { label: 'Return on spend', value: cost ? Math.round((revenue / cost) * 10) / 10 : 0, format: 'multiple' },
      ],
      chart: { type: 'bar', x: 'name', series: [{ key: 'cost', label: 'Cost' }, { key: 'revenue', label: 'Revenue' }], format: 'currency' },
      columns: [col('name', 'Campaign'), col('start_date', 'Date', 'date'), col('cost', 'Cost', 'currency'), col('leads', 'Leads', 'number'), col('meetings', 'Meetings', 'number'), col('quotations', 'Quotations', 'number'), col('orders', 'Orders', 'number'), col('revenue', 'Revenue', 'currency'), col('conversion_pct', 'Conversion', 'pct'), col('cost_per_lead', 'Cost / lead', 'currency'), col('roi_multiple', 'ROI', 'multiple')],
      rows,
    };
  },

  salesperson_conversion({ from, to, user }) {
    const ls = leadScope(user, 'l');
    const rows = all(
      `SELECT u.id, u.name, rg.name AS region,
              COUNT(l.id) AS leads, SUM(l.status = 'won') AS won, SUM(l.status = 'lost') AS lost, SUM(l.status = 'open') AS open,
              (SELECT COUNT(*) FROM quotations q WHERE q.owner_id = u.id AND substr(q.sent_at, 1, 10) BETWEEN ? AND ?) AS quotes_sent,
              (SELECT COUNT(*) FROM sales_orders o WHERE o.sales_owner_id = u.id AND o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled') AS orders,
              (SELECT COALESCE(SUM(o.taxable_total), 0) FROM sales_orders o WHERE o.sales_owner_id = u.id AND o.order_date BETWEEN ? AND ? AND o.status <> 'cancelled') AS revenue,
              (SELECT AVG(v.discount_pct) FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version WHERE q.owner_id = u.id AND substr(q.created_at, 1, 10) BETWEEN ? AND ?) AS avg_discount
       FROM users u LEFT JOIN regions rg ON rg.id = u.region_id
       LEFT JOIN leads l ON l.assigned_to = u.id AND substr(l.created_at, 1, 10) BETWEEN ? AND ? ${and(ls)}
       WHERE u.role IN ('sales_executive', 'regional_manager') AND u.active = 1
       GROUP BY u.id ORDER BY revenue DESC`,
      from, to, from, to, from, to, from, to, from, to,
    ).filter((x) => x.leads || x.orders).map((x) => ({
      ...x, conversion_pct: pct(x.won, x.leads), win_rate_pct: pct(x.won, x.won + x.lost), avg_deal: x.orders ? Math.round(x.revenue / x.orders) : 0,
      avg_discount: x.avg_discount ? Math.round(x.avg_discount * 10) / 10 : 0,
    }));
    return {
      chart: { type: 'bar', x: 'name', series: [{ key: 'revenue', label: 'Revenue' }], format: 'currency' },
      columns: [col('name', 'Salesperson'), col('region', 'Region'), col('leads', 'Leads', 'number'), col('quotes_sent', 'Quotes sent', 'number'), col('won', 'Won', 'number'), col('lost', 'Lost', 'number'), col('conversion_pct', 'Conversion', 'pct'), col('win_rate_pct', 'Win rate', 'pct'), col('orders', 'Orders', 'number'), col('revenue', 'Revenue', 'currency'), col('avg_deal', 'Avg order', 'currency'), col('avg_discount', 'Avg discount', 'pct')],
      rows,
    };
  },

  quote_to_order({ from, to, user }) {
    const rows = all(
      `SELECT substr(q.sent_at, 1, 7) AS month, COUNT(*) AS sent, COALESCE(SUM(v.grand_total), 0) AS sent_value,
              SUM(q.status = 'converted') AS converted, COALESCE(SUM(CASE WHEN q.status = 'converted' THEN v.grand_total END), 0) AS converted_value,
              SUM(q.status = 'rejected') AS rejected, SUM(q.status = 'expired') AS expired, SUM(q.status IN (${QUOTE_AWAITING.map((s) => `'${s}'`).join(',')}, 'accepted')) AS open
       FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version
       WHERE q.sent_at IS NOT NULL AND substr(q.sent_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))}
       GROUP BY 1 ORDER BY 1`,
      from, to,
    ).map((x) => ({ ...x, conversion_pct: pct(x.converted, x.sent), value_conversion_pct: pct(x.converted_value, x.sent_value) }));
    const sent = rows.reduce((s, x) => s + x.sent, 0);
    const conv = rows.reduce((s, x) => s + x.converted, 0);
    const avgRevisions = get(`SELECT AVG(current_version) AS v FROM quotations q WHERE q.status = 'converted' AND substr(q.created_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))}`, from, to).v;
    return {
      kpis: [
        { label: 'Quotations sent', value: sent, format: 'number' }, { label: 'Converted', value: conv, format: 'number' },
        { label: 'Count conversion', value: pct(conv, sent), format: 'pct' },
        { label: 'Value conversion', value: pct(rows.reduce((s, x) => s + x.converted_value, 0), rows.reduce((s, x) => s + x.sent_value, 0)), format: 'pct' },
        { label: 'Avg versions to win', value: avgRevisions ? Math.round(avgRevisions * 10) / 10 : 0, format: 'decimal' },
      ],
      chart: { type: 'bar', x: 'month', series: [{ key: 'sent_value', label: 'Quoted value' }, { key: 'converted_value', label: 'Converted value' }], format: 'currency' },
      columns: [col('month', 'Month', 'month'), col('sent', 'Sent', 'number'), col('sent_value', 'Quoted value', 'currency'), col('converted', 'Converted', 'number'), col('converted_value', 'Converted value', 'currency'), col('rejected', 'Rejected', 'number'), col('expired', 'Expired', 'number'), col('open', 'Still open', 'number'), col('conversion_pct', 'Conversion', 'pct'), col('value_conversion_pct', 'Value conv.', 'pct')],
      rows,
    };
  },

  sales_cycle({ from, to, user }) {
    const won = all(
      `SELECT l.id, l.source, l.created_at, l.closed_at, u.name AS owner, pc.name AS category, l.estimated_value
       FROM leads l LEFT JOIN users u ON u.id = l.assigned_to LEFT JOIN product_categories pc ON pc.id = l.category_id
       WHERE l.status = 'won' AND substr(l.closed_at, 1, 10) BETWEEN ? AND ? ${and(leadScope(user, 'l'))}`,
      from, to,
    ).map((l) => ({ ...l, days: Math.max(0, daysBetween(l.created_at, l.closed_at)) }));
    const groupBy = (key, labeler = (v) => v) => Object.values(won.reduce((acc, l) => {
      const k = l[key] || 'Unknown';
      acc[k] ||= { dimension: labeler(k), deals: 0, total_days: 0, min_days: Infinity, max_days: 0 };
      acc[k].deals++;
      acc[k].total_days += l.days;
      acc[k].min_days = Math.min(acc[k].min_days, l.days);
      acc[k].max_days = Math.max(acc[k].max_days, l.days);
      return acc;
    }, {})).map((g) => ({ ...g, avg_days: Math.round(g.total_days / g.deals) }));
    const rows = [
      ...groupBy('source', (v) => labelOf(LEAD_SOURCES, v)).map((g) => ({ ...g, group: 'By source' })),
      ...groupBy('owner').map((g) => ({ ...g, group: 'By salesperson' })),
      ...groupBy('category').map((g) => ({ ...g, group: 'By product category' })),
    ];
    const avg = won.length ? Math.round(won.reduce((s, l) => s + l.days, 0) / won.length) : 0;
    const sorted = won.map((l) => l.days).sort((a, b) => a - b);
    return {
      kpis: [
        { label: 'Deals won', value: won.length, format: 'number' }, { label: 'Average cycle', value: avg, format: 'days' },
        { label: 'Median cycle', value: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0, format: 'days' },
        { label: 'Fastest', value: sorted[0] || 0, format: 'days' }, { label: 'Slowest', value: sorted[sorted.length - 1] || 0, format: 'days' },
      ],
      chart: { type: 'bar', x: 'dimension', series: [{ key: 'avg_days', label: 'Average days' }], filter: { group: 'By source' }, format: 'days' },
      columns: [col('group', 'View'), col('dimension', 'Segment'), col('deals', 'Deals', 'number'), col('avg_days', 'Avg days', 'days'), col('min_days', 'Fastest', 'days'), col('max_days', 'Slowest', 'days')],
      rows,
    };
  },

  lost_reasons({ from, to, user }) {
    const lost = all(
      `SELECT COALESCE(l.win_loss_reason, 'Not recorded') AS reason, COALESCE(l.competitor, '-') AS competitor, l.estimated_value
       FROM leads l WHERE l.status = 'lost' AND substr(l.closed_at, 1, 10) BETWEEN ? AND ? ${and(leadScope(user, 'l'))}`,
      from, to,
    );
    const agg = (key) => Object.values(lost.reduce((acc, l) => {
      acc[l[key]] ||= { label: l[key], count: 0, value: 0 };
      acc[l[key]].count++;
      acc[l[key]].value += l.estimated_value;
      return acc;
    }, {})).sort((a, b) => b.count - a.count);
    const total = lost.length;
    const rows = [
      ...agg('reason').map((x) => ({ ...x, group: 'Reason', share_pct: pct(x.count, total) })),
      ...agg('competitor').filter((x) => x.label !== '-').map((x) => ({ ...x, group: 'Lost to competitor', share_pct: pct(x.count, total) })),
    ];
    return {
      kpis: [{ label: 'Leads lost', value: total, format: 'number' }, { label: 'Value lost', value: lost.reduce((s, l) => s + l.estimated_value, 0), format: 'currency' }],
      chart: { type: 'donut', x: 'label', series: [{ key: 'count', label: 'Leads' }], filter: { group: 'Reason' } },
      columns: [col('group', 'View'), col('label', 'Reason / competitor'), col('count', 'Leads', 'number'), col('share_pct', 'Share', 'pct'), col('value', 'Estimated value', 'currency')],
      rows,
    };
  },

  discount_margin({ from, to, user }) {
    const quotes = all(
      `SELECT q.id, q.status, u.name AS owner, v.discount_pct, v.margin_pct, v.taxable_total, v.approval_role, v.below_min_price
       FROM quotations q JOIN quotation_versions v ON v.quotation_id = q.id AND v.version_no = q.current_version LEFT JOIN users u ON u.id = q.owner_id
       WHERE substr(q.created_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))}`,
      from, to,
    );
    const byOwner = Object.values(quotes.reduce((acc, q) => {
      const k = q.owner || 'Unassigned';
      acc[k] ||= { dimension: k, group: 'By salesperson', quotes: 0, value: 0, disc_w: 0, margin_w: 0, cost_base: 0, needing_approval: 0, below_min: 0, won: 0, won_disc_w: 0, won_value: 0 };
      const a = acc[k];
      a.quotes++;
      a.value += q.taxable_total;
      a.disc_w += q.discount_pct * q.taxable_total;
      if (q.margin_pct !== null) {
        a.margin_w += q.margin_pct * q.taxable_total;
        a.cost_base += q.taxable_total;
      }
      if (q.approval_role) a.needing_approval++;
      if (q.below_min_price) a.below_min++;
      if (['accepted', 'converted'].includes(q.status)) {
        a.won++;
        a.won_disc_w += q.discount_pct * q.taxable_total;
        a.won_value += q.taxable_total;
      }
      return acc;
    }, {})).map((a) => ({
      dimension: a.dimension, group: a.group, quotes: a.quotes, value: a.value,
      avg_discount: a.value ? Math.round((a.disc_w / a.value) * 10) / 10 : 0,
      margin_pct: a.cost_base ? Math.round((a.margin_w / a.cost_base) * 10) / 10 : null,
      won_discount: a.won_value ? Math.round((a.won_disc_w / a.won_value) * 10) / 10 : null,
      needing_approval: a.needing_approval, below_min: a.below_min,
    }));
    const byCategory = all(
      `SELECT pc.name AS dimension, 'By product category' AS "group", COUNT(DISTINCT q.id) AS quotes, COALESCE(SUM(qi.taxable), 0) AS value,
              ROUND(100.0 * (SUM(qi.qty * qi.list_price) - SUM(qi.taxable)) / NULLIF(SUM(qi.qty * qi.list_price), 0), 1) AS avg_discount,
              ROUND(100.0 * (SUM(qi.taxable) - SUM(qi.qty * qi.cost_price)) / NULLIF(SUM(qi.taxable), 0), 1) AS margin_pct
       FROM quotation_items qi JOIN quotation_versions v ON v.id = qi.version_id JOIN quotations q ON q.id = v.quotation_id AND v.version_no = q.current_version
       JOIN products p ON p.id = qi.product_id JOIN product_categories pc ON pc.id = p.category_id
       WHERE substr(q.created_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))} GROUP BY pc.id ORDER BY value DESC`,
      from, to,
    );
    const totalValue = quotes.reduce((s, q) => s + q.taxable_total, 0);
    return {
      kpis: [
        { label: 'Quotations', value: quotes.length, format: 'number' },
        { label: 'Weighted avg discount', value: totalValue ? Math.round((quotes.reduce((s, q) => s + q.discount_pct * q.taxable_total, 0) / totalValue) * 10) / 10 : 0, format: 'pct' },
        { label: 'Weighted margin', value: totalValue ? Math.round((quotes.filter((q) => q.margin_pct !== null).reduce((s, q) => s + q.margin_pct * q.taxable_total, 0) / totalValue) * 10) / 10 : 0, format: 'pct', key: 'margin_pct' },
        { label: 'Needed approval', value: quotes.filter((q) => q.approval_role).length, format: 'number' },
      ],
      chart: { type: 'bar', x: 'dimension', series: [{ key: 'avg_discount', label: 'Avg discount %' }, { key: 'margin_pct', label: 'Margin %' }], filter: { group: 'By salesperson' }, format: 'pct' },
      columns: [col('group', 'View'), col('dimension', 'Segment'), col('quotes', 'Quotes', 'number'), col('value', 'Quoted value', 'currency'), col('avg_discount', 'Avg discount', 'pct'), col('won_discount', 'Discount on won', 'pct'), col('margin_pct', 'Margin', 'pct'), col('needing_approval', 'Needed approval', 'number'), col('below_min', 'Below min price', 'number')],
      rows: [...byOwner, ...byCategory],
    };
  },

  forecast({ user }) {
    const t = today();
    const leads = all(
      `SELECT l.id, l.code, l.title, l.stage, l.probability, l.estimated_value, l.expected_close_date, c.name AS customer_name, u.name AS owner
       FROM leads l JOIN customers c ON c.id = l.customer_id LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.status = 'open' AND l.expected_close_date IS NOT NULL AND l.expected_close_date <= ? ${and(leadScope(user, 'l'))}`,
      addDays(t, 90),
    );
    const bucket = (d) => (d <= addDays(t, 30) ? '0-30 days' : d <= addDays(t, 60) ? '31-60 days' : '61-90 days');
    const buckets = ['0-30 days', '31-60 days', '61-90 days'].map((b) => {
      const list = leads.filter((l) => bucket(l.expected_close_date) === b);
      return {
        window: b, deals: list.length, pipeline_value: list.reduce((s, l) => s + l.estimated_value, 0),
        weighted_value: Math.round(list.reduce((s, l) => s + (l.estimated_value * l.probability) / 100, 0)),
        commit_value: list.filter((l) => l.probability >= 65).reduce((s, l) => s + l.estimated_value, 0),
      };
    });
    const overdue = leads.filter((l) => l.expected_close_date < t);
    const deliveries = all(`SELECT o.*, ${ORDER_ROLLUP} FROM sales_orders o WHERE o.status = 'active' ${and(orderScope(user, 'o'))}`).map(decorateOrder)
      .filter((o) => o.dispatch_status !== 'delivered' && o.delivery_date && o.delivery_date <= addDays(t, 90));
    return {
      kpis: [
        { label: 'Weighted 30 days', value: buckets[0].weighted_value, format: 'currency' },
        { label: 'Weighted 60 days', value: buckets[0].weighted_value + buckets[1].weighted_value, format: 'currency' },
        { label: 'Weighted 90 days', value: buckets.reduce((s, b) => s + b.weighted_value, 0), format: 'currency' },
        { label: 'Close date passed', value: overdue.length, format: 'number' },
        { label: 'Invoicing from deliveries (90d)', value: deliveries.reduce((s, o) => s + Math.max(0, o.grand_total - o.invoiced), 0), format: 'currency' },
      ],
      chart: { type: 'bar', x: 'window', series: [{ key: 'pipeline_value', label: 'Pipeline' }, { key: 'weighted_value', label: 'Weighted' }, { key: 'commit_value', label: 'Commit (≥65%)' }], format: 'currency' },
      columns: [col('window', 'Closing window'), col('deals', 'Deals', 'number'), col('pipeline_value', 'Pipeline value', 'currency'), col('weighted_value', 'Weighted value', 'currency'), col('commit_value', 'Commit value', 'currency')],
      rows: buckets,
      detail: {
        title: 'Deals in the forecast',
        columns: [col('code', 'Lead'), col('customer_name', 'Customer'), col('title', 'Opportunity'), col('owner', 'Owner'), col('expected_close_date', 'Expected close', 'date'), col('probability', 'Probability', 'pct'), col('estimated_value', 'Value', 'currency')],
        rows: leads.sort((a, b) => a.expected_close_date.localeCompare(b.expected_close_date)).map((l) => ({ ...l, link: `/leads/${l.id}` })),
      },
    };
  },

  region_revenue({ from, to, user }) {
    const os = orderScope(user, 'o');
    const rows = all(
      `SELECT rg.name AS region, COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.customer_id) AS customers, COALESCE(SUM(o.taxable_total), 0) AS revenue,
              COALESCE(SUM(o.grand_total), 0) AS order_value
       FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN regions rg ON rg.id = c.region_id
       WHERE o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(os)} GROUP BY rg.id ORDER BY revenue DESC`,
      from, to,
    );
    const money = all(
      `SELECT rg.name AS region,
              COALESCE((SELECT SUM(i.total) FROM invoices i JOIN customers c2 ON c2.id = i.customer_id WHERE c2.region_id = rg.id AND i.invoice_date BETWEEN ? AND ?), 0) AS invoiced,
              COALESCE((SELECT SUM(p.amount) FROM payments p JOIN customers c2 ON c2.id = p.customer_id WHERE c2.region_id = rg.id AND p.payment_date BETWEEN ? AND ?), 0) AS collected,
              COALESCE((SELECT SUM(i.balance) FROM invoice_balances i JOIN customers c2 ON c2.id = i.customer_id WHERE c2.region_id = rg.id AND i.balance > 1), 0) AS outstanding
       FROM regions rg`,
      from, to, from, to,
    );
    const states = all(
      `SELECT c.state, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.taxable_total), 0) AS revenue FROM sales_orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(os)} GROUP BY c.state ORDER BY revenue DESC`,
      from, to,
    );
    const total = rows.reduce((s, x) => s + x.revenue, 0);
    return {
      kpis: [{ label: 'Revenue (ex-GST)', value: total, format: 'currency' }, { label: 'Orders', value: rows.reduce((s, x) => s + x.orders, 0), format: 'number' }],
      chart: { type: 'bar', x: 'region', series: [{ key: 'revenue', label: 'Revenue' }, { key: 'collected', label: 'Collected' }], format: 'currency' },
      columns: [col('region', 'Region'), col('orders', 'Orders', 'number'), col('customers', 'Customers', 'number'), col('revenue', 'Revenue (ex-GST)', 'currency'), col('share_pct', 'Share', 'pct'), col('invoiced', 'Invoiced', 'currency'), col('collected', 'Collected', 'currency'), col('outstanding', 'Outstanding', 'currency')],
      rows: rows.map((x) => ({ ...x, ...money.find((m) => m.region === x.region), share_pct: pct(x.revenue, total) })),
      detail: { title: 'By state', columns: [col('state', 'State'), col('orders', 'Orders', 'number'), col('revenue', 'Revenue', 'currency')], rows: states },
    };
  },

  product_demand({ from, to, user }) {
    const rows = all(
      `SELECT p.id, p.sku, p.name, pc.name AS category,
              COALESCE((SELECT SUM(qi.qty) FROM quotation_items qi JOIN quotation_versions v ON v.id = qi.version_id JOIN quotations q ON q.id = v.quotation_id AND v.version_no = q.current_version
                        WHERE qi.product_id = p.id AND q.sent_at IS NOT NULL AND substr(q.sent_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))}), 0) AS qty_quoted,
              COALESCE((SELECT SUM(qi.taxable) FROM quotation_items qi JOIN quotation_versions v ON v.id = qi.version_id JOIN quotations q ON q.id = v.quotation_id AND v.version_no = q.current_version
                        WHERE qi.product_id = p.id AND q.sent_at IS NOT NULL AND substr(q.sent_at, 1, 10) BETWEEN ? AND ? ${and(quotationScope(user, 'q'))}), 0) AS quoted_value,
              COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN sales_orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(orderScope(user, 'o'))}), 0) AS qty_ordered,
              COALESCE((SELECT SUM(oi.taxable) FROM order_items oi JOIN sales_orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(orderScope(user, 'o'))}), 0) AS revenue,
              (SELECT COUNT(*) FROM leads l WHERE (l.product_id = p.id) AND substr(l.created_at, 1, 10) BETWEEN ? AND ?) AS enquiries
       FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id
       ORDER BY revenue DESC`,
      from, to, from, to, from, to, from, to, from, to,
    ).filter((x) => x.qty_quoted || x.qty_ordered || x.enquiries).map((x) => ({ ...x, hit_rate_pct: pct(x.qty_ordered, x.qty_quoted) }));
    return {
      kpis: [{ label: 'Products sold', value: rows.filter((x) => x.qty_ordered).length, format: 'number' }, { label: 'Revenue', value: rows.reduce((s, x) => s + x.revenue, 0), format: 'currency' }],
      chart: { type: 'bar', x: 'name', series: [{ key: 'quoted_value', label: 'Quoted' }, { key: 'revenue', label: 'Ordered' }], format: 'currency', limit: 10 },
      columns: [col('sku', 'SKU'), col('name', 'Product'), col('category', 'Category'), col('enquiries', 'Enquiries', 'number'), col('qty_quoted', 'Qty quoted', 'number'), col('quoted_value', 'Quoted value', 'currency'), col('qty_ordered', 'Qty ordered', 'number'), col('revenue', 'Revenue', 'currency'), col('hit_rate_pct', 'Qty hit rate', 'pct')],
      rows,
    };
  },

  top_customers({ from, to, user }) {
    const rows = all(
      `SELECT c.id, c.name, c.customer_type, c.city, c.value_category, u.name AS owner, COUNT(o.id) AS orders, COALESCE(SUM(o.taxable_total), 0) AS revenue,
              MAX(o.order_date) AS last_order, (SELECT COALESCE(SUM(balance), 0) FROM invoice_balances i WHERE i.customer_id = c.id AND i.balance > 1) AS outstanding
       FROM customers c JOIN sales_orders o ON o.customer_id = c.id AND o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ?
       LEFT JOIN users u ON u.id = c.assigned_to WHERE 1 = 1 ${and(customerScope(user, 'c'))}
       GROUP BY c.id ORDER BY revenue DESC LIMIT 50`,
      from, to,
    );
    const total = get(`SELECT COALESCE(SUM(o.taxable_total), 0) AS v FROM sales_orders o WHERE o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(orderScope(user, 'o'))}`, from, to).v;
    let running = 0;
    return {
      kpis: [
        { label: 'Top 10 share', value: pct(rows.slice(0, 10).reduce((s, x) => s + x.revenue, 0), total), format: 'pct' },
        { label: 'Customers billed', value: rows.length, format: 'number' },
      ],
      chart: { type: 'bar', x: 'name', series: [{ key: 'revenue', label: 'Revenue' }], format: 'currency', limit: 12, horizontal: true },
      columns: [col('rank', '#', 'number'), col('name', 'Customer'), col('customer_type', 'Type', 'customer_type'), col('city', 'City'), col('owner', 'Owner'), col('orders', 'Orders', 'number'), col('revenue', 'Revenue', 'currency'), col('share_pct', 'Share', 'pct'), col('cumulative_pct', 'Cumulative', 'pct'), col('last_order', 'Last order', 'date'), col('outstanding', 'Outstanding', 'currency')],
      rows: rows.map((x, i) => {
        running += x.revenue;
        return { ...x, rank: i + 1, share_pct: pct(x.revenue, total), cumulative_pct: pct(running, total), link: `/customers/${x.id}` };
      }),
    };
  },

  repeat_orders({ user }) {
    const customers = all(
      `SELECT c.id, c.name, c.customer_type, COUNT(o.id) AS orders, MIN(o.order_date) AS first_order, MAX(o.order_date) AS last_order, COALESCE(SUM(o.taxable_total), 0) AS revenue
       FROM customers c JOIN sales_orders o ON o.customer_id = c.id AND o.status <> 'cancelled' WHERE 1 = 1 ${and(customerScope(user, 'c'))} GROUP BY c.id`,
    );
    const byType = Object.values(customers.reduce((acc, c) => {
      const k = c.customer_type;
      acc[k] ||= { segment: labelOf(CUSTOMER_TYPES, k), customers: 0, repeat_customers: 0, revenue: 0, repeat_revenue: 0 };
      acc[k].customers++;
      acc[k].revenue += c.revenue;
      if (c.orders > 1) {
        acc[k].repeat_customers++;
        acc[k].repeat_revenue += c.revenue;
      }
      return acc;
    }, {})).map((x) => ({ ...x, repeat_rate_pct: pct(x.repeat_customers, x.customers), repeat_revenue_pct: pct(x.repeat_revenue, x.revenue) }));
    const repeaters = customers.filter((c) => c.orders > 1);
    return {
      kpis: [
        { label: 'Customers with orders', value: customers.length, format: 'number' },
        { label: 'Repeat customers', value: repeaters.length, format: 'number' },
        { label: 'Repeat-order rate', value: pct(repeaters.length, customers.length), format: 'pct' },
        { label: 'Revenue from repeat customers', value: pct(repeaters.reduce((s, c) => s + c.revenue, 0), customers.reduce((s, c) => s + c.revenue, 0)), format: 'pct' },
        { label: 'Avg reorder cycle', value: repeaters.length ? Math.round(repeaters.reduce((s, c) => s + daysBetween(c.first_order, c.last_order) / (c.orders - 1), 0) / repeaters.length) : 0, format: 'days' },
      ],
      chart: { type: 'bar', x: 'segment', series: [{ key: 'repeat_rate_pct', label: 'Repeat rate %' }], format: 'pct' },
      columns: [col('segment', 'Customer type'), col('customers', 'Customers', 'number'), col('repeat_customers', 'Repeat', 'number'), col('repeat_rate_pct', 'Repeat rate', 'pct'), col('revenue', 'Revenue', 'currency'), col('repeat_revenue_pct', 'Revenue from repeat', 'pct')],
      rows: byType,
      detail: {
        title: 'Repeat customers',
        columns: [col('name', 'Customer'), col('orders', 'Orders', 'number'), col('first_order', 'First order', 'date'), col('last_order', 'Last order', 'date'), col('cycle', 'Avg cycle', 'days'), col('revenue', 'Revenue', 'currency')],
        rows: repeaters.sort((a, b) => b.orders - a.orders).map((c) => ({ ...c, cycle: Math.round(daysBetween(c.first_order, c.last_order) / (c.orders - 1)), link: `/customers/${c.id}` })),
      },
    };
  },

  dormant_customers({ user }) {
    const rem = computeReminders(user);
    const rows = rem.dormant_customers.map((c) => ({ ...c, link: `/customers/${c.id}` }));
    return {
      kpis: [
        { label: 'Dormant customers', value: rows.length, format: 'number' },
        { label: 'Their lifetime value', value: rows.reduce((s, c) => s + c.lifetime_value, 0), format: 'currency' },
        { label: 'Repeat orders due now', value: rem.repeat_opportunities.length, format: 'number' },
      ],
      columns: [col('name', 'Customer'), col('owner_name', 'Owner'), col('orders', 'Orders', 'number'), col('last_order', 'Last order', 'date'), col('days', 'Days since', 'days'), col('lifetime_value', 'Lifetime value', 'currency'), col('has_open_lead', 'Open lead', 'bool')],
      rows,
      detail: {
        title: 'Repeat-order opportunities (past usual reorder cycle)',
        columns: [col('name', 'Customer'), col('owner_name', 'Owner'), col('orders', 'Orders', 'number'), col('cycle', 'Usual cycle', 'days'), col('days', 'Days since last', 'days'), col('lifetime_value', 'Lifetime value', 'currency')],
        rows: rem.repeat_opportunities.map((c) => ({ ...c, link: `/customers/${c.id}` })),
      },
    };
  },

  payment_ageing({ user }) {
    const t = today();
    const inv = all(
      `SELECT i.*, c.name AS customer_name, u.name AS owner FROM invoice_balances i JOIN customers c ON c.id = i.customer_id LEFT JOIN users u ON u.id = c.assigned_to
       WHERE i.balance > 1 ${and(customerScope(user, 'c'))}`,
    );
    const map = {};
    for (const i of inv) {
      const row = (map[i.customer_id] ||= { id: i.customer_id, customer_name: i.customer_name, owner: i.owner, invoices: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, balance: 0, overdue: 0 });
      row[ageingBucket(i.invoice_date)] += i.balance;
      row.balance += i.balance;
      row.invoices++;
      if (i.due_date < t) row.overdue += i.balance;
    }
    const rows = Object.values(map).sort((a, b) => b.balance - a.balance).map((x) => ({ ...x, link: `/customers/${x.id}` }));
    const sum = (k) => rows.reduce((s, x) => s + x[k], 0);
    return {
      kpis: [
        { label: 'Outstanding', value: sum('balance'), format: 'currency' }, { label: 'Overdue', value: sum('overdue'), format: 'currency' },
        { label: '0-30 days', value: sum('d0_30'), format: 'currency' }, { label: '31-60 days', value: sum('d31_60'), format: 'currency' },
        { label: '61-90 days', value: sum('d61_90'), format: 'currency' }, { label: '90+ days', value: sum('d90_plus'), format: 'currency' },
      ],
      chart: { type: 'stacked', x: 'customer_name', series: [{ key: 'd0_30', label: '0-30' }, { key: 'd31_60', label: '31-60' }, { key: 'd61_90', label: '61-90' }, { key: 'd90_plus', label: '90+' }], format: 'currency', limit: 12, horizontal: true },
      columns: [col('customer_name', 'Customer'), col('owner', 'Owner'), col('invoices', 'Invoices', 'number'), col('d0_30', '0-30', 'currency'), col('d31_60', '31-60', 'currency'), col('d61_90', '61-90', 'currency'), col('d90_plus', '90+', 'currency'), col('balance', 'Total', 'currency'), col('overdue', 'Overdue', 'currency')],
      rows,
    };
  },

  order_delays({ from, to, user }) {
    const orders = all(
      `SELECT o.*, c.name AS customer_name, f.name AS factory, p.planned_completion, p.actual_completion, ${ORDER_ROLLUP}
       FROM sales_orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN factories f ON f.id = o.factory_id LEFT JOIN production p ON p.order_id = o.id
       WHERE o.status <> 'cancelled' AND o.order_date BETWEEN ? AND ? ${and(orderScope(user, 'o'))}`,
      from, to,
    ).map(decorateOrder);
    const delivered = orders.filter((o) => o.delivered_at);
    const late = delivered.filter((o) => o.expected_delivery_date && o.delivered_at.slice(0, 10) > o.expected_delivery_date)
      .map((o) => ({ ...o, late_days: daysBetween(o.expected_delivery_date, o.delivered_at) }));
    const currentlyDelayed = orders.filter((o) => o.is_delayed);
    const reasons = Object.values([...late, ...currentlyDelayed].reduce((acc, o) => {
      const k = o.delay_reason || 'Reason not recorded';
      acc[k] ||= { reason: k, orders: 0, total_days: 0 };
      acc[k].orders++;
      acc[k].total_days += o.late_days || o.delay_days;
      return acc;
    }, {})).map((x) => ({ ...x, avg_days: Math.round(x.total_days / x.orders) })).sort((a, b) => b.orders - a.orders);
    return {
      kpis: [
        { label: 'Delivered', value: delivered.length, format: 'number' },
        { label: 'On-time delivery', value: pct(delivered.length - late.length, delivered.length), format: 'pct' },
        { label: 'Avg delay when late', value: late.length ? Math.round(late.reduce((s, o) => s + o.late_days, 0) / late.length) : 0, format: 'days' },
        { label: 'Currently delayed', value: currentlyDelayed.length, format: 'number' },
      ],
      chart: { type: 'bar', x: 'reason', series: [{ key: 'orders', label: 'Orders' }], horizontal: true },
      columns: [col('reason', 'Delay reason'), col('orders', 'Orders', 'number'), col('avg_days', 'Avg days late', 'days')],
      rows: reasons,
      detail: {
        title: 'Currently delayed orders',
        columns: [col('number', 'Order'), col('customer_name', 'Customer'), col('stage', 'Stage', 'order_stage'), col('factory', 'Factory'), col('delivery_date', 'Committed', 'date'), col('delay_days', 'Days late', 'days'), col('delay_reason', 'Reason')],
        rows: currentlyDelayed.sort((a, b) => b.delay_days - a.delay_days).map((o) => ({ ...o, link: `/orders/${o.id}` })),
      },
    };
  },

  complaint_trends({ from, to }) {
    const byMonth = all(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS opened, SUM(resolved_at IS NOT NULL) AS resolved,
              ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN julianday(resolved_at) - julianday(created_at) END), 1) AS avg_resolution_days,
              ROUND(AVG(feedback_rating), 1) AS avg_rating
       FROM complaints WHERE substr(created_at, 1, 10) BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`,
      from, to,
    );
    const byCategory = all(`SELECT category, COUNT(*) AS count FROM complaints WHERE substr(created_at, 1, 10) BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC`, from, to)
      .map((x) => ({ ...x, label: labelOf(COMPLAINT_CATEGORIES, x.category) }));
    const byProduct = all(
      `SELECT p.name AS product, COUNT(*) AS complaints, COUNT(DISTINCT k.customer_id) AS customers, GROUP_CONCAT(DISTINCT k.root_cause) AS root_causes
       FROM complaints k JOIN products p ON p.id = k.product_id WHERE substr(k.created_at, 1, 10) BETWEEN ? AND ? GROUP BY p.id ORDER BY complaints DESC`,
      from, to,
    );
    return {
      kpis: [
        { label: 'Complaints', value: byMonth.reduce((s, x) => s + x.opened, 0), format: 'number' },
        { label: 'Resolved', value: byMonth.reduce((s, x) => s + x.resolved, 0), format: 'number' },
        ...byCategory.slice(0, 1).map((c) => ({ label: `Top issue: ${c.label}`, value: c.count, format: 'number' })),
      ],
      chart: { type: 'line', x: 'month', series: [{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved' }] },
      columns: [col('month', 'Month', 'month'), col('opened', 'Opened', 'number'), col('resolved', 'Resolved', 'number'), col('avg_resolution_days', 'Avg resolution', 'days'), col('avg_rating', 'Avg rating', 'decimal')],
      rows: byMonth,
      detail: { title: 'By product', columns: [col('product', 'Product'), col('complaints', 'Complaints', 'number'), col('customers', 'Customers', 'number'), col('root_causes', 'Root causes')], rows: byProduct },
    };
  },

  summaries() {
    const rows = all('SELECT * FROM summaries ORDER BY period_key DESC, period LIMIT 60').map((s) => ({ period: s.period, period_key: s.period_key, ...JSON.parse(s.data) }));
    return {
      columns: [col('period', 'Period'), col('period_key', 'From', 'date'), col('new_leads', 'New leads', 'number'), col('quotations_sent', 'Quotes sent', 'number'), col('quotations_value', 'Quoted', 'currency'), col('orders_booked', 'Orders', 'number'), col('order_value', 'Order value', 'currency'), col('dispatches', 'Dispatches', 'number'), col('collections', 'Collected', 'currency'), col('complaints_opened', 'Complaints', 'number'), col('delayed_orders', 'Delayed', 'number'), col('overdue_followups', 'Overdue F/U', 'number'), col('outstanding', 'Outstanding', 'currency')],
      rows,
    };
  },
};

r.get('/reports', allow('reports.view'), (_req, res) => res.json(REPORTS));

r.get('/reports/:key', allow('reports.view'), (req, res) => {
  const build = builders[req.params.key];
  if (!build) throw badRequest('Unknown report');
  const from = req.query.from || fyStart(today());
  const to = req.query.to || today();
  const data = build({ from, to, user: req.user });
  const meta = REPORTS.find((x) => x.key === req.params.key);
  res.json(redact(req.user, { ...meta, from, to, ...data }));
});

export default r;
