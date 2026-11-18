// Single source of truth for roles, permissions, workflow states, dropdown defaults and settings.
// Imported by both the API server and the React client so labels and rules never drift apart.

const opt = (value, label, extra = {}) => ({ value, label, ...extra });

export const COMPANY = { name: 'Veritek Engineering Private Limited', short: 'VERITEK' };

// ------------------------------------------------------------------ people & access
// Each role belongs to one of the specification's role groups (Management/admin, Data coordinator,
// Sales/export, Production/QC, Accounts, Service, Read-only management, named owner without sign-in).
// `scope` limits which customers' records the role sees: all, region (the user's region), own (customers
// and work the user owns) or factory (confirmed orders at the user's factory).
export const ROLES = [
  opt('super_admin', 'Super admin', { group: 'admin', scope: 'all', rank: 6, login: true, description: 'Everything, including settings, users and access. Approves exceptional corrections.' }),
  opt('management', 'Management', { group: 'admin', scope: 'all', rank: 5, login: true, description: 'Views all records and reports, assigns owners, approves quotations and exceptional corrections.' }),
  opt('coordinator', 'Coordinator', { group: 'coordinator', scope: 'all', rank: 3, login: true, description: 'Creates and updates operational records, records updates on behalf of others, imports. Cannot erase history or grant access.' }),
  opt('sales_head', 'Sales head', { group: 'sales', scope: 'all', rank: 4, login: true, description: 'All regions: enquiries, quotations, approvals above the manager threshold, targets.' }),
  opt('regional_manager', 'Regional sales manager', { group: 'sales', scope: 'region', rank: 3, login: true, description: 'Customers in their region: enquiries, quotations and approvals for that region.' }),
  opt('sales_executive', 'Sales', { group: 'sales', scope: 'own', rank: 2, login: true, description: 'Their own customers: enquiries, calls, quotations and customer communication; manages assigned tasks.' }),
  opt('commercial', 'Quotation / commercial', { group: 'sales', scope: 'all', rank: 2, login: true, description: 'Quotations, purchase-order checks and order entry for all customers.' }),
  opt('production', 'Production', { group: 'production', scope: 'factory', rank: 1, login: true, description: 'Updates order readiness, delay reasons and dispatch for their factory. Quantities and dates; commercial values hidden unless allowed.' }),
  opt('quality', 'Quality / QC', { group: 'production', scope: 'factory', rank: 1, login: true, description: 'QC summaries and passing lines from QC to ready. Sees quantities and dates, not prices.' }),
  opt('dispatch', 'Dispatch', { group: 'production', scope: 'all', rank: 1, login: true, description: 'Ready-to-ship lines, dispatch posting, transport details and proof of delivery.' }),
  opt('accounts', 'Accounts', { group: 'accounts', scope: 'all', rank: 2, login: true, description: 'Invoice and receipt register, TDS and deductions, collection follow-ups and payment holds.' }),
  opt('service', 'Service', { group: 'service', scope: 'all', rank: 1, login: true, description: 'Complaints, site visits, root cause and customer feedback.' }),
  opt('viewer', 'Read-only management', { group: 'viewer', scope: 'all', rank: 4, login: true, description: 'Dashboards, profiles and reports. Cannot change anything.' }),
  opt('staff', 'Named owner (no sign-in)', { group: 'staff', scope: 'own', rank: 0, login: false, description: 'A department person who reports updates and owns actions, but does not sign in. The coordinator records on their behalf.' }),
];

export const groupOf = (role) => ROLES.find((r) => r.value === role)?.group || 'staff';
export const scopeOf = (role) => ROLES.find((r) => r.value === role)?.scope || 'own';
export const roleRank = (role) => ROLES.find((r) => r.value === role)?.rank ?? 0;
export const rolesInGroup = (...groups) => ROLES.filter((r) => groups.includes(r.group)).map((r) => r.value);
export const loginRole = (role) => Boolean(ROLES.find((r) => r.value === role)?.login);
// The roles offered when adding a person. The others still work for anyone who already has them.
export const V1_ROLES = ['super_admin', 'management', 'coordinator', 'sales_executive', 'production', 'quality', 'dispatch', 'accounts'];

// The website's WhatsApp product finder: a message to this number from an ACTIVE user with one of these roles
// gets product files instead of the customer chat. The website reads crm.users (phone, role, active) itself,
// with these exact role values, so they are an interface: keep them, the phone column and active = 1 / 0 as
// they are (docs/schema.md). The phone rules are in rules.js (whatsappNumber).
export const PRODUCT_FINDER_ROLES = ['super_admin', 'management'];
export const PRODUCT_FINDER_WHATSAPP = '+91 97694 90155';

