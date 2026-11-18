// End-to-end acceptance journey through the HTTP API, one step per spec requirement:
// customer → enquiry & pipeline → quotation (configurator, discount approval, revision) → customer portal →
// conversion to an order → advance → production & QC → planned and partial dispatch → invoice & receipt with
// TDS → complaint → customer tracking, timeline, QR scan page and role/scope checks.
const BASE = process.env.API || 'http://localhost:4399/api';
let failures = 0;
let checks = 0;
const log = (ok, msg, extra = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? ` — ${extra}` : ''}`);
};

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Veritek@123' }) });
  const b = await r.json();
  if (!b.token) throw new Error(`login failed for ${email}: ${b.error}`);
  const call = async (path, { method = 'GET', body, key } = {}) => {
    const headers = { authorization: `Bearer ${b.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['idempotency-key'] = key;
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  return {
    user: b.user,
    get: (p) => call(p),
    post: (p, body, key) => call(p, { method: 'POST', body: body ?? {}, key }),
    put: (p, body) => call(p, { method: 'PUT', body: body ?? {} }),
  };
}
const anon = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const hasKey = (obj, re) => JSON.stringify(obj).match(re) !== null;

const admin = await login('admin@veritek.example');
const meta = (await admin.get('/meta')).data;
const today = meta.today;
const addDays = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const exec = await login('saurav@veritek.example'); // Sales executive, West
const otherExec = await login('kavya@veritek.example'); // Sales / export executive, Export region
const rm = await login('rsm.west@veritek.example'); // Regional sales manager, West
const coord = await login('coordinator@veritek.example');
const production = await login('production@veritek.example');
const quality = await login('quality@veritek.example');
const dispatch = await login('dispatch@veritek.example');
const accounts = await login('accounts@veritek.example');
const service = await login('service@veritek.example');
const viewer = await login('viewer@veritek.example');
const stamp = Date.now().toString().slice(-6);
const west = meta.regions.find((r) => r.name === 'West');
const unit1 = meta.factories[0];

// ---------------------------------------------------------------- 1. customer master & region
const cust = await exec.post('/customers', {
  company_name: `Journey Test Industries ${stamp}`, country_code: 'IN', city: 'Pune', state: 'Maharashtra', industry: 'Automotive', value_category: 'high_value',
  tags: ['Journey'], interests: [meta.categories[0].id], billing_address: 'Plot 9, MIDC Bhosari, Pune', payment_terms: '30% advance, balance 30 days',
  contacts: [{ name: 'Anil Deshpande', role: 'Purchase Manager', phone: `+91 98${stamp}11`, email: `anil${stamp}@journeytest.example` }], confirm_not_duplicate: true,
});
log(cust.status === 201, 'sales executive creates a customer with master fields', cust.data?.error);
const customerId = cust.data.id;
const profile = (await exec.get(`/customers/${customerId}`)).data;
log(profile.customer.region_id === west.id, 'region inferred from the state (Maharashtra → West)', profile.customer.region_name);
log(profile.customer.owner_id === exec.user.id, 'the creating executive owns the customer');
log(profile.customer.tags.some((t) => t.name === 'Journey') && profile.customer.interests.length === 1, 'tags and product interests saved');
const contactId = profile.contacts[0].id;
const dup = await exec.post('/customers', { company_name: `Journey Test Industries ${stamp}`, country_code: 'IN', contacts: [{ phone: `+91 98${stamp}11` }] });
log(dup.status === 409 && dup.data?.details?.code === 'possible_duplicate', 'a duplicate company is flagged before it is created');

