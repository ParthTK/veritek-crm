// Exhibitions & campaigns: a page per event with its enquiry funnel, quotations, orders, revenue and cost.
// Values are kept per currency; ROI is shown only where cost and revenue are in the same currency.
import { all, get, insert, run, tx, update } from '../db.js';
import {
  Check, notFound, nowIso, today, str, intId, audit, placeholders,
} from '../util.js';
import {
  CAMPAIGN_TYPES, CAMPAIGN_STATUSES, CURRENCIES, OPEN_ENQUIRY_STAGES, VISIT_OUTCOMES, labelOf,
} from '../../shared/constants.js';
import { toMinor } from '../../shared/rules.js';
import { assertCustomer, customerScope, enquiryScope } from '../access.js';
import { requireActiveUser } from './people.js';

const OPEN = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
const add = (map, cur, v) => {
  if (cur && v) map[cur] = (map[cur] || 0) + v;
};

/** Funnel and ROI metrics for one campaign, limited to the enquiries the user may see. */
export function campaignMetrics(campaignId, user) {
  const scope = enquiryScope(user, 'e');
  const enquiries = all(`SELECT e.id, e.stage, e.owner_id, e.customer_id, e.first_response_at, e.est_value_minor, e.est_currency FROM enquiries e
    WHERE e.campaign_id = ? ${scope ? `AND ${scope}` : ''}`, campaignId);
  const campaign = get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  const ids = enquiries.map((e) => e.id);
  const none = !ids.length;
  const meetings = none ? 0 : get(`SELECT COUNT(DISTINCT enquiry_id) AS n FROM activities WHERE enquiry_id IN (${placeholders(ids)}) AND channel IN ('meeting','video','factory_visit','exhibition') AND customer_contact = 1`, ids).n;
  const quotes = none ? [] : all(`SELECT r.currency, r.total_minor, q.enquiry_id FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id
    WHERE q.enquiry_id IN (${placeholders(ids)}) AND r.status IN ('issued','accepted','superseded','rejected') AND r.sent_at IS NOT NULL`, ids);
  const latestQuoteByEnquiry = new Map();
  for (const q of quotes) latestQuoteByEnquiry.set(q.enquiry_id, q);
  const quotedValue = {};
  for (const q of latestQuoteByEnquiry.values()) add(quotedValue, q.currency, q.total_minor);
  const orders = none ? [] : all(`SELECT o.id, o.currency, (SELECT SUM(CASE WHEN l.unit_price_minor IS NULL THEN NULL ELSE ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) FROM order_lines l WHERE l.order_id = o.id) AS value_minor
    FROM orders o WHERE o.enquiry_id IN (${placeholders(ids)}) AND o.status = 'confirmed'`, ids);
  const revenue = {};
  for (const o of orders) add(revenue, o.currency, o.value_minor);
  const customerIds = [...new Set(enquiries.map((e) => e.customer_id))];
  const influenced = {};
  if (customerIds.length) {
    for (const o of all(`SELECT o.currency, (SELECT SUM(CASE WHEN l.unit_price_minor IS NULL THEN NULL ELSE ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) FROM order_lines l WHERE l.order_id = o.id) AS value_minor
      FROM orders o WHERE o.customer_id IN (${placeholders(customerIds)}) AND o.status = 'confirmed' AND o.received_date >= ? AND (o.enquiry_id IS NULL ${none ? '' : `OR o.enquiry_id NOT IN (${placeholders(ids)})`})`,
    ...customerIds, campaign?.start_date || '0000-00-00', ...(none ? [] : ids))) add(influenced, o.currency, o.value_minor);
  }
  const pipeline = {};
  for (const e of enquiries.filter((x) => OPEN_ENQUIRY_STAGES.includes(x.stage))) {
    const q = latestQuoteByEnquiry.get(e.id);
    if (q) add(pipeline, q.currency, q.total_minor);
    else add(pipeline, e.est_currency, e.est_value_minor);
  }
  const won = enquiries.filter((e) => e.stage === 'won').length;
  const cost = campaign?.cost_minor ?? null;
  const costCurrency = campaign?.cost_currency || 'INR';
  const custScope = customerScope(user, 'c');
  const visits = get(`SELECT COUNT(*) AS visitors, COALESCE(SUM(CASE WHEN v.enquiry_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_enquiry, COALESCE(SUM(CASE WHEN v.outcome = 'follow_up' AND v.enquiry_id IS NULL THEN 1 ELSE 0 END), 0) AS to_follow_up
    FROM exhibition_visits v JOIN customers c ON c.id = v.customer_id WHERE v.campaign_id = ? ${custScope ? `AND ${custScope}` : ''}`, campaignId);
  return {
    visitors: visits.visitors,
    visitors_with_enquiry: visits.with_enquiry,
    visitors_to_follow_up: visits.to_follow_up,
    enquiries: enquiries.length,
    assigned: enquiries.filter((e) => e.owner_id).length,
    contacted: enquiries.filter((e) => e.first_response_at).length,
    meetings,
    qualified: enquiries.filter((e) => !['new', 'clarification', 'cancelled'].includes(e.stage)).length,
    quoted: latestQuoteByEnquiry.size,
    quoted_value: quotedValue,
    orders: orders.length,
    won,
    lost: enquiries.filter((e) => e.stage === 'lost').length,
    open: enquiries.filter((e) => OPEN_ENQUIRY_STAGES.includes(e.stage)).length,
    pipeline,
    revenue,
    influenced_revenue: influenced,
    conversion_pct: enquiries.length ? Math.round((won / enquiries.length) * 1000) / 10 : null,
    cost_minor: cost,
    cost_currency: costCurrency,
    roi_multiple: cost && revenue[costCurrency] ? Math.round((revenue[costCurrency] / cost) * 10) / 10 : null,
    cost_per_enquiry_minor: cost && enquiries.length ? Math.round(cost / enquiries.length) : null,
    target_progress_pct: campaign?.target_leads ? Math.round((enquiries.length / campaign.target_leads) * 100) : null,
  };
}

