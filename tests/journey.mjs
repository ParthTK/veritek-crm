// End-to-end journey through the HTTP API: lead → quote → approval → PO → production → dispatch → payment → service.
const BASE = process.env.API || 'http://localhost:4399/api';
let failures = 0;
const log = (ok, msg, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? ` — ${extra}` : ''}`);
};

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Veritek@123' }) });
  const b = await r.json();
  if (!b.token) throw new Error(`login failed for ${email}: ${b.error}`);
  const call = async (path, opts = {}) => {
    const res = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  return { user: b.user, get: (p) => call(p), post: (p, body) => call(p, { method: 'POST', body }), put: (p, body) => call(p, { method: 'PUT', body }) };
}
const anon = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const today = new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const exec = await login('rohan@veritek.example');       // Sales executive, West
const rm = await login('rsm.west@veritek.example');      // Regional manager
const head = await login('saleshead@veritek.example');
const commercial = await login('commercial@veritek.example');
const production = await login('production@veritek.example');
const quality = await login('quality@veritek.example');
const dispatch = await login('dispatch@veritek.example');
const accounts = await login('accounts@veritek.example');
const service = await login('service@veritek.example');

// ---------------------------------------------------------------- 1. lead
const stamp = Date.now().toString().slice(-6);
const leadRes = await exec.post('/leads', {
  title: `APFC panels for new plant ${stamp}`,
  new_customer: { name: `Journey Test Industries ${stamp}`, customer_type: 'direct', industry: 'Automotive', city: 'Pune', state: 'Maharashtra', region_id: 1, contact_name: 'Anil Deshpande', designation: 'Purchase Manager', phone: '+91 9800000001', email: 'anil@journeytest.example', billing_address: 'Plot 9, MIDC, Pune' },
  requirement: 'APFC panel with thyristor switching for a new press shop',
  source: 'referral', temperature: 'hot', estimated_value: 900000, expected_close_date: addDays(30),
  next_action: 'Site visit to check load pattern', next_follow_up_date: today, tags: ['Urgent Requirement'],
});
log(leadRes.status === 201, 'sales executive creates a lead with a new company', leadRes.data?.error);
const leadId = leadRes.data.id;
const lead = (await exec.get(`/leads/${leadId}`)).data;
log(lead.assigned_to === exec.user.id, 'lead auto-assigned to the creating executive');
log(lead.followups.some((f) => f.status === 'pending' && f.due_date === today), 'follow-up task created automatically');

// activity + stage moves
const act = await exec.post('/activities', { lead_id: leadId, type: 'meeting', summary: 'Visited site, measured load', customer_response: 'Wants thyristor switching', next_action: 'Share technical proposal', follow_up_date: addDays(2) });
log(act.status === 201, 'log a site meeting against the lead', act.data?.error);
const noNext = await exec.post('/activities', { lead_id: leadId, type: 'call', summary: 'Quick call' });
log(noNext.status === 400, 'API refuses an interaction on an open lead without a next action');
await exec.post(`/leads/${leadId}/move`, { stage: 'technical_discussion', next_action: 'Prepare quotation', next_follow_up_date: addDays(1) });
const afterMove = (await exec.get(`/leads/${leadId}`)).data;
log(afterMove.stage === 'technical_discussion' && afterMove.followups.find((f) => f.status === 'pending')?.due_date === addDays(1), 'stage move updates the pending follow-up');

// ---------------------------------------------------------------- 2. quotation with a discount that needs approval
const products = (await exec.get('/products?active=1')).data;
const panel = products.find((p) => p.sku === 'VT-APFC');
const comm = products.find((p) => p.sku === 'VT-COMM');
const panelDetail = (await exec.get(`/products/${panel.id}`)).data;
const thyristor = panelDetail.options.find((o) => o.name.startsWith('Thyristor'));
const items = [
  { product_id: panel.id, option_ids: [thyristor.id], qty: 2, discount_pct: 14 },
  { product_id: comm.id, qty: 4, discount_pct: 0 },
];
const preview = (await exec.post('/quotations/preview', { customer_id: lead.customer_id, items, freight: 12000 })).data;
log(preview.approval_role === 'regional_manager', 'a 14% discount needs regional manager approval', preview.approval_role);
log(preview.lines[0].list_price === panel.standard_price + thyristor.price_delta, 'configurator option is priced from the master');

const qRes = await exec.post('/quotations', { customer_id: lead.customer_id, lead_id: leadId, contact_id: lead.contact_id, subject: 'APFC panels', items, freight: 12000 });
log(qRes.status === 201, 'create quotation', qRes.data?.error);
const qid = qRes.data.id;
const submit = await exec.post(`/quotations/${qid}/submit`);
log(submit.data.status === 'approval_pending', 'submitting routes it for approval');
const sendEarly = await exec.post(`/quotations/${qid}/send`, {});
log(sendEarly.status === 400, 'cannot send a quotation that is awaiting approval');
const selfApprove = await exec.get('/approvals');
log(selfApprove.data.every((a) => !a.can_decide), 'the executive cannot approve their own quotation');
const pending = (await rm.get('/approvals')).data.find((a) => a.quotation_id === qid);
log(Boolean(pending?.can_decide), 'regional manager sees it in the approval queue');
const decided = await rm.post(`/approvals/${pending.id}/decide`, { decision: 'approved', comments: 'Approved for the volume' });
log(decided.status === 200, 'regional manager approves', decided.data?.error);
const sent = await exec.post(`/quotations/${qid}/send`, { channel: 'email', valid_until: addDays(20) });
log(sent.status === 200, 'quotation sent to the customer', sent.data?.error);

// ---------------------------------------------------------------- 3. customer portal
const quote = (await exec.get(`/quotations/${qid}`)).data;
const portal = await anon(`/public/quotations/${quote.public_token}`);
log(portal.status === 200 && portal.data.totals.grand_total === quote.current.grand_total, 'customer opens the public quotation link');
log(portal.data.items[0].cost_price === undefined, 'portal hides internal cost');
const afterView = (await exec.get(`/quotations/${qid}`)).data;
log(afterView.status === 'viewed' && afterView.viewed_at, 'opening the link marks the quotation viewed');
const accept = await anon(`/public/quotations/${quote.public_token}/respond`, { method: 'POST', body: { action: 'accept', name: 'Anil Deshpande', message: 'Please proceed' } });
log(accept.status === 200, 'customer accepts from the portal', accept.data?.error);
log((await exec.get(`/quotations/${qid}`)).data.status === 'accepted', 'quotation status becomes accepted');

// revision flow on a second quotation
const q2 = (await exec.post('/quotations', { customer_id: lead.customer_id, items: [{ product_id: panel.id, qty: 1, discount_pct: 2 }] })).data;
await exec.post(`/quotations/${q2.id}/submit`);
await exec.post(`/quotations/${q2.id}/send`, {});
const rev = await exec.put(`/quotations/${q2.id}`, { items: [{ product_id: panel.id, qty: 1, discount_pct: 9 }], change_note: 'Extra discount after negotiation' });
log(rev.data.new_version === true && rev.data.version_no === 2, 'editing a sent quotation creates version 2');
const versions = (await exec.get(`/quotations/${q2.id}`)).data.versions;
log(versions.length === 2 && versions[1].grand_total > versions[0].grand_total, 'both versions are preserved for comparison');

// ---------------------------------------------------------------- 4. order
const convert = await commercial.post(`/quotations/${qid}/convert`, { customer_po_number: `PO/JT/${stamp}`, po_date: today, advance_pct: 40, priority: 'high', expected_delivery_date: addDays(25), win_reason: 'Technical superiority' });
log(convert.status === 201, 'commercial converts the accepted quotation into a sales order', convert.data?.error);
const orderId = convert.data.id;
const order = (await commercial.get(`/orders/${orderId}`)).data;
log(order.stage === 'po_received' && order.items.length === 2, 'order carries the quoted items');
log((await exec.get(`/leads/${leadId}`)).data.status === 'won', 'linked lead is marked won');

await commercial.post(`/orders/${orderId}/stage`, { stage: 'commercial_verification', note: 'PO checked' });
const blocked = await commercial.post(`/orders/${orderId}/stage`, { stage: 'order_confirmed' });
log(blocked.status === 400, 'cannot confirm the order before the advance is received', blocked.data?.error?.slice(0, 40));
await commercial.post(`/orders/${orderId}/stage`, { stage: 'advance_pending' });
const adv = await accounts.post('/payments', { order_id: orderId, amount: order.advance_required, payment_date: today, mode: 'rtgs', reference: `UTR${stamp}` });
log(adv.status === 201, 'accounts records the advance', adv.data?.error);
log((await commercial.get(`/orders/${orderId}`)).data.stage === 'order_confirmed', 'advance receipt confirms the order automatically');

// ---------------------------------------------------------------- 5. production & quality
const execProd = await exec.post(`/orders/${orderId}/stage`, { stage: 'under_production' });
log(execProd.status === 403, 'a sales executive cannot move the order into production');
await production.post(`/orders/${orderId}/stage`, { stage: 'material_check' });
const prodUpdate = await production.put(`/orders/${orderId}/production`, {
  material_status: 'partial', material_constraint: 'Thyristor modules awaited', planned_start: addDays(2), planned_completion: addDays(15),
  update_note: 'Slot booked in panel shop',
});
log(prodUpdate.status === 200, 'production updates material status and plan', prodUpdate.data?.error);
const qcByProduction = await production.put(`/orders/${orderId}/production`, { qc_status: 'passed' });
log(qcByProduction.status === 403, 'production cannot mark its own quality check as passed');
await production.post(`/orders/${orderId}/stage`, { stage: 'production_scheduled' });
await production.post(`/orders/${orderId}/stage`, { stage: 'under_production' });
const items2 = (await production.get(`/orders/${orderId}`)).data.items;
await production.put(`/orders/${orderId}/production`, { items: items2.map((i) => ({ id: i.id, qty_produced: i.qty })), update_note: 'Assembly complete' });
await production.post(`/orders/${orderId}/stage`, { stage: 'quality_check' });
const packEarly = await production.post(`/orders/${orderId}/stage`, { stage: 'packing' });
log(packEarly.status === 400, 'packing is blocked until quality check passes');
const qc = await quality.put(`/orders/${orderId}/production`, { qc_status: 'passed', qc_remarks: 'Routine tests passed, FAT witnessed' });
log(qc.status === 200, 'quality team passes the QC', qc.data?.error);
await production.post(`/orders/${orderId}/stage`, { stage: 'packing' });
await production.post(`/orders/${orderId}/stage`, { stage: 'ready_for_dispatch' });
log((await production.get(`/orders/${orderId}`)).data.stage === 'ready_for_dispatch', 'order reaches ready for dispatch');

// ---------------------------------------------------------------- 6. partial dispatch, invoice, delivery
const ordForDispatch = (await dispatch.get(`/orders/${orderId}`)).data;
const panelItem = ordForDispatch.items.find((i) => i.qty === 2);
const commItem = ordForDispatch.items.find((i) => i.id !== panelItem.id);
const d1 = await dispatch.post(`/orders/${orderId}/dispatches`, {
  items: [{ order_item_id: panelItem.id, qty: 1 }], dispatch_date: today, transporter: 'VRL Logistics', vehicle_number: 'MH12 AB 1234',
  lr_number: '556677', boxes: 3, eway_bill: '1234 5678 9012', expected_delivery_date: addDays(3), create_invoice: true,
});
log(d1.status === 201, 'dispatch team ships part of the order with an invoice', d1.data?.error);
const afterPartial = (await dispatch.get(`/orders/${orderId}`)).data;
log(afterPartial.dispatch_status === 'partial' && afterPartial.stage === 'ready_for_dispatch', 'partial shipment keeps the order open');
log(afterPartial.invoices === undefined || afterPartial.invoices.length === 0, 'dispatch team sees no invoice data');
const accInvoices = (await accounts.get(`/orders/${orderId}`)).data.invoices;
log(accInvoices.length === 1 && accInvoices[0].total > 0, 'invoice raised for the shipped quantity', JSON.stringify(accInvoices.map((i) => i.total)));
const over = await dispatch.post(`/orders/${orderId}/dispatches`, { items: [{ order_item_id: panelItem.id, qty: 5 }], dispatch_date: today });
log(over.status === 400, 'cannot dispatch more than the pending quantity');
const d2 = await dispatch.post(`/orders/${orderId}/dispatches`, {
  items: [{ order_item_id: panelItem.id, qty: 1 }, { order_item_id: commItem.id, qty: commItem.qty }], dispatch_date: today, transporter: 'VRL Logistics', create_invoice: true,
});
log(d2.status === 201, 'final shipment dispatched', d2.data?.error);
const afterFull = (await dispatch.get(`/orders/${orderId}`)).data;
log(afterFull.stage === 'dispatched', 'order moves to dispatched when everything has shipped');
await dispatch.put(`/dispatches/${d1.data.id}`, { status: 'delivered', delivered_date: today, received_by: 'Store in-charge', received_confirmed: true });
await dispatch.put(`/dispatches/${d2.data.id}`, { status: 'delivered', delivered_date: today, received_by: 'Store in-charge', received_confirmed: true });
log((await dispatch.get(`/orders/${orderId}`)).data.stage === 'delivered', 'order marked delivered when all shipments are delivered');

// ---------------------------------------------------------------- 7. payments
const withPay = (await accounts.get(`/orders/${orderId}`)).data;
const inv = withPay.invoices.find((i) => i.balance > 1);
const overPay = await accounts.post('/payments', { invoice_id: inv.id, amount: inv.balance + 100000, payment_date: today });
log(overPay.status === 400, 'payment beyond the invoice balance is rejected');
const pay = await accounts.post('/payments', { invoice_id: inv.id, amount: inv.balance - 500, tds_amount: 500, payment_date: today, mode: 'neft', reference: 'UTR9911' });
log(pay.status === 201, 'accounts records payment with TDS', pay.data?.error);
const balAfter = (await accounts.get(`/orders/${orderId}`)).data.invoices.find((i) => i.id === inv.id);
log(Math.abs(balAfter.balance) < 1.5, 'invoice balance settles after receipt plus TDS', `balance ${balAfter.balance}`);
const execView = (await exec.get(`/orders/${orderId}`)).data;
log(execView.credit_notes.length === 0 && execView.payments.every((p) => p.tds_amount === undefined), 'sales executive does not see TDS/deduction detail');
const prodView = (await production.get(`/orders/${orderId}`)).data;
log(prodView.grand_total === undefined && prodView.items.every((i) => i.unit_price === undefined), 'production sees quantities but no prices');

// ---------------------------------------------------------------- 8. service
const complaint = await service.post('/complaints', {
  customer_id: lead.customer_id, order_id: orderId, product_id: panel.id, serial_number: `APFC${stamp}`, category: 'hardware_failure',
  severity: 'high', description: 'Contactor chattering on step 3', installation_date: today,
});
log(complaint.status === 201, 'service registers a complaint', complaint.data?.error);
const cid = complaint.data.id;
const earlyResolve = await service.put(`/complaints/${cid}`, { status: 'resolved' });
log(earlyResolve.status === 400, 'cannot resolve a complaint without root cause and resolution');
const resolved = await service.put(`/complaints/${cid}`, { status: 'resolved', root_cause: 'Loose contactor coil connection', resolution_type: 'repair', resolution_notes: 'Retightened and tested' });
log(resolved.status === 200, 'complaint resolved with root cause', resolved.data?.error);
const warranty = (await service.get(`/complaints/${cid}`)).data;
log(warranty.warranty_status === 'in_warranty', 'warranty inferred from installation date and product warranty');

// ---------------------------------------------------------------- 9. customer tracking portal & timeline
const tracking = await anon(`/public/orders/${(await commercial.get(`/orders/${orderId}`)).data.tracking_token}`);
log(tracking.status === 200 && tracking.data.milestones.filter((m) => m.done).length >= 4, 'customer order tracking page shows progress');
log(tracking.data.dispatches.length === 2, 'tracking page lists both shipments');
const timeline = (await exec.get(`/customers/${lead.customer_id}/timeline`)).data;
const kinds = new Set(timeline.map((t) => t.kind));
log(['communication', 'lead', 'quotation', 'order', 'dispatch', 'payment', 'complaint'].every((k) => kinds.has(k)), 'customer timeline spans every module', [...kinds].join(','));

// ---------------------------------------------------------------- 10. scope checks
const otherExec = await login('lakshmi@veritek.example'); // South region
const leak = await otherExec.get(`/leads/${leadId}`);
log(leak.status === 403 || leak.status === 404, 'another region\'s executive cannot open this lead');
const rmLeak = await rm.get(`/leads/${leadId}`);
log(rmLeak.status === 200, 'the regional manager for this region can open it');
const prodLeads = await production.get('/leads');
log(prodLeads.status === 403, 'production has no access to the leads module');

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