// ---------------------------------------------------------------- 2. enquiry, opportunity & pipeline
const allProducts = (await admin.get('/products?status=active')).data;
let pick = null;
for (const p of allProducts.filter((x) => x.option_count > 0 && x.price_currency === 'INR' && x.standard_price_minor && x.cost_price_minor)) {
  const detail = (await admin.get(`/products/${p.id}`)).data;
  for (const o of detail.options.filter((x) => x.active && x.price_delta_minor >= 0)) {
    const list = p.standard_price_minor + o.price_delta_minor;
    const cost = p.cost_price_minor + o.cost_delta_minor;
    const net = Math.round(list * 0.88);
    const minRatio = (p.min_price_minor || 0) / p.standard_price_minor;
    const min = p.min_price_minor ? Math.round(p.min_price_minor + o.price_delta_minor * minRatio) : 0;
    if ((net - cost) / net > 0.25 && net >= min) {
      pick = { p, o, list };
      break;
    }
  }
  if (pick) break;
}
log(Boolean(pick), 'found a catalogue product with a configurator option', pick ? `${pick.p.code} + ${pick.o.name}` : 'none');
const enq = await exec.post('/enquiries', {
  customer_id: customerId, contact_id: contactId, lines: [{ product_id: pick.p.id, qty: 10, unit: pick.p.default_unit || 'pcs' }], source_code: 'email',
  owner_id: exec.user.id, next: { purpose: 'Respond to enquiry', owner_id: exec.user.id, due_date: today },
}, `journey-enq-${stamp}`);
log(enq.status === 201, 'enquiry captured with a product, source and next action', enq.data?.error);
const enquiryId = enq.data.id;
const enquiry = (await exec.get(`/enquiries/${enquiryId}`)).data;
log(enquiry.enquiry.stage === 'new' && enquiry.tasks.some((t) => t.status === 'open' && t.due_date === today), 'new enquiry has an open follow-up due today');
const opp = await exec.put(`/enquiries/${enquiryId}`, { version: enquiry.enquiry.version, est_value: '150000', est_currency: 'INR', probability: 40, expected_decision_date: addDays(20) });
log(opp.status === 200, 'opportunity value, probability and decision date saved', opp.data?.error);
const board = (await exec.get('/enquiries/pipeline')).data;
const card = board.columns.flatMap((c) => c.cards).find((c) => c.id === enquiryId);
log(card && card.value_minor === 15000000 && card.weighted_minor === 6000000, 'pipeline shows the estimate weighted by probability', card ? `${card.value_minor}/${card.weighted_minor}` : 'missing');

// ---------------------------------------------------------------- 3. quotation: configurator, discount, approval
const lines = [{ product_id: pick.p.id, option_ids: [pick.o.id], qty: 10, discount_pct: 12 }];
const preview = (await exec.post('/quotations/preview', { customer_id: customerId, lines, freight: '1200' })).data;
log(preview.approval_role === 'regional_manager', 'a 12% discount needs regional manager approval', `${preview.approval_role} — ${preview.approval_reasons?.join('; ')}`);
log(preview.lines[0].list_price_minor === pick.list, 'configurator option is priced from the product master');
log(preview.lines[0].cost_price_minor === undefined && preview.totals.margin_pct === undefined, 'cost and margin are hidden from a sales executive');
const adminPreview = (await admin.post('/quotations/preview', { customer_id: customerId, lines })).data;
log(typeof adminPreview.totals.margin_pct === 'number', 'management sees the margin', String(adminPreview.totals.margin_pct));
const qRes = await exec.post('/quotations', { enquiry_id: enquiryId, contact_id: contactId, subject: 'Panel meters for the new press shop', lines, freight: '1200' }, `journey-q-${stamp}`);
log(qRes.status === 201, 'quotation created against the enquiry', qRes.data?.error);
const qid = qRes.data.quotation_id;
const rid = qRes.data.revision_id;
const sendNow = () => ({ sent_at: new Date().toISOString(), channel: 'email', summary: 'Quotation emailed to the purchase manager', validity_date: addDays(20), next: { purpose: 'Follow up quotation', owner_id: exec.user.id, due_date: addDays(2) } });
const early = await exec.post(`/quote-revisions/${rid}/issue`, sendNow());
log(early.status === 409 && early.data?.details?.code === 'approval_required', 'a quotation needing approval cannot be issued yet');
const sub = await exec.post(`/quote-revisions/${rid}/submit`);
log(sub.data?.approval_status === 'pending', 'submitting routes it for approval', sub.data?.error);
log((await exec.get('/approvals')).data.every((a) => !a.can_decide), 'the executive cannot approve their own quotation');
const pending = (await rm.get('/approvals')).data.find((a) => a.entity_id === rid);
log(Boolean(pending?.can_decide), 'the West regional manager sees it in the approval queue');
const rejectNoReason = await rm.post(`/approvals/${pending.id}/decide`, { decision: 'rejected' });
log(rejectNoReason.status === 400, 'rejecting needs a reason');
const decided = await rm.post(`/approvals/${pending.id}/decide`, { decision: 'approved', comments: 'Approved for the volume' });
log(decided.status === 200, 'regional manager approves', decided.data?.error);
const issued = await exec.post(`/quote-revisions/${rid}/issue`, sendNow());
log(issued.status === 200, 'approved revision issued with sent time, channel and follow-up', issued.data?.error);
const afterIssue = (await exec.get(`/enquiries/${enquiryId}`)).data;
log(afterIssue.enquiry.stage === 'quote_sent', 'issuing moves the enquiry to “Quotation sent”');
const editIssued = await exec.put(`/quote-revisions/${rid}`, { lines, version: 99 });
log(editIssued.status === 409, 'an issued revision can no longer be edited');

