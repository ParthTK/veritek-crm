import { get, all, run, insert, update, tx } from '../db.js';
import { LEAD_STAGES, stageIndex } from '../../shared/constants.js';
import { badRequest, nowIso, today, strOrNull, num, intOrNull, nextNumber, notify, managersOf } from '../util.js';

export const STAGE_PROBABILITY = {
  new_enquiry: 5, contact_attempted: 10, requirement_identified: 20, technical_discussion: 30,
  sample_shared: 35, quotation_preparation: 40, quotation_sent: 50, follow_up: 55,
  negotiation: 65, po_expected: 80, order_confirmed: 100,
};

/** Choose a salesperson for a lead using assignment rules, then least-loaded executive in region. */
export function pickAssignee({ customer_id, category_id }) {
  const customer = get('SELECT region_id, assigned_to FROM customers WHERE id = ?', customer_id);
  if (!customer) return null;
  if (customer.assigned_to) {
    const owner = get('SELECT id FROM users WHERE id = ? AND active = 1', customer.assigned_to);
    if (owner) return owner.id;
  }
  const rule = get(
    `SELECT r.user_id FROM lead_assignment_rules r JOIN users u ON u.id = r.user_id AND u.active = 1
     WHERE r.active = 1
       AND (r.region_id IS NULL OR r.region_id = ?)
       AND (r.category_id IS NULL OR r.category_id = ?)
       AND (r.region_id IS NOT NULL OR r.category_id IS NOT NULL)
     ORDER BY (r.region_id IS NOT NULL) + (r.category_id IS NOT NULL) DESC, r.priority ASC
     LIMIT 1`,
    customer.region_id, category_id ?? null,
  );
  if (rule) return rule.user_id;
  const exec = get(
    `SELECT u.id FROM users u
     WHERE u.active = 1 AND u.role = 'sales_executive' AND u.region_id = ?
     ORDER BY (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id AND l.status = 'open') ASC, u.id
     LIMIT 1`,
    customer.region_id,
  );
  if (exec) return exec.id;
  return get("SELECT id FROM users WHERE active = 1 AND role IN ('regional_manager','sales_head') ORDER BY role = 'regional_manager' DESC LIMIT 1")?.id ?? null;
}

/** Keep exactly one pending auto follow-up per open lead, mirroring next_action / next_follow_up_date. */
export function syncLeadFollowup(leadId) {
  const lead = get('SELECT * FROM leads WHERE id = ?', leadId);
  if (!lead) return;
  const key = `lead:${lead.id}`;
  const pending = get("SELECT id FROM followups WHERE auto_key = ? AND status = 'pending'", key);
  if (lead.status !== 'open' || !lead.next_follow_up_date) {
    if (pending) run("UPDATE followups SET status = 'cancelled', completed_at = ? WHERE id = ?", nowIso(), pending.id);
    return;
  }
  const data = {
    title: lead.next_action || `Follow up: ${lead.title}`,
    due_date: lead.next_follow_up_date,
    assigned_to: lead.assigned_to,
    priority: lead.temperature === 'hot' ? 'high' : 'normal',
    customer_id: lead.customer_id,
  };
  if (pending) update('followups', pending.id, data);
  else insert('followups', { ...data, type: 'call', lead_id: lead.id, auto_key: key, status: 'pending', created_by: lead.assigned_to, created_at: nowIso() });
}

function history(lead, next, userId, note) {
  if (lead.stage === next.stage && lead.status === next.status) return;
  insert('lead_stage_history', {
    lead_id: lead.id, from_stage: lead.stage, to_stage: next.stage, from_status: lead.status, to_status: next.status,
    note: note ?? null, changed_by: userId ?? null, changed_at: nowIso(),
  });
}

