import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, insert, getSetting, UPLOAD_DIR, EPHEMERAL } from '../db.js';
import { DEFAULT_SETTINGS } from '../../shared/constants.js';
import { badRequest, notFound, nowIso, token } from '../util.js';
import { customerScope, leadScope, quotationScope, orderScope, complaintScope, redact } from '../access.js';

const r = Router();

r.get('/meta', (req, res) => {
  res.json({
    // True on serverless hosting, where the database is a per-instance copy of the demo snapshot.
    demo: EPHEMERAL,
    regions: all('SELECT * FROM regions ORDER BY name'),
    factories: all('SELECT * FROM factories ORDER BY name'),
    users: all('SELECT id, name, role, region_id, factory_id, designation, active FROM users ORDER BY active DESC, name'),
    categories: all('SELECT * FROM product_categories ORDER BY name'),
    campaigns: all('SELECT id, name, type, start_date, status FROM campaigns ORDER BY start_date DESC'),
    tags: all('SELECT t.*, (SELECT COUNT(*) FROM taggings tg WHERE tg.tag_id = t.id) AS uses FROM tags t ORDER BY t.name'),
    settings: {
      company: { ...DEFAULT_SETTINGS.company, ...getSetting('company', {}) },
      approvals: { ...DEFAULT_SETTINGS.approvals, ...getSetting('approvals', {}) },
      quotation: { ...DEFAULT_SETTINGS.quotation, ...getSetting('quotation', {}) },
      followups: { ...DEFAULT_SETTINGS.followups, ...getSetting('followups', {}) },
    },
    states: all("SELECT DISTINCT state FROM customers WHERE state IS NOT NULL ORDER BY state").map((s) => s.state),
  });
});

r.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const u = req.user;
  const and = (s) => (s ? `AND ${s}` : '');
  const results = [];
  for (const c of all(`SELECT c.id, c.name, c.code, c.city FROM customers c WHERE (c.name LIKE ? OR c.code LIKE ? OR c.gstin LIKE ?) ${and(customerScope(u, 'c'))} LIMIT 6`, like, like, like)) {
    results.push({ type: 'Customer', label: c.name, sub: [c.code, c.city].filter(Boolean).join(' · '), link: `/customers/${c.id}` });
  }
  for (const c of all(`SELECT ct.id, ct.name, ct.phone, ct.customer_id, c.name AS customer_name FROM contacts ct JOIN customers c ON c.id = ct.customer_id WHERE (ct.name LIKE ? OR ct.phone LIKE ? OR ct.email LIKE ?) ${and(customerScope(u, 'c'))} LIMIT 5`, like, like, like)) {
    results.push({ type: 'Contact', label: c.name, sub: `${c.customer_name}${c.phone ? ` · ${c.phone}` : ''}`, link: `/customers/${c.customer_id}` });
  }
  if (!['production', 'quality', 'dispatch', 'service', 'accounts'].includes(u.role)) {
    for (const l of all(`SELECT l.id, l.code, l.title, c.name AS customer_name FROM leads l JOIN customers c ON c.id = l.customer_id WHERE (l.title LIKE ? OR l.code LIKE ? OR c.name LIKE ?) ${and(leadScope(u, 'l'))} ORDER BY l.created_at DESC LIMIT 5`, like, like, like)) {
      results.push({ type: 'Lead', label: `${l.code} · ${l.title}`, sub: l.customer_name, link: `/leads/${l.id}` });
    }
  }
  if (!['production', 'quality', 'dispatch', 'service'].includes(u.role)) {
    for (const x of all(`SELECT q.id, q.number, q.subject, c.name AS customer_name FROM quotations q JOIN customers c ON c.id = q.customer_id WHERE (q.number LIKE ? OR q.subject LIKE ? OR c.name LIKE ?) ${and(quotationScope(u, 'q'))} ORDER BY q.created_at DESC LIMIT 5`, like, like, like)) {
      results.push({ type: 'Quotation', label: `${x.number} · ${x.subject || ''}`, sub: x.customer_name, link: `/quotations/${x.id}` });
    }
  }
  for (const o of all(`SELECT o.id, o.number, o.customer_po_number, c.name AS customer_name FROM sales_orders o JOIN customers c ON c.id = o.customer_id WHERE (o.number LIKE ? OR o.customer_po_number LIKE ? OR c.name LIKE ?) ${and(orderScope(u, 'o'))} ORDER BY o.created_at DESC LIMIT 5`, like, like, like)) {
    results.push({ type: 'Order', label: `${o.number} · PO ${o.customer_po_number || '-'}`, sub: o.customer_name, link: `/orders/${o.id}` });
  }
  for (const k of all(`SELECT k.id, k.number, k.serial_number, c.name AS customer_name FROM complaints k JOIN customers c ON c.id = k.customer_id WHERE (k.number LIKE ? OR k.serial_number LIKE ? OR c.name LIKE ?) ${and(complaintScope(u, 'k'))} LIMIT 4`, like, like, like)) {
    results.push({ type: 'Complaint', label: k.number, sub: `${k.customer_name}${k.serial_number ? ` · SN ${k.serial_number}` : ''}`, link: `/complaints/${k.id}` });
  }
  res.json(results);
});

