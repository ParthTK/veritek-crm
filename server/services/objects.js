// Objects & QR codes: a general-purpose object register with permanent public ids, custom fields, versioned
// documents, QR / Code 128 codes, public scan pages and privacy-preserving scan analytics.
import crypto from 'node:crypto';
import { get, all, run, insert, update, tx } from '../db.js';
import { getFile, fileExists } from '../storage.js';
import { FIELD_TYPES, OBJECT_VISIBILITY } from '../../shared/constants.js';
import {
  badRequest, notFound, nowIso, today, str, intId, num, audit, parseJson, settings,
} from '../util.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { linkAttachment } from './attachments.js';

// Unambiguous alphabet: no 0/O/1/I/L, so ids survive being read off a printed label.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ID_LENGTH = 8;

/**
 * A cryptographically unpredictable public id. Ids are never reused: deleting an object
 * only sets deleted_at, so the row (and its id) stays claimed forever.
 */
export function newPublicId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = crypto.randomBytes(ID_LENGTH * 2);
    let id = '';
    for (let i = 0; id.length < ID_LENGTH && i < bytes.length; i++) {
      const v = bytes[i];
      if (v >= 256 - (256 % ALPHABET.length)) continue; // avoid modulo bias
      id += ALPHABET[v % ALPHABET.length];
    }
    if (id.length === ID_LENGTH && !get('SELECT 1 AS x FROM objects WHERE public_id = ?', id)) return id;
  }
  throw new Error('Could not allocate a unique public id');
}

export const publicUrlFor = (publicId, baseUrl) => `${String(baseUrl || '').replace(/\/+$/, '')}/o/${publicId}`;
export const objectSettings = () => settings().objects;
/** The stored bytes of an attachment, or null when the file is missing. */
export const fileData = (attachment) => getFile(attachment.storage_key);

// ------------------------------------------------------------------ custom fields
const FIELD_TYPE_VALUES = FIELD_TYPES.map((f) => f.value);

/**
 * Custom fields are stored as an ordered array so the object's structure is entirely
 * user-defined: [{ key, label, type, value, options, public }].
 */
export function normalizeFields(raw) {
  const list = Array.isArray(raw) ? raw : parseJson(raw, []) || [];
  const seen = new Set();
  return list.slice(0, 100).map((f, i) => {
    const label = str(f.label, 120) || `Field ${i + 1}`;
    let key = str(f.key, 80) || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `field_${i + 1}`;
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    const type = FIELD_TYPE_VALUES.includes(f.type) ? f.type : 'text';
    let value = f.value;
    if (type === 'checkbox') value = Boolean(value && value !== 'false');
    else if (type === 'number') value = value === '' || value === null || value === undefined ? null : num(value);
    else if (type === 'file') value = intId(value);
    else value = str(value, 4000);
    return {
      key,
      label,
      type,
      value,
      options: type === 'dropdown' ? (Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean) : undefined,
      public: f.public !== false,
    };
  });
}

// ------------------------------------------------------------------ objects
function objectData(body) {
  const d = {};
  for (const k of ['name', 'description', 'location', 'owner_name', 'serial_number', 'archive_note']) {
    if (body[k] !== undefined) d[k] = str(body[k], k === 'description' ? 4000 : 200);
  }
  for (const k of ['category_id', 'image_attachment_id', 'customer_id', 'product_id', 'order_id']) {
    if (body[k] !== undefined) d[k] = intId(body[k]);
  }
  if (d.customer_id && !get('SELECT id FROM customers WHERE id = ?', d.customer_id)) throw badRequest('Customer not found', { customer_id: 'Choose a customer' });
  if (d.product_id && !get('SELECT id FROM products WHERE id = ?', d.product_id)) throw badRequest('Product not found', { product_id: 'Choose a product' });
  if (d.order_id && !get('SELECT id FROM orders WHERE id = ?', d.order_id)) throw badRequest('Order not found', { order_id: 'Choose an order' });
  if (body.visibility !== undefined) {
    if (!OBJECT_VISIBILITY.some((v) => v.value === body.visibility)) throw badRequest('Unknown visibility');
    d.visibility = body.visibility;
  }
  if (body.single_file_direct !== undefined) d.single_file_direct = body.single_file_direct ? 1 : 0;
  if (body.show_updated !== undefined) d.show_updated = body.show_updated ? 1 : 0;
  if (body.custom_fields !== undefined) d.custom_fields = JSON.stringify(normalizeFields(body.custom_fields));
  return d;
}

