// Import wizard: template → upload → map → preview (no writes) → resolve duplicates → idempotent commit
// → result log → retry failed rows → guarded rollback. Unknown historical values stay unknown.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, insert, run, tx, update, FILE_DIR } from '../db.js';
import {
  HttpError, badRequest, conflict, notFound, nowIso, today, str, intId, bool, sha256, token, normName, normEmail, normPhone, audit, settings, calendar,
} from '../util.js';
import { isDate, addWorkingDays } from '../../shared/dates.js';
import { COUNTRIES, OPEN_ENQUIRY_STAGES, DROPDOWNS } from '../../shared/constants.js';
import { round3 } from '../../shared/rules.js';
import { sheetsFromUpload, toCsv } from '../lib/files.js';
import { createCustomer, findMatches } from './customers.js';
import { createEnquiry } from './enquiries.js';
import { createOrder, postDispatch, cancelQuantity, recalcLine, recalcOrder } from './orders.js';
import { createTask } from './tasks.js';

const col = (key, label, help, example, required = false) => ({ key, label, help, example, required });
export const TEMPLATES = {
  customers: {
    label: 'Customers & contacts',
    columns: [
      col('external_id', 'Source ID', 'The customer ID in the old system — used to recognise the same customer on re-import', 'TALLY-1023'),
      col('company_name', 'Company name', 'Registered or trading name (2–200 characters)', 'Gulf Panel Co.', true),
      col('aliases', 'Other names', 'Other names to search by, separated by ;', 'Gulf Panels LLC'),
      col('country', 'Country', 'ISO code (IN, AE…) or country name. Blank = unknown', 'AE'),
      col('city', 'City', 'City', 'Sharjah'),
      col('segment', 'Domestic / export', '"domestic" or "export". Blank = not classified (never guessed from the phone)', 'export'),
      col('types', 'Customer types', 'manufacturer; oem; dealer; distributor; end_user; other (separated by ;)', 'oem'),
      col('owner_email', 'Owner email', 'Email of the accountable owner in this system. Blank = the importer', 'saurav@veritek.example'),
      col('contact_name', 'Contact name', 'Main contact person', 'Rashid Ali'),
      col('contact_role', 'Contact role', 'Designation', 'Purchase Manager'),
      col('phone', 'Phone', 'With country code if possible', '+971 50 123 4567'),
      col('email', 'Email', 'Email address', 'rashid@gulfpanel.example'),
      col('external_account_id', 'Accounting ID', 'Customer reference in the accounting system', 'GPC001'),
      col('first_order_date', 'First order date', 'Historical first order date. Blank = unknown (never assumed)', '12/02/2024'),
      col('last_order_date', 'Last order date', 'Historical last order date. Blank = unknown', '05/03/2026'),
      col('order_count', 'Historical order count', 'Number of orders before this system', '12'),
      col('do_not_contact', 'Do not contact', 'yes / no', 'no'),
      col('notes', 'Notes', 'Short note', ''),
    ],
  },
  enquiries: {
    label: 'Enquiries',
    columns: [
      col('external_id', 'Source ID', 'The enquiry ID in the old sheet or system', 'ENQ-OLD-77'),
      col('customer_ref', 'Customer source ID', 'Source ID used in the customer import (preferred)', 'TALLY-1023'),
      col('customer_name', 'Customer name', 'Used when there is no customer source ID', 'Gulf Panel Co.', true),
      col('contact_name', 'Contact name', '', 'Rashid Ali'),
      col('phone', 'Phone', '', '+971 50 123 4567'),
      col('email', 'Email', '', ''),
      col('received_date', 'Received date', 'Blank = unknown (kept unknown, not set to the import date)', '02/11/2026'),
      col('source', 'Source', 'existing_customer, website, whatsapp, email, exhibition, field_visit, dealer_referral, outbound, other, unknown', 'exhibition'),
      col('event', 'Event name', 'Exhibition or campaign name', 'Middle East Energy'),
      col('owner_email', 'Owner email', 'Accountable owner', 'kavya@veritek.example'),
      col('product_code', 'Product code', 'Product master code. Unknown codes are kept as requirement text', 'VIPS 70L'),
      col('requirement', 'Requirement', 'Short description when the product is not known', ''),
      col('qty', 'Quantity', 'Blank = unknown (never defaulted to 1)', '100'),
      col('unit', 'Unit', 'pcs, set, m, kg, lot', 'pcs'),
      col('stage', 'Stage', 'new, clarification, quote_to_prepare, quote_sent, awaiting_decision, on_hold, won, lost, cancelled', 'quote_sent'),
      col('lost_reason', 'Lost reason', 'For lost enquiries: price, delivery_time, … Blank = unknown', ''),
      col('next_action', 'Next action', 'For open enquiries', 'Follow up quotation'),
      col('next_action_due', 'Next action due', 'Date', '20/11/2026'),
      col('notes', 'Notes', '', ''),
    ],
  },
  order_lines: {
    label: 'Order lines',
    columns: [
      col('order_ref', 'Order number (source)', 'Rows with the same order number become one order', 'SO-0988', true),
      col('line_ref', 'Line ID (source)', 'Optional: identifies the line on re-import', '1'),
      col('customer_ref', 'Customer source ID', 'Source ID from the customer import (preferred)', 'TALLY-1023'),
      col('customer_name', 'Customer name', 'Used when there is no customer source ID', 'Gulf Panel Co.', true),
      col('po_reference', 'Customer PO', '', 'GP/PO/2026/114'),
      col('received_date', 'Order received date', 'Blank = unknown', '01/11/2026'),
      col('owner_email', 'Sales owner email', '', 'saurav@veritek.example'),
      col('product_code', 'Product code', '', 'VIPS 70L'),
      col('description', 'Description / specification', 'Used when the product code is unknown', ''),
      col('qty', 'Confirmed quantity', 'Positive number', '100', true),
      col('unit', 'Unit', 'pcs, set, m, kg, lot', 'pcs'),
      col('unit_price', 'Unit price', 'Blank = price unknown (not zero)', '1250.00'),
      col('currency', 'Currency', 'INR, USD, EUR, AED…', 'AED'),
      col('original_commitment_date', 'Original committed dispatch date', 'Blank = commitment unknown (excluded from timeliness)', '19/11/2026'),
      col('forecast_dispatch_date', 'Current dispatch forecast', '', '21/11/2026'),
      col('phase', 'Phase', 'received, production, qc, ready', 'production'),
      col('dispatched_qty', 'Already dispatched', 'Historical dispatched quantity', '0'),
      col('dispatch_date', 'Dispatch date', 'Actual dispatch date of the dispatched quantity. Blank = unknown (not the invoice date)', ''),
      col('cancelled_qty', 'Cancelled quantity', '', '0'),
      col('cancel_reason', 'Cancellation reason', 'customer_cancelled, project_cancelled, delivery_delay, spec_change, payment_issue, duplicate_entry, other', ''),
      col('notes', 'Notes', '', ''),
    ],
  },
};

