import express from 'express';
import { get, insert, tx } from '../db.js';
import { HttpError, nowIso, sha256 } from '../util.js';
import { redact } from '../access.js';

/** Wraps a synchronous handler: returns JSON (with commercial values redacted for the user) or passes errors on. */
export const h = (fn, status = 200) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (res.headersSent || out === undefined) return;
    res.status(status).json(redact(req.user || { values_access: true }, out));
  } catch (err) {
    next(err);
  }
};

/**
 * Safe retries: a POST carrying an Idempotency-Key returns the stored result when repeated, so a
 * double-click or a retried request never creates a second order, dispatch or import.
 */
export const idempotent = (route, fn) => (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key) return res.status(201).json(redact(req.user, fn(req)));
    const hash = sha256(JSON.stringify(req.body ?? {}));
    const prev = get('SELECT * FROM idempotency_keys WHERE key = ? AND user_id = ?', key, req.user.id);
    if (prev) {
      if (prev.route !== route || prev.request_hash !== hash) throw new HttpError(422, 'This request key was already used for a different request');
      res.set('Idempotent-Replay', 'true');
      return res.status(prev.status).json(redact(req.user, JSON.parse(prev.response)));
    }
    const out = tx(() => {
      const result = fn(req);
      insert('idempotency_keys', { key, user_id: req.user.id, route, request_hash: hash, status: 201, response: JSON.stringify(result), created_at: nowIso() });
      return result;
    });
    res.status(201).json(redact(req.user, out));
  } catch (err) {
    next(err);
  }
};

export const rawBody = express.raw({ type: () => true, limit: '21mb' });

export function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"`);
  res.send(csv);
}
