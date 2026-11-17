// Quotations: register, builder (preview / create / edit drafts), revisions, approvals, issue, outcome and
// idempotent conversion to an order.
import { Router } from 'express';
import { get } from '../db.js';
import { intId, notFound } from '../util.js';
import { allow } from '../auth.js';
import { assertQuotation, assertEnquiry, assertCustomer, assertOrder } from '../access.js';
import {
  createQuotation, updateDraft, newRevision, issueRevision, recordOutcome, convertToOrder, revisionDetail, loadQuotation, listQuotations, previewQuote,
  duplicateQuotation, submitForApproval, withdrawApproval, decideApproval, listApprovals,
} from '../services/quotes.js';
import { h, idempotent } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);
const revQuotation = (revId) => {
  const q = get('SELECT quotation_id FROM quote_revisions WHERE id = ?', revId);
  if (!q) throw notFound('Quotation revision');
  return q.quotation_id;
};

r.get('/quotations', allow('quotes.view'), h((req) => listQuotations(req.query, req.user)));
r.post('/quotations/preview', allow('quotes.edit'), h((req) => previewQuote(req.body || {})));

r.post('/quotations', allow('quotes.edit'), idempotent('quotation.create', (req) => {
  if (req.body?.enquiry_id) assertEnquiry(req.user, intId(req.body.enquiry_id));
  else assertCustomer(req.user, intId(req.body?.customer_id));
  return createQuotation(req.body || {}, req.user);
}));

r.post('/quotations/duplicate', allow('quotes.edit'), idempotent('quotation.duplicate', (req) => {
  if (req.body?.order_id) assertOrder(req.user, intId(req.body.order_id));
  if (req.body?.quotation_id) assertQuotation(req.user, intId(req.body.quotation_id));
  if (req.body?.customer_id) assertCustomer(req.user, intId(req.body.customer_id));
  return duplicateQuotation(req.body || {}, req.user);
}));

r.get('/quotations/:id', allow('quotes.view'), h((req) => {
  assertQuotation(req.user, id(req));
  return loadQuotation(id(req), req.user);
}));

r.post('/quotations/:id/revisions', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, id(req));
  return newRevision(id(req), req.user, req.body || {});
}, 201));

r.get('/quote-revisions/:id', allow('quotes.view'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return revisionDetail(id(req));
}));

r.put('/quote-revisions/:id', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return updateDraft(id(req), req.body || {}, req.user);
}));

r.post('/quote-revisions/:id/submit', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return submitForApproval(id(req), req.user);
}));

r.post('/quote-revisions/:id/withdraw', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return withdrawApproval(id(req), req.user);
}));

r.post('/quote-revisions/:id/issue', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return issueRevision(id(req), req.body || {}, req.user);
}));

r.post('/quote-revisions/:id/outcome', allow('quotes.edit'), h((req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return recordOutcome(id(req), req.body || {}, req.user);
}));

/** Conversion is idempotent: a double-click or retried request returns the order already created. */
r.post('/quote-revisions/:id/convert', allow('orders.edit'), idempotent('quote.convert', (req) => {
  assertQuotation(req.user, revQuotation(id(req)));
  return convertToOrder(id(req), req.body || {}, req.user);
}));

// ------------------------------------------------------------------ approvals
r.get('/approvals', allow('quotes.view', 'team.view'), h((req) => listApprovals(req.query, req.user)));
r.post('/approvals/:id/decide', allow('quotes.approve'), h((req) => decideApproval(id(req), req.body || {}, req.user)));

export default r;