export function createObject(body, user) {
  const d = objectData(body);
  if (!d.name) throw badRequest('Give the object a name', { name: 'Required' });
  return tx(() => {
    // A category template seeds the field structure when the caller sends none.
    if (d.category_id && body.custom_fields === undefined) {
      const template = parseJson(get('SELECT field_template FROM object_categories WHERE id = ?', d.category_id)?.field_template, []);
      if (template?.length) d.custom_fields = JSON.stringify(normalizeFields(template));
    }
    const stamp = nowIso();
    const id = insert('objects', {
      ...d,
      public_id: newPublicId(),
      visibility: d.visibility || 'public',
      custom_fields: d.custom_fields ?? '[]',
      status: 'active',
      created_by: user.id,
      created_at: stamp,
      updated_at: stamp,
    });
    if (body.password) setObjectPassword(id, body.password);
    if (body.image_attachment_id) linkAttachment(intId(body.image_attachment_id), 'object', id, user);
    audit('object', id, 'create', { name: d.name });
    return id;
  });
}

export function updateObject(id, body, user) {
  const existing = get('SELECT * FROM objects WHERE id = ? AND deleted_at IS NULL', id);
  if (!existing) throw notFound('Object');
  const d = objectData(body);
  if (d.name === null) throw badRequest('Give the object a name', { name: 'Required' });
  tx(() => {
    update('objects', id, { ...d, updated_at: nowIso() });
    if (body.password !== undefined) setObjectPassword(id, body.password);
    if (body.image_attachment_id) linkAttachment(intId(body.image_attachment_id), 'object', id, user);
    audit('object', id, 'update', Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'custom_fields')));
  });
}

export function setObjectPassword(id, password) {
  const value = str(password, 200);
  run('UPDATE objects SET password_hash = ? WHERE id = ?', value ? hashPassword(value) : null, id);
}

export function checkObjectPassword(object, password) {
  return Boolean(object.password_hash) && verifyPassword(String(password || ''), object.password_hash);
}

export function archiveObject(id, archived, note) {
  if (!get('SELECT id FROM objects WHERE id = ? AND deleted_at IS NULL', id)) throw notFound('Object');
  update('objects', id, {
    status: archived ? 'archived' : 'active',
    archived_at: archived ? nowIso() : null,
    archive_note: archived ? str(note, 500) : null,
    updated_at: nowIso(),
  });
  audit('object', id, archived ? 'archive' : 'restore', { note });
}

/** Soft delete: the row stays so the public id is never handed to a different object. */
export function deleteObject(id) {
  if (!get('SELECT id FROM objects WHERE id = ?', id)) throw notFound('Object');
  update('objects', id, { deleted_at: nowIso(), status: 'archived', updated_at: nowIso() });
  audit('object', id, 'delete', {});
}

/** Copies the structure and field values of an object, with a brand new identity. */
export function duplicateObject(id, user, overrides = {}) {
  const src = get('SELECT * FROM objects WHERE id = ?', id);
  if (!src) throw notFound('Object');
  return tx(() => {
    const stamp = nowIso();
    const copyId = insert('objects', {
      public_id: newPublicId(), name: str(overrides.name, 200) || `${src.name} (copy)`, description: src.description, category_id: src.category_id,
      location: src.location, owner_name: src.owner_name, visibility: src.visibility, custom_fields: src.custom_fields, single_file_direct: src.single_file_direct,
      show_updated: src.show_updated, customer_id: src.customer_id, product_id: src.product_id, order_id: src.order_id, image_attachment_id: src.image_attachment_id,
      status: 'active', created_by: user.id, created_at: stamp, updated_at: stamp,
    });
    if (overrides.copyFiles !== false) {
      for (const f of all('SELECT * FROM object_files WHERE object_id = ? AND is_current = 1 ORDER BY sort_order', id)) {
        insert('object_files', {
          object_id: copyId, attachment_id: f.attachment_id, title: f.title, description: f.description, visibility: f.visibility, sort_order: f.sort_order,
          version_group: nextVersionGroup(copyId), version_no: 1, is_current: 1, uploaded_by: user.id, uploaded_at: stamp,
        });
        linkAttachment(f.attachment_id, 'object', copyId, user);
      }
    }
    audit('object', copyId, 'duplicate', { from: src.public_id });
    return copyId;
  });
}

