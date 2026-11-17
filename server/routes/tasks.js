import { Router } from 'express';
import { get } from '../db.js';
import { intId, forbidden } from '../util.js';
import { allow, hasPerm } from '../auth.js';
import { assertTask, assertCustomer, assertEnquiry, assertOrder } from '../access.js';
import { listTasks, taskDetail, createTask, completeTask, rescheduleTask, reassignTask, cancelTask, recordActivity } from '../services/tasks.js';
import { h, idempotent } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

/** People manage their own tasks; the coordinator and management can act on anyone's. */
function canActOnTask(req) {
  assertTask(req.user, id(req));
  const t = get('SELECT owner_id, kind, order_id FROM tasks WHERE id = ?', id(req));
  if (t.owner_id === req.user.id || hasPerm(req.user, 'tasks.manage_any')) return;
  if (req.user.group === 'sales' && t.kind === 'customer') return;
  throw forbidden('Only the task owner, the coordinator or management can update this task');
}

function assertLinks(req, body) {
  if (body.customer_id) assertCustomer(req.user, intId(body.customer_id));
  if (body.enquiry_id) assertEnquiry(req.user, intId(body.enquiry_id));
  if (body.order_id) assertOrder(req.user, intId(body.order_id));
}

r.get('/tasks', h((req) => listTasks(req.query, req.user)));

r.get('/tasks/:id', h((req) => {
  assertTask(req.user, id(req));
  return taskDetail(id(req));
}));

r.post('/tasks', allow('tasks.edit'), h((req) => {
  assertLinks(req, req.body || {});
  if (!req.body?.customer_id && !req.body?.enquiry_id && !req.body?.order_id && !req.body?.line_id && !req.body?.complaint_id && !req.body?.invoice_id) {
    throw forbidden('Link the task to a customer, enquiry or order');
  }
  return { id: createTask({ ...req.body, source: 'manual' }, req.user) };
}, 201));

r.post('/tasks/:id/complete', allow('tasks.edit'), idempotent('task.complete', (req) => {
  canActOnTask(req);
  return completeTask(id(req), req.body || {}, req.user);
}));

r.post('/tasks/:id/reschedule', allow('tasks.edit'), h((req) => {
  canActOnTask(req);
  return rescheduleTask(id(req), req.body || {}, req.user);
}));

r.post('/tasks/:id/reassign', allow('tasks.edit'), h((req) => {
  canActOnTask(req);
  return reassignTask(id(req), req.body || {}, req.user);
}));

r.post('/tasks/:id/cancel', allow('tasks.edit'), h((req) => {
  canActOnTask(req);
  return cancelTask(id(req), req.body || {}, req.user);
}));

r.post('/activities', allow('activities.edit'), idempotent('activity.create', (req) => {
  assertLinks(req, req.body || {});
  return { id: recordActivity(req.body || {}, req.user) };
}));

export default r;