export const DEPARTMENTS = [
  opt('management', 'Management'),
  opt('coordination', 'Coordination'),
  opt('sales', 'Sales'),
  opt('export', 'Export'),
  opt('commercial', 'Commercial'),
  opt('production', 'Production'),
  opt('qc', 'Quality / QC'),
  opt('purchase', 'Purchase'),
  opt('dispatch', 'Dispatch'),
  opt('accounts', 'Accounts'),
  opt('service', 'Service'),
];

const ADMIN = ['super_admin', 'management'];
const OPS = [...ADMIN, 'coordinator'];
const SALES = ['sales_head', 'regional_manager', 'sales_executive', 'commercial'];
const COMMERCIAL = [...OPS, ...SALES];
const SHOP = ['production', 'quality', 'dispatch'];
const ALL = ROLES.filter((r) => r.login).map((r) => r.value);
const WORKERS = ALL.filter((r) => r !== 'viewer');

// Permission -> roles holding it. Checked on the server for every operation; the UI only mirrors it.
export const PERMISSIONS = {
  'dashboard.view': ALL,
  'analytics.view': [...ADMIN, 'coordinator', 'viewer', 'sales_head', 'regional_manager', 'commercial', 'accounts'],
  'queue.view': OPS,
  'customers.view': ALL,
  'customers.edit': [...COMMERCIAL, 'accounts'],
  'customers.merge': ADMIN,
  'customers.archive': ADMIN,
  'past.view': [...COMMERCIAL, 'viewer'],
  'past.edit': COMMERCIAL,
  'enquiries.view': [...COMMERCIAL, 'viewer'],
  'enquiries.edit': COMMERCIAL,
  'quotes.view': [...COMMERCIAL, 'accounts', 'viewer'],
  'quotes.edit': COMMERCIAL,
  'quotes.approve': [...ADMIN, 'sales_head', 'regional_manager'],
  'quotes.expired_override': OPS,
  'tasks.edit': WORKERS,
  'tasks.manage_any': [...OPS, 'sales_head'],
  'activities.edit': WORKERS,
  'orders.view': ALL,
  'orders.edit': COMMERCIAL,
  'orders.update': [...OPS, ...SHOP],
  'orders.communicate': COMMERCIAL,
  'orders.amend': [...OPS, 'commercial'],
  'orders.cancel': COMMERCIAL,
  'orders.authorise': ADMIN,
  'qc.pass': [...OPS, 'quality'],
  'dispatch.post': [...OPS, 'production', 'dispatch'],
  'dispatch.override': OPS,
  'dispatch.reverse': ADMIN,
  'values.view': [...COMMERCIAL, 'accounts', 'viewer'],
  'margin.view': [...ADMIN, 'sales_head', 'regional_manager', 'commercial'],
  'finance.full': [...ADMIN, 'sales_head', 'accounts'],
  'reports.view': [...OPS, 'viewer', 'sales_head', 'regional_manager', 'commercial', 'accounts'],
  'export.lists': [...OPS, 'viewer', 'sales_head'],
  'export.full': ADMIN,
  'imports.run': OPS,
  'attachments.upload': WORKERS,
  'finance.view': [...COMMERCIAL, 'accounts', 'viewer'],
  'finance.edit': [...ADMIN, 'accounts'],
  'finance.holds': [...ADMIN, 'accounts'],
  'complaints.view': ALL,
  'complaints.edit': [...COMMERCIAL, 'service', 'quality', 'production'],
  'products.view': ALL,
  'products.edit': [...ADMIN, 'commercial'],
  'campaigns.view': [...COMMERCIAL, 'viewer'],
  'campaigns.edit': [...ADMIN, 'sales_head', 'regional_manager'],
  'objects.view': ALL,
  'objects.edit': WORKERS,
  'objects.manage': ADMIN,
  'team.view': [...OPS, 'viewer', 'sales_head', 'regional_manager'],
  'targets.edit': [...ADMIN, 'sales_head'],
  'users.manage': ['super_admin'],
  'pins.manage': [...ADMIN, 'viewer'],
  'settings.manage': ['super_admin'],
  'audit.view': ADMIN,
};

