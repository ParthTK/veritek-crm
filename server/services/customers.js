// One customer profile, linked everywhere. Its history is assembled from linked records, never kept as
// a separate handwritten log.
import { all, get, insert, run, tx, update, updateVersioned } from '../db.js';
import {
  Check, badRequest, conflict, notFound, nowIso, now, today, tz, str, intId, bool, normName, normEmail, normPhone, phoneKey, nameSimilarity,
  nextCode, audit, history, diff, parseJson, settings, optionLabel, dropdowns, placeholders, outstandingSql,
} from '../util.js';
import { customerScope } from '../access.js';
import { requireActiveUser } from './people.js';
import { decorateTask, TASK_COLUMNS, activitiesWhere } from './tasks.js';
import { attachmentsFor } from './attachments.js';
import {
  COUNTRIES, OPEN_ENQUIRY_STAGES, labelOf, ENQUIRY_STAGES, PHASES, VALUE_CATEGORIES, CONTACT_ROLES, CURRENCIES, TAG_COLORS, QUOTE_STATUSES,
} from '../../shared/constants.js';
import { addDays, localDate, daysBetween } from '../../shared/dates.js';
import { lineStatus, lineQty, orderSummary, isPositive, lineValueMinor, fulfilmentOutcome, toMinor } from '../../shared/rules.js';

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'rediffmail.com', 'icloud.com', 'live.com', 'ymail.com', 'protonmail.com', 'aol.com']);
const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.value));

// ------------------------------------------------------------------ derived facts (one definition everywhere)
export const LAST_ORDER_SQL = (c = 'c') => `(SELECT MAX(o.received_date) FROM orders o WHERE o.customer_id = ${c}.id AND o.status = 'confirmed')`;
export const FIRST_ORDER_SQL = (c = 'c') => `(SELECT MIN(o.received_date) FROM orders o WHERE o.customer_id = ${c}.id AND o.status = 'confirmed')`;
/** Latest of the recorded confirmed orders and any imported historical last-order date. */
export const EFFECTIVE_LAST_ORDER_SQL = (c = 'c') => `(SELECT CASE WHEN x IS NULL THEN ${c}.legacy_last_order_date WHEN ${c}.legacy_last_order_date IS NULL OR x >= ${c}.legacy_last_order_date THEN x ELSE ${c}.legacy_last_order_date END FROM (SELECT ${LAST_ORDER_SQL(c)} AS x))`;
export const LAST_CONTACT_SQL = (c = 'c') => `(SELECT MAX(a.occurred_at) FROM activities a WHERE a.customer_id = ${c}.id AND a.customer_contact = 1 AND a.meaningful = 1)`;
export const LAST_ENQUIRY_SQL = (c = 'c') => `(SELECT MAX(e.received_at) FROM enquiries e WHERE e.customer_id = ${c}.id)`;
export const HAS_ORDERS_SQL = (c = 'c') => `(EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = ${c}.id AND o.status = 'confirmed') OR COALESCE(${c}.legacy_order_count, 0) > 0 OR ${c}.legacy_last_order_date IS NOT NULL)`;

// ------------------------------------------------------------------ duplicate matching
/** Possible existing customers for a name/phone/email. Warnings only: nothing is ever merged automatically. */
export function findMatches({ company_name, phones = [], emails = [], country_code, excludeId } = {}) {
  const found = new Map();
  const add = (id, reason, score) => {
    const m = found.get(id) || { id, reasons: [], score: 0 };
    if (!m.reasons.includes(reason)) m.reasons.push(reason);
    m.score = Math.max(m.score, score);
    found.set(id, m);
  };
  for (const raw of phones) {
    const key = phoneKey(normPhone(raw, country_code));
    if (!key || key.length < 7) continue;
    for (const r of all('SELECT DISTINCT customer_id, phone_raw FROM contacts WHERE phone_norm LIKE ?', `%${key}`)) add(r.customer_id, `Same phone number (${r.phone_raw})`, 0.95);
  }
  for (const e of emails.map(normEmail).filter(Boolean)) {
    for (const r of all('SELECT DISTINCT customer_id FROM contacts WHERE email_norm = ?', e)) add(r.customer_id, `Same email address (${e})`, 0.98);
    const domain = e.split('@')[1];
    if (domain && !FREE_MAIL.has(domain)) {
      for (const r of all('SELECT DISTINCT customer_id FROM contacts WHERE email_norm LIKE ?', `%@${domain}`)) add(r.customer_id, `Same email domain (@${domain})`, 0.75);
    }
  }
  const n = normName(company_name);
  if (n.length >= 2) {
    const tokens = n.split(' ').filter((t) => t.length >= 3);
    const rows = tokens.length
      ? all(`SELECT id, name_norm FROM customers WHERE ${tokens.map(() => 'name_norm LIKE ?').join(' OR ')} LIMIT 500`, tokens.map((t) => `%${t}%`))
      : all('SELECT id, name_norm FROM customers WHERE name_norm = ?', n);
    for (const r of rows) {
      const s = nameSimilarity(n, r.name_norm);
      if (r.name_norm === n) add(r.id, 'Same company name', 1);
      else if (s >= 0.72) add(r.id, 'Similar company name', s);
    }
    for (const r of all('SELECT customer_id, alias FROM customer_aliases WHERE alias_norm = ?', n)) add(r.customer_id, `Matches an alias ("${r.alias}")`, 0.9);
  }
  // Follow merges to the surviving profile.
  const resolved = new Map();
  for (const m of found.values()) {
    let id = m.id;
    for (let i = 0; i < 5; i++) {
      const next = get('SELECT merged_into_id FROM customers WHERE id = ?', id)?.merged_into_id;
      if (!next) break;
      id = next;
    }
    if (id === excludeId) continue;
    const prev = resolved.get(id);
    resolved.set(id, prev ? { ...prev, reasons: [...new Set([...prev.reasons, ...m.reasons])], score: Math.max(prev.score, m.score) } : { ...m, id });
  }
  const ids = [...resolved.keys()];
  if (!ids.length) return [];
  const info = Object.fromEntries(all(`SELECT c.id, c.code, c.company_name, c.city, c.country_code, c.provisional, c.archived_at, u.name AS owner_name,
      (SELECT phone_raw FROM contacts WHERE customer_id = c.id AND phone_raw IS NOT NULL ORDER BY is_primary DESC LIMIT 1) AS phone
    FROM customers c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id IN (${placeholders(ids)})`, ids).map((r) => [r.id, r]));
  return [...resolved.values()].map((m) => ({ ...info[m.id], reasons: m.reasons, score: Math.round(m.score * 100) / 100 }))
    .sort((a, b) => b.score - a.score).slice(0, 8);
}

function dismissedWith(id) {
  return new Set(all('SELECT customer_a, customer_b FROM duplicate_dismissals WHERE customer_a = ? OR customer_b = ?', id, id).map((r) => (r.customer_a === id ? r.customer_b : r.customer_a)));
}

// ------------------------------------------------------------------ create / update
function validateCustomerFields(c, input, { partial = false } = {}) {
  if (!partial || input.company_name !== undefined) c.text('company_name', input.company_name, { required: true, min: 2, max: 200, label: 'Company name' });
  if (input.country_code && !COUNTRY_CODES.has(input.country_code)) c.fail('country_code', 'Choose a country from the list');
  if (input.segment && !['domestic', 'export'].includes(input.segment)) c.fail('segment', 'Choose domestic or export');
  const types = Array.isArray(input.types) ? input.types : [];
  const valid = new Set((dropdowns().customer_type || []).map((o) => o.code));
  if (types.some((t) => !valid.has(t))) c.fail('types', 'Choose customer types from the list');
  c.text('city', input.city, { max: 100, label: 'City' });
  c.text('state', input.state, { max: 80, label: 'State' });
  c.text('industry', input.industry, { max: 80, label: 'Industry' });
  c.text('website', input.website, { max: 200, label: 'Website' });
  if (input.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/i.test(String(input.gstin).trim())) c.fail('gstin', 'A GSTIN has 15 characters (e.g. 27ABCDE1234F1Z5)');
  if (input.pincode && !/^[A-Za-z0-9 -]{3,10}$/.test(String(input.pincode).trim())) c.fail('pincode', 'Check the PIN / postal code');
  if (input.value_category && !VALUE_CATEGORIES.some((v) => v.value === input.value_category)) c.fail('value_category', 'Choose a value category');
  if (input.region_id && !get('SELECT id FROM regions WHERE id = ?', intId(input.region_id))) c.fail('region_id', 'Choose a region');
  if (input.campaign_id && !get('SELECT id FROM campaigns WHERE id = ?', intId(input.campaign_id))) c.fail('campaign_id', 'Choose a campaign');
  if (input.acquisition_source && !(dropdowns().enquiry_source || []).some((o) => o.code === input.acquisition_source)) c.fail('acquisition_source', 'Choose a source');
  if (input.payment_terms_days !== undefined && input.payment_terms_days !== '' && input.payment_terms_days !== null && (!Number.isInteger(Number(input.payment_terms_days)) || Number(input.payment_terms_days) < 0 || Number(input.payment_terms_days) > 365)) c.fail('payment_terms_days', 'Enter 0–365 days');
  if (input.credit_limit !== undefined && input.credit_limit !== '' && input.credit_limit !== null) {
    const m = toMinor(input.credit_limit);
    if (Number.isNaN(m) || m < 0) c.fail('credit_limit', 'Enter a valid amount');
  }
  if (input.credit_currency && !CURRENCIES.includes(input.credit_currency)) c.fail('credit_currency', 'Choose a currency');
  if (bool(input.credit_hold) && !str(input.credit_hold_reason)) c.fail('credit_hold_reason', 'Give the reason for the credit hold');
}

