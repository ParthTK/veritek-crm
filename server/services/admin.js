// Administration: people and access, settings, dropdown governance, master lists, audit and health.
import { all, get, insert, run, tx, update, DB_PATH, POSTGRES_SERVER, databaseBytes } from '../db.js';
import { STORAGE_LABEL } from '../storage.js';
import {
  Check, badRequest, conflict, notFound, nowIso, str, intId, bool, audit, history, setSetting, settings, resetDropdownCache, dropdowns, normEmail,
} from '../util.js';
import { hashPassword, passwordProblem, destroyUserSessions } from '../auth.js';
import { ROLES, DEPARTMENTS, DROPDOWNS, DEFAULT_SETTINGS, OPEN_ENQUIRY_STAGES, CURRENCIES, TAG_COLORS, PRODUCT_FINDER_ROLES } from '../../shared/constants.js';
import { isDate, isTime } from '../../shared/dates.js';
import { finderPhoneProblem } from '../../shared/rules.js';
import { requireActiveUser } from './people.js';
import { reconcileQuantities } from './orders.js';
import { listBackups } from './backup.js';

// ------------------------------------------------------------------ dropdown defaults
/** Adds any default dropdown values that are missing. Existing labels and active flags are never touched. */
export function ensureDropdownDefaults() {
  const stamp = nowIso();
  // Runs at every start: one read, and writes only for values that are really missing.
  const have = new Set(all('SELECT category, code FROM dropdown_options').map((r) => `${r.category}|${r.code}`));
  for (const [category, def] of Object.entries(DROPDOWNS)) {
    def.options.forEach((o, i) => {
      if (have.has(`${category}|${o.code}`)) return;
      run(`INSERT INTO dropdown_options (category, code, label, active, sort_order, requires_note, system, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`,
        category, o.code, o.label, (i + 1) * 10, o.note ? 1 : 0, stamp, stamp);
    });
  }
  resetDropdownCache();
}

const USAGE = {
  enquiry_source: ['SELECT COUNT(*) AS n FROM enquiries WHERE source_code = ?', 'SELECT COUNT(*) AS n FROM customers WHERE acquisition_source = ?'],
  lost_reason: ['SELECT COUNT(*) AS n FROM enquiries WHERE lost_reason_code = ?', 'SELECT COUNT(*) AS n FROM enquiry_lines WHERE lost_reason_code = ?', 'SELECT COUNT(*) AS n FROM reactivation_cases WHERE reason_code = ?', 'SELECT COUNT(*) AS n FROM quote_revisions WHERE rejection_reason_code = ?'],
  enquiry_cancel_reason: ['SELECT COUNT(*) AS n FROM enquiries WHERE cancel_reason_code = ?'],
  contact_outcome: ['SELECT COUNT(*) AS n FROM activities WHERE outcome = ?'],
  customer_update_outcome: ['SELECT COUNT(*) AS n FROM activities WHERE outcome = ?', 'SELECT COUNT(*) AS n FROM communication_confirmations WHERE response_code = ?'],
  delay_reason: ['SELECT COUNT(*) AS n FROM order_lines WHERE issue_code = ?', 'SELECT COUNT(*) AS n FROM line_issues WHERE issue_code = ?'],
  cancel_reason: ['SELECT COUNT(*) AS n FROM cancellations WHERE reason_code = ?'],
  reactivation_close_reason: ['SELECT COUNT(*) AS n FROM reactivation_cases WHERE closure_reason_code = ?'],
  channel: ['SELECT COUNT(*) AS n FROM activities WHERE channel = ?'],
  customer_type: ["SELECT COUNT(*) AS n FROM customers WHERE COALESCE(NULLIF(types, ''), '[]')::jsonb @> jsonb_build_array(?::text)"],
  unit: ['SELECT COUNT(*) AS n FROM order_lines WHERE unit = ?', 'SELECT COUNT(*) AS n FROM enquiry_lines WHERE unit = ?', 'SELECT COUNT(*) AS n FROM products WHERE default_unit = ?'],
  order_source: ['SELECT COUNT(*) AS n FROM orders WHERE source_code = ?'],
  complaint_category: ['SELECT COUNT(*) AS n FROM complaints WHERE category_code = ?'],
  complaint_resolution: ['SELECT COUNT(*) AS n FROM complaints WHERE resolution_code = ?'],
  complaint_root_cause: ['SELECT COUNT(*) AS n FROM complaints WHERE root_cause_code = ?'],
};
const usageCount = (category, code) => (USAGE[category] || []).reduce((s, sql) => s + get(sql, code).n, 0);

