// Overview, coordinator queue, past customers, reports and list exports.
import { Router } from 'express';
import { get } from '../db.js';
import { intId, notFound, now, tz } from '../util.js';
import { allow } from '../auth.js';
import { assertCustomer } from '../access.js';
import { dashboard, salesMap } from '../services/dashboard.js';
import { salesDashboard } from '../services/analytics.js';
import { workQueue, dataQuality } from '../services/queue.js';
import { pastCustomers, recordUpdate, openLinkedEnquiry, closeCase, reactivationMetrics } from '../services/reactivation.js';
import { reportList, runReport, reportRecords } from '../services/reports.js';
import { listCustomers } from '../services/customers.js';
import { listEnquiries } from '../services/enquiries.js';
import { listOrders } from '../services/orders.js';
import { listTasks } from '../services/tasks.js';
import { toCsv } from '../lib/files.js';
import { localDate, localTime } from '../../shared/dates.js';
import { h, idempotent, sendCsv } from './helpers.js';

const r = Router();

r.get('/dashboard', allow('dashboard.view'), h((req) => dashboard(req.query, req.user)));
r.get('/dashboard/map', allow('dashboard.view'), h((req) => salesMap(req.user)));
r.get('/analytics', allow('analytics.view'), h((req) => salesDashboard(req.query, req.user)));
r.get('/queue', allow('queue.view'), h((req) => workQueue(req.user)));
r.get('/data-quality', allow('queue.view'), h((req) => dataQuality(req.user)));

// ------------------------------------------------------------------ past customers
r.get('/past-customers', allow('past.view'), h((req) => pastCustomers(req.query, req.user)));
r.get('/past-customers/metrics', allow('past.view'), h((req) => reactivationMetrics(req.user, { from: req.query.from, to: req.query.to })));

r.post('/past-customers/:id/update', allow('past.edit'), h((req) => {
  assertCustomer(req.user, intId(req.params.id));
  return recordUpdate(intId(req.params.id), req.body || {}, req.user);
}));

r.post('/past-customers/:id/enquiry', allow('past.edit', 'enquiries.edit'), idempotent('reactivation.enquiry', (req) => {
  assertCustomer(req.user, intId(req.params.id));
  return openLinkedEnquiry(intId(req.params.id), req.body || {}, req.user);
}));

r.post('/reactivation/:id/close', allow('past.edit'), h((req) => {
  const rc = get('SELECT customer_id FROM reactivation_cases WHERE id = ?', intId(req.params.id));
  if (!rc) throw notFound('Reactivation case');
  assertCustomer(req.user, rc.customer_id);
  return closeCase(intId(req.params.id), req.body || {}, req.user);
}));

// ------------------------------------------------------------------ reports
r.get('/reports', allow('reports.view'), h(() => reportList()));
r.get('/reports/:key', allow('reports.view'), h((req) => runReport(req.params.key, req.query, req.user) || (() => { throw notFound('Report'); })()));
r.get('/reports/:key/records', allow('reports.view'), h((req) => reportRecords(req.params.key, req.query, req.user) || (() => { throw notFound('Report'); })()));

const exportMeta = (title, filters, definition) => {
  const n = now();
  return [
    ['Export', title],
    ['Generated', `${localDate(n, tz())} ${localTime(n, tz())} (${tz()})`],
    ['Filters', Object.entries(filters).filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['fromUtc', 'toUtc'].includes(k)).map(([k, v]) => `${k}=${v}`).join('; ') || 'none'],
    ...(definition ? [['Definition', definition]] : []),
    ['Note', 'Blank values are unknown, not zero. Money is in minor units (1/100) of the stated currency; currencies are never combined.'],
  ];
};

r.get('/reports/:key/export.csv', allow('reports.view'), (req, res, next) => {
  try {
    const out = reportRecords(req.params.key, req.query, req.user);
    if (!out) throw notFound('Report');
    const cols = [...out.columns];
    sendCsv(res, `${req.params.key}-${localDate(now(), tz())}.csv`, toCsv(cols, out.rows, exportMeta(out.title, { ...req.query }, out.definition)));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ list exports (exactly the filtered records)
const LIST_EXPORTS = {
  customers: {
    perm: 'export.lists',
    run: (q, u) => listCustomers({ ...q, page: 1, pageSize: 100000 }, u).rows,
    columns: [['code', 'Code'], ['company_name', 'Company'], ['country_code', 'Country'], ['city', 'City'], ['segment', 'Segment'], ['owner_name', 'Owner'], ['last_order_date', 'Last order date'], ['last_contact_at', 'Last contact (UTC)'], ['open_enquiries', 'Open enquiries'], ['active_orders', 'Active orders'], ['do_not_contact', 'Do not contact']],
  },
  enquiries: {
    perm: 'export.lists',
    run: (q, u) => listEnquiries({ ...q, page: 1, pageSize: 100000 }, u).rows,
    columns: [['code', 'Enquiry'], ['customer_name', 'Customer'], ['product', 'First product'], ['qty', 'Quantity (blank = unknown)'], ['unit', 'Unit'], ['stage_label', 'Stage'], ['owner_name', 'Owner'], ['source_label', 'Source'], ['received_at', 'Received (UTC)'], ['first_response_at', 'First response (UTC)'], ['lost_reason', 'Lost reason']],
  },
  orders: {
    perm: 'export.lists',
    run: (q, u) => listOrders(q, u).rows.flatMap((o) => o.lines.map((l) => ({ ...l, order_code: o.code, customer_name: o.customer_name, po_reference: o.po_reference, owner_name: o.owner_name, received_date: o.received_date, confirmed: l.quantities.confirmed, dispatched: l.quantities.dispatched, cancelled: l.quantities.cancelled, remaining: l.quantities.remaining }))),
    columns: [['order_code', 'Order'], ['customer_name', 'Customer'], ['po_reference', 'Customer PO'], ['line_no', 'Line'], ['product', 'Product'], ['unit', 'Unit'], ['confirmed', 'Confirmed'], ['dispatched', 'Dispatched'], ['cancelled', 'Cancelled'], ['remaining', 'Remaining'], ['phase_label', 'Phase'], ['state', 'Delay state'], ['original_commitment_date', 'Original commitment'], ['forecast_dispatch_date', 'Dispatch forecast'], ['agreed_commitment_date', 'Customer-agreed date'], ['issue_label', 'Delay reason'], ['comm_state', 'Customer informed'], ['owner_name', 'Owner']],
  },
  tasks: {
    perm: 'export.lists',
    run: (q, u) => listTasks({ ...q, limit: 1000 }, u).rows,
    columns: [['purpose', 'Task'], ['customer_name', 'Customer'], ['owner_name', 'Owner'], ['kind', 'Kind'], ['due_date', 'Due'], ['due_state', 'State'], ['original_due_date', 'Originally due'], ['reschedule_count', 'Reschedules']],
  },
};

r.get('/export/:list.csv', (req, res, next) => {
  try {
    const def = LIST_EXPORTS[req.params.list];
    if (!def) throw notFound('Export');
    allow(def.perm)(req, res, (err) => {
      if (err) return next(err);
      try {
        const rows = def.run(req.query, req.user);
        const cols = def.columns.map(([key, label]) => ({ key, label }));
        sendCsv(res, `${req.params.list}-${localDate(now(), tz())}.csv`, toCsv(req.user.values_access ? cols : cols.filter((c) => !/_minor$/.test(c.key)), rows, exportMeta(req.params.list, req.query)));
      } catch (e) {
        next(e);
      }
    });
  } catch (err) {
    next(err);
  }
});

export default r;