export const PERMISSION_LABELS = {
  'dashboard.view': 'Overview (exceptions first)', 'analytics.view': 'Sales dashboard', 'queue.view': 'Coordinator work queue',
  'customers.view': 'View customers', 'customers.edit': 'Create / edit customers', 'customers.merge': 'Merge duplicate customers', 'customers.archive': 'Archive customers',
  'past.view': 'Past customers', 'past.edit': 'Reactivation work', 'enquiries.view': 'View enquiries', 'enquiries.edit': 'Create / update enquiries',
  'quotes.view': 'View quotations', 'quotes.edit': 'Build and issue quotations', 'quotes.approve': 'Approve discounts / margins', 'quotes.expired_override': 'Convert an expired quotation',
  'tasks.edit': 'Own follow-ups', 'tasks.manage_any': 'Manage anyone\'s follow-ups', 'activities.edit': 'Record activities',
  'orders.view': 'View orders', 'orders.edit': 'Create / confirm orders', 'orders.update': 'Production updates', 'orders.communicate': 'Record customer communication',
  'orders.amend': 'Amend confirmed quantities / specs', 'orders.cancel': 'Cancel quantities', 'orders.authorise': 'Reopen / undo cancellations',
  'qc.pass': 'Pass QC (QC → ready)', 'dispatch.post': 'Post dispatches', 'dispatch.override': 'Dispatch quantity not recorded as ready', 'dispatch.reverse': 'Reverse a dispatch',
  'values.view': 'See prices and order values', 'margin.view': 'See cost and margin', 'finance.full': 'See TDS, deductions and credit limits',
  'reports.view': 'Reports', 'export.lists': 'Export lists', 'export.full': 'Full data export', 'imports.run': 'Run imports', 'attachments.upload': 'Upload documents',
  'finance.view': 'View invoices and receipts', 'finance.edit': 'Record invoices and receipts', 'finance.holds': 'Payment holds',
  'complaints.view': 'View complaints', 'complaints.edit': 'Handle complaints', 'products.view': 'View products & price list', 'products.edit': 'Edit products & prices',
  'campaigns.view': 'View exhibitions & campaigns', 'campaigns.edit': 'Manage exhibitions & campaigns', 'objects.view': 'View objects & QR', 'objects.edit': 'Edit objects & QR', 'objects.manage': 'Delete objects / templates',
  'team.view': 'Team, approvals & targets', 'targets.edit': 'Set sales targets', 'users.manage': 'Users and access', 'pins.manage': 'Pin records to the overview',
  'settings.manage': 'Settings', 'audit.view': 'Audit trail',
};

export function can(role, permission) {
  return Boolean(PERMISSIONS[permission]?.includes(role));
}

export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

// ------------------------------------------------------------------ enquiries & opportunities
export const ENQUIRY_STAGES = [
  opt('new', 'New', { open: true, tone: 'blue', probability: 10 }),
  opt('clarification', 'Clarification needed', { open: true, tone: 'amber', probability: 15 }),
  opt('quote_to_prepare', 'Quotation to prepare', { open: true, tone: 'violet', probability: 30 }),
  opt('quote_sent', 'Quotation sent', { open: true, tone: 'green', probability: 45 }),
  opt('awaiting_decision', 'Awaiting decision', { open: true, tone: 'amber', probability: 60 }),
  opt('on_hold', 'On hold', { open: true, tone: 'slate', probability: 20 }),
  opt('won', 'Won', { open: false, tone: 'green', probability: 100 }),
  opt('lost', 'Lost', { open: false, tone: 'red', probability: 0 }),
  opt('cancelled', 'Cancelled', { open: false, tone: 'slate', probability: 0 }),
];
export const OPEN_ENQUIRY_STAGES = ENQUIRY_STAGES.filter((s) => s.open).map((s) => s.value);
// The pipeline board shows open stages as columns, in this order.
export const PIPELINE_STAGES = ['new', 'clarification', 'quote_to_prepare', 'quote_sent', 'awaiting_decision', 'on_hold'];

// The whole sales journey. Every live enquiry or order sits at exactly one of these steps.
export const JOURNEY_STAGES = [
  opt('enquiry', 'Enquiry'),
  opt('quotation', 'Quotation'),
  opt('confirmation', 'Confirmation'),
  opt('payment', 'Payment'),
  opt('production', 'Production'),
  opt('dispatch', 'Dispatch'),
];

export const ENQUIRY_LINE_OUTCOMES = [
  opt('open', 'Open', { tone: 'blue' }),
  opt('partial', 'Partly won', { tone: 'amber' }),
  opt('won', 'Won', { tone: 'green' }),
  opt('lost', 'Lost', { tone: 'red' }),
  opt('cancelled', 'Cancelled', { tone: 'slate' }),
];

export const QUOTE_STATUSES = [
  opt('draft', 'Pending', { tone: 'amber' }),
  opt('issued', 'Sent', { tone: 'blue' }),
  opt('accepted', 'Approved', { tone: 'green' }),
  opt('rejected', 'Rejected', { tone: 'red' }),
  opt('superseded', 'Replaced', { tone: 'slate' }),
];

// The four states a quotation is tracked by. "Approved" means the customer approved it; internal discount
// approval is a separate step inside "Pending".
export const QUOTE_TRACKING = [
  opt('pending', 'Pending', { tone: 'amber' }),
  opt('sent', 'Sent', { tone: 'blue' }),
  opt('approved', 'Approved', { tone: 'green' }),
  opt('rejected', 'Rejected', { tone: 'red' }),
];
export const quoteTracking = (status) => ({ draft: 'pending', issued: 'sent', accepted: 'approved', rejected: 'rejected' }[status] || null);