/** Region from the country (outside India → "Export") or from the state list configured on each region. */
export function regionFor(countryCode, state) {
  const regions = all('SELECT id, name, states FROM regions WHERE active = 1');
  if (countryCode && countryCode !== 'IN') return regions.find((r) => /export|international|overseas/i.test(r.name))?.id ?? null;
  if (!state) return null;
  const s = String(state).trim().toLowerCase();
  return regions.find((r) => String(r.states || '').toLowerCase().split(/\s*,\s*/).includes(s))?.id ?? null;
}

/** Replaces a customer's tags (names; new names create tags). */
export function setTags(customerId, names, user) {
  const list = [...new Set((Array.isArray(names) ? names : String(names || '').split(',')).map((n) => str(n, 40)).filter(Boolean))];
  run("DELETE FROM taggings WHERE entity = 'customer' AND entity_id = ?", customerId);
  for (const name of list) {
    let tag = get('SELECT id FROM tags WHERE name = ? COLLATE NOCASE', name);
    if (!tag) tag = { id: insert('tags', { name, color: TAG_COLORS[(get('SELECT COUNT(*) AS n FROM tags').n) % TAG_COLORS.length] }) };
    run("INSERT OR IGNORE INTO taggings (tag_id, entity, entity_id) VALUES (?, 'customer', ?)", tag.id, customerId);
  }
  return list;
}

/** Replaces the product families a customer is interested in. */
export function setInterests(customerId, categoryIds) {
  run('DELETE FROM customer_interests WHERE customer_id = ?', customerId);
  for (const cid of [...new Set((categoryIds || []).map(intId).filter(Boolean))]) {
    if (get('SELECT id FROM product_categories WHERE id = ?', cid)) run('INSERT OR IGNORE INTO customer_interests (customer_id, category_id) VALUES (?, ?)', customerId, cid);
  }
}

export const tagsFor = (customerId) => all("SELECT t.id, t.name, t.color FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.entity = 'customer' AND g.entity_id = ? ORDER BY t.name", customerId);
export const interestsFor = (customerId) => all('SELECT pc.id, pc.name FROM customer_interests ci JOIN product_categories pc ON pc.id = ci.category_id WHERE ci.customer_id = ? ORDER BY pc.name', customerId);

function contactRow(customerId, x, isPrimary, countryCode) {
  const stamp = nowIso();
  return insert('contacts', {
    customer_id: customerId,
    name: str(x.name, 120),
    role: str(x.role ?? x.designation, 120),
    contact_role: CONTACT_ROLES.some((r) => r.value === x.contact_role) ? x.contact_role : null,
    phone_raw: str(x.phone, 40),
    phone_norm: normPhone(x.phone, countryCode),
    whatsapp_raw: str(x.whatsapp, 40),
    email_raw: str(x.email, 160),
    email_norm: normEmail(x.email),
    preferred_channel: ['phone', 'whatsapp', 'email', 'meeting'].includes(x.preferred_channel) ? x.preferred_channel : null,
    is_primary: isPrimary ? 1 : 0,
    active: 1,
    notes: str(x.notes, 500),
    created_at: stamp,
    updated_at: stamp,
  });
}

/** Master-data fields shared by create and update (stored as given; money as minor units). */
function masterFields(input) {
  const out = {};
  for (const k of ['state', 'pincode', 'industry', 'website', 'billing_address', 'shipping_address', 'payment_terms', 'credit_hold_reason']) {
    if (input[k] !== undefined) out[k] = str(input[k], k.endsWith('address') ? 500 : 200);
  }
  if (input.gstin !== undefined) out.gstin = input.gstin ? String(input.gstin).trim().toUpperCase() : null;
  if (input.value_category !== undefined) out.value_category = input.value_category || null;
  if (input.region_id !== undefined) out.region_id = intId(input.region_id);
  if (input.campaign_id !== undefined) out.campaign_id = intId(input.campaign_id);
  if (input.acquisition_source !== undefined) out.acquisition_source = input.acquisition_source || null;
  if (input.payment_terms_days !== undefined) out.payment_terms_days = input.payment_terms_days === '' || input.payment_terms_days === null ? null : Number(input.payment_terms_days);
  if (input.credit_limit !== undefined) out.credit_limit_minor = input.credit_limit === '' || input.credit_limit === null ? null : toMinor(input.credit_limit);
  if (input.credit_currency !== undefined) out.credit_currency = input.credit_currency || null;
  if (input.credit_hold !== undefined) {
    out.credit_hold = bool(input.credit_hold) ? 1 : 0;
    if (!out.credit_hold) out.credit_hold_reason = null;
  }
  return out;
}

/**
 * Creates a customer. Before creating, possible matches are returned as a 409 so the user can pick the
 * existing profile; creating anyway records an explicit "not a duplicate" decision.
 */
export function createCustomer(input, user, { requireContactChannel = true, importBatchId = null, skipDuplicateCheck = false, sourceConfidence = null } = {}) {
  const c = new Check();
  validateCustomerFields(c, input);
  const contacts = (input.contacts || []).filter((x) => x && (str(x.name) || str(x.phone) || str(x.email)));
  if (requireContactChannel && !contacts.some((x) => str(x.phone) || str(x.email))) c.fail('contacts', 'Add at least one way to reach them: phone or email');
  contacts.forEach((x, i) => {
    if (str(x.email) && !normEmail(x.email)) c.fail(`contacts.${i}.email`, 'Check the email address');
    if (str(x.phone) && !normPhone(x.phone, input.country_code)) c.fail(`contacts.${i}.phone`, 'Check the phone number');
  });
  const ownerId = intId(input.owner_id) || user.id;
  requireActiveUser(c, 'owner_id', ownerId, 'Owner');
  c.throwIfAny();

  let matches = [];
  if (!skipDuplicateCheck) {
    matches = findMatches({ company_name: input.company_name, phones: contacts.map((x) => x.phone), emails: contacts.map((x) => x.email), country_code: input.country_code });
    if (matches.length && !bool(input.confirm_not_duplicate)) {
      throw conflict('This may be an existing customer. Choose the existing profile, or confirm it is a separate company.', { code: 'possible_duplicate', matches });
    }
  }
  return tx(() => {
    const stamp = nowIso();
    const id = insert('customers', {
      code: nextCode('CUS'),
      company_name: str(input.company_name, 200),
      name_norm: normName(input.company_name),
      provisional: bool(input.provisional) ? 1 : 0,
      country_code: input.country_code || null,
      city: str(input.city, 100),
      segment: input.segment || (input.country_code ? (input.country_code === 'IN' ? 'domestic' : 'export') : null),
      types: JSON.stringify(Array.isArray(input.types) ? input.types : []),
      ...masterFields(input),
      region_id: intId(input.region_id) || regionFor(input.country_code, input.state),
      owner_id: ownerId,
      preferred_channel: input.preferred_channel || null,
      external_source: str(input.external_source, 60),
      external_account_id: str(input.external_account_id, 80),
      legacy_first_order_date: input.legacy_first_order_date || null,
      legacy_last_order_date: input.legacy_last_order_date || null,
      legacy_order_count: intId(input.legacy_order_count),
      legacy_source: str(input.legacy_source, 120),
      notes: str(input.notes, 1000),
      import_batch_id: importBatchId,
      source_confidence: sourceConfidence,
      created_by: user.id,
      created_at: stamp,
      updated_at: stamp,
    });
    contacts.forEach((x, i) => contactRow(id, x, x.is_primary ? true : i === 0, input.country_code));
    if (input.tags) setTags(id, input.tags, user);
    if (input.interests) setInterests(id, input.interests);
    for (const alias of (input.aliases || []).map((a) => str(a, 200)).filter(Boolean)) {
      insert('customer_aliases', { customer_id: id, alias, alias_norm: normName(alias), kind: 'name', created_at: stamp, created_by: user.id });
    }
    for (const m of matches) {
      run('INSERT OR IGNORE INTO duplicate_dismissals (customer_a, customer_b, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)',
        Math.min(id, m.id), Math.max(id, m.id), 'Confirmed as a separate company at creation', user.id, stamp);
    }
    history('customer', id, 'created', { customerId: id, data: { provisional: bool(input.provisional), duplicates_acknowledged: matches.map((m) => m.code) } });
    audit('customer', id, 'create', { company_name: input.company_name, owner_id: ownerId, contacts: contacts.length, acknowledged_matches: matches.map((m) => m.id) });
    return id;
  });
}