export function normalizeLead(body) {
  return {
    title: strOrNull(body.title),
    customer_id: intOrNull(body.customer_id),
    contact_id: intOrNull(body.contact_id),
    requirement: strOrNull(body.requirement),
    category_id: intOrNull(body.category_id),
    product_id: intOrNull(body.product_id),
    quantity: body.quantity === '' || body.quantity == null ? null : num(body.quantity),
    estimated_value: num(body.estimated_value),
    expected_close_date: strOrNull(body.expected_close_date),
    source: strOrNull(body.source),
    campaign_id: intOrNull(body.campaign_id),
    assigned_to: intOrNull(body.assigned_to),
    temperature: body.temperature || 'warm',
    probability: body.probability === '' || body.probability == null ? undefined : Math.min(100, Math.max(0, num(body.probability))),
    next_action: strOrNull(body.next_action),
    next_follow_up_date: strOrNull(body.next_follow_up_date),
    competitor: strOrNull(body.competitor),
    win_loss_reason: strOrNull(body.win_loss_reason),
  };
}

function requireNextAction(lead) {
  if (lead.status === 'open' && (!lead.next_action || !lead.next_follow_up_date)) {
    throw badRequest('Every open lead needs a next action and a follow-up date');
  }
}

export function createLead(body, user) {
  const data = normalizeLead(body);
  return tx(() => {
    if (!data.customer_id && body.new_customer?.name) {
      data.customer_id = createProspect(body.new_customer, data, user);
    }
    if (!data.customer_id) throw badRequest('Select a customer or enter a new company name');
    if (!data.title) data.title = data.requirement ? data.requirement.slice(0, 80) : 'New enquiry';
    if (!data.next_action) data.next_action = 'Make first contact and qualify requirement';
    if (!data.next_follow_up_date) data.next_follow_up_date = today();
    const stage = LEAD_STAGES.some((s) => s.value === body.stage) ? body.stage : 'new_enquiry';
    let autoAssigned = false;
    if (!data.assigned_to) {
      // A salesperson entering their own enquiry keeps it; everyone else's goes through the rules.
      if (user.role === 'sales_executive') data.assigned_to = user.id;
      else {
        data.assigned_to = pickAssignee(data);
        autoAssigned = true;
      }
    }
    if (data.assigned_to) run('UPDATE customers SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL', data.assigned_to, data.customer_id);
    if (!data.contact_id) {
      data.contact_id = get('SELECT id FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, id LIMIT 1', data.customer_id)?.id ?? null;
    }
    const id = insert('leads', {
      ...data,
      probability: data.probability ?? STAGE_PROBABILITY[stage],
      code: nextNumber('LD'),
      stage,
      status: 'open',
      stage_changed_at: nowIso(),
      created_by: user.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    insert('lead_stage_history', { lead_id: id, to_stage: stage, to_status: 'open', note: 'Lead created', changed_by: user.id, changed_at: nowIso() });
    if (body.tags) setTags('lead', id, body.tags);
    syncLeadFollowup(id);
    if (data.assigned_to && data.assigned_to !== user.id) {
      notify(data.assigned_to, {
        type: 'lead_assigned', title: `New lead assigned: ${data.title}`,
        message: autoAssigned ? 'Auto-assigned by region / product rules' : `Assigned by ${user.name}`,
        link: `/leads/${id}`, severity: data.temperature === 'hot' ? 'warning' : 'info', dedupeKey: `lead_assigned:${id}:${data.assigned_to}`,
      });
    }
    return id;
  });
}

function createProspect(nc, lead, user) {
  const region = nc.region_id ? intOrNull(nc.region_id) : null;
  const customerId = insert('customers', {
    code: nextNumber('CU'),
    name: String(nc.name).trim(),
    customer_type: nc.customer_type || 'direct',
    industry: strOrNull(nc.industry),
    city: strOrNull(nc.city),
    state: strOrNull(nc.state),
    country: strOrNull(nc.country) || 'India',
    pincode: strOrNull(nc.pincode),
    billing_address: strOrNull(nc.billing_address),
    shipping_address: strOrNull(nc.shipping_address),
    region_id: region,
    status: 'prospect',
    source: lead.source,
    campaign_id: lead.campaign_id,
    assigned_to: lead.assigned_to,
    created_by: user.id,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  if (nc.contact_name) {
    insert('contacts', {
      customer_id: customerId, name: nc.contact_name, contact_role: nc.contact_role || 'purchase',
      designation: strOrNull(nc.designation), phone: strOrNull(nc.phone), whatsapp: strOrNull(nc.phone),
      email: strOrNull(nc.email), is_primary: 1, created_at: nowIso(),
    });
  }
  if (lead.category_id) run('INSERT OR IGNORE INTO customer_interests (customer_id, category_id) VALUES (?, ?)', customerId, lead.category_id);
  return customerId;
}

export function updateLead(id, body, user) {
  const lead = get('SELECT * FROM leads WHERE id = ?', id);
  const data = normalizeLead({ ...lead, ...body });
  const next = { ...lead, ...data };
  requireNextAction(next);
  tx(() => {
    update('leads', id, { ...data, updated_at: nowIso() });
    if (body.tags) setTags('lead', id, body.tags);
    syncLeadFollowup(id);
    if (data.assigned_to && data.assigned_to !== lead.assigned_to) {
      notify(data.assigned_to, {
        type: 'lead_assigned', title: `Lead reassigned to you: ${next.title}`, message: `By ${user.name}`,
        link: `/leads/${id}`, dedupeKey: `lead_assigned:${id}:${data.assigned_to}`,
      });
    }
  });
}

/**
 * Move a lead through the pipeline or close it. Enforces: open leads keep a next action,
 * lost leads carry a reason. Probability follows the stage unless supplied.
 */
export function moveLead(id, body, user, { system = false } = {}) {
  const lead = get('SELECT * FROM leads WHERE id = ?', id);
  const stage = body.stage || lead.stage;
  const status = body.status || (body.stage ? 'open' : lead.status);
  if (!LEAD_STAGES.some((s) => s.value === stage)) throw badRequest('Unknown stage');
  const next = {
    stage,
    status,
    next_action: body.next_action !== undefined ? strOrNull(body.next_action) : lead.next_action,
    next_follow_up_date: body.next_follow_up_date !== undefined ? strOrNull(body.next_follow_up_date) : lead.next_follow_up_date,
    win_loss_reason: body.win_loss_reason !== undefined ? strOrNull(body.win_loss_reason) : lead.win_loss_reason,
    competitor: body.competitor !== undefined ? strOrNull(body.competitor) : lead.competitor,
  };
  if (status === 'lost' && !next.win_loss_reason) throw badRequest('Record the reason this lead was lost');
  if (!system) requireNextAction(next);
  if (status === 'won') next.stage = 'order_confirmed';
  let probability = body.probability !== undefined && body.probability !== '' ? num(body.probability) : STAGE_PROBABILITY[next.stage];
  if (status === 'won') probability = 100;
  if (status === 'lost') probability = 0;
  const closing = status === 'won' || status === 'lost';
  tx(() => {
    history(lead, next, user?.id, body.note);
    update('leads', id, {
      ...next,
      probability,
      stage_changed_at: next.stage !== lead.stage ? nowIso() : lead.stage_changed_at,
      closed_at: closing ? lead.closed_at || nowIso() : null,
      updated_at: nowIso(),
    });
    syncLeadFollowup(id);
    if (status === 'lost' && lead.status !== 'lost' && Number(lead.estimated_value) >= 1000000) {
      notify(managersOf(lead.assigned_to), {
        type: 'lead_lost', title: `High-value lead lost: ${lead.title}`, message: next.win_loss_reason,
        link: `/leads/${id}`, severity: 'warning', dedupeKey: `lead_lost:${id}`,
      });
    }
  });
}

/** Advance a lead to `stage` only if it is currently at an earlier stage and still open. */
export function advanceLeadTo(leadId, stage, user, note) {
  if (!leadId) return;
  const lead = get('SELECT * FROM leads WHERE id = ?', leadId);
  if (!lead || lead.status !== 'open') return;
  if (stageIndex(LEAD_STAGES, lead.stage) >= stageIndex(LEAD_STAGES, stage)) return;
  moveLead(leadId, { stage, note }, user, { system: true });
}

// ------------------------------------------------------------------ tags
export function setTags(entity, entityId, tagNames) {
  const names = [...new Set((Array.isArray(tagNames) ? tagNames : String(tagNames).split(',')).map((t) => String(t).trim()).filter(Boolean))];
  run('DELETE FROM taggings WHERE entity = ? AND entity_id = ?', entity, entityId);
  for (const name of names) {
    run('INSERT OR IGNORE INTO tags (name) VALUES (?)', name);
    const tag = get('SELECT id FROM tags WHERE name = ?', name);
    run('INSERT OR IGNORE INTO taggings (tag_id, entity, entity_id) VALUES (?, ?, ?)', tag.id, entity, entityId);
  }
}

export function tagsFor(entity, ids) {
  if (!ids.length) return {};
  const rows = all(
    `SELECT tg.entity_id, t.name, t.color FROM taggings tg JOIN tags t ON t.id = tg.tag_id
     WHERE tg.entity = ? AND tg.entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name`,
    [entity, ...ids],
  );
  const map = {};
  for (const r of rows) (map[r.entity_id] ||= []).push({ name: r.name, color: r.color });
  return map;
}

// ------------------------------------------------------------------ activities
const CONTACT_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'video', 'factory_visit'];

/**
 * Log a sales interaction. Updates the lead's next action, completes a follow-up,
 * schedules the next one and nudges early pipeline stages forward.
 */
export function logActivity(body, user) {
  const leadId = intOrNull(body.lead_id);
  let customerId = intOrNull(body.customer_id);
  const lead = leadId ? get('SELECT * FROM leads WHERE id = ?', leadId) : null;
  if (lead && !customerId) customerId = lead.customer_id;
  if (!customerId) throw badRequest('Activity must be linked to a customer');
  if (!body.type) throw badRequest('Select the interaction type');
  if (!strOrNull(body.summary) && !strOrNull(body.subject)) throw badRequest('Add a short discussion summary');
  if (lead && lead.status === 'open' && (!strOrNull(body.next_action) || !strOrNull(body.follow_up_date))) {
    throw badRequest('This lead is open: set the next action and follow-up date');
  }

  return tx(() => {
    const id = insert('activities', {
      type: body.type,
      customer_id: customerId,
      contact_id: intOrNull(body.contact_id),
      lead_id: leadId,
      quotation_id: intOrNull(body.quotation_id),
      order_id: intOrNull(body.order_id),
      complaint_id: intOrNull(body.complaint_id),
      subject: strOrNull(body.subject),
      summary: strOrNull(body.summary),
      customer_response: strOrNull(body.customer_response),
      objections: strOrNull(body.objections),
      products_discussed: strOrNull(body.products_discussed),
      next_action: strOrNull(body.next_action),
      follow_up_date: strOrNull(body.follow_up_date),
      duration_minutes: intOrNull(body.duration_minutes),
      activity_date: body.activity_date ? new Date(body.activity_date).toISOString() : nowIso(),
      created_by: user.id,
      created_at: nowIso(),
    });

    if (body.attachment_ids?.length) {
      for (const aid of body.attachment_ids) run("UPDATE attachments SET entity = 'activity', entity_id = ? WHERE id = ? AND entity = 'pending'", id, aid);
    }

    if (body.complete_followup_id) {
      run(
        "UPDATE followups SET status = 'done', completed_at = ?, completed_by = ?, outcome = ? WHERE id = ? AND status = 'pending'",
        nowIso(), user.id, strOrNull(body.summary), body.complete_followup_id,
      );
    }

    if (lead && lead.status === 'open') {
      run('UPDATE leads SET next_action = ?, next_follow_up_date = ?, updated_at = ? WHERE id = ?',
        strOrNull(body.next_action), strOrNull(body.follow_up_date), nowIso(), lead.id);
      if (lead.stage === 'new_enquiry' && CONTACT_TYPES.includes(body.type)) {
        advanceLeadTo(lead.id, 'contact_attempted', user, 'First contact logged');
      }
      if (body.type === 'sample_delivery') advanceLeadTo(lead.id, 'sample_shared', user, 'Sample / catalogue shared');
      syncLeadFollowup(lead.id);
    } else if (strOrNull(body.follow_up_date)) {
      insert('followups', {
        title: strOrNull(body.next_action) || `Follow up with customer`,
        type: body.type === 'sample_delivery' ? 'sample_feedback' : (CONTACT_TYPES.includes(body.type) ? body.type : 'call'),
        customer_id: customerId,
        quotation_id: intOrNull(body.quotation_id),
        order_id: intOrNull(body.order_id),
        complaint_id: intOrNull(body.complaint_id),
        assigned_to: user.id,
        due_date: body.follow_up_date,
        status: 'pending',
        created_by: user.id,
        created_at: nowIso(),
      });
    }
    return id;
  });
}