export const APPROVAL_STATUSES = [
  opt('not_required', 'Within policy', { tone: 'green' }),
  opt('required', 'Approval needed', { tone: 'amber' }),
  opt('pending', 'Awaiting approval', { tone: 'amber' }),
  opt('approved', 'Approved', { tone: 'green' }),
  opt('rejected', 'Approval rejected', { tone: 'red' }),
];

export const PRICE_LISTS = [
  opt('standard', 'Standard price'),
  opt('dealer', 'Dealer price'),
  opt('distributor', 'Distributor price'),
];

// ------------------------------------------------------------------ orders
export const ORDER_STATUSES = [
  opt('draft', 'Draft', { tone: 'slate' }),
  opt('confirmed', 'Confirmed', { tone: 'blue' }),
];

export const PRIORITIES = [
  opt('low', 'Low', { tone: 'slate' }),
  opt('normal', 'Normal', { tone: 'blue' }),
  opt('high', 'High', { tone: 'amber' }),
  opt('urgent', 'Urgent', { tone: 'red' }),
];

// Journey phase: broad, never a detailed factory routing. "dispatched" is derived from dispatch records.
export const PHASES = [
  opt('received', 'Order received'),
  opt('production', 'Production'),
  opt('qc', 'QC'),
  opt('ready', 'Ready for dispatch'),
  opt('dispatched', 'Dispatched', { derived: true }),
];
export const SELECTABLE_PHASES = PHASES.filter((p) => !p.derived).map((p) => p.value);

export const WORK_STATUSES = [
  opt('not_started', 'Not started', { tone: 'slate' }),
  opt('in_progress', 'In progress', { tone: 'blue' }),
  opt('on_hold', 'On hold', { tone: 'amber' }),
  opt('phase_complete', 'Complete for current phase', { tone: 'green' }),
];

export const COMMITMENT_STATES = [
  opt('committed', 'Committed dispatch date'),
  opt('uncommitted', 'Not yet agreed (uncommitted)'),
  opt('unknown', 'Unknown (legacy record)'),
];

export const LINE_STATES = [
  opt('overdue', 'Overdue dispatch', { tone: 'red', icon: 'alert' }),
  opt('at_risk', 'Forecast late', { tone: 'amber', icon: 'clock' }),
  opt('issue', 'Issue reported', { tone: 'amber', icon: 'flag' }),
  opt('uncommitted', 'No committed date', { tone: 'violet', icon: 'calendar' }),
  opt('on_track', 'On track', { tone: 'green', icon: 'check' }),
  opt('draft', 'Draft — not confirmed', { tone: 'slate', icon: 'note' }),
  opt('closed', 'Closed', { tone: 'slate', icon: 'check' }),
];

export const OUTCOMES = [
  opt('not_dispatched', 'Not dispatched', { tone: 'slate' }),
  opt('partially_dispatched', 'Partially dispatched', { tone: 'blue' }),
  opt('fully_dispatched', 'Fully dispatched', { tone: 'green' }),
  opt('partially_cancelled', 'Partially cancelled', { tone: 'amber' }),
  opt('fully_cancelled', 'Fully cancelled', { tone: 'red' }),
];

export const COMM_STATES = [
  opt('not_needed', 'No customer update needed', { tone: 'slate' }),
  opt('pending', 'Customer not informed', { tone: 'red' }),
  opt('informed', 'Customer informed', { tone: 'green' }),
];

export const DISPATCH_STATUSES = [
  opt('planned', 'Planned — not dispatched yet', { tone: 'slate' }),
  opt('posted', 'Dispatched', { tone: 'blue' }),
  opt('reversed', 'Reversed (correction)', { tone: 'red' }),
  opt('cancelled', 'Plan cancelled', { tone: 'slate' }),
];

// ------------------------------------------------------------------ tasks, activities & reactivation
export const TASK_STATUSES = [
  opt('open', 'Open', { tone: 'blue' }),
  opt('done', 'Done', { tone: 'green' }),
  opt('cancelled', 'Cancelled', { tone: 'slate' }),
];
export const TASK_KINDS = [
  opt('customer', 'Customer contact'),
  opt('internal', 'Internal action'),
];

export const REACTIVATION_STATUSES = [
  opt('not_reviewed', 'Not reviewed', { tone: 'slate' }),
  opt('to_contact', 'To contact', { tone: 'amber' }),
  opt('contacted', 'Contacted', { tone: 'blue' }),
  opt('opportunity_reopened', 'Opportunity reopened', { tone: 'violet' }),
  opt('won_back', 'Won back', { tone: 'green' }),
  opt('not_pursuing', 'Not pursuing', { tone: 'slate' }),
];

// ------------------------------------------------------------------ customers
export const SEGMENTS = [opt('domestic', 'Domestic'), opt('export', 'Export')];
export const CURRENCIES = ['INR', 'USD', 'EUR', 'AED', 'GBP', 'SAR'];