// ------------------------------------------------------------------ files
function nextVersionGroup(objectId) {
  return (get('SELECT COALESCE(MAX(version_group), 0) AS g FROM object_files WHERE object_id = ?', objectId).g || 0) + 1;
}

/** Adds a document (uploaded first through /attachments), or a new version of an existing one. */
export function attachFile(objectId, body, user) {
  if (!get('SELECT id FROM objects WHERE id = ? AND deleted_at IS NULL', objectId)) throw notFound('Object');
  const attachmentId = intId(body.attachment_id);
  if (!attachmentId) throw badRequest('Upload the file first');
  const attachment = get('SELECT * FROM attachments WHERE id = ?', attachmentId);
  if (!attachment) throw badRequest('Upload not found');
  return tx(() => {
    linkAttachment(attachmentId, 'object', objectId, user);
    const replacesId = intId(body.replaces_id);
    let versionGroup = nextVersionGroup(objectId);
    let versionNo = 1;
    let sortOrder = (get('SELECT COALESCE(MAX(sort_order), -1) AS s FROM object_files WHERE object_id = ?', objectId).s ?? -1) + 1;
    let title = str(body.title, 200) || attachment.original_name;
    if (replacesId) {
      const previous = get('SELECT * FROM object_files WHERE id = ? AND object_id = ?', replacesId, objectId);
      if (!previous) throw badRequest('The document being replaced was not found');
      versionGroup = previous.version_group;
      versionNo = (get('SELECT MAX(version_no) AS v FROM object_files WHERE object_id = ? AND version_group = ?', objectId, versionGroup).v || 0) + 1;
      sortOrder = previous.sort_order;
      title = str(body.title, 200) || previous.title;
      run('UPDATE object_files SET is_current = 0 WHERE object_id = ? AND version_group = ?', objectId, versionGroup);
    }
    const id = insert('object_files', {
      object_id: objectId, attachment_id: attachmentId, title, description: str(body.description, 1000),
      visibility: body.visibility === 'private' ? 'private' : 'public', sort_order: sortOrder,
      version_group: versionGroup, version_no: versionNo, is_current: 1, uploaded_by: user.id, uploaded_at: nowIso(),
    });
    run('UPDATE objects SET updated_at = ? WHERE id = ?', nowIso(), objectId);
    audit('object', objectId, replacesId ? 'file_replace' : 'file_add', { title, version: versionNo });
    return id;
  });
}

/** Brings an older version back as the current one — the object URL never changes. */
export function restoreFileVersion(objectId, fileId, user) {
  const file = get('SELECT * FROM object_files WHERE id = ? AND object_id = ?', fileId, objectId);
  if (!file) throw notFound('Version');
  tx(() => {
    const versionNo = (get('SELECT MAX(version_no) AS v FROM object_files WHERE object_id = ? AND version_group = ?', objectId, file.version_group).v || 0) + 1;
    run('UPDATE object_files SET is_current = 0 WHERE object_id = ? AND version_group = ?', objectId, file.version_group);
    insert('object_files', {
      object_id: objectId, attachment_id: file.attachment_id, title: file.title, description: file.description, visibility: file.visibility, sort_order: file.sort_order,
      version_group: file.version_group, version_no: versionNo, is_current: 1, uploaded_by: user.id, uploaded_at: nowIso(),
    });
    run('UPDATE objects SET updated_at = ? WHERE id = ?', nowIso(), objectId);
    audit('object', objectId, 'file_restore', { title: file.title, restored_version: file.version_no });
  });
}

