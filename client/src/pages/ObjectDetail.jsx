import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, uploadFile, downloadAuthed } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useBlobUrl } from '../lib/hooks.js';
import { date, dateTime, timeAgo, number, fileSize } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, Facts, Field, Input, Modal, Notice, PageHeader, Segmented, Select,
  Spinner, Tabs, Textarea, Tile, useConfirm, useToast,
} from '../components/ui.jsx';
import { CustomerPicker, ProductSelect } from '../components/domain.jsx';
import { ColumnChart } from '../components/charts.jsx';
import Icon from '../components/Icon.jsx';
import { ObjectFormModal, VisibilityBadge } from './Objects.jsx';

export default function ObjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { can } = useAuth();
  const { data: o, error, reload } = useApi(`/objects/${id}`);
  const categories = useApi('/object-categories');
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null);
  const editable = can('objects.edit');

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!o) return <Spinner />;

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Objects & QR codes', to: '/objects' }, { label: o.public_id }]}
        title={<span className="row wrap" style={{ gap: 10 }}>{o.name}<VisibilityBadge value={o.visibility} />{o.status === 'archived' && <Badge>Archived</Badge>}</span>}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <span className="mono">{o.public_id}</span>
          {o.category_name && <span className="muted">· {o.category_name}</span>}
          {o.location && <span className="muted">· {o.location}</span>}
          <a href={`/o/${o.public_id}`} target="_blank" rel="noreferrer" className="small">Open the scan page ↗</a>
        </span>}
        actions={(
          <>
            <Button icon="link" onClick={() => { navigator.clipboard?.writeText(o.public_url); toast.success('Public link copied'); }}>Copy link</Button>
            {editable && <Button icon="paperclip" onClick={() => setTab('documents')}>Documents</Button>}
            {editable && <Button icon="edit" onClick={() => setModal('edit')}>Edit</Button>}
            {editable && <Button variant="primary" icon="qr" onClick={() => setTab('code')}>QR &amp; barcode</Button>}
          </>
        )}
      />

      {o.status === 'archived' && <Notice tone="warn">Archived{o.archived_at ? ` on ${date(o.archived_at)}` : ''}. The link still resolves and shows: “{o.archive_note || 'This item has been archived.'}”</Notice>}

      <div className="tiles">
        <Tile icon="eye" label="Total scans" value={number(o.scans.total)} foot={`${number(o.scans.today)} today · ${number(o.scans.last_7)} this week`} />
        <Tile icon="file" label="Documents" value={number(o.files.length)} foot={o.versions.length ? `${o.versions.length} earlier version${o.versions.length === 1 ? '' : 's'} kept` : 'No replaced versions'} />
        <Tile icon="clock" label="Last scanned" value={o.scans.last_scanned_at ? timeAgo(o.scans.last_scanned_at) : 'Never'} foot={o.scans.last_scanned_at ? dateTime(o.scans.last_scanned_at) : 'No scans yet'} />
        <Tile icon="qr" label="Codes" value={o.codes.length ? o.codes.map((c) => (c.code_type === 'qr' ? 'QR' : 'Barcode')).join(' + ') : 'None yet'} foot={o.codes.length ? 'Permanent — never regenerated' : 'Generate one in the QR tab'} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' },
        { key: 'documents', label: 'Documents', count: o.files.length },
        { key: 'code', label: 'QR / barcode' },
        { key: 'activity', label: 'Activity' },
      ]} />

      {tab === 'overview' && (
        <div className="split side-340">
          <Card title="Information">
            <Facts items={[
              ['Object ID', <span className="mono">{o.public_id}</span>],
              ['Name', o.name],
              ['Category', o.category_name],
              ['Description', o.description],
              ['Location', o.location],
              ['Owner / department', o.owner_name],
              ['Serial number', o.serial_number],
              ['Created', `${date(o.created_at)}${o.created_by_name ? ` by ${o.created_by_name}` : ''}`],
              ['Last updated', o.updated_at ? dateTime(o.updated_at) : null],
            ]} />
            {o.custom_fields.length > 0 && (
              <>
                <div className="divider" />
                <div className="small strong" style={{ marginBottom: 8 }}>Custom fields</div>
                <Facts items={o.custom_fields.map((f) => [
                  <span key={f.key}>{f.label} {f.public === false && <Badge size="sm">Internal</Badge>}</span>,
                  f.type === 'checkbox' ? (f.value ? 'Yes' : 'No')
                    : f.type === 'file' ? (f.value && o.field_file_urls?.[f.value] ? <a href={o.field_file_urls[f.value]} target="_blank" rel="noreferrer">Open file</a> : null)
                      : f.type === 'date' ? date(f.value) : f.value,
                ])} />
              </>
            )}
          </Card>
          <div className="stack">
            {o.image_url && <Card title="Image"><img src={o.image_url} alt="" style={{ width: '100%', borderRadius: 10 }} /></Card>}
            <Card title="Linked records" sub="Optional connections to the rest of the CRM">
              <Facts items={[
                ['Customer', o.customer_id ? <Link to={`/customers/${o.customer_id}`}>{o.customer_name}</Link> : null],
                ['Product', o.product_id ? <Link to={`/products/${o.product_id}`}>{o.product_code} — {o.product_name}</Link> : null],
                ['Sales order', o.order_id ? <Link to={`/orders/${o.order_id}`}>{o.order_code}</Link> : null],
              ]} />
              {editable && <Button size="sm" style={{ marginTop: 10 }} onClick={() => setModal('link')}>Link records</Button>}
            </Card>
            {editable && (
              <Card title="Manage">
                <div className="stack-sm">
                  <Button icon="copy" onClick={async () => {
                    const r = await api.post(`/objects/${o.id}/duplicate`, {}).catch((e) => toast.error(e.message));
                    if (r) navigate(`/objects/${r.id}`);
                  }}>Duplicate object</Button>
                  <Button icon={o.status === 'archived' ? 'refresh' : 'archive'} onClick={() => setModal(o.status === 'archived' ? 'restore' : 'archive')}>
                    {o.status === 'archived' ? 'Restore object' : 'Archive object'}
                  </Button>
                  {can('objects.manage') && (
                    <Button variant="danger-ghost" icon="trash" onClick={async () => {
                      if (!(await confirm({ title: `Delete ${o.name}?`, message: 'The code stops resolving and its id is retired forever — it is never given to another object.', danger: true, confirmLabel: 'Delete' }))) return;
                      await api.del(`/objects/${o.id}`);
                      toast.success('Object deleted');
                      navigate('/objects');
                    }}>Delete object</Button>
                  )}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'documents' && <Documents object={o} reload={reload} editable={editable} />}
      {tab === 'code' && <Codes object={o} reload={reload} editable={editable} />}
      {tab === 'activity' && <Activity object={o} />}

      <ObjectFormModal open={modal === 'edit'} onClose={() => setModal(null)} object={o} categories={categories.data || []} onSaved={reload} />
      <ArchiveModal open={modal === 'archive' || modal === 'restore'} restore={modal === 'restore'} object={o} onClose={() => setModal(null)} onSaved={reload} />
      <LinkModal open={modal === 'link'} object={o} onClose={() => setModal(null)} onSaved={reload} />
    </div>
  );
}

// ------------------------------------------------------------------ documents
function Documents({ object, reload, editable }) {
  const toast = useToast();
  const confirm = useConfirm();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const [replacing, setReplacing] = useState(null);
  const [editingFile, setEditingFile] = useState(null);
  const [dragId, setDragId] = useState(null);

  const addFiles = async (files, replacesId) => {
    for (const file of files) {
      setBusy((n) => n + 1);
      try {
        const attachment = await uploadFile(file, {});
        await api.post(`/objects/${object.id}/files`, { attachment_id: attachment.id, title: file.name, replaces_id: replacesId });
      } catch (err) {
        toast.error(`${file.name}: ${err.message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    toast.success(replacesId ? 'Document replaced — the printed code is unchanged' : 'Uploaded');
    reload();
  };

  const drop = async (e) => {
    e.preventDefault();
    setOver(false);
    if (editable && e.dataTransfer.files?.length) await addFiles([...e.dataTransfer.files]);
  };

  const reorder = async (targetId) => {
    if (!dragId || dragId === targetId) return;
    const ids = object.files.map((f) => f.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    setDragId(null);
    await api.post(`/objects/${object.id}/files/reorder`, { order: ids });
    reload();
  };

  return (
    <div className="stack">
      {editable && (
        <label className={`dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <Icon name="paperclip" size={24} />
          <strong>Drop files here, or choose them</strong>
          <span className="muted small">PDF, Excel, Word, images, video, CSV, text — up to 20 MB each</span>
          {busy > 0 && <span className="small">Uploading {busy} file{busy === 1 ? '' : 's'}…</span>}
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        </label>
      )}

      {object.files.length === 0 ? <EmptyState icon="file" title="No documents yet" message="Attach the manual, drawings, test certificates or maintenance sheets." /> : (
        <div className="stack-sm">
          {object.files.map((f) => (
            <div key={f.id} className={`file-row ${dragId === f.id ? 'dragging' : ''}`}
              draggable={editable} onDragStart={() => setDragId(f.id)} onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()} onDrop={() => reorder(f.id)}>
              {editable && <span className="grip" title="Drag to reorder"><Icon name="menu" size={14} /></span>}
              <span style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', flex: 'none' }}>
                <Icon name={f.mime?.startsWith('image/') ? 'eye' : f.mime?.startsWith('video/') ? 'video' : 'file'} size={16} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <strong className="truncate">{f.title}</strong>
                  {f.visibility === 'private' && <Badge size="sm" tone="amber">Internal only</Badge>}
                  {f.version_count > 1 && <Badge size="sm">v{f.version_no}</Badge>}
                </div>
                <div className="tiny muted truncate">{f.original_name} · {fileSize(f.size)} · uploaded {date(f.uploaded_at)}{f.uploaded_by_name ? ` by ${f.uploaded_by_name}` : ''}{f.description ? ` · ${f.description}` : ''}</div>
              </div>
              <a className="btn sm" href={f.url} target="_blank" rel="noreferrer">Preview</a>
              {editable && (
                <>
                  <Button size="sm" variant="ghost" icon="edit" aria-label="Rename" onClick={() => setEditingFile(f)} />
                  <Button size="sm" variant="ghost" icon="refresh" title="Replace with a new version" onClick={() => setReplacing(f)} />
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Delete" onClick={async () => {
                    if (!(await confirm({ title: `Delete ${f.title}?`, message: 'All versions of this document are removed.', danger: true, confirmLabel: 'Delete' }))) return;
                    await api.del(`/objects/${object.id}/files/${f.id}`);
                    toast.success('Deleted');
                    reload();
                  }} />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {object.versions.length > 0 && (
        <Card title="Version history" sub="Replaced documents are kept and can be restored without changing the code" flush>
          <DataTable rows={object.versions} compact columns={[
            { key: 'title', label: 'Document', render: (v) => <span className="strong">{v.title}</span> },
            { key: 'version', label: 'Version', render: (v) => `v${v.version_no}` },
            { key: 'file', label: 'File', render: (v) => <span className="small">{v.original_name} · {fileSize(v.size)}</span> },
            { key: 'when', label: 'Replaced', render: (v) => <span className="small muted">{date(v.uploaded_at)}{v.uploaded_by_name ? ` · ${v.uploaded_by_name}` : ''}</span> },
            { key: 'act', label: '', render: (v) => (
              <div className="row">
                <a className="btn xs" href={v.url} target="_blank" rel="noreferrer">View</a>
                {editable && <Button size="xs" onClick={async () => {
                  await api.post(`/objects/${object.id}/files/${v.id}/restore`);
                  toast.success('Restored as the current version');
                  reload();
                }}>Restore</Button>}
              </div>
            ) },
          ]} />
        </Card>
      )}

      {replacing && (
        <Modal open size="sm" onClose={() => setReplacing(null)} title={`Replace “${replacing.title}”`}
          subtitle="The current file becomes version history. The object's code and link do not change.">
          <label className="dropzone">
            <Icon name="refresh" size={22} />
            <strong>Choose the new file</strong>
            <input type="file" hidden onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const id = replacing.id;
              setReplacing(null);
              await addFiles([file], id);
            }} />
          </label>
        </Modal>
      )}

      {editingFile && (
        <Modal open size="sm" onClose={() => setEditingFile(null)} title="Document details"
          footer={<><Button onClick={() => setEditingFile(null)}>Cancel</Button><Button variant="primary" onClick={async () => {
            await api.put(`/objects/${object.id}/files/${editingFile.id}`, editingFile);
            toast.success('Saved');
            setEditingFile(null);
            reload();
          }}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Title" className="full"><Input value={editingFile.title} onChange={(e) => setEditingFile((s) => ({ ...s, title: e.target.value }))} /></Field>
            <Field label="Description" className="full"><Textarea rows={2} value={editingFile.description || ''} onChange={(e) => setEditingFile((s) => ({ ...s, description: e.target.value }))} /></Field>
            <Field label="Visibility" className="full" hint="Internal documents never appear on the public scan page">
              <Select value={editingFile.visibility} onChange={(e) => setEditingFile((s) => ({ ...s, visibility: e.target.value }))}
                options={[{ value: 'public', label: 'Visible to anyone who scans' }, { value: 'private', label: 'Internal only' }]} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ codes
function Codes({ object, reload, editable }) {
  const toast = useToast();
  const [type, setType] = useState('qr');
  const code = object.codes.find((c) => c.code_type === type);
  const imageUrl = useBlobUrl(code ? `/objects/${object.id}/code.png?type=${type}&scale=${type === 'qr' ? 8 : 3}` : null);
  const download = (format) => downloadAuthed(`/objects/${object.id}/code.${format}`, { type, download: 1, scale: format === 'png' ? (type === 'qr' ? 12 : 4) : undefined }, `${object.public_id}-${type}.${format}`).catch((e) => toast.error(e.message));

  const generate = async () => {
    await api.post(`/objects/${object.id}/code`, { code_type: type });
    toast.success(`${type === 'qr' ? 'QR code' : 'Barcode'} generated — this link is permanent`);
    reload();
  };

  return (
    <div className="stack">
      <Card title="Permanent code" sub="Generated once and never regenerated: update the object freely, the printed code keeps working"
        actions={<Segmented label="Code type" value={type} onChange={setType} options={[{ value: 'qr', label: 'QR code' }, { value: 'barcode', label: 'Barcode' }]} />}>
        {!code ? (
          <EmptyState icon="qr" title={`No ${type === 'qr' ? 'QR code' : 'barcode'} yet`}
            message={type === 'qr' ? 'Generate one and print it on the object. Scanning it always shows the latest information.' : 'Code 128 encodes the object ID for handheld scanners.'}
            action={editable ? <Button variant="primary" onClick={generate}>Generate {type === 'qr' ? 'QR code' : 'barcode'}</Button> : null} />
        ) : (
          <div className="code-preview">
            {imageUrl ? <img src={imageUrl} alt={`${type === 'qr' ? 'QR code' : 'Barcode'} for ${object.name}`} style={{ width: type === 'qr' ? 190 : 280 }} /> : <Spinner label="Loading code…" />}
            <div className="stack-sm grow" style={{ minWidth: 240 }}>
              <Field label="Permanent public URL" hint="Printed codes point here forever">
                <Input value={code.permanent_url} readOnly onFocus={(e) => e.target.select()} />
              </Field>
              {type === 'barcode' && <div className="small muted">The barcode encodes <span className="mono">{code.payload}</span> — handheld scanners read the ID, which staff can look up or type into the CRM.</div>}
              <div className="row wrap">
                <Button size="sm" icon="download" onClick={() => download('png')}>PNG</Button>
                <Button size="sm" icon="download" onClick={() => download('svg')}>SVG</Button>
                <Button size="sm" icon="printer" to={`/objects/labels?ids=${object.id}&type=${type}`}>Print label</Button>
                <Button size="sm" icon="link" onClick={() => { navigator.clipboard?.writeText(code.permanent_url); toast.success('Link copied'); }}>Copy link</Button>
                <Button size="sm" icon="eye" onClick={() => window.open(`/o/${object.public_id}`, '_blank')}>Preview what a scanner sees</Button>
              </div>
              <div className="tiny muted">Issued {dateTime(code.created_at)}. Generated by this system — no expiry, no scan limit, no third-party service.</div>
            </div>
          </div>
        )}
      </Card>

      {object.codes.length > 0 && (
        <Card title="Both formats">
          <div className="row wrap" style={{ gap: 24 }}>
            {['qr', 'barcode'].map((t) => {
              const c = object.codes.find((x) => x.code_type === t);
              return (
                <div key={t} className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <div className="small strong">{t === 'qr' ? 'QR code' : 'Barcode (Code 128)'}</div>
                  {c
                    ? <SmallCode objectId={object.id} type={t} />
                    : editable && <Button size="sm" onClick={async () => { await api.post(`/objects/${object.id}/code`, { code_type: t }).catch((e) => toast.error(e.message)); reload(); }}>Generate</Button>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function SmallCode({ objectId, type }) {
  const url = useBlobUrl(`/objects/${objectId}/code.png?type=${type}&scale=${type === 'qr' ? 5 : 2}`);
  return url ? <img src={url} alt="" style={{ background: '#fff', borderRadius: 8, border: '1px solid var(--border)', padding: 6 }} /> : <Spinner label="" />;
}

// ------------------------------------------------------------------ activity
const ACTION_TEXT = {
  create: 'Object created', update: 'Details updated', file_add: 'Document added', file_replace: 'Document replaced',
  file_restore: 'Earlier version restored', file_update: 'Document details changed', file_delete: 'Document removed',
  file_reorder: 'Documents reordered', code_generate: 'Code generated', archive: 'Archived', restore: 'Restored',
  duplicate: 'Duplicated from another object', delete: 'Deleted',
};

function Activity({ object }) {
  const s = object.scans;
  return (
    <div className="stack">
      <div className="tiles">
        <Tile label="Total scans" value={number(s.total)} />
        <Tile label="Today" value={number(s.today)} />
        <Tile label="Last 7 days" value={number(s.last_7)} />
        <Tile label="Last 30 days" value={number(s.last_30)} />
        <Tile label="Mobile / desktop" value={`${number(s.mobile + s.tablet)} / ${number(s.desktop)}`} foot="Device category only" />
        <Tile label="Last scanned" value={s.last_scanned_at ? timeAgo(s.last_scanned_at) : 'Never'} />
      </div>
      <Card title="Scans" sub="Last 30 days">
        <ColumnChart data={s.series} x="day" series={[{ key: 'scans', label: 'Scans' }]} height={200}
          xFormat={(d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} />
      </Card>
      <div className="grid grid-2">
        <Card title="Approximate locations" sub="Derived from the network, never precise" flush>
          {s.locations.length ? s.locations.map((l) => (
            <div key={l.location} className="alert-row"><span className="grow">{l.location}</span><span className="num">{l.scans}</span></div>
          )) : <EmptyState title="No scans yet" />}
        </Card>
        <Card title="Change history" flush>
          {object.activity.length ? object.activity.map((a) => (
            <div key={a.id} className="alert-row small">
              <span className="grow">
                {ACTION_TEXT[a.action] || a.action}
                {a.details?.title && <span className="muted"> · {a.details.title}</span>}
                {a.details?.code_type && <span className="muted"> · {a.details.code_type.toUpperCase()}</span>}
              </span>
              <span className="tiny muted nowrap">{dateTime(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}</span>
            </div>
          )) : <EmptyState title="No changes recorded" />}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ small modals
function ArchiveModal({ open, restore, object, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  return (
    <Modal open={open} onClose={onClose} size="sm" title={restore ? 'Restore object' : 'Archive object'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        await api.post(`/objects/${object.id}/archive`, { archived: !restore, note });
        toast.success(restore ? 'Restored' : 'Archived');
        onSaved();
        onClose();
      }}>{restore ? 'Restore' : 'Archive'}</Button></>}>
      {restore ? <p className="secondary">The scan page starts showing the object's information again.</p> : (
        <div className="stack">
          <p className="secondary">The permanent link keeps working and explains that the item is archived — it never redirects to another object.</p>
          <Field label="Message for anyone who scans it"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Machine decommissioned in Oct 2026" /></Field>
        </div>
      )}
    </Modal>
  );
}

function LinkModal({ open, object, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ customer: object.customer_id ? { id: object.customer_id, company_name: object.customer_name } : null, product_id: object.product_id || null, order_id: object.order_id ? String(object.order_id) : '' });
  const orders = useApi(open && form.customer?.id ? '/orders' : null, { customer_id: form.customer?.id, view: 'all' });
  return (
    <Modal open={open} onClose={onClose} title="Link to CRM records" subtitle="Optional — handy when a QR label sits on something you sold"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try {
          await api.put(`/objects/${object.id}`, { customer_id: form.customer?.id || null, product_id: form.product_id || null, order_id: form.order_id || null });
        } catch (e) {
          toast.error(e.message);
          return;
        }
        toast.success('Links saved');
        onSaved();
        onClose();
      }}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Customer" className="full">
          <CustomerPicker value={form.customer} allowCreate={false} onNewCustomer={() => {}} onChange={(c) => setForm((s) => ({ ...s, customer: c, order_id: '' }))} />
          {form.customer && <button type="button" className="btn link small" onClick={() => setForm((s) => ({ ...s, customer: null, order_id: '' }))}>Remove customer link</button>}
        </Field>
        <Field label="Product"><ProductSelect value={form.product_id} allowUnspecified onChange={(v) => setForm((s) => ({ ...s, product_id: v }))} /></Field>
        <Field label="Sales order" hint={form.customer ? undefined : 'Choose the customer first'}><Select value={form.order_id} disabled={!form.customer} onChange={(e) => setForm((s) => ({ ...s, order_id: e.target.value }))} placeholder="None" options={(orders.data?.rows || []).map((o) => ({ value: String(o.id), label: `${o.code}${o.po_reference ? ` · PO ${o.po_reference}` : ''}` }))} /></Field>
      </div>
    </Modal>
  );
}