// ---------------------------------------------------------------- 4. customer link: view, ask for a revision, accept
const quote = (await exec.get(`/quotations/${qid}`)).data;
const portal = await anon(`/public/quotations/${quote.public_token}`);
log(portal.status === 200 && portal.data.totals.grand_total_minor === quote.current.grand_total_minor, 'customer opens the shared quotation link');
log(!hasKey(portal.data, /cost_|margin|min_price/), 'the customer link never shows cost, margin or minimum price');
log(Boolean((await exec.get(`/quotations/${qid}`)).data.current.viewed_at), 'opening the link records that the customer viewed it');
const revise = await anon(`/public/quotations/${quote.public_token}/respond`, { method: 'POST', body: { action: 'revise', name: 'Anil Deshpande', note: 'Please check the price for 10 units' } });
log(revise.status === 200, 'customer asks for a revision through the link', revise.data?.error);
const rev2 = await exec.post(`/quotations/${qid}/revisions`, { change_note: 'Revised price after negotiation' });
log(rev2.status === 201, 'a new draft revision is started from the issued one', rev2.data?.error);
const rev2Detail = (await exec.get(`/quote-revisions/${rev2.data.revision_id}`)).data;
const upd2 = await exec.put(`/quote-revisions/${rev2.data.revision_id}`, { version: rev2Detail.version, lines: [{ ...lines[0], discount_pct: 8 }], change_note: 'Revised price after negotiation' });
log(upd2.status === 200 && upd2.data.approval_role === null, 'an 8% discount is within policy — no approval needed', upd2.data?.error);
const issued2 = await exec.post(`/quote-revisions/${rev2.data.revision_id}/issue`, sendNow());
log(issued2.status === 200, 'revision 2 issued', issued2.data?.error);
const quote2 = (await exec.get(`/quotations/${qid}`)).data;
log(quote2.revisions.find((r) => r.revision_no === 1)?.status === 'superseded' && quote2.revisions.length === 2, 'revision 1 is superseded but kept for comparison');
const accept = await anon(`/public/quotations/${quote.public_token}/respond`, { method: 'POST', body: { action: 'accept', name: 'Anil Deshpande', note: 'PO to follow' } });
log(accept.status === 200, 'customer accepts revision 2 online', accept.data?.error);
const accepted = (await exec.get(`/quotations/${qid}`)).data;
log(accepted.current.status === 'accepted', 'the accepted revision is marked accepted (not yet won)');
log((await exec.get(`/enquiries/${enquiryId}`)).data.enquiry.stage !== 'won', 'accepted is not won until a confirmed order exists');

