// Single source of truth for workflow stages, statuses, roles and permissions.
// Imported by both the API server and the React client.

const opt = (value, label, color) => ({ value, label, color });

export const LEAD_STAGES = [
  opt('new_enquiry', 'New enquiry', 'slate'),
  opt('contact_attempted', 'Contact attempted', 'slate'),
  opt('requirement_identified', 'Requirement identified', 'blue'),
  opt('technical_discussion', 'Technical discussion', 'blue'),
  opt('sample_shared', 'Sample / catalogue shared', 'indigo'),
  opt('quotation_preparation', 'Quotation preparation', 'indigo'),
  opt('quotation_sent', 'Quotation sent', 'violet'),
  opt('follow_up', 'Follow-up', 'violet'),
  opt('negotiation', 'Negotiation', 'amber'),
  opt('po_expected', 'Purchase order expected', 'amber'),
  opt('order_confirmed', 'Order confirmed', 'green'),
];
// Stage index from which an enquiry counts as a qualified opportunity.
export const OPPORTUNITY_FROM_STAGE = 'requirement_identified';

export const LEAD_STATUSES = [
  opt('open', 'Open', 'blue'),
  opt('won', 'Won', 'green'),
  opt('lost', 'Lost', 'red'),
  opt('on_hold', 'On hold', 'amber'),
];

export const LEAD_TEMPERATURES = [
  opt('hot', 'Hot', 'red'),
  opt('warm', 'Warm', 'amber'),
  opt('cold', 'Cold', 'blue'),
];

export const LEAD_SOURCES = [
  opt('website', 'Website'),
  opt('referral', 'Referral'),
  opt('cold_call', 'Cold call'),
  opt('existing_customer', 'Existing customer'),
  opt('exhibition', 'Exhibition'),
  opt('campaign', 'Event / campaign'),
  opt('indiamart', 'IndiaMART / portal'),
  opt('tender', 'Tender'),
  opt('dealer', 'Dealer / channel partner'),
  opt('email', 'Email enquiry'),
];

export const CUSTOMER_TYPES = [
  opt('dealer', 'Dealer'),
  opt('distributor', 'Distributor'),
  opt('oem', 'OEM'),
  opt('contractor', 'Contractor'),
  opt('consultant', 'Consultant'),
  opt('direct', 'Direct customer'),
  opt('government', 'Government / PSU'),
  opt('system_integrator', 'System integrator'),
  opt('epc', 'EPC'),
];

export const INDUSTRIES = [
  'Automotive', 'Pharma', 'Hospitality', 'Infrastructure', 'Data centre', 'Textiles',
  'Food processing', 'Real estate', 'Utilities', 'Steel & metals', 'Chemicals',
  'Healthcare', 'Education', 'Railways', 'Water treatment', 'Cement', 'Retail',
];

export const CUSTOMER_STATUSES = [
  opt('prospect', 'Prospect', 'blue'),
  opt('active', 'Active', 'green'),
  opt('inactive', 'Inactive', 'slate'),
  opt('blocked', 'Blocked', 'red'),
  opt('lost', 'Lost', 'red'),
];

export const VALUE_CATEGORIES = [
  opt('key_account', 'Key account', 'violet'),
  opt('high_value', 'High value', 'green'),
  opt('regular', 'Regular', 'blue'),
  opt('low_value', 'Low value', 'slate'),
];

export const CONTACT_ROLES = [
  opt('owner', 'Owner / director'),
  opt('purchase', 'Purchase manager'),
  opt('technical', 'Technical contact'),
  opt('accounts', 'Accounts contact'),
  opt('site', 'Site / factory contact'),
  opt('other', 'Other'),
];

export const COMM_CHANNELS = [
  opt('phone', 'Phone'),
  opt('whatsapp', 'WhatsApp'),
  opt('email', 'Email'),
  opt('meeting', 'In person'),
];

export const ACTIVITY_TYPES = [
  opt('call', 'Call', 'blue'),
  opt('whatsapp', 'WhatsApp', 'green'),
  opt('email', 'Email', 'indigo'),
  opt('meeting', 'Physical meeting', 'violet'),
  opt('video', 'Video meeting', 'violet'),
  opt('factory_visit', 'Factory visit', 'amber'),
  opt('sample_delivery', 'Sample delivery', 'amber'),
  opt('requirement', 'Requirement received', 'blue'),
  opt('note', 'Internal note', 'slate'),
];

