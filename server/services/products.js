// Product master & price list: categories (the "product family" used in filters and reports), models with
// standard / dealer / distributor / minimum prices and cost, GST, warranty, lead time, configurator options
// and datasheets. Product codes are stable; used products are deactivated, never deleted.
import { all, get, insert, run, tx, update, updateVersioned } from '../db.js';
import {
  Check, conflict, notFound, nowIso, str, intId, bool, num, audit, dropdowns, likeTerm, parseJson,
} from '../util.js';
import { CURRENCIES, STOCK_TYPES, PRODUCT_DOC_TYPES } from '../../shared/constants.js';
import { toMinor } from '../../shared/rules.js';
import { linkAttachment } from './attachments.js';

const PRICE_FIELDS = ['standard_price', 'dealer_price', 'distributor_price', 'min_price', 'cost_price'];

export function listProducts(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) {
    where.push('(p.code LIKE ? OR p.name LIKE ? OR p.model LIKE ? OR p.description LIKE ? OR p.family LIKE ?)');
    params.push(...Array(5).fill(likeTerm(query.q)));
  }
  if (intId(query.category_id)) {
    where.push('p.category_id = ?');
    params.push(intId(query.category_id));
  }
  if (query.status === 'active') where.push('p.active = 1');
  if (query.status === 'inactive') where.push('p.active = 0');
  if (query.stock_type) {
    where.push('p.stock_type = ?');
    params.push(query.stock_type);
  }
  return all(`SELECT p.*, pc.name AS category_name,
      (SELECT COUNT(*) FROM product_options o WHERE o.product_id = p.id AND o.active = 1) AS option_count,
      (SELECT COUNT(*) FROM product_documents d WHERE d.product_id = p.id) AS document_count,
      (SELECT COUNT(*) FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.product_id = p.id AND o.status = 'confirmed') AS order_lines,
      (SELECT COUNT(*) FROM enquiry_lines el WHERE el.product_id = p.id) AS enquiry_lines
    FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id
    WHERE ${where.join(' AND ')} ORDER BY p.active DESC, COALESCE(pc.sort_order, 999), pc.name, p.code`, ...params)
    .map((p) => ({ ...p, specs: parseJson(p.specs, {}) }));
}

export function productDetail(id) {
  const p = get('SELECT p.*, pc.name AS category_name FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id WHERE p.id = ?', id);
  if (!p) throw notFound('Product');
  const options = all('SELECT * FROM product_options WHERE product_id = ? ORDER BY active DESC, group_name, sort_order, id', id);
  const documents = all(`SELECT d.*, a.original_name, a.mime, a.size FROM product_documents d LEFT JOIN attachments a ON a.id = d.attachment_id
    WHERE d.product_id = ? ORDER BY d.sort_order, d.doc_type, d.id`, id);
  // Demand: confirmed order quantities and values per currency (never summed across currencies).
  const demand = all(`SELECT o.currency, SUM(l.confirmed_qty - l.cancelled_qty) AS qty, SUM(l.dispatched_qty) AS dispatched,
      SUM(CASE WHEN l.unit_price_minor IS NOT NULL THEN ROUND((l.confirmed_qty - l.cancelled_qty) * l.unit_price_minor) END) AS value_minor,
      SUM(CASE WHEN l.unit_price_minor IS NULL THEN 1 ELSE 0 END) AS unpriced_lines, COUNT(DISTINCT o.customer_id) AS customers, COUNT(DISTINCT o.id) AS orders
    FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.product_id = ? AND o.status = 'confirmed' GROUP BY o.currency`, id);
  const stats = {
    enquiries: get('SELECT COUNT(DISTINCT enquiry_id) AS n FROM enquiry_lines WHERE product_id = ?', id).n,
    open_enquiries: get(`SELECT COUNT(DISTINCT el.enquiry_id) AS n FROM enquiry_lines el JOIN enquiries e ON e.id = el.enquiry_id
      WHERE el.product_id = ? AND e.stage NOT IN ('won','lost','cancelled')`, id).n,
    complaints: get('SELECT COUNT(*) AS n FROM complaints WHERE product_id = ?', id).n,
    open_complaints: get("SELECT COUNT(*) AS n FROM complaints WHERE product_id = ? AND status NOT IN ('resolved','closed')", id).n,
    active_lines: get(`SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.product_id = ? AND o.status = 'confirmed' AND l.confirmed_qty - l.dispatched_qty - l.cancelled_qty > 0.0005`, id).n,
  };
  const customers = all(`SELECT c.id, c.company_name, COUNT(DISTINCT o.id) AS orders, MAX(o.received_date) AS last_order
    FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN customers c ON c.id = o.customer_id
    WHERE l.product_id = ? AND o.status = 'confirmed' GROUP BY c.id ORDER BY last_order DESC LIMIT 15`, id);
  const history = all(`SELECT a.action, a.changes, a.created_at, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.entity_type = 'product' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30`, id).map((h) => ({ ...h, changes: parseJson(h.changes, {}) }));
  return { product: { ...p, specs: parseJson(p.specs, {}) }, options, documents, demand, stats, customers, history };
}