export function listDropdowns() {
  return Object.entries(DROPDOWNS).map(([category, def]) => ({
    category, label: def.label,
    options: (dropdowns()[category] || []).map((o) => ({ ...o, used: usageCount(category, o.code) })),
  }));
}

export function addDropdown(category, input, user) {
  if (!DROPDOWNS[category]) throw notFound('Dropdown');
  const c = new Check();
  c.text('label', input.label, { required: true, max: 80, label: 'Label' });
  const code = String(input.code || input.label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!code) c.fail('code', 'Enter a code');
  if (get('SELECT id FROM dropdown_options WHERE category = ? AND code = ?', category, code)) c.fail('code', 'This code already exists — codes are permanent; reactivate or rename the existing value');
  c.throwIfAny();
  const max = get('SELECT MAX(sort_order) AS m FROM dropdown_options WHERE category = ?', category).m || 0;
  const stamp = nowIso();
  const id = insert('dropdown_options', { category, code, label: str(input.label, 80), active: 1, sort_order: max + 10, requires_note: bool(input.requires_note) ? 1 : 0, system: 0, created_at: stamp, updated_at: stamp });
  resetDropdownCache();
  audit('dropdown', id, 'create', { category, code, label: input.label });
  return { id };
}

/** Rename, reorder or (de)activate. The stable code never changes. */
export function updateDropdown(id, input, user) {
  const o = get('SELECT * FROM dropdown_options WHERE id = ?', id);
  if (!o) throw notFound('Dropdown value');
  const next = {};
  if (input.label !== undefined) {
    if (!str(input.label)) throw badRequest('Enter a label', { label: 'Required' });
    next.label = str(input.label, 80);
  }
  if (input.active !== undefined) next.active = bool(input.active) ? 1 : 0;
  if (input.sort_order !== undefined) next.sort_order = Number(input.sort_order) || 0;
  if (input.requires_note !== undefined) next.requires_note = bool(input.requires_note) ? 1 : 0;
  if (next.active === 0 && dropdowns()[o.category].filter((x) => x.active && x.id !== id).length === 0) throw conflict('Keep at least one active value');
  update('dropdown_options', id, { ...next, updated_at: nowIso() });
  resetDropdownCache();
  audit('dropdown', id, 'update', { category: o.category, code: o.code, ...next });
  return { id };
}

export function deleteDropdown(id, user) {
  const o = get('SELECT * FROM dropdown_options WHERE id = ?', id);
  if (!o) throw notFound('Dropdown value');
  if (o.system) throw conflict('Built-in values cannot be deleted — deactivate them instead');
  const used = usageCount(o.category, o.code);
  if (used) throw conflict(`This value has been used ${used} time(s) and cannot be deleted. Deactivate it for new selections instead.`);
  run('DELETE FROM dropdown_options WHERE id = ?', id);
  resetDropdownCache();
  audit('dropdown', id, 'delete', { category: o.category, code: o.code });
  return { id };
}

