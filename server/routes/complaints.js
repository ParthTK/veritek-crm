// P1 complaints & service.
import { Router } from 'express';
import { intId } from '../util.js';
import { allow } from '../auth.js';
import { assertComplaint, assertCustomer } from '../access.js';
import { listComplaints, getComplaint, createComplaint, updateComplaint, complaintInsights } from '../services/complaints.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

r.get('/complaints', allow('complaints.view'), h((req) => listComplaints(req.query, req.user)));
r.get('/complaints/insights', allow('complaints.view'), h((req) => complaintInsights(req.query)));
r.get('/complaints/:id', allow('complaints.view'), h((req) => {
  assertComplaint(req.user, id(req));
  return getComplaint(id(req));
}));
r.post('/complaints', allow('complaints.edit'), h((req) => {
  if (!['service', 'production'].includes(req.user.group)) assertCustomer(req.user, intId(req.body?.customer_id));
  return createComplaint(req.body || {}, req.user);
}, 201));
r.put('/complaints/:id', allow('complaints.edit'), h((req) => {
  assertComplaint(req.user, id(req));
  return updateComplaint(id(req), req.body || {}, req.user);
}));

export default r;
