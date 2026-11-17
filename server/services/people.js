import { get, all } from '../db.js';
import { settings, str, intId } from '../util.js';
import { groupOf } from '../../shared/constants.js';

/** SQL list of the management/admin roles, e.g. for "the first administrator". */
export const ADMIN_ROLES_SQL = "('management','super_admin')";
const ADMIN_ORDER = "CASE role WHEN 'management' THEN 0 ELSE 1 END, id";

/** Validates that an owner is an active named person. Returns the user row or null (with a field error). */
export function requireActiveUser(check, field, id, label = 'Owner') {
  if (!id) {
    check.fail(field, `${label} is required`);
    return null;
  }
  const u = get('SELECT id, name, active, role, department FROM users WHERE id = ?', id);
  if (!u) {
    check.fail(field, `Choose ${label.toLowerCase()} from the list`);
    return null;
  }
  if (!u.active) {
    check.fail(field, `${u.name} is deactivated — choose an active person`);
    return null;
  }
  return u;
}

export const userName = (id) => (id ? get('SELECT name FROM users WHERE id = ?', id)?.name ?? null : null);

export function defaultCoordinatorId() {
  return get("SELECT id FROM users WHERE role = 'coordinator' AND active = 1 ORDER BY id LIMIT 1")?.id
    ?? get(`SELECT id FROM users WHERE role IN ${ADMIN_ROLES_SQL} AND active = 1 ORDER BY ${ADMIN_ORDER} LIMIT 1`)?.id
    ?? null;
}

/** Who gets escalations for a person: their manager, else the configured default, else the first admin. */
export function escalationManagerFor(userId) {
  const u = userId ? get('SELECT manager_id FROM users WHERE id = ?', userId) : null;
  if (u?.manager_id && get('SELECT active FROM users WHERE id = ?', u.manager_id)?.active) return u.manager_id;
  const configured = settings().escalation.defaultManagerId;
  if (configured && get('SELECT active FROM users WHERE id = ?', configured)?.active) return configured;
  return get(`SELECT id FROM users WHERE role IN ${ADMIN_ROLES_SQL} AND active = 1 ORDER BY ${ADMIN_ORDER} LIMIT 1`)?.id ?? null;
}

/**
 * The person an update came from. In coordinator mode, updates entered on someone's behalf must name
 * the source person (who can be a named owner without a login, or a free-text name).
 */
export function resolveReporter(input, user, check, { required = false } = {}) {
  const id = intId(input.reported_by_id);
  const name = str(input.reported_by_name, 120);
  if (id) {
    const u = get('SELECT id, name FROM users WHERE id = ?', id);
    if (!u) check.fail('reported_by_id', 'Choose a person from the list');
    return { reported_by_id: id, reported_by_name: u?.name ?? null };
  }
  if (name) return { reported_by_id: null, reported_by_name: name };
  if (required) check.fail('reported_by_id', 'Who reported this update? (coordinator mode needs the source person)');
  return { reported_by_id: null, reported_by_name: null };
}

export function activePeople() {
  return all('SELECT id, name, role, department, designation, region_id, factory_id, active, login_enabled FROM users ORDER BY active DESC, name')
    .map((p) => ({ ...p, group: groupOf(p.role) }));
}