export function listCampaigns(query, user) {
  const where = ['1 = 1'];
  const params = [];
  if (query.status) {
    where.push('c.status = ?');
    params.push(query.status);
  }
  if (query.type) {
    where.push('c.type = ?');
    params.push(query.type);
  }
  return all(`SELECT c.*, u.name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(c.start_date, c.created_at) DESC`, ...params)
    .map((c) => ({ ...c, type_label: labelOf(CAMPAIGN_TYPES, c.type), status_label: labelOf(CAMPAIGN_STATUSES, c.status), metrics: campaignMetrics(c.id, user) }));
}

export function campaignDetail(id, user) {
  const c = get('SELECT c.*, u.name AS owner_name FROM campaigns c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', id);
  if (!c) throw notFound('Campaign');
  const scope = enquiryScope(user, 'e');
  const enquiries = all(`SELECT e.id, e.code, e.title, e.stage, e.received_at, e.est_value_minor, e.est_currency, e.first_response_at, cu.company_name AS customer_name, cu.city, u.name AS owner_name, e.owner_id,
      (SELECT COUNT(*) FROM activities a WHERE a.enquiry_id = e.id AND a.customer_contact = 1) AS contacts,
      (SELECT COUNT(*) FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE q.enquiry_id = e.id AND r.sent_at IS NOT NULL) AS quotes,
      (SELECT COALESCE(p.code, el.requirement, 'Unspecified') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort LIMIT 1) AS product
    FROM enquiries e JOIN customers cu ON cu.id = e.customer_id LEFT JOIN users u ON u.id = e.owner_id
    WHERE e.campaign_id = ? ${scope ? `AND ${scope}` : ''} ORDER BY e.received_at DESC`, id);
  const bySalesperson = Object.values(enquiries.reduce((acc, e) => {
    const key = e.owner_name || 'Unassigned';
    acc[key] ||= { name: key, enquiries: 0, contacted: 0, quoted: 0, won: 0, lost: 0, open: 0 };
    acc[key].enquiries++;
    if (e.first_response_at) acc[key].contacted++;
    if (e.quotes) acc[key].quoted++;
    if (e.stage === 'won') acc[key].won++;
    else if (e.stage === 'lost') acc[key].lost++;
    else if (OPEN_ENQUIRY_STAGES.includes(e.stage)) acc[key].open++;
    return acc;
  }, {}));
  return {
    campaign: { ...c, type_label: labelOf(CAMPAIGN_TYPES, c.type), status_label: labelOf(CAMPAIGN_STATUSES, c.status) },
    metrics: campaignMetrics(id, user),
    enquiries,
    visits: exhibitionVisits(id, user),
    by_salesperson: bySalesperson,
  };
}

