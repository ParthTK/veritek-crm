import { Router } from 'express';
import { all, get, run, insert, update, tx } from '../db.js';
import { allow } from '../auth.js';
import { nowIso, badRequest, notFound, strOrNull, intOrNull, num, whereClause, audit, parseJson } from '../util.js';
import { redact } from '../access.js';

const r = Router();

r.get('/products', allow('products.view'), (req, res) => {
  const q = req.query;
  const w = [];
  const p = [];
  if (q.q) {
    w.push('(p.name LIKE ? OR p.sku LIKE ? OR p.model LIKE ? OR p.description LIKE ?)');
    p.push(...Array(4).fill(`%${q.q}%`));
  }
  for (const k of ['category_id', 'status', 'stock_type']) {
    if (q[k]) {
      w.push(`p.${k} = ?`);
      p.push(q[k]);
    }
  }
  if (q.active === '1') w.push("p.status = 'active'");
  const rows = all(
    `SELECT p.*, pc.name AS category_name,
            (SELECT COUNT(*) FROM product_options o WHERE o.product_id = p.id) AS option_count,
            (SELECT COUNT(*) FROM product_documents d WHERE d.product_id = p.id) AS document_count
     FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id ${whereClause(w)} ORDER BY pc.name, p.name`,
    ...p,
  ).map((x) => ({ ...x, specs: parseJson(x.specs, {}) }));
  res.json(redact(req.user, rows));
});

r.get('/products/:id', allow('products.view'), (req, res) => {
  const product = get('SELECT p.*, pc.name AS category_name FROM products p LEFT JOIN product_categories pc ON pc.id = p.category_id WHERE p.id = ?', req.params.id);
  if (!product) throw notFound('Product');
  product.specs = parseJson(product.specs, {});
  product.options = all('SELECT * FROM product_options WHERE product_id = ? ORDER BY group_name, price_delta', product.id);
  product.documents = all('SELECT d.*, a.original_name, a.mime FROM product_documents d LEFT JOIN attachments a ON a.id = d.attachment_id WHERE d.product_id = ? ORDER BY d.doc_type', product.id);
  product.demand = get(
    `SELECT COALESCE(SUM(oi.qty), 0) AS qty_ordered, COALESCE(SUM(oi.taxable), 0) AS revenue, COUNT(DISTINCT o.customer_id) AS customers
     FROM order_items oi JOIN sales_orders o ON o.id = oi.order_id WHERE oi.product_id = ? AND o.status <> 'cancelled'`,
    product.id,
  );
  product.complaints = get('SELECT COUNT(*) AS n FROM complaints WHERE product_id = ?', product.id).n;
  res.json(redact(req.user, product));
});

function productData(b) {
  const d = {};
  for (const k of ['sku', 'name', 'model', 'description', 'unit', 'hsn', 'stock_type', 'status']) if (b[k] !== undefined) d[k] = strOrNull(b[k]);
  for (const k of ['standard_price', 'dealer_price', 'distributor_price', 'min_price', 'cost_price', 'gst_rate']) if (b[k] !== undefined) d[k] = num(b[k]);
  for (const k of ['warranty_months', 'lead_time_days', 'stock_qty']) if (b[k] !== undefined) d[k] = Math.max(0, Math.round(num(b[k])));
  if (b.category_id !== undefined) d.category_id = intOrNull(b.category_id);
  if (b.specs !== undefined) d.specs = typeof b.specs === 'string' ? parseJson(b.specs, {}) : b.specs;
  if (d.min_price && d.standard_price && d.min_price > d.standard_price) throw badRequest('Minimum selling price cannot exceed the standard price');
  return d;
}

r.post('/products', allow('products.edit'), (req, res) => {
  const d = productData(req.body);
  if (!d.sku || !d.name) throw badRequest('SKU and product name are required');
  const id = insert('products', { ...d, created_at: nowIso(), updated_at: nowIso() });
  audit(req.user.id, 'product', id, 'create', d);
  res.status(201).json({ id });
});

r.put('/products/:id', allow('products.edit'), (req, res) => {
  const before = get('SELECT * FROM products WHERE id = ?', req.params.id);
  if (!before) throw notFound('Product');
  const d = productData(req.body);
  update('products', before.id, { ...d, updated_at: nowIso() });
  const priceChanges = ['standard_price', 'dealer_price', 'distributor_price', 'min_price', 'cost_price']
    .filter((k) => d[k] !== undefined && d[k] !== before[k]).map((k) => ({ field: k, from: before[k], to: d[k] }));
  audit(req.user.id, 'product', before.id, priceChanges.length ? 'price_change' : 'update', priceChanges.length ? priceChanges : d);
  res.json({ ok: true });
});

r.post('/products/:id/options', allow('products.edit'), (req, res) => {
  const b = req.body;
  if (!strOrNull(b.group_name) || !strOrNull(b.name)) throw badRequest('Option group and name are required');
  const id = insert('product_options', {
    product_id: Number(req.params.id), group_name: strOrNull(b.group_name), name: strOrNull(b.name),
    price_delta: num(b.price_delta), cost_delta: num(b.cost_delta), lead_time_delta: Math.round(num(b.lead_time_delta)),
  });
  res.status(201).json({ id });
});

r.put('/product-options/:id', allow('products.edit'), (req, res) => {
  const b = req.body;
  update('product_options', req.params.id, {
    group_name: strOrNull(b.group_name), name: strOrNull(b.name), price_delta: num(b.price_delta), cost_delta: num(b.cost_delta), lead_time_delta: Math.round(num(b.lead_time_delta)),
  });
  res.json({ ok: true });
});

r.delete('/product-options/:id', allow('products.edit'), (req, res) => {
  run('DELETE FROM product_options WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.post('/products/:id/documents', allow('products.edit'), (req, res) => {
  const b = req.body;
  if (!strOrNull(b.title)) throw badRequest('Document title is required');
  if (!strOrNull(b.url) && !b.attachment_id) throw badRequest('Upload a file or give a link');
  const id = tx(() => {
    const did = insert('product_documents', { product_id: Number(req.params.id), doc_type: b.doc_type || 'datasheet', title: strOrNull(b.title), url: strOrNull(b.url), attachment_id: intOrNull(b.attachment_id) });
    if (b.attachment_id) run("UPDATE attachments SET entity = 'product', entity_id = ? WHERE id = ?", req.params.id, b.attachment_id);
    return did;
  });
  res.status(201).json({ id });
});

r.delete('/product-documents/:id', allow('products.edit'), (req, res) => {
  run('DELETE FROM product_documents WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

r.get('/categories', (req, res) => {
  res.json(all('SELECT pc.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = pc.id) AS product_count FROM product_categories pc ORDER BY name'));
});

r.post('/categories', allow('products.edit'), (req, res) => {
  if (!strOrNull(req.body.name)) throw badRequest('Category name is required');
  res.status(201).json({ id: insert('product_categories', { name: strOrNull(req.body.name), description: strOrNull(req.body.description) }) });
});

r.put('/categories/:id', allow('products.edit'), (req, res) => {
  update('product_categories', req.params.id, { name: strOrNull(req.body.name), description: strOrNull(req.body.description) });
  res.json({ ok: true });
});

export default r;
