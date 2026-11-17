-- Veritek CRM — Customer & Order Control System: initial schema.
-- Conventions: instants are ISO-8601 UTC text; business dates are 'YYYY-MM-DD' text; money is INTEGER
-- minor units with an explicit ISO currency; quantities are REAL rounded to 3 decimals in the service layer.
-- History tables are append-only: no API deletes from them.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- ------------------------------------------------------------------ organisation masters
CREATE TABLE regions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  states TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE factories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ people
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'staff',
  department TEXT,
  designation TEXT,
  branch TEXT,
  region_id INTEGER REFERENCES regions(id),
  factory_id INTEGER REFERENCES factories(id),
  login_enabled INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  values_access INTEGER NOT NULL DEFAULT 0,
  manager_id INTEGER REFERENCES users(id),
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  deactivated_at TEXT,
  deactivated_by INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Monthly sales targets (INR by default; achievement is compared in the same currency only).
CREATE TABLE sales_targets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  amount_minor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by INTEGER,
  UNIQUE (user_id, month, currency)
);

-- ------------------------------------------------------------------ configuration
CREATE TABLE dropdown_options (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  requires_note INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category, code)
);

-- ------------------------------------------------------------------ product master & price list
-- A category is the "product family" used by filters and reports (products.family mirrors its name).
CREATE TABLE product_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  model TEXT,
  category_id INTEGER REFERENCES product_categories(id),
  family TEXT,
  description TEXT,
  specs TEXT,
  default_unit TEXT NOT NULL DEFAULT 'pcs',
  integer_qty INTEGER NOT NULL DEFAULT 1,
  spec_hint TEXT,
  hsn TEXT,
  price_currency TEXT NOT NULL DEFAULT 'INR',
  standard_price_minor INTEGER,
  dealer_price_minor INTEGER,
  distributor_price_minor INTEGER,
  min_price_minor INTEGER,
  cost_price_minor INTEGER,
  gst_rate REAL NOT NULL DEFAULT 18,
  warranty_months INTEGER,
  lead_time_days INTEGER,
  stock_type TEXT NOT NULL DEFAULT 'made_to_order',
  stock_qty REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (min_price_minor IS NULL OR standard_price_minor IS NULL OR min_price_minor <= standard_price_minor)
);
CREATE INDEX ix_products_category ON products(category_id);