const EDITABLE = ['company_name', 'provisional', 'country_code', 'city', 'segment', 'types', 'owner_id', 'preferred_channel', 'contact_notes', 'external_source', 'external_account_id', 'notes'];

export function updateCustomer(id, input, user) {
  const cur = get('SELECT * FROM customers WHERE id = ?', id);
  if (!cur) throw notFound('Customer');
  if (cur.merged_into_id) throw conflict('This profile was merged into another customer and can no longer be edited.');
  const c = new Check();
  validateCustomerFields(c, input, { partial: true });
  if (input.owner_id !== undefined) requireActiveUser(c, 'owner_id', intId(input.owner_id), 'Owner');
  c.throwIfAny();
  const next = { ...masterFields(input) };
  for (const k of EDITABLE) {
    if (input[k] === undefined) continue;
    if (k === 'types') next.types = JSON.stringify(Array.isArray(input.types) ? input.types : []);
    else if (k === 'provisional') next.provisional = bool(input.provisional) ? 1 : 0;
    else if (k === 'owner_id') next.owner_id = intId(input.owner_id);
    else next[k] = str(input[k], k === 'notes' || k === 'contact_notes' ? 1000 : 200);
  }
  if (next.company_name) next.name_norm = normName(next.company_name);
  if ((input.country_code !== undefined || input.state !== undefined) && input.region_id === undefined && !cur.region_id) {
    next.region_id = regionFor(input.country_code ?? cur.country_code, input.state ?? cur.state);
  }
  const changes = diff(cur, { ...cur, ...next }, Object.keys(next));
  const tagsChanged = input.tags !== undefined;
  const interestsChanged = input.interests !== undefined;
  if (!Object.keys(changes).length && !tagsChanged && !interestsChanged) return { id, unchanged: true };
  return tx(() => {
    if (!updateVersioned('customers', id, Number(input.version ?? cur.version), { ...next, updated_at: nowIso() })) {
      throw conflict('Someone else updated this customer. Review their changes before saving again.', { code: 'version_conflict', current: get('SELECT * FROM customers WHERE id = ?', id) });
    }
    if (tagsChanged) changes.tags = [tagsFor(id).map((t) => t.name).join(', '), setTags(id, input.tags, user).join(', ')];
    if (interestsChanged) setInterests(id, input.interests);
    if (changes.credit_hold) history('customer', id, next.credit_hold ? 'credit_hold_set' : 'credit_hold_cleared', { customerId: id, note: next.credit_hold_reason || null });
    if (changes.owner_id) history('customer', id, 'owner_changed', { customerId: id, data: { from: changes.owner_id[0], to: changes.owner_id[1] } });
    if (changes.company_name) {
      insert('customer_aliases', { customer_id: id, alias: cur.company_name, alias_norm: cur.name_norm, kind: 'former_name', created_at: nowIso(), created_by: user.id });
    }
    audit('customer', id, 'update', changes);
    return { id };
  });
}

export function addContact(customerId, input, user) {
  const cust = get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!cust) throw notFound('Customer');
  const c = new Check();
  if (!str(input.name) && !str(input.phone) && !str(input.email)) c.fail('name', 'Add a name, phone or email');
  if (str(input.email) && !normEmail(input.email)) c.fail('email', 'Check the email address');
  if (str(input.phone) && !normPhone(input.phone, cust.country_code)) c.fail('phone', 'Check the phone number');
  c.throwIfAny();
  return tx(() => {
    const hasPrimary = get('SELECT id FROM contacts WHERE customer_id = ? AND is_primary = 1 AND active = 1', customerId);
    if (bool(input.is_primary) && hasPrimary) run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', customerId);
    const id = contactRow(customerId, input, bool(input.is_primary) || !hasPrimary, cust.country_code);
    audit('contact', id, 'create', { customer_id: customerId, name: input.name });
    return id;
  });
}

export function updateContact(contactId, input, user) {
  const cur = get('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!cur) throw notFound('Contact');
  const cust = get('SELECT country_code FROM customers WHERE id = ?', cur.customer_id);
  const c = new Check();
  if (input.email !== undefined && str(input.email) && !normEmail(input.email)) c.fail('email', 'Check the email address');
  if (input.phone !== undefined && str(input.phone) && !normPhone(input.phone, cust.country_code)) c.fail('phone', 'Check the phone number');
  c.throwIfAny();
  const next = {};
  if (input.name !== undefined) next.name = str(input.name, 120);
  if (input.role !== undefined) next.role = str(input.role, 120);
  if (input.contact_role !== undefined) next.contact_role = CONTACT_ROLES.some((r) => r.value === input.contact_role) ? input.contact_role : null;
  if (input.whatsapp !== undefined) next.whatsapp_raw = str(input.whatsapp, 40);
  if (input.preferred_channel !== undefined) next.preferred_channel = ['phone', 'whatsapp', 'email', 'meeting'].includes(input.preferred_channel) ? input.preferred_channel : null;
  if (input.phone !== undefined) Object.assign(next, { phone_raw: str(input.phone, 40), phone_norm: normPhone(input.phone, cust.country_code) });
  if (input.email !== undefined) Object.assign(next, { email_raw: str(input.email, 160), email_norm: normEmail(input.email) });
  if (input.active !== undefined) next.active = bool(input.active) ? 1 : 0;
  if (input.notes !== undefined) next.notes = str(input.notes, 500);
  return tx(() => {
    if (bool(input.is_primary)) {
      run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', cur.customer_id);
      next.is_primary = 1;
    }
    if (!updateVersioned('contacts', contactId, Number(input.version ?? cur.version), { ...next, updated_at: nowIso() })) {
      throw conflict('Someone else updated this contact.', { code: 'version_conflict' });
    }
    audit('contact', contactId, 'update', diff(cur, { ...cur, ...next }, Object.keys(next)));
    return { id: contactId };
  });
}

export function setDoNotContact(customerId, input, user) {
  const cur = get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!cur) throw notFound('Customer');
  const on = bool(input.do_not_contact);
  const c = new Check();
  if (on) c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    update('customers', customerId, {
      do_not_contact: on ? 1 : 0, dnc_reason: on ? str(input.reason, 300) : null, dnc_source: on ? str(input.source, 120) : null,
      dnc_date: on ? today() : null, updated_at: nowIso(), version: cur.version + 1,
    });
    history('customer', customerId, on ? 'do_not_contact_set' : 'do_not_contact_cleared', { customerId, note: str(input.reason, 300) });
    audit('customer', customerId, 'do_not_contact', { do_not_contact: on, reason: input.reason, source: input.source });
    return { id: customerId };
  });
}

export function dismissDuplicate(a, b, reason, user) {
  run('INSERT OR REPLACE INTO duplicate_dismissals (customer_a, customer_b, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)', Math.min(a, b), Math.max(a, b), str(reason, 300) || 'Confirmed separate companies', user.id, nowIso());
  audit('customer', a, 'not_duplicate', { other: b, reason });
}

const MERGE_TABLES = ['contacts', 'enquiries', 'quotations', 'orders', 'dispatches', 'tasks', 'activities', 'reactivation_cases', 'attachments', 'invoices', 'receipts', 'payment_holds', 'complaints', 'objects', 'history_events', 'customer_aliases', 'alerts'];

/**
 * Authorised merge of a duplicate into the surviving profile. Every linked record moves across, the old
 * code and name become search aliases, and both profiles keep an audit trail. Nothing is deleted.
 */
