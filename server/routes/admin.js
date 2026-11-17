// Settings (restricted): users and access, dropdowns, rules, imports, audit, system health, backups and the
// full data export. Products, finance and complaints have their own routers.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, FILE_DIR } from '../db.js';
import { intId, now, tz } from '../util.js';
import { allow } from '../auth.js';
import {
  listUsers, createUser, updateUser, deactivateUser, reactivateUser, openWorkFor, getSettings, updateSettings, listDropdowns, addDropdown, updateDropdown, deleteDropdown,
  listAudit, systemHealth, listMasters, saveMaster, deleteMaster,
} from '../services/admin.js';
import { listSummaries } from '../services/alerts.js';
import { runEvaluator, startScheduler } from '../services/alerts.js';
import { createBackup, restoreTest, maybeScheduledBackup } from '../services/backup.js';
import {
  TEMPLATES, templateCsv, guideCsv, storeUpload, previewImport, commitImport, retryRows, batchDetail, batchLogCsv, listBatches, rollbackBatch, autoMap,
} from '../services/imports.js';
import { zipFiles, toCsv } from '../lib/files.js';
import { localDate } from '../../shared/dates.js';
import { h, rawBody, sendCsv } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

// ------------------------------------------------------------------ users
r.get('/admin/users', allow('users.manage'), h(() => listUsers()));
r.post('/admin/users', allow('users.manage'), h((req) => createUser(req.body || {}, req.user), 201));
r.put('/admin/users/:id', allow('users.manage'), h((req) => updateUser(id(req), req.body || {}, req.user)));
r.get('/admin/users/:id/open-work', allow('users.manage'), h((req) => openWorkFor(id(req))));
r.post('/admin/users/:id/deactivate', allow('users.manage'), h((req) => deactivateUser(id(req), req.body || {}, req.user)));
r.post('/admin/users/:id/reactivate', allow('users.manage'), h((req) => reactivateUser(id(req), req.user)));

// ------------------------------------------------------------------ settings, dropdowns
r.get('/admin/settings', allow('settings.manage'), h(() => getSettings()));
r.put('/admin/settings/:section', allow('settings.manage'), h((req) => {
  const out = updateSettings(req.params.section, req.body || {}, req.user);
  if (req.params.section === 'scheduler' && !process.env.VERCEL) startScheduler(maybeScheduledBackup);
  return out;
}));
r.get('/admin/dropdowns', allow('settings.manage'), h(() => listDropdowns()));
r.post('/admin/dropdowns/:category', allow('settings.manage'), h((req) => addDropdown(req.params.category, req.body || {}, req.user), 201));
r.put('/admin/dropdown-options/:id', allow('settings.manage'), h((req) => updateDropdown(id(req), req.body || {}, req.user)));
r.delete('/admin/dropdown-options/:id', allow('settings.manage'), h((req) => deleteDropdown(id(req), req.user)));

// ------------------------------------------------------------------ master lists (regions, factories, tags, assignment rules)
r.get('/admin/masters', allow('settings.manage', 'users.manage'), h(() => listMasters()));
r.post('/admin/masters/:kind', allow('settings.manage'), h((req) => saveMaster(req.params.kind, null, req.body || {}), 201));
r.put('/admin/masters/:kind/:id', allow('settings.manage'), h((req) => saveMaster(req.params.kind, id(req), req.body || {})));
r.delete('/admin/masters/:kind/:id', allow('settings.manage'), h((req) => deleteMaster(req.params.kind, id(req))));
r.get('/summaries', allow('reports.view', 'analytics.view'), h((req) => listSummaries(req.query.period === 'week' ? 'week' : 'day', 30)));

// ------------------------------------------------------------------ audit, system, scheduler, backups
r.get('/admin/audit', allow('audit.view'), h((req) => listAudit(req.query)));
r.get('/admin/system', allow('settings.manage'), h(() => systemHealth()));
r.post('/admin/scheduler/run', allow('settings.manage', 'queue.view'), h(() => runEvaluator({ trigger: 'manual' })));
r.post('/admin/backups', allow('settings.manage'), h(() => createBackup('manual'), 201));
r.post('/admin/backups/restore-test', allow('settings.manage'), h(() => restoreTest()));

