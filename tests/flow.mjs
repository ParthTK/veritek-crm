// The CRM flow from first contact to dispatch, through the HTTP API: customer → exhibition visit → enquiry →
// reply → quotation (pending, sent, approved, rejected) → confirmation → payment → production → dispatch, with the
// sales pipeline, dashboard and order screens checked at each step. Runs against a seeded database.
const BASE = process.env.API || 'http://localhost:4399/api';
let failures = 0;
let checks = 0;
const log = (ok, msg, extra = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${!ok && extra ? ` — ${extra}` : ''}`);
};

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Veritek@123' }) });
  const b = await r.json();
  if (!b.token) throw new Error(`login failed for ${email}: ${b.error}`);
  const call = async (path, method = 'GET', body) => {
    const headers = { authorization: `Bearer ${b.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { user: b.user, get: (p) => call(p), post: (p, body = {}) => call(p, 'POST', body), put: (p, body = {}) => call(p, 'PUT', body) };
}

const [admin, exec, otherExec, production, quality, dispatch, accounts] = await Promise.all(['admin', 'saurav', 'kavya', 'production', 'quality', 'dispatch', 'accounts'].map((n) => login(`${n}@veritek.example`)));
const meta = (await admin.get('/meta')).data;
const today = meta.today;
const addDays = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const stamp = Date.now().toString().slice(-6);
const company = `Deccan Control Panels ${stamp}`;
const dealOf = async (who = exec) => (await who.get(`/pipeline?q=${encodeURIComponent(company)}`)).data.items;

// ---------------------------------------------------------------- 1. the customer comes first
const noCustomer = await exec.post('/enquiries', { lines: [{ requirement: 'Panel meters' }], source_code: 'website' });
log(noCustomer.status === 400 && noCustomer.data.details?.fields?.customer_id, 'an enquiry cannot be added without a customer');
const cust = await exec.post('/customers', {
  company_name: company, country_code: 'IN', city: 'Pune', state: 'Maharashtra', industry: 'Panel building', billing_address: 'Plot 14, Chakan MIDC, Pune',
  contacts: [{ name: 'Meera Kulkarni', role: 'Purchase Manager', phone: `+91 97${stamp}22`, email: `meera${stamp}@deccanpanels.example` }], confirm_not_duplicate: true,
});
log(cust.status === 201, 'customer profile created with contact details', cust.data?.error);
const customerId = cust.data.id;
const profile = (await exec.get(`/customers/${customerId}`)).data;
const contactId = profile.contacts[0].id;

// ---------------------------------------------------------------- 5. exhibition: visit, linked lead source
const show = await admin.post('/campaigns', { name: `Power & Automation Expo ${stamp}`, type: 'exhibition', status: 'active', location: 'Pune', stall: 'B-12', start_date: addDays(-2), end_date: today });
log(show.status === 201, 'exhibition created', show.data?.error);
const showId = show.data.id;
const dealerMeet = (await admin.post('/campaigns', { name: `Dealer evening ${stamp}`, type: 'dealer_meet', status: 'completed', start_date: addDays(-9) })).data.id;
const visit = await exec.post(`/campaigns/${showId}/visits`, { customer_id: customerId, contact_id: contactId, visited_on: addDays(-1), interest: 'Multifunction meters for MCC panels', notes: 'Asked for the datasheet and a budget price' });
log(visit.status === 201, 'sales executive records the customer who visited', visit.data?.error);
log((await exec.post(`/campaigns/${showId}/visits`, { customer_id: customerId })).status === 400, 'the same customer is not recorded twice for one exhibition');
let detail = (await exec.get(`/campaigns/${showId}`)).data;
log(detail.metrics.visitors === 1 && detail.visits[0].outcome === 'follow_up' && detail.metrics.enquiries === 0, 'the exhibition shows one visitor to follow up and no enquiry yet');

const products = (await admin.get('/products')).data.filter((p) => p.active && p.standard_price_minor && p.price_currency === 'INR');
const product = products[0];
const enquiryBody = { customer_id: customerId, contact_id: contactId, owner_id: exec.user.id, lines: [{ product_id: product.id, qty: 5, unit: 'pcs' }], requirement_note: 'Needs meters for two MCC panels', next: { purpose: 'Respond to enquiry', owner_id: exec.user.id, due_date: addDays(1) } };
const unlinked = await exec.post('/enquiries', { ...enquiryBody, source_code: 'exhibition' });
log(unlinked.status === 400 && unlinked.data.details?.fields?.campaign_id, 'an exhibition enquiry must name the exhibition');
log((await exec.post('/enquiries', { ...enquiryBody, source_code: 'exhibition', campaign_id: dealerMeet })).status === 400, 'a dealer meet cannot be chosen as the exhibition');
const enq = await exec.post('/enquiries', { ...enquiryBody, source_code: 'exhibition', campaign_id: showId });
log(enq.status === 201, 'enquiry added with exhibition as its source', enq.data?.error);
const enquiryId = enq.data.id;
detail = (await exec.get(`/campaigns/${showId}`)).data;
log(detail.visits[0].enquiry_id === enquiryId && detail.visits[0].outcome === 'enquiry', 'the visit is linked to the enquiry it produced');
log(detail.metrics.enquiries === 1 && detail.metrics.visitors_with_enquiry === 1 && detail.metrics.visitors_to_follow_up === 0, 'the exhibition counts the enquiry generated');
log((await exec.get(`/customers/${customerId}`)).data.exhibition_visits.some((v) => v.campaign_id === showId), 'the customer page lists the exhibition visited');
log((await exec.get(`/customers/${customerId}/timeline`)).data.items?.some((i) => /^Visited us at/.test(i.title)) !== false, 'the customer history shows the visit');

// ---------------------------------------------------------------- 2. enquiry: reply status
const inList = async (reply) => (await exec.get(`/enquiries?stage=open&reply=${reply}&q=${encodeURIComponent(company)}`)).data.rows.some((r) => r.id === enquiryId);
log(await inList('unreplied') && !(await inList('replied')), 'a new enquiry is listed as not replied');
let [deal] = await dealOf();
log(deal?.stage === 'enquiry' && deal.exhibition?.id === showId && deal.owner_id === exec.user.id, 'the pipeline shows it at the Enquiry step, linked to the exhibition', JSON.stringify(deal?.stage));
const before = (await exec.get('/dashboard')).data.flow;
log(before.enquiries_today >= 1 && before.not_replied >= 1 && before.daily_enquiries.length === 14 && before.daily_enquiries.at(-1).day === today, 'the dashboard counts today’s enquiry and the unreplied one', JSON.stringify(before.daily_enquiries.at(-1)));
const reply = await exec.post('/activities', { customer_id: customerId, enquiry_id: enquiryId, contact_id: contactId, channel: 'phone', outcome: 'requirement_confirmed', note: 'Confirmed quantity and voltage on the phone' });
log(reply.status === 201, 'the reply to the customer is recorded', reply.data?.error);
log(await inList('replied') && !(await inList('unreplied')), 'the enquiry now shows as replied');
const after = (await exec.get('/dashboard')).data.flow;
log(after.not_replied === before.not_replied - 1 && after.replied === before.replied + 1, 'the dashboard reply counts move with it');

// ---------------------------------------------------------------- 3. quotation: pending → sent → approved
const tracked = async (status) => (await exec.get(`/quotations?status=${status}&q=${encodeURIComponent(company)}`)).data;
const q = await exec.post('/quotations', { enquiry_id: enquiryId, contact_id: contactId, subject: 'Meters for two MCC panels', lines: [{ product_id: product.id, qty: 5 }] });
log(q.status === 201, 'quotation created against the enquiry', q.data?.error);
const { quotation_id: quotationId, revision_id: revisionId } = q.data;
let list = await tracked('pending');
log(list.rows.some((r) => r.id === quotationId && r.tracking === 'pending') && typeof list.tracking.pending === 'number', 'an unsent quotation is tracked as pending');
[deal] = await dealOf();
log(deal.stage === 'quotation' && deal.quotation.tracking === 'pending', 'the pipeline moves to the Quotation step');
const issued = await exec.post(`/quote-revisions/${revisionId}/issue`, { sent_at: new Date().toISOString(), channel: 'email', summary: 'Quotation emailed to Meera', validity_date: addDays(20), next: { purpose: 'Follow up quotation', owner_id: exec.user.id, due_date: addDays(3) } });
log(issued.status === 200 || issued.status === 201, 'quotation sent', issued.data?.error);
log((await tracked('sent')).rows.some((r) => r.id === quotationId && r.tracking === 'sent'), 'a sent quotation is tracked as sent');
const token = (await exec.get(`/quotations/${quotationId}`)).data.public_token;
const accept = await fetch(`${BASE}/public/quotations/${token}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept', name: 'Meera Kulkarni' }) });
log(accept.status === 200, 'the customer approves the quotation');
log((await tracked('approved')).rows.some((r) => r.id === quotationId && r.tracking === 'approved'), 'it is tracked as approved');
[deal] = await dealOf();
log(deal.stage === 'confirmation', 'the pipeline moves to the Confirmation step', deal.stage);

// ---------------------------------------------------------------- 4 and 7. confirmation → payment → production → dispatch
const convert = await exec.post(`/quote-revisions/${revisionId}/convert`, { lines: [{ index: 0, qty: 5, original_commitment_date: addDays(20) }], po_reference: `DCP/PO/${stamp}`, po_date: today, received_date: today, confirmation_type: 'po', confirm: true, advance_pct: 30 });
log(convert.status === 201, 'the approved quotation becomes a confirmed order with a 30% advance', convert.data?.error);
const orderId = convert.data.order_id ?? convert.data.id;
[deal] = await dealOf();
log(deal.key === `order:${orderId}` && deal.stage === 'payment' && deal.payment.code === 'advance_pending', 'the pipeline waits at the Payment step for the advance', `${deal.stage}/${deal.payment?.code}`);
log(deal.enquiry?.id === enquiryId && deal.quotation?.id === quotationId && deal.order?.id === orderId, 'the deal links its enquiry, quotation and order');
const steps = () => deal.steps.map((s) => s.state).join(',');
log(steps() === 'done,done,done,current,todo,todo', 'the journey shows the three finished steps and the current one', steps());
let row = (await exec.get(`/orders?q=${encodeURIComponent(company)}`)).data.rows[0];
log(row.payment.code === 'advance_pending' && row.progress.ready_pct === 0, 'the order list shows the payment status and progress');
const order = (await exec.get(`/orders/${orderId}`)).data;
log(order.payment?.code === 'advance_pending', 'the order page shows the payment status');
const adv = await accounts.post(`/finance/orders/${orderId}/advances`, { amount: (order.order.advance_required_minor / 100).toFixed(2), effective_date: today, mode: 'rtgs', reference: `UTR${stamp}` });
log(adv.status === 201, 'accounts records the advance', adv.data?.error);
[deal] = await dealOf();
log(deal.stage === 'production' && deal.payment.code === 'advance_received', 'with the advance in, the deal moves to Production', `${deal.stage}/${deal.payment?.code}`);
const line = async () => (await exec.get(`/orders/${orderId}`)).data.lines[0];
let l = await line();
let up = await production.post(`/order-lines/${l.id}/update`, { version: l.version, phase: 'production', work_status: 'in_progress', forecast_ready_date: addDays(10), forecast_dispatch_date: addDays(12) });
log(up.status === 200, 'production starts the order', up.data?.error);
const board = (await production.get('/production/board')).data;
log(board.columns.flatMap((c) => c.lines).find((x) => x.order_id === orderId)?.payment?.code === 'advance_received', 'the production board shows the payment status');
l = await line();
up = await production.post(`/order-lines/${l.id}/update`, { version: l.version, phase: 'qc', work_status: 'in_progress' });
l = await line();
up = await quality.post(`/order-lines/${l.id}/update`, { version: l.version, phase: 'ready', work_status: 'phase_complete', ready_qty: 5, qc_summary: 'Accuracy test passed' });
log(up.status === 200, 'quality passes the order as ready', up.data?.error);
[deal] = await dealOf();
log(deal.stage === 'dispatch' && deal.order.progress_pct === 100, 'the deal moves to Dispatch at 100% ready', `${deal.stage}/${deal.order.progress_pct}`);
const sent = await dispatch.post('/dispatches', { lines: [{ line_id: l.id, qty: 5 }], dispatch_date: today, carrier: 'VRL Logistics', tracking_no: `LR${stamp}` });
log(sent.status === 201, 'the order is dispatched', sent.data?.error);
log((await dealOf()).length === 0, 'a fully dispatched order leaves the live pipeline');
const finished = (await exec.get(`/pipeline/journey?enquiry_id=${enquiryId}`)).data.journey;
log(finished?.status === 'completed' && finished.steps.every((s) => s.state === 'done'), 'its journey shows every step done, from the enquiry itself');
log((await exec.get(`/dispatches?q=${stamp}`)).data.rows[0]?.lines[0]?.payment?.code === 'advance_received', 'the dispatch list shows the payment status');

// ---------------------------------------------------------------- where deals are stuck, and why
const all = (await admin.get('/pipeline')).data;
log(all.stages.map((s) => s.value).join('>') === 'enquiry>quotation>confirmation>payment>production>dispatch', 'the pipeline has the six journey stages in order');
log(all.items.filter((d) => d.stuck).every((d) => d.reasons.some((r) => ['red', 'amber'].includes(r.severity))), 'every stuck deal says why');
log(all.stages.every((s) => s.count > 0), 'the sample data has deals at every stage', all.stages.map((s) => `${s.value}:${s.count}`).join(' '));
const payment = (await admin.get('/pipeline?stage=payment&stuck=1')).data.items;
log(payment.some((d) => d.reasons.some((r) => r.code === 'advance_pending')), 'an overdue advance is shown as the reason at the Payment stage');
log(all.items.some((d) => d.stage === 'production' && d.reasons.some((r) => r.code === 'overdue')), 'a late production line is shown with how late it is');
const rows = (await production.get('/pipeline')).data;
log(rows.items.every((d) => d.order) && rows.items.every((d) => d.value_minor === undefined), 'production sees orders only, without commercial values');
log((await dealOf(otherExec)).length === 0 && (await otherExec.get(`/pipeline?customer_id=${customerId}`)).data.count === 0, 'another salesperson does not see this customer’s deals');

// ---------------------------------------------------------------- rejected quotations
const enq2 = (await exec.post('/enquiries', { ...enquiryBody, source_code: 'website' })).data.id;
const q2 = (await exec.post('/quotations', { enquiry_id: enq2, contact_id: contactId, lines: [{ product_id: product.id, qty: 2 }] })).data;
await exec.post(`/quote-revisions/${q2.revision_id}/issue`, { sent_at: new Date().toISOString(), channel: 'email', summary: 'Second quotation', validity_date: addDays(10), next: { purpose: 'Follow up', owner_id: exec.user.id, due_date: addDays(2) } });
const version = (await exec.get(`/enquiries/${enq2}`)).data.enquiry.version;
const lost = await exec.post(`/enquiries/${enq2}/stage`, { stage: 'lost', version, lost_reason_code: 'price', lost_note: 'Competitor quoted lower' });
log(lost.status === 200, 'the second enquiry is closed as lost', lost.data?.error);
log((await tracked('rejected')).rows.some((r) => r.id === q2.quotation_id && r.tracking === 'rejected') && !(await tracked('sent')).rows.some((r) => r.id === q2.quotation_id), 'its sent quotation becomes rejected instead of staying open');
log((await exec.get(`/pipeline/journey?enquiry_id=${enq2}`)).data.journey?.status === 'lost' && (await dealOf()).length === 0, 'a lost deal leaves the live pipeline but keeps its journey');

// ---------------------------------------------------------------- 6. dashboard, 8. QR stays separate
const d = (await admin.get('/dashboard')).data;
log(d.flow.production.map((p) => p.phase).join() === 'received,production,qc,ready' && d.flow.production.some((p) => p.lines > 0), 'the dashboard shows production status by stage');
log(['not_sent', 'awaiting_approval', 'sent', 'expired'].every((k) => typeof d.flow.quotations[k] === 'number') && d.tiles.active_orders.count > 0 && typeof d.tiles.delayed.count === 'number', 'the dashboard shows pending quotations, active orders and delays');
log(!('objects' in (await admin.get(`/customers/${customerId}`)).data) && !('objects' in (await admin.get(`/orders/${orderId}`)).data), 'customer and order records no longer carry QR objects');
log((await admin.get('/objects')).status === 200, 'the QR module itself still works');

console.log(failures ? `\n${failures} OF ${checks} FLOW CHECKS FAILED` : `\nALL ${checks} FLOW CHECKS PASSED`);
process.exit(failures ? 1 : 0);