export function templateCsv(type) {
  const t = TEMPLATES[type];
  if (!t) throw notFound('Template');
  return toCsv(t.columns.map((c) => ({ key: c.key, label: c.key })), [Object.fromEntries(t.columns.map((c) => [c.key, c.example]))]);
}
export function guideCsv(type) {
  const t = TEMPLATES[type];
  if (!t) throw notFound('Template');
  return toCsv([{ key: 'key', label: 'Column' }, { key: 'label', label: 'Meaning' }, { key: 'required', label: 'Required' }, { key: 'help', label: 'Rules' }, { key: 'example', label: 'Example' }],
    t.columns.map((c) => ({ ...c, required: c.required ? 'yes' : '' })), [['Template', t.label], ['Dates', 'Choose the date format when uploading; YYYY-MM-DD is always accepted']]);
}

// ------------------------------------------------------------------ upload & mapping
export function storeUpload(buffer, name, user) {
  if (!buffer?.length) throw badRequest('The file is empty');
  if (buffer.length > 20 * 1024 * 1024) throw badRequest('Files can be at most 20 MB');
  let sheets;
  try {
    sheets = sheetsFromUpload(buffer, name);
  } catch (err) {
    throw badRequest(err.message || 'This file could not be read');
  }
  const t = token(16);
  const storageKey = `import-${Date.now().toString(36)}-${token(8)}`;
  fs.writeFileSync(path.join(FILE_DIR, storageKey), buffer);
  const checksum = sha256(buffer);
  insert('import_uploads', { token: t, file_name: path.basename(String(name)).slice(-120), checksum, size: buffer.length, storage_key: storageKey, uploaded_by: user.id, created_at: nowIso() });
  return {
    upload_id: t, file_name: name, checksum,
    previously_imported: all("SELECT id, type, created_at, status FROM import_batches WHERE file_checksum = ? AND rolled_back_at IS NULL", checksum),
    sheets: sheets.map((s) => ({ name: s.name, rows: Math.max(0, s.rows.length - 1), headers: s.rows[0] || [], sample: s.rows.slice(1, 6) })),
  };
}

function loadUpload(uploadId) {
  const u = get('SELECT * FROM import_uploads WHERE token = ?', uploadId);
  if (!u) throw notFound('Uploaded file');
  const buffer = fs.readFileSync(path.join(FILE_DIR, u.storage_key));
  return { upload: u, sheets: sheetsFromUpload(buffer, u.file_name) };
}

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export function autoMap(type, headers) {
  const t = TEMPLATES[type];
  const out = {};
  t.columns.forEach((c) => {
    const idx = headers.findIndex((h) => [normHeader(c.key), normHeader(c.label)].includes(normHeader(h)));
    if (idx >= 0) out[c.key] = idx;
  });
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Parses a date in the chosen format. Blank means unknown — never today. */
export function parseDate(raw, format = 'DD/MM/YYYY') {
  const s = String(raw ?? '').trim();
  if (!s) return { unknown: true };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return isDate(s.slice(0, 10)) ? { date: s.slice(0, 10) } : { error: `"${s}" is not a valid date` };
  const named = s.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3})[A-Za-z]*[\s\-/.,]+(\d{2,4})$/);
  let y;
  let m;
  let d;
  if (named) {
    d = Number(named[1]);
    m = MONTHS[named[2].toLowerCase()];
    y = Number(named[3]);
  } else {
    const parts = s.split(/[/\-.]/).map((x) => x.trim());
    if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return { error: `"${s}" is not a date in ${format}` };
    if (format === 'MM/DD/YYYY') [m, d, y] = parts.map(Number);
    else if (format === 'YYYY-MM-DD') [y, m, d] = parts.map(Number);
    else [d, m, y] = parts.map(Number);
  }
  if (y < 100) y += 2000;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDate(iso) ? { date: iso } : { error: `"${s}" is not a valid date in ${format}` };
}

const COUNTRY_BY_NAME = Object.fromEntries(COUNTRIES.flatMap((c) => [[c.value.toLowerCase(), c.value], [c.label.toLowerCase(), c.value]]));
COUNTRY_BY_NAME.uae = 'AE';
COUNTRY_BY_NAME.ksa = 'SA';
COUNTRY_BY_NAME.uk = 'GB';
COUNTRY_BY_NAME.usa = 'US';
const optionCodes = (cat) => new Set(DROPDOWNS[cat].options.map((o) => o.code));
const userByEmail = (email) => (email ? get('SELECT id, active FROM users WHERE email = ? COLLATE NOCASE', String(email).trim()) : null);
const legacyAlias = (source, id) => `${source || 'import'}:${id}`;

function rowRecord(type, cells, mapping) {
  const rec = {};
  for (const c of TEMPLATES[type].columns) {
    const idx = mapping[c.key];
    rec[c.key] = idx === undefined || idx === null || idx === '' ? '' : String(cells[Number(idx)] ?? '').trim();
  }
  return rec;
}

function rowKey(type, source, rec) {
  const id = type === 'order_lines' ? (rec.order_ref ? `${rec.order_ref}#${rec.line_ref || sha256(JSON.stringify(rec)).slice(0, 16)}` : null) : rec.external_id;
  return `${type}|${source || 'manual'}|${id || sha256(JSON.stringify(rec)).slice(0, 24)}`;
}

