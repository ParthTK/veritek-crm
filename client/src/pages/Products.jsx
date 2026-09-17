import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inr, inrCompact, number, pct } from '../lib/format.js';
import { Badge, Button, Card, DataTable, Field, Input, KV, Modal, PageHeader, SearchBox, Select, Spinner, Tabs, Textarea, Tile, useToast, EmptyState, useConfirm } from '../components/ui.jsx';
import { useMeta } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

const STOCK_TYPES = [{ value: 'stock', label: 'Stock item' }, { value: 'made_to_order', label: 'Made to order' }, { value: 'service', label: 'Service' }];
const STATUSES = [{ value: 'active', label: 'Active' }, { value: 'development', label: 'Under development' }, { value: 'discontinued', label: 'Discontinued' }];

export default function Products() {
  const { can } = useAuth();
  const meta = useMeta();
  const [f, setFilter] = useUrlFilters();
  const { data, loading, reload } = useApi('/products', f);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const canEdit = can('products.edit');
  const marginVisible = can('margin.view');
  const values = can('finance.values');

  const columns = [
    { key: 'sku', label: 'SKU', render: (p) => <div className="col" style={{ gap: 0 }}><span className="strong mono">{p.sku}</span><span className="tiny muted">{p.model}</span></div> },
    { key: 'name', label: 'Product', render: (p) => (
      <div className="col" style={{ gap: 0, maxWidth: 320 }}>
        <button type="button" className="btn ghost xs" style={{ padding: 0, height: 'auto', justifyContent: 'flex-start' }} onClick={() => setSelected(p.id)}><span className="strong">{p.name}</span></button>
        <span className="tiny muted truncate">{Object.entries(p.specs || {}).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>
      </div>
    ) },
    { key: 'category', label: 'Category', render: (p) => <span className="small">{p.category_name}</span> },
    values && { key: 'std', label: 'Standard', align: 'num', render: (p) => inr(p.standard_price) },
    values && { key: 'dealer', label: 'Dealer', align: 'num', render: (p) => inr(p.dealer_price) },
    values && { key: 'dist', label: 'Distributor', align: 'num', render: (p) => inr(p.distributor_price) },
    marginVisible && { key: 'min', label: 'Min. selling', align: 'num', render: (p) => <span className="warning-text">{inr(p.min_price)}</span> },
    marginVisible && { key: 'margin', label: 'Margin at list', align: 'num', render: (p) => (p.standard_price ? pct(((p.standard_price - p.cost_price) / p.standard_price) * 100) : '—') },
    { key: 'gst', label: 'GST', align: 'num', render: (p) => `${p.gst_rate}%` },
    { key: 'lead', label: 'Lead time', align: 'num', render: (p) => `${p.lead_time_days} d` },
    { key: 'stock', label: 'Availability', render: (p) => (
      <div className="col" style={{ gap: 2 }}>
        <Badge size="sm" color={p.stock_type === 'stock' ? 'green' : p.stock_type === 'service' ? 'violet' : 'blue'}>{STOCK_TYPES.find((s) => s.value === p.stock_type)?.label}</Badge>
        {p.stock_type === 'stock' && <span className="tiny muted">{number(p.stock_qty)} in stock</span>}
      </div>
    ) },
    { key: 'status', label: 'Status', render: (p) => <Badge size="sm" color={p.status === 'active' ? 'green' : p.status === 'discontinued' ? 'red' : 'amber'}>{p.status}</Badge> },
    { key: 'extras', label: 'Options / docs', render: (p) => <span className="small muted">{p.option_count ? `${p.option_count} options` : '—'}{p.document_count ? ` · ${p.document_count} docs` : ''}</span> },
  ];

  return (
    <div className="stack">
      <PageHeader title="Products & price master" subtitle="Approved prices, minimum selling price, GST, warranty, lead time and configurable variants"
        actions={canEdit && <><Button icon="plus" onClick={() => setEditing({})}>New product</Button><Button icon="tag" onClick={() => setEditing({ category: true })}>New category</Button></>} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="SKU, name, model" />
        <Select className="sm" value={f.category_id} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="All categories" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="sm" value={f.stock_type} onChange={(e) => setFilter({ stock_type: e.target.value })} placeholder="All types" options={STOCK_TYPES} />
        <Select className="sm" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} placeholder="All statuses" options={STATUSES} />
      </div>
      <Card flush>
        <DataTable columns={columns} rows={data} loading={loading} onRowClick={(p) => setSelected(p.id)} />
      </Card>
      {selected && <ProductDetail id={selected} onClose={() => setSelected(null)} onEdit={(p) => { setSelected(null); setEditing(p); }} onChanged={reload} />}
      {editing && (editing.category
        ? <CategoryModal onClose={() => setEditing(null)} onSaved={() => { meta.reload(); setEditing(null); }} />
        : <ProductModal product={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { reload(); setEditing(null); }} />)}
    </div>
  );
}

