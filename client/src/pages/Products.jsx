// Product master & price list: models with standard / dealer / distributor / minimum prices and cost, GST,
// warranty, lead time, configurator options (price, cost and lead-time deltas) and datasheets.
// Codes are stable; a product that has been used is deactivated, never deleted.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { STOCK_TYPES, PRODUCT_DOC_TYPES, CURRENCIES, labelOf } from '@shared/constants.js';
import { api, openFile, uploadFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { date, dateTime, number, pct, qty as fmtQty, money } from '../lib/format.js';
import {
  Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Facts, Field, Input, Modal, Notice, PageHeader, SaveStatus, SearchBox,
  Select, Spinner, Stat, Tabs, Textarea, useConfirm, useToast,
} from '../components/ui.jsx';
import { Money, OptionSelect, useMeta } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

const toMajor = (minor) => (minor === null || minor === undefined ? '' : String(minor / 100));
const err = (save, k) => save.fields?.[k];

export function marginAtList(p) {
  if (p.standard_price_minor === undefined || p.cost_price_minor === undefined) return undefined;
  if (!p.standard_price_minor || p.cost_price_minor === null) return null;
  return ((p.standard_price_minor - p.cost_price_minor) / p.standard_price_minor) * 100;
}

function StockBadge({ p }) {
  return (
    <span className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
      <Badge size="sm" tone={p.stock_type === 'stock' ? 'green' : 'blue'}>{labelOf(STOCK_TYPES, p.stock_type)}</Badge>
      {p.stock_type === 'stock' && p.stock_qty !== null && p.stock_qty !== undefined && <span className="tiny muted">{number(p.stock_qty)} in stock</span>}
    </span>
  );
}

// ------------------------------------------------------------------ list
export default function Products() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters({ status: 'active' });
  const { data, loading, error, reload } = useApi('/products', { q: f.q, category_id: f.category_id, status: f.status === 'all' ? '' : f.status, stock_type: f.stock_type });
  const [editing, setEditing] = useState(null);
  const [cats, setCats] = useState(false);
  const canEdit = can('products.edit');
  const margin = can('margin.view');
  const values = can('values.view');

  const columns = [
    { key: 'code', label: 'Model / code', render: (p) => <div className="col" style={{ gap: 0 }}><span className="strong mono">{p.code}</span>{p.model && <span className="tiny muted">{p.model}</span>}</div> },
    { key: 'name', label: 'Product', render: (p) => (
      <div className="col" style={{ gap: 0, maxWidth: 340 }}>
        <span className="strong">{p.name}</span>
        <span className="tiny muted truncate">{Object.entries(p.specs || {}).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' · ') || p.description || ''}</span>
      </div>
    ) },
    { key: 'category', label: 'Category', render: (p) => <span className="small">{p.category_name || <span className="muted">—</span>}</span> },
    values && { key: 'std', label: 'Standard', align: 'num', render: (p) => <Money minor={p.standard_price_minor} currency={p.price_currency} /> },
    values && { key: 'dealer', label: 'Dealer', align: 'num', render: (p) => (p.dealer_price_minor ? <Money minor={p.dealer_price_minor} currency={p.price_currency} /> : <span className="muted small">= standard</span>) },
    values && { key: 'dist', label: 'Distributor', align: 'num', render: (p) => (p.distributor_price_minor ? <Money minor={p.distributor_price_minor} currency={p.price_currency} /> : <span className="muted small">= standard</span>) },
    margin && { key: 'min', label: 'Min. selling', align: 'num', render: (p) => (p.min_price_minor ? <span className="warning-text"><Money minor={p.min_price_minor} currency={p.price_currency} /></span> : <span className="muted">—</span>) },
    margin && { key: 'margin', label: 'Margin at list', align: 'num', render: (p) => { const m = marginAtList(p); return m === null || m === undefined ? <span className="muted">—</span> : pct(m); } },
    { key: 'gst', label: 'GST', align: 'num', render: (p) => `${number(p.gst_rate, 2)}%` },
    { key: 'lead', label: 'Lead time', align: 'num', render: (p) => (p.lead_time_days !== null && p.lead_time_days !== undefined ? `${p.lead_time_days} d` : <span className="muted">—</span>) },
    { key: 'stock', label: 'Availability', render: (p) => <StockBadge p={p} /> },
    { key: 'extras', label: 'Options / docs', render: (p) => <span className="small muted">{p.option_count ? `${p.option_count} option${p.option_count === 1 ? '' : 's'}` : '—'}{p.document_count ? ` · ${p.document_count} doc${p.document_count === 1 ? '' : 's'}` : ''}</span> },
    { key: 'status', label: 'Status', render: (p) => (p.active ? <Badge size="sm" tone="green">Active</Badge> : <Badge size="sm">Inactive</Badge>) },
  ];

  return (
    <div className="stack">
      <PageHeader title="Products & price list" subtitle="Approved prices, minimum selling price, GST, warranty, lead time, configurator options and datasheets"
        actions={canEdit && <><Button icon="tag" onClick={() => setCats(true)}>Categories</Button><Button variant="primary" icon="plus" onClick={() => setEditing({})}>New product</Button></>} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Code, name, model or family" />
        <Select aria-label="Category" value={f.category_id || ''} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="All categories" options={meta.categories.map((c) => ({ value: String(c.id), label: c.name }))} />
        <Select aria-label="Availability" value={f.stock_type || ''} onChange={(e) => setFilter({ stock_type: e.target.value })} placeholder="Stock & made to order" options={STOCK_TYPES} />
        <Select aria-label="Status" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} options={[{ value: 'active', label: 'Active products' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All products' }]} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns} rows={data} loading={loading} onRowClick={(p) => navigate(`/products/${p.id}`)}
          empty={<EmptyState icon="box" title="No products" message={f.q ? 'Nothing matches this search.' : 'Add the first model to the price list.'} />}
          card={(p) => (
            <>
              <div className="row between"><span className="strong mono">{p.code}</span>{p.active ? <Badge size="sm" tone="green">Active</Badge> : <Badge size="sm">Inactive</Badge>}</div>
              <div>{p.name}</div>
              <div className="row between small"><span className="muted">{p.category_name}</span>{values && <Money minor={p.standard_price_minor} currency={p.price_currency} />}</div>
            </>
          )} />
      </Card>
      {editing && <ProductForm product={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); reload(); meta.reload(); if (r?.id && !editing.id) navigate(`/products/${r.id}`); }} />}
      {cats && <CategoriesModal onClose={() => { setCats(false); meta.reload(); reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ detail page
export function ProductDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useApi(`/products/${id}`);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [option, setOption] = useState(null);
  const [doc, setDoc] = useState(false);
  const canEdit = can('products.edit');
  const margin = can('margin.view');
  const values = can('values.view');
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { product: p, options, documents, demand, stats, customers, history } = data;
  const m = marginAtList(p);
  const groups = options.reduce((acc, o) => ({ ...acc, [o.group_name]: [...(acc[o.group_name] || []), o] }), {});

  const toggleActive = async () => {
    if (p.active && !(await confirm({ title: `Deactivate ${p.code}?`, message: 'It stays on existing enquiries, quotations and orders but cannot be chosen for new ones.', confirmLabel: 'Deactivate' }))) return;
    try {
      await api.put(`/products/${p.id}`, { active: !p.active, version: p.version });
      toast.success(p.active ? 'Product deactivated' : 'Product reactivated');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Products', to: '/products' }, { label: p.code }]} title={`${p.code} — ${p.name}`}
        eyebrow={<>{p.category_name || 'Uncategorised'} {!p.active && <Badge size="sm">Inactive</Badge>}</>}
        subtitle={p.model ? `Model ${p.model}` : undefined}
        actions={canEdit && <><Button onClick={toggleActive}>{p.active ? 'Deactivate' : 'Reactivate'}</Button><Button variant="primary" icon="edit" onClick={() => setEditing(true)}>Edit product</Button></>} />
      <div className="tiles">
        {values && <div className="stat"><span className="k">Standard price</span><span className="v"><Money minor={p.standard_price_minor} currency={p.price_currency} /></span><span className="d">excl. GST {number(p.gst_rate, 2)}%</span></div>}
        <Stat k="Lead time" v={p.lead_time_days !== null && p.lead_time_days !== undefined ? `${p.lead_time_days} days` : '—'} d={labelOf(STOCK_TYPES, p.stock_type)} />
        <Stat k="Open enquiries" v={number(stats.open_enquiries)} d={`${number(stats.enquiries)} enquiries in total`} />
        <Stat k="Open complaints" v={number(stats.open_complaints)} d={`${number(stats.complaints)} logged in total`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Specification & prices' },
        { key: 'options', label: 'Configurator', count: options.filter((o) => o.active).length },
        { key: 'docs', label: 'Documents', count: documents.length },
        { key: 'demand', label: 'Demand & customers' },
        { key: 'history', label: 'History', count: history.length },
      ]} />
      {tab === 'overview' && (
        <div className="grid grid-2">
          <Card title="Commercial">
            <Facts items={[
              values && ['Standard price', <strong><Money minor={p.standard_price_minor} currency={p.price_currency} /></strong>],
              values && ['Dealer price', p.dealer_price_minor ? <Money minor={p.dealer_price_minor} currency={p.price_currency} /> : 'Same as standard'],
              values && ['Distributor price', p.distributor_price_minor ? <Money minor={p.distributor_price_minor} currency={p.price_currency} /> : 'Same as standard'],
              margin && ['Minimum selling price', p.min_price_minor ? <span className="warning-text"><Money minor={p.min_price_minor} currency={p.price_currency} /></span> : 'Not set'],
              margin && ['Cost price', p.cost_price_minor ? <Money minor={p.cost_price_minor} currency={p.price_currency} /> : 'Not set'],
              margin && ['Margin at standard price', m === null || m === undefined ? '—' : pct(m)],
              ['Price currency', p.price_currency],
              ['GST rate', `${number(p.gst_rate, 2)}%`],
              ['HSN / SAC', p.hsn],
              !values && ['Prices', <span className="muted">Hidden for your role</span>],
            ]} />
          </Card>
          <Card title="Supply & service">
            <Facts items={[
              ['Model', p.model],
              ['Unit', p.default_unit],
              ['Whole quantities only', p.integer_qty ? 'Yes' : 'No — decimals allowed'],
              ['Warranty', p.warranty_months ? `${p.warranty_months} months` : null],
              ['Production lead time', p.lead_time_days !== null && p.lead_time_days !== undefined ? `${p.lead_time_days} days` : null],
              ['Availability', labelOf(STOCK_TYPES, p.stock_type)],
              p.stock_type === 'stock' && ['Stock on hand', p.stock_qty === null || p.stock_qty === undefined ? null : fmtQty(p.stock_qty, p.default_unit)],
              ['Specification prompt', p.spec_hint],
            ]} />
          </Card>
          <Card title="Technical specification" className="span-all">
            {Object.keys(p.specs || {}).length ? <Facts items={Object.entries(p.specs)} /> : <div className="muted small">No specification recorded.</div>}
            {p.description && <p className="small secondary mt-12" style={{ whiteSpace: 'pre-wrap' }}>{p.description}</p>}
          </Card>
        </div>
      )}
      {tab === 'options' && (
        <Card title="Configurator options" sub="Priced variants the quotation builder offers for this model" flush
          actions={canEdit && <Button size="sm" icon="plus" onClick={() => setOption({})}>Add option</Button>}>
          {!options.length && <EmptyState icon="sliders" title="No options" message="Add option groups such as rating, communication or enclosure." />}
          {Object.entries(groups).map(([group, list]) => (
            <div key={group}>
              <div className="form-section" style={{ padding: '10px 16px 4px', margin: 0, border: 0 }}>{group}</div>
              {list.map((o) => (
                <div key={o.id} className="alert-row">
                  <span className="grow"><strong>{o.name}</strong> {!o.active && <Badge size="sm">Inactive</Badge>}</span>
                  {o.price_delta_minor !== undefined && <span className="small num">{o.price_delta_minor >= 0 ? '+' : '−'}{money(Math.abs(o.price_delta_minor), p.price_currency)}</span>}
                  {margin && o.cost_delta_minor !== undefined && o.cost_delta_minor !== 0 && <span className="tiny muted num">cost {o.cost_delta_minor >= 0 ? '+' : '−'}{money(Math.abs(o.cost_delta_minor), p.price_currency)}</span>}
                  {o.lead_time_delta ? <Badge size="sm" tone="amber">+{o.lead_time_delta} days</Badge> : null}
                  {canEdit && <Button size="xs" variant="ghost" icon="edit" onClick={() => setOption(o)} aria-label={`Edit ${o.name}`} />}
                  {canEdit && o.active ? <Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${o.name}`} onClick={async () => {
                    if (!(await confirm({ title: 'Remove option?', message: `${o.group_name}: ${o.name}. If it was already quoted or ordered it is deactivated instead, so those documents keep it.`, danger: true, confirmLabel: 'Remove' }))) return;
                    try {
                      const r = await api.del(`/products/${p.id}/options/${o.id}`);
                      toast.success(r.deactivated ? 'Option was in use — deactivated instead' : 'Option removed');
                      reload();
                    } catch (e) {
                      toast.error(e.message);
                    }
                  }} /> : null}
                </div>
              ))}
            </div>
          ))}
        </Card>
      )}
      {tab === 'docs' && (
        <Card title="Datasheets, manuals & certificates" flush actions={canEdit && <Button size="sm" icon="plus" onClick={() => setDoc(true)}>Add document</Button>}>
          {!documents.length && <EmptyState icon="file" title="No documents" message="Upload a datasheet or link to one on the website." />}
          {documents.map((d) => (
            <div key={d.id} className="alert-row">
              <Icon name={d.attachment_id ? 'paperclip' : 'link'} size={15} />
              <span className="grow">
                {d.attachment_id
                  ? <button type="button" className="btn link" onClick={() => openFile(d.attachment_id).catch((e) => toast.error(e.message))}>{d.title}</button>
                  : <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a>}
                <div className="tiny muted">{labelOf(PRODUCT_DOC_TYPES, d.doc_type)}{d.original_name ? ` · ${d.original_name}` : ''} · added {date(d.created_at)}</div>
              </span>
              {canEdit && <Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${d.title}`} onClick={async () => {
                if (!(await confirm({ title: 'Remove document?', message: d.title, danger: true, confirmLabel: 'Remove' }))) return;
                await api.del(`/products/${p.id}/documents/${d.id}`).then(reload, (e) => toast.error(e.message));
              }} />}
            </div>
          ))}
        </Card>
      )}
      {tab === 'demand' && (
        <div className="grid grid-2">
          <Card title="Confirmed demand" sub="Per currency — never added across currencies">
            {!demand.length && <div className="muted small">No confirmed orders for this product yet.</div>}
            {demand.map((d) => (
              <div key={d.currency} className="stack-xs mb-12">
                <div className="strong">{d.currency}</div>
                <Facts items={[
                  ['Quantity ordered', fmtQty(d.qty, p.default_unit)],
                  ['Dispatched', fmtQty(d.dispatched, p.default_unit)],
                  values && ['Order value', <Money minor={d.value_minor} currency={d.currency} />],
                  d.unpriced_lines > 0 && ['Lines without a price', <span className="warning-text">{d.unpriced_lines} — value excludes them</span>],
                  ['Orders', number(d.orders)],
                  ['Customers', number(d.customers)],
                ]} />
              </div>
            ))}
            <div className="small muted">{number(stats.active_lines)} order line{stats.active_lines === 1 ? '' : 's'} still open.</div>
          </Card>
          <Card title="Customers buying this model" flush>
            <DataTable compact rows={customers} rowKey="id" columns={[
              { key: 'c', label: 'Customer', render: (c) => <Link to={`/customers/${c.id}`}>{c.company_name}</Link> },
              { key: 'o', label: 'Orders', align: 'num', render: (c) => number(c.orders) },
              { key: 'l', label: 'Last order', render: (c) => date(c.last_order) },
            ]} empty={<div className="muted small" style={{ padding: 12 }}>No orders yet.</div>} />
          </Card>
        </div>
      )}
      {tab === 'history' && (
        <Card title="Change history" sub="Price changes are recorded field by field" flush>
          {!history.length && <EmptyState title="No changes recorded" />}
          {history.map((h, i) => (
            <div key={i} className="alert-row">
              <span className="grow">
                <strong>{historyLabel(h.action)}</strong>
                {h.action === 'price_change' && (
                  <div className="small secondary">{(h.changes.prices || []).map((c) => `${c.field.replace('_minor', '').replace(/_/g, ' ')}: ${c.from === null || c.from === undefined ? '—' : money(c.from, p.price_currency)} → ${c.to === null || c.to === undefined ? '—' : money(c.to, p.price_currency)}`).join(' · ')}</div>
                )}
                {['option_add', 'option_update'].includes(h.action) && <div className="small secondary">{h.changes.group_name}: {h.changes.name}</div>}
                {h.action.startsWith('document') && <div className="small secondary">{h.changes.title}</div>}
              </span>
              <span className="tiny muted">{h.actor_name || 'System'} · {dateTime(h.created_at)}</span>
            </div>
          ))}
        </Card>
      )}
      {editing && <ProductForm product={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {option && <OptionForm productId={p.id} option={option.id ? option : null} groups={Object.keys(groups)} currency={p.price_currency} onClose={() => setOption(null)} onSaved={() => { setOption(null); reload(); }} />}
      {doc && <DocumentForm productId={p.id} onClose={() => setDoc(false)} onSaved={() => { setDoc(false); reload(); }} />}
      {loading && <span className="sr-only">Refreshing…</span>}
    </div>
  );
}

const HISTORY_LABELS = {
  create: 'Product created', update: 'Details updated', price_change: 'Prices changed', option_add: 'Option added', option_update: 'Option updated',
  option_delete: 'Option removed', option_deactivate: 'Option deactivated (in use)', document_add: 'Document added', document_remove: 'Document removed',
};
const historyLabel = (a) => HISTORY_LABELS[a] || a.replace(/_/g, ' ');

// ------------------------------------------------------------------ forms
export function ProductForm({ product, onClose, onSaved }) {
  const meta = useMeta();
  const { can } = useAuth();
  const save = useSave();
  const margin = can('margin.view');
  const [f, setF] = useState(() => (product ? {
    code: product.code, name: product.name, model: product.model || '', category_id: product.category_id ? String(product.category_id) : '', description: product.description || '',
    hsn: product.hsn || '', default_unit: product.default_unit || 'pcs', integer_qty: Boolean(product.integer_qty), spec_hint: product.spec_hint || '', price_currency: product.price_currency || 'INR',
    standard_price: toMajor(product.standard_price_minor), dealer_price: toMajor(product.dealer_price_minor), distributor_price: toMajor(product.distributor_price_minor),
    min_price: toMajor(product.min_price_minor), cost_price: toMajor(product.cost_price_minor), gst_rate: product.gst_rate ?? 18, warranty_months: product.warranty_months ?? '',
    lead_time_days: product.lead_time_days ?? '', stock_type: product.stock_type || 'made_to_order', stock_qty: product.stock_qty ?? '',
  } : {
    code: '', name: '', model: '', category_id: '', description: '', hsn: '', default_unit: 'pcs', integer_qty: true, spec_hint: '', price_currency: 'INR',
    standard_price: '', dealer_price: '', distributor_price: '', min_price: '', cost_price: '', gst_rate: 18, warranty_months: 18, lead_time_days: 14, stock_type: 'made_to_order', stock_qty: '',
  }));
  const [specs, setSpecs] = useState(() => [...Object.entries(product?.specs || {}), ['', '']]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const setSpec = (i, j, v) => setSpecs((rows) => {
    const next = rows.map((r, ri) => (ri === i ? (j === 0 ? [v, r[1]] : [r[0], v]) : r));
    return i === rows.length - 1 && v ? [...next, ['', '']] : next;
  });
  const visibleMinor = (k) => !product || product[`${k}_minor`] !== undefined;

  const submit = () => save.run(async () => {
    const body = {
      ...f, specs: Object.fromEntries(specs.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])), category_id: f.category_id || null,
      warranty_months: f.warranty_months === '' ? null : f.warranty_months, lead_time_days: f.lead_time_days === '' ? null : f.lead_time_days, stock_qty: f.stock_qty === '' ? null : f.stock_qty,
      version: product?.version,
    };
    for (const k of ['standard_price', 'dealer_price', 'distributor_price', 'min_price', 'cost_price']) {
      if (!visibleMinor(k) || (!margin && ['min_price', 'cost_price'].includes(k))) delete body[k];
    }
    const r = product ? await api.put(`/products/${product.id}`, body) : await api.post('/products', body);
    onSaved(r);
    return r;
  });

  return (
    <Modal open size="lg" onClose={onClose} title={product ? `Edit ${product.code}` : 'New product'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save product</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {save.conflict && <div className="full"><Notice tone="warn" title="Someone else changed this product">Close and reopen it to see the latest version, then apply your change again.</Notice></div>}
        <Field label="Model / code" required error={err(save, 'code')} hint="Stable — used on quotations and orders"><Input value={f.code} onChange={(e) => set({ code: e.target.value })} /></Field>
        <Field label="Model name" optional error={err(save, 'model')}><Input value={f.model} onChange={(e) => set({ model: e.target.value })} /></Field>
        <Field label="Product name" required className="full" error={err(save, 'name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Category" error={err(save, 'category_id')}><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })} placeholder="Uncategorised" options={meta.categories.filter((c) => c.active || String(c.id) === f.category_id).map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
        <Field label="Unit" error={err(save, 'default_unit')}><OptionSelect category="unit" value={f.default_unit} onChange={(v) => set({ default_unit: v })} /></Field>
        <div className="full"><Checkbox label="Whole quantities only (no decimals)" checked={f.integer_qty} onChange={(v) => set({ integer_qty: v })} /></div>
        <Field label="Description" optional className="full"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} /></Field>
        <Field label="Specification prompt" optional className="full" hint="Shown when this model is added to an enquiry, e.g. “CT ratio, communication”"><Input value={f.spec_hint} onChange={(e) => set({ spec_hint: e.target.value })} /></Field>

        <div className="form-section">Prices (excluding GST)</div>
        <Field label="Price currency" error={err(save, 'price_currency')} hint="Quotations in another currency are priced manually"><Select value={f.price_currency} onChange={(e) => set({ price_currency: e.target.value })} options={CURRENCIES} /></Field>
        {visibleMinor('standard_price') && <Field label="Standard price" error={err(save, 'standard_price')}><Input inputMode="decimal" value={f.standard_price} onChange={(e) => set({ standard_price: e.target.value })} placeholder="e.g. 12500" /></Field>}
        {visibleMinor('dealer_price') && <Field label="Dealer price" optional error={err(save, 'dealer_price')} hint="Blank = standard price"><Input inputMode="decimal" value={f.dealer_price} onChange={(e) => set({ dealer_price: e.target.value })} /></Field>}
        {visibleMinor('distributor_price') && <Field label="Distributor price" optional error={err(save, 'distributor_price')} hint="Blank = standard price"><Input inputMode="decimal" value={f.distributor_price} onChange={(e) => set({ distributor_price: e.target.value })} /></Field>}
        {margin && visibleMinor('min_price') && <Field label="Minimum selling price" optional error={err(save, 'min_price')} hint="Quoting below it needs approval"><Input inputMode="decimal" value={f.min_price} onChange={(e) => set({ min_price: e.target.value })} /></Field>}
        {margin && visibleMinor('cost_price') && <Field label="Cost price" optional error={err(save, 'cost_price')} hint="Used for margin checks; never shown to customers"><Input inputMode="decimal" value={f.cost_price} onChange={(e) => set({ cost_price: e.target.value })} /></Field>}
        <Field label="GST rate (%)" error={err(save, 'gst_rate')}><Input type="number" min={0} max={40} step="0.01" value={f.gst_rate} onChange={(e) => set({ gst_rate: e.target.value })} /></Field>
        <Field label="HSN / SAC" optional error={err(save, 'hsn')}><Input value={f.hsn} onChange={(e) => set({ hsn: e.target.value })} /></Field>

        <div className="form-section">Supply</div>
        <Field label="Warranty (months)" optional error={err(save, 'warranty_months')}><Input type="number" min={0} value={f.warranty_months} onChange={(e) => set({ warranty_months: e.target.value })} /></Field>
        <Field label="Lead time (days)" optional error={err(save, 'lead_time_days')}><Input type="number" min={0} value={f.lead_time_days} onChange={(e) => set({ lead_time_days: e.target.value })} /></Field>
        <Field label="Availability" error={err(save, 'stock_type')}><Select value={f.stock_type} onChange={(e) => set({ stock_type: e.target.value })} options={STOCK_TYPES} /></Field>
        {f.stock_type === 'stock' && <Field label="Stock on hand" optional error={err(save, 'stock_qty')}><Input type="number" min={0} step="any" value={f.stock_qty} onChange={(e) => set({ stock_qty: e.target.value })} /></Field>}

        <div className="form-section">Technical specification</div>
        <div className="full stack-xs">
          {specs.map(([k, v], i) => (
            <div key={i} className="row">
              <Input placeholder="Parameter, e.g. Accuracy" value={k} onChange={(e) => setSpec(i, 0, e.target.value)} aria-label={`Specification ${i + 1} name`} />
              <Input placeholder="Value, e.g. Class 0.5S" value={v} onChange={(e) => setSpec(i, 1, e.target.value)} aria-label={`Specification ${i + 1} value`} />
              {i < specs.length - 1 && <Button size="sm" variant="ghost" icon="x" aria-label="Remove row" onClick={() => setSpecs((rows) => rows.filter((_, ri) => ri !== i))} />}
            </div>
          ))}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function OptionForm({ productId, option, groups, currency, onClose, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const [f, setF] = useState(option ? {
    group_name: option.group_name, name: option.name, price_delta: toMajor(option.price_delta_minor), cost_delta: toMajor(option.cost_delta_minor), lead_time_delta: option.lead_time_delta || 0, active: Boolean(option.active), sort_order: option.sort_order || 0,
  } : { group_name: groups[0] || '', name: '', price_delta: '0', cost_delta: '0', lead_time_delta: 0, active: true, sort_order: 0 });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const body = { ...f };
    if (!can('margin.view')) delete body.cost_delta;
    const r = option ? await api.put(`/products/${productId}/options/${option.id}`, body) : await api.post(`/products/${productId}/options`, body);
    onSaved(r);
    return r;
  });
  return (
    <Modal open size="sm" onClose={onClose} title={option ? 'Edit option' : 'Add configurator option'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save option</Button></>}>
      <div className="form-grid">
        <Field label="Option group" required error={err(save, 'group_name')} hint="e.g. Rating, Communication">
          <Input value={f.group_name} onChange={(e) => set({ group_name: e.target.value })} list="option-groups" />
          <datalist id="option-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
        <Field label="Option" required error={err(save, 'name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. RS-485 Modbus" /></Field>
        <Field label={`Price change (${currency})`} error={err(save, 'price_delta')} hint="Negative for a cheaper variant"><Input inputMode="decimal" value={f.price_delta} onChange={(e) => set({ price_delta: e.target.value })} /></Field>
        {can('margin.view') && <Field label={`Cost change (${currency})`} error={err(save, 'cost_delta')}><Input inputMode="decimal" value={f.cost_delta} onChange={(e) => set({ cost_delta: e.target.value })} /></Field>}
        <Field label="Extra lead time (days)" error={err(save, 'lead_time_delta')}><Input type="number" value={f.lead_time_delta} onChange={(e) => set({ lead_time_delta: e.target.value })} /></Field>
        <Field label="Sort order" optional><Input type="number" value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} /></Field>
        {option && <div className="full"><Checkbox label="Active — offered on new quotations" checked={f.active} onChange={(v) => set({ active: v })} /></div>}
      </div>
    </Modal>
  );
}

function DocumentForm({ productId, onClose, onSaved }) {
  const toast = useToast();
  const save = useSave();
  const ref = useRef(null);
  const [f, setF] = useState({ doc_type: 'datasheet', title: '', url: '', file: null });
  const [uploading, setUploading] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const r = await api.post(`/products/${productId}/documents`, { doc_type: f.doc_type, title: f.title, url: f.file ? undefined : f.url, attachment_id: f.file?.id });
    onSaved(r);
    return r;
  });
  return (
    <Modal open size="sm" onClose={onClose} title="Add document"
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Add document</Button></>}>
      <div className="stack-sm">
        <div className="form-grid">
          <Field label="Type" error={err(save, 'doc_type')}><Select value={f.doc_type} onChange={(e) => set({ doc_type: e.target.value })} options={PRODUCT_DOC_TYPES} /></Field>
          <Field label="Title" required error={err(save, 'title')}><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Datasheet 2026" /></Field>
        </div>
        <Field label="File" hint="PDF, image or Office file, max 20 MB" error={err(save, 'attachment_id')}>
          <input ref={ref} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.pptx" onChange={async (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;
            setUploading(true);
            try {
              const r = await uploadFile(file, {});
              set({ file: { id: r.id, name: r.original_name }, title: f.title || file.name.replace(/\.[^.]+$/, '') });
            } catch (ex) {
              toast.error(ex.message);
            } finally {
              setUploading(false);
            }
          }} />
          <div className="row wrap">
            <Button size="sm" icon="upload" loading={uploading} onClick={() => ref.current?.click()}>{f.file ? 'Replace file' : 'Upload file'}</Button>
            {f.file && <span className="small"><Icon name="file" size={13} /> {f.file.name} <button type="button" className="btn link" onClick={() => set({ file: null })}>Remove</button></span>}
          </div>
        </Field>
        {!f.file && <Field label="…or a link" error={err(save, 'url')} hint="e.g. the datasheet on the website"><Input value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" /></Field>}
      </div>
    </Modal>
  );
}

function CategoriesModal({ onClose }) {
  const toast = useToast();
  const { data, reload } = useApi('/product-categories');
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [editing, setEditing] = useState(null);
  const save = useSave();
  const rows = useMemo(() => data || [], [data]);
  const add = () => save.run(async () => {
    await api.post('/product-categories', draft);
    setDraft({ name: '', description: '' });
    toast.success('Category added');
    reload();
  });
  const update = async (c, patch) => {
    try {
      await api.put(`/product-categories/${c.id}`, patch);
      setEditing(null);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <Modal open size="lg" onClose={onClose} title="Product categories" subtitle="Categories are the product families used in filters, assignment rules and reports. Renaming one updates every product in it."
      footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Category</th><th className="num">Products</th><th>Status</th><th /></tr></thead>
            <tbody>
              {!data && <tr><td colSpan={4}><Spinner /></td></tr>}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    {editing?.id === c.id ? (
                      <div className="row"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="Category name" /><Button size="sm" variant="primary" onClick={() => update(c, { name: editing.name })}>Save</Button><Button size="sm" onClick={() => setEditing(null)}>Cancel</Button></div>
                    ) : <><strong>{c.name}</strong>{c.description && <div className="sub">{c.description}</div>}</>}
                  </td>
                  <td className="num">{c.active_count} active{c.product_count !== c.active_count ? ` / ${c.product_count}` : ''}</td>
                  <td>{c.active ? <Badge size="sm" tone="green">Active</Badge> : <Badge size="sm">Inactive</Badge>}</td>
                  <td className="num nowrap">
                    <Button size="xs" variant="ghost" icon="edit" aria-label={`Rename ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name })} />
                    <Button size="xs" onClick={() => update(c, { active: !c.active })}>{c.active ? 'Deactivate' : 'Activate'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="form-grid">
          <div className="form-section">Add a category</div>
          <Field label="Name" required error={err(save, 'name')}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Description" optional><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
          <div className="full row between"><SaveStatus save={save} /><Button variant="primary" icon="plus" loading={save.saving} onClick={add}>Add category</Button></div>
        </div>
      </div>
    </Modal>
  );
}