function findImportedCustomer(source, rec) {
  if (rec.customer_ref || rec.external_id) {
    const ref = rec.customer_ref || rec.external_id;
    const hit = get("SELECT customer_id FROM customer_aliases WHERE kind = 'legacy_id' AND alias = ?", legacyAlias(source, ref));
    if (hit) return get('SELECT * FROM customers WHERE id = ?', hit.customer_id);
  }
  if (rec.external_account_id) {
    const hit = get('SELECT * FROM customers WHERE external_account_id = ? AND merged_into_id IS NULL', rec.external_account_id);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ validation (shared by preview & commit)
function analyseRow(type, rec, opts, decisions, rowNumber) {
  const errors = [];
  const warnings = [];
  const out = { row_number: rowNumber, errors, warnings, matches: [], action: 'insert', data: {} };
  const date = (field, { required = false } = {}) => {
    const r = parseDate(rec[field], opts.date_format);
    if (r.error) errors.push(`${field}: ${r.error}`);
    if (r.unknown && required) errors.push(`${field} is required`);
    return r.date || null;
  };
  const owner = (field) => {
    if (!rec[field]) return null;
    const u = userByEmail(rec[field]);
    if (!u) errors.push(`Unknown user "${rec[field]}" — add them in Settings → Users or correct the email`);
    else if (!u.active) errors.push(`User "${rec[field]}" is deactivated`);
    return u?.id ?? null;
  };
  const decision = decisions?.[rowNumber];

  if (type === 'customers') {
    if (!rec.company_name || rec.company_name.length < 2) errors.push('Company name is required');
    const country = rec.country ? COUNTRY_BY_NAME[rec.country.toLowerCase()] : null;
    if (rec.country && !country) warnings.push(`Country "${rec.country}" not recognised — kept as unknown`);
    if (rec.segment && !['domestic', 'export'].includes(rec.segment.toLowerCase())) warnings.push(`Segment "${rec.segment}" ignored (use domestic/export)`);
    const types = rec.types ? rec.types.split(/[;,]/).map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean) : [];
    const valid = optionCodes('customer_type');
    if (types.some((t) => !valid.has(t))) warnings.push(`Unknown customer types ignored: ${types.filter((t) => !valid.has(t)).join(', ')}`);
    if (rec.email && !normEmail(rec.email)) errors.push(`Email "${rec.email}" is not valid`);
    if (!rec.phone && !rec.email) warnings.push('No phone or email — listed in the missing-information queue');
    const ownerId = owner('owner_email');
    const first = date('first_order_date');
    const last = date('last_order_date');
    out.data = {
      company_name: rec.company_name, aliases: rec.aliases ? rec.aliases.split(';').map((x) => x.trim()).filter(Boolean) : [], country_code: country, city: rec.city || null,
      segment: ['domestic', 'export'].includes(rec.segment?.toLowerCase()) ? rec.segment.toLowerCase() : null, types: types.filter((t) => valid.has(t)), owner_id: ownerId,
      contacts: rec.contact_name || rec.phone || rec.email ? [{ name: rec.contact_name, role: rec.contact_role, phone: rec.phone, email: rec.email }] : [],
      external_account_id: rec.external_account_id || null, external_source: rec.external_account_id ? opts.source_system || 'import' : null,
      legacy_first_order_date: first, legacy_last_order_date: last, legacy_order_count: intId(rec.order_count), legacy_source: opts.source_system || 'import',
      notes: rec.notes || null, do_not_contact: /^(y|yes|true|1)$/i.test(rec.do_not_contact),
    };
    out.summary = rec.company_name;
    if (!errors.length) {
      const existing = findImportedCustomer(opts.source_system, rec);
      if (existing) {
        out.action = 'update';
        out.target_id = existing.id;
        out.matches = [{ id: existing.id, code: existing.code, company_name: existing.company_name, reasons: ['Same source ID / accounting ID'] }];
      } else {
        const m = findMatches({ company_name: rec.company_name, phones: [rec.phone].filter(Boolean), emails: [rec.email].filter(Boolean), country_code: country });
        if (m.length) {
          out.matches = m.slice(0, 3);
          if (!decision) out.action = 'needs_decision';
          else if (decision === 'skip') out.action = 'skip';
          else if (String(decision).startsWith('link:')) {
            out.action = 'update';
            out.target_id = intId(String(decision).slice(5));
          }
        }
      }
    }
  } else if (type === 'enquiries') {
    if (!rec.customer_ref && !rec.customer_name) errors.push('Customer source ID or name is required');
    const source = rec.source ? rec.source.toLowerCase().replace(/[\s/]+/g, '_') : 'unknown';
    if (!optionCodes('enquiry_source').has(source)) errors.push(`Unknown source "${rec.source}"`);
    const stage = rec.stage ? rec.stage.toLowerCase().replace(/\s+/g, '_') : 'new';
    if (!['new', 'clarification', 'quote_to_prepare', 'quote_sent', 'awaiting_decision', 'on_hold', 'won', 'lost', 'cancelled'].includes(stage)) errors.push(`Unknown stage "${rec.stage}"`);
    const qty = rec.qty === '' ? null : Number(rec.qty);
    if (qty !== null && !(qty > 0)) errors.push(`Quantity "${rec.qty}" must be greater than zero (or blank if unknown)`);
    const product = rec.product_code ? get('SELECT * FROM products WHERE code = ? COLLATE NOCASE', rec.product_code) : null;
    if (rec.product_code && !product) warnings.push(`Unknown product "${rec.product_code}" — kept as requirement text`);
    if (!product && !rec.requirement && !rec.product_code) warnings.push('No product or requirement — recorded as "Unspecified / needs clarification"');
    const received = date('received_date');
    if (!received) warnings.push('Received date unknown — kept unknown and excluded from response-time metrics');
    const lostReason = rec.lost_reason ? rec.lost_reason.toLowerCase().replace(/\s+/g, '_') : null;
    if (lostReason && !optionCodes('lost_reason').has(lostReason)) errors.push(`Unknown lost reason "${rec.lost_reason}"`);
    const ownerId = owner('owner_email') || opts.user.id;
    const due = date('next_action_due');
    const customer = findImportedCustomer(opts.source_system, rec) || (rec.customer_name ? get('SELECT * FROM customers WHERE name_norm = ? AND merged_into_id IS NULL', normName(rec.customer_name)) : null);
    if (!customer) {
      if (!decision) out.action = 'needs_decision';
      else if (decision === 'skip') out.action = 'skip';
      else if (String(decision).startsWith('link:')) out.customer_id = intId(String(decision).slice(5));
      else out.create_customer = true;
      out.matches = rec.customer_name ? findMatches({ company_name: rec.customer_name, phones: [rec.phone].filter(Boolean), emails: [rec.email].filter(Boolean) }).slice(0, 3) : [];
      if (!out.matches.length && !decision) out.action = 'insert', out.create_customer = true, warnings.push('Customer not found — a provisional customer will be created');
    } else out.customer_id = customer.id;
    if (rec.external_id && get('SELECT id FROM enquiries WHERE external_id = ?', rec.external_id)) {
      out.action = 'skip';
      warnings.push('An enquiry with this source ID already exists');
    }
    out.data = {
      external_id: rec.external_id || null, customer_name: rec.customer_name, contact: { name: rec.contact_name, phone: rec.phone, email: rec.email },
      received_date: received, source_code: source, source_event: rec.event || null, owner_id: ownerId, stage, lost_reason_code: lostReason,
      lines: [{ product_id: product?.id || null, requirement: product ? null : rec.requirement || rec.product_code || 'Unspecified / needs clarification', qty, unit: rec.unit || product?.default_unit || null }],
      next_action: rec.next_action || 'Review imported enquiry', next_action_due: due, notes: rec.notes || null,
    };
    out.summary = `${rec.customer_name || rec.customer_ref} · ${product?.code || rec.requirement || 'Unspecified'}`;
  } else if (type === 'order_lines') {
    if (!rec.order_ref) errors.push('Order number is required');
    if (!rec.customer_ref && !rec.customer_name) errors.push('Customer source ID or name is required');
    const qty = Number(rec.qty);
    if (!(qty > 0)) errors.push(`Quantity "${rec.qty}" must be greater than zero`);
    const dispatched = rec.dispatched_qty === '' ? 0 : Number(rec.dispatched_qty);
    const cancelled = rec.cancelled_qty === '' ? 0 : Number(rec.cancelled_qty);
    if (!(dispatched >= 0) || !(cancelled >= 0)) errors.push('Dispatched and cancelled quantities must be zero or more');
    if (dispatched + cancelled > qty + 0.0005) errors.push(`Impossible quantity: dispatched ${dispatched} + cancelled ${cancelled} is more than ordered ${qty}`);
    const product = rec.product_code ? get('SELECT * FROM products WHERE code = ? COLLATE NOCASE', rec.product_code) : null;
    if (rec.product_code && !product) warnings.push(`Unknown product "${rec.product_code}" — line kept with its description and flagged for clarification`);
    const received = date('received_date');
    if (!received) warnings.push('Order received date unknown');
    const commitment = date('original_commitment_date');
    if (!commitment) warnings.push('No committed date — marked unknown and excluded from timeliness');
    const forecast = date('forecast_dispatch_date');
    const dispatchDate = date('dispatch_date');
    if (dispatched > 0 && !dispatchDate) warnings.push('Dispatch date unknown — kept unknown (invoice date is not assumed)');
    const price = rec.unit_price === '' ? null : Number(String(rec.unit_price).replace(/,/g, ''));
    if (price !== null && !(price >= 0)) errors.push(`Price "${rec.unit_price}" is not valid`);
    if (price !== null && !rec.currency) errors.push('Currency is required when a price is given');
    const phase = rec.phase ? rec.phase.toLowerCase() : 'received';
    if (!['received', 'production', 'qc', 'ready'].includes(phase)) errors.push(`Unknown phase "${rec.phase}"`);
    const cancelReason = rec.cancel_reason ? rec.cancel_reason.toLowerCase().replace(/\s+/g, '_') : cancelled > 0 ? 'other' : null;
    if (cancelReason && !optionCodes('cancel_reason').has(cancelReason)) errors.push(`Unknown cancellation reason "${rec.cancel_reason}"`);
    const ownerId = owner('owner_email');
    const customer = findImportedCustomer(opts.source_system, rec) || (rec.customer_name ? get('SELECT * FROM customers WHERE name_norm = ? AND merged_into_id IS NULL', normName(rec.customer_name)) : null);
    if (!customer) {
      if (decision && String(decision).startsWith('link:')) out.customer_id = intId(String(decision).slice(5));
      else if (decision === 'skip') out.action = 'skip';
      else if (decision === 'create') out.create_customer = true;
      else {
        out.action = 'needs_decision';
        out.matches = rec.customer_name ? findMatches({ company_name: rec.customer_name }).slice(0, 3) : [];
      }
    } else out.customer_id = customer.id;
    out.data = {
      order_ref: rec.order_ref, customer_name: rec.customer_name, po_reference: rec.po_reference || null, received_date: received, owner_id: ownerId,
      product_id: product?.id || null, description: product?.name || rec.description || rec.product_code || 'Unspecified item', spec: product ? rec.description || null : null,
      needs_clarification: !product, confirmed_qty: round3(qty), unit: rec.unit || product?.default_unit || 'pcs', unit_price: price, currency: rec.currency ? rec.currency.toUpperCase() : null,
      original_commitment_date: commitment, forecast_dispatch_date: forecast, phase, dispatched_qty: round3(dispatched || 0), dispatch_date: dispatchDate,
      cancelled_qty: round3(cancelled || 0), cancel_reason: cancelReason, notes: rec.notes || null,
    };
    out.summary = `${rec.order_ref} · ${rec.customer_name || rec.customer_ref} · ${qty} × ${product?.code || rec.description || rec.product_code}`;
  }
  if (errors.length) out.action = 'error';
  return out;
}

function previouslyImported(key) {
  return get(`SELECT r.batch_id, r.entity_type, r.entity_id FROM import_rows r JOIN import_batches b ON b.id = r.batch_id
    WHERE r.row_key = ? AND r.status IN ('inserted','updated') AND b.rolled_back_at IS NULL LIMIT 1`, key);
}

export function previewImport(input, user) {
  const type = input.type;
  if (!TEMPLATES[type]) throw badRequest('Choose what you are importing');
  const { sheets } = loadUpload(input.upload_id);
  const sheet = sheets.find((s) => s.name === input.sheet) || sheets[0];
  const mapping = input.mapping || autoMap(type, sheet.rows[0] || []);
  const missing = TEMPLATES[type].columns.filter((c) => c.required && (mapping[c.key] === undefined || mapping[c.key] === '')).map((c) => c.label);
  if (missing.length && !(type === 'enquiries' && mapping.customer_ref !== undefined) && !(type === 'order_lines' && mapping.customer_ref !== undefined && missing.every((m) => m === 'Customer name'))) {
    throw badRequest(`Map the required columns first: ${missing.join(', ')}`, { mapping: `Required: ${missing.join(', ')}` });
  }
  const opts = { date_format: input.date_format || 'DD/MM/YYYY', source_system: str(input.source_system, 60) || 'import', user };
  const rows = [];
  const counts = { insert: 0, update: 0, skip: 0, error: 0, needs_decision: 0, already_imported: 0 };
  const unknownProducts = new Set();
  const orders = new Map();
  sheet.rows.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2;
    const rec = rowRecord(type, cells, mapping);
    const key = rowKey(type, opts.source_system, rec);
    const prev = previouslyImported(key);
    let a;
    if (prev) {
      a = { row_number: rowNumber, action: 'skip', errors: [], warnings: [`Already imported in batch #${prev.batch_id}`], matches: [], summary: rec.company_name || rec.order_ref || rec.customer_name, already: true };
      counts.already_imported++;
    } else a = analyseRow(type, rec, opts, input.decisions, rowNumber);
    if (rec.product_code && !get('SELECT id FROM products WHERE code = ? COLLATE NOCASE', rec.product_code)) unknownProducts.add(rec.product_code);
    if (type === 'order_lines' && a.data?.order_ref && a.action !== 'error') {
      const o = orders.get(a.data.order_ref) || { order_ref: a.data.order_ref, lines: 0, confirmed: 0, dispatched: 0, cancelled: 0 };
      o.lines++;
      o.confirmed = round3(o.confirmed + a.data.confirmed_qty);
      o.dispatched = round3(o.dispatched + a.data.dispatched_qty);
      o.cancelled = round3(o.cancelled + a.data.cancelled_qty);
      orders.set(a.data.order_ref, o);
    }
    counts[a.action] = (counts[a.action] || 0) + 1;
    rows.push({ ...a, key, data: undefined });
  });
  return {
    type, sheet: sheet.name, mapping, total: rows.length, counts, rows: rows.slice(0, 1000), unknown_products: [...unknownProducts],
    reconciliation: [...orders.values()].map((o) => ({ ...o, remaining: round3(o.confirmed - o.dispatched - o.cancelled) })),
    note: 'Preview only — nothing has been saved yet.',
  };
}