// ------------------------------------------------------------------ customers met at an exhibition
export function exhibitionVisits(campaignId, user) {
  const scope = customerScope(user, 'c');
  return all(`SELECT v.*, c.company_name AS customer_name, c.city, ct.name AS contact_name, ct.phone_raw AS contact_phone, u.name AS met_by_name, e.code AS enquiry_code, e.stage AS enquiry_stage
    FROM exhibition_visits v JOIN customers c ON c.id = v.customer_id LEFT JOIN contacts ct ON ct.id = v.contact_id LEFT JOIN users u ON u.id = v.met_by LEFT JOIN enquiries e ON e.id = v.enquiry_id
    WHERE v.campaign_id = ? ${scope ? `AND ${scope}` : ''} ORDER BY v.visited_on DESC, c.company_name`, campaignId)
    .map((v) => ({ ...v, outcome_label: labelOf(VISIT_OUTCOMES, v.outcome) }));
}

/** The date to record for a visit: the given day, kept inside the exhibition's dates when they are known. */
function visitDay(campaign, date) {
  let d = date || today();
  if (campaign.end_date && d > campaign.end_date) d = campaign.end_date;
  if (campaign.start_date && d < campaign.start_date) d = campaign.start_date;
  return d;
}

export function saveVisit(campaignId, visitId, input, user) {
  const campaign = get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  if (!campaign) throw notFound('Exhibition');
  const cur = visitId ? get('SELECT * FROM exhibition_visits WHERE id = ? AND campaign_id = ?', visitId, campaignId) : null;
  if (visitId && !cur) throw notFound('Visit');
  const c = new Check();
  const customerId = cur ? cur.customer_id : intId(input.customer_id);
  if (!customerId) c.fail('customer_id', 'Choose the customer who visited');
  else {
    const customer = get('SELECT id, merged_into_id FROM customers WHERE id = ?', customerId);
    if (!customer) c.fail('customer_id', 'Customer not found');
    else if (customer.merged_into_id) c.fail('customer_id', 'This profile was merged — choose the surviving customer');
    else assertCustomer(user, customerId);
    if (!cur && get('SELECT id FROM exhibition_visits WHERE campaign_id = ? AND customer_id = ?', campaignId, customerId)) c.fail('customer_id', 'This customer is already recorded for this exhibition');
  }
  const contactId = input.contact_id !== undefined ? intId(input.contact_id) : cur?.contact_id ?? null;
  if (contactId && customerId && !get('SELECT id FROM contacts WHERE id = ? AND customer_id = ?', contactId, customerId)) c.fail('contact_id', 'Choose a contact of this customer');
  c.date('visited_on', input.visited_on);
  const outcome = input.outcome ?? cur?.outcome ?? 'follow_up';
  if (!VISIT_OUTCOMES.some((o) => o.value === outcome)) c.fail('outcome', 'Choose an outcome');
  const metBy = input.met_by !== undefined ? intId(input.met_by) : cur?.met_by ?? user.id;
  if (metBy) requireActiveUser(c, 'met_by', metBy, 'Met by');
  c.text('interest', input.interest, { max: 200, label: 'Interested in' });
  c.note('notes', input.notes);
  c.throwIfAny();
  const stamp = nowIso();
  const data = {
    contact_id: contactId, visited_on: input.visited_on || cur?.visited_on || visitDay(campaign), met_by: metBy, outcome,
    interest: input.interest !== undefined ? str(input.interest, 200) : cur?.interest ?? null, notes: input.notes !== undefined ? str(input.notes, 1000) : cur?.notes ?? null, updated_at: stamp,
  };
  return tx(() => {
    if (cur) {
      update('exhibition_visits', cur.id, { ...data, outcome: cur.enquiry_id ? 'enquiry' : outcome });
      audit('campaign', campaignId, 'visit_updated', { customer_id: customerId });
      return { id: cur.id };
    }
    const enquiry = get('SELECT id FROM enquiries WHERE campaign_id = ? AND customer_id = ? ORDER BY id DESC LIMIT 1', campaignId, customerId);
    const newId = insert('exhibition_visits', {
      ...data, campaign_id: campaignId, customer_id: customerId, enquiry_id: enquiry?.id ?? null, outcome: enquiry ? 'enquiry' : outcome, created_by: user.id, created_at: stamp,
    });
    audit('campaign', campaignId, 'visit_added', { customer_id: customerId });
    return { id: newId };
  });
}