// ------------------------------------------------------------------ notifications
r.get('/notifications', (req, res) => {
  const rows = all(
    `SELECT * FROM notifications WHERE user_id = ? ${req.query.unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`,
    req.user.id, Math.min(Number(req.query.limit) || 50, 200),
  );
  const unread = get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).n;
  res.json({ rows: redact(req.user, rows), unread });
});

r.post('/notifications/read', (req, res) => {
  if (Array.isArray(req.body.ids) && req.body.ids.length) {
    run(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${req.body.ids.map(() => '?').join(',')})`, nowIso(), req.user.id, ...req.body.ids);
  } else {
    run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------------ attachments (base64 JSON upload)
const ALLOWED = /^(image\/|video\/|audio\/|application\/pdf|application\/msword|application\/vnd\.|text\/plain|text\/csv|application\/zip)/;

r.post('/attachments', (req, res) => {
  const { name, mime, data, entity, entity_id, kind } = req.body;
  if (!name || !data) throw badRequest('No file received');
  const type = String(mime || 'application/octet-stream');
  if (!ALLOWED.test(type)) throw badRequest('This file type is not allowed');
  const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buffer.length > 20 * 1024 * 1024) throw badRequest('File is too large (max 20 MB)');
  const ext = path.extname(String(name)).slice(0, 10).replace(/[^.\w]/g, '');
  const fileName = `${Date.now()}-${token(9)}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
  const id = insert('attachments', {
    entity: entity || 'pending', entity_id: Number(entity_id) || 0, kind: kind || 'file', file_name: fileName,
    original_name: String(name).slice(0, 200), mime: type, size: buffer.length, uploaded_by: req.user.id, created_at: nowIso(),
  });
  res.status(201).json(get('SELECT id, entity, entity_id, kind, original_name, mime, size, created_at FROM attachments WHERE id = ?', id));
});

r.get('/attachments', (req, res) => {
  const { entity, entity_id } = req.query;
  if (!entity || !entity_id) throw badRequest('entity and entity_id are required');
  res.json(all(
    `SELECT a.id, a.entity, a.entity_id, a.kind, a.original_name, a.mime, a.size, a.created_at, u.name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.created_at DESC`,
    entity, entity_id,
  ));
});

r.get('/attachments/:id/file', (req, res) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', req.params.id);
  if (!a) throw notFound('File');
  const file = path.join(UPLOAD_DIR, path.basename(a.file_name));
  if (!fs.existsSync(file)) throw notFound('File');
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  const disposition = /^(image|video|audio)\/|application\/pdf/.test(a.mime) && !req.query.download ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(a.original_name)}"`);
  fs.createReadStream(file).pipe(res);
});

r.delete('/attachments/:id', (req, res) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', req.params.id);
  if (!a) throw notFound('File');
  if (a.uploaded_by !== req.user.id && !['super_admin', 'management'].includes(req.user.role)) throw badRequest('Only the uploader can delete this file');
  run('DELETE FROM attachments WHERE id = ?', a.id);
  fs.rmSync(path.join(UPLOAD_DIR, path.basename(a.file_name)), { force: true });
  res.json({ ok: true });
});

export default r;