// ------------------------------------------------------------------ commit
function processRow(type, a, opts, batchId, user, orderCache) {
  if (type === 'customers') {
    if (a.action === 'update') {
      const cur = get('SELECT * FROM customers WHERE id = ?', a.target_id);
      if (!cur) throw new Error('Linked customer not found');
      const filled = {};
      for (const k of ['country_code', 'city', 'segment', 'external_account_id', 'legacy_first_order_date', 'legacy_last_order_date', 'legacy_order_count', 'notes']) {
        if ((cur[k] === null || cur[k] === '') && a.data[k] !== null && a.data[k] !== undefined) filled[k] = a.data[k];
      }
      if (filled.external_account_id) filled.external_source = a.data.external_source;
      if (Object.keys(filled).length) update('customers', cur.id, { ...filled, updated_at: nowIso(), version: cur.version + 1 });
      if (opts.rec_external_id) run("INSERT INTO customer_aliases (customer_id, alias, alias_norm, kind, created_at, created_by) SELECT ?, ?, ?, 'legacy_id', ?, ? WHERE NOT EXISTS (SELECT 1 FROM customer_aliases WHERE kind = 'legacy_id' AND alias = ?)",
        cur.id, legacyAlias(opts.source_system, opts.rec_external_id), normName(opts.rec_external_id), nowIso(), user.id, legacyAlias(opts.source_system, opts.rec_external_id));
      return { status: Object.keys(filled).length ? 'updated' : 'skipped', entity_type: 'customer', entity_id: cur.id, message: Object.keys(filled).length ? `Filled blank fields: ${Object.keys(filled).join(', ')} (existing values never overwritten)` : 'No new information' };
    }
    const id = createCustomer({ ...a.data, owner_id: a.data.owner_id || user.id, confirm_not_duplicate: true }, user, { requireContactChannel: false, importBatchId: batchId, skipDuplicateCheck: true, sourceConfidence: 'imported' });
    if (a.data.do_not_contact) update('customers', id, { do_not_contact: 1, dnc_reason: 'Imported preference', dnc_source: opts.source_system, dnc_date: today() });
    if (opts.rec_external_id) insert('customer_aliases', { customer_id: id, alias: legacyAlias(opts.source_system, opts.rec_external_id), alias_norm: normName(opts.rec_external_id), kind: 'legacy_id', created_at: nowIso(), created_by: user.id });
    return { status: 'inserted', entity_type: 'customer', entity_id: id };
  }
  if (type === 'enquiries') {
    let customerId = a.customer_id;
    if (!customerId) {
      customerId = createCustomer({ company_name: a.data.customer_name, provisional: true, owner_id: a.data.owner_id, contacts: [a.data.contact].filter((x) => x.name || x.phone || x.email), confirm_not_duplicate: true }, user, { requireContactChannel: false, importBatchId: batchId, skipDuplicateCheck: true, sourceConfidence: 'imported' });
    }
    const open = OPEN_ENQUIRY_STAGES.includes(a.data.stage);
    const res = createEnquiry({
      customer_id: customerId, source_code: a.data.source_code, source_event: a.data.source_event, owner_id: a.data.owner_id, lines: a.data.lines,
      received_at: a.data.received_date ? `${a.data.received_date}T06:30:00.000Z` : undefined, received_unknown: !a.data.received_date, requirement_note: a.data.notes,
      external_id: a.data.external_id, skip_task: true,
    }, user, { importBatchId: batchId, sourceConfidence: 'imported', allowUnknownReceived: true });
    if (a.data.stage !== 'new') {
      const fields = { stage: a.data.stage, updated_at: nowIso() };
      if (a.data.stage === 'lost') Object.assign(fields, { lost_reason_code: a.data.lost_reason_code || 'unknown', decided_at: nowIso() });
      if (a.data.stage === 'cancelled') Object.assign(fields, { cancel_reason_code: 'other', cancel_note: 'Imported as cancelled', decided_at: nowIso() });
      if (a.data.stage === 'won') fields.decided_at = nowIso();
      update('enquiries', res.id, fields);
      if (!open) run("UPDATE enquiry_lines SET outcome = ? WHERE enquiry_id = ?", a.data.stage === 'won' ? 'won' : a.data.stage, res.id);
    }
    if (open) {
      createTask({ enquiry_id: res.id, customer_id: customerId, purpose: a.data.next_action, owner_id: a.data.owner_id, due_date: a.data.next_action_due || today(), kind: 'customer', source: 'import' }, user, { validated: true });
    }
    return { status: 'inserted', entity_type: 'enquiry', entity_id: res.id };
  }
  // order lines
  const d = a.data;
  let customerId = a.customer_id;
  if (!customerId) {
    customerId = createCustomer({ company_name: d.customer_name, provisional: false, owner_id: d.owner_id, confirm_not_duplicate: true }, user, { requireContactChannel: false, importBatchId: batchId, skipDuplicateCheck: true, sourceConfidence: 'imported' });
  }
  const lineInput = {
    product_id: d.product_id, description: d.description, spec: d.spec, needs_clarification: d.needs_clarification, unit: d.unit, confirmed_qty: d.confirmed_qty,
    unit_price: d.unit_price, commitment_state: d.original_commitment_date ? 'committed' : 'unknown', original_commitment_date: d.original_commitment_date,
  };
  let orderId = orderCache.get(d.order_ref) || get('SELECT id FROM orders WHERE external_id = ? AND customer_id = ?', d.order_ref, customerId)?.id;
  let lineId;
  if (!orderId) {
    orderId = createOrder({
      customer_id: customerId, owner_id: d.owner_id, po_reference: d.po_reference, received_date: d.received_date, received_unknown: !d.received_date, currency: d.currency,
      source_code: 'po_received', confirmation_note: `Imported from ${opts.source_system}`, external_id: d.order_ref, lines: [lineInput], confirm: true, confirm_duplicate_po: true, notes: d.notes,
    }, user, { importBatchId: batchId, allowUnknown: true, sourceConfidence: 'imported' });
    lineId = get('SELECT id FROM order_lines WHERE order_id = ? ORDER BY line_no LIMIT 1', orderId).id;
  } else {
    const stamp = nowIso();
    const lineNo = (get('SELECT MAX(line_no) AS n FROM order_lines WHERE order_id = ?', orderId).n || 0) + 1;
    lineId = insert('order_lines', {
      order_id: orderId, line_no: lineNo, product_id: d.product_id, description: d.description, spec: d.spec, needs_clarification: d.needs_clarification ? 1 : 0, unit: d.unit,
      confirmed_qty: d.confirmed_qty, original_qty: d.confirmed_qty, unit_price_minor: d.unit_price === null ? null : Math.round(d.unit_price * 100), commitment_state: lineInput.commitment_state,
      original_commitment_date: d.original_commitment_date, forecast_dispatch_date: d.forecast_dispatch_date || d.original_commitment_date, source_update_at: stamp, source_update_basis: 'entry_time',
      created_at: stamp, updated_at: stamp,
    });
    if (d.original_commitment_date) insert('commitment_changes', { line_id: lineId, order_id: orderId, kind: 'original', new_date: d.original_commitment_date, actor_id: user.id, created_at: stamp, occurred_at: stamp });
  }
  orderCache.set(d.order_ref, orderId);
  update('order_lines', lineId, { phase: d.phase, forecast_dispatch_date: d.forecast_dispatch_date || d.original_commitment_date || null, ready_qty: d.dispatched_qty > 0 ? d.dispatched_qty : null });
  if (d.dispatched_qty > 0) {
    postDispatch({ lines: [{ line_id: lineId, qty: d.dispatched_qty }], dispatch_date: d.dispatch_date, date_unknown: !d.dispatch_date, notes: `Imported historical dispatch (${opts.source_system})` }, { ...user, permissions: [...user.permissions, 'dispatch.override'] }, { importBatchId: batchId, allowUnknownDate: true });
  }
  if (d.cancelled_qty > 0) cancelQuantity(lineId, { qty: d.cancelled_qty, reason_code: d.cancel_reason, note: `Imported from ${opts.source_system}`, requested_source: 'customer' }, user);
  recalcLine(lineId);
  recalcOrder(orderId, user);
  return { status: 'inserted', entity_type: 'order_line', entity_id: lineId };
}