export function deleteVisit(campaignId, visitId, user) {
  const v = get('SELECT * FROM exhibition_visits WHERE id = ? AND campaign_id = ?', visitId, campaignId);
  if (!v) throw notFound('Visit');
  assertCustomer(user, v.customer_id);
  return tx(() => {
    run('DELETE FROM exhibition_visits WHERE id = ?', visitId);
    audit('campaign', campaignId, 'visit_removed', { customer_id: v.customer_id });
    return { ok: true };
  });
}

/** An enquiry tagged to an exhibition means that customer met us there: record or complete their visit. */
export function linkVisitToEnquiry({ campaignId, customerId, contactId, enquiryId, receivedAt }, user) {
  const campaign = get('SELECT * FROM campaigns WHERE id = ?', campaignId);
  if (campaign?.type !== 'exhibition') return;
  const stamp = nowIso();
  const visit = get('SELECT id, enquiry_id FROM exhibition_visits WHERE campaign_id = ? AND customer_id = ?', campaignId, customerId);
  if (visit) {
    if (!visit.enquiry_id) update('exhibition_visits', visit.id, { enquiry_id: enquiryId, outcome: 'enquiry', updated_at: stamp });
    return;
  }
  insert('exhibition_visits', {
    campaign_id: campaignId, customer_id: customerId, contact_id: contactId ?? null, visited_on: visitDay(campaign, String(receivedAt).slice(0, 10)), met_by: user?.id ?? null,
    outcome: 'enquiry', enquiry_id: enquiryId, created_by: user?.id ?? null, created_at: stamp, updated_at: stamp,
  });
}

export function saveCampaign(id, input, user) {
  const cur = id ? get('SELECT * FROM campaigns WHERE id = ?', id) : null;
  if (id && !cur) throw notFound('Campaign');
  const c = new Check();
  c.text('name', input.name ?? cur?.name, { required: true, max: 160, label: 'Campaign name' });
  const type = input.type ?? cur?.type ?? 'exhibition';
  if (!CAMPAIGN_TYPES.some((t) => t.value === type)) c.fail('type', 'Choose a type');
  const status = input.status ?? cur?.status ?? 'planned';
  if (!CAMPAIGN_STATUSES.some((s) => s.value === status)) c.fail('status', 'Choose a status');
  c.date('start_date', input.start_date);
  c.date('end_date', input.end_date);
  const start = input.start_date ?? cur?.start_date;
  const end = input.end_date ?? cur?.end_date;
  if (start && end && end < start) c.fail('end_date', 'The end date cannot be before the start');
  let cost;
  if (input.cost !== undefined) {
    cost = input.cost === '' || input.cost === null ? null : toMinor(input.cost);
    if (Number.isNaN(cost) || (cost !== null && cost < 0)) c.fail('cost', 'Enter a valid amount');
  }
  const currency = input.cost_currency ?? cur?.cost_currency ?? 'INR';
  if (!CURRENCIES.includes(currency)) c.fail('cost_currency', 'Choose a currency');
  if (input.target_leads !== undefined && input.target_leads !== '' && input.target_leads !== null && (!Number.isInteger(Number(input.target_leads)) || Number(input.target_leads) < 0)) c.fail('target_leads', 'Enter a whole number');
  if (input.owner_id) requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Owner');
  c.throwIfAny();
  const stamp = nowIso();
  const data = {
    name: str(input.name ?? cur?.name, 160), type, status, location: input.location !== undefined ? str(input.location, 160) : cur?.location ?? null,
    start_date: start || null, end_date: end || null, cost_minor: cost !== undefined ? cost : cur?.cost_minor ?? null, cost_currency: currency,
    target_leads: input.target_leads !== undefined ? (input.target_leads === '' || input.target_leads === null ? null : Number(input.target_leads)) : cur?.target_leads ?? null,
    stall: input.stall !== undefined ? str(input.stall, 80) : cur?.stall ?? null, description: input.description !== undefined ? str(input.description, 1000) : cur?.description ?? null,
    owner_id: input.owner_id !== undefined ? intId(input.owner_id) : cur?.owner_id ?? null, updated_at: stamp,
  };
  return tx(() => {
    if (cur) {
      update('campaigns', id, data);
      audit('campaign', id, 'update', data);
      return { id };
    }
    const newId = insert('campaigns', { ...data, created_by: user.id, created_at: stamp });
    audit('campaign', newId, 'create', data);
    return { id: newId };
  });
}
