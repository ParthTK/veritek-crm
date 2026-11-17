// Attachments: authenticated uploads, access-checked short-lived download links, safe downloads.
import { Router } from 'express';
import { get } from '../db.js';
import { intId, forbidden, notFound, badRequest } from '../util.js';
import { allow, publicUser } from '../auth.js';
import {
  storeAttachment, assertEntityVisible, canAccessAttachment, signedFileUrl, verifyFileSignature, readAttachmentFile, linkAttachment,
} from '../services/attachments.js';
import { h, rawBody } from './helpers.js';

export const publicFiles = Router();
const r = Router();

r.post('/attachments', allow('attachments.upload'), rawBody, h((req) => {
  const entityType = req.query.entity_type || null;
  const entityId = intId(req.query.entity_id);
  if (entityType) assertEntityVisible(req.user, entityType, entityId);
  if (!Buffer.isBuffer(req.body)) throw badRequest('Send the file as the request body');
  const a = storeAttachment({ buffer: req.body, name: req.query.name, entityType, entityId, description: req.query.description, visibility: req.query.visibility === 'finance' ? 'finance' : 'internal' }, req.user);
  return { id: a.id, original_name: a.original_name, size: a.size, mime: a.mime, reused: a.reused };
}, 201));

r.post('/attachments/:id/link', allow('attachments.upload'), h((req) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', intId(req.params.id));
  if (!a || !canAccessAttachment(req.user, a)) throw notFound('Document');
  assertEntityVisible(req.user, req.body?.entity_type, intId(req.body?.entity_id));
  linkAttachment(a.id, req.body.entity_type, intId(req.body.entity_id), req.user);
  return { ok: true };
}));

/** Returns a 5-minute link bound to this user; the server re-checks access when it is used. */
r.get('/attachments/:id/url', h((req) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', intId(req.params.id));
  if (!a) throw notFound('Document');
  if (!canAccessAttachment(req.user, a)) throw forbidden('This document is outside your access');
  return { url: signedFileUrl(a.id, req.user.id) };
}));

publicFiles.get('/files/:id', (req, res, next) => {
  try {
    const id = intId(req.params.id);
    const userId = intId(req.query.u);
    if (!verifyFileSignature(id, userId, req.query.exp, req.query.sig)) throw forbidden('This download link has expired. Open the document again from the record.');
    const u = get('SELECT * FROM users WHERE id = ? AND active = 1 AND login_enabled = 1', userId);
    if (!u) throw forbidden();
    const user = publicUser(u);
    const a = get('SELECT * FROM attachments WHERE id = ?', id);
    if (!a) throw notFound('Document');
    if (!canAccessAttachment(user, a)) throw forbidden('This document is outside your access');
    const data = readAttachmentFile(a);
    const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(a.mime) && req.query.download !== '1';
    res.set('Content-Type', a.mime || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
    res.send(data);
  } catch (err) {
    next(err);
  }
});

export default r;