/**
 * Commits a batch. The batch key makes a retried request return the existing result; row keys make
 * re-importing the same source skip rows already imported. Duplicates without a decision are skipped,
 * never overwritten or merged.
 */
export function commitImport(input, user) {
  const type = input.type;
  if (!TEMPLATES[type]) throw badRequest('Choose what you are importing');
  const batchKey = str(input.batch_key, 80);
  if (!batchKey) throw badRequest('Missing batch key');
  const existing = get('SELECT * FROM import_batches WHERE batch_key = ?', batchKey);
  if (existing) return batchDetail(existing.id);
  const { upload, sheets } = loadUpload(input.upload_id);
  const sheet = sheets.find((s) => s.name === input.sheet) || sheets[0];
  const mapping = input.mapping || autoMap(type, sheet.rows[0] || []);
  const opts = { date_format: input.date_format || 'DD/MM/YYYY', source_system: str(input.source_system, 60) || 'import', user };
  const stamp = nowIso();
  const batchId = insert('import_batches', {
    batch_key: batchKey, type, source_system: opts.source_system, file_name: upload.file_name, file_checksum: upload.checksum, upload_id: upload.id, sheet: sheet.name,
    mapping: JSON.stringify(mapping), date_format: opts.date_format, status: 'processing', created_by: user.id, created_at: stamp,
  });
  processRows(batchId, type, sheet.rows, mapping, opts, input.decisions || {}, user);
  return batchDetail(batchId);
}