export const FOLLOWUP_TYPES = [
  opt('call', 'Call'),
  opt('whatsapp', 'WhatsApp'),
  opt('email', 'Email'),
  opt('meeting', 'Meeting'),
  opt('quotation', 'Quotation follow-up'),
  opt('sample_feedback', 'Sample feedback'),
  opt('po_followup', 'PO follow-up'),
  opt('payment', 'Payment collection'),
  opt('reengage', 'Re-engage customer'),
  opt('repeat_order', 'Repeat order'),
  opt('other', 'Other'),
];

export const QUOTATION_STATUSES = [
  opt('draft', 'Draft', 'slate'),
  opt('approval_pending', 'Approval pending', 'amber'),
  opt('approved', 'Approved internally', 'teal'),
  opt('sent', 'Sent', 'blue'),
  opt('viewed', 'Viewed', 'indigo'),
  opt('responded', 'Customer responded', 'violet'),
  opt('revision_requested', 'Revision requested', 'amber'),
  opt('negotiation', 'Negotiation', 'amber'),
  opt('accepted', 'Accepted', 'green'),
  opt('rejected', 'Rejected', 'red'),
  opt('expired', 'Expired', 'slate'),
  opt('converted', 'Converted to order', 'green'),
];
// Quotations the customer is still considering.
export const QUOTE_AWAITING = ['sent', 'viewed', 'responded', 'revision_requested', 'negotiation'];

export const ORDER_STAGES = [
  opt('po_received', 'Purchase order received', 'slate'),
  opt('commercial_verification', 'Commercial verification', 'slate'),
  opt('advance_pending', 'Advance payment pending', 'amber'),
  opt('order_confirmed', 'Order confirmed', 'blue'),
  opt('material_check', 'Material availability check', 'blue'),
  opt('production_scheduled', 'Production scheduled', 'indigo'),
  opt('under_production', 'Under production', 'indigo'),
  opt('quality_check', 'Quality check', 'violet'),
  opt('packing', 'Packing', 'violet'),
  opt('ready_for_dispatch', 'Ready for dispatch', 'teal'),
  opt('dispatched', 'Dispatched', 'teal'),
  opt('delivered', 'Delivered', 'green'),
  opt('installation', 'Installation / commissioning', 'green'),
  opt('closed', 'Order closed', 'green'),
];
export const PRODUCTION_STAGE_KEYS = ['material_check', 'production_scheduled', 'under_production', 'quality_check', 'packing', 'ready_for_dispatch'];

export const PRIORITIES = [
  opt('low', 'Low', 'slate'),
  opt('normal', 'Normal', 'blue'),
  opt('high', 'High', 'amber'),
  opt('urgent', 'Urgent', 'red'),
];

export const MATERIAL_STATUSES = [
  opt('pending', 'Not checked', 'slate'),
  opt('available', 'Available', 'green'),
  opt('partial', 'Partially available', 'amber'),
  opt('shortage', 'Shortage', 'red'),
];

export const QC_STATUSES = [
  opt('pending', 'Pending', 'slate'),
  opt('in_progress', 'In progress', 'blue'),
  opt('passed', 'Passed', 'green'),
  opt('failed', 'Failed', 'red'),
  opt('rework', 'Rework', 'amber'),
];

export const DISPATCH_STATUSES = [
  opt('planned', 'Planned', 'slate'),
  opt('dispatched', 'Dispatched', 'blue'),
  opt('in_transit', 'In transit', 'indigo'),
  opt('delivered', 'Delivered', 'green'),
];

export const PAYMENT_MODES = [
  opt('neft', 'NEFT'), opt('rtgs', 'RTGS'), opt('upi', 'UPI'), opt('cheque', 'Cheque'),
  opt('lc', 'Letter of credit'), opt('cash', 'Cash'),
];

