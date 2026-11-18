// Coordinator work queue, the data-quality queue and global search.
import { all, get } from '../db.js';
import { now, today, likeTerm, normPhone, phoneKey, normName, optionLabel, intId, placeholders, settings } from '../util.js';
import { OPEN_ENQUIRY_STAGES } from '../../shared/constants.js';
import { customerScope, enquiryScope, orderScope } from '../access.js';
import { hasPerm } from '../auth.js';
import { loadOrdersWithLines, orderListRow } from './orders.js';
import { TASK_COLUMNS, decorateTask } from './tasks.js';
import { defaultCoordinatorId, userName } from './people.js';

const OPEN = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');

/** Each item names who should resolve it. */
export function dataQuality(user) {
  const coordinator = userName(defaultCoordinatorId()) || 'Coordinator';
  const groups = [];
  const add = (code, label, help, items) => groups.push({ code, label, help, count: items.length, items: items.slice(0, 100) });

  add('missing_owner', 'Missing or inactive owner', 'Every customer, open enquiry and open task needs an active named owner.', [
    ...all(`SELECT c.id, c.code, c.company_name FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL AND (c.owner_id IS NULL OR u.active = 0)`)
      .map((c) => ({ label: `${c.code} · ${c.company_name}`, detail: 'Customer has no active owner', link: `/customers/${c.id}`, resolver: 'Management' })),
    ...all(`SELECT e.id, e.code, c.company_name, u.name FROM enquiries e JOIN users u ON u.id = e.owner_id JOIN customers c ON c.id = e.customer_id WHERE e.stage IN (${OPEN}) AND u.active = 0`)
      .map((e) => ({ label: `${e.code} · ${e.company_name}`, detail: `Owner ${e.name} is deactivated`, link: `/enquiries/${e.id}`, resolver: 'Management' })),
    ...all(`SELECT t.id, t.purpose, u.name, t.customer_id FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.status = 'open' AND u.active = 0`)
      .map((t) => ({ label: t.purpose, detail: `Task owner ${t.name} is deactivated`, link: t.customer_id ? `/customers/${t.customer_id}` : '/followups', resolver: 'Management' })),
  ]);
  add('no_next_action', 'No next action', 'Open enquiries need a next action or a recorded reason for no follow-up.',
    all(`SELECT e.id, e.code, c.company_name, u.name AS owner FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
      WHERE e.stage IN (${OPEN}) AND e.no_followup_reason IS NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.enquiry_id = e.id AND t.status = 'open')`)
      .map((e) => ({ label: `${e.code} · ${e.company_name}`, detail: 'Open enquiry without a next action', link: `/enquiries/${e.id}`, resolver: e.owner })));
  add('unknown_lost_reason', 'Unknown lost reason', 'Lost for an unknown reason: ask the customer rather than guess.',
    all(`SELECT e.id, e.code, c.company_name, u.name AS owner FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id
      WHERE e.stage = 'lost' AND (e.lost_reason_code = 'unknown' OR e.lost_reason_code IS NULL)
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.enquiry_id = e.id AND a.meaningful = 1 AND a.occurred_at > e.decided_at)`)
      .map((e) => ({ label: `${e.code} · ${e.company_name}`, detail: 'Lost reason not known', link: `/enquiries/${e.id}`, resolver: e.owner })));

  const orders = loadOrdersWithLines(["o.status = 'confirmed'", 'o.closed_at IS NULL']).map(({ order, lines }) => orderListRow(order, lines));
  const stale = [];
  const uncommitted = [];
  const impossible = [];
  for (const o of orders) {
    for (const l of o.lines) {
      if (l.quantities.remaining <= 0) continue;
      if (l.stale) stale.push({ label: `${o.code} · ${o.customer_name} · ${l.product}`, detail: l.freshness?.as_of ? `No update for ${l.freshness.working_days} working days` : 'No update recorded', link: `/orders/${o.id}`, resolver: coordinator });
      if (l.commitment_state !== 'committed') uncommitted.push({ label: `${o.code} · ${o.customer_name} · ${l.product}`, detail: l.commitment_state === 'unknown' ? 'Commitment unknown (legacy record)' : 'Dispatch date not yet agreed', link: `/orders/${o.id}`, resolver: o.owner_name });
      const q = l.quantities;
      if (q.ready !== null && (q.ready > q.confirmed - q.cancelled + 0.0005 || q.ready < q.dispatched - 0.0005)) impossible.push({ label: `${o.code} · ${l.product}`, detail: `Ready ${q.ready} is outside dispatched ${q.dispatched} – required ${q.confirmed - q.cancelled}`, link: `/orders/${o.id}`, resolver: coordinator });
    }
  }
  add('stale_update', 'Stale order update', 'Active lines past the freshness threshold (based on the reported as-of time).', stale);
  add('unknown_commitment', 'Unknown commitment', 'Lines without a committed dispatch date are excluded from timeliness until agreed.', uncommitted);
  add('impossible_quantity', 'Impossible quantity', 'Quantities that break the line quantity model.', impossible);

  const seen = new Set();
  const dupes = [];
  for (const r of all(`SELECT a.customer_id AS a, b.customer_id AS b, a.phone_raw AS v, 'phone' AS kind FROM contacts a JOIN contacts b ON a.phone_norm = b.phone_norm AND a.customer_id < b.customer_id
      WHERE a.phone_norm IS NOT NULL
    UNION ALL SELECT a.customer_id, b.customer_id, a.email_norm, 'email' FROM contacts a JOIN contacts b ON a.email_norm = b.email_norm AND a.customer_id < b.customer_id WHERE a.email_norm IS NOT NULL
    UNION ALL SELECT a.id, b.id, a.company_name, 'name' FROM customers a JOIN customers b ON a.name_norm = b.name_norm AND a.id < b.id WHERE a.name_norm <> ''`)) {
    const key = `${r.a}-${r.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ca = get('SELECT id, code, company_name, merged_into_id FROM customers WHERE id = ?', r.a);
    const cb = get('SELECT id, code, company_name, merged_into_id FROM customers WHERE id = ?', r.b);
    if (!ca || !cb || ca.merged_into_id || cb.merged_into_id) continue;
    if (get('SELECT 1 FROM duplicate_dismissals WHERE customer_a = ? AND customer_b = ?', Math.min(r.a, r.b), Math.max(r.a, r.b))) continue;
    dupes.push({ label: `${ca.company_name} ↔ ${cb.company_name}`, detail: `Same ${r.kind}: ${r.v}`, link: `/customers/${ca.id}?compare=${cb.id}`, resolver: 'Management (authorised merge)', ids: [ca.id, cb.id] });
  }
  add('duplicate_candidate', 'Possible duplicate customers', 'Warnings only — nothing is merged automatically.', dupes);
  add('missing_contact_channel', 'Missing contact channel', 'Customers with no phone or email on any contact.',
    all(`SELECT c.id, c.code, c.company_name, u.name AS owner FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.customer_id = c.id AND ct.active = 1 AND (ct.phone_norm IS NOT NULL OR ct.email_norm IS NOT NULL))`)
      .map((c) => ({ label: `${c.code} · ${c.company_name}`, detail: 'No phone or email recorded', link: `/customers/${c.id}`, resolver: c.owner || coordinator })));
  add('provisional_customer', 'Provisional customers', 'Confirm company details before an order can be confirmed.',
    all(`SELECT c.id, c.code, c.company_name, u.name AS owner FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE c.provisional = 1 AND c.merged_into_id IS NULL AND c.archived_at IS NULL`)
      .map((c) => ({ label: `${c.code} · ${c.company_name}`, detail: 'Provisional record', link: `/customers/${c.id}`, resolver: c.owner || coordinator })));
  add('unknown_country', 'Country unknown', 'Needed before export reporting.',
    all(`SELECT c.id, c.code, c.company_name, u.name AS owner FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE c.country_code IS NULL AND c.merged_into_id IS NULL AND c.archived_at IS NULL`)
      .map((c) => ({ label: `${c.code} · ${c.company_name}`, detail: 'Country not recorded', link: `/customers/${c.id}`, resolver: c.owner || coordinator })));
  return groups;
}

export function workQueue(user) {
  const nowStr = now().toISOString();
  const day = today();
  const newEnquiries = all(`SELECT e.id, e.code, e.received_at, e.stage, c.company_name, c.id AS customer_id, u.name AS owner_name, e.source_code,
      (SELECT COALESCE(p.code, el.requirement, 'Unspecified') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort LIMIT 1) AS product
    FROM enquiries e JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = e.owner_id WHERE e.stage = 'new' AND e.first_response_at IS NULL ORDER BY e.received_at`)
    .map((e) => ({ ...e, source_label: optionLabel('enquiry_source', e.source_code) }));
  const drafts = all(`SELECT o.id, o.code, o.created_at, c.company_name, u.name AS owner_name FROM orders o JOIN customers c ON c.id = o.customer_id JOIN users u ON u.id = o.owner_id WHERE o.status = 'draft' AND o.archived_at IS NULL ORDER BY o.created_at`);
  const technical = all(`SELECT a.id, a.occurred_at, a.note, c.company_name, c.id AS customer_id FROM activities a JOIN customers c ON c.id = a.customer_id WHERE a.technical_issue = 1 AND a.complaint_converted_id IS NULL ORDER BY a.occurred_at DESC LIMIT 50`);
  const tasks = all(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
      LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.status = 'open' AND (t.overdue_at <= ? OR t.due_date = ?) ORDER BY t.overdue_at LIMIT 400`, nowStr, day).map((t) => decorateTask(t));
  const orders = loadOrdersWithLines(["o.status = 'confirmed'", 'o.closed_at IS NULL'], [], user).map(({ order, lines }) => orderListRow(order, lines));
  const needing = orders.filter((o) => o.stale_lines || o.estimate_unknown || o.no_action || o.comm_pending || o.ready_waiting || o.overdue || o.at_risk)
    .map((o) => ({
      ...o,
      reasons: [
        o.overdue && 'Dispatch overdue', o.at_risk && 'Forecast late', o.stale_lines && `${o.stale_lines} line(s) need a fresh update`, o.estimate_unknown && 'Estimate unknown',
        o.no_action && 'Delay without action owner', o.comm_pending && 'Customer not informed', o.ready_waiting && 'Ready, awaiting dispatch',
      ].filter(Boolean),
    }));
  const quality = dataQuality(user);
  return {
    counts: {
      new_inputs: newEnquiries.length + drafts.length + technical.length,
      followups_due: tasks.length,
      orders_needing_updates: needing.length,
      missing_information: quality.reduce((s, g) => s + g.count, 0),
    },
    new_inputs: { enquiries: newEnquiries, drafts, technical },
    followups_due: tasks,
    orders_needing_updates: needing,
    missing_information: quality,
  };
}