export function updateFile(objectId, fileId, body) {
  const file = get('SELECT * FROM object_files WHERE id = ? AND object_id = ?', fileId, objectId);
  if (!file) throw notFound('Document');
  const d = {};
  if (body.title !== undefined) d.title = str(body.title, 200) || file.title;
  if (body.description !== undefined) d.description = str(body.description, 1000);
  if (body.visibility !== undefined) d.visibility = body.visibility === 'private' ? 'private' : 'public';
  update('object_files', fileId, d);
  run('UPDATE objects SET updated_at = ? WHERE id = ?', nowIso(), objectId);
  audit('object', objectId, 'file_update', { title: d.title ?? file.title });
}

export function removeFile(objectId, fileId) {
  const file = get('SELECT * FROM object_files WHERE id = ? AND object_id = ?', fileId, objectId);
  if (!file) throw notFound('Document');
  tx(() => {
    // Remove the whole version group so history does not resurface as the current file. The stored
    // attachment itself is kept (it may be referenced elsewhere and is part of the audit trail).
    run('DELETE FROM object_files WHERE object_id = ? AND version_group = ?', objectId, file.version_group);
    run('UPDATE objects SET updated_at = ? WHERE id = ?', nowIso(), objectId);
    audit('object', objectId, 'file_delete', { title: file.title });
  });
}

export function reorderFiles(objectId, order) {
  tx(() => {
    order.forEach((fileId, index) => {
      const file = get('SELECT version_group FROM object_files WHERE id = ? AND object_id = ?', fileId, objectId);
      if (file) run('UPDATE object_files SET sort_order = ? WHERE object_id = ? AND version_group = ?', index, objectId, file.version_group);
    });
    run('UPDATE objects SET updated_at = ? WHERE id = ?', nowIso(), objectId);
  });
  audit('object', objectId, 'file_reorder', { count: order.length });
}

export function objectFiles(objectId, { includePrivate = true, currentOnly = true } = {}) {
  return all(
    `SELECT f.*, a.original_name, a.mime, a.size, a.storage_key, u.name AS uploaded_by_name,
            (SELECT COUNT(*) FROM object_files v WHERE v.object_id = f.object_id AND v.version_group = f.version_group) AS version_count
     FROM object_files f JOIN attachments a ON a.id = f.attachment_id LEFT JOIN users u ON u.id = f.uploaded_by
     WHERE f.object_id = ? ${currentOnly ? 'AND f.is_current = 1' : ''} ${includePrivate ? '' : "AND f.visibility = 'public'"}
     ORDER BY f.sort_order, f.id`,
    objectId,
  );
}

// ------------------------------------------------------------------ codes
export function ensureCode(objectId, codeType, baseUrl, user) {
  const object = get('SELECT * FROM objects WHERE id = ?', objectId);
  if (!object) throw notFound('Object');
  const existing = get('SELECT * FROM object_codes WHERE object_id = ? AND code_type = ?', objectId, codeType);
  if (existing) return existing;
  const url = publicUrlFor(object.public_id, baseUrl);
  // Barcodes carry the bare id: Code 128 of a long URL is unreadable by most handheld scanners.
  const payload = codeType === 'barcode' ? object.public_id : url;
  const id = insert('object_codes', { object_id: objectId, code_type: codeType, permanent_url: url, payload, created_by: user?.id ?? null, created_at: nowIso() });
  audit('object', objectId, 'code_generate', { code_type: codeType, url });
  return get('SELECT * FROM object_codes WHERE id = ?', id);
}

// ------------------------------------------------------------------ scans
const deviceFrom = (userAgent = '') => {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|iphone|android|phone/.test(ua)) return 'mobile';
  if (!ua) return 'unknown';
  if (/bot|crawler|spider|preview|curl|wget|node-fetch|headless/.test(ua)) return 'bot';
  return 'desktop';
};

