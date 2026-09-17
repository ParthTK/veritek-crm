// The Express app itself. `server/index.js` runs it as a normal server;
// `api/[...path].js` exports it as a Vercel serverless function.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate, val } from './db.js';
import { HttpError } from './util.js';
import { requireAuth } from './auth.js';

import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import metaRoutes from './routes/meta.js';
import dashboardRoutes from './routes/dashboard.js';
import leadRoutes from './routes/leads.js';
import customerRoutes from './routes/customers.js';
import followupRoutes from './routes/followups.js';
import quotationRoutes from './routes/quotations.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payments.js';
import productRoutes from './routes/products.js';
import campaignRoutes from './routes/campaigns.js';
import complaintRoutes from './routes/complaints.js';
import reportRoutes from './routes/reports.js';
import teamRoutes from './routes/team.js';
import settingsRoutes from './routes/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));

migrate();
if (!val('SELECT COUNT(*) FROM users')) {
  console.log('Empty database: loading demo data…');
  const { seed } = await import('./seed.js');
  seed();
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);

const api = express.Router();
api.use(requireAuth);
for (const r of [metaRoutes, dashboardRoutes, leadRoutes, customerRoutes, followupRoutes, quotationRoutes, orderRoutes,
  paymentRoutes, productRoutes, campaignRoutes, complaintRoutes, reportRoutes, teamRoutes, settingsRoutes]) {
  api.use(r);
}
app.use('/api', api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API route not found')));

// When running as a normal server we also serve the built client. On Vercel the
// static files are served by the CDN and this function only handles /api.
const dist = path.join(here, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (max 20 MB)' });
  if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed: (\w+)\.(\w+)/.test(err.message)) {
    const [, table, col] = err.message.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
    return res.status(409).json({ error: `A ${table.replace(/s$/, '')} with this ${col.replace(/_/g, ' ')} already exists` });
  }
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: 'Something went wrong. The error has been logged.' });
});

export default app;