function processRows(batchId, type, sheetRows, mapping, opts, decisions, user, { only = null } = {}) {
  const orderCache = new Map();
  sheetRows.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2;
    if (only && !only.has(rowNumber)) return;
    const rec = rowRecord(type, cells, mapping);
    const key = rowKey(type, opts.source_system, rec);
    const record = (status, extra = {}) => {
      run(`INSERT INTO import_rows (batch_id, row_number, row_key, status, entity_type, entity_id, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id, row_number) DO UPDATE SET status = excluded.status, entity_type = excluded.entity_type, entity_id = excluded.entity_id, message = excluded.message, created_at = excluded.created_at`,
      batchId, rowNumber, key, status, extra.entity_type || null, extra.entity_id || null, extra.message || null, JSON.stringify(rec), nowIso());
    };
    const prev = previouslyImported(key);
    if (prev) return record('skipped', { message: `Already imported in batch #${prev.batch_id}`, entity_type: prev.entity_type, entity_id: prev.entity_id });
    const a = analyseRow(type, rec, opts, decisions, rowNumber);
    if (a.action === 'error') return record('failed', { message: a.errors.join('; ') });
    if (a.action === 'skip') return record('skipped', { message: a.warnings.join('; ') || 'Skipped by decision' });
    if (a.action === 'needs_decision') return record('skipped', { message: `Possible duplicate of ${a.matches.map((m) => m.company_name).join(', ') || 'an existing customer'} — choose create, link or skip and retry` });
    try {
      const res = tx(() => processRow(type, a, { ...opts, rec_external_id: rec.external_id || rec.customer_ref }, batchId, user, orderCache));
      record(res.status, { entity_type: res.entity_type, entity_id: res.entity_id, message: [res.message, ...a.warnings].filter(Boolean).join('; ') || null });
    } catch (err) {
      const msg = err instanceof HttpError && err.details?.fields ? `${err.message}: ${Object.values(err.details.fields).join('; ')}` : err.message;
      record('failed', { message: msg });
    }
  });
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM import_rows WHERE batch_id = ? GROUP BY status', batchId).map((r) => [r.status, r.n]));
  update('import_batches', batchId, { status: 'committed', counts: JSON.stringify(counts) });
  audit('import_batch', batchId, 'commit', { counts });
}

