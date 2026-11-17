import { Router } from 'express';
import { all, get } from '../db.js';
import { intId, forbidden } from '../util.js';
import { allow, hasPerm } from '../auth.js';
import { assertOrder, assertCustomer } from '../access.js';
import {
  listOrders, createOrder, getOrder, updateDraftOrder, confirmOrder, quickUpdate, bulkPreview, bulkApply, recordCommunication, postDispatch,
  reverseDispatch, recordDispatchNotice, markDelivered, cancelQuantity, reverseCancellation, amendLine, clarifySpec, setCommitment, addLine, splitLine, orderLineOptions,
  updateOrderHeader, postPlannedDispatch, cancelPlannedDispatch, updateDispatchDetails, listDispatches, productionBoard,
} from '../services/orders.js';
import { placeHold, releaseHold } from '../services/finance.js';
import { h, idempotent } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);
const lineOrder = (lineId) => get('SELECT order_id FROM order_lines WHERE id = ?', lineId)?.order_id;
const assertLine = (req) => {
  const oid = lineOrder(id(req));
  if (!oid) throw forbidden('Order line not found');
  assertOrder(req.user, oid);
};

r.get('/orders', allow('orders.view'), h((req) => listOrders(req.query, req.user)));
r.get('/order-lines/options', allow('orders.view'), h((req) => orderLineOptions(req.user, req.query)));
r.get('/production/board', allow('orders.view'), h((req) => productionBoard(req.query, req.user)));
r.get('/dispatches', allow('orders.view'), h((req) => listDispatches(req.query, req.user)));

r.post('/orders', allow('orders.edit'), idempotent('order.create', (req) => {
  assertCustomer(req.user, intId(req.body?.customer_id));
  return { id: createOrder(req.body || {}, req.user) };
}));

r.get('/orders/:id', allow('orders.view'), h((req) => {
  assertOrder(req.user, id(req));
  return getOrder(id(req), req.user);
}));

r.put('/orders/:id', allow('orders.edit', 'orders.update'), h((req) => {
  assertOrder(req.user, id(req));
  const o = get('SELECT status FROM orders WHERE id = ?', id(req));
  if (o?.status === 'draft') {
    if (!hasPerm(req.user, 'orders.edit')) throw forbidden();
    return updateDraftOrder(id(req), req.body || {}, req.user);
  }
  // Production users may only set the factory / production owner on a confirmed order.
  if (!hasPerm(req.user, 'orders.edit')) {
    const allowed = ['factory_id', 'production_owner_id', 'dispatch_owner_id', 'version', 'reason'];
    if (Object.keys(req.body || {}).some((k) => !allowed.includes(k))) throw forbidden('You can only change the factory and production / dispatch owners');
  }
  return updateOrderHeader(id(req), req.body || {}, req.user);
}));

r.post('/orders/:id/confirm', allow('orders.edit'), h((req) => {
  assertOrder(req.user, id(req));
  return confirmOrder(id(req), req.body || {}, req.user);
}));

// Quick production update (one line) and bulk updates (preview first, then per-line results).
r.post('/order-lines/:id/update', allow('orders.update'), h((req) => {
  assertLine(req);
  return quickUpdate(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/bulk/preview', allow('orders.update'), h((req) => {
  for (const lid of req.body?.line_ids || []) assertOrder(req.user, lineOrder(intId(lid)));
  return bulkPreview(req.body || {}, req.user);
}));

r.post('/order-lines/bulk/apply', allow('orders.update'), idempotent('lines.bulk', (req) => {
  for (const lid of req.body?.line_ids || []) assertOrder(req.user, lineOrder(intId(lid)));
  return bulkApply(req.body || {}, req.user);
}));

r.post('/orders/:id/communications', allow('orders.communicate'), idempotent('order.communicate', (req) => {
  assertOrder(req.user, id(req));
  return recordCommunication(id(req), req.body || {}, req.user);
}));

/** Dispatch posting is idempotent and transactional: concurrent or repeated requests cannot over-dispatch. */
r.post('/dispatches', allow('dispatch.post'), idempotent('dispatch.post', (req) => {
  for (const l of req.body?.lines || []) assertOrder(req.user, lineOrder(intId(l.line_id)));
  return postDispatch(req.body || {}, req.user);
}));

const dispatchOrders = (req) => all('SELECT DISTINCT order_id FROM dispatch_lines WHERE dispatch_id = ?', id(req)).forEach((x) => assertOrder(req.user, x.order_id));

r.post('/dispatches/:id/reverse', allow('dispatch.reverse'), h((req) => {
  dispatchOrders(req);
  return reverseDispatch(id(req), req.body || {}, req.user);
}));

r.post('/dispatches/:id/notify', allow('orders.communicate', 'dispatch.post'), h((req) => {
  dispatchOrders(req);
  return recordDispatchNotice(id(req), req.body || {}, req.user);
}));

r.post('/dispatches/:id/delivered', allow('orders.communicate', 'dispatch.post'), h((req) => {
  dispatchOrders(req);
  return markDelivered(id(req), req.body || {}, req.user);
}));

r.post('/dispatches/:id/post', allow('dispatch.post'), idempotent('dispatch.post_planned', (req) => {
  dispatchOrders(req);
  return postPlannedDispatch(id(req), req.body || {}, req.user);
}));

r.post('/dispatches/:id/cancel', allow('dispatch.post'), h((req) => {
  dispatchOrders(req);
  return cancelPlannedDispatch(id(req), req.body || {}, req.user);
}));

r.put('/dispatches/:id', allow('dispatch.post'), h((req) => {
  dispatchOrders(req);
  return updateDispatchDetails(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/:id/cancel', allow('orders.cancel'), idempotent('line.cancel', (req) => {
  assertLine(req);
  return cancelQuantity(id(req), req.body || {}, req.user);
}));

r.post('/cancellations/:id/reverse', allow('orders.authorise'), h((req) => {
  const k = get('SELECT order_id FROM cancellations WHERE id = ?', id(req));
  if (k) assertOrder(req.user, k.order_id);
  return reverseCancellation(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/:id/amend', allow('orders.amend'), h((req) => {
  assertLine(req);
  return amendLine(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/:id/clarify', allow('orders.edit'), h((req) => {
  assertLine(req);
  return clarifySpec(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/:id/commitment', allow('orders.edit'), h((req) => {
  assertLine(req);
  return setCommitment(id(req), req.body || {}, req.user);
}));

r.post('/order-lines/:id/split', allow('orders.amend'), h((req) => {
  assertLine(req);
  return splitLine(id(req), req.body || {}, req.user);
}));

r.post('/orders/:id/lines', allow('orders.amend'), h((req) => {
  assertOrder(req.user, id(req));
  return addLine(id(req), req.body || {}, req.user);
}, 201));

// P1 payment holds
r.post('/orders/:id/holds', allow('finance.holds'), h((req) => {
  assertOrder(req.user, id(req));
  return placeHold(id(req), req.body || {}, req.user);
}, 201));

r.post('/holds/:id/release', allow('finance.holds'), h((req) => {
  if (!hasPerm(req.user, 'finance.holds')) throw forbidden();
  return releaseHold(id(req), req.body || {}, req.user);
}));

export default r;