// [ISO code, name, international dialling code].
export const COUNTRIES = [
  ['IN', 'India', '91'], ['AE', 'United Arab Emirates', '971'], ['SA', 'Saudi Arabia', '966'], ['OM', 'Oman', '968'], ['QA', 'Qatar', '974'], ['KW', 'Kuwait', '965'],
  ['BH', 'Bahrain', '973'], ['KE', 'Kenya', '254'], ['NG', 'Nigeria', '234'], ['TZ', 'Tanzania', '255'], ['EG', 'Egypt', '20'], ['ZA', 'South Africa', '27'],
  ['BD', 'Bangladesh', '880'], ['LK', 'Sri Lanka', '94'], ['NP', 'Nepal', '977'], ['SG', 'Singapore', '65'], ['MY', 'Malaysia', '60'], ['GB', 'United Kingdom', '44'],
  ['US', 'United States', '1'], ['DE', 'Germany', '49'],
].map(([value, label, dial]) => ({ value, label, dial }));
export const dialFor = (country) => COUNTRIES.find((c) => c.value === country)?.dial || null;

// Spelled as the sales regions list them, because a customer's region is worked out from the state.
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
  'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

export const INDUSTRIES = [
  'Panel building', 'Switchgear', 'Automotive', 'Pharma', 'Hospitality', 'Infrastructure', 'Data centre', 'Textiles',
  'Food processing', 'Real estate', 'Utilities', 'Steel & metals', 'Chemicals', 'Healthcare', 'Education',
  'Railways', 'Water treatment', 'Cement', 'Oil & gas', 'Retail',
];

export const VALUE_CATEGORIES = [
  opt('key_account', 'Key account', { tone: 'violet' }),
  opt('high_value', 'High value', { tone: 'green' }),
  opt('regular', 'Regular', { tone: 'blue' }),
  opt('low_value', 'Low value', { tone: 'slate' }),
];

export const CONTACT_ROLES = [
  opt('owner', 'Owner / director'),
  opt('purchase', 'Purchase'),
  opt('technical', 'Technical'),
  opt('accounts', 'Accounts'),
  opt('site', 'Site / factory'),
  opt('other', 'Other'),
];

export const TAG_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet'];

// ------------------------------------------------------------------ products
export const STOCK_TYPES = [
  opt('stock', 'Stock item'),
  opt('made_to_order', 'Made to order'),
];

export const PRODUCT_DOC_TYPES = [
  opt('datasheet', 'Datasheet'),
  opt('manual', 'Manual'),
  opt('certificate', 'Certificate'),
  opt('drawing', 'Drawing'),
  opt('brochure', 'Brochure'),
  opt('other', 'Other'),
];

// ------------------------------------------------------------------ marketing
export const CAMPAIGN_TYPES = [
  opt('exhibition', 'Exhibition'),
  opt('dealer_meet', 'Dealer meet'),
  opt('product_launch', 'Product launch'),
  opt('webinar', 'Webinar'),
  opt('email_campaign', 'Email campaign'),
  opt('seminar', 'Technical seminar'),
];

export const VISIT_OUTCOMES = [
  opt('follow_up', 'Follow-up needed', { tone: 'amber' }),
  opt('enquiry', 'Enquiry raised', { tone: 'green' }),
  opt('no_interest', 'No requirement', { tone: 'slate' }),
];

export const CAMPAIGN_STATUSES = [
  opt('planned', 'Planned', { tone: 'slate' }),
  opt('active', 'Running', { tone: 'blue' }),
  opt('completed', 'Completed', { tone: 'green' }),
  opt('cancelled', 'Cancelled', { tone: 'red' }),
];

export const COMPETITORS = ['Schneider Electric', 'Secure Meters', 'L&T Electrical', 'Elmeasure', 'Rishabh Instruments', 'Siemens', 'Selec', 'Local assembler'];

// ------------------------------------------------------------------ finance (P1)
export const PAYMENT_MODES = [
  opt('neft', 'NEFT'), opt('rtgs', 'RTGS'), opt('upi', 'UPI'), opt('cheque', 'Cheque'),
  opt('lc', 'Letter of credit'), opt('tt', 'Telegraphic transfer'), opt('cash', 'Cash'),
];

export const RECEIPT_KINDS = [
  opt('receipt', 'Receipt'),
  opt('credit', 'Credit note / adjustment'),
  opt('advance', 'Advance against order'),
];

export const AGEING_BUCKETS = [
  opt('current', 'Not yet due'),
  opt('d0_30', '1–30 days overdue'),
  opt('d31_60', '31–60 days overdue'),
  opt('d61_90', '61–90 days overdue'),
  opt('d90_plus', 'Over 90 days overdue'),
];

