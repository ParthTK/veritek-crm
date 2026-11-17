import { Router } from 'express';
import { get } from '../db.js';
import { intId, forbidden, bool } from '../util.js';
import { allow, hasPerm } from '../auth.js';
import { assertCustomer } from '../access.js';
import {
  listCustomers, findMatches, createCustomer, getCustomerProfile, customerTimeline, updateCustomer, addContact, updateContact, setDoNotContact,
  mergeCustomers, dismissDuplicate, archiveCustomer, customerFacets, listContacts,
} from '../services/customers.js';
import { activitiesWhere, tasksWhere } from '../services/tasks.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

r.get('/customers', allow('customers.view'), h((req) => listCustomers(req.query, req.user)));
r.get('/customers/facets', allow('customers.view'), h((req) => customerFacets(req.user)));
r.get('/contacts', allow('customers.view'), h((req) => listContacts(req.query, req.user)));

// Possible matches shown before a record is created (warnings, never automatic merges).
r.get('/customers/match', allow('customers.view', 'enquiries.edit'), h((req) => findMatches({
  company_name: req.query.name, phones: [req.query.phone].filter(Boolean), emails: [req.query.email].filter(Boolean), country_code: req.query.country, excludeId: intId(req.query.exclude),
})));

r.post('/customers', allow('customers.edit'), h((req) => ({ id: createCustomer(req.body, req.user) }), 201));

r.get('/customers/:id', allow('customers.view'), h((req) => {
  assertCustomer(req.user, id(req));
  return getCustomerProfile(id(req), req.user);
}));

r.get('/customers/:id/timeline', allow('customers.view'), h((req) => {
  assertCustomer(req.user, id(req));
  return customerTimeline(id(req), { filter: req.query.filter || 'all', limit: Math.min(Number(req.query.limit) || 300, 1000) });
}));

r.get('/customers/:id/activities', allow('customers.view'), h((req) => {
  assertCustomer(req.user, id(req));
  return activitiesWhere('customer_id', id(req), 500);
}));

r.get('/customers/:id/tasks', allow('customers.view'), h((req) => {
  assertCustomer(req.user, id(req));
  return tasksWhere('customer_id', id(req));
}));

r.put('/customers/:id', allow('customers.edit'), h((req) => {
  assertCustomer(req.user, id(req));
  if (req.body.owner_id !== undefined && req.user.role === 'sales_executive' && Number(req.body.owner_id) !== req.user.id) {
    const cur = get('SELECT owner_id FROM customers WHERE id = ?', id(req));
    if (cur.owner_id !== Number(req.body.owner_id)) throw forbidden('Only management or the coordinator can assign customers to someone else');
  }
  return updateCustomer(id(req), req.body, req.user);
}));

r.post('/customers/:id/contacts', allow('customers.edit'), h((req) => {
  assertCustomer(req.user, id(req));
  return { id: addContact(id(req), req.body, req.user) };
}, 201));

r.put('/contacts/:id', allow('customers.edit'), h((req) => {
  const ct = get('SELECT customer_id FROM contacts WHERE id = ?', id(req));
  if (ct) assertCustomer(req.user, ct.customer_id);
  return updateContact(id(req), req.body, req.user);
}));

r.post('/customers/:id/do-not-contact', allow('customers.edit'), h((req) => {
  assertCustomer(req.user, id(req));
  return setDoNotContact(id(req), req.body, req.user);
}));

r.post('/customers/:id/merge', allow('customers.merge'), h((req) => mergeCustomers(id(req), intId(req.body?.source_id), req.body?.reason, req.user)));

r.post('/customers/:id/not-duplicate', allow('customers.edit'), h((req) => {
  assertCustomer(req.user, id(req));
  dismissDuplicate(id(req), intId(req.body?.other_id), req.body?.reason, req.user);
  return { ok: true };
}));

r.post('/customers/:id/archive', allow('customers.archive'), h((req) => archiveCustomer(id(req), { archived: !bool(req.body?.unarchive), reason: req.body?.reason }, req.user)));

r.get('/customers/:id/can-merge', h((req) => ({ allowed: hasPerm(req.user, 'customers.merge') })));

export default r;