export function mergeCustomers(targetId, sourceId, reason, user) {
  if (targetId === sourceId) throw badRequest('Choose two different customers');
  const target = get('SELECT * FROM customers WHERE id = ?', targetId);
  const source = get('SELECT * FROM customers WHERE id = ?', sourceId);
  if (!target || !source) throw notFound('Customer');
  if (target.merged_into_id || source.merged_into_id) throw conflict('One of these profiles has already been merged.');
  const c = new Check();
  c.text('reason', reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  return tx(() => {
    const stamp = nowIso();
    const moved = {};
    if (get('SELECT id FROM contacts WHERE customer_id = ? AND is_primary = 1', targetId)) run('UPDATE contacts SET is_primary = 0 WHERE customer_id = ?', sourceId);
    if (get("SELECT id FROM reactivation_cases WHERE customer_id = ? AND closed_at IS NULL", targetId)) {
      run("UPDATE reactivation_cases SET status = 'not_pursuing', closure_reason_code = 'other', closure_note = 'Duplicate profile merged', closed_at = ? WHERE customer_id = ? AND closed_at IS NULL", stamp, sourceId);
    }
    for (const table of MERGE_TABLES) moved[table] = Number(run(`UPDATE ${table} SET customer_id = ? WHERE customer_id = ?`, targetId, sourceId).changes);
    run("INSERT OR IGNORE INTO taggings (tag_id, entity, entity_id) SELECT tag_id, 'customer', ? FROM taggings WHERE entity = 'customer' AND entity_id = ?", targetId, sourceId);
    run("DELETE FROM taggings WHERE entity = 'customer' AND entity_id = ?", sourceId);
    run('INSERT OR IGNORE INTO customer_interests (customer_id, category_id) SELECT ?, category_id FROM customer_interests WHERE customer_id = ?', targetId, sourceId);
    run('DELETE FROM customer_interests WHERE customer_id = ?', sourceId);
    run("INSERT OR IGNORE INTO pins (user_id, entity_type, entity_id, created_at) SELECT user_id, 'customer', ?, created_at FROM pins WHERE entity_type = 'customer' AND entity_id = ?", targetId, sourceId);
    run("DELETE FROM pins WHERE entity_type = 'customer' AND entity_id = ?", sourceId);
    insert('customer_aliases', { customer_id: targetId, alias: source.company_name, alias_norm: source.name_norm, kind: 'merged_name', created_at: stamp, created_by: user.id });
    insert('customer_aliases', { customer_id: targetId, alias: source.code, alias_norm: normName(source.code), kind: 'merged_code', created_at: stamp, created_by: user.id });
    if (source.external_account_id && !target.external_account_id) {
      update('customers', targetId, { external_source: source.external_source, external_account_id: source.external_account_id });
      update('customers', sourceId, { external_account_id: null });
    }
    if (source.legacy_last_order_date && (!target.legacy_last_order_date || source.legacy_last_order_date > target.legacy_last_order_date)) {
      update('customers', targetId, { legacy_last_order_date: source.legacy_last_order_date, legacy_source: source.legacy_source });
    }
    if (source.do_not_contact && !target.do_not_contact) {
      update('customers', targetId, { do_not_contact: 1, dnc_reason: source.dnc_reason, dnc_source: `Merged from ${source.code}`, dnc_date: source.dnc_date });
    }
    update('customers', sourceId, { merged_into_id: targetId, archived_at: stamp, archived_reason: `Merged into ${target.code}`, updated_at: stamp });
    run('UPDATE customers SET version = version + 1, updated_at = ? WHERE id IN (?, ?)', stamp, targetId, sourceId);
    history('customer', targetId, 'merged_in', { customerId: targetId, data: { source_id: sourceId, source_code: source.code, moved }, note: reason });
    history('customer', sourceId, 'merged_into', { customerId: sourceId, data: { target_id: targetId, target_code: target.code }, note: reason });
    audit('customer', targetId, 'merge', { source_id: sourceId, source_code: source.code, reason, moved });
    return { target_id: targetId, moved };
  });
}

export function archiveCustomer(id, input, user) {
  const cur = get('SELECT * FROM customers WHERE id = ?', id);
  if (!cur) throw notFound('Customer');
  const on = input.archived !== false;
  const c = new Check();
  if (on) c.text('reason', input.reason, { required: true, max: 300, label: 'Reason' });
  c.throwIfAny();
  if (on && get("SELECT id FROM orders WHERE customer_id = ? AND status = 'confirmed' AND closed_at IS NULL LIMIT 1", id)) {
    throw conflict('This customer has active orders. Close or cancel them before archiving.');
  }
  update('customers', id, { archived_at: on ? nowIso() : null, archived_reason: on ? str(input.reason, 300) : null, updated_at: nowIso(), version: cur.version + 1 });
  history('customer', id, on ? 'archived' : 'unarchived', { customerId: id, note: str(input.reason, 300) });
  audit('customer', id, on ? 'archive' : 'unarchive', { reason: input.reason });
  return { id };
}

// ------------------------------------------------------------------ directory & search
export function listCustomers(query, user) {
  const where = ['c.merged_into_id IS NULL'];
  const params = [];
  const scope = customerScope(user, 'c');
  if (scope) where.push(scope);
  if (!bool(query.include_archived)) where.push('c.archived_at IS NULL');
  if (query.q) {
    const q = String(query.q).trim();
    const like = `%${q}%`;
    const pk = phoneKey(normPhone(q, 'IN'));
    where.push(`(c.company_name LIKE ? OR c.code LIKE ? OR c.city LIKE ? OR c.external_account_id = ?
      OR c.id IN (SELECT customer_id FROM customer_aliases WHERE alias LIKE ? OR alias_norm = ?)
      OR c.id IN (SELECT customer_id FROM contacts WHERE email_norm LIKE ? OR name LIKE ? ${pk && pk.length >= 6 ? 'OR phone_norm LIKE ?' : ''})
      OR c.id IN (SELECT customer_id FROM orders WHERE code LIKE ? OR po_reference LIKE ?)
      OR c.id IN (SELECT customer_id FROM enquiries WHERE code LIKE ?))`);
    params.push(like, like, like, q, like, normName(q), like.toLowerCase(), like, ...(pk && pk.length >= 6 ? [`%${pk}%`] : []), like, like, like);
  }
  if (intId(query.owner)) {
    where.push('c.owner_id = ?');
    params.push(intId(query.owner));
  }
  if (query.segment) {
    where.push('c.segment = ?');
    params.push(query.segment);
  }
  if (query.country) {
    where.push('c.country_code = ?');
    params.push(query.country);
  }
  if (query.type) {
    where.push("EXISTS (SELECT 1 FROM json_each(c.types) WHERE value = ?)");
    params.push(query.type);
  }
  if (bool(query.provisional)) where.push('c.provisional = 1');
  if (bool(query.dnc)) where.push('c.do_not_contact = 1');
  if (bool(query.credit_hold)) where.push('c.credit_hold = 1');
  for (const [k, col] of [['region_id', 'c.region_id'], ['campaign_id', 'c.campaign_id']]) {
    if (intId(query[k])) {
      where.push(`${col} = ?`);
      params.push(intId(query[k]));
    }
  }
  for (const [k, col] of [['state', 'c.state'], ['industry', 'c.industry'], ['value_category', 'c.value_category'], ['source', 'c.acquisition_source']]) {
    if (query[k]) {
      where.push(`${col} = ?`);
      params.push(query[k]);
    }
  }
  if (intId(query.tag)) {
    where.push("EXISTS (SELECT 1 FROM taggings g WHERE g.entity = 'customer' AND g.entity_id = c.id AND g.tag_id = ?)");
    params.push(intId(query.tag));
  }
  if (intId(query.interest)) {
    where.push('EXISTS (SELECT 1 FROM customer_interests ci WHERE ci.customer_id = c.id AND ci.category_id = ?)');
    params.push(intId(query.interest));
  }
  // Relationship status is derived, never stored: prospect (no order), active buyer, dormant buyer, with open work.
  const dormantFrom = addDays(today(), -settings().rules.dormantDays);
  if (query.status === 'prospect') where.push(`NOT ${HAS_ORDERS_SQL('c')}`);
  else if (query.status === 'active') where.push(`${HAS_ORDERS_SQL('c')} AND ${EFFECTIVE_LAST_ORDER_SQL('c')} >= '${dormantFrom}'`);
  else if (query.status === 'dormant') where.push(`${HAS_ORDERS_SQL('c')} AND (${EFFECTIVE_LAST_ORDER_SQL('c')} < '${dormantFrom}' OR ${EFFECTIVE_LAST_ORDER_SQL('c')} IS NULL)`);
  else if (query.status === 'open_work') where.push(`(EXISTS (SELECT 1 FROM enquiries e WHERE e.customer_id = c.id AND e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')})) OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed' AND o.closed_at IS NULL))`);
  const sorts = {
    name: 'c.company_name', last_order: 'last_order_date', last_contact: 'last_contact_at', created: 'c.created_at',
  };
  const sortCol = sorts[query.sort] || 'c.company_name';
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const pageSize = Math.min(Number(query.pageSize) || 50, 500);
  const page = Math.max(Number(query.page) || 1, 1);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const count = get(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`, ...params).n;
  const rows = all(
    `SELECT c.id, c.code, c.company_name, c.country_code, c.city, c.state, c.segment, c.types, c.provisional, c.do_not_contact, c.archived_at, c.owner_id,
      c.industry, c.value_category, c.region_id, c.credit_hold, rg.name AS region_name, u.name AS owner_name,
      ${HAS_ORDERS_SQL('c')} AS has_orders,
      (SELECT GROUP_CONCAT(t.name, '|') FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.entity = 'customer' AND g.entity_id = c.id) AS tag_names,
      ${EFFECTIVE_LAST_ORDER_SQL('c')} AS last_order_date,
      ${LAST_CONTACT_SQL('c')} AS last_contact_at,
      (SELECT COUNT(*) FROM enquiries e WHERE e.customer_id = c.id AND e.stage IN (${OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',')})) AS open_enquiries,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'confirmed' AND o.closed_at IS NULL) AS active_orders,
      (SELECT COALESCE(phone_raw, email_raw) FROM contacts ct WHERE ct.customer_id = c.id AND ct.active = 1 ORDER BY ct.is_primary DESC, ct.id LIMIT 1) AS primary_contact
     FROM customers c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN regions rg ON rg.id = c.region_id ${whereSql}
     ORDER BY ${sortCol} ${dir} NULLS LAST, c.id LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  ).map((r) => ({
    ...r,
    types: parseJson(r.types, []),
    tags: r.tag_names ? r.tag_names.split('|') : [],
    relationship: !r.has_orders ? 'prospect' : r.last_order_date && r.last_order_date >= dormantFrom ? 'active' : 'dormant',
  }));
  return { rows, count, page, pageSize };
}