/** Records a scan. Deliberately stores no identifiers — just device class and coarse location. */
export function recordScan(objectId, req, source = 'qr') {
  const device = deviceFrom(req.get('user-agent'));
  if (device === 'bot') return;
  const city = req.get('x-vercel-ip-city') || req.get('cf-ipcity');
  const country = req.get('x-vercel-ip-country') || req.get('cf-ipcountry');
  let cityName = city;
  try {
    cityName = city ? decodeURIComponent(city) : null;
  } catch {
    cityName = city;
  }
  const location = [cityName, country].filter(Boolean).join(', ') || null;
  insert('scan_events', { object_id: objectId, scanned_at: nowIso(), device_type: device, approximate_location: location, source: String(source).slice(0, 20) });
  run('UPDATE objects SET scan_count = scan_count + 1, last_scanned_at = ? WHERE id = ?', nowIso(), objectId);
}

export function scanStats(objectId) {
  const t = today();
  const day = (n) => `${new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)}`;
  const stats = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN substr(scanned_at, 1, 10) = ? THEN 1 ELSE 0 END) AS today,
            SUM(CASE WHEN substr(scanned_at, 1, 10) >= ? THEN 1 ELSE 0 END) AS last_7,
            SUM(CASE WHEN substr(scanned_at, 1, 10) >= ? THEN 1 ELSE 0 END) AS last_30,
            MAX(scanned_at) AS last_scanned_at,
            SUM(CASE WHEN device_type = 'mobile' THEN 1 ELSE 0 END) AS mobile,
            SUM(CASE WHEN device_type = 'tablet' THEN 1 ELSE 0 END) AS tablet,
            SUM(CASE WHEN device_type = 'desktop' THEN 1 ELSE 0 END) AS desktop
     FROM scan_events WHERE object_id = ?`,
    t, day(6), day(29), objectId,
  );
  const daily = all(`SELECT substr(scanned_at, 1, 10) AS day, COUNT(*) AS scans FROM scan_events WHERE object_id = ? AND substr(scanned_at, 1, 10) >= ? GROUP BY 1 ORDER BY 1`, objectId, day(29));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = day(i);
    series.push({ day: d, scans: daily.find((x) => x.day === d)?.scans || 0 });
  }
  const locations = all(`SELECT COALESCE(approximate_location, 'Unknown') AS location, COUNT(*) AS scans FROM scan_events WHERE object_id = ? GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, objectId);
  return { ...stats, series, locations };
}

/** Objects whose stored file is missing on disk, and active objects without a code — the broken-link check. */
export function objectHealth() {
  const rows = all(`SELECT f.id, f.title, f.object_id, a.storage_key, a.original_name, o.name AS object_name, o.public_id
    FROM object_files f JOIN attachments a ON a.id = f.attachment_id JOIN objects o ON o.id = f.object_id WHERE f.is_current = 1 AND o.deleted_at IS NULL`);
  const missing = rows.filter((f) => !fileExists(f.storage_key));
  const noCode = all(`SELECT o.id, o.name, o.public_id FROM objects o WHERE o.deleted_at IS NULL AND o.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM object_codes k WHERE k.object_id = o.id)`);
  return { missing_files: missing.map(({ storage_key: _k, ...f }) => f), without_codes: noCode, checked: rows.length };
}

// ------------------------------------------------------------------ public view
/**
 * The payload behind a scan. Private fields and files never leave the server, and the
 * object is resolved by public_id so the printed code keeps working whatever changes.
 */
export function publicView(object, { baseUrl } = {}) {
  const fields = (parseJson(object.custom_fields, []) || []).filter((f) => f.public !== false && f.value !== null && f.value !== '' && f.value !== undefined);
  const files = objectFiles(object.id, { includePrivate: false }).map((f) => ({
    id: f.id, title: f.title, description: f.description, name: f.original_name, mime: f.mime, size: f.size, uploaded_at: f.uploaded_at, version_no: f.version_no,
  }));
  return {
    public_id: object.public_id,
    name: object.name,
    description: object.description,
    category: object.category_name || null,
    location: object.location,
    owner: object.owner_name,
    serial_number: object.serial_number,
    image: object.image_attachment_id || null,
    fields: fields.map(({ key, label, type, value }) => ({ key, label, type, value })),
    files,
    single_file_direct: Boolean(object.single_file_direct) && files.length === 1,
    updated_at: object.show_updated ? object.updated_at : null,
    url: publicUrlFor(object.public_id, baseUrl),
    status: object.status,
  };
}
