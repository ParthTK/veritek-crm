// Read-only sweep: calls every GET endpoint (lists with their filters, details, every report and its records
// and CSV, exports) as several roles against a seeded database and fails on any server error. It catches
// database errors in paths the journey does not walk. Run by tests/run.mjs after the journey.
const BASE = process.env.API || 'http://localhost:4399/api';
let failures = 0;
let calls = 0;
const problems = [];

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Veritek@123' }) });
  const b = await r.json();
  if (!b.token) throw new Error(`login failed for ${email}: ${b.error}`);
  return async (p) => {
    calls++;
    const res = await fetch(BASE + p, { headers: { authorization: `Bearer ${b.token}` } });
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json().catch(() => null) : await res.arrayBuffer();
    if (res.status >= 500) {
      failures++;
      problems.push(`${res.status} ${p} as ${email}: ${body?.error || ''} ${body?.request_id || ''}`);
    }
    return { status: res.status, body };
  };
}

const admin = await login('admin@veritek.example');
const roles = {
  admin,
  sales_exec: await login('saurav@veritek.example'),
  regional: await login('rsm.west@veritek.example'),
  production: await login('production@veritek.example'),
  accounts: await login('accounts@veritek.example'),
  viewer: await login('viewer@veritek.example'),
};

const first = async (p, pick = (b) => b?.rows?.[0]?.id ?? (Array.isArray(b) ? b[0]?.id : null)) => pick((await admin(p)).body);
const ids = {
  customer: await first('/customers'),
  enquiry: await first('/enquiries'),
  quotation: await first('/quotations'),
  order: await first('/orders'),
  task: await first('/tasks'),
  complaint: await first('/complaints'),
  campaign: await first('/campaigns'),
  product: await first('/products'),
  invoice: await first('/finance/invoices?state=all'),
  object: await first('/objects'),
  user: await first('/admin/users'),
  batch: await first('/imports/batches'),
};
const quote = ids.quotation ? (await admin(`/quotations/${ids.quotation}`)).body : null;
const revisionId = quote?.revisions?.[0]?.id || quote?.revision?.id;
const reports = (await admin('/reports')).body;
const reportKeys = (Array.isArray(reports) ? reports : reports?.reports || []).map((r) => r.key).filter(Boolean);

const paths = [
  '/meta', '/auth/me', '/pipeline', '/pipeline?stuck=1', '/pipeline?stage=production', '/enquiries?reply=unreplied', '/quotations?status=pending', '/quotations?status=sent', '/quotations?status=approved', '/dashboard', '/dashboard?period=month', '/dashboard?period=quarter', '/analytics', '/analytics?period=month', '/analytics?period=quarter',
  '/queue', '/queue?tab=mine', '/search?q=pan', '/search?q=SO-', '/notifications', '/alerts', '/summaries', '/approvals', '/data-quality',
  '/customers', '/customers?q=panel', '/customers?type=oem', '/customers?segment=export', '/customers?sort=last_order', '/customers/facets', '/customers/match?name=Apex%20Panels',
  '/contacts', '/contacts?q=a', '/past-customers', '/past-customers?view=all', '/past-customers/metrics',
  '/enquiries', '/enquiries?view=pipeline', '/enquiries?stage=won', '/enquiries?q=VIPS', '/enquiries?sort=received_at&dir=asc', '/enquiries/pipeline', '/enquiries/suggest-owner?customer_id=' + ids.customer,
  '/quotations', '/quotations?status=awaiting', '/quotations?status=draft', '/quotations?status=expiring', '/quotations?status=approval', '/quotations?q=Q-',
  '/orders', '/orders?view=delayed', '/orders?q=SO', '/orders?phase=production', '/order-lines/options', '/production/board', '/dispatches', '/dispatches?q=MH',
  '/finance/overview', '/finance/invoices', '/finance/invoices?state=all', '/finance/invoices?state=overdue', '/finance/receipts', '/finance/advances',
  '/complaints', '/complaints?q=a', '/complaints/insights', '/tasks', '/tasks?scope=team', '/tasks?status=done',
  '/campaigns', '/products', '/products?q=CT', '/products?active=all', '/product-categories', '/objects', '/objects?q=a', '/objects/stats', '/objects/health', '/objects/settings', '/object-categories',
  '/team/members', '/team/targets', '/team/performance', '/team/performance?period=quarter',
  '/admin/users', '/admin/dropdowns', '/admin/masters', '/admin/settings', '/admin/system', '/admin/audit', '/admin/audit?action=sign', '/imports/batches', '/imports/templates',
  '/export/customers.csv', '/export/enquiries.csv', '/export/orders.csv', '/export/quotations.csv', '/admin/export/full.zip',
  ids.customer && `/customers/${ids.customer}`, ids.customer && `/pipeline?customer_id=${ids.customer}`, ids.enquiry && `/pipeline/journey?enquiry_id=${ids.enquiry}`, ids.quotation && `/pipeline/journey?quotation_id=${ids.quotation}`, ids.order && `/pipeline/journey?order_id=${ids.order}`, ids.customer && `/customers/${ids.customer}/timeline`, ids.customer && `/customers/${ids.customer}/activities`, ids.customer && `/customers/${ids.customer}/tasks`, ids.customer && `/customers/${ids.customer}/can-merge`,
  ids.enquiry && `/enquiries/${ids.enquiry}`, ids.quotation && `/quotations/${ids.quotation}`, revisionId && `/quote-revisions/${revisionId}`,
  ids.order && `/orders/${ids.order}`, ids.order && `/finance/orders/${ids.order}`, ids.task && `/tasks/${ids.task}`, ids.complaint && `/complaints/${ids.complaint}`,
  ids.campaign && `/campaigns/${ids.campaign}`, ids.product && `/products/${ids.product}`, ids.invoice && `/finance/invoices/${ids.invoice}`, ids.object && `/objects/${ids.object}`,
  ids.user && `/admin/users/${ids.user}/open-work`, ids.batch && `/imports/batches/${ids.batch}`,
  ...reportKeys.flatMap((k) => [`/reports/${k}`, `/reports/${k}?period=quarter`, `/reports/${k}/records`, `/reports/${k}/export.csv`]),
].filter(Boolean);

for (const p of paths) await admin(p);
// Role-scoped views of the busiest lists and pages.
const scoped = ['/pipeline', '/dashboard', '/dashboard/map', '/analytics', '/queue', '/customers', '/enquiries', '/quotations', '/orders', '/production/board', '/finance/overview', '/finance/invoices', '/tasks', '/team/performance', '/reports', ...reportKeys.slice(0, 8).map((k) => `/reports/${k}`)];
for (const [, call] of Object.entries(roles)) for (const p of scoped) await call(p);

for (const p of problems) console.log(`FAIL ${p}`);
console.log(failures ? `\n${failures} OF ${calls} SWEEP CALLS FAILED` : `\nSWEEP: ALL ${calls} CALLS ANSWERED WITHOUT A SERVER ERROR (${reportKeys.length} reports)`);
process.exit(failures ? 1 : 0);
