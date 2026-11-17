import { Router } from 'express';
import { get } from '../db.js';
import { intId } from '../util.js';
import { allow } from '../auth.js';
import { assertEnquiry, assertCustomer } from '../access.js';
import { createEnquiry, getEnquiry, listEnquiries, updateEnquiry, changeStage, reopenEnquiry, setLineOutcome, pipelineBoard, defaultOwnerFor } from '../services/enquiries.js';
import { h, idempotent } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

r.get('/enquiries', allow('enquiries.view'), h((req) => listEnquiries(req.query, req.user)));
r.get('/enquiries/pipeline', allow('enquiries.view'), h((req) => pipelineBoard(req.query, req.user)));
/** Suggested owner for a new enquiry from the assignment rules (the customer's owner comes first). */
r.get('/enquiries/suggest-owner', allow('enquiries.edit'), h((req) => {
  const cid = intId(req.query.customer_id);
  const own = cid ? get('SELECT owner_id FROM customers WHERE id = ?', cid)?.owner_id : null;
  return { owner_id: own || defaultOwnerFor(cid, (String(req.query.product_ids || '')).split(',').map(intId).filter(Boolean).map((product_id) => ({ product_id }))) };
}));

r.post('/enquiries', allow('enquiries.edit'), idempotent('enquiry.create', (req) => {
  if (req.body?.customer_id) assertCustomer(req.user, intId(req.body.customer_id));
  return createEnquiry(req.body || {}, req.user);
}));

r.get('/enquiries/:id', allow('enquiries.view'), h((req) => {
  assertEnquiry(req.user, id(req));
  return getEnquiry(id(req), req.user);
}));

r.put('/enquiries/:id', allow('enquiries.edit'), h((req) => {
  assertEnquiry(req.user, id(req));
  return updateEnquiry(id(req), req.body || {}, req.user);
}));

r.post('/enquiries/:id/stage', allow('enquiries.edit'), h((req) => {
  assertEnquiry(req.user, id(req));
  return changeStage(id(req), req.body || {}, req.user);
}));

r.post('/enquiries/:id/reopen', allow('enquiries.edit'), h((req) => {
  assertEnquiry(req.user, id(req));
  return reopenEnquiry(id(req), req.body || {}, req.user);
}));

/** A materially new request from a closed enquiry becomes a linked new enquiry. */
r.post('/enquiries/:id/linked', allow('enquiries.edit'), idempotent('enquiry.linked', (req) => {
  assertEnquiry(req.user, id(req));
  const e = get('SELECT customer_id, contact_id, owner_id FROM enquiries WHERE id = ?', id(req));
  return createEnquiry({ owner_id: e.owner_id, contact_id: e.contact_id, ...req.body, customer_id: e.customer_id, parent_enquiry_id: id(req) }, req.user);
}));

r.post('/enquiry-lines/:id/outcome', allow('enquiries.edit'), h((req) => {
  const l = get('SELECT enquiry_id FROM enquiry_lines WHERE id = ?', id(req));
  if (l) assertEnquiry(req.user, l.enquiry_id);
  return setLineOutcome(id(req), req.body || {}, req.user);
}));

export default r;