/** Facet counts for the segment panel (within the user's scope). */
export function customerFacets(user) {
  const scope = customerScope(user, 'c');
  const base = `FROM customers c WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL ${scope ? `AND ${scope}` : ''}`;
  const facet = (col) => all(`SELECT ${col} AS value, COUNT(*) AS n ${base} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC`);
  return {
    regions: all(`SELECT rg.id AS value, rg.name AS label, COUNT(*) AS n FROM customers c JOIN regions rg ON rg.id = c.region_id WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL ${scope ? `AND ${scope}` : ''} GROUP BY rg.id ORDER BY rg.sort_order`),
    states: facet('c.state'),
    industries: facet('c.industry'),
    value_categories: facet('c.value_category'),
    sources: facet('c.acquisition_source').map((x) => ({ ...x, label: optionLabel('enquiry_source', x.value) })),
    tags: all(`SELECT t.id AS value, t.name AS label, t.color, COUNT(*) AS n FROM taggings g JOIN tags t ON t.id = g.tag_id JOIN customers c ON c.id = g.entity_id
      WHERE g.entity = 'customer' AND c.merged_into_id IS NULL AND c.archived_at IS NULL ${scope ? `AND ${scope}` : ''} GROUP BY t.id ORDER BY t.name`),
    interests: all(`SELECT pc.id AS value, pc.name AS label, COUNT(*) AS n FROM customer_interests ci JOIN product_categories pc ON pc.id = ci.category_id JOIN customers c ON c.id = ci.customer_id
      WHERE c.merged_into_id IS NULL AND c.archived_at IS NULL ${scope ? `AND ${scope}` : ''} GROUP BY pc.id ORDER BY pc.name`),
    campaigns: all(`SELECT cp.id AS value, cp.name AS label, COUNT(*) AS n FROM customers c JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.merged_into_id IS NULL ${scope ? `AND ${scope}` : ''} GROUP BY cp.id ORDER BY cp.name`),
  };
}