/** Retries failed (and undecided) rows without touching rows that already succeeded. */
export function retryRows(batchId, input, user) {
  const b = get('SELECT * FROM import_batches WHERE id = ?', batchId);
  if (!b) throw notFound('Import batch');
  if (b.rolled_back_at) throw conflict('This batch was rolled back');
  const upload = get('SELECT * FROM import_uploads WHERE id = ?', b.upload_id);
  const { sheets } = loadUpload(upload.token);
  const sheet = sheets.find((s) => s.name === b.sheet) || sheets[0];
  const rows = new Set(all("SELECT row_number FROM import_rows WHERE batch_id = ? AND (status = 'failed' OR (status = 'skipped' AND message LIKE 'Possible duplicate%'))", batchId).map((r) => r.row_number));
  processRows(batchId, b.type, sheet.rows, JSON.parse(b.mapping), { date_format: b.date_format, source_system: b.source_system, user }, input.decisions || {}, user, { only: rows });
  return batchDetail(batchId);
}

export function batchDetail(id) {
  const b = get('SELECT b.*, u.name AS created_by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?', id);
  if (!b) throw notFound('Import batch');
  const rows = all('SELECT row_number, row_key, status, entity_type, entity_id, message FROM import_rows WHERE batch_id = ? ORDER BY row_number', id);
  const counts = { inserted: 0, updated: 0, skipped: 0, failed: 0, ...JSON.parse(b.counts || '{}') };
  let reconciliation = null;
  if (b.type === 'order_lines') {
    reconciliation = all(`SELECT o.id, o.code, o.external_id, SUM(l.confirmed_qty) AS confirmed, SUM(l.dispatched_qty) AS dispatched, SUM(l.cancelled_qty) AS cancelled,
      SUM(l.confirmed_qty - l.dispatched_qty - l.cancelled_qty) AS remaining FROM orders o JOIN order_lines l ON l.order_id = o.id WHERE o.import_batch_id = ? GROUP BY o.id`, id);
  }
  return { batch: { ...b, mapping: JSON.parse(b.mapping || '{}'), counts }, rows, reconciliation };
}

export function batchLogCsv(id) {
  const { batch, rows } = batchDetail(id);
  return toCsv([{ key: 'row_number', label: 'Row' }, { key: 'status', label: 'Result' }, { key: 'entity_type', label: 'Record type' }, { key: 'entity_id', label: 'Record ID' }, { key: 'message', label: 'Message' }],
    rows, [['Batch', `#${batch.id} ${batch.type} from ${batch.source_system}`], ['File', batch.file_name], ['Counts', JSON.stringify(batch.counts)]]);
}

export function listBatches() {
  return all('SELECT b.id, b.type, b.source_system, b.file_name, b.status, b.counts, b.created_at, b.rolled_back_at, u.name AS created_by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100')
    .map((b) => ({ ...b, counts: JSON.parse(b.counts || '{}') }));
}