// ------------------------------------------------------------------ users
export function listUsers() {
  return all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.department, u.designation, u.region_id, u.factory_id, u.login_enabled, u.active, u.values_access, u.manager_id, u.mfa_enabled,
      u.last_login_at, u.deactivated_at, m.name AS manager_name, u.version, (SELECT name FROM regions WHERE id = u.region_id) AS region_name, (SELECT name FROM factories WHERE id = u.factory_id) AS factory_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id AND t.status = 'open') AS open_tasks
    FROM users u LEFT JOIN users m ON m.id = u.manager_id ORDER BY u.active DESC, u.name`);
}

// users.phone, role and active are read by the website: active super admins and management get product files
// on its WhatsApp number (PRODUCT_FINDER_ROLES). Keep those columns and values as they are; see docs/schema.md.
function validateUser(c, input, { creating, id, cur } = {}) {
  if (creating || input.name !== undefined) c.text('name', input.name, { required: true, max: 120, label: 'Name' });
  // An administrator's phone (optional) must give a number the website can match, as saved (create keeps 40
  // characters, edit 120). Other roles' phones are saved as typed, unchecked.
  const role = creating ? input.role || 'staff' : input.role ?? cur?.role;
  const phone = input.phone !== undefined ? input.phone : cur?.phone;
  if (PRODUCT_FINDER_ROLES.includes(role) && str(phone)) {
    c.text('phone', phone, { max: creating ? 40 : 120, label: 'Phone' });
    const problem = finderPhoneProblem(phone);
    if (problem) c.fail('phone', problem);
  }
  if (input.role !== undefined && !ROLES.some((r) => r.value === input.role)) c.fail('role', 'Choose a role');
  if (input.department && !DEPARTMENTS.some((d) => d.value === input.department)) c.fail('department', 'Choose a department');
  const login = input.role ? ROLES.find((r) => r.value === input.role)?.login : undefined;
  if (input.email !== undefined && input.email) {
    if (!normEmail(input.email)) c.fail('email', 'Check the email address');
    else if (get('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id IS NOT ?', input.email.trim(), id ?? null)) c.fail('email', 'Another person already uses this email');
  }
  if (creating && login && !input.email) c.fail('email', 'People who sign in need an email address');
  if (creating && login) {
    const problem = passwordProblem(input.password, input.email);
    if (problem) c.fail('password', problem);
  }
  if (input.manager_id) requireActiveUser(c, 'manager_id', intId(input.manager_id), 'Manager');
  if (input.region_id && !get('SELECT id FROM regions WHERE id = ?', intId(input.region_id))) c.fail('region_id', 'Choose a region');
  if (input.factory_id && !get('SELECT id FROM factories WHERE id = ?', intId(input.factory_id))) c.fail('factory_id', 'Choose a factory');
  if (input.role === 'regional_manager' && !intId(input.region_id) && !(id && get('SELECT region_id FROM users WHERE id = ?', id)?.region_id)) c.fail('region_id', 'A regional sales manager needs a region');
  c.text('designation', input.designation, { max: 120, label: 'Designation' });
}

/** Individual accounts only — there is no shared admin password. */
export function createUser(input, user) {
  const c = new Check();
  validateUser(c, input, { creating: true });
  c.throwIfAny();
  const login = ROLES.find((r) => r.value === input.role)?.login;
  const stamp = nowIso();
  const id = insert('users', {
    name: str(input.name, 120), email: input.email ? input.email.trim().toLowerCase() : null, phone: str(input.phone, 40), role: input.role || 'staff', department: input.department || null,
    login_enabled: login ? 1 : 0, password_hash: login ? hashPassword(input.password) : null, must_change_password: login ? 1 : 0,
    values_access: bool(input.values_access) ? 1 : 0, manager_id: intId(input.manager_id), designation: str(input.designation, 120), region_id: intId(input.region_id), factory_id: intId(input.factory_id),
    active: 1, created_at: stamp, updated_at: stamp,
  });
  audit('user', id, 'create', { name: input.name, role: input.role, department: input.department, login: Boolean(login) });
  return { id };
}

export function updateUser(id, input, user) {
  const cur = get('SELECT * FROM users WHERE id = ?', id);
  if (!cur) throw notFound('User');
  const c = new Check();
  validateUser(c, input, { id, cur });
  if (input.role && ROLES.find((r) => r.value === input.role)?.login && !cur.password_hash && !input.password) c.fail('password', 'Set a first password for sign-in');
  if (input.password) {
    const problem = passwordProblem(input.password, input.email || cur.email);
    if (problem) c.fail('password', problem);
  }
  if (id === user.id && input.role && input.role !== 'super_admin') c.fail('role', 'You cannot remove your own administrator access');
  c.throwIfAny();
  const next = {};
  for (const k of ['name', 'phone', 'department', 'designation']) if (input[k] !== undefined) next[k] = str(input[k], 120);
  for (const k of ['region_id', 'factory_id']) if (input[k] !== undefined) next[k] = intId(input[k]);
  if (input.email !== undefined) next.email = input.email ? input.email.trim().toLowerCase() : null;
  if (input.role !== undefined) {
    next.role = input.role;
    next.login_enabled = ROLES.find((r) => r.value === input.role)?.login ? 1 : 0;
  }
  if (input.values_access !== undefined) next.values_access = bool(input.values_access) ? 1 : 0;
  if (input.manager_id !== undefined) next.manager_id = intId(input.manager_id);
  if (input.password) Object.assign(next, { password_hash: hashPassword(input.password), must_change_password: 1 });
  return tx(() => {
    update('users', id, { ...next, updated_at: nowIso(), version: cur.version + 1 });
    if (next.role !== undefined || next.login_enabled === 0 || input.password) destroyUserSessions(id);
    audit('user', id, 'update', { ...next, password_hash: next.password_hash ? '[reset]' : undefined });
    return { id };
  });
}

export function openWorkFor(userId) {
  const open = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
  return {
    customers: get('SELECT COUNT(*) AS n FROM customers WHERE owner_id = ? AND merged_into_id IS NULL AND archived_at IS NULL', userId).n,
    enquiries: get(`SELECT COUNT(*) AS n FROM enquiries WHERE owner_id = ? AND stage IN (${open})`, userId).n,
    tasks: get("SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status = 'open'", userId).n,
    orders: get("SELECT COUNT(*) AS n FROM orders WHERE (owner_id = ? OR coordinator_id = ?) AND closed_at IS NULL AND archived_at IS NULL", userId, userId).n,
    reactivation: get('SELECT COUNT(*) AS n FROM reactivation_cases WHERE owner_id = ? AND closed_at IS NULL', userId).n,
    complaints: get("SELECT COUNT(*) AS n FROM complaints WHERE owner_id = ? AND status NOT IN ('resolved','closed')", userId).n,
  };
}

/**
 * Deactivation keeps the person's historical name everywhere and requires their open work to be reassigned
 * to an active owner first. Sign-in stops immediately.
 */
export function deactivateUser(id, input, user) {
  const cur = get('SELECT * FROM users WHERE id = ?', id);
  if (!cur) throw notFound('User');
  if (!cur.active) throw conflict('Already deactivated');
  if (id === user.id) throw conflict('You cannot deactivate yourself');
  const work = openWorkFor(id);
  const total = Object.values(work).reduce((s, n) => s + n, 0);
  const to = intId(input.reassign_to);
  if (total && !to) throw conflict('Reassign this person\'s open work before deactivating them.', { code: 'open_work', open_work: work });
  if (to) {
    const c = new Check();
    const target = requireActiveUser(c, 'reassign_to', to, 'New owner');
    if (target && target.id === id) c.fail('reassign_to', 'Choose someone else');
    c.throwIfAny();
  }
  return tx(() => {
    const stamp = nowIso();
    if (to) {
      const open = OPEN_ENQUIRY_STAGES.map((s) => `'${s}'`).join(',');
      for (const t of all("SELECT id FROM tasks WHERE owner_id = ? AND status = 'open'", id)) {
        insert('task_changes', { task_id: t.id, field: 'owner', old_value: String(id), new_value: String(to), reason: `Reassigned on deactivation of ${cur.name}`, actor_id: user.id, created_at: stamp });
      }
      run("UPDATE tasks SET owner_id = ?, updated_at = ?, version = version + 1 WHERE owner_id = ? AND status = 'open'", to, stamp, id);
      run('UPDATE customers SET owner_id = ?, updated_at = ?, version = version + 1 WHERE owner_id = ? AND merged_into_id IS NULL', to, stamp, id);
      run(`UPDATE enquiries SET owner_id = ?, updated_at = ?, version = version + 1 WHERE owner_id = ? AND stage IN (${open})`, to, stamp, id);
      run('UPDATE orders SET owner_id = ?, updated_at = ?, version = version + 1 WHERE owner_id = ? AND closed_at IS NULL', to, stamp, id);
      run('UPDATE orders SET coordinator_id = ?, updated_at = ? WHERE coordinator_id = ? AND closed_at IS NULL', to, stamp, id);
      run('UPDATE reactivation_cases SET owner_id = ?, updated_at = ? WHERE owner_id = ? AND closed_at IS NULL', to, stamp, id);
      run("UPDATE complaints SET owner_id = ?, updated_at = ? WHERE owner_id = ? AND status NOT IN ('resolved','closed')", to, stamp, id);
      run('UPDATE invoices SET owner_id = ?, updated_at = ? WHERE owner_id = ?', to, stamp, id);
    }
    update('users', id, { active: 0, deactivated_at: stamp, deactivated_by: user.id, updated_at: stamp, version: cur.version + 1 });
    destroyUserSessions(id);
    audit('user', id, 'deactivate', { reassigned_to: to, open_work: work, reason: input.reason });
    return { id, reassigned: work };
  });
}

export function reactivateUser(id, user) {
  const cur = get('SELECT * FROM users WHERE id = ?', id);
  if (!cur) throw notFound('User');
  update('users', id, { active: 1, deactivated_at: null, deactivated_by: null, failed_logins: 0, locked_until: null, updated_at: nowIso(), version: cur.version + 1 });
  audit('user', id, 'reactivate', {});
  return { id };
}

// ------------------------------------------------------------------ settings
export function getSettings() {
  return settings();
}

export function updateSettings(section, input, user) {
  if (!DEFAULT_SETTINGS[section] || section === 'finance') throw notFound('Settings section');
  const c = new Check();
  const cur = settings()[section];
  const next = { ...cur };
  if (section === 'calendar') {
    try {
      Intl.DateTimeFormat('en-US', { timeZone: input.timezone || cur.timezone });
    } catch {
      c.fail('timezone', 'Unknown time zone');
    }
    const days = Array.isArray(input.workingDays) ? input.workingDays.map(Number).filter((d) => d >= 0 && d <= 6) : cur.workingDays;
    if (!days.length) c.fail('workingDays', 'Choose at least one working day');
    const holidays = Array.isArray(input.holidays) ? input.holidays : cur.holidays;
    if (holidays.some((h) => !isDate(h))) c.fail('holidays', 'Holidays must be valid dates');
    for (const k of ['workStart', 'workEnd']) if (input[k] && !isTime(input[k])) c.fail(k, 'Use HH:MM');
    Object.assign(next, { timezone: input.timezone || cur.timezone, workingDays: [...new Set(days)].sort(), holidays: [...new Set(holidays)].sort(), workStart: input.workStart || cur.workStart, workEnd: input.workEnd || cur.workEnd });
  } else if (section === 'rules') {
    for (const k of Object.keys(DEFAULT_SETTINGS.rules)) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 0 || n > 3650) c.fail(k, 'Enter a whole number');
      else next[k] = n;
    }
  } else if (section === 'access') {
    if (input.salesScope !== undefined) {
      if (!['own', 'all'].includes(input.salesScope)) c.fail('salesScope', 'Choose own or all');
      else next.salesScope = input.salesScope;
    }
    if (input.dncPolicy !== undefined) {
      if (!['warn', 'block'].includes(input.dncPolicy)) c.fail('dncPolicy', 'Choose warn or block');
      else next.dncPolicy = input.dncPolicy;
    }
    for (const k of ['coordinatorMode', 'productionSeesValues']) if (input[k] !== undefined) next[k] = bool(input[k]);
  } else if (section === 'escalation') {
    if (input.defaultManagerId) requireActiveUser(c, 'defaultManagerId', intId(input.defaultManagerId), 'Escalation manager');
    next.defaultManagerId = intId(input.defaultManagerId);
  } else if (section === 'scheduler') {
    if (input.enabled !== undefined) next.enabled = bool(input.enabled);
    if (input.intervalMinutes !== undefined) {
      const n = Number(input.intervalMinutes);
      if (!(n >= 1 && n <= 1440)) c.fail('intervalMinutes', 'Between 1 and 1440 minutes');
      else next.intervalMinutes = n;
    }
  } else if (section === 'backup') {
    if (input.enabled !== undefined) next.enabled = bool(input.enabled);
    if (input.keep !== undefined) next.keep = Math.max(1, Number(input.keep) || 14);
    if (input.hour !== undefined) next.hour = Math.min(23, Math.max(0, Number(input.hour) || 0));
  } else if (section === 'company') {
    c.text('name', input.name ?? cur.name, { required: true, max: 120, label: 'Company name' });
    next.name = str(input.name ?? cur.name, 120);
    next.short = str(input.short ?? cur.short, 20);
    for (const k of ['gstin', 'address', 'phone', 'email', 'website']) if (input[k] !== undefined) next[k] = str(input[k], k === 'address' ? 300 : 120) || '';
    if (input.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/i.test(String(input.gstin).trim())) c.fail('gstin', 'A GSTIN has 15 characters');
    if (input.currency !== undefined) {
      if (!CURRENCIES.includes(input.currency)) c.fail('currency', 'Choose a currency');
      else next.currency = input.currency;
    }
    if (input.fiscalYearStartMonth !== undefined) {
      const m = Number(input.fiscalYearStartMonth);
      if (!Number.isInteger(m) || m < 1 || m > 12) c.fail('fiscalYearStartMonth', 'Choose a month');
      else next.fiscalYearStartMonth = m;
    }
  } else if (section === 'modules') {
    // The parts of the CRM kept for later versions. Switching one on brings back its pages and reminders.
    for (const k of Object.keys(DEFAULT_SETTINGS.modules)) if (input[k] !== undefined) next[k] = bool(input[k]);
  } else if (section === 'approvals') {
    if (input.enabled !== undefined) next.enabled = bool(input.enabled);
    for (const k of ['discountManagerPct', 'discountHeadPct', 'minMarginPct']) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < 0 || n > 100) c.fail(k, 'Enter a percentage');
      else next[k] = n;
    }
    if (next.discountHeadPct < next.discountManagerPct) c.fail('discountHeadPct', 'The sales-head threshold must be at or above the manager threshold');
    if (input.largeQuotationValue !== undefined) {
      const n = Number(input.largeQuotationValue);
      if (!Number.isFinite(n) || n < 0) c.fail('largeQuotationValue', 'Enter an amount');
      else next.largeQuotationValue = n;
    }
    if (input.belowMinPriceRole !== undefined) {
      if (!['regional_manager', 'sales_head', 'management', 'super_admin'].includes(input.belowMinPriceRole)) c.fail('belowMinPriceRole', 'Choose an approver level');
      else next.belowMinPriceRole = input.belowMinPriceRole;
    }
    if (input.requireBeforeIssue !== undefined) next.requireBeforeIssue = bool(input.requireBeforeIssue);
  } else if (section === 'quotation') {
    for (const k of ['defaultPaymentTerms', 'defaultWarranty', 'defaultDelivery']) if (input[k] !== undefined) next[k] = str(input[k], 300) || '';
    for (const [k, max] of [['defaultValidityDays', 365], ['freightGstRate', 40]]) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isFinite(n) || n < 0 || n > max) c.fail(k, 'Enter a valid number');
      else next[k] = n;
    }
  } else if (section === 'reminders') {
    for (const k of ['quotationFollowupWorkingDays', 'quotationExpiryWarnDays', 'sampleFeedbackDays', 'repeatOrderMinOrders', 'paymentReminderDays']) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < 0 || n > 365) c.fail(k, 'Enter a whole number of days');
      else next[k] = n;
    }
    for (const k of ['repeatOrderEnabled', 'managementSummaries']) if (input[k] !== undefined) next[k] = bool(input[k]);
  } else if (section === 'objects') {
    if (input.publicBaseUrl !== undefined) {
      const u = str(input.publicBaseUrl, 300) || '';
      if (u && !/^https?:\/\/[^\s]+$/i.test(u)) c.fail('publicBaseUrl', 'Use a full address such as https://crm.example.com');
      else next.publicBaseUrl = u.replace(/\/+$/, '');
    }
    if (input.brandColor !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(String(input.brandColor))) c.fail('brandColor', 'Use a colour like #3f1069');
      else next.brandColor = input.brandColor;
    }
    if (input.archivedMessage !== undefined) next.archivedMessage = str(input.archivedMessage, 300) || '';
    for (const k of ['labelShowName', 'labelShowId', 'labelShowCompany']) if (input[k] !== undefined) next[k] = bool(input[k]);
  }
  if (section === 'access' && input.autoAssignEnquiries !== undefined) next.autoAssignEnquiries = bool(input.autoAssignEnquiries);
  c.throwIfAny();
  setSetting(section, next, user.id);
  audit('settings', null, `update_${section}`, { before: cur, after: next });
  return settings()[section];
}

// ------------------------------------------------------------------ masters: regions, factories, tags, assignment rules
export function listMasters() {
  return {
    regions: all('SELECT r.*, (SELECT COUNT(*) FROM customers c WHERE c.region_id = r.id) AS customers, (SELECT COUNT(*) FROM users u WHERE u.region_id = r.id) AS users FROM regions r ORDER BY r.sort_order, r.name'),
    factories: all('SELECT f.*, (SELECT COUNT(*) FROM orders o WHERE o.factory_id = f.id) AS orders FROM factories f ORDER BY f.name'),
    tags: all("SELECT t.*, (SELECT COUNT(*) FROM taggings g WHERE g.tag_id = t.id) AS uses FROM tags t ORDER BY t.name"),
    assignment_rules: all(`SELECT a.*, u.name AS user_name, rg.name AS region_name, pc.name AS category_name FROM assignment_rules a JOIN users u ON u.id = a.user_id
      LEFT JOIN regions rg ON rg.id = a.region_id LEFT JOIN product_categories pc ON pc.id = a.category_id ORDER BY a.priority, a.id`),
  };
}

const MASTER_TABLES = { regions: 'regions', factories: 'factories', tags: 'tags', assignment_rules: 'assignment_rules' };

export function saveMaster(kind, id, input) {
  const table = MASTER_TABLES[kind];
  if (!table) throw notFound('Master list');
  const cur = id ? get(`SELECT * FROM ${table} WHERE id = ?`, id) : null;
  if (id && !cur) throw notFound('Record');
  const c = new Check();
  let data = {};
  if (kind === 'regions') {
    c.text('name', input.name ?? cur?.name, { required: true, max: 60, label: 'Region name' });
    if (get('SELECT id FROM regions WHERE name = ? COLLATE NOCASE AND id IS NOT ?', str(input.name ?? cur?.name, 60), id ?? null)) c.fail('name', 'A region with this name exists');
    data = { name: str(input.name ?? cur?.name, 60), states: input.states !== undefined ? str(input.states, 500) : cur?.states ?? null, active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : cur?.active ?? 1, sort_order: input.sort_order !== undefined ? Number(input.sort_order) || 0 : cur?.sort_order ?? 0 };
  } else if (kind === 'factories') {
    c.text('name', input.name ?? cur?.name, { required: true, max: 80, label: 'Factory name' });
    data = { name: str(input.name ?? cur?.name, 80), location: input.location !== undefined ? str(input.location, 160) : cur?.location ?? null, active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : cur?.active ?? 1 };
  } else if (kind === 'tags') {
    c.text('name', input.name ?? cur?.name, { required: true, max: 40, label: 'Tag' });
    if (get('SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id IS NOT ?', str(input.name ?? cur?.name, 40), id ?? null)) c.fail('name', 'This tag exists');
    const color = input.color ?? cur?.color ?? 'slate';
    if (!TAG_COLORS.includes(color)) c.fail('color', 'Choose a colour');
    data = { name: str(input.name ?? cur?.name, 40), color };
  } else if (kind === 'assignment_rules') {
    const userId = intId(input.user_id ?? cur?.user_id);
    requireActiveUser(c, 'user_id', userId, 'Owner');
    const regionId = input.region_id !== undefined ? intId(input.region_id) : cur?.region_id ?? null;
    const categoryId = input.category_id !== undefined ? intId(input.category_id) : cur?.category_id ?? null;
    const segment = input.segment !== undefined ? input.segment || null : cur?.segment ?? null;
    if (regionId && !get('SELECT id FROM regions WHERE id = ?', regionId)) c.fail('region_id', 'Choose a region');
    if (categoryId && !get('SELECT id FROM product_categories WHERE id = ?', categoryId)) c.fail('category_id', 'Choose a product family');
    if (segment && !['domestic', 'export'].includes(segment)) c.fail('segment', 'Choose domestic or export');
    if (!regionId && !categoryId && !segment) c.fail('region_id', 'A rule needs a region, a product family or a market');
    data = { user_id: userId, region_id: regionId, category_id: categoryId, segment, priority: input.priority !== undefined ? Number(input.priority) || 10 : cur?.priority ?? 10, active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : cur?.active ?? 1 };
  }
  c.throwIfAny();
  if (cur) {
    update(table, id, data);
    audit(kind, id, 'update', data);
    return { id };
  }
  const newId = insert(table, data);
  audit(kind, newId, 'create', data);
  return { id: newId };
}

/** Unused master values can be removed; used ones are deactivated (regions, factories, rules) or kept (tags). */
export function deleteMaster(kind, id) {
  const table = MASTER_TABLES[kind];
  if (!table) throw notFound('Master list');
  if (!get(`SELECT id FROM ${table} WHERE id = ?`, id)) throw notFound('Record');
  const used = {
    regions: () => get('SELECT 1 AS x FROM customers WHERE region_id = ? UNION SELECT 1 FROM users WHERE region_id = ? LIMIT 1', id, id),
    factories: () => get('SELECT 1 AS x FROM orders WHERE factory_id = ? UNION SELECT 1 FROM users WHERE factory_id = ? LIMIT 1', id, id),
    tags: () => null,
    assignment_rules: () => null,
  }[kind]();
  if (used) {
    update(table, id, { active: 0 });
    audit(kind, id, 'deactivate', {});
    return { id, deactivated: true };
  }
  if (kind === 'tags') run('DELETE FROM taggings WHERE tag_id = ?', id);
  run(`DELETE FROM ${table} WHERE id = ?`, id);
  audit(kind, id, 'delete', {});
  return { id, deleted: true };
}

// ------------------------------------------------------------------ audit & health
export function listAudit(query) {
  const where = ['1 = 1'];
  const params = [];
  if (query.entity_type) {
    where.push('a.entity_type = ?');
    params.push(query.entity_type);
  }
  if (intId(query.entity_id)) {
    where.push('a.entity_id = ?');
    params.push(intId(query.entity_id));
  }
  if (intId(query.actor)) {
    where.push('a.actor_id = ?');
    params.push(intId(query.actor));
  }
  if (query.action) {
    where.push('a.action LIKE ?');
    params.push(`%${query.action}%`);
  }
  const page = Math.max(1, Number(query.page) || 1);
  const rows = all(`SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 100 OFFSET ?`, ...params, (page - 1) * 100);
  const count = get(`SELECT COUNT(*) AS n FROM audit_events a WHERE ${where.join(' AND ')}`, ...params).n;
  return { rows: rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null })), count, page, pageSize: 100 };
}

export function systemHealth() {
  const runs = all('SELECT * FROM scheduler_runs ORDER BY id DESC LIMIT 15').map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null, error: r.error ? JSON.parse(r.error) : null }));
  return {
    database: { path: DB_PATH, engine: POSTGRES_SERVER ? 'PostgreSQL (Cloud SQL)' : 'PostgreSQL (embedded PGlite)', bytes: databaseBytes(), documents: STORAGE_LABEL, migrations: all('SELECT * FROM schema_migrations ORDER BY version') },
    scheduler: { settings: settings().scheduler, runs, open_alerts: all('SELECT rule, COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL GROUP BY rule') },
    backups: { settings: settings().backup, list: listBackups() },
    errors: all('SELECT * FROM error_log ORDER BY id DESC LIMIT 30'),
    imports: all("SELECT id, type, file_name, status, counts, created_at FROM import_batches ORDER BY id DESC LIMIT 10").map((b) => ({ ...b, counts: JSON.parse(b.counts || '{}') })),
    quantity_reconciliation: { mismatches: reconcileQuantities() },
  };
}

export { history };
