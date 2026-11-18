// Objects & QR codes (signed-in users). Public scan pages are served by routes/public.js.
import { Router } from 'express';
import { all, get, run, insert, update, tx } from '../db.js';
import { allow, hasPerm } from '../auth.js';
import { OBJECT_VISIBILITY } from '../../shared/constants.js';
import {
  badRequest, notFound, nowIso, paginate, str, intId, parseJson, audit, settings,
} from '../util.js';
import {
  createObject, updateObject, archiveObject, deleteObject, duplicateObject, attachFile, updateFile, removeFile,
  reorderFiles, restoreFileVersion, objectFiles, ensureCode, scanStats, publicUrlFor, normalizeFields, objectHealth, objectSettings, fileData,
} from '../services/objects.js';
import { qrPng, qrSvg, barcodePng, barcodeSvg, zipFiles } from '../lib/codes.js';
import { xlsxToSheets, csvToRows } from '../lib/docpreview.js';
import { signedFileUrl } from '../services/attachments.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

/** The origin QR codes point at: an explicit setting wins, otherwise the current request. */
export function baseUrlFor(req) {
  const configured = str(objectSettings().publicBaseUrl, 300);
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

const SELECT = `
  SELECT o.*, c.name AS category_name, u.name AS created_by_name,
         cu.company_name AS customer_name, p.code AS product_code, p.name AS product_name, so.code AS order_code,
         (SELECT COUNT(*) FROM object_files f WHERE f.object_id = o.id AND f.is_current = 1) AS file_count,
         (SELECT COUNT(*) FROM object_codes k WHERE k.object_id = o.id) AS code_count
  FROM objects o
  LEFT JOIN object_categories c ON c.id = o.category_id
  LEFT JOIN users u ON u.id = o.created_by
  LEFT JOIN customers cu ON cu.id = o.customer_id
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN orders so ON so.id = o.order_id`;

const clean = (o) => ({ ...o, custom_fields: parseJson(o.custom_fields, []), password_hash: undefined, has_password: Boolean(o.password_hash) });

// ------------------------------------------------------------------ list & stats
r.get('/objects', allow('objects.view'), h((req) => {
  const q = req.query;
  const w = ['o.deleted_at IS NULL'];
  const p = [];
  if (q.q) {
    w.push('(o.name LIKE ? OR o.public_id LIKE ? OR o.description LIKE ? OR o.serial_number LIKE ? OR o.location LIKE ?)');
    p.push(...Array(5).fill(`%${String(q.q).trim()}%`));
  }
  for (const key of ['category_id', 'customer_id', 'product_id', 'order_id']) {
    if (intId(q[key])) {
      w.push(`o.${key} = ?`);
      p.push(intId(q[key]));
    }
  }
  if (q.visibility && OBJECT_VISIBILITY.some((v) => v.value === q.visibility)) {
    w.push('o.visibility = ?');
    p.push(q.visibility);
  }
  w.push(q.status === 'archived' ? "o.status = 'archived'" : q.status === 'all' ? '1 = 1' : "o.status = 'active'");
  if (q.has_code === '1') w.push('EXISTS (SELECT 1 FROM object_codes k WHERE k.object_id = o.id)');
  if (q.no_files === '1') w.push('NOT EXISTS (SELECT 1 FROM object_files f WHERE f.object_id = o.id AND f.is_current = 1)');
  const where = `WHERE ${w.join(' AND ')}`;
  const sorts = { name: 'o.name', created: 'o.created_at', updated: 'o.updated_at', scans: 'o.scan_count', files: 'file_count', id: 'o.public_id' };
  const col = sorts[q.sort] || 'o.updated_at';
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const { limit, offset } = paginate(q);
  const rows = all(`${SELECT} ${where} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const count = get(`SELECT COUNT(*) AS n FROM objects o ${where}`, ...p).n;
  return { rows: rows.map(clean).map((o) => ({ ...o, image_url: o.image_attachment_id ? signedFileUrl(o.image_attachment_id, req.user.id, 3600) : null })), count };
}));

r.get('/objects/stats', allow('objects.view'), h(() => {
  const base = get(`SELECT COUNT(*) AS objects, COALESCE(SUM(scan_count), 0) AS scans,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived, SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END) AS public_objects
    FROM objects WHERE deleted_at IS NULL`);
  const codes = get('SELECT COUNT(*) AS n FROM object_codes').n;
  const storage = get(`SELECT COALESCE(SUM(a.size), 0) AS bytes, COUNT(*) AS files FROM attachments a
    WHERE a.id IN (SELECT attachment_id FROM attachment_links WHERE entity_type = 'object')`);
  const today = new Date().toISOString().slice(0, 10);
  const scansToday = get('SELECT COUNT(*) AS n FROM scan_events WHERE substr(scanned_at, 1, 10) = ?', today).n;
  const recent = all(`${SELECT} WHERE o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 5`).map(clean);
  const updated = all(`${SELECT} WHERE o.deleted_at IS NULL AND o.updated_at IS NOT NULL ORDER BY o.updated_at DESC LIMIT 5`).map(clean);
  const scanSeries = all(`SELECT substr(scanned_at, 1, 10) AS day, COUNT(*) AS scans FROM scan_events WHERE substr(scanned_at, 1, 10) >= ? GROUP BY 1 ORDER BY 1`,
    new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ day: d, scans: scanSeries.find((x) => x.day === d)?.scans || 0 });
  }
  return { ...base, codes, ...storage, scans_today: scansToday, recent, updated, series };
}));

r.get('/objects/health', allow('objects.view'), h(() => objectHealth()));

// Settings used by labels (registered before /objects/:id).
r.get('/objects/settings', allow('objects.view'), h((req) => ({
  ...objectSettings(), company_name: settings().company.name, base_url: baseUrlFor(req), can_manage: hasPerm(req.user, 'objects.manage'),
})));

// ------------------------------------------------------------------ bulk codes
r.get('/objects/codes.zip', allow('objects.view'), (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 500);
    if (!ids.length) throw badRequest('Select at least one object');
    const type = req.query.type === 'barcode' ? 'barcode' : 'qr';
    const format = req.query.format === 'svg' ? 'svg' : 'png';
    const base = baseUrlFor(req);
    const entries = [];
    for (const oid of ids) {
      const o = get('SELECT * FROM objects WHERE id = ? AND deleted_at IS NULL', oid);
      if (!o) continue;
      const code = ensureCode(o.id, type, base, req.user);
      const safe = `${o.public_id}-${o.name.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'object'}`;
      const data = format === 'svg'
        ? Buffer.from(type === 'qr' ? qrSvg(code.payload) : barcodeSvg(code.payload))
        : (type === 'qr' ? qrPng(code.payload) : barcodePng(code.payload));
      entries.push({ name: `${safe}.${format}`, data });
    }
    if (!entries.length) throw notFound('Objects');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="codes-${type}-${entries.length}.zip"`);
    res.send(zipFiles(entries));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ single object
r.post('/objects', allow('objects.edit'), h((req) => ({ id: createObject(req.body || {}, req.user) }), 201));

r.get('/objects/:id', allow('objects.view'), h((req) => {
  const o = get(`${SELECT} WHERE o.id = ?`, id(req));
  if (!o || o.deleted_at) throw notFound('Object');
  const versions = all(`SELECT f.*, a.original_name, a.mime, a.size, u.name AS uploaded_by_name FROM object_files f
    JOIN attachments a ON a.id = f.attachment_id LEFT JOIN users u ON u.id = f.uploaded_by
    WHERE f.object_id = ? AND f.is_current = 0 ORDER BY f.version_group, f.version_no DESC`, o.id);
  const activity = all(`SELECT a.id, a.action, a.changes, a.created_at, u.name AS user_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'object' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 60`, o.id).map((x) => ({ ...x, details: parseJson(x.changes, {}) }));
  return {
    ...clean(o),
    image_url: o.image_attachment_id ? signedFileUrl(o.image_attachment_id, req.user.id, 3600) : null,
    files: objectFiles(o.id).map(({ storage_key: _k, ...f }) => ({ ...f, url: signedFileUrl(f.attachment_id, req.user.id, 3600) })),
    field_file_urls: Object.fromEntries(parseJson(o.custom_fields, []).filter((f) => f.type === 'file' && intId(f.value)).map((f) => [f.value, signedFileUrl(intId(f.value), req.user.id, 3600)])),
    versions: versions.map((v) => ({ ...v, url: signedFileUrl(v.attachment_id, req.user.id, 3600) })),
    codes: all('SELECT * FROM object_codes WHERE object_id = ?', o.id),
    activity,
    scans: scanStats(o.id),
    public_url: publicUrlFor(o.public_id, baseUrlFor(req)),
  };
}));

r.put('/objects/:id', allow('objects.edit'), h((req) => {
  updateObject(id(req), req.body || {}, req.user);
  return { ok: true };
}));

r.post('/objects/:id/archive', allow('objects.edit'), h((req) => {
  archiveObject(id(req), req.body?.archived !== false, req.body?.note);
  return { ok: true };
}));

r.delete('/objects/:id', allow('objects.manage'), h((req) => {
  deleteObject(id(req));
  return { ok: true };
}));

r.post('/objects/:id/duplicate', allow('objects.edit'), h((req) => ({ id: duplicateObject(id(req), req.user, req.body || {}) }), 201));

// ------------------------------------------------------------------ files
r.post('/objects/:id/files', allow('objects.edit'), h((req) => ({ id: attachFile(id(req), req.body || {}, req.user) }), 201));
r.put('/objects/:id/files/:fileId', allow('objects.edit'), h((req) => {
  updateFile(id(req), intId(req.params.fileId), req.body || {});
  return { ok: true };
}));
r.delete('/objects/:id/files/:fileId', allow('objects.edit'), h((req) => {
  removeFile(id(req), intId(req.params.fileId));
  return { ok: true };
}));
r.post('/objects/:id/files/reorder', allow('objects.edit'), h((req) => {
  reorderFiles(id(req), (req.body?.order || []).map(Number).filter(Boolean));
  return { ok: true };
}));
r.post('/objects/:id/files/:fileId/restore', allow('objects.edit'), h((req) => {
  restoreFileVersion(id(req), intId(req.params.fileId), req.user);
  return { ok: true };
}));

// ------------------------------------------------------------------ codes
r.post('/objects/:id/code', allow('objects.edit'), h((req) => ensureCode(id(req), req.body?.code_type === 'barcode' ? 'barcode' : 'qr', baseUrlFor(req), req.user), 201));

r.get('/objects/:id/code.:format', allow('objects.view'), (req, res, next) => {
  try {
    const type = req.query.type === 'barcode' ? 'barcode' : 'qr';
    const object = get('SELECT public_id, name FROM objects WHERE id = ? AND deleted_at IS NULL', id(req));
    if (!object) throw notFound('Object');
    const code = ensureCode(id(req), type, baseUrlFor(req), req.user);
    const scale = Math.min(20, Math.max(2, Number(req.query.scale) || (type === 'qr' ? 10 : 3)));
    const download = req.query.download ? 'attachment; ' : '';
    const filename = `${object.public_id}-${type}.${req.params.format}`;
    if (req.params.format === 'svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `${download}filename="${filename}"`);
      return res.send(type === 'qr' ? qrSvg(code.payload, { scale }) : barcodeSvg(code.payload, { scale }));
    }
    if (req.params.format !== 'png') throw badRequest('Supported formats are png and svg');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `${download}filename="${filename}"`);
    return res.send(type === 'qr' ? qrPng(code.payload, { scale }) : barcodePng(code.payload, { scale }));
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------------------ categories & templates
r.get('/object-categories', allow('objects.view'), h(() => all(`SELECT c.*, (SELECT COUNT(*) FROM objects o WHERE o.category_id = c.id AND o.deleted_at IS NULL) AS object_count
  FROM object_categories c ORDER BY c.name`).map((c) => ({ ...c, field_template: parseJson(c.field_template, []) }))));

r.post('/object-categories', allow('objects.edit'), h((req) => {
  if (!str(req.body?.name)) throw badRequest('Give the category a name', { name: 'Required' });
  if (get('SELECT id FROM object_categories WHERE name = ? COLLATE NOCASE', str(req.body.name, 120))) throw badRequest('A category with this name exists', { name: 'Already used' });
  const cid = insert('object_categories', {
    name: str(req.body.name, 120), description: str(req.body.description, 500),
    field_template: JSON.stringify(normalizeFields(req.body.field_template || []).map(({ value: _v, ...f }) => f)),
    created_by: req.user.id, created_at: nowIso(),
  });
  audit('object_category', cid, 'create', { name: req.body.name });
  return { id: cid };
}, 201));

r.put('/object-categories/:id', allow('objects.edit'), h((req) => {
  if (!get('SELECT id FROM object_categories WHERE id = ?', id(req))) throw notFound('Category');
  update('object_categories', id(req), {
    name: str(req.body?.name, 120), description: str(req.body?.description, 500),
    field_template: JSON.stringify(normalizeFields(req.body?.field_template || []).map(({ value: _v, ...f }) => f)),
  });
  audit('object_category', id(req), 'update', { name: req.body?.name });
  return { ok: true };
}));

r.delete('/object-categories/:id', allow('objects.manage'), h((req) => {
  if (get('SELECT 1 AS x FROM objects WHERE category_id = ? AND deleted_at IS NULL', id(req))) throw badRequest('Objects still use this category');
  run('DELETE FROM object_categories WHERE id = ?', id(req));
  audit('object_category', id(req), 'delete', {});
  return { ok: true };
}));

// ------------------------------------------------------------------ bulk import
/** Reads an uploaded spreadsheet and returns its columns and rows for mapping. */
function readImportFile(attachmentId) {
  const a = get('SELECT * FROM attachments WHERE id = ?', attachmentId);
  if (!a) throw badRequest('Upload the spreadsheet first');
  const buffer = fileData(a);
  if (!buffer) throw notFound('Uploaded file');
  const ext = a.original_name.toLowerCase().split('.').pop();
  const rows = ext === 'csv' || ext === 'txt' ? csvToRows(buffer.toString('utf8'), { maxRows: 2000, maxCols: 40 }) : xlsxToSheets(buffer, { maxRows: 2000, maxCols: 40 })[0]?.rows;
  if (!rows?.length) throw badRequest('The file has no rows');
  const header = rows[0].map((x) => String(x || '').trim());
  return { header, rows: rows.slice(1).filter((row) => row.some((c) => String(c ?? '').trim() !== '')) };
}

r.post('/objects/import/preview', allow('objects.edit'), h((req) => {
  const { header, rows } = readImportFile(intId(req.body?.attachment_id));
  return { header, sample: rows.slice(0, 8), total: rows.length };
}));

/**
 * Creates one object per row. `mapping` maps a built-in field to a column index; every other column
 * becomes a custom field named after its header, so any spreadsheet shape works.
 */
r.post('/objects/import', allow('objects.edit'), h((req) => {
  const body = req.body || {};
  const { header, rows } = readImportFile(intId(body.attachment_id));
  const mapping = body.mapping || {};
  const nameColumn = Number(mapping.name ?? header.findIndex((x) => /name|title|item|asset|machine/i.test(x)));
  if (!(nameColumn >= 0)) throw badRequest('Choose which column holds the object name');
  const builtIn = new Map(Object.entries(mapping).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [Number(v), k]));
  const categoryId = intId(body.category_id);
  const visibility = OBJECT_VISIBILITY.some((v) => v.value === body.visibility) ? body.visibility : 'public';
  const limit = Math.min(rows.length, 1000);
  const created = [];
  const errors = [];
  tx(() => {
    for (let i = 0; i < limit; i++) {
      const row = rows[i];
      const value = (col) => (col >= 0 ? String(row[col] ?? '').trim() : '');
      const name = value(nameColumn);
      if (!name) {
        errors.push({ row: i + 2, error: 'No object name' });
        continue;
      }
      const fields = header.map((label, col) => (builtIn.has(col) || col === nameColumn || !label.trim() || !value(col) ? null : { label, type: 'text', value: value(col) })).filter(Boolean);
      try {
        const oid = createObject({
          name,
          description: value(Number(mapping.description ?? -1)) || null,
          location: value(Number(mapping.location ?? -1)) || null,
          owner_name: value(Number(mapping.owner_name ?? -1)) || null,
          serial_number: value(Number(mapping.serial_number ?? -1)) || null,
          category_id: categoryId,
          visibility,
          custom_fields: fields,
        }, req.user);
        if (body.generate_codes !== false) ensureCode(oid, 'qr', baseUrlFor(req), req.user);
        created.push(get('SELECT id, public_id, name FROM objects WHERE id = ?', oid));
      } catch (err) {
        errors.push({ row: i + 2, error: err.message });
      }
    }
    audit('object', null, 'import', { created: created.length, errors: errors.length });
  });
  return { created, errors, skipped: rows.length - limit };
}, 201));

export default r;