// ------------------------------------------------------------------ complaints & service (P1)
export const COMPLAINT_STATUSES = [
  opt('new', 'New', { tone: 'red', open: true }),
  opt('assessing', 'Assessing', { tone: 'amber', open: true }),
  opt('awaiting_customer', 'Awaiting customer', { tone: 'violet', open: true }),
  opt('action_in_progress', 'Action in progress', { tone: 'blue', open: true }),
  opt('resolved', 'Resolved', { tone: 'green', open: false }),
  opt('closed', 'Closed', { tone: 'slate', open: false }),
];

export const COMPLAINT_SEVERITIES = [
  opt('low', 'Low', { tone: 'slate' }),
  opt('medium', 'Medium', { tone: 'blue' }),
  opt('high', 'High', { tone: 'amber' }),
  opt('critical', 'Critical', { tone: 'red' }),
];

export const WARRANTY_STATUSES = [
  opt('in_warranty', 'In warranty', { tone: 'green' }),
  opt('out_of_warranty', 'Out of warranty', { tone: 'red' }),
  opt('amc', 'Under AMC', { tone: 'blue' }),
  opt('unknown', 'Not known', { tone: 'slate' }),
];

// ------------------------------------------------------------------ objects & QR codes
export const OBJECT_VISIBILITY = [
  opt('public', 'Public', { tone: 'green' }),
  opt('password', 'Password protected', { tone: 'amber' }),
  opt('private', 'Private (staff only)', { tone: 'red' }),
];

export const OBJECT_STATUSES = [
  opt('active', 'Active', { tone: 'green' }),
  opt('archived', 'Archived', { tone: 'slate' }),
];

/** Field types available when designing an object's custom fields. */
export const FIELD_TYPES = [
  opt('text', 'Text'),
  opt('notes', 'Multiline notes'),
  opt('number', 'Number'),
  opt('date', 'Date'),
  opt('dropdown', 'Dropdown'),
  opt('checkbox', 'Checkbox'),
  opt('url', 'URL'),
  opt('email', 'Email'),
  opt('phone', 'Phone'),
  opt('file', 'File attachment'),
];

export const CODE_TYPES = [
  opt('qr', 'QR code'),
  opt('barcode', 'Barcode (Code 128)'),
];