export const COMPLAINT_CATEGORIES = [
  opt('hardware_failure', 'Hardware failure'),
  opt('communication', 'Communication / connectivity'),
  opt('display', 'Display issue'),
  opt('calibration', 'Calibration / accuracy'),
  opt('installation', 'Installation issue'),
  opt('transit_damage', 'Damage in transit'),
  opt('wrong_supply', 'Wrong / short supply'),
  opt('software', 'Software / firmware'),
  opt('other', 'Other'),
];

export const COMPLAINT_STATUSES = [
  opt('open', 'Open', 'red'),
  opt('assigned', 'Assigned', 'amber'),
  opt('site_visit', 'Site visit scheduled', 'amber'),
  opt('in_progress', 'In progress', 'blue'),
  opt('awaiting_parts', 'Awaiting parts', 'violet'),
  opt('resolved', 'Resolved', 'green'),
  opt('closed', 'Closed', 'slate'),
];

export const COMPLAINT_SEVERITIES = [
  opt('low', 'Low', 'slate'),
  opt('medium', 'Medium', 'blue'),
  opt('high', 'High', 'amber'),
  opt('critical', 'Critical', 'red'),
];

export const RESOLUTION_TYPES = [
  opt('repair', 'Repair'), opt('replacement', 'Replacement'), opt('firmware_update', 'Firmware update'),
  opt('reconfiguration', 'Reconfiguration'), opt('training', 'Customer training'), opt('no_fault', 'No fault found'),
];

export const WARRANTY_STATUSES = [
  opt('in_warranty', 'In warranty', 'green'),
  opt('out_of_warranty', 'Out of warranty', 'red'),
  opt('amc', 'Under AMC', 'blue'),
];

export const CAMPAIGN_TYPES = [
  opt('exhibition', 'Exhibition'),
  opt('dealer_meet', 'Dealer meet'),
  opt('product_launch', 'Product launch'),
  opt('webinar', 'Webinar'),
  opt('email_campaign', 'Email campaign'),
  opt('seminar', 'Technical seminar'),
];

export const LOSS_REASONS = [
  'Price too high', 'Lost to competitor', 'Delivery timeline', 'Specification mismatch',
  'Project cancelled / deferred', 'Budget not approved', 'No response from customer', 'Credit terms',
];
export const WIN_REASONS = [
  'Technical superiority', 'Competitive price', 'Faster delivery', 'Existing relationship',
  'Service support', 'Brand reputation', 'Approved vendor',
];

export const COMPETITORS = ['Schneider Electric', 'Secure Meters', 'L&T Electrical', 'Elmeasure', 'Rishabh Instruments', 'Siemens', 'Local assembler'];

// ---------------------------------------------------------------- roles & access
export const ROLES = [
  { value: 'super_admin', label: 'Super Admin', rank: 5, scope: 'all' },
  { value: 'management', label: 'Management', rank: 4, scope: 'all' },
  { value: 'sales_head', label: 'Sales Head', rank: 3, scope: 'all' },
  { value: 'regional_manager', label: 'Regional Sales Manager', rank: 2, scope: 'region' },
  { value: 'sales_executive', label: 'Sales Executive', rank: 1, scope: 'own' },
  { value: 'commercial', label: 'Quotation / Commercial', rank: 1, scope: 'all' },
  { value: 'production', label: 'Production Team', rank: 1, scope: 'factory' },
  { value: 'quality', label: 'Quality Team', rank: 1, scope: 'factory' },
  { value: 'dispatch', label: 'Dispatch Team', rank: 1, scope: 'all' },
  { value: 'accounts', label: 'Accounts Team', rank: 1, scope: 'all' },
  { value: 'service', label: 'Service Team', rank: 1, scope: 'all' },
];

const SALES = ['super_admin', 'management', 'sales_head', 'regional_manager', 'sales_executive'];
const LEADERS = ['super_admin', 'management', 'sales_head'];
const EVERYONE = ROLES.map((r) => r.value);