function ProductDetail({ id, onClose, onEdit, onChanged }) {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: p, reload } = useApi(`/products/${id}`);
  const [tab, setTab] = useState('overview');
  const [option, setOption] = useState(null);
  const [doc, setDoc] = useState(null);
  const canEdit = can('products.edit');
  const marginVisible = can('margin.view');

  return (
    <Modal open size="lg" onClose={onClose} title={p ? `${p.sku} — ${p.name}` : 'Loading…'} subtitle={p?.category_name}
      footer={canEdit && p && <><Button onClick={onClose}>Close</Button><Button variant="primary" icon="edit" onClick={() => onEdit(p)}>Edit product</Button></>}>
      {!p ? <Spinner /> : (
        <div className="stack">
          <Tabs value={tab} onChange={setTab} tabs={[
            { key: 'overview', label: 'Specifications' },
            { key: 'options', label: 'Configurator', count: p.options.length },
            { key: 'docs', label: 'Documents', count: p.documents.length },
            { key: 'demand', label: 'Demand' },
          ]} />
          {tab === 'overview' && (
            <div className="grid grid-2">
              <Card title="Commercial">
                <KV items={[
                  p.standard_price !== undefined && ['Standard price', <strong>{inr(p.standard_price)}</strong>],
                  p.dealer_price !== undefined && ['Dealer price', inr(p.dealer_price)],
                  p.distributor_price !== undefined && ['Distributor price', inr(p.distributor_price)],
                  marginVisible && ['Minimum selling price', <span className="warning-text">{inr(p.min_price)}</span>],
                  marginVisible && ['Cost price', inr(p.cost_price)],
                  marginVisible && p.standard_price > 0 && ['Margin at list price', pct(((p.standard_price - p.cost_price) / p.standard_price) * 100)],
                  ['GST rate', `${p.gst_rate}%`],
                  ['HSN / SAC', p.hsn],
                  ['Unit', p.unit],
                ]} />
              </Card>
              <Card title="Supply">
                <KV items={[
                  ['Model', p.model],
                  ['Warranty', p.warranty_months ? `${p.warranty_months} months` : '—'],
                  ['Production lead time', `${p.lead_time_days} days`],
                  ['Availability', STOCK_TYPES.find((s) => s.value === p.stock_type)?.label],
                  p.stock_type === 'stock' && ['Stock on hand', `${number(p.stock_qty)} ${p.unit}`],
                  ['Status', p.status],
                  ['Complaints logged', p.complaints],
                ]} />
              </Card>
              <Card title="Technical specifications" className="span-2">
                <KV items={Object.entries(p.specs || {})} />
                {p.description && <p className="small secondary" style={{ marginTop: 10 }}>{p.description}</p>}
              </Card>
            </div>
          )}
          {tab === 'options' && (
            <Card title="Configurable options" sub="Used by the quotation builder to price variants" flush
              actions={canEdit && <Button size="sm" icon="plus" onClick={() => setOption({ product_id: p.id })}>Add option</Button>}>
              {p.options.length === 0 && <EmptyState title="No options" message="Add option groups such as rating, communication or enclosure." />}
              {p.options.map((o) => (
                <div key={o.id} className="action-row">
                  <span className="grow small"><span className="muted">{o.group_name}:</span> <strong>{o.name}</strong></span>
                  {o.price_delta !== undefined && <span className="small num">{o.price_delta >= 0 ? '+' : '−'}{inr(Math.abs(o.price_delta))}</span>}
                  {o.lead_time_delta ? <Badge size="sm">+{o.lead_time_delta} d</Badge> : null}
                  {canEdit && <Button size="xs" variant="ghost" icon="edit" onClick={() => setOption(o)} aria-label="Edit option" />}
                  {canEdit && <Button size="xs" variant="ghost" icon="trash" aria-label="Delete option" onClick={async () => {
                    if (!(await confirm({ title: 'Delete option?', message: `${o.group_name}: ${o.name}`, danger: true, confirmLabel: 'Delete' }))) return;
                    await api.del(`/product-options/${o.id}`);
                    toast.success('Option removed');
                    reload();
                  }} />}
                </div>
              ))}
            </Card>
          )}
          {tab === 'docs' && (
            <Card title="Datasheets, manuals & videos" flush actions={canEdit && <Button size="sm" icon="plus" onClick={() => setDoc({})}>Add document</Button>}>
              {p.documents.length === 0 && <EmptyState title="No documents" />}
              {p.documents.map((d) => (
                <div key={d.id} className="action-row">
                  <Icon name={d.doc_type === 'video' ? 'video' : 'file'} size={15} />
                  <span className="grow small">{d.title}<div className="tiny muted">{d.doc_type}</div></span>
                  {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="small">Open</a>}
                  {canEdit && <Button size="xs" variant="ghost" icon="trash" aria-label="Delete document" onClick={async () => { await api.del(`/product-documents/${d.id}`); reload(); }} />}
                </div>
              ))}
            </Card>
          )}
          {tab === 'demand' && (
            <div className="tiles">
              <Tile label="Quantity ordered" value={number(p.demand.qty_ordered)} foot="All time" />
              {p.demand.revenue !== undefined && <Tile label="Revenue" value={inrCompact(p.demand.revenue)} foot="Excluding GST" />}
              <Tile label="Customers" value={number(p.demand.customers)} />
              <Tile label="Complaints" value={number(p.complaints)} alert={p.complaints > 2} />
            </div>
          )}
        </div>
      )}
      {option && <OptionModal option={option} productId={p?.id} onClose={() => setOption(null)} onSaved={() => { setOption(null); reload(); onChanged?.(); }} />}
      {doc && <DocModal productId={p?.id} onClose={() => setDoc(null)} onSaved={() => { setDoc(null); reload(); }} />}
    </Modal>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const toast = useToast();
  const meta = useMeta();
  const { can } = useAuth();
  const [form, setForm] = useState({ gst_rate: 18, warranty_months: 18, lead_time_days: 14, stock_type: 'stock', status: 'active', unit: 'Nos' });
  const [specs, setSpecs] = useState([['', '']]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (product) {
      setForm(product);
      setSpecs(Object.entries(product.specs || {}).concat([['', '']]));
    }
  }, [product]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, specs: Object.fromEntries(specs.filter(([k]) => k.trim())) };
      if (product?.id) await api.put(`/products/${product.id}`, body);
      else await api.post('/products', body);
      toast.success('Product saved');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open size="lg" onClose={onClose} title={product?.id ? `Edit ${product.sku}` : 'New product'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="SKU" required><Input value={form.sku} onChange={set('sku')} /></Field>
        <Field label="Model"><Input value={form.model} onChange={set('model')} /></Field>
        <Field label="Product name" required className="full"><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Category"><Select value={form.category_id} onChange={set('category_id')} placeholder="—" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Unit"><Input value={form.unit} onChange={set('unit')} /></Field>
        <Field label="Description" className="full"><Textarea rows={2} value={form.description} onChange={set('description')} /></Field>
        <div className="form-section">Pricing</div>
        <Field label="Standard price (₹)" required><Input type="number" min="0" value={form.standard_price} onChange={set('standard_price')} /></Field>
        <Field label="Dealer price (₹)"><Input type="number" min="0" value={form.dealer_price} onChange={set('dealer_price')} /></Field>
        <Field label="Distributor price (₹)"><Input type="number" min="0" value={form.distributor_price} onChange={set('distributor_price')} /></Field>
        {can('margin.view') && <Field label="Minimum selling price (₹)" hint="Quoting below this needs management approval"><Input type="number" min="0" value={form.min_price} onChange={set('min_price')} /></Field>}
        {can('margin.view') && <Field label="Cost price (₹)" hint="Used for margin checks"><Input type="number" min="0" value={form.cost_price} onChange={set('cost_price')} /></Field>}
        <Field label="GST rate (%)"><Input type="number" min="0" value={form.gst_rate} onChange={set('gst_rate')} /></Field>
        <Field label="HSN / SAC"><Input value={form.hsn} onChange={set('hsn')} /></Field>
        <div className="form-section">Supply</div>
        <Field label="Warranty (months)"><Input type="number" min="0" value={form.warranty_months} onChange={set('warranty_months')} /></Field>
        <Field label="Lead time (days)"><Input type="number" min="0" value={form.lead_time_days} onChange={set('lead_time_days')} /></Field>
        <Field label="Availability"><Select value={form.stock_type} onChange={set('stock_type')} options={STOCK_TYPES} /></Field>
        <Field label="Stock on hand"><Input type="number" min="0" value={form.stock_qty} onChange={set('stock_qty')} /></Field>
        <Field label="Status"><Select value={form.status} onChange={set('status')} options={STATUSES} /></Field>
        <div className="form-section">Technical specifications</div>
        <div className="full stack-sm">
          {specs.map(([k, v], i) => (
            <div key={i} className="row">
              <Input placeholder="Parameter" value={k} onChange={(e) => setSpecs((s) => s.map((row, ri) => (ri === i ? [e.target.value, row[1]] : row)).concat(i === s.length - 1 && e.target.value ? [['', '']] : []))} />
              <Input placeholder="Value" value={v} onChange={(e) => setSpecs((s) => s.map((row, ri) => (ri === i ? [row[0], e.target.value] : row)))} />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function OptionModal({ option, productId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(option.id ? option : { group_name: '', name: '', price_delta: 0, cost_delta: 0, lead_time_delta: 0 });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    try {
      if (option.id) await api.put(`/product-options/${option.id}`, form);
      else await api.post(`/products/${productId}/options`, form);
      toast.success('Option saved');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={option.id ? 'Edit option' : 'Add configurator option'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Option group" required hint="e.g. Rating, Communication"><Input value={form.group_name} onChange={set('group_name')} /></Field>
        <Field label="Option name" required><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Price change (₹)"><Input type="number" value={form.price_delta} onChange={set('price_delta')} /></Field>
        <Field label="Cost change (₹)"><Input type="number" value={form.cost_delta} onChange={set('cost_delta')} /></Field>
        <Field label="Extra lead time (days)"><Input type="number" value={form.lead_time_delta} onChange={set('lead_time_delta')} /></Field>
      </div>
    </Modal>
  );
}

function DocModal({ productId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ doc_type: 'datasheet' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} size="sm" title="Add document"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try {
          await api.post(`/products/${productId}/documents`, form);
          toast.success('Document added');
          onSaved();
        } catch (err) {
          toast.error(err.message);
        }
      }}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Type"><Select value={form.doc_type} onChange={set('doc_type')} options={[{ value: 'datasheet', label: 'Datasheet' }, { value: 'manual', label: 'Manual' }, { value: 'drawing', label: 'Drawing' }, { value: 'certificate', label: 'Certificate' }, { value: 'video', label: 'Video' }]} /></Field>
        <Field label="Title" required><Input value={form.title} onChange={set('title')} /></Field>
        <Field label="Link" className="full" required><Input value={form.url} onChange={set('url')} placeholder="https://…" /></Field>
      </div>
    </Modal>
  );
}

function CategoryModal({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  return (
    <Modal open onClose={onClose} size="sm" title="New product category"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try {
          await api.post('/categories', form);
          toast.success('Category created');
          onSaved();
        } catch (err) {
          toast.error(err.message);
        }
      }}>Create</Button></>}>
      <div className="form-grid">
        <Field label="Name" required className="full"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
        <Field label="Description" className="full"><Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
      </div>
    </Modal>
  );
}