/** Every person across all (visible) customers, by role, with call / WhatsApp / email details. */
export function listContacts(query, user) {
  const where = ['c.merged_into_id IS NULL', 'ct.active = 1'];
  const params = [];
  const scope = customerScope(user, 'c');
  if (scope) where.push(scope);
  if (query.q) {
    const like = `%${String(query.q).trim()}%`;
    where.push('(ct.name LIKE ? OR ct.email_raw LIKE ? OR ct.phone_raw LIKE ? OR ct.role LIKE ? OR c.company_name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (query.contact_role) {
    where.push('ct.contact_role = ?');
    params.push(query.contact_role);
  }
  const pageSize = Math.min(Number(query.pageSize) || 100, 500);
  const page = Math.max(Number(query.page) || 1, 1);
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const count = get(`SELECT COUNT(*) AS n FROM contacts ct JOIN customers c ON c.id = ct.customer_id ${whereSql}`, ...params).n;
  const rows = all(`SELECT ct.*, c.company_name, c.code AS customer_code, c.city, c.do_not_contact,
      (SELECT MAX(a.occurred_at) FROM activities a WHERE a.contact_id = ct.id AND a.customer_contact = 1) AS last_contact_at
    FROM contacts ct JOIN customers c ON c.id = ct.customer_id ${whereSql} ORDER BY c.company_name, ct.is_primary DESC, ct.name LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize)
    .map((r) => ({ ...r, contact_role_label: labelOf(CONTACT_ROLES, r.contact_role) }));
  return { rows, count, page, pageSize };
}

// ------------------------------------------------------------------ profile
function orderRowsForCustomer(customerId) {
  const orders = all(`SELECT o.*, u.name AS owner_name FROM orders o LEFT JOIN users u ON u.id = o.owner_id WHERE o.customer_id = ? ORDER BY COALESCE(o.received_date, o.created_at) DESC, o.id DESC`, customerId);
  const lines = orders.length ? all(`SELECT l.*, p.code AS product_code, o.status AS order_status,
      (SELECT MAX(d.dispatch_date) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted') AS last_dispatch_date,
      (SELECT MAX(d.date_unknown) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE dl.line_id = l.id AND d.status = 'posted') AS dispatch_date_unknown
    FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN products p ON p.id = l.product_id WHERE o.customer_id = ? ORDER BY l.order_id, l.line_no`, customerId) : [];
  const byOrder = new Map(orders.map((o) => [o.id, []]));
  for (const l of lines) byOrder.get(l.order_id)?.push(l);
  return { orders, byOrder };
}

/**
 * Line-level dispatch timeliness against the ORIGINAL commitment. A line is on time only if its
 * non-cancelled quantity was fully dispatched by its original date. Unknown commitments are excluded
 * and counted; fully cancelled lines are reported separately.
 */
export function timelinessForLines(lines) {
  const out = { eligible: 0, on_time: 0, late: 0, excluded_unknown: 0, cancelled_lines: 0, open_overdue: 0 };
  const day = today();
  for (const l of lines) {
    if (l.order_status !== 'confirmed') continue;
    const q = lineQty(l);
    if (isPositive(q.remaining)) {
      if (lineStatus(l, day, 'confirmed').overdue) out.open_overdue++;
      continue;
    }
    if (!isPositive(q.dispatched)) {
      out.cancelled_lines++;
      continue;
    }
    if (l.commitment_state !== 'committed' || !l.original_commitment_date || !l.last_dispatch_date || l.dispatch_date_unknown) {
      out.excluded_unknown++;
      continue;
    }
    out.eligible++;
    if (l.last_dispatch_date <= l.original_commitment_date) out.on_time++;
    else out.late++;
  }
  return out;
}

/**
 * Communication state of a line, decided by its latest dispatch-date revision: a late revision needs the
 * customer informed; informing one revision never covers a later one; a recovered forecast needs nothing.
 */
export function commStateForLine(lineId) {
  const rev = get("SELECT * FROM commitment_changes WHERE line_id = ? AND kind IN ('forecast_dispatch','missed') ORDER BY id DESC LIMIT 1", lineId);
  if (!rev || (!rev.comm_required && !rev.informed_at)) return { state: 'not_needed' };
  if (!rev.informed_at) return { state: 'pending', revision_id: rev.id, since: rev.created_at, new_date: rev.new_date, kind: rev.kind };
  const by = rev.informed_by ? get('SELECT name FROM users WHERE id = ?', rev.informed_by)?.name : null;
  return { state: 'informed', revision_id: rev.id, informed_at: rev.informed_at, informed_by_name: by, response: rev.customer_response, agreed_date: rev.agreed_date, new_date: rev.new_date };
}

export function healthLabels(customerId, facts) {
  const labels = [];
  const r = settings().rules;
  if (facts.followupDue) labels.push({ code: 'followup_due', label: 'Follow-up due', tone: 'amber' });
  if (facts.hasOrders && facts.lastOrder && daysBetween(facts.lastOrder, today()) >= r.dormantDays) labels.push({ code: 'dormant', label: `No order for ${r.dormantDays} days`, tone: 'violet' });
  if (facts.hasOrders && !facts.lastOrder) labels.push({ code: 'order_date_unknown', label: 'Last order date unknown', tone: 'slate' });
  if (facts.activeDelay) labels.push({ code: 'active_delay', label: 'Active delay', tone: 'red' });
  if (facts.commPending) labels.push({ code: 'not_informed', label: 'Customer not informed of delay', tone: 'red' });
  if (facts.openComplaint) labels.push({ code: 'open_complaint', label: 'Open complaint', tone: 'red' });
  if (facts.paymentOverdue) labels.push({ code: 'payment_overdue', label: 'Payment overdue', tone: 'red' });
  if (facts.paymentHold) labels.push({ code: 'payment_hold', label: 'Payment hold', tone: 'amber' });
  if (facts.dnc) labels.push({ code: 'dnc', label: 'Do not contact', tone: 'slate' });
  if (facts.provisional) labels.push({ code: 'provisional', label: 'Provisional record', tone: 'slate' });
  return labels;
}

export function getCustomerProfile(id, user) {
  const c = get(`SELECT c.*, u.name AS owner_name, m.code AS merged_into_code, rg.name AS region_name, cp.name AS campaign_name FROM customers c LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN customers m ON m.id = c.merged_into_id LEFT JOIN regions rg ON rg.id = c.region_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.id = ?`, id);
  if (!c) throw notFound('Customer');
  const day = today();
  const contacts = all('SELECT * FROM contacts WHERE customer_id = ? ORDER BY active DESC, is_primary DESC, id', id);
  const aliases = all('SELECT alias, kind, created_at FROM customer_aliases WHERE customer_id = ? ORDER BY id', id);
  const { orders, byOrder } = orderRowsForCustomer(id);
  const allLines = [...byOrder.values()].flat();

  const confirmed = orders.filter((o) => o.status === 'confirmed');
  const counts = { confirmed: confirmed.length, active: 0, fully_dispatched: 0, fully_cancelled: 0, dispatched_and_cancelled: 0, drafts: orders.length - confirmed.length };
  const recentOrders = [];
  const attention = [];
  let activeDelay = false;
  let commPending = false;
  const balance = { lines: 0, by_unit: {}, value_by_currency: {} };
  const totalsByCurrency = {};
  for (const o of orders) {
    const lines = byOrder.get(o.id) || [];
    const sum = orderSummary(o, lines, day);
    if (o.status === 'confirmed') {
      if (sum.active) counts.active++;
      else if (sum.outcome.includes('fully_dispatched')) counts.fully_dispatched++;
      else if (sum.outcome.includes('fully_cancelled')) counts.fully_cancelled++;
      else counts.dispatched_and_cancelled++;
      const cur = o.currency || 'INR';
      for (const l of lines) {
        const v = lineValueMinor(l.confirmed_qty - l.cancelled_qty, l.unit_price_minor);
        const t = (totalsByCurrency[cur] ||= { currency: cur, value_minor: 0, orders: new Set(), lines_without_price: 0 });
        t.orders.add(o.id);
        if (v === null) t.lines_without_price++;
        else t.value_minor += v;
        const q = lineQty(l);
        if (sum.active && isPositive(q.remaining)) {
          balance.lines++;
          balance.by_unit[l.unit] = (balance.by_unit[l.unit] || 0) + q.remaining;
          const rv = lineValueMinor(q.remaining, l.unit_price_minor);
          if (rv !== null) balance.value_by_currency[cur] = (balance.value_by_currency[cur] || 0) + rv;
        }
        const st = lineStatus(l, day, o.status);
        if (st.active && (st.delayed || st.issue)) {
          const comm = commStateForLine(l.id);
          if (st.delayed) activeDelay = true;
          if (comm.state === 'pending') commPending = true;
          const issue = l.issue_code ? optionLabel('delay_reason', l.issue_code) : null;
          const action = get(`SELECT t.id, t.purpose, t.due_date, t.overdue_at, u.name AS owner_name FROM tasks t JOIN users u ON u.id = t.owner_id
            WHERE t.line_id = ? AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1`, l.id);
          attention.push({
            type: st.delayed ? 'delay' : 'issue', order_id: o.id, order_code: o.code, line_id: l.id, product: l.product_code || l.description,
            state: st.state, days_late: st.daysLate, original_date: l.original_commitment_date, forecast_date: l.forecast_dispatch_date,
            agreed_date: l.agreed_commitment_date, estimate_unknown: Boolean(l.estimate_unknown), reason: issue, note: l.stage_note,
            communication: comm, next_action: action ? { ...action, due_state: decorateTask({ ...action, status: 'open', due_time: null }).due_state } : null,
          });
        }
      }
    }
    if (recentOrders.length < 6) {
      const first = lines[0];
      recentOrders.push({
        id: o.id, code: o.code, status: o.status, received_date: o.received_date,
        product: lines.length ? `${lines.length > 1 ? `${lines.length} lines: ` : ''}${first.confirmed_qty} × ${first.product_code || first.description}${lines.length > 1 ? ' …' : ''}` : '—',
        original_date: sum.earliest_due ?? (lines.find((l) => l.original_commitment_date)?.original_commitment_date || null),
        forecast_date: lines.filter((l) => isPositive(lineQty(l).remaining)).map((l) => l.forecast_dispatch_date).filter(Boolean).sort()[0] || null,
        last_dispatch_date: lines.map((l) => l.last_dispatch_date).filter(Boolean).sort().at(-1) || null,
        phase: sum.phase, outcome: sum.outcome, active: sum.active, delayed: sum.delayed, overdue: sum.overdue,
        cancel_reason: lines.length && sum.outcome.includes('fully_cancelled')
          ? optionLabel('cancel_reason', get('SELECT reason_code FROM cancellations WHERE order_id = ? AND reversed_at IS NULL ORDER BY id DESC LIMIT 1', o.id)?.reason_code) : null,
      });
    }
  }

  const lastOrderRecorded = confirmed.map((o) => o.received_date).filter(Boolean).sort().at(-1) || null;
  const firstOrderRecorded = confirmed.map((o) => o.received_date).filter(Boolean).sort()[0] || null;
  const lastOrder = [lastOrderRecorded, c.legacy_last_order_date].filter(Boolean).sort().at(-1) || null;
  const firstOrder = [firstOrderRecorded, c.legacy_first_order_date].filter(Boolean).sort()[0] || null;
  const hasOrders = confirmed.length > 0 || Boolean(c.legacy_order_count) || Boolean(c.legacy_last_order_date);

  const nextTask = get(`SELECT ${TASK_COLUMNS} FROM tasks t JOIN users u ON u.id = t.owner_id LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN enquiries e ON e.id = t.enquiry_id LEFT JOIN orders o ON o.id = t.order_id WHERE t.customer_id = ? AND t.status = 'open' ORDER BY t.overdue_at LIMIT 1`, id);
  const openTasks = all("SELECT id, due_date, due_time, overdue_at, status FROM tasks WHERE customer_id = ? AND status = 'open'", id);
  const followupDue = openTasks.some((t) => ['today', 'overdue'].includes(decorateTask(t).due_state));
  const lastContact = get(`SELECT a.occurred_at, a.channel, a.outcome, u.name AS entered_by_name, a.reported_by_name FROM activities a LEFT JOIN users u ON u.id = a.entered_by
    WHERE a.customer_id = ? AND a.customer_contact = 1 AND a.meaningful = 1 ORDER BY a.occurred_at DESC LIMIT 1`, id);
  const lastAttempt = get(`SELECT a.occurred_at, a.channel, a.outcome FROM activities a WHERE a.customer_id = ? AND a.customer_contact = 1 ORDER BY a.occurred_at DESC LIMIT 1`, id);
  const enquiries = all(`SELECT e.id, e.code, e.stage, e.received_at, e.received_unknown, e.lost_reason_code, e.lost_note, e.decided_at, e.cancel_reason_code, u.name AS owner_name,
      (SELECT GROUP_CONCAT(COALESCE(p.code, el.requirement), ', ') FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id) AS products
    FROM enquiries e LEFT JOIN users u ON u.id = e.owner_id WHERE e.customer_id = ? ORDER BY COALESCE(e.received_at, e.created_at) DESC`, id);
  const openOpps = enquiries.filter((e) => OPEN_ENQUIRY_STAGES.includes(e.stage)).length;
  const missedReasons = enquiries.filter((e) => e.stage === 'lost').map((e) => ({
    enquiry_id: e.id, code: e.code, reason_code: e.lost_reason_code, reason: optionLabel('lost_reason', e.lost_reason_code), note: e.lost_note, decided_at: e.decided_at, products: e.products,
  }));
  const openComplaint = get("SELECT id FROM complaints WHERE customer_id = ? AND status NOT IN ('resolved','closed') LIMIT 1", id);
  const holds = all(`SELECT h.*, o.code AS order_code FROM payment_holds h JOIN orders o ON o.id = h.order_id WHERE h.customer_id = ? AND h.released_at IS NULL`, id);
  const invoices = all(`SELECT i.*, ${outstandingSql('i')} AS outstanding_minor FROM invoices i WHERE i.customer_id = ?`, id);
  const payment = { has_data: invoices.length > 0, outstanding_by_currency: {}, overdue_by_currency: {}, broken_promises: 0 };
  for (const inv of invoices) {
    const out = inv.outstanding_minor;
    if (out > 0) {
      payment.outstanding_by_currency[inv.currency] = (payment.outstanding_by_currency[inv.currency] || 0) + out;
      if (inv.due_date && inv.due_date < day) payment.overdue_by_currency[inv.currency] = (payment.overdue_by_currency[inv.currency] || 0) + out;
      if (inv.promise_date && inv.promise_date < day) payment.broken_promises++;
    }
  }
  const paymentOverdue = Object.keys(payment.overdue_by_currency).length > 0;
  for (const h of holds) attention.push({ type: 'payment_hold', order_id: h.order_id, order_code: h.order_code, reason: h.reason, since: h.held_at });
  if (openComplaint) {
    for (const k of all("SELECT id, code, category_code, status, received_date FROM complaints WHERE customer_id = ? AND status NOT IN ('resolved','closed')", id)) {
      attention.push({ type: 'complaint', complaint_id: k.id, code: k.code, reason: optionLabel('complaint_category', k.category_code), status: k.status, since: k.received_date });
    }
  }
  const overdueTasks = openTasks.filter((t) => decorateTask(t).due_state === 'overdue').length;
  if (overdueTasks) attention.push({ type: 'followup_overdue', count: overdueTasks });

  const productsBought = all(`SELECT COALESCE(p.code, l.description) AS product, l.unit, SUM(l.confirmed_qty - l.cancelled_qty) AS qty, COUNT(DISTINCT l.order_id) AS orders
    FROM order_lines l JOIN orders o ON o.id = l.order_id LEFT JOIN products p ON p.id = l.product_id WHERE o.customer_id = ? AND o.status = 'confirmed'
    GROUP BY 1, 2 ORDER BY qty DESC LIMIT 12`, id);
  const productsEnquired = all(`SELECT COALESCE(p.code, el.requirement, 'Unspecified') AS product, COUNT(DISTINCT el.enquiry_id) AS enquiries
    FROM enquiry_lines el JOIN enquiries e ON e.id = el.enquiry_id LEFT JOIN products p ON p.id = el.product_id WHERE e.customer_id = ? GROUP BY 1 ORDER BY enquiries DESC LIMIT 12`, id);
  const reactivation = get(`SELECT rc.*, u.name AS owner_name FROM reactivation_cases rc LEFT JOIN users u ON u.id = rc.owner_id WHERE rc.customer_id = ? ORDER BY rc.closed_at IS NOT NULL, rc.id DESC LIMIT 1`, id);

  const delivery = timelinessForLines(allLines);
  const facts = {
    followupDue, hasOrders, lastOrder, activeDelay, commPending, openComplaint: Boolean(openComplaint), paymentOverdue,
    paymentHold: holds.length > 0, dnc: Boolean(c.do_not_contact), provisional: Boolean(c.provisional),
  };
  const priority = { delay: 0, issue: 2, payment_hold: 3, complaint: 4, followup_overdue: 1 };
  attention.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9) || (b.days_late || 0) - (a.days_late || 0));

  const quotations = all(`SELECT q.id, q.number, q.subject, q.enquiry_id, r.revision_no, r.status, r.currency, r.total_minor, r.sent_at, r.validity_date, r.approval_status
    FROM quotations q JOIN quote_revisions r ON r.quotation_id = q.id AND r.revision_no = (SELECT MAX(r2.revision_no) FROM quote_revisions r2 WHERE r2.quotation_id = q.id)
    WHERE q.customer_id = ? ORDER BY q.id DESC LIMIT 100`, id).map((q) => ({ ...q, status_label: labelOf(QUOTE_STATUSES, q.status), expired: q.status === 'issued' && q.validity_date && q.validity_date < day }));
  return {
    customer: {
      ...c, types: parseJson(c.types, []), aliases, tags: tagsFor(id), interests: interestsFor(id),
      value_category_label: labelOf(VALUE_CATEGORIES, c.value_category), acquisition_source_label: optionLabel('enquiry_source', c.acquisition_source),
    },
    quotations,
    objects: all('SELECT id, public_id, name, serial_number, status, scan_count FROM objects WHERE customer_id = ? AND deleted_at IS NULL ORDER BY id DESC', id),
    complaints: all("SELECT id, code, status, severity, category_code, received_date FROM complaints WHERE customer_id = ? ORDER BY received_date DESC", id).map((k) => ({ ...k, category: optionLabel('complaint_category', k.category_code) })),
    contacts,
    summary: {
      first_order_date: firstOrder,
      first_order_source: firstOrder && firstOrder === firstOrderRecorded ? 'orders' : firstOrder ? 'imported history' : null,
      last_order_date: lastOrder,
      last_order_source: lastOrder && lastOrder === lastOrderRecorded ? 'orders' : lastOrder ? `imported history${c.legacy_source ? ` (${c.legacy_source})` : ''}` : null,
      has_orders: hasOrders,
      legacy_order_count: c.legacy_order_count,
      orders: counts,
      last_enquiry_date: enquiries.find((e) => e.received_at)?.received_at || null,
      last_contact: lastContact ? { ...lastContact, outcome_label: optionLabel('contact_outcome', lastContact.outcome) ?? optionLabel('customer_update_outcome', lastContact.outcome) } : null,
      last_attempt: lastAttempt,
      open_opportunities: openOpps,
      active_balance: balance,
      next_action: nextTask ? decorateTask(nextTask) : null,
      dormant_threshold_days: settings().rules.dormantDays,
    },
    delivery,
    attention,
    health: healthLabels(id, facts),
    commercial: {
      products_bought: productsBought,
      products_enquired: productsEnquired,
      order_totals_by_currency: Object.values(totalsByCurrency).map((t) => ({ currency: t.currency, value_minor: t.value_minor, orders: t.orders.size, lines_without_price: t.lines_without_price })),
      missed_reasons: missedReasons,
    },
    recent_orders: recentOrders,
    enquiries: enquiries.map((e) => ({ ...e, stage_label: labelOf(ENQUIRY_STAGES, e.stage), lost_reason: optionLabel('lost_reason', e.lost_reason_code) })),
    reactivation,
    payment,
    pinned: Boolean(get("SELECT 1 FROM pins WHERE user_id = ? AND entity_type = 'customer' AND entity_id = ?", user.id, id)),
    documents: customerDocuments(id),
    recent_interactions: customerTimeline(id, { limit: 6 }),
  };
}

export function customerDocuments(customerId) {
  return all(`SELECT DISTINCT a.id, a.original_name, a.mime, a.size, a.uploaded_at, a.description, a.visibility, u.name AS uploaded_by_name,
      (SELECT GROUP_CONCAT(l.entity_type || ':' || l.entity_id) FROM attachment_links l WHERE l.attachment_id = a.id) AS links
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.customer_id = ? ORDER BY a.uploaded_at DESC`, customerId);
}

// ------------------------------------------------------------------ timeline
const CALL_CHANNELS = new Set(['phone', 'whatsapp', 'meeting', 'video', 'exhibition', 'other']);

/**
 * Newest-first history assembled from linked records. Internal reminders are never shown as customer
 * communications, and back-entered records show both when they happened and when they were entered.
 */
export function customerTimeline(customerId, { filter = 'all', limit = 200 } = {}) {
  const items = [];
  const zone = tz();
  for (const a of all(`SELECT a.*, u.name AS entered_by_name, ct.name AS contact_name, e.code AS enquiry_code, o.code AS order_code
      FROM activities a LEFT JOIN users u ON u.id = a.entered_by LEFT JOIN contacts ct ON ct.id = a.contact_id
      LEFT JOIN enquiries e ON e.id = a.enquiry_id LEFT JOIN orders o ON o.id = a.order_id
      WHERE a.customer_id = ? ORDER BY a.occurred_at DESC LIMIT 400`, customerId)) {
    const group = a.kind === 'quotation' ? 'quotations' : a.kind === 'complaint' ? 'complaints' : !a.customer_contact ? 'internal'
      : a.channel === 'email' ? 'emails' : a.order_id && a.kind === 'order_comm' ? 'orders' : CALL_CHANNELS.has(a.channel) ? 'calls' : 'calls';
    const outcome = a.kind === 'quotation' ? 'Quotation sent' : optionLabel('contact_outcome', a.outcome) ?? optionLabel('customer_update_outcome', a.outcome) ?? a.outcome;
    items.push({
      key: `a${a.id}`, at: a.occurred_at, entered_at: a.entered_at, group, icon: a.customer_contact ? a.channel : 'note',
      title: a.customer_contact ? `${optionLabel('channel', a.channel)} — ${outcome}` : `Internal note${a.outcome && a.outcome !== 'note' && a.outcome !== 'done' ? ` — ${a.outcome}` : ''}`,
      detail: a.note, ref: a.order_code || a.enquiry_code, link: a.order_id ? `/orders/${a.order_id}` : a.enquiry_id ? `/enquiries/${a.enquiry_id}` : null,
      actor: a.entered_by_name, reported_by: a.reported_by_name, contact: a.contact_name, customer_contact: Boolean(a.customer_contact),
      backdated: Date.parse(a.entered_at) - Date.parse(a.occurred_at) > 6 * 3600000, technical_issue: Boolean(a.technical_issue),
    });
  }
  for (const h of all(`SELECT h.*, u.name AS actor_name FROM history_events h LEFT JOIN users u ON u.id = h.actor_id WHERE h.customer_id = ? ORDER BY h.created_at DESC LIMIT 400`, customerId)) {
    const data = parseJson(h.data, {});
    const ref = h.entity_type === 'enquiry' ? get('SELECT code FROM enquiries WHERE id = ?', h.entity_id)?.code
      : h.entity_type === 'order' ? get('SELECT code FROM orders WHERE id = ?', h.entity_id)?.code
        : h.entity_type === 'complaint' ? get('SELECT code FROM complaints WHERE id = ?', h.entity_id)?.code : null;
    const title = describeHistory(h, data);
    if (!title) continue;
    items.push({
      key: `h${h.id}`, at: h.occurred_at || h.created_at, entered_at: h.created_at,
      group: h.entity_type === 'order' ? 'orders' : h.entity_type === 'complaint' ? 'complaints' : h.entity_type === 'quotation' ? 'quotations' : h.entity_type === 'enquiry' ? 'enquiries' : 'internal',
      icon: h.entity_type, title, detail: h.note, ref, link: h.entity_type === 'order' ? `/orders/${h.entity_id}` : h.entity_type === 'enquiry' ? `/enquiries/${h.entity_id}` : h.entity_type === 'complaint' ? `/complaints/${h.entity_id}` : null,
      actor: h.actor_name, backdated: h.occurred_at ? Date.parse(h.created_at) - Date.parse(h.occurred_at) > 6 * 3600000 : false,
    });
  }
  for (const u of all(`SELECT ou.*, o.code AS order_code, l.line_no, COALESCE(p.code, l.description) AS product, us.name AS entered_by_name
      FROM order_updates ou JOIN orders o ON o.id = ou.order_id LEFT JOIN order_lines l ON l.id = ou.line_id LEFT JOIN products p ON p.id = l.product_id
      LEFT JOIN users us ON us.id = ou.entered_by WHERE o.customer_id = ? AND ou.kind IN ('progress','issue','correction','amend') ORDER BY ou.occurred_at DESC LIMIT 300`, customerId)) {
    items.push({
      key: `u${u.id}`, at: u.occurred_at, entered_at: u.entered_at, group: 'orders', icon: 'production',
      title: `${u.order_code}${u.product ? ` · ${u.product}` : ''}: ${summariseChanges(parseJson(u.changes, {}))}`,
      detail: u.note, ref: u.order_code, link: `/orders/${u.order_id}`, actor: u.entered_by_name, reported_by: u.reported_by_name,
      backdated: Date.parse(u.entered_at) - Date.parse(u.occurred_at) > 6 * 3600000, historical: Boolean(u.historical),
    });
  }
  for (const d of all(`SELECT d.*, GROUP_CONCAT(o.code || ': ' || dl.qty || ' × ' || COALESCE(p.code, l.description), '; ') AS summary, MIN(o.id) AS order_id
      FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id JOIN orders o ON o.id = dl.order_id JOIN order_lines l ON l.id = dl.line_id
      LEFT JOIN products p ON p.id = l.product_id WHERE d.customer_id = ? GROUP BY d.id ORDER BY d.dispatch_date DESC LIMIT 200`, customerId)) {
    const at = d.dispatch_date ? new Date(`${d.dispatch_date}T12:00:00+05:30`).toISOString() : d.created_at;
    items.push({
      key: `d${d.id}`, at, entered_at: d.created_at, group: 'orders', icon: 'dispatch',
      title: `${d.status === 'reversed' ? 'Dispatch reversed' : 'Dispatched'} ${d.code}${d.date_unknown ? ' (date unknown)' : ''}`, detail: [d.summary, d.reversal_reason ? `Reversal: ${d.reversal_reason}` : null].filter(Boolean).join(' — '),
      link: `/orders/${d.order_id}`, ref: d.code,
    });
  }
  for (const x of all(`SELECT k.*, o.code AS order_code, COALESCE(p.code, l.description) AS product, u.name AS actor_name FROM cancellations k JOIN orders o ON o.id = k.order_id
      JOIN order_lines l ON l.id = k.line_id LEFT JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = k.created_by WHERE o.customer_id = ?`, customerId)) {
    items.push({
      key: `k${x.id}`, at: x.created_at, entered_at: x.created_at, group: 'orders', icon: 'cancel',
      title: `${x.order_code}: ${x.qty} × ${x.product} cancelled — ${optionLabel('cancel_reason', x.reason_code)}${x.reversed_at ? ' (later reversed)' : ''}`,
      detail: x.note, link: `/orders/${x.order_id}`, ref: x.order_code, actor: x.actor_name,
    });
  }
  for (const r of all(`SELECT r.*, i.invoice_ref, o.code AS order_code, COALESCE(r.currency, i.currency, o.currency) AS cur FROM receipts r
      LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN orders o ON o.id = r.order_id WHERE r.customer_id = ?`, customerId)) {
    const what = r.kind === 'credit' ? 'Credit note' : r.kind === 'advance' ? 'Advance received' : 'Receipt';
    items.push({
      key: `r${r.id}`, at: new Date(`${r.effective_date}T12:00:00+05:30`).toISOString(), entered_at: r.created_at, group: 'payments', icon: 'payment',
      title: `${what} ${r.invoice_ref ? `against ${r.invoice_ref}` : r.order_code ? `for ${r.order_code}` : ''}${r.reversed_at ? ' (reversed)' : ''}`, detail: r.note, value_minor: r.amount_minor, currency: r.cur,
    });
  }
  const filtered = filter === 'all' ? items : items.filter((i) => i.group === filter);
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filtered.slice(0, limit).map((i) => ({ ...i, local_date: i.at ? localDate(new Date(i.at), zone) : null }));
}

const FIELD_LABELS = {
  phase: 'phase', work_status: 'status', issue_code: 'delay reason', forecast_dispatch_date: 'dispatch forecast', forecast_ready_date: 'expected ready date',
  ready_qty: 'ready quantity', stage_note: 'note', estimate_unknown: 'estimate', confirmed_qty: 'confirmed quantity', spec: 'specification',
  original_commitment_date: 'original commitment', hold_review_date: 'review date',
};
export function summariseChanges(changes) {
  const parts = [];
  for (const [k, [a, b]] of Object.entries(changes)) {
    const label = FIELD_LABELS[k] || k.replace(/_/g, ' ');
    const fmt = (v) => {
      if (v === null || v === undefined || v === '') return '—';
      if (k === 'phase') return labelOf(PHASES, v);
      if (k === 'work_status') return String(v).replace(/_/g, ' ');
      if (k === 'issue_code') return optionLabel('delay_reason', v);
      if (k === 'estimate_unknown') return v ? 'unknown' : 'known';
      return v;
    };
    parts.push(`${label} ${fmt(a)} → ${fmt(b)}`);
  }
  return parts.length ? parts.join('; ') : 'No change — still on track';
}

function describeHistory(h, data) {
  switch (`${h.entity_type}.${h.kind}`) {
    case 'customer.created': return 'Customer record created';
    case 'customer.merged_in': return `Merged duplicate profile ${data.source_code} into this customer`;
    case 'customer.merged_into': return `Profile merged into ${data.target_code}`;
    case 'customer.do_not_contact_set': return 'Marked do-not-contact';
    case 'customer.do_not_contact_cleared': return 'Do-not-contact cleared';
    case 'customer.owner_changed': return 'Customer owner changed';
    case 'customer.archived': return 'Customer archived';
    case 'enquiry.created': return 'Enquiry received';
    case 'enquiry.stage_changed': return `Enquiry moved to ${labelOf(ENQUIRY_STAGES, data.to)}${data.reason ? ` — ${data.reason}` : ''}`;
    case 'enquiry.reopened': return 'Enquiry reopened';
    case 'enquiry.first_response': return null;
    case 'enquiry.no_followup': return 'No further follow-up planned';
    case 'quotation.accepted': return `Quotation ${data.number} rev ${data.revision} accepted`;
    case 'quotation.rejected': return `Quotation ${data.number} rev ${data.revision} rejected — ${optionLabel('lost_reason', data.reason) || 'no reason recorded'}`;
    case 'order.created': return `Order ${data.code} entered${data.status === 'draft' ? ' as draft' : ''}`;
    case 'order.confirmed': return `Order ${data.code} confirmed`;
    case 'order.closed': return `Order ${data.code} closed — ${data.outcome}`;
    case 'order.reopened': return `Order ${data.code} reopened`;
    case 'order.date_change': return `${data.code}: ${data.label}`;
    case 'order.customer_informed': return `${data.code}: customer informed of date change`;
    case 'complaint.created': return `Complaint ${data.code} registered`;
    case 'complaint.status_changed': return `Complaint moved to ${String(data.to).replace(/_/g, ' ')}`;
    default: return null;
  }
}

export function customerExists(id) {
  return Boolean(get('SELECT id FROM customers WHERE id = ?', id));
}

export function activitiesForCustomer(id) {
  return activitiesWhere('customer_id', id, 300);
}

export function documentsForCustomer(id) {
  return attachmentsFor('customer', id);
}

export { addDays };