// Permission -> roles holding it. "view" grants read; "edit" grants write.
export const PERMISSIONS = {
  'dashboard.view': EVERYONE,
  'leads.view': [...SALES, 'commercial'],
  'leads.edit': SALES,
  'customers.view': EVERYONE,
  'customers.edit': [...SALES, 'commercial', 'accounts'],
  'activities.edit': [...SALES, 'commercial', 'accounts', 'service', 'dispatch'],
  'quotations.view': [...SALES, 'commercial', 'accounts'],
  'quotations.edit': [...SALES, 'commercial'],
  'orders.view': EVERYONE,
  'orders.edit': [...SALES, 'commercial'],
  'production.view': EVERYONE,
  'production.edit': ['super_admin', 'management', 'production', 'quality'],
  'quality.edit': ['super_admin', 'management', 'quality'],
  'dispatch.view': EVERYONE,
  'dispatch.edit': ['super_admin', 'management', 'dispatch'],
  'payments.view': [...SALES, 'commercial', 'accounts'],
  'payments.edit': ['super_admin', 'management', 'accounts'],
  // Full finance: TDS/deductions, credit notes, bank references, credit limits.
  'finance.full': ['super_admin', 'management', 'sales_head', 'accounts'],
  // Commercial values (order/quote amounts). Shop-floor roles do not see prices.
  'finance.values': [...SALES, 'commercial', 'accounts'],
  // Cost price and margin.
  'margin.view': [...LEADERS, 'regional_manager', 'commercial'],
  'products.view': EVERYONE,
  'products.edit': ['super_admin', 'management', 'commercial'],
  'campaigns.view': [...SALES, 'commercial'],
  'campaigns.edit': [...LEADERS, 'regional_manager'],
  'complaints.view': EVERYONE,
  'complaints.edit': [...SALES, 'service', 'quality'],
  'reports.view': [...LEADERS, 'regional_manager', 'accounts', 'commercial'],
  'team.view': [...LEADERS, 'regional_manager'],
  'team.edit': ['super_admin'],
  'approvals.decide': ['super_admin', 'management', 'sales_head', 'regional_manager'],
  'settings.edit': ['super_admin'],
  'audit.view': ['super_admin', 'management'],
};

export function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

export function roleRank(role) {
  return ROLES.find((r) => r.value === role)?.rank ?? 0;
}

export function labelOf(list, value) {
  const hit = list.find((o) => (typeof o === 'string' ? o === value : o.value === value));
  if (!hit) return value ? String(value).replace(/_/g, ' ') : '';
  return typeof hit === 'string' ? hit : hit.label;
}

export function colorOf(list, value) {
  return list.find((o) => o.value === value)?.color || 'slate';
}

export function stageIndex(list, value) {
  return list.findIndex((o) => o.value === value);
}

export const DEFAULT_SETTINGS = {
  company: {
    name: 'Veritek Energy Systems Pvt. Ltd.',
    gstin: '27AAHCV4521K1ZQ',
    address: 'Plot 42, MIDC Bhosari, Pune 411026, Maharashtra',
    phone: '+91 20 4012 5500',
    email: 'sales@veritek.example',
    website: 'www.veritek.example',
    currency: 'INR',
    fiscalYearStartMonth: 4,
  },
  approvals: {
    discountManagerPct: 10, // above this -> Regional Sales Manager approval
    discountHeadPct: 18, // above this -> Sales Head approval
    minMarginPct: 22, // below this -> Sales Head approval
    belowMinPriceRole: 'management',
    largeQuotationValue: 2500000, // notify management at or above this grand total
  },
  followups: {
    escalateAfterDays: 2,
    noResponseDays: 7,
    quotationExpiryWarnDays: 3,
    sampleFeedbackDays: 5,
    quotationFollowupDays: 3,
  },
  customers: {
    dormantAfterDays: 180,
  },
  quotation: {
    defaultValidityDays: 30,
    defaultPaymentTerms: '30% advance, balance against proforma before dispatch',
    defaultWarranty: '18 months from supply or 12 months from commissioning, whichever is earlier',
    defaultDelivery: '3-4 weeks from receipt of technically and commercially clear PO',
    freightGstRate: 18,
  },
  automation: {
    enabled: true,
    intervalMinutes: 15,
    autoAssignLeads: true,
    escalateOverdue: true,
    delayWarnings: true,
    paymentReminders: true,
    dormantDetection: true,
    repeatOrderSuggestions: true,
    managementSummaries: true,
  },
};
