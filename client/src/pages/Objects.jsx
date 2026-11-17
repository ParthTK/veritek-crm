import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { OBJECT_VISIBILITY, FIELD_TYPES, labelOf, toneOf } from '@shared/constants.js';
import { api, uploadFile, downloadAuthed, openFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, timeAgo, number, fileSize, downloadCsv } from '../lib/format.js';
import {
  Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Modal, Notice, PageHeader, Pagination,
  SearchBox, Select, Spinner, Tabs, Textarea, Tile, useConfirm, useToast,
} from '../components/ui.jsx';

export const VisibilityBadge = ({ value, size }) => <Badge tone={toneOf(OBJECT_VISIBILITY, value)} size={size}>{labelOf(OBJECT_VISIBILITY, value)}</Badge>;
export const downloadCodes = (ids, toast) => downloadAuthed('/objects/codes.zip', { ids: ids.join(',') }, 'codes.zip').catch((e) => toast.error(e.message));
import { ColumnChart } from '../components/charts.jsx';
import Icon from '../components/Icon.jsx';

export default function Objects() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setFilter] = useUrlFilters({ tab: 'objects', status: 'active' });
  const { data, loading, reload } = useApi(f.tab === 'objects' ? '/objects' : null, { ...f, tab: undefined, pageSize: 50 });
  const stats = useApi('/objects/stats');
  const categories = useApi('/object-categories');
  const [selected, setSelected] = useState([]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const editable = can('objects.edit');

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allOnPage = (data?.rows || []).map((o) => o.id);
  const s = stats.data;

  const columns = [
    editable && {
      key: 'select',
      label: <Checkbox checked={allOnPage.length > 0 && allOnPage.every((id) => selected.includes(id))}
        onChange={(v) => setSelected(v ? [...new Set([...selected, ...allOnPage])] : selected.filter((id) => !allOnPage.includes(id)))} />,
      width: 36,
      render: (o) => <Checkbox checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />,
    },
    { key: 'name', label: 'Object', sort: 'name', render: (o) => (
      <div className="row" style={{ gap: 10 }}>
        {o.image_url
          ? <img src={o.image_url} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flex: 'none', border: '1px solid var(--border)' }} />
          : <span style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--surface-3)', display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--text-3)' }}><Icon name="box" size={16} /></span>}
        <div className="col" style={{ gap: 0, maxWidth: 280 }}>
          <Link to={`/objects/${o.id}`} className="strong truncate">{o.name}</Link>
          <span className="tiny muted truncate">{[o.location, o.serial_number && `SN ${o.serial_number}`].filter(Boolean).join(' · ') || o.description?.slice(0, 48)}</span>
        </div>
      </div>
    ) },
    { key: 'public_id', label: 'Object ID', sort: 'id', render: (o) => <span className="mono">{o.public_id}</span> },
    { key: 'category', label: 'Category', render: (o) => o.category_name || <span className="muted">—</span> },
    { key: 'files', label: 'Files', align: 'num', sort: 'files', render: (o) => (o.file_count ? number(o.file_count) : <span className="muted">0</span>) },
    { key: 'visibility', label: 'Visibility', render: (o) => (
      <span className="row" style={{ gap: 4 }}>
        <VisibilityBadge value={o.visibility} size="sm" />
        {o.status === 'archived' && <Badge size="sm">Archived</Badge>}
      </span>
    ) },
    { key: 'scans', label: 'Scans', align: 'num', sort: 'scans', render: (o) => (o.scan_count ? number(o.scan_count) : <span className="muted">0</span>) },
    { key: 'code', label: 'Code', render: (o) => (o.code_count ? <Badge size="sm" tone="green">Issued</Badge> : <span className="muted small">Not generated</span>) },
    { key: 'updated', label: 'Last updated', sort: 'updated', render: (o) => <span className="small muted">{timeAgo(o.updated_at || o.created_at)}</span> },
    { key: 'actions', label: '', render: (o) => (
      <div className="row" style={{ gap: 2 }}>
        <Button size="xs" variant="ghost" icon="link" title="Copy public link" aria-label="Copy public link" onClick={async () => {
          try {
            const detail = await api.get(`/objects/${o.id}`);
            await navigator.clipboard?.writeText(detail.public_url);
            toast.success('Public link copied');
          } catch (e) {
            toast.error(e.message);
          }
        }} />
        <Button size="xs" variant="ghost" icon="eye" title="Open the scan page" aria-label="Open the scan page" onClick={() => window.open(`/o/${o.public_id}`, '_blank')} />
        {editable && <Button size="xs" variant="ghost" icon="copy" title="Duplicate" aria-label="Duplicate" onClick={async () => {
          const r = await api.post(`/objects/${o.id}/duplicate`, {}).catch((e) => toast.error(e.message));
          if (r) {
            toast.success('Duplicated with a new code');
            navigate(`/objects/${r.id}`);
          }
        }} />}
        {editable && <Button size="xs" variant="ghost" icon={o.status === 'archived' ? 'refresh' : 'archive'} title={o.status === 'archived' ? 'Restore' : 'Archive'} aria-label={o.status === 'archived' ? 'Restore' : 'Archive'} onClick={async () => {
          await api.post(`/objects/${o.id}/archive`, { archived: o.status !== 'archived' }).catch((e) => toast.error(e.message));
          toast.success(o.status === 'archived' ? 'Restored' : 'Archived — the link stays alive and explains it is archived');
          reload();
        }} />}
        {can('objects.manage') && <Button size="xs" variant="ghost" icon="trash" title="Delete" aria-label="Delete" onClick={async () => {
          if (!(await confirm({ title: `Delete ${o.name}?`, message: 'The object stops resolving. Its code is retired permanently and never reused by another object.', danger: true, confirmLabel: 'Delete' }))) return;
          await api.del(`/objects/${o.id}`);
          toast.success('Deleted');
          reload();
        }} />}
      </div>
    ) },
  ].filter(Boolean);

  return (
    <div className="stack">
      <PageHeader
        title="Objects & QR codes"
        subtitle="Create an object, attach anything, print one code — update the information for years without reprinting"
        actions={(
          <>
            {selected.length > 0 && (
              <>
                <Button icon="printer" to={`/objects/labels?ids=${selected.join(',')}`}>Print {selected.length} labels</Button>
                <Button icon="download" onClick={() => downloadCodes(selected, toast)}>Download codes</Button>
              </>
            )}
            {editable && <Button icon="file" onClick={() => setImporting(true)}>Import</Button>}
            {editable && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create object</Button>}
          </>
        )}
      />

      {s && (
        <div className="tiles">
          <Tile icon="box" label="Total objects" value={number(s.objects)} foot={`${number(s.archived || 0)} archived · ${number(s.public_objects || 0)} public`} />
          <Tile icon="qr" label="Codes issued" value={number(s.codes)} foot={s.objects > s.codes ? `${number(s.objects - s.codes)} without a code` : 'Every object has one'} />
          <Tile icon="eye" label="Total scans" value={number(s.scans)} foot={`${number(s.scans_today)} today`} />
          <Tile icon="file" label="Documents" value={number(s.files)} foot={`${fileSize(s.bytes)} stored`} />
        </div>
      )}

      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[
        { key: 'objects', label: 'Objects', count: data?.count },
        { key: 'categories', label: 'Categories & templates', count: categories.data?.length },
        { key: 'activity', label: 'Scan activity' },
      ]} />

      {f.tab === 'objects' && (
        <>
          <div className="filter-bar">
            <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Name, object ID, serial number, location" />
            <Select aria-label="Category" value={f.category_id || ''} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="Any category"
              options={(categories.data || []).map((c) => ({ value: String(c.id), label: c.name }))} />
            <Select aria-label="Visibility" value={f.visibility} onChange={(e) => setFilter({ visibility: e.target.value })} placeholder="Any visibility" options={OBJECT_VISIBILITY} />
            <Select aria-label="Status" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} options={[
              { value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' },
            ]} />
            <Checkbox label="Without files" checked={f.no_files === '1'} onChange={(v) => setFilter({ no_files: v ? '1' : '' })} />
            {selected.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear {selected.length} selected</Button>}
          </div>
          <Card flush>
            <DataTable columns={columns} rows={data?.rows} loading={loading} sort={f.sort ? { key: f.sort, dir: f.dir || 'desc' } : null}
              onSort={(x) => setFilter({ sort: x.key, dir: x.dir })} onRowClick={(o) => navigate(`/objects/${o.id}`)}
              empty={<EmptyState icon="box" title="No objects yet" message="Create your first object, attach its documents and print one permanent code."
                action={editable ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create object</Button> : null} />} />
            <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
          </Card>
        </>
      )}

      {f.tab === 'categories' && <Categories data={categories} editable={editable} canManage={can('objects.manage')} />}
      {f.tab === 'activity' && <ScanActivity stats={s} />}

      <ObjectFormModal open={creating} onClose={() => setCreating(false)} categories={categories.data || []} onSaved={(id) => navigate(`/objects/${id}`)} />
      <ImportModal open={importing} onClose={() => setImporting(false)} categories={categories.data || []} onDone={() => { reload(); stats.reload(); }} />
    </div>
  );
}