// ---------------------------------------------------------------- 5. conversion to an order (idempotent)
const convertBody = {
  lines: [{ index: 0, qty: 10, original_commitment_date: addDays(25) }], po_reference: `PO/JT/${stamp}`, po_date: today, received_date: today,
  confirmation_type: 'po', confirm: true, advance_pct: 30, priority: 'high',
};
const convert = await exec.post(`/quote-revisions/${accepted.current.id}/convert`, convertBody, `journey-convert-${stamp}`);
log(convert.status === 201 && convert.data.order_status === 'confirmed', 'accepted revision converted into a confirmed order', convert.data?.error);
const again = await exec.post(`/quote-revisions/${accepted.current.id}/convert`, convertBody, `journey-convert-${stamp}`);
log(again.data?.order_id === convert.data.order_id, 'a retried conversion returns the same order (no duplicate)');
const orderId = convert.data.order_id;
log((await exec.get(`/enquiries/${enquiryId}`)).data.enquiry.stage === 'won', 'the enquiry is won once the confirmed order covers the accepted scope');
const order = (await coord.get(`/orders/${orderId}`)).data;
log(order.order.priority === 'high' && order.order.advance_pct === 30 && order.order.advance_required_minor > 0, 'priority and advance carried into the order');
const hdr = await coord.put(`/orders/${orderId}`, { version: order.order.version, factory_id: unit1.id, production_owner_id: meta.people.find((p) => p.role === 'production')?.id, reason: 'Planned in Unit 1' });
log(hdr.status === 200, 'coordinator assigns the factory and production owner', hdr.data?.error);

// ---------------------------------------------------------------- 6. advance
const adv = await accounts.post(`/finance/orders/${orderId}/advances`, { amount: (order.order.advance_required_minor / 100).toFixed(2), effective_date: today, mode: 'rtgs', reference: `UTR${stamp}` });
log(adv.status === 201, 'accounts records the advance against the order', adv.data?.error);
log(!(await accounts.get('/finance/advances')).data.some((o) => o.id === orderId), 'the order leaves the pending-advance list');