/** Full export: every business table as CSV plus the stored documents, in one ZIP. */
r.get('/admin/export/full.zip', allow('export.full'), (req, res, next) => {
  try {
    const tables = ['customers', 'customer_aliases', 'contacts', 'customer_interests', 'tags', 'taggings', 'regions', 'factories', 'product_categories', 'products', 'product_options',
      'product_documents', 'campaigns', 'assignment_rules', 'sales_targets', 'enquiries', 'enquiry_lines', 'quotations', 'quote_revisions', 'approvals', 'orders', 'order_lines', 'order_updates',
      'commitment_changes', 'communication_confirmations', 'line_issues', 'dispatches', 'dispatch_lines', 'cancellations', 'tasks', 'task_changes', 'activities', 'reactivation_cases',
      'history_events', 'audit_events', 'attachments', 'attachment_links', 'invoices', 'receipts', 'payment_holds', 'complaints', 'dropdown_options',
      'object_categories', 'objects', 'object_files', 'object_codes', 'scan_events', 'summaries'];
    const entries = tables.map((t) => {
      const rows = all(`SELECT * FROM ${t}`);
      const cols = rows.length ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : [{ key: 'id', label: 'id' }];
      return { name: `data/${t}.csv`, data: toCsv(cols, rows) };
    });
    entries.push({ name: 'users.csv', data: toCsv(['id', 'name', 'email', 'role', 'department', 'active'].map((k) => ({ key: k, label: k })), all('SELECT id, name, email, role, department, active FROM users')) });
    for (const a of all('SELECT id, storage_key, original_name FROM attachments')) {
      const p = path.join(FILE_DIR, a.storage_key);
      if (fs.existsSync(p)) entries.push({ name: `documents/${a.id}-${a.original_name.replace(/[^\w.\- ]+/g, '_')}`, data: fs.readFileSync(p) });
    }
    entries.push({ name: 'README.txt', data: `Veritek CRM full export\nGenerated ${now().toISOString()} (display zone ${tz()})\nInstants are UTC; business dates are local dates; money is integer minor units with an ISO currency.\n` });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="veritek-export-${localDate(now(), tz())}.zip"`);
    res.send(zipFiles(entries));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ imports
r.get('/imports/templates', allow('imports.run'), h(() => Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, columns: t.columns }))));
r.get('/imports/templates/:type.csv', allow('imports.run'), (req, res, next) => {
  try {
    sendCsv(res, `veritek-${req.params.type}-template.csv`, templateCsv(req.params.type));
  } catch (err) {
    next(err);
  }
});
r.get('/imports/templates/:type/guide.csv', allow('imports.run'), (req, res, next) => {
  try {
    sendCsv(res, `veritek-${req.params.type}-column-guide.csv`, guideCsv(req.params.type));
  } catch (err) {
    next(err);
  }
});
r.post('/imports/upload', allow('imports.run'), rawBody, h((req) => {
  const out = storeUpload(req.body, req.query.name || 'upload.csv', req.user);
  return { ...out, suggested: req.query.type && TEMPLATES[req.query.type] ? autoMap(req.query.type, out.sheets[0]?.headers || []) : null };
}, 201));
r.post('/imports/preview', allow('imports.run'), h((req) => previewImport(req.body || {}, req.user)));
r.post('/imports/commit', allow('imports.run'), h((req) => commitImport(req.body || {}, req.user), 201));
r.get('/imports/batches', allow('imports.run'), h(() => listBatches()));
r.get('/imports/batches/:id', allow('imports.run'), h((req) => batchDetail(id(req))));
r.get('/imports/batches/:id/log.csv', allow('imports.run'), (req, res, next) => {
  try {
    sendCsv(res, `import-${id(req)}-log.csv`, batchLogCsv(id(req)));
  } catch (err) {
    next(err);
  }
});
r.post('/imports/batches/:id/retry', allow('imports.run'), h((req) => retryRows(id(req), req.body || {}, req.user)));
r.post('/imports/batches/:id/rollback', allow('settings.manage'), h((req) => rollbackBatch(id(req), req.body || {}, req.user)));

export default r;
