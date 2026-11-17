// P1 finance: invoice register, receipts (with TDS / deductions), credit notes, order advances, payment
// promises and the receivables overview. Payment holds live with the order routes.
import { Router } from 'express';
import { get } from '../db.js';
import { intId, notFound } from '../util.js';
import { allow } from '../auth.js';
import { assertCustomer, assertOrder } from '../access.js';
import {
  listInvoices, invoiceDetail, createInvoice, recordReceipt, reverseReceipt, setPromise, setFinanceAsOf, financeOverview, recordAdvance, listReceipts, pendingAdvances, orderFinance,
} from '../services/finance.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

function invoiceCustomer(req) {
  const inv = get('SELECT customer_id FROM invoices WHERE id = ?', id(req));
  if (!inv) throw notFound('Invoice');
  assertCustomer(req.user, inv.customer_id);
}

r.get('/finance/overview', allow('finance.view'), h((req) => financeOverview(req.user)));
r.get('/finance/invoices', allow('finance.view'), h((req) => listInvoices(req.query, req.user)));
r.get('/finance/invoices/:id', allow('finance.view'), h((req) => {
  invoiceCustomer(req);
  return invoiceDetail(id(req));
}));
r.post('/finance/invoices', allow('finance.edit'), h((req) => {
  if (req.body?.order_id) assertOrder(req.user, intId(req.body.order_id));
  return createInvoice(req.body || {}, req.user);
}, 201));
r.post('/finance/invoices/:id/receipts', allow('finance.edit'), h((req) => {
  invoiceCustomer(req);
  return recordReceipt(id(req), req.body || {}, req.user);
}, 201));
r.post('/finance/invoices/:id/promise', allow('finance.edit', 'orders.communicate'), h((req) => {
  invoiceCustomer(req);
  return setPromise(id(req), req.body || {}, req.user);
}));
r.get('/finance/receipts', allow('finance.view'), h((req) => listReceipts(req.query, req.user)));
r.post('/finance/receipts/:id/reverse', allow('finance.edit'), h((req) => {
  const rc = get('SELECT customer_id FROM receipts WHERE id = ?', id(req));
  if (!rc) throw notFound('Receipt');
  assertCustomer(req.user, rc.customer_id);
  return reverseReceipt(id(req), req.body || {}, req.user);
}));
r.get('/finance/advances', allow('finance.view'), h((req) => pendingAdvances(req.user)));
r.post('/finance/orders/:id/advances', allow('finance.edit'), h((req) => {
  assertOrder(req.user, id(req));
  return recordAdvance(id(req), req.body || {}, req.user);
}, 201));
r.get('/finance/orders/:id', allow('finance.view'), h((req) => {
  assertOrder(req.user, id(req));
  return orderFinance(id(req));
}));
r.put('/finance/as-of', allow('finance.edit'), h((req) => setFinanceAsOf(req.body || {}, req.user)));

export default r;