// ---------------------------------------------------------------- 7. production & QC
const prodOrder = (await production.get(`/orders/${orderId}`)).data;
log(prodOrder && !hasKey(prodOrder, /_minor"/), 'production sees the order with quantities and dates but no prices');
let line = prodOrder.lines[0];
const execUpdate = await exec.post(`/order-lines/${line.id}/update`, { version: line.version, phase: 'production' });
log(execUpdate.status === 403, 'a sales executive cannot post production updates');
let up = await production.post(`/order-lines/${line.id}/update`, { version: line.version, phase: 'production', work_status: 'in_progress', forecast_ready_date: addDays(10), forecast_dispatch_date: addDays(12) });
log(up.status === 200, 'production moves the line into production with forecasts', up.data?.error);
line = (await production.get(`/orders/${orderId}`)).data.lines[0];
up = await production.post(`/order-lines/${line.id}/update`, { version: line.version, phase: 'qc', work_status: 'in_progress' });
log(up.status === 200, 'line moves to QC', up.data?.error);
line = (await production.get(`/orders/${orderId}`)).data.lines[0];
const selfPass = await production.post(`/order-lines/${line.id}/update`, { version: line.version, phase: 'ready', work_status: 'phase_complete' });
log(selfPass.status === 400, 'production cannot pass its own QC');
up = await quality.post(`/order-lines/${line.id}/update`, { version: line.version, phase: 'ready', work_status: 'phase_complete', ready_qty: 10, qc_summary: 'Accuracy test passed; IR test OK' });
log(up.status === 200, 'quality passes QC and records the ready quantity', up.data?.error);
const boardRow = (await production.get('/production/board')).data.columns.find((c) => c.phase === 'ready').lines.find((l) => l.order_id === orderId);
log(Boolean(boardRow) && boardRow.qc_summary, 'the production board shows the line ready with its QC summary');

// ---------------------------------------------------------------- 8. planned, actual and partial dispatch
line = (await dispatch.get(`/orders/${orderId}`)).data.lines[0];
const plan = await dispatch.post('/dispatches', { planned: true, planned_date: addDays(1), lines: [{ line_id: line.id, qty: 6 }], carrier: 'VRL Logistics' }, `journey-plan-${stamp}`);
log(plan.status === 201 && plan.data.status === 'planned', 'dispatch plans a shipment', plan.data?.error);
log((await dispatch.get(`/orders/${orderId}`)).data.lines[0].quantities.dispatched === 0, 'a plan changes no balance');
const posted = await dispatch.post(`/dispatches/${plan.data.id}/post`, { dispatch_date: today, vehicle_number: 'MH12 AB 1234', tracking_no: '556677', boxes: 3, eway_bill: '1234 5678 9012' }, `journey-post-${stamp}`);
log(posted.status === 201 && posted.data.status === 'posted', 'the plan is posted once the goods leave', posted.data?.error);
log((await dispatch.get(`/orders/${orderId}`)).data.lines[0].quantities.dispatched === 6, 'posting reduces the balance');
const over = await dispatch.post('/dispatches', { lines: [{ line_id: line.id, qty: 10 }], dispatch_date: today });
log(over.status === 409 && over.data?.details?.code === 'over_dispatch', 'over-dispatch beyond the remaining balance is rejected');
const future = await dispatch.post('/dispatches', { lines: [{ line_id: line.id, qty: 4 }], dispatch_date: addDays(3) });
log(future.status === 400, 'a future date is a plan, not a dispatch');
const final = await dispatch.post('/dispatches', { lines: [{ line_id: line.id, qty: 4 }], dispatch_date: today, carrier: 'VRL Logistics', tracking_no: '556699' }, `journey-final-${stamp}`);
log(final.status === 201, 'final shipment dispatched', final.data?.error);
const afterFull = (await dispatch.get(`/orders/${orderId}`)).data;
log(afterFull.summary.outcome.includes('fully_dispatched'), 'the order is fully dispatched');
const delivered = await dispatch.post(`/dispatches/${final.data.id}/delivered`, { delivered_at: today, received_by_name: 'Store in-charge' });
log(delivered.status === 200, 'delivery recorded with the receiver', delivered.data?.error);
const told = await exec.post(`/dispatches/${final.data.id}/notify`, { channel: 'email' });
log(told.status === 200, 'sales records that the customer was told', told.data?.error);

// ---------------------------------------------------------------- 9. invoice and receipt with TDS
const fin = (await accounts.get(`/finance/orders/${orderId}`)).data;
const taxable = fin.value_minor;
const tax = Math.round(taxable * 0.18);
const gross = taxable + tax;
const advanceIn = fin.advance_received_minor;
const inv = await accounts.post('/finance/invoices', {
  customer_id: customerId, order_id: orderId, dispatch_id: final.data.id, invoice_ref: `INV/JT/${stamp}`, invoice_date: today, due_date: addDays(30), currency: 'INR',
  taxable_amount: (taxable / 100).toFixed(2), tax_amount: (tax / 100).toFixed(2), gross_amount: (gross / 100).toFixed(2), advance_adjusted: (advanceIn / 100).toFixed(2),
});
log(inv.status === 201, 'accounts records the invoice, adjusting the advance', inv.data?.error);
const overAdjust = await accounts.post('/finance/invoices', { customer_id: customerId, order_id: orderId, invoice_ref: `INV/JT/${stamp}-B`, invoice_date: today, due_date: addDays(30), currency: 'INR', gross_amount: '1000.00', advance_adjusted: '900.00' });
log(overAdjust.status === 400, 'the same advance cannot be adjusted twice');
const outstanding = gross - advanceIn;
const tds = Math.round(outstanding * 0.02);
const futureReceipt = await accounts.post(`/finance/invoices/${inv.data.id}/receipts`, { kind: 'receipt', amount: '100.00', effective_date: addDays(2) });
log(futureReceipt.status === 400, 'a receipt cannot be dated in the future (a promise is not a receipt)');
const rcpt = await accounts.post(`/finance/invoices/${inv.data.id}/receipts`, { kind: 'receipt', amount: ((outstanding - tds) / 100).toFixed(2), tds_amount: (tds / 100).toFixed(2), mode: 'neft', effective_date: today, reference: 'UTR9911' });
log(rcpt.status === 201 && rcpt.data.outstanding_minor === 0, 'receipt plus TDS settles the invoice', rcpt.data?.error || `outstanding ${rcpt.data?.outstanding_minor}`);
const execInvoices = (await exec.get(`/finance/invoices?order_id=${orderId}&state=all`)).data;
log(execInvoices.rows.length === 1 && execInvoices.rows[0].tds_minor === undefined, 'a sales executive sees the invoice but not TDS detail');
log((await dispatch.get('/finance/invoices')).status === 403, 'dispatch has no access to the invoice register');

// ---------------------------------------------------------------- 10. complaint & service
const cats = meta.dropdowns.complaint_category.filter((o) => o.active).map((o) => o.code);
const complaint = await service.post('/complaints', {
  customer_id: customerId, order_id: orderId, product_id: pick.p.id, serial_batch: `SN${stamp}`, category_code: cats.includes('display') ? 'display' : cats[0],
  severity: 'high', description: 'Display flickers intermittently', owner_id: service.user.id, next_response_date: addDays(1), installation_date: today,
});
log(complaint.status === 201, 'service registers a complaint against the order', complaint.data?.error);
const cid = complaint.data.id;
let k = (await service.get(`/complaints/${cid}`)).data.complaint;
log(k.warranty_status === 'in_warranty', 'warranty inferred from the installation date and product warranty', k.warranty_status);
const early2 = await service.put(`/complaints/${cid}`, { version: k.version, status: 'resolved' });
log(early2.status === 400, 'a complaint cannot be resolved without the resolution');
const resolved = await service.put(`/complaints/${cid}`, { version: k.version, status: 'resolved', root_cause_code: 'component', resolution_code: 'replacement', resolution_summary: 'Replaced the display module', resolved_date: today });
log(resolved.status === 200, 'complaint resolved with root cause and resolution', resolved.data?.error);
k = (await service.get(`/complaints/${cid}`)).data.complaint;
const rated = await service.put(`/complaints/${cid}`, { version: k.version, feedback_rating: 5, customer_feedback: 'Quick replacement' });
log(rated.status === 200, 'customer feedback rating recorded', rated.data?.error);

// ---------------------------------------------------------------- 11. customer tracking, timeline, QR scan page
const tracking = await anon(`/public/orders/${order.order.tracking_token}`);
log(tracking.status === 200 && tracking.data.dispatches.length === 2 && tracking.data.lines[0].quantities.dispatched === 10, 'customer tracking link shows both shipments and quantities');
log(!hasKey(tracking.data, /_minor|cost|margin/), 'the tracking link shows no commercial values');
const timeline = (await exec.get(`/customers/${customerId}/timeline`)).data;
const groups = new Set(timeline.map((t) => t.group));
log(['enquiries', 'quotations', 'orders'].every((g) => groups.has(g)), 'customer timeline spans enquiries, quotations and orders', [...groups].join(','));
const obj = await admin.post('/objects', { name: `Press shop meter panel ${stamp}`, visibility: 'public', customer_id: customerId, order_id: orderId, serial_number: `SN${stamp}` });
log(obj.status === 201, 'a QR object is created for the delivered panel', obj.data?.error);
const objDetail = (await admin.get(`/objects/${obj.data.id}`)).data;
const code = await admin.post(`/objects/${obj.data.id}/code`, { code_type: 'qr' });
log(code.status === 201 && code.data.permanent_url?.includes(objDetail.public_id), 'a permanent QR code is generated', code.data?.error);
const scan = await anon(`/public/objects/${objDetail.public_id}`);
log(scan.status === 200 && scan.data.state === 'ok', 'scanning the code opens the public object page');

// ---------------------------------------------------------------- 12. roles & scope
const leak = await otherExec.get(`/enquiries/${enquiryId}`);
log(leak.status === 403 || leak.status === 404, 'another region\'s executive cannot open this enquiry');
log((await rm.get(`/enquiries/${enquiryId}`)).status === 200, 'the regional manager for the customer\'s region can open it');
log((await production.get('/enquiries')).status === 403, 'production has no access to enquiries');
log((await viewer.post('/enquiries', { customer_id: customerId })).status === 403, 'read-only management cannot change anything');
const prodProducts = (await production.get('/products')).data;
log(!hasKey(prodProducts, /_minor"/), 'production sees the product list without prices');
log((await exec.get('/admin/users')).status === 403, 'only the super admin manages users');

console.log(failures ? `\n${failures} of ${checks} CHECK(S) FAILED` : `\nALL ${checks} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
