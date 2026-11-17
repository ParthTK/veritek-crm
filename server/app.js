// The Express app. `server/index.js` runs it as a normal server; `api/index.js` exports it as a
// serverless function for the demo deployment.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { migrate, val, insert, ROOT } from './db.js';
import { HttpError, context, token, nowIso } from './util.js';
import { requireAuth } from './auth.js';
import { ensureDropdownDefaults } from './services/admin.js';

import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import customerRoutes from './routes/customers.js';
import enquiryRoutes from './routes/enquiries.js';
import taskRoutes from './routes/tasks.js';
import orderRoutes from './routes/orders.js';
import workRoutes from './routes/work.js';
import fileRoutes, { publicFiles } from './routes/files.js';
import adminRoutes from './routes/admin.js';
import financeRoutes from './routes/finance.js';
import complaintRoutes from './routes/complaints.js';
import productRoutes from './routes/products.js';
import quotationRoutes from './routes/quotations.js';
import campaignRoutes from './routes/campaigns.js';
import objectRoutes from './routes/objects.js';
import publicRoutes from './routes/public.js';

migrate();
ensureDropdownDefaults();
if (!val('SELECT COUNT(*) FROM users') && process.env.CRM_NO_DEMO !== '1') {
  console.log('Empty database: loading demo data…');
  const { seed } = await import('./seed.js');
  seed();
} else if (!val('SELECT COUNT(*) FROM users')) {
  const { bootstrapAdmin } = await import('./seed.js');
  bootstrapAdmin();
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  req.id = token(9);
  res.set('X-Request-Id', req.id);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  context.run({ requestId: req.id, source: 'web', ip: req.ip }, next);
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const json = express.json({ limit: '2mb' });
const jsonUnlessUpload = (req, res, next) => (/^\/api\/(attachments|imports\/upload)/.test(req.originalUrl) && req.method === 'POST' ? next() : json(req, res, next));
app.use(jsonUnlessUpload);

app.use('/api', authRoutes);
app.use('/api', publicFiles);
app.use('/api/public', publicRoutes);

const api = express.Router();
api.use(requireAuth);
api.use((req, _res, next) => context.run({ ...context.getStore(), userId: req.user.id }, next));
// Read-only management can never change anything, whatever route is called.
api.use((req, _res, next) => {
  if (req.user.group === 'viewer' && req.method !== 'GET' && !/^\/(notifications\/read|pins)/.test(req.path)) {
    return next(new HttpError(403, 'Read-only access: this account cannot change records'));
  }
  next();
});
for (const r of [metaRoutes, customerRoutes, enquiryRoutes, taskRoutes, orderRoutes, workRoutes, fileRoutes, quotationRoutes, financeRoutes, complaintRoutes, productRoutes, campaignRoutes, objectRoutes, adminRoutes]) api.use(r);
app.use('/api', api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API route not found')));

// The built client (single-process deployments). On serverless hosting the CDN serves it.
const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large (max 20 MB)' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read' });
  const msg = String(err?.message || '');
  if (/UNIQUE constraint failed/.test(msg)) return res.status(409).json({ error: 'This record already exists (duplicate value)' });
  if (/CHECK constraint failed/.test(msg)) return res.status(409).json({ error: 'This change would break a quantity rule (for example a negative remaining balance) and was rejected' });
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  try {
    insert('error_log', { at: nowIso(), method: req.method, path: req.originalUrl.slice(0, 300), message: msg.slice(0, 1000), stack: err?.stack?.slice(0, 4000), user_id: req.user?.id ?? null, request_id: req.id });
  } catch {
    /* logging must never mask the original error */
  }
  res.status(500).json({ error: 'Something went wrong. Nothing was saved. The error has been logged — please try again.', request_id: req.id });
});

export default app;