function priceInput(c, input, field) {
  if (input[field] === undefined) return undefined;
  const m = toMinor(input[field]);
  if (m === null) return null;
  if (Number.isNaN(m) || m < 0) {
    c.fail(field, 'Enter a valid price (up to 2 decimals)');
    return undefined;
  }
  return m;
}

/** Creates or updates a product. Price changes are audited field by field. */
export function saveProduct(id, input, user) {
  const cur = id ? get('SELECT * FROM products WHERE id = ?', id) : null;
  if (id && !cur) throw notFound('Product');
  const c = new Check();
  c.text('code', input.code, { required: !id, max: 40, label: 'Model / code' });
  c.text('name', input.name, { required: !id, max: 160, label: 'Name' });
  c.text('model', input.model, { max: 80, label: 'Model' });
  c.text('hsn', input.hsn, { max: 20, label: 'HSN code' });
  if (input.code && get('SELECT id FROM products WHERE code = ? COLLATE NOCASE AND id IS NOT ?', input.code.trim(), id ?? null)) c.fail('code', 'This code is already used');
  if (input.default_unit && !(dropdowns().unit || []).some((u) => u.code === input.default_unit)) c.fail('default_unit', 'Choose a unit');
  if (input.price_currency && !CURRENCIES.includes(input.price_currency)) c.fail('price_currency', 'Choose a currency');
  if (input.stock_type && !STOCK_TYPES.some((s) => s.value === input.stock_type)) c.fail('stock_type', 'Choose a stock type');
  let category = null;
  if (input.category_id !== undefined && input.category_id !== null && input.category_id !== '') {
    category = get('SELECT * FROM product_categories WHERE id = ?', intId(input.category_id));
    if (!category) c.fail('category_id', 'Choose a category');
  }
  const prices = {};
  for (const f of PRICE_FIELDS) {
    const v = priceInput(c, input, f);
    if (v !== undefined) prices[`${f}_minor`] = v;
  }
  const std = prices.standard_price_minor !== undefined ? prices.standard_price_minor : cur?.standard_price_minor;
  const min = prices.min_price_minor !== undefined ? prices.min_price_minor : cur?.min_price_minor;
  if (std !== null && std !== undefined && min !== null && min !== undefined && min > std) c.fail('min_price', 'The minimum selling price cannot exceed the standard price');
  for (const f of ['gst_rate', 'warranty_months', 'lead_time_days', 'stock_qty']) {
    if (input[f] !== undefined && input[f] !== '' && input[f] !== null && (num(input[f]) === null || num(input[f]) < 0)) c.fail(f, 'Enter a valid number');
  }
  if (input.gst_rate !== undefined && num(input.gst_rate) > 40) c.fail('gst_rate', 'GST rate looks wrong');
  c.throwIfAny();
  const stamp = nowIso();
  const data = {
    code: input.code !== undefined ? input.code.trim() : undefined,
    name: input.name !== undefined ? str(input.name, 160) : undefined,
    model: input.model !== undefined ? str(input.model, 80) : undefined,
    description: input.description !== undefined ? str(input.description, 2000) : undefined,
    specs: input.specs !== undefined ? JSON.stringify(typeof input.specs === 'string' ? parseJson(input.specs, {}) : input.specs || {}) : undefined,
    hsn: input.hsn !== undefined ? str(input.hsn, 20) : undefined,
    default_unit: input.default_unit || undefined,
    integer_qty: input.integer_qty !== undefined ? (bool(input.integer_qty) ? 1 : 0) : undefined,
    spec_hint: input.spec_hint !== undefined ? str(input.spec_hint, 300) : undefined,
    price_currency: input.price_currency || undefined,
    gst_rate: input.gst_rate !== undefined && input.gst_rate !== '' ? num(input.gst_rate) : undefined,
    warranty_months: input.warranty_months !== undefined ? (input.warranty_months === '' || input.warranty_months === null ? null : Math.round(num(input.warranty_months))) : undefined,
    lead_time_days: input.lead_time_days !== undefined ? (input.lead_time_days === '' || input.lead_time_days === null ? null : Math.round(num(input.lead_time_days))) : undefined,
    stock_type: input.stock_type || undefined,
    stock_qty: input.stock_qty !== undefined ? (input.stock_qty === '' || input.stock_qty === null ? null : num(input.stock_qty)) : undefined,
    active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : undefined,
    ...prices,
  };
  if (input.category_id !== undefined) {
    data.category_id = category?.id ?? null;
    data.family = category?.name ?? null;
  }
  return tx(() => {
    if (cur) {
      if (input.version !== undefined && Number(input.version) !== cur.version) throw conflict('Someone else updated this product.', { code: 'version_conflict', current: cur });
      if (!updateVersioned('products', id, cur.version, { ...data, updated_at: stamp })) throw conflict('Someone else updated this product.', { code: 'version_conflict' });
      const priceChanges = Object.keys(prices).filter((k) => prices[k] !== cur[k]).map((k) => ({ field: k, from: cur[k], to: prices[k] }));
      audit('product', id, priceChanges.length ? 'price_change' : 'update', priceChanges.length ? { prices: priceChanges } : Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
      return { id };
    }
    const newId = insert('products', {
      ...data, active: data.active ?? 1, integer_qty: data.integer_qty ?? 1, default_unit: data.default_unit || 'pcs', price_currency: data.price_currency || 'INR',
      gst_rate: data.gst_rate ?? 18, stock_type: data.stock_type || 'made_to_order', created_at: stamp, updated_at: stamp,
    });
    audit('product', newId, 'create', { code: data.code, name: data.name, ...prices });
    return { id: newId };
  });
}

// ------------------------------------------------------------------ configurator options
export function saveOption(productId, optionId, input) {
  if (!get('SELECT id FROM products WHERE id = ?', productId)) throw notFound('Product');
  const cur = optionId ? get('SELECT * FROM product_options WHERE id = ? AND product_id = ?', optionId, productId) : null;
  if (optionId && !cur) throw notFound('Option');
  const c = new Check();
  c.text('group_name', input.group_name ?? cur?.group_name, { required: true, max: 60, label: 'Option group' });
  c.text('name', input.name ?? cur?.name, { required: true, max: 120, label: 'Option' });
  const price = input.price_delta !== undefined ? toMinor(input.price_delta || 0) : cur?.price_delta_minor ?? 0;
  const cost = input.cost_delta !== undefined ? toMinor(input.cost_delta || 0) : cur?.cost_delta_minor ?? 0;
  if (Number.isNaN(price)) c.fail('price_delta', 'Enter a valid amount');
  if (Number.isNaN(cost)) c.fail('cost_delta', 'Enter a valid amount');
  const lead = input.lead_time_delta !== undefined ? Math.round(num(input.lead_time_delta) || 0) : cur?.lead_time_delta ?? 0;
  c.throwIfAny();
  const data = {
    group_name: str(input.group_name ?? cur?.group_name, 60), name: str(input.name ?? cur?.name, 120), price_delta_minor: price, cost_delta_minor: cost, lead_time_delta: lead,
    active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : cur?.active ?? 1, sort_order: input.sort_order !== undefined ? Number(input.sort_order) || 0 : cur?.sort_order ?? 0,
  };
  if (cur) {
    update('product_options', optionId, data);
    audit('product', productId, 'option_update', { option_id: optionId, ...data });
    return { id: optionId };
  }
  const id = insert('product_options', { ...data, product_id: productId });
  audit('product', productId, 'option_add', { option_id: id, ...data });
  return { id };
}

/** Options already quoted stay visible in those quotations (they are snapshots); here they are deactivated. */
export function removeOption(productId, optionId) {
  const cur = get('SELECT * FROM product_options WHERE id = ? AND product_id = ?', optionId, productId);
  if (!cur) throw notFound('Option');
  const used = get("SELECT id FROM quote_revisions WHERE lines LIKE ? LIMIT 1", `%"option_id":${optionId}%`) || get('SELECT id FROM order_lines WHERE config LIKE ? LIMIT 1', `%"id":${optionId}%`);
  if (used) {
    update('product_options', optionId, { active: 0 });
    audit('product', productId, 'option_deactivate', { option_id: optionId });
    return { id: optionId, deactivated: true };
  }
  run('DELETE FROM product_options WHERE id = ?', optionId);
  audit('product', productId, 'option_delete', { option_id: optionId, name: cur.name });
  return { id: optionId, deleted: true };
}

// ------------------------------------------------------------------ documents
export function addDocument(productId, input, user) {
  if (!get('SELECT id FROM products WHERE id = ?', productId)) throw notFound('Product');
  const c = new Check();
  c.text('title', input.title, { required: true, max: 160, label: 'Title' });
  const docType = input.doc_type || 'datasheet';
  if (!PRODUCT_DOC_TYPES.some((d) => d.value === docType)) c.fail('doc_type', 'Choose a document type');
  const url = str(input.url, 500);
  if (url && !/^https?:\/\//i.test(url)) c.fail('url', 'Links must start with http:// or https://');
  const attachmentId = intId(input.attachment_id);
  if (attachmentId && !get('SELECT id FROM attachments WHERE id = ?', attachmentId)) c.fail('attachment_id', 'Upload the file again');
  if (!url && !attachmentId) c.fail('url', 'Upload a file or give a link');
  c.throwIfAny();
  return tx(() => {
    const id = insert('product_documents', { product_id: productId, doc_type: docType, title: str(input.title, 160), url, attachment_id: attachmentId, created_by: user.id, created_at: nowIso() });
    if (attachmentId) linkAttachment(attachmentId, 'product', productId, user);
    audit('product', productId, 'document_add', { document_id: id, title: input.title, doc_type: docType });
    return { id };
  });
}

export function removeDocument(productId, documentId) {
  const d = get('SELECT * FROM product_documents WHERE id = ? AND product_id = ?', documentId, productId);
  if (!d) throw notFound('Document');
  run('DELETE FROM product_documents WHERE id = ?', documentId);
  audit('product', productId, 'document_remove', { document_id: documentId, title: d.title });
  return { id: documentId };
}

// ------------------------------------------------------------------ categories (product families)
export function listCategories() {
  return all(`SELECT pc.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = pc.id) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = pc.id AND p.active = 1) AS active_count
    FROM product_categories pc ORDER BY pc.sort_order, pc.name`);
}

/** Renaming a category keeps every product's family label in step (filters and reports use it). */
export function saveCategory(id, input) {
  const cur = id ? get('SELECT * FROM product_categories WHERE id = ?', id) : null;
  if (id && !cur) throw notFound('Category');
  const c = new Check();
  c.text('name', input.name ?? cur?.name, { required: true, max: 80, label: 'Category name' });
  const name = str(input.name ?? cur?.name, 80);
  if (name && get('SELECT id FROM product_categories WHERE name = ? COLLATE NOCASE AND id IS NOT ?', name, id ?? null)) c.fail('name', 'A category with this name exists');
  c.throwIfAny();
  return tx(() => {
    const data = {
      name, description: input.description !== undefined ? str(input.description, 300) : cur?.description ?? null,
      active: input.active !== undefined ? (bool(input.active) ? 1 : 0) : cur?.active ?? 1,
      sort_order: input.sort_order !== undefined ? Number(input.sort_order) || 0 : cur?.sort_order ?? 0,
    };
    if (cur) {
      update('product_categories', id, data);
      if (cur.name !== name) run('UPDATE products SET family = ?, updated_at = ? WHERE category_id = ?', name, nowIso(), id);
      audit('product_category', id, 'update', data);
      return { id };
    }
    const newId = insert('product_categories', { ...data, created_at: nowIso() });
    audit('product_category', newId, 'create', data);
    return { id: newId };
  });
}

/** Price for a price list: dealer/distributor prices fall back to the standard price when not set. */
export function listPriceMinor(product, priceList) {
  if (priceList === 'dealer' && product.dealer_price_minor) return product.dealer_price_minor;
  if (priceList === 'distributor' && product.distributor_price_minor) return product.distributor_price_minor;
  return product.standard_price_minor ?? null;
}