-- Configurator options: choosing one adjusts list price, cost and lead time.
CREATE TABLE product_options (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta_minor INTEGER NOT NULL DEFAULT 0,
  cost_delta_minor INTEGER NOT NULL DEFAULT 0,
  lead_time_delta INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_product_options ON product_options(product_id);

-- Datasheets, manuals, certificates: an uploaded file or an external link.
CREATE TABLE product_documents (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  doc_type TEXT NOT NULL DEFAULT 'datasheet',
  title TEXT NOT NULL,
  url TEXT,
  attachment_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_product_documents ON product_documents(product_id);

-- ------------------------------------------------------------------ marketing
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'exhibition',
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  cost_minor INTEGER,
  cost_currency TEXT NOT NULL DEFAULT 'INR',
  target_leads INTEGER,
  stall TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  description TEXT,
  owner_id INTEGER REFERENCES users(id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ customers & contacts
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  country_code TEXT,
  state TEXT,
  city TEXT,
  pincode TEXT,
  region_id INTEGER REFERENCES regions(id),
  segment TEXT,
  types TEXT NOT NULL DEFAULT '[]',
  industry TEXT,
  value_category TEXT,
  gstin TEXT,
  website TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  owner_id INTEGER REFERENCES users(id),
  preferred_channel TEXT,
  contact_notes TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  dnc_reason TEXT,
  dnc_source TEXT,
  dnc_date TEXT,
  acquisition_source TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  payment_terms TEXT,
  payment_terms_days INTEGER,
  credit_limit_minor INTEGER,
  credit_currency TEXT,
  credit_hold INTEGER NOT NULL DEFAULT 0,
  credit_hold_reason TEXT,
  external_source TEXT,
  external_account_id TEXT,
  legacy_first_order_date TEXT,
  legacy_last_order_date TEXT,
  legacy_order_count INTEGER,
  legacy_source TEXT,
  notes TEXT,
  archived_at TEXT,
  archived_reason TEXT,
  merged_into_id INTEGER REFERENCES customers(id),
  import_batch_id INTEGER,
  source_confidence TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_customers_external ON customers(external_source, external_account_id) WHERE external_account_id IS NOT NULL;
CREATE INDEX ix_customers_owner ON customers(owner_id);
CREATE INDEX ix_customers_name ON customers(name_norm);
CREATE INDEX ix_customers_region ON customers(region_id);

CREATE TABLE customer_aliases (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'name',
  created_at TEXT NOT NULL,
  created_by INTEGER
);
CREATE INDEX ix_aliases_norm ON customer_aliases(alias_norm);
CREATE INDEX ix_aliases_customer ON customer_aliases(customer_id);

CREATE TABLE duplicate_dismissals (
  customer_a INTEGER NOT NULL,
  customer_b INTEGER NOT NULL,
  reason TEXT,
  decided_by INTEGER,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (customer_a, customer_b)
);

-- Product families a customer is interested in (segmentation and outreach lists).
CREATE TABLE customer_interests (
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  category_id INTEGER NOT NULL REFERENCES product_categories(id),
  PRIMARY KEY (customer_id, category_id)
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT 'slate'
);

CREATE TABLE taggings (
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (tag_id, entity, entity_id)
);
CREATE INDEX ix_taggings_entity ON taggings(entity, entity_id);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT,
  role TEXT,
  contact_role TEXT,
  phone_raw TEXT,
  phone_norm TEXT,
  whatsapp_raw TEXT,
  email_raw TEXT,
  email_norm TEXT,
  preferred_channel TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_contacts_customer ON contacts(customer_id);
CREATE INDEX ix_contacts_phone ON contacts(phone_norm);
CREATE INDEX ix_contacts_email ON contacts(email_norm);

-- Default enquiry owner by region and/or product family (first matching active rule by priority).
CREATE TABLE assignment_rules (
  id INTEGER PRIMARY KEY,
  region_id INTEGER REFERENCES regions(id),
  category_id INTEGER REFERENCES product_categories(id),
  segment TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  priority INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ enquiries & quotations
CREATE TABLE enquiries (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  received_at TEXT,
  received_unknown INTEGER NOT NULL DEFAULT 0,
  source_code TEXT NOT NULL,
  source_event TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  stage TEXT NOT NULL DEFAULT 'new',
  requirement_note TEXT,
  est_value_minor INTEGER,
  est_currency TEXT,
  probability INTEGER,
  temperature TEXT,
  expected_decision_date TEXT,
  first_response_at TEXT,
  first_response_activity_id INTEGER,
  hold_reason TEXT,
  hold_review_date TEXT,
  lost_reason_code TEXT,
  lost_note TEXT,
  competitor TEXT,
  decision_evidence TEXT,
  cancel_reason_code TEXT,
  cancel_note TEXT,
  duplicate_of_id INTEGER REFERENCES enquiries(id),
  decided_at TEXT,
  no_followup_reason TEXT,
  parent_enquiry_id INTEGER REFERENCES enquiries(id),
  reactivation_case_id INTEGER,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER,
  external_id TEXT,
  source_confidence TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (probability IS NULL OR (probability >= 0 AND probability <= 100))
);
CREATE INDEX ix_enquiries_customer ON enquiries(customer_id);
CREATE INDEX ix_enquiries_stage ON enquiries(stage);
CREATE INDEX ix_enquiries_owner ON enquiries(owner_id);
CREATE INDEX ix_enquiries_campaign ON enquiries(campaign_id);

CREATE TABLE enquiry_lines (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  product_id INTEGER REFERENCES products(id),
  category_id INTEGER REFERENCES product_categories(id),
  requirement TEXT,
  spec TEXT,
  qty REAL,
  unit TEXT,
  won_qty REAL NOT NULL DEFAULT 0,
  lost_qty REAL NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'open',
  lost_reason_code TEXT,
  outcome_note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (qty IS NULL OR qty > 0)
);
CREATE INDEX ix_enquiry_lines_enquiry ON enquiry_lines(enquiry_id);

CREATE TABLE quotations (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  enquiry_id INTEGER REFERENCES enquiries(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id),
  subject TEXT,
  owner_id INTEGER REFERENCES users(id),
  price_list TEXT NOT NULL DEFAULT 'standard',
  public_token TEXT UNIQUE,
  prepared_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_quotations_enquiry ON quotations(enquiry_id);
CREATE INDEX ix_quotations_customer ON quotations(customer_id);

-- One quotation, immutable issued revisions. `lines` is the priced line snapshot (JSON array).
-- total_minor is the quoted value before GST (after discounts, including freight/installation);
-- grand_total_minor includes GST.
CREATE TABLE quote_revisions (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT,
  price_list TEXT,
  lines TEXT NOT NULL DEFAULT '[]',
  total_minor INTEGER,
  list_total_minor INTEGER,
  subtotal_minor INTEGER,
  discount_total_minor INTEGER,
  freight_minor INTEGER NOT NULL DEFAULT 0,
  installation_minor INTEGER NOT NULL DEFAULT 0,
  tax_total_minor INTEGER,
  grand_total_minor INTEGER,
  cost_total_minor INTEGER,
  margin_pct REAL,
  discount_pct REAL,
  max_line_discount_pct REAL,
  below_min_price INTEGER NOT NULL DEFAULT 0,
  approval_role TEXT,
  approval_reasons TEXT,
  approval_status TEXT NOT NULL DEFAULT 'not_required',
  approved_by INTEGER,
  approved_at TEXT,
  change_note TEXT,
  validity_date TEXT,
  delivery_terms TEXT,
  payment_terms TEXT,
  warranty_terms TEXT,
  notes TEXT,
  summary TEXT,
  document_id INTEGER,
  sent_at TEXT,
  sent_channel TEXT,
  sent_activity_id INTEGER,
  issued_by INTEGER,
  viewed_at TEXT,
  customer_response TEXT,
  customer_response_at TEXT,
  decided_at TEXT,
  decision_note TEXT,
  rejection_reason_code TEXT,
  acceptance_type TEXT,
  acceptance_note TEXT,
  acceptance_document_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (quotation_id, revision_no)
);

-- Internal approvals (quotation discounts/margins today; other exceptional actions can reuse it).
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  revision_id INTEGER,
  required_role TEXT NOT NULL,
  reasons TEXT,
  amount_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER,
  requested_at TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT,
  comments TEXT
);
CREATE INDEX ix_approvals_status ON approvals(status);
CREATE INDEX ix_approvals_entity ON approvals(entity_type, entity_id);

-- ------------------------------------------------------------------ orders
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  coordinator_id INTEGER REFERENCES users(id),
  production_owner_id INTEGER REFERENCES users(id),
  dispatch_owner_id INTEGER REFERENCES users(id),
  accounts_owner_id INTEGER REFERENCES users(id),
  factory_id INTEGER REFERENCES factories(id),
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'draft',
  po_reference TEXT,
  po_norm TEXT,
  po_date TEXT,
  received_date TEXT,
  received_unknown INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  confirmed_by INTEGER,
  enquiry_id INTEGER REFERENCES enquiries(id),
  quote_revision_id INTEGER REFERENCES quote_revisions(id),
  source_code TEXT,
  confirmation_type TEXT,
  confirmation_note TEXT,
  confirmation_document_id INTEGER,
  currency TEXT,
  payment_terms TEXT,
  advance_pct REAL,
  advance_required_minor INTEGER,
  freight_minor INTEGER NOT NULL DEFAULT 0,
  installation_minor INTEGER NOT NULL DEFAULT 0,
  billing_address TEXT,
  delivery_address TEXT,
  shipping_mode TEXT,
  segment TEXT,
  notes TEXT,
  tracking_token TEXT UNIQUE,
  external_order_ref TEXT,
  external_invoice_ref TEXT,
  closed_at TEXT,
  import_batch_id INTEGER,
  external_id TEXT,
  source_confidence TEXT,
  archived_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_orders_customer ON orders(customer_id);
CREATE INDEX ix_orders_po ON orders(customer_id, po_norm);
CREATE INDEX ix_orders_enquiry ON orders(enquiry_id);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  sku TEXT,
  description TEXT NOT NULL,
  spec TEXT,
  config TEXT,
  hsn TEXT,
  needs_clarification INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'pcs',
  confirmed_qty REAL NOT NULL,
  original_qty REAL,
  list_price_minor INTEGER,
  discount_pct REAL,
  unit_price_minor INTEGER,
  gst_rate REAL,
  cost_price_minor INTEGER,
  enquiry_line_id INTEGER REFERENCES enquiry_lines(id),
  quote_line_index INTEGER,
  commitment_state TEXT NOT NULL DEFAULT 'committed',
  original_commitment_date TEXT,
  agreed_commitment_date TEXT,
  forecast_ready_date TEXT,
  forecast_dispatch_date TEXT,
  estimate_unknown INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'received',
  work_status TEXT NOT NULL DEFAULT 'not_started',
  issue_code TEXT,
  stage_note TEXT,
  hold_review_date TEXT,
  ready_qty REAL,
  ready_as_of TEXT,
  ready_since TEXT,
  qc_qty REAL,
  qc_summary TEXT,
  dispatched_qty REAL NOT NULL DEFAULT 0,
  cancelled_qty REAL NOT NULL DEFAULT 0,
  source_update_at TEXT,
  source_update_basis TEXT,
  last_reported_by_id INTEGER,
  last_reported_by_name TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (confirmed_qty > 0),
  CHECK (dispatched_qty >= 0 AND cancelled_qty >= 0),
  -- last line of defence against negative remaining balances
  CHECK (dispatched_qty + cancelled_qty <= confirmed_qty + 0.0005)
);
CREATE INDEX ix_lines_order ON order_lines(order_id);

CREATE TABLE line_issues (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  issue_code TEXT NOT NULL,
  note TEXT,
  reported_at TEXT NOT NULL,
  reported_by_id INTEGER,
  reported_by_name TEXT,
  resolved_at TEXT,
  resolved_by INTEGER,
  resolution TEXT,
  action_task_id INTEGER,
  entered_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_issues_line ON line_issues(line_id);

CREATE TABLE order_updates (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_id INTEGER REFERENCES order_lines(id),
  kind TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  customer_visible INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'entry_time',
  entered_at TEXT NOT NULL,
  entered_by INTEGER,
  reported_by_id INTEGER,
  reported_by_name TEXT,
  substantive INTEGER NOT NULL DEFAULT 1,
  historical INTEGER NOT NULL DEFAULT 0,
  record_version INTEGER,
  bulk_id TEXT,
  request_id TEXT
);
CREATE INDEX ix_updates_order ON order_updates(order_id);
CREATE INDEX ix_updates_line ON order_updates(line_id);

CREATE TABLE commitment_changes (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  old_date TEXT,
  new_date TEXT,
  estimate_unknown INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  comm_required INTEGER NOT NULL DEFAULT 0,
  informed_at TEXT,
  informed_activity_id INTEGER,
  informed_by INTEGER,
  customer_response TEXT,
  agreed_date TEXT,
  activity_id INTEGER,
  actor_id INTEGER,
  occurred_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_commit_line ON commitment_changes(line_id);

CREATE TABLE communication_confirmations (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  commitment_change_id INTEGER REFERENCES commitment_changes(id),
  activity_id INTEGER NOT NULL,
  contact_id INTEGER,
  channel TEXT,
  occurred_at TEXT NOT NULL,
  response_code TEXT,
  agreed_date TEXT,
  note TEXT,
  entered_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_comm_order ON communication_confirmations(order_id);

-- A dispatch is 'planned' (no effect on quantities), 'posted' (actual dispatch: reduces the balance) or
-- 'reversed' (an authorised correction; the original event stays visible).
CREATE TABLE dispatches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  dispatch_date TEXT,
  planned_date TEXT,
  date_unknown INTEGER NOT NULL DEFAULT 0,
  reference TEXT,
  carrier TEXT,
  tracking_no TEXT,
  tracking_url TEXT,
  vehicle_number TEXT,
  eway_bill TEXT,
  boxes INTEGER,
  weight_kg REAL,
  expected_arrival TEXT,
  invoice_ref TEXT,
  document_id INTEGER,
  pod_document_id INTEGER,
  notes TEXT,
  override_reason TEXT,
  status TEXT NOT NULL DEFAULT 'posted',
  posted_at TEXT,
  reversed_at TEXT,
  reversed_by INTEGER,
  reversal_reason TEXT,
  notify_state TEXT NOT NULL DEFAULT 'pending',
  notify_activity_id INTEGER,
  delivered_at TEXT,
  delivery_note TEXT,
  received_by_name TEXT,
  import_batch_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_dispatches_customer ON dispatches(customer_id);

CREATE TABLE dispatch_lines (
  id INTEGER PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  qty REAL NOT NULL,
  not_ready_override INTEGER NOT NULL DEFAULT 0,
  CHECK (qty > 0)
);
CREATE INDEX ix_dispatch_lines_line ON dispatch_lines(line_id);
CREATE INDEX ix_dispatch_lines_dispatch ON dispatch_lines(dispatch_id);

CREATE TABLE cancellations (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_id INTEGER NOT NULL REFERENCES order_lines(id),
  qty REAL NOT NULL,
  reason_code TEXT NOT NULL,
  note TEXT,
  requested_source TEXT,
  requested_by_name TEXT,
  effective_date TEXT NOT NULL,
  activity_id INTEGER,
  reversed_at TEXT,
  reversed_by INTEGER,
  reversal_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  CHECK (qty > 0)
);
CREATE INDEX ix_cancellations_line ON cancellations(line_id);

-- ------------------------------------------------------------------ tasks & activities
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  entity_type TEXT,
  entity_id INTEGER,
  enquiry_id INTEGER REFERENCES enquiries(id),
  quotation_id INTEGER,
  order_id INTEGER REFERENCES orders(id),
  line_id INTEGER REFERENCES order_lines(id),
  reactivation_case_id INTEGER,
  complaint_id INTEGER,
  invoice_id INTEGER,
  purpose TEXT NOT NULL,
  purpose_code TEXT,
  kind TEXT NOT NULL DEFAULT 'customer',
  priority TEXT NOT NULL DEFAULT 'normal',
  customer_promise INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  due_date TEXT NOT NULL,
  due_time TEXT,
  overdue_at TEXT NOT NULL,
  original_due_date TEXT NOT NULL,
  original_due_time TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source TEXT NOT NULL DEFAULT 'manual',
  alert_key TEXT,
  note TEXT,
  completed_at TEXT,
  completed_by INTEGER,
  completed_late INTEGER,
  completion_activity_id INTEGER,
  cancelled_at TEXT,
  cancelled_by INTEGER,
  cancel_reason TEXT,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  escalated_to INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_tasks_open_alert_key ON tasks(alert_key) WHERE status = 'open' AND alert_key IS NOT NULL;
CREATE INDEX ix_tasks_owner ON tasks(owner_id, status);
CREATE INDEX ix_tasks_customer ON tasks(customer_id);
CREATE INDEX ix_tasks_enquiry ON tasks(enquiry_id);
CREATE INDEX ix_tasks_order ON tasks(order_id);
CREATE INDEX ix_tasks_overdue ON tasks(status, overdue_at);

CREATE TABLE task_changes (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  was_overdue INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_task_changes_task ON task_changes(task_id);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id),
  entity_type TEXT,
  entity_id INTEGER,
  enquiry_id INTEGER,
  order_id INTEGER,
  quote_revision_id INTEGER,
  complaint_id INTEGER,
  reactivation_case_id INTEGER,
  invoice_id INTEGER,
  campaign_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'contact',
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL,
  note TEXT,
  duration_minutes INTEGER,
  customer_contact INTEGER NOT NULL DEFAULT 1,
  meaningful INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT,
  occurred_unknown INTEGER NOT NULL DEFAULT 0,
  entered_at TEXT NOT NULL,
  entered_by INTEGER,
  reported_by_id INTEGER,
  reported_by_name TEXT,
  technical_issue INTEGER NOT NULL DEFAULT 0,
  complaint_converted_id INTEGER,
  task_id INTEGER,
  import_batch_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_activities_customer ON activities(customer_id, occurred_at);
CREATE INDEX ix_activities_enquiry ON activities(enquiry_id);
CREATE INDEX ix_activities_order ON activities(order_id);

CREATE TABLE reactivation_cases (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'not_reviewed',
  basis TEXT NOT NULL DEFAULT 'manual',
  threshold_days INTEGER,
  opened_at TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  reason_code TEXT,
  reason_note TEXT,
  reason_recorded_at TEXT,
  reason_recorded_by INTEGER,
  task_id INTEGER,
  enquiry_id INTEGER,
  order_id INTEGER,
  closure_reason_code TEXT,
  closure_note TEXT,
  review_date TEXT,
  closed_at TEXT,
  last_outcome TEXT,
  last_contact_at TEXT,
  alert_key TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ix_reactivation_customer ON reactivation_cases(customer_id);

-- ------------------------------------------------------------------ documents
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  visibility TEXT NOT NULL DEFAULT 'internal',
  scan_status TEXT NOT NULL DEFAULT 'basic_checks_passed',
  description TEXT,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX ix_attachments_checksum ON attachments(checksum);

CREATE TABLE attachment_links (
  attachment_id INTEGER NOT NULL REFERENCES attachments(id),
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  linked_by INTEGER,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (attachment_id, entity_type, entity_id)
);
CREATE INDEX ix_attachment_links_entity ON attachment_links(entity_type, entity_id);

-- ------------------------------------------------------------------ alerts, notifications, scheduler
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  customer_id INTEGER,
  order_id INTEGER,
  line_id INTEGER,
  enquiry_id INTEGER,
  task_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  detail TEXT,
  owner_id INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  acknowledged_at TEXT,
  acknowledged_by INTEGER,
  escalated_at TEXT,
  escalated_to INTEGER,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  last_notify_at TEXT,
  last_notify_error TEXT
);
CREATE UNIQUE INDEX ux_alerts_open_key ON alerts(alert_key) WHERE resolved_at IS NULL;
CREATE INDEX ix_alerts_rule ON alerts(rule, resolved_at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  alert_id INTEGER,
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE scheduler_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  error TEXT
);

-- Daily / weekly management summaries, stored once per period (idempotent).
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (period, period_key)
);

-- ------------------------------------------------------------------ history & audit
CREATE TABLE history_events (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  customer_id INTEGER,
  kind TEXT NOT NULL,
  data TEXT,
  note TEXT,
  actor_id INTEGER,
  occurred_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_history_entity ON history_events(entity_type, entity_id);
CREATE INDEX ix_history_customer ON history_events(customer_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  actor_id INTEGER,
  source TEXT NOT NULL DEFAULT 'web',
  request_id TEXT,
  changes TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX ix_audit_created ON audit_events(created_at);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE pins (
  user_id INTEGER NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  method TEXT,
  path TEXT,
  message TEXT,
  stack TEXT,
  user_id INTEGER,
  request_id TEXT
);

-- ------------------------------------------------------------------ imports
CREATE TABLE import_uploads (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  batch_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  source_system TEXT,
  file_name TEXT,
  file_checksum TEXT,
  upload_id INTEGER,
  sheet TEXT,
  mapping TEXT,
  date_format TEXT,
  status TEXT NOT NULL DEFAULT 'committed',
  counts TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  rolled_back_at TEXT,
  rolled_back_by INTEGER,
  rollback_reason TEXT
);

CREATE TABLE import_rows (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  row_number INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  status TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  message TEXT,
  data TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, row_number)
);
CREATE INDEX ix_import_rows_key ON import_rows(row_key, status);

-- ------------------------------------------------------------------ P1: invoices, receipts, holds
-- An operational mirror of the accounting system: invoice value incl. tax (gross), what was adjusted
-- from an advance, and receipts / TDS / deductions / credit notes as events.
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  invoice_ref TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_id INTEGER REFERENCES orders(id),
  dispatch_id INTEGER REFERENCES dispatches(id),
  invoice_date TEXT,
  due_date TEXT,
  currency TEXT NOT NULL,
  taxable_minor INTEGER,
  tax_minor INTEGER,
  gross_minor INTEGER NOT NULL,
  advance_adjusted_minor INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  external_ref TEXT,
  owner_id INTEGER REFERENCES users(id),
  promise_date TEXT,
  promise_note TEXT,
  notes TEXT,
  import_batch_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (customer_id, invoice_ref),
  CHECK (gross_minor >= 0),
  CHECK (advance_adjusted_minor >= 0 AND advance_adjusted_minor <= gross_minor)
);
CREATE INDEX ix_invoices_order ON invoices(order_id);

-- kind: 'receipt' (money received against an invoice), 'credit' (credit note / adjustment) or
-- 'advance' (received against an order before invoicing). amount_minor is the cash received;
-- TDS and other deductions are recorded alongside and also reduce the invoice balance.
CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id),
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL DEFAULT 'receipt',
  currency TEXT,
  amount_minor INTEGER NOT NULL,
  tds_minor INTEGER NOT NULL DEFAULT 0,
  other_deduction_minor INTEGER NOT NULL DEFAULT 0,
  deduction_note TEXT,
  mode TEXT,
  effective_date TEXT NOT NULL,
  reference TEXT,
  source TEXT,
  note TEXT,
  reversed_at TEXT,
  reversed_by INTEGER,
  reversal_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  CHECK (amount_minor >= 0 AND tds_minor >= 0 AND other_deduction_minor >= 0),
  CHECK (amount_minor + tds_minor + other_deduction_minor > 0),
  CHECK (invoice_id IS NOT NULL OR kind = 'advance')
);
CREATE INDEX ix_receipts_invoice ON receipts(invoice_id);
CREATE INDEX ix_receipts_order ON receipts(order_id);

CREATE TABLE payment_holds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  reason TEXT NOT NULL,
  authorised_by INTEGER REFERENCES users(id),
  held_at TEXT NOT NULL,
  release_evidence TEXT,
  release_document_id INTEGER,
  released_at TEXT,
  released_by INTEGER,
  task_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ P1: complaints & service
CREATE TABLE complaints (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id),
  order_id INTEGER REFERENCES orders(id),
  line_id INTEGER REFERENCES order_lines(id),
  product_id INTEGER REFERENCES products(id),
  model TEXT,
  serial_batch TEXT,
  invoice_ref TEXT,
  invoice_date TEXT,
  installation_date TEXT,
  warranty_status TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',
  received_date TEXT NOT NULL,
  category_code TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'new',
  first_response_at TEXT,
  review_date TEXT,
  site_visit_date TEXT,
  site_visit_notes TEXT,
  root_cause_code TEXT,
  root_cause_note TEXT,
  resolution_code TEXT,
  resolution_summary TEXT,
  resolved_date TEXT,
  customer_feedback TEXT,
  feedback_rating INTEGER,
  closed_at TEXT,
  original_dispatch_id INTEGER REFERENCES dispatches(id),
  replacement_order_id INTEGER REFERENCES orders(id),
  return_reference TEXT,
  source_activity_id INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (feedback_rating IS NULL OR (feedback_rating >= 1 AND feedback_rating <= 5))
);
CREATE INDEX ix_complaints_customer ON complaints(customer_id);
CREATE INDEX ix_complaints_product ON complaints(product_id);

-- ------------------------------------------------------------------ objects & QR codes
-- Reusable object templates: a category can predefine the custom fields its objects use.
CREATE TABLE object_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  field_template TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- An object's public_id is permanent: rows are soft-deleted so an id is never reused,
-- and nothing about editing an object (name, files, fields) ever changes it.
CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES object_categories(id),
  image_attachment_id INTEGER,
  location TEXT,
  owner_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  password_hash TEXT,
  custom_fields TEXT,
  single_file_direct INTEGER NOT NULL DEFAULT 0,
  show_updated INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TEXT,
  archive_note TEXT,
  customer_id INTEGER REFERENCES customers(id),
  product_id INTEGER REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  serial_number TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX ix_objects_category ON objects(category_id);
CREATE INDEX ix_objects_status ON objects(status, deleted_at);
CREATE INDEX ix_objects_links ON objects(customer_id, product_id, order_id);

-- Files keep their history: replacing a document adds a version to the same group.
CREATE TABLE object_files (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id),
  attachment_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  sort_order INTEGER NOT NULL DEFAULT 0,
  version_group INTEGER NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 1,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX ix_object_files ON object_files(object_id, is_current, sort_order);

CREATE TABLE object_codes (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id),
  code_type TEXT NOT NULL,
  permanent_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (object_id, code_type)
);

CREATE TABLE scan_events (
  id INTEGER PRIMARY KEY,
  object_id INTEGER NOT NULL REFERENCES objects(id),
  scanned_at TEXT NOT NULL,
  device_type TEXT,
  approximate_location TEXT,
  source TEXT
);
CREATE INDEX ix_scan_events ON scan_events(object_id, scanned_at);

-- ------------------------------------------------------------------ operations
CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  path TEXT,
  db_bytes INTEGER,
  files INTEGER,
  file_bytes INTEGER,
  manifest TEXT,
  error TEXT
);