/** Safe reversal only if nothing has happened to the imported records since; otherwise use corrections. */
export function rollbackBatch(id, input, user) {
  const b = get('SELECT * FROM import_batches WHERE id = ?', id);
  if (!b) throw notFound('Import batch');
  if (b.rolled_back_at) throw conflict('Already rolled back');
  const reason = str(input.reason, 300);
  if (!reason) throw badRequest('Give a reason for the rollback', { reason: 'Required' });
  const customers = all('SELECT id FROM customers WHERE import_batch_id = ?', id).map((r) => r.id);
  const enquiries = all('SELECT id FROM enquiries WHERE import_batch_id = ?', id).map((r) => r.id);
  const orders = all('SELECT id FROM orders WHERE import_batch_id = ?', id).map((r) => r.id);
  const after = b.created_at;
  const blockers = [];
  const ph = (arr) => arr.map(() => '?').join(',') || 'NULL';
  if (customers.length) {
    if (get(`SELECT 1 FROM enquiries WHERE customer_id IN (${ph(customers)}) AND (import_batch_id IS NOT ? ) LIMIT 1`, ...customers, id)) blockers.push('Enquiries were added to imported customers');
    if (get(`SELECT 1 FROM orders WHERE customer_id IN (${ph(customers)}) AND (import_batch_id IS NOT ?) LIMIT 1`, ...customers, id)) blockers.push('Orders were added to imported customers');
    if (get(`SELECT 1 FROM activities WHERE customer_id IN (${ph(customers)}) LIMIT 1`, ...customers)) blockers.push('Contacts were recorded with imported customers');
  }
  if (enquiries.length && get(`SELECT 1 FROM activities WHERE enquiry_id IN (${ph(enquiries)}) LIMIT 1`, ...enquiries)) blockers.push('Activities were recorded on imported enquiries');
  if (enquiries.length && get(`SELECT 1 FROM quotations WHERE enquiry_id IN (${ph(enquiries)}) LIMIT 1`, ...enquiries)) blockers.push('Quotations were added to imported enquiries');
  if (orders.length && get(`SELECT 1 FROM order_updates WHERE order_id IN (${ph(orders)}) AND entered_at > ? AND kind NOT IN ('confirm','dispatch','cancellation') LIMIT 1`, ...orders, after)) blockers.push('Production updates were recorded on imported orders');
  if (orders.length && get(`SELECT 1 FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id WHERE dl.order_id IN (${ph(orders)}) AND (d.import_batch_id IS NOT ?) LIMIT 1`, ...orders, id)) blockers.push('Dispatches were posted on imported orders');
  if (blockers.length) throw conflict('This batch cannot be rolled back because the records have been used since. Use corrections instead.', { blockers });
  tx(() => {
    if (orders.length) {
      const lines = all(`SELECT id FROM order_lines WHERE order_id IN (${ph(orders)})`, ...orders).map((r) => r.id);
      const dispatchIds = all(`SELECT DISTINCT dispatch_id FROM dispatch_lines WHERE order_id IN (${ph(orders)})`, ...orders).map((r) => r.dispatch_id);
      run(`DELETE FROM dispatch_lines WHERE order_id IN (${ph(orders)})`, ...orders);
      if (dispatchIds.length) run(`DELETE FROM dispatches WHERE id IN (${ph(dispatchIds)})`, ...dispatchIds);
      for (const t of ['cancellations', 'order_updates', 'commitment_changes', 'line_issues', 'communication_confirmations']) run(`DELETE FROM ${t} WHERE order_id IN (${ph(orders)})`, ...orders);
      if (lines.length) run(`DELETE FROM task_changes WHERE task_id IN (SELECT id FROM tasks WHERE line_id IN (${ph(lines)}) OR order_id IN (${ph(orders)}))`, ...lines, ...orders);
      run(`DELETE FROM tasks WHERE order_id IN (${ph(orders)})`, ...orders);
      run(`DELETE FROM alerts WHERE order_id IN (${ph(orders)})`, ...orders);
      run(`DELETE FROM order_lines WHERE order_id IN (${ph(orders)})`, ...orders);
      run(`DELETE FROM history_events WHERE entity_type = 'order' AND entity_id IN (${ph(orders)})`, ...orders);
      run(`DELETE FROM orders WHERE id IN (${ph(orders)})`, ...orders);
    }
    if (enquiries.length) {
      run(`DELETE FROM task_changes WHERE task_id IN (SELECT id FROM tasks WHERE enquiry_id IN (${ph(enquiries)}))`, ...enquiries);
      run(`DELETE FROM tasks WHERE enquiry_id IN (${ph(enquiries)})`, ...enquiries);
      run(`DELETE FROM enquiry_lines WHERE enquiry_id IN (${ph(enquiries)})`, ...enquiries);
      run(`DELETE FROM history_events WHERE entity_type = 'enquiry' AND entity_id IN (${ph(enquiries)})`, ...enquiries);
      run(`DELETE FROM enquiries WHERE id IN (${ph(enquiries)})`, ...enquiries);
    }
    if (customers.length) {
      for (const t of ['contacts', 'customer_aliases', 'reactivation_cases', 'alerts']) run(`DELETE FROM ${t} WHERE customer_id IN (${ph(customers)})`, ...customers);
      run(`DELETE FROM tasks WHERE customer_id IN (${ph(customers)})`, ...customers);
      run(`DELETE FROM duplicate_dismissals WHERE customer_a IN (${ph(customers)}) OR customer_b IN (${ph(customers)})`, ...customers, ...customers);
      run(`DELETE FROM history_events WHERE customer_id IN (${ph(customers)})`, ...customers);
      run(`DELETE FROM customers WHERE id IN (${ph(customers)})`, ...customers);
    }
    update('import_batches', id, { status: 'rolled_back', rolled_back_at: nowIso(), rolled_back_by: user.id, rollback_reason: reason });
    run("UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = ? AND status IN ('inserted','updated')", id);
    audit('import_batch', id, 'rollback', { reason, customers: customers.length, enquiries: enquiries.length, orders: orders.length });
  });
  return batchDetail(id);
}

export { addWorkingDays, settings, calendar, bool };
