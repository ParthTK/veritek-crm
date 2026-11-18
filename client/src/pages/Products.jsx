// The product catalogue: codes, prices, GST and datasheets. Codes stay stable; a used product is deactivated, never deleted.
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PRODUCT_DOC_TYPES, labelOf } from '@shared/constants.js';
import { api, openFile, uploadFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { date, number } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Facts, Field, Input, Modal, Notice, PageHeader, SaveStatus, SearchBox, Select, Spinner, Textarea, useConfirm, useToast,
} from '../components/ui.jsx';
import { Money, OptionSelect, useMeta } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

const toMajor = (minor) => (minor === null || minor === undefined ? '' : String(minor / 100));
const err = (save, k) => save.fields?.[k];
const ActiveBadge = ({ active }) => (active ? <Badge size="sm" tone="green">Active</Badge> : <Badge size="sm">Inactive</Badge>);

// ------------------------------------------------------------------ list
export default function Products() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters({ status: 'active' });
  const { data, loading, error, reload } = useApi('/products', { q: f.q, category_id: f.category_id, status: f.status === 'all' ? '' : f.status });
  const [adding, setAdding] = useState(false);
  const [cats, setCats] = useState(false);
  const canEdit = can('products.edit');
  const values = can('values.view');
  const columns = [
    { key: 'code', label: 'Code', render: (p) => <span className="strong mono">{p.code}</span> },
    { key: 'name', label: 'Product', render: (p) => p.name },
    { key: 'category', label: 'Category', render: (p) => <span className="small">{p.category_name || <span className="muted">—</span>}</span> },
    values && { key: 'price', label: 'Price', align: 'num', render: (p) => <Money minor={p.standard_price_minor} currency={p.price_currency} empty="Not set" /> },
    { key: 'gst', label: 'GST', align: 'num', render: (p) => `${number(p.gst_rate, 2)}%` },
    { key: 'status', label: 'Status', render: (p) => <ActiveBadge active={p.active} /> },
  ];
  return (
    <div className="stack">
      <PageHeader title="Products" actions={canEdit && <><Button icon="tag" onClick={() => setCats(true)}>Categories</Button><Button variant="cta" icon="plus" onClick={() => setAdding(true)}>New product</Button></>} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Code or name…" />
        <Select aria-label="Category" value={f.category_id || ''} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="All categories" options={meta.categories.map((c) => ({ value: String(c.id), label: c.name }))} />
        <Select aria-label="Status" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }]} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable columns={columns.filter(Boolean)} rows={data} loading={loading} onRowClick={(p) => navigate(`/products/${p.id}`)}
          empty={<EmptyState icon="box" title="No products here" />}
          card={(p) => <><div className="row between"><span className="strong mono">{p.code}</span><ActiveBadge active={p.active} /></div><div>{p.name}</div>{values && <div className="small"><Money minor={p.standard_price_minor} currency={p.price_currency} empty="Price not set" /></div>}</>} />
      </Card>
      {adding && <ProductForm onClose={() => setAdding(false)} onSaved={(r) => { meta.reload(); navigate(`/products/${r.id}`); }} />}
      {cats && <CategoriesModal onClose={() => { setCats(false); meta.reload(); reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ one product
export function ProductDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta();
  const { data, error, reload } = useApi(`/products/${id}`);
  const [editing, setEditing] = useState(false);
  const [doc, setDoc] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { product: p, documents } = data;
  const canEdit = can('products.edit');
  const specs = Object.entries(p.specs || {});
  const toggleActive = async () => {
    if (p.active && !(await confirm({ title: `Deactivate ${p.code}?`, message: 'It stays on existing records but cannot be chosen for new ones.', confirmLabel: 'Deactivate' }))) return;
    try {
      await api.put(`/products/${p.id}`, { active: !p.active, version: p.version });
      toast.success(p.active ? 'Product deactivated' : 'Product reactivated');
      reload();
      meta.reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Products', to: '/products' }, { label: p.code }]} title={`${p.code} — ${p.name}`}
        eyebrow={<>{p.category_name || 'No category'} {!p.active && <Badge size="sm">Inactive</Badge>}</>}
        actions={canEdit && <><Button onClick={toggleActive}>{p.active ? 'Deactivate' : 'Reactivate'}</Button><Button variant="primary" icon="edit" onClick={() => setEditing(true)}>Edit</Button></>} />
      <div className="grid grid-2">
        <Card title="Details">
          <Facts items={[
            can('values.view') && ['Price', <strong><Money minor={p.standard_price_minor} currency={p.price_currency} empty="Not set" /></strong>],
            ['GST', `${number(p.gst_rate, 2)}%`],
            ['HSN', p.hsn],
            ['Unit', p.default_unit],
            ['Lead time', p.lead_time_days !== null && p.lead_time_days !== undefined ? `${p.lead_time_days} days` : null],
            ['Warranty', p.warranty_months ? `${p.warranty_months} months` : null],
          ]} />
          {p.description && <p className="small secondary mt-12" style={{ whiteSpace: 'pre-wrap' }}>{p.description}</p>}
        </Card>
        {specs.length > 0 && <Card title="Specification"><Facts items={specs} /></Card>}
        <Card title="Documents" flush actions={canEdit && <Button size="sm" icon="plus" onClick={() => setDoc(true)}>Add</Button>}>
          {!documents.length && <div className="muted small" style={{ padding: 16 }}>No documents yet.</div>}
          {documents.map((d) => (
            <div key={d.id} className="alert-row">
              <Icon name={d.attachment_id ? 'paperclip' : 'link'} size={15} />
              <span className="grow">
                {d.attachment_id
                  ? <button type="button" className="btn link" onClick={() => openFile(d.attachment_id).catch((e) => toast.error(e.message))}>{d.title}</button>
                  : <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a>}
                <div className="tiny muted">{labelOf(PRODUCT_DOC_TYPES, d.doc_type)} · {date(d.created_at)}</div>
              </span>
              {canEdit && <Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${d.title}`} onClick={async () => {
                if (!(await confirm({ title: 'Remove document?', message: d.title, danger: true, confirmLabel: 'Remove' }))) return;
                await api.del(`/products/${p.id}/documents/${d.id}`).then(reload, (e) => toast.error(e.message));
              }} />}
            </div>
          ))}
        </Card>
      </div>
      {editing && <ProductForm product={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); meta.reload(); }} />}
      {doc && <DocumentForm productId={p.id} onClose={() => setDoc(false)} onSaved={() => { setDoc(false); reload(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------ forms
/** Fields not shown here, such as dealer prices and specifications, are left as they are. */
export function ProductForm({ product, onClose, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const showPrice = !product || product.standard_price_minor !== undefined;
  const [f, setF] = useState(() => ({
    code: product?.code || '', name: product?.name || '', category_id: product?.category_id ? String(product.category_id) : '', default_unit: product?.default_unit || 'pcs',
    standard_price: toMajor(product?.standard_price_minor), gst_rate: product?.gst_rate ?? 18, hsn: product?.hsn || '',
    lead_time_days: product ? product.lead_time_days ?? '' : 14, warranty_months: product ? product.warranty_months ?? '' : 18, description: product?.description || '',
  }));
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const body = { ...f, category_id: f.category_id || null, lead_time_days: f.lead_time_days === '' ? null : f.lead_time_days, warranty_months: f.warranty_months === '' ? null : f.warranty_months, version: product?.version };
    if (!showPrice) delete body.standard_price;
    const r = product ? await api.put(`/products/${product.id}`, body) : await api.post('/products', body);
    onSaved(r);
    return r;
  });
  return (
    <Modal open onClose={onClose} title={product ? `Edit ${product.code}` : 'New product'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {save.conflict && <div className="full"><Notice tone="warn">Someone else changed this product. Close this and open it again.</Notice></div>}
        <Field label="Code" required error={err(save, 'code')}><Input value={f.code} onChange={(e) => set({ code: e.target.value })} /></Field>
        <Field label="Category" error={err(save, 'category_id')}><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })} placeholder="None" options={meta.categories.filter((c) => c.active || String(c.id) === f.category_id).map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
        <Field label="Name" required className="full" error={err(save, 'name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        {showPrice && <Field label="Price (before GST)" error={err(save, 'standard_price')}><Input inputMode="decimal" value={f.standard_price} onChange={(e) => set({ standard_price: e.target.value })} /></Field>}
        <Field label="GST %" error={err(save, 'gst_rate')}><Input type="number" min={0} max={40} step="0.01" value={f.gst_rate} onChange={(e) => set({ gst_rate: e.target.value })} /></Field>
        <Field label="HSN" optional error={err(save, 'hsn')}><Input value={f.hsn} onChange={(e) => set({ hsn: e.target.value })} /></Field>
        <Field label="Unit" error={err(save, 'default_unit')}><OptionSelect category="unit" value={f.default_unit} onChange={(v) => set({ default_unit: v })} /></Field>
        <Field label="Lead time (days)" optional error={err(save, 'lead_time_days')}><Input type="number" min={0} value={f.lead_time_days} onChange={(e) => set({ lead_time_days: e.target.value })} /></Field>
        <Field label="Warranty (months)" optional error={err(save, 'warranty_months')}><Input type="number" min={0} value={f.warranty_months} onChange={(e) => set({ warranty_months: e.target.value })} /></Field>
        <Field label="Description" optional className="full" error={err(save, 'description')}><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} /></Field>
        <button type="submit" hidden />
      </form>
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
