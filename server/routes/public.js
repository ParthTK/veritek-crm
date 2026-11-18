// Links that work without signing in: the customer's quotation (view / accept / ask for a revision), order
// tracking, and the scan pages behind object QR codes. Each link is a long random token or a permanent
// object id; nothing internal (costs, margins, notes) is ever returned.
import { Router } from 'express';
import crypto from 'node:crypto';
import { get } from '../db.js';
import { HttpError, notFound, settings, installSecret } from '../util.js';
import { h } from './helpers.js';
import { portalQuotation, portalRespond } from '../services/quotes.js';
import { orderTracking } from '../services/orders.js';
import {
  checkObjectPassword, publicView, recordScan, objectFiles, objectSettings, fileData,
} from '../services/objects.js';
import { xlsxToSheets, docxToBlocks, csvToRows, previewKind } from '../lib/docpreview.js';

const r = Router();

// Simple per-IP rate limit for public links.
const hits = new Map();
r.use((req, _res, next) => {
  const t = Date.now();
  const list = (hits.get(req.ip) || []).filter((x) => t - x < 60000);
  if (list.length > 90) return next(new HttpError(429, 'Too many requests — please wait a minute'));
  list.push(t);
  hits.set(req.ip, list);
  if (hits.size > 5000) hits.clear();
  next();
});

const publicUser = { values_access: true, permissions: [] };
const pub = (fn) => (req, res, next) => {
  req.user = publicUser;
  return h(fn)(req, res, next);
};

// ------------------------------------------------------------------ quotation link
r.get('/quotations/:token', pub((req) => portalQuotation(req.params.token)));
r.post('/quotations/:token/respond', pub((req) => portalRespond(req.params.token, req.body || {})));

// ------------------------------------------------------------------ order tracking
r.get('/orders/:token', pub((req) => orderTracking(req.params.token)));

// ------------------------------------------------------------------ object scanning
/** Short-lived proof that a visitor entered the right password for this object. */
const unlockSecret = () => `object-unlock:${installSecret()}`;
const unlockToken = (objectId) => {
  const expires = Date.now() + 2 * 60 * 60 * 1000;
  const payload = `${objectId}.${expires}`;
  return `${payload}.${crypto.createHmac('sha256', unlockSecret()).update(payload).digest('base64url')}`;
};
function unlockValid(objectId, value) {
  const [oid, expires, signature] = String(value || '').split('.');
  if (Number(oid) !== Number(objectId) || !expires || Number(expires) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', unlockSecret()).update(`${oid}.${expires}`).digest('base64url');
  return expected.length === signature?.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function loadPublicObject(publicId) {
  return get(`SELECT o.*, c.name AS category_name FROM objects o LEFT JOIN object_categories c ON c.id = o.category_id WHERE o.public_id = ?`,
    String(publicId || '').toUpperCase());
}

const brandingFor = () => {
  const company = settings().company;
  return { name: company.name, phone: company.phone, email: company.email, website: company.website, color: objectSettings().brandColor };
};
const baseUrl = (req) => (objectSettings().publicBaseUrl || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** The scan endpoint: resolves a permanent id to whatever the object holds today. */
r.get('/objects/:publicId', (req, res, next) => {
  try {
    const o = loadPublicObject(req.params.publicId);
    if (!o || o.deleted_at) return res.status(404).json({ error: 'This code is not in use.', state: 'unknown', branding: brandingFor() });
    const branding = brandingFor();
    recordScan(o.id, req, req.query.src || 'qr');
    if (o.status === 'archived') return res.json({ state: 'archived', name: o.name, message: o.archive_note || objectSettings().archivedMessage, branding });
    if (o.visibility === 'private') return res.json({ state: 'private', name: o.name, branding });
    if (o.visibility === 'password' && !unlockValid(o.id, req.query.unlock)) return res.json({ state: 'locked', name: o.name, branding });
    return res.json({ state: 'ok', branding, object: publicView(o, { baseUrl: baseUrl(req) }) });
  } catch (err) {
    return next(err);
  }
});

r.post('/objects/:publicId/unlock', (req, res, next) => {
  try {
    const o = loadPublicObject(req.params.publicId);
    if (!o || o.deleted_at || o.visibility !== 'password') throw notFound('Object');
    if (!checkObjectPassword(o, req.body?.password)) throw new HttpError(401, 'That password does not match');
    res.json({ unlock: unlockToken(o.id), branding: brandingFor(), object: publicView(o, { baseUrl: baseUrl(req) }) });
  } catch (err) {
    next(err);
  }
});

/** Files are only reachable through their object, and only when that object allows it. */
function publicFile(req) {
  const o = loadPublicObject(req.params.publicId);
  if (!o || o.deleted_at || o.status === 'archived') throw notFound('Object');
  if (o.visibility === 'private') throw new HttpError(403, 'This object is private');
  if (o.visibility === 'password' && !unlockValid(o.id, req.query.unlock)) throw new HttpError(401, 'Password required');
  const file = objectFiles(o.id, { includePrivate: false }).find((f) => f.id === Number(req.params.fileId));
  if (!file) throw notFound('Document');
  const data = fileData(file);
  if (!data) throw notFound('Document');
  return { object: o, file, data };
}

/** The object's own photo, shown at the top of the scan page. */
r.get('/objects/:publicId/image', (req, res, next) => {
  try {
    const o = loadPublicObject(req.params.publicId);
    if (!o || o.deleted_at || !o.image_attachment_id) throw notFound('Image');
    if (o.visibility === 'private') throw new HttpError(403, 'This object is private');
    if (o.visibility === 'password' && !unlockValid(o.id, req.query.unlock)) throw new HttpError(401, 'Password required');
    const a = get('SELECT * FROM attachments WHERE id = ?', o.image_attachment_id);
    const data = a && /^image\//.test(a.mime || '') ? fileData(a) : null;
    if (!data) throw notFound('Image');
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  } catch (err) {
    next(err);
  }
});

r.get('/objects/:publicId/files/:fileId/raw', (req, res, next) => {
  try {
    const { file, data } = publicFile(req);
    const inline = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(file.mime || '') && !req.query.download;
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(data);
  } catch (err) {
    next(err);
  }
});

/** Parsed content for documents the browser cannot display itself (Excel, Word, CSV, text). */
r.get('/objects/:publicId/files/:fileId/preview', (req, res, next) => {
  try {
    const { file, data } = publicFile(req);
    const kind = previewKind(file.mime, file.original_name);
    try {
      if (kind === 'sheet') return res.json({ kind, sheets: xlsxToSheets(data) });
      if (kind === 'csv') return res.json({ kind, sheets: [{ name: file.original_name, rows: csvToRows(data.toString('utf8')) }] });
      if (kind === 'doc') return res.json({ kind, ...docxToBlocks(data) });
      if (kind === 'text') return res.json({ kind, text: data.toString('utf8').slice(0, 100000) });
    } catch (err) {
      return res.json({ kind: 'download', error: err.message });
    }
    return res.json({ kind });
  } catch (err) {
    return next(err);
  }
});

export default r;