/** Search by company, alias, phone, email, enquiry ID, order ID, quotation number or customer PO. */
export function globalSearch(q, user) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const like = likeTerm(term);
  const out = [];
  if (hasPerm(user, 'customers.view')) {
    const scope = customerScope(user, 'c');
    const pk = phoneKey(normPhone(term, 'IN'));
    for (const c of all(`SELECT c.id, c.code, c.company_name, c.city, c.country_code, c.merged_into_id FROM customers c WHERE (${scope || '1=1'}) AND (
        c.company_name LIKE ? OR c.code LIKE ? OR c.name_norm LIKE ? OR c.external_account_id = ?
        OR c.id IN (SELECT customer_id FROM customer_aliases WHERE alias LIKE ?)
        OR c.id IN (SELECT customer_id FROM contacts WHERE email_norm LIKE ? OR name LIKE ? ${pk && pk.length >= 6 ? 'OR phone_norm LIKE ?' : ''}))
      ORDER BY c.merged_into_id IS NOT NULL, c.company_name LIMIT 8`, like, like, `%${normName(term)}%`, term, like, like.toLowerCase(), like, ...(pk && pk.length >= 6 ? [`%${pk}%`] : []))) {
      out.push({ type: 'Customer', label: c.company_name, sub: [c.code, c.city, c.merged_into_id ? 'merged' : null].filter(Boolean).join(' · '), link: `/customers/${c.merged_into_id || c.id}` });
    }
  }
  if (hasPerm(user, 'enquiries.view')) {
    const scope = enquiryScope(user, 'e');
    for (const e of all(`SELECT e.id, e.code, e.stage, c.company_name FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE (${scope || '1=1'}) AND (e.code LIKE ? OR e.external_id = ?) ORDER BY e.id DESC LIMIT 6`, like, term)) {
      out.push({ type: 'Enquiry', label: `${e.code} · ${e.company_name}`, sub: e.stage.replace(/_/g, ' '), link: `/enquiries/${e.id}` });
    }
    for (const qn of all(`SELECT q.number, q.enquiry_id, c.company_name FROM quotations q JOIN customers c ON c.id = q.customer_id JOIN enquiries e ON e.id = q.enquiry_id WHERE (${scope || '1=1'}) AND q.number LIKE ? LIMIT 5`, like)) {
      out.push({ type: 'Quotation', label: `${qn.number} · ${qn.company_name}`, sub: 'quotation', link: `/enquiries/${qn.enquiry_id}` });
    }
  }
  if (hasPerm(user, 'orders.view')) {
    const scope = orderScope(user, 'o');
    for (const o of all(`SELECT o.id, o.code, o.po_reference, c.company_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE (${scope || '1=1'}) AND (o.code LIKE ? OR o.po_reference LIKE ? OR o.external_id = ?) ORDER BY o.id DESC LIMIT 8`, like, like, term)) {
      out.push({ type: 'Order', label: `${o.code} · ${o.company_name}`, sub: o.po_reference ? `PO ${o.po_reference}` : '', link: `/orders/${o.id}` });
    }
  }
  if (settings().modules.complaints && hasPerm(user, 'complaints.view')) {
    for (const k of all('SELECT k.id, k.code, c.company_name FROM complaints k JOIN customers c ON c.id = k.customer_id WHERE k.code LIKE ? LIMIT 4', like)) {
      out.push({ type: 'Complaint', label: `${k.code} · ${k.company_name}`, sub: '', link: `/complaints/${k.id}` });
    }
  }
  return out;
}

export { placeholders, intId };