function ScanActivity({ stats }) {
  if (!stats) return <Spinner />;
  return (
    <div className="stack">
      <Card title="Scans across all objects" sub="Last 30 days">
        <ColumnChart data={stats.series} x="day" series={[{ key: 'scans', label: 'Scans' }]} height={220}
          xFormat={(d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} />
      </Card>
      <div className="grid grid-2">
        <Card title="Recently created" flush>
          {stats.recent.map((o) => (
            <Link key={o.id} to={`/objects/${o.id}`} className="alert-row">
              <span className="grow"><span className="strong">{o.name}</span><div className="tiny muted mono">{o.public_id}</div></span>
              <span className="small muted">{date(o.created_at)}</span>
            </Link>
          ))}
        </Card>
        <Card title="Recently updated" flush>
          {stats.updated.map((o) => (
            <Link key={o.id} to={`/objects/${o.id}`} className="alert-row">
              <span className="grow"><span className="strong">{o.name}</span><div className="tiny muted">{o.file_count} file{o.file_count === 1 ? '' : 's'} · {o.scan_count} scans</div></span>
              <span className="small muted">{timeAgo(o.updated_at)}</span>
            </Link>
          ))}
        </Card>
      </div>
      <HealthCard />
    </div>
  );
}

function HealthCard() {
  const { data } = useApi('/objects/health');
  if (!data) return null;
  const clean = !data.missing_files.length && !data.without_codes.length;
  return (
    <Card title="Link health" sub={`${data.checked} documents checked`}>
      {clean ? <Notice tone="success">Every document resolves and every active object has a code.</Notice> : (
        <div className="stack-sm">
          {data.missing_files.length > 0 && (
            <Notice tone="danger">
              <strong>{data.missing_files.length} document{data.missing_files.length === 1 ? '' : 's'} missing from storage.</strong>
              <div className="small">{data.missing_files.slice(0, 5).map((m) => `${m.object_name} → ${m.title}`).join('; ')}</div>
            </Notice>
          )}
          {data.without_codes.length > 0 && (
            <Notice tone="warn">
              {data.without_codes.length} active object{data.without_codes.length === 1 ? '' : 's'} without a generated code:{' '}
              {data.without_codes.slice(0, 6).map((o) => <Link key={o.id} to={`/objects/${o.id}`} style={{ marginRight: 8 }}>{o.name}</Link>)}
            </Notice>
          )}
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ categories & templates
function Categories({ data, editable, canManage }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  return (
    <div className="stack">
      <Card title="Categories & field templates" sub="A template pre-fills an object's custom fields when that category is chosen"
        actions={editable && <Button size="sm" icon="plus" onClick={() => setEditing({ field_template: [] })}>New category</Button>} flush>
        {!data.data ? <Spinner /> : data.data.length === 0 ? <EmptyState icon="tag" title="No categories yet" message="Categories are optional, but templates save typing when you create similar objects." /> : (
          <DataTable rows={data.data} columns={[
            { key: 'name', label: 'Category', render: (c) => <div className="col" style={{ gap: 0 }}><span className="strong">{c.name}</span><span className="tiny muted">{c.description}</span></div> },
            { key: 'fields', label: 'Template fields', render: (c) => (c.field_template.length
              ? <span className="row wrap" style={{ gap: 4 }}>{c.field_template.map((x) => <span key={x.key} className="tag">{x.label} <span className="muted">· {labelOf(FIELD_TYPES, x.type)}</span></span>)}</span>
              : <span className="muted small">No template</span>) },
            { key: 'count', label: 'Objects', align: 'num', render: (c) => c.object_count },
            editable && { key: 'act', label: '', render: (c) => (
              <div className="row">
                <Button size="xs" variant="ghost" icon="edit" aria-label="Edit" onClick={() => setEditing(c)} />
                {canManage && <Button size="xs" variant="ghost" icon="trash" aria-label="Delete" onClick={async () => {
                  if (!(await confirm({ title: `Delete ${c.name}?`, danger: true, confirmLabel: 'Delete' }))) return;
                  await api.del(`/object-categories/${c.id}`).then(() => { toast.success('Deleted'); data.reload(); }, (e) => toast.error(e.message));
                }} />}
              </div>
            ) },
          ].filter(Boolean)} />
        )}
      </Card>
      {editing && <CategoryModal category={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); data.reload(); }} />}
    </div>
  );
}

function CategoryModal({ category, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(category || { name: '', description: '', field_template: [] });
  const save = async () => {
    try {
      if (category?.id) await api.put(`/object-categories/${category.id}`, form);
      else await api.post('/object-categories', form);
      toast.success('Category saved');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open size="lg" onClose={onClose} title={category?.id ? `Edit ${category.name}` : 'New category'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name" required><Input value={form.name} onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} autoFocus /></Field>
          <Field label="Description"><Input value={form.description} onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))} /></Field>
        </div>
        <FieldDesigner fields={form.field_template} onChange={(field_template) => setForm((s) => ({ ...s, field_template }))} valuesEditable={false}
          hint="Objects in this category start with these fields. Each object can still add its own." />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ dynamic field designer
export function FieldDesigner({ fields, onChange, valuesEditable = true, hint, fileUrls }) {
  const set = (i, patch) => onChange(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const move = (i, delta) => {
    const next = [...fields];
    const [item] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + delta)), 0, item);
    onChange(next);
  };
  return (
    <div className="stack-sm">
      <div className="row between">
        <span className="small strong">Custom fields</span>
        <Button size="sm" icon="plus" onClick={() => onChange([...fields, { label: '', type: 'text', value: '', public: true }])}>Add field</Button>
      </div>
      {hint && <div className="tiny muted">{hint}</div>}
      {fields.length === 0 && <div className="muted small">No custom fields yet — add anything this object needs: model number, warranty expiry, dimensions, price…</div>}
      {fields.map((f, i) => (
        <div key={i} className="row wrap" style={{ gap: 6, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
          <Input style={{ flex: '1 1 150px' }} placeholder="Field name" aria-label="Field name" value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
          <Select style={{ width: 140 }} aria-label="Field type" value={f.type} onChange={(e) => set(i, { type: e.target.value, value: '' })} options={FIELD_TYPES} />
          {f.type === 'dropdown' && <Input style={{ flex: '1 1 160px' }} placeholder="Options, comma separated" value={Array.isArray(f.options) ? f.options.join(', ') : f.options || ''} onChange={(e) => set(i, { options: e.target.value.split(',') })} />}
          {valuesEditable && <div style={{ flex: '1 1 180px' }}><FieldValueInput field={f} fileUrls={fileUrls} onChange={(value) => set(i, { value })} /></div>}
          <Checkbox label="Public" checked={f.public !== false} onChange={(v) => set(i, { public: v })} />
          <div className="row" style={{ gap: 0 }}>
            <Button size="xs" variant="ghost" icon="chevronDown" aria-label="Move down" onClick={() => move(i, 1)} />
            <Button size="xs" variant="ghost" icon="trash" aria-label="Remove field" onClick={() => onChange(fields.filter((_, idx) => idx !== i))} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FieldValueInput({ field, onChange, fileUrls = {} }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (field.type === 'checkbox') return <Checkbox label={field.value ? 'Yes' : 'No'} checked={Boolean(field.value)} onChange={onChange} />;
  if (field.type === 'dropdown') {
    return <Select value={field.value || ''} onChange={(e) => onChange(e.target.value)} placeholder="—"
      options={(Array.isArray(field.options) ? field.options : String(field.options || '').split(',')).map((o) => String(o).trim()).filter(Boolean)} />;
  }
  if (field.type === 'notes') return <Textarea rows={2} value={field.value || ''} onChange={(e) => onChange(e.target.value)} />;
  if (field.type === 'file') {
    return (
      <div className="row">
        {field.value ? (fileUrls[field.value] ? <a href={fileUrls[field.value]} target="_blank" rel="noreferrer" className="small">Attached file</a> : <button type="button" className="btn link small" onClick={() => openFile(field.value).catch((e) => toast.error(e.message))}>Attached file</button>) : <span className="muted small">No file</span>}
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          {busy ? 'Uploading…' : 'Upload'}
          <input type="file" hidden onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              const a = await uploadFile(file, {});
              onChange(a.id);
            } catch (err) {
              toast.error(err.message);
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }} />
        </label>
      </div>
    );
  }
  const type = { number: 'number', date: 'date', url: 'url', email: 'email', phone: 'tel' }[field.type] || 'text';
  return <Input type={type} value={field.value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="Value" />;
}

// ------------------------------------------------------------------ create / edit
export function ObjectFormModal({ open, onClose, onSaved, object, categories }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [image, setImage] = useState(null);
  const [busy, setBusy] = useState(false);
  const cats = categories || [];

  useEffect(() => {
    if (!open) return;
    setForm(object
      ? { ...object, custom_fields: object.custom_fields || [], password: undefined }
      : { name: '', visibility: 'public', custom_fields: [], single_file_direct: false, show_updated: true });
    setImage(null);
  }, [open, object]);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const applyTemplate = (categoryId) => {
    const cat = cats.find((c) => String(c.id) === String(categoryId));
    setForm((s) => {
      const existing = s.custom_fields || [];
      const template = (cat?.field_template || []).filter((t) => !existing.some((f) => f.label === t.label));
      return { ...s, category_id: categoryId, custom_fields: [...existing, ...template.map((t) => ({ ...t, value: '' }))] };
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, image_attachment_id: image?.id ?? form.image_attachment_id };
      const res = object?.id ? await api.put(`/objects/${object.id}`, body) : await api.post('/objects', body);
      toast.success(object?.id ? 'Object updated — its code and link are unchanged' : 'Object created');
      onSaved?.(object?.id || res.id);
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title={object?.id ? `Edit ${object.name}` : 'Create object'}
      subtitle={object?.id ? `Object ID ${object.public_id} — editing never changes the code` : 'Anything physical or digital: a machine, a product, a document, a room'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{object?.id ? 'Save changes' : 'Create object'}</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Object name" required className="full"><Input value={form.name || ''} onChange={set('name')} autoFocus placeholder="e.g. APFC Panel — Press shop" /></Field>
          <Field label="Category" hint="Applies the category's field template">
            <Select value={form.category_id ? String(form.category_id) : ''} onChange={(e) => applyTemplate(e.target.value)} placeholder="None" options={cats.map((c) => ({ value: String(c.id), label: c.name }))} />
          </Field>
          <Field label="Visibility" hint={form.visibility === 'password' ? 'Scanners must enter a password' : form.visibility === 'private' ? 'Only signed-in staff can open it' : 'Anyone with the code can view it'}>
            <Select value={form.visibility || 'public'} onChange={set('visibility')} options={OBJECT_VISIBILITY} />
          </Field>
          {form.visibility === 'password' && (
            <Field label={object?.has_password ? 'Change password' : 'Password'} className="full" hint={object?.has_password ? 'Leave blank to keep the current password' : undefined}>
              <Input type="text" value={form.password || ''} onChange={set('password')} placeholder="Shared with the people who may view it" />
            </Field>
          )}
          <Field label="Description" className="full"><Textarea rows={2} value={form.description || ''} onChange={set('description')} /></Field>
          <Field label="Location"><Input value={form.location || ''} onChange={set('location')} placeholder="e.g. Unit 1 · Press shop" /></Field>
          <Field label="Owner / department"><Input value={form.owner_name || ''} onChange={set('owner_name')} /></Field>
          <Field label="Serial / reference number"><Input value={form.serial_number || ''} onChange={set('serial_number')} /></Field>
          <Field label="Object image" hint="Shown at the top of the scan page">
            <div className="row">
              {(image?.preview || object?.image_url) && <img src={image?.preview || object.image_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} />}
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                Choose image
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const a = await uploadFile(file, {});
                    setImage({ id: a.id, preview: URL.createObjectURL(file) });
                  } catch (err) {
                    toast.error(err.message);
                  }
                }} />
              </label>
            </div>
          </Field>
        </div>

        <FieldDesigner fields={form.custom_fields || []} fileUrls={object?.field_file_urls} onChange={(custom_fields) => setForm((s) => ({ ...s, custom_fields }))}
          hint="Add whatever this object needs. Fields marked public appear on the scan page." />

        <div className="form-grid">
          <div className="form-section">Scan behaviour</div>
          <Checkbox label="If only one document is attached, open it immediately when scanned" checked={Boolean(form.single_file_direct)} onChange={(v) => setForm((s) => ({ ...s, single_file_direct: v }))} />
          <Checkbox label="Show the last-updated date on the public page" checked={form.show_updated !== false} onChange={(v) => setForm((s) => ({ ...s, show_updated: v }))} />
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ bulk import
function ImportModal({ open, onClose, onDone, categories }) {
  const toast = useToast();
  const [step, setStep] = useState('upload');
  const [attachment, setAttachment] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [options, setOptions] = useState({ category_id: '', visibility: 'public', generate_codes: true });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStep('upload');
      setAttachment(null);
      setPreview(null);
      setMapping({});
      setResult(null);
    }
  }, [open]);

  const upload = async (file) => {
    setBusy(true);
    try {
      const a = await uploadFile(file, {});
      setAttachment(a);
      const p = await api.post('/objects/import/preview', { attachment_id: a.id });
      setPreview(p);
      const guess = (re) => p.header.findIndex((h) => re.test(h));
      setMapping({
        name: String(Math.max(0, guess(/name|title|item|asset|machine|product/i))),
        location: guess(/location|site|place|area/i) >= 0 ? String(guess(/location|site|place|area/i)) : '',
        serial_number: guess(/serial|sn\b|code/i) >= 0 ? String(guess(/serial|sn\b|code/i)) : '',
        owner_name: guess(/owner|department|dept|custodian/i) >= 0 ? String(guess(/owner|department|dept|custodian/i)) : '',
        description: guess(/description|details|notes/i) >= 0 ? String(guess(/description|details|notes/i)) : '',
      });
      setStep('map');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.post('/objects/import', {
        attachment_id: attachment.id,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
        ...options,
      });
      setResult(res);
      setStep('done');
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const columnOptions = (preview?.header || []).map((h, i) => ({ value: String(i), label: `${String.fromCharCode(65 + i)} · ${h || '(no header)'}` }));

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Import objects from a spreadsheet"
      subtitle="Excel (.xlsx) or CSV — one row per object, with a header row"
      footer={step === 'map'
        ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={run}>Create {preview?.total} objects</Button></>
        : <Button onClick={onClose}>{step === 'done' ? 'Done' : 'Cancel'}</Button>}>
      {step === 'upload' && (
        <label className="dropzone">
          <Icon name="file" size={26} />
          <strong>Choose a spreadsheet</strong>
          <span className="muted small">Columns you do not map become custom fields automatically.</span>
          <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {busy && <Spinner label="Reading…" />}
        </label>
      )}

      {step === 'map' && preview && (
        <div className="stack">
          <Notice tone="info">{preview.total} rows found. Map the columns you want as built-in fields — everything else is kept as a custom field.</Notice>
          <div className="form-grid">
            <Field label="Object name" required><Select value={mapping.name} onChange={(e) => setMapping((m) => ({ ...m, name: e.target.value }))} options={columnOptions} /></Field>
            <Field label="Description"><Select value={mapping.description} onChange={(e) => setMapping((m) => ({ ...m, description: e.target.value }))} placeholder="Not mapped" options={columnOptions} /></Field>
            <Field label="Location"><Select value={mapping.location} onChange={(e) => setMapping((m) => ({ ...m, location: e.target.value }))} placeholder="Not mapped" options={columnOptions} /></Field>
            <Field label="Owner / department"><Select value={mapping.owner_name} onChange={(e) => setMapping((m) => ({ ...m, owner_name: e.target.value }))} placeholder="Not mapped" options={columnOptions} /></Field>
            <Field label="Serial number"><Select value={mapping.serial_number} onChange={(e) => setMapping((m) => ({ ...m, serial_number: e.target.value }))} placeholder="Not mapped" options={columnOptions} /></Field>
            <Field label="Category for all rows"><Select value={options.category_id} onChange={(e) => setOptions((o) => ({ ...o, category_id: e.target.value }))} placeholder="None" options={categories.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
            <Field label="Visibility"><Select value={options.visibility} onChange={(e) => setOptions((o) => ({ ...o, visibility: e.target.value }))} options={OBJECT_VISIBILITY} /></Field>
            <Checkbox label="Generate a QR code for every row" checked={options.generate_codes} onChange={(v) => setOptions((o) => ({ ...o, generate_codes: v }))} />
          </div>
          <div className="table-wrap" style={{ maxHeight: 220 }}>
            <table className="table compact">
              <thead><tr>{preview.header.map((h, i) => <th key={i}>{String.fromCharCode(65 + i)} · {h}</th>)}</tr></thead>
              <tbody>{preview.sample.map((row, i) => <tr key={i}>{preview.header.map((_, j) => <td key={j}>{row[j]}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <div className="stack">
          <Notice tone="success"><strong>{result.created.length} objects created</strong>{result.errors.length ? `, ${result.errors.length} rows skipped` : ', each with its own permanent code'}.</Notice>
          {result.errors.length > 0 && <Notice tone="warn">{result.errors.slice(0, 6).map((e) => `Row ${e.row}: ${e.error}`).join(' · ')}</Notice>}
          <div className="row">
            <Button icon="printer" to={`/objects/labels?ids=${result.created.map((o) => o.id).join(',')}`}>Print all labels</Button>
            <Button icon="download" onClick={() => downloadCodes(result.created.map((o) => o.id), toast)}>Download codes</Button>
            <Button icon="file" onClick={() => downloadCsv('imported-objects.csv', [{ key: 'public_id', label: 'Object ID' }, { key: 'name', label: 'Name' }], result.created)}>Export list</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