// ------------------------------------------------------------------ configurable dropdowns
// Stable codes with editable labels. Administrators can rename, add or deactivate values; a value
// that has been used is never hard-deleted. `note` marks values that need a short explanation.
const o = (code, label, extra = {}) => ({ code, label, ...extra });
export const DROPDOWNS = {
  enquiry_source: {
    label: 'Enquiry source / how they found us',
    options: [
      o('existing_customer', 'Existing customer'), o('whatsapp', 'WhatsApp'), o('email', 'Email'),
      o('exhibition', 'Exhibition'), o('field_visit', 'Field visit'), o('dealer_referral', 'Dealer / referral'),
      o('outbound', 'Outbound'), o('online_portal', 'IndiaMART / online portal'), o('tender', 'Tender'), o('campaign', 'Event / campaign'),
      o('other', 'Other', { note: true }), o('unknown', 'Unknown'),
    ],
  },
  lost_reason: {
    label: 'Lost / no-purchase reason',
    options: [
      o('price', 'Price'), o('delivery_time', 'Delivery time'), o('spec_mismatch', 'Specification / feature mismatch'),
      o('certification', 'Certification / approval requirement'), o('competitor', 'Competitor selected'),
      o('project_postponed', 'Project postponed'), o('project_cancelled', 'Project cancelled'),
      o('no_requirement', 'No current requirement'), o('no_response', 'No response'), o('credit_terms', 'Credit / payment terms'),
      o('unknown', 'Unknown'), o('other', 'Other', { note: true }),
    ],
  },
  win_reason: {
    label: 'Win reason',
    options: [
      o('technical', 'Technical superiority'), o('price', 'Competitive price'), o('delivery', 'Faster delivery'), o('relationship', 'Existing relationship'),
      o('service', 'Service support'), o('brand', 'Brand reputation'), o('approved_vendor', 'Approved vendor'), o('other', 'Other', { note: true }),
    ],
  },
  enquiry_cancel_reason: {
    label: 'Enquiry cancellation reason',
    options: [o('withdrawn', 'Withdrawn by customer'), o('duplicate', 'Duplicate enquiry'), o('invalid', 'Invalid / spam'), o('other', 'Other', { note: true })],
  },
  contact_outcome: {
    label: 'Contact outcome',
    options: [
      o('no_answer', 'No answer'), o('callback_requested', 'Requested callback'), o('requirement_confirmed', 'Requirement confirmed'),
      o('quotation_requested', 'Quotation requested'), o('quotation_discussed', 'Quotation discussed'), o('price_concern', 'Price concern'),
      o('delivery_concern', 'Delivery concern'), o('spec_clarification', 'Specification clarification'),
      o('sample_shared', 'Sample / catalogue shared'), o('waiting_for_customer', 'Waiting for customer'), o('order_confirmed', 'Order confirmed'),
      o('not_interested', 'Not interested'), o('other', 'Other', { note: true }),
    ],
  },
  customer_update_outcome: {
    label: 'Customer response to a date change',
    options: [
      o('informed_awaiting', 'Informed — awaiting response'), o('accepted_revised_date', 'Customer accepted revised date'),
      o('requested_earlier', 'Customer requested earlier dispatch'), o('partial_dispatch_agreed', 'Partial dispatch agreed'),
      o('considering_cancellation', 'Customer considering cancellation'), o('customer_cancelled', 'Customer cancelled'),
      o('other', 'Other', { note: true }),
    ],
  },
  delay_reason: {
    label: 'Delay reason',
    options: [
      o('raw_material', 'Raw material shortage'), o('staff_shortage', 'Staff shortage'), o('machine_tool', 'Machine / tool issue'),
      o('technical_clarification', 'Technical clarification'), o('quality_rework', 'Quality / rework issue'),
      o('other_work', 'Other work prioritised'), o('customer_approval', 'Customer approval pending'), o('payment_hold', 'Payment hold'),
      o('other', 'Other', { note: true }),
    ],
  },
  cancel_reason: {
    label: 'Order cancellation reason',
    options: [
      o('customer_cancelled', 'Customer cancelled'), o('project_cancelled', 'Project cancelled'), o('delivery_delay', 'Delivery delay'),
      o('spec_change', 'Specification change'), o('payment_issue', 'Payment issue'), o('duplicate_entry', 'Duplicate entry'),
      o('other', 'Other', { note: true }),
    ],
  },
  reactivation_action: {
    label: 'Reconnect action',
    options: [o('call', 'Call'), o('email', 'Email'), o('revised_quote', 'Revised quote'), o('product_update', 'Product update'), o('ask_feedback', 'Ask for feedback'), o('other', 'Other', { note: true })],
  },
  reactivation_close_reason: {
    label: 'Reason for not pursuing',
    options: [o('no_potential', 'No further potential'), o('business_closed', 'Business closed / moved'), o('do_not_contact', 'Asked not to be contacted'), o('served_by_dealer', 'Served through a dealer'), o('other', 'Other', { note: true })],
  },
  channel: {
    label: 'Contact channel',
    options: [
      o('phone', 'Phone call'), o('whatsapp', 'WhatsApp'), o('email', 'Email'), o('meeting', 'Meeting / visit'),
      o('video', 'Video call'), o('factory_visit', 'Factory visit'), o('exhibition', 'Exhibition'), o('internal', 'Internal note (not customer contact)'), o('other', 'Other', { note: true }),
    ],
  },
  customer_type: {
    label: 'Customer type',
    options: [
      o('manufacturer', 'Manufacturer'), o('oem', 'OEM'), o('panel_builder', 'Panel builder'), o('dealer', 'Dealer'), o('distributor', 'Distributor'),
      o('contractor', 'Contractor'), o('consultant', 'Consultant'), o('system_integrator', 'System integrator'), o('epc', 'EPC'),
      o('government', 'Government / PSU'), o('end_user', 'End user'), o('other', 'Other'),
    ],
  },
  unit: {
    label: 'Unit of measure',
    options: [o('pcs', 'Pieces'), o('set', 'Sets'), o('m', 'Metres'), o('kg', 'Kilograms'), o('lot', 'Lot')],
  },
  order_source: {
    label: 'Direct order source',
    options: [o('repeat_order', 'Repeat order'), o('po_received', 'Purchase order without tracked enquiry'), o('replacement', 'Replacement / warranty'), o('verbal', 'Verbal / phone order'), o('other', 'Other', { note: true })],
  },
  complaint_category: {
    label: 'Complaint category',
    options: [
      o('reading_accuracy', 'Reading / accuracy'), o('display', 'Display'), o('communication', 'Communication'), o('physical_damage', 'Physical damage'),
      o('installation', 'Installation / application'), o('delivery_quantity', 'Delivery / quantity'), o('documentation', 'Documentation'),
      o('other', 'Other', { note: true }),
    ],
  },
  complaint_resolution: {
    label: 'Complaint resolution action',
    options: [
      o('technical_guidance', 'Technical guidance'), o('repair', 'Repair'), o('replacement', 'Replacement'), o('return_accepted', 'Return accepted'),
      o('firmware_update', 'Firmware update / reconfiguration'), o('commercial_resolution', 'Commercial resolution'), o('no_fault', 'No product fault identified'), o('other', 'Other', { note: true }),
    ],
  },
  complaint_root_cause: {
    label: 'Confirmed root cause',
    options: [
      o('component', 'Component failure'), o('workmanship', 'Workmanship'), o('design', 'Design / firmware'), o('transit', 'Transit damage'),
      o('application', 'Application / installation'), o('supplier', 'Supplier material'), o('no_fault', 'No fault found'), o('other', 'Other', { note: true }),
    ],
  },
};

