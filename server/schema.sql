-- Veritek CRM schema. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  states TEXT
);

CREATE TABLE IF NOT EXISTS factories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  designation TEXT,
  phone TEXT,
  branch TEXT,
  region_id INTEGER REFERENCES regions(id),
  factory_id INTEGER REFERENCES factories(id),
  manager_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_targets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  UNIQUE (user_id, month)
);

CREATE TABLE IF NOT EXISTS lead_assignment_rules (
  id INTEGER PRIMARY KEY,
  region_id INTEGER REFERENCES regions(id),
  category_id INTEGER REFERENCES product_categories(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  priority INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'exhibition',
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  cost REAL NOT NULL DEFAULT 0,
  target_leads INTEGER,
  stall TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  description TEXT,
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES product_categories(id),
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  model TEXT,
  description TEXT,
  specs TEXT,
  unit TEXT NOT NULL DEFAULT 'Nos',
  hsn TEXT,
  standard_price REAL NOT NULL DEFAULT 0,
  dealer_price REAL NOT NULL DEFAULT 0,
  distributor_price REAL NOT NULL DEFAULT 0,
  min_price REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18,
  warranty_months INTEGER NOT NULL DEFAULT 18,
  lead_time_days INTEGER NOT NULL DEFAULT 21,
  stock_type TEXT NOT NULL DEFAULT 'stock',
  stock_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS product_options (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta REAL NOT NULL DEFAULT 0,
  cost_delta REAL NOT NULL DEFAULT 0,
  lead_time_delta INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_documents (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  attachment_id INTEGER
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  customer_type TEXT NOT NULL DEFAULT 'direct',
  industry TEXT,
  gstin TEXT,
  website TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  city TEXT,
  state TEXT,
  country TEXT NOT NULL DEFAULT 'India',
  pincode TEXT,
  region_id INTEGER REFERENCES regions(id),
  credit_limit REAL NOT NULL DEFAULT 0,
  payment_terms TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  assigned_to INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'prospect',
  value_category TEXT NOT NULL DEFAULT 'regular',
  source TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_assigned ON customers(assigned_to);
CREATE INDEX IF NOT EXISTS idx_customers_region ON customers(region_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact_role TEXT NOT NULL DEFAULT 'other',
  designation TEXT,
  phone TEXT,
  whatsapp TEXT,
  email TEXT,
  preferred_channel TEXT DEFAULT 'phone',
  is_primary INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);

CREATE TABLE IF NOT EXISTS customer_interests (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES product_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, category_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT 'slate'
);

CREATE TABLE IF NOT EXISTS taggings (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (tag_id, entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_taggings_entity ON taggings(entity, entity_id);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  requirement TEXT,
  category_id INTEGER REFERENCES product_categories(id),
  product_id INTEGER REFERENCES products(id),
  quantity REAL,
  estimated_value REAL NOT NULL DEFAULT 0,
  expected_close_date TEXT,
  source TEXT,
  campaign_id INTEGER REFERENCES campaigns(id),
  assigned_to INTEGER REFERENCES users(id),
  temperature TEXT NOT NULL DEFAULT 'warm',
  probability INTEGER NOT NULL DEFAULT 10,
  stage TEXT NOT NULL DEFAULT 'new_enquiry',
  status TEXT NOT NULL DEFAULT 'open',
  next_action TEXT,
  next_follow_up_date TEXT,
  competitor TEXT,
  win_loss_reason TEXT,
  stage_changed_at TEXT,
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_history ON lead_stage_history(lead_id);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  quotation_id INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
  complaint_id INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
  subject TEXT,
  summary TEXT,
  customer_response TEXT,
  objections TEXT,
  products_discussed TEXT,
  next_action TEXT,
  follow_up_date TEXT,
  duration_minutes INTEGER,
  activity_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'call',
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  quotation_id INTEGER REFERENCES quotations(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES sales_orders(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
  assigned_to INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  auto_key TEXT,
  escalated_at TEXT,
  completed_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  outcome TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(assigned_to, status, due_date);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followups_auto ON followups(auto_key) WHERE auto_key IS NOT NULL AND status = 'pending';

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity, entity_id);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 1,
  price_list TEXT NOT NULL DEFAULT 'standard',
  owner_id INTEGER REFERENCES users(id),
  valid_until TEXT,
  sent_at TEXT,
  viewed_at TEXT,
  responded_at TEXT,
  decided_at TEXT,
  customer_feedback TEXT,
  rejection_reason TEXT,
  public_token TEXT UNIQUE,
  order_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);

CREATE TABLE IF NOT EXISTS quotation_versions (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  change_note TEXT,
  payment_terms TEXT,
  delivery_terms TEXT,
  warranty_terms TEXT,
  validity_days INTEGER NOT NULL DEFAULT 30,
  freight REAL NOT NULL DEFAULT 0,
  installation REAL NOT NULL DEFAULT 0,
  notes TEXT,
  list_total REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  taxable_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  margin_pct REAL,
  discount_pct REAL NOT NULL DEFAULT 0,
  max_line_discount_pct REAL NOT NULL DEFAULT 0,
  below_min_price INTEGER NOT NULL DEFAULT 0,
  approval_role TEXT,
  approval_reasons TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (quotation_id, version_no)
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES quotation_versions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER REFERENCES products(id),
  sku TEXT,
  description TEXT NOT NULL,
  specs TEXT,
  hsn TEXT,
  unit TEXT NOT NULL DEFAULT 'Nos',
  qty REAL NOT NULL,
  list_price REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18,
  cost_price REAL NOT NULL DEFAULT 0,
  min_price REAL NOT NULL DEFAULT 0,
  taxable REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  config TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_version ON quotation_items(version_id);

CREATE TABLE IF NOT EXISTS quotation_events (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  version_no INTEGER,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotation_events ON quotation_events(quotation_id);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  version_id INTEGER,
  required_role TEXT NOT NULL,
  reasons TEXT,
  amount REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  comments TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  quotation_id INTEGER REFERENCES quotations(id),
  quotation_version_id INTEGER REFERENCES quotation_versions(id),
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_po_number TEXT,
  po_date TEXT,
  po_attachment_id INTEGER,
  stage TEXT NOT NULL DEFAULT 'po_received',
  status TEXT NOT NULL DEFAULT 'active',
  order_date TEXT NOT NULL,
  expected_delivery_date TEXT,
  revised_delivery_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  factory_id INTEGER REFERENCES factories(id),
  sales_owner_id INTEGER REFERENCES users(id),
  commercial_owner_id INTEGER REFERENCES users(id),
  production_owner_id INTEGER REFERENCES users(id),
  dispatch_owner_id INTEGER REFERENCES users(id),
  accounts_owner_id INTEGER REFERENCES users(id),
  payment_terms TEXT,
  advance_pct REAL NOT NULL DEFAULT 0,
  advance_required REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  taxable_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  freight REAL NOT NULL DEFAULT 0,
  installation REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL DEFAULT 0,
  billing_address TEXT,
  shipping_address TEXT,
  delay_reason TEXT,
  internal_notes TEXT,
  tracking_token TEXT UNIQUE,
  stage_changed_at TEXT,
  confirmed_at TEXT,
  delivered_at TEXT,
  closed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_stage ON sales_orders(stage, status);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  sku TEXT,
  description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'Nos',
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 18,
  cost_price REAL NOT NULL DEFAULT 0,
  taxable REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  qty_produced REAL NOT NULL DEFAULT 0,
  config TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_stage_history (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_history ON order_stage_history(order_id);

CREATE TABLE IF NOT EXISTS production (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES sales_orders(id) ON DELETE CASCADE,
  factory_id INTEGER REFERENCES factories(id),
  planned_start TEXT,
  planned_completion TEXT,
  actual_start TEXT,
  actual_completion TEXT,
  revised_completion TEXT,
  material_status TEXT NOT NULL DEFAULT 'pending',
  material_constraint TEXT,
  qc_status TEXT NOT NULL DEFAULT 'pending',
  qc_remarks TEXT,
  qc_by INTEGER REFERENCES users(id),
  qc_at TEXT,
  delay_reason TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS production_updates (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  stage TEXT,
  note TEXT NOT NULL,
  visible_to_customer INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_production_updates ON production_updates(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES sales_orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  dispatch_id INTEGER,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  taxable REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  advance_adjusted REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'dispatched',
  dispatch_type TEXT NOT NULL DEFAULT 'complete',
  invoice_id INTEGER REFERENCES invoices(id),
  invoice_number TEXT,
  eway_bill TEXT,
  transporter TEXT,
  vehicle_number TEXT,
  lr_number TEXT,
  boxes INTEGER,
  weight_kg REAL,
  dispatch_date TEXT,
  expected_delivery_date TEXT,
  delivered_date TEXT,
  tracking_url TEXT,
  pod_attachment_id INTEGER,
  received_confirmed INTEGER NOT NULL DEFAULT 0,
  received_by TEXT,
  received_at TEXT,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatches_order ON dispatches(order_id);

CREATE TABLE IF NOT EXISTS dispatch_items (
  id INTEGER PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_id INTEGER REFERENCES sales_orders(id),
  invoice_id INTEGER REFERENCES invoices(id),
  type TEXT NOT NULL DEFAULT 'invoice',
  amount REAL NOT NULL,
  tds_amount REAL NOT NULL DEFAULT 0,
  other_deduction REAL NOT NULL DEFAULT 0,
  deduction_note TEXT,
  payment_date TEXT NOT NULL,
  mode TEXT,
  reference TEXT,
  notes TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  amount REAL NOT NULL,
  reason TEXT,
  note_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES sales_orders(id),
  product_id INTEGER REFERENCES products(id),
  serial_number TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  installation_date TEXT,
  warranty_status TEXT NOT NULL DEFAULT 'in_warranty',
  category TEXT NOT NULL DEFAULT 'other',
  severity TEXT NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to INTEGER REFERENCES users(id),
  site_visit_date TEXT,
  site_visit_notes TEXT,
  root_cause TEXT,
  resolution_type TEXT,
  resolution_notes TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  feedback_rating INTEGER,
  feedback_comment TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaints_customer ON complaints(customer_id);
CREATE INDEX IF NOT EXISTS idx_complaints_product ON complaints(product_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS automation_log (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  message TEXT,
  affected INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (period, period_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- Invoice balance after advance adjustment, receipts (incl. TDS/deductions) and credit notes.
DROP VIEW IF EXISTS invoice_balances;
CREATE VIEW invoice_balances AS
SELECT i.*,
  COALESCE((SELECT SUM(p.amount + p.tds_amount + p.other_deduction) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid,
  COALESCE((SELECT SUM(cn.amount) FROM credit_notes cn WHERE cn.invoice_id = i.id), 0) AS credits,
  ROUND(i.total - i.advance_adjusted
    - COALESCE((SELECT SUM(p.amount + p.tds_amount + p.other_deduction) FROM payments p WHERE p.invoice_id = i.id), 0)
    - COALESCE((SELECT SUM(cn.amount) FROM credit_notes cn WHERE cn.invoice_id = i.id), 0), 2) AS balance
FROM invoices i;
