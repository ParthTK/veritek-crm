// Private document storage: random storage keys (never user-controlled paths), type allow-list with
// content sniffing, size limits, checksums, reuse by reference and short-lived signed download links.
import crypto from 'node:crypto';
import path from 'node:path';
import { all, get, insert, run } from '../db.js';
import { putFile, getFile } from '../storage.js';
import { badRequest, forbidden, notFound, nowIso, sha256, token, audit, installSecret } from '../util.js';
import { assertCustomer, assertEnquiry, assertOrder } from '../access.js';
import { hasPerm } from '../auth.js';

export const MAX_BYTES = 20 * 1024 * 1024;

const TYPES = {
  pdf: { mime: 'application/pdf', magic: 'pdf' },
  png: { mime: 'image/png', magic: 'png' },
  jpg: { mime: 'image/jpeg', magic: 'jpg' },
  jpeg: { mime: 'image/jpeg', magic: 'jpg' },
  gif: { mime: 'image/gif', magic: 'gif' },
  webp: { mime: 'image/webp', magic: 'webp' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
  doc: { mime: 'application/msword', magic: 'ole' },
  xls: { mime: 'application/vnd.ms-excel', magic: 'ole' },
  msg: { mime: 'application/vnd.ms-outlook', magic: 'ole' },
  csv: { mime: 'text/csv', magic: 'text' },
  txt: { mime: 'text/plain', magic: 'text' },
  eml: { mime: 'message/rfc822', magic: 'text' },
  // Short videos for object scan pages (installation guides, demos).
  mp4: { mime: 'video/mp4', magic: 'mp4' },
  mov: { mime: 'video/quicktime', magic: 'mp4' },
  webm: { mime: 'video/webm', magic: 'webm' },
};
export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

function sniff(buf) {
  const head = buf.subarray(0, 8);
  if (head.toString('latin1', 0, 4) === '%PDF') return 'pdf';
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head.readUInt32BE(0) === 0xd0cf11e0) return 'ole';
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (head[0] === 0x4d && head[1] === 0x5a) return 'executable';
  if (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return 'executable';
  if (head.toString('latin1', 0, 2) === '#!') return 'executable';
  if (!buf.subarray(0, 4096).includes(0)) return 'text';
  return 'binary';
}

export function safeName(name) {
  const base = path.basename(String(name || 'document')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').trim();
  return (base || 'document').slice(-120);
}

/** Checks a file and returns its normalised type. Throws a 400 explaining what is allowed. */
export function checkFile(buffer, name) {
  if (!buffer?.length) throw badRequest('The file is empty');
  if (buffer.length > MAX_BYTES) throw badRequest('Files can be at most 20 MB');
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw badRequest(`This file type is not accepted. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  const found = sniff(buffer);
  if (found === 'executable') throw badRequest('Executable or script content is not accepted');
  if (found !== type.magic) throw badRequest(`The file content does not look like a .${ext} file`);
  if (type.magic === 'text' && /<script|<html|<svg/i.test(buffer.subarray(0, 4096).toString('utf8'))) {
    throw badRequest('Files containing HTML or script content are not accepted');
  }
  return { ext, mime: type.mime };
}

const ENTITY_TABLES = {
  customer: 'customers', enquiry: 'enquiries', quote_revision: 'quote_revisions', order: 'orders', order_line: 'order_lines',
  dispatch: 'dispatches', activity: 'activities', complaint: 'complaints', invoice: 'invoices', task: 'tasks', reactivation: 'reactivation_cases',
  payment_hold: 'payment_holds', import: 'import_batches', product: 'products', object: 'objects', campaign: 'campaigns',
};

/** The customer an entity belongs to (for scoping and de-duplication). */
export function customerOf(entityType, entityId) {
  switch (entityType) {
    case 'customer': return entityId;
    case 'quote_revision': return get('SELECT q.customer_id FROM quote_revisions r JOIN quotations q ON q.id = r.quotation_id WHERE r.id = ?', entityId)?.customer_id ?? null;
    case 'order_line': return get('SELECT o.customer_id FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ?', entityId)?.customer_id ?? null;
    case 'import':
    case 'product':
    case 'campaign':
      return null;
    default: {
      const table = ENTITY_TABLES[entityType];
      if (!table) return null;
      return get(`SELECT customer_id FROM ${table} WHERE id = ?`, entityId)?.customer_id ?? null;
    }
  }
}

/** Throws unless the user can see the entity a document is attached to. */
export function assertEntityVisible(user, entityType, entityId) {
  const table = ENTITY_TABLES[entityType];
  if (!table) throw badRequest('Unknown record type');
  if (!get(`SELECT id FROM ${table} WHERE id = ?`, entityId)) throw notFound('Linked record');
  if (entityType === 'import') {
    if (!hasPerm(user, 'imports.run')) throw forbidden();
    return;
  }
  if (entityType === 'invoice' && !hasPerm(user, 'finance.view')) throw forbidden();
  if (entityType === 'product') {
    if (!hasPerm(user, 'products.view')) throw forbidden();
    return;
  }
  if (entityType === 'object') {
    if (!hasPerm(user, 'objects.view')) throw forbidden();
    return;
  }
  if (entityType === 'campaign') {
    if (!hasPerm(user, 'campaigns.view')) throw forbidden();
    return;
  }
  if (entityType === 'enquiry') return assertEnquiry(user, entityId);
  if (entityType === 'order') return assertOrder(user, entityId);
  if (entityType === 'order_line') return assertOrder(user, get('SELECT order_id FROM order_lines WHERE id = ?', entityId).order_id);
  if (entityType === 'dispatch') {
    const orderIds = all('SELECT DISTINCT order_id FROM dispatch_lines WHERE dispatch_id = ?', entityId).map((r) => r.order_id);
    for (const oid of orderIds) assertOrder(user, oid);
    return;
  }
  const cid = customerOf(entityType, entityId);
  if (cid) {
    if (user.group === 'production') {
      if (!get("SELECT id FROM orders WHERE customer_id = ? AND status = 'confirmed' LIMIT 1", cid)) throw forbidden();
      if (!['order', 'order_line', 'dispatch', 'complaint', 'activity'].includes(entityType)) throw forbidden('This document is outside your access');
      return;
    }
    assertCustomer(user, cid);
  }
}

export function storeAttachment({ buffer, name, entityType, entityId, description, visibility = 'internal' }, user) {
  const original = safeName(name);
  const { mime } = checkFile(buffer, original);
  const checksum = sha256(buffer);
  const customerId = entityType ? customerOf(entityType, entityId) : null;
  // Identical file already stored for this customer: reuse it by reference instead of a second copy.
  const existing = get('SELECT * FROM attachments WHERE checksum = ? AND customer_id IS ? LIMIT 1', checksum, customerId);
  let id = existing?.id;
  if (!id) {
    const storageKey = `${Date.now().toString(36)}-${token(12)}`;
    putFile(storageKey, buffer, { contentType: mime });
    id = insert('attachments', {
      storage_key: storageKey, original_name: original, mime, size: buffer.length, checksum, customer_id: customerId,
      visibility, scan_status: 'basic_checks_passed', description: description || null, uploaded_by: user.id, uploaded_at: nowIso(),
    });
    audit('attachment', id, 'upload', { name: original, size: buffer.length, checksum });
  }
  if (entityType) linkAttachment(id, entityType, entityId, user);
  return { ...get('SELECT * FROM attachments WHERE id = ?', id), reused: Boolean(existing) };
}

export function linkAttachment(attachmentId, entityType, entityId, user) {
  if (!attachmentId || !entityType || !entityId) return;
  run('INSERT INTO attachment_links (attachment_id, entity_type, entity_id, linked_by, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', attachmentId, entityType, entityId, user?.id ?? null, nowIso());
}

export function attachmentsFor(entityType, entityId) {
  return all(
    `SELECT a.id, a.original_name, a.mime, a.size, a.uploaded_at, a.description, a.visibility, u.name AS uploaded_by_name, l.entity_type, l.entity_id
     FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE l.entity_type = ? AND l.entity_id = ? ORDER BY a.uploaded_at DESC`,
    entityType, entityId,
  );
}

/** Whether the user may download this document: they must be able to see at least one linked record. */
export function canAccessAttachment(user, attachment) {
  if (attachment.visibility === 'finance' && !hasPerm(user, 'finance.view')) return false;
  const links = all('SELECT entity_type, entity_id FROM attachment_links WHERE attachment_id = ?', attachment.id);
  if (!links.length) return attachment.uploaded_by === user.id;
  return links.some((l) => {
    try {
      assertEntityVisible(user, l.entity_type, l.entity_id);
      return true;
    } catch {
      return false;
    }
  });
}

// Kept in the database, so links stay valid across restarts and instances, unlike a per-process random key.
const fileSecret = () => process.env.CRM_FILE_SECRET || `files:${installSecret()}`;
const fileSig = (id, userId, exp) => crypto.createHmac('sha256', fileSecret()).update(`${id}.${userId}.${exp}`).digest('base64url');

/** A short-lived link bound to one user, so tokens never appear in URLs or browser history. */
export function signedFileUrl(attachmentId, userId, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/files/${attachmentId}?u=${userId}&exp=${exp}&sig=${fileSig(attachmentId, userId, exp)}`;
}

export function verifyFileSignature(id, userId, exp, sig) {
  if (!id || !userId || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(fileSig(id, userId, exp));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function readAttachmentFile(attachment) {
  const data = getFile(attachment.storage_key);
  if (!data) throw notFound('Stored file');
  return data;
}