// Next-action presets offered in task forms (free text is always allowed).
export const TASK_PURPOSES = [
  'Respond to enquiry', 'Send quotation', 'Follow up quotation', 'Confirm purchase decision', 'Collect purchase order', 'Clarify specification',
  'Reconnect with customer', 'Ask why they did not proceed', 'Send revised offer', 'Inform customer of revised date',
  'Confirm revised delivery', 'Obtain revised estimate', 'Agree dispatch commitment', 'Share datasheet', 'Sample feedback', 'Call back',
  'Delivery / feedback follow-up', 'Repeat order check', 'Collect payment', 'Release payment hold', 'Site visit',
];

// ------------------------------------------------------------------ settings
export const DEFAULT_SETTINGS = {
  // Version 1 keeps to the daily flow: customer, enquiry, quotation, order, payment, production, dispatch,
  // exhibitions and QR. These finished modules are switched off; their code and data stay, and setting one to
  // true brings it back.
  modules: { workQueue: false, salesDashboard: false, contacts: false, pastCustomers: false, payments: false, complaints: false, reports: false, team: false, adminTools: false },
  company: {
    name: COMPANY.name,
    short: COMPANY.short,
    gstin: '',
    address: '',
    phone: '',
    email: '',
    website: 'www.veritekindia.com',
    currency: 'INR',
    fiscalYearStartMonth: 4,
  },
  calendar: {
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5, 6], // Monday–Saturday; confirm the factory calendar
    holidays: [],
    workStart: '09:30',
    workEnd: '18:30',
  },
  rules: {
    dormantDays: 180,
    staleWorkingDays: 2,
    readyGraceWorkingDays: 1,
    enquiryResponseWorkingDays: 1,
    pipelineQuoteDraftWorkingDays: 2,
    pipelineQuoteDecisionWorkingDays: 5,
    pipelineConfirmationWorkingDays: 2,
    pipelineAdvanceWorkingDays: 3,
    escalateAfterWorkingDays: 1,
    reactivationDailyCapPerOwner: 5,
    noteMaxLength: 1000,
  },
  reminders: {
    quotationFollowupWorkingDays: 3,
    quotationExpiryWarnDays: 3,
    sampleFeedbackDays: 5,
    repeatOrderEnabled: false,
    repeatOrderMinOrders: 2,
    paymentReminderDays: 0,
    managementSummaries: false,
  },
  access: {
    salesScope: 'own', // 'own' | 'all' — sales executives; management and coordinator always see everything
    coordinatorMode: false, // when on, the source person is required for an update entered on someone's behalf
    productionSeesValues: false,
    dncPolicy: 'warn', // 'warn' | 'block' outreach to do-not-contact customers
    autoAssignEnquiries: true, // default enquiry owner from assignment rules when none is chosen
  },
  approvals: {
    enabled: false, // internal approval of discounts and margins before a quotation goes out
    discountManagerPct: 10, // above this -> Regional sales manager approval
    discountHeadPct: 18, // above this -> Sales head approval
    minMarginPct: 22, // below this -> Sales head approval
    belowMinPriceRole: 'management',
    largeQuotationValue: 2500000, // INR: notify management at or above this value
    requireBeforeIssue: true, // a revision needing approval cannot be issued until approved
  },
  quotation: {
    defaultValidityDays: 30,
    defaultPaymentTerms: '30% advance, balance against proforma before dispatch',
    defaultWarranty: '18 months from supply or 12 months from commissioning, whichever is earlier',
    defaultDelivery: '3-4 weeks from receipt of technically and commercially clear PO',
    freightGstRate: 18,
  },
  objects: {
    publicBaseUrl: '',
    labelShowName: true,
    labelShowId: true,
    labelShowCompany: true,
    brandColor: '#3f1069',
    archivedMessage: 'This item has been archived and is no longer published.',
  },
  escalation: { defaultManagerId: null },
  finance: { asOf: null, reconciliation: 'not_reconciled', source: 'Manual entry' },
  scheduler: { enabled: true, intervalMinutes: 15 },
  backup: { enabled: true, keep: 14, hour: 2 },
};

// ------------------------------------------------------------------ helpers
export function labelOf(list, value) {
  if (value === null || value === undefined || value === '') return '';
  const hit = list.find((x) => (typeof x === 'string' ? x === value : (x.value ?? x.code) === value));
  if (!hit) return String(value).replace(/_/g, ' ');
  return typeof hit === 'string' ? hit : hit.label;
}

export function toneOf(list, value) {
  return list.find((x) => (x.value ?? x.code) === value)?.tone || 'slate';
}
