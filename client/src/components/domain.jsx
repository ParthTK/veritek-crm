import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTIVITY_TYPES, CONTACT_ROLES, ROLES, labelOf,
} from '@shared/constants.js';
import { api, fileUrl, uploadFile } from '../api.js';
import { useApi } from '../lib/hooks.js';
import { dateTime, date, fileSize, inrCompact, relativeDay, todayStr, addDaysStr } from '../lib/format.js';
import Icon from './Icon.jsx';
import { Button, Field, Input, Modal, Select, Textarea, useToast, Chips, EmptyState, Spinner, Badge } from './ui.jsx';
import { useAuth } from '../auth.jsx';

// ------------------------------------------------------------------ meta (reference data)
const MetaContext = createContext(null);
export function MetaProvider({ children }) {
  const { data, reload } = useApi('/meta');
  return <MetaContext.Provider value={{ ...(data || { regions: [], factories: [], users: [], categories: [], campaigns: [], tags: [], settings: {}, states: [] }), loaded: Boolean(data), reload }}>{children}</MetaContext.Provider>;
}
export const useMeta = () => useContext(MetaContext);

export const userOptions = (users, roles) => users
  .filter((u) => u.active && (!roles || roles.includes(u.role)))
  .map((u) => ({ value: u.id, label: `${u.name} · ${labelOf(ROLES, u.role)}` }));

export const SALES_ROLES = ['sales_executive', 'regional_manager', 'sales_head', 'management'];

export function UserSelect({ roles, placeholder = 'Unassigned', ...props }) {
  const { users } = useMeta();
  return <Select options={userOptions(users, roles)} placeholder={placeholder} {...props} />;
}

// ------------------------------------------------------------------ customer picker
export function CustomerPicker({ value, onChange, placeholder = 'Search company…', allowCreate, onCreate }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (value && (!selected || selected.id !== Number(value))) {
      api.get(`/customers/${value}`).then((c) => setSelected({ id: c.id, name: c.name, city: c.city })).catch(() => {});
    }
    if (!value) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => {
      api.get('/customers', { q: text, pageSize: 12, sort: 'name', dir: 'asc' }).then((r) => setResults(r.rows)).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [text, open]);

  useEffect(() => {
    const onDoc = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  if (selected && !open) {
    return (
      <div className="row input" style={{ justifyContent: 'space-between' }}>
        <span className="truncate">{selected.name}{selected.city ? <span className="muted"> · {selected.city}</span> : ''}</span>
        <button type="button" className="btn ghost xs" onClick={() => { onChange(null, null); setSelected(null); setOpen(true); }}>Change</button>
      </div>
    );
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input className="input" value={text} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }} />
      {open && (
        <div className="search-results" style={{ top: 38 }}>
          {results.map((c) => (
            <a key={c.id} href="#" onClick={(e) => { e.preventDefault(); setSelected(c); setOpen(false); onChange(c.id, c); }}>
              <span className="grow truncate">{c.name}</span>
              <span className="muted small">{c.city}</span>
            </a>
          ))}
          {!results.length && <div className="muted small" style={{ padding: 10 }}>No matching customers</div>}
          {allowCreate && text.trim().length > 2 && (
            <a href="#" onClick={(e) => { e.preventDefault(); setOpen(false); onCreate(text.trim()); }}>
              <Icon name="plus" size={14} /> Add “{text.trim()}” as a new company
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ attachments & voice notes
export function VoiceRecorder({ onRecorded }) {
  const [state, setState] = useState('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef(null);
  const timer = useRef(null);
  const toast = useToast();

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('Voice recording is not supported in this browser');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        onRecorded(blob);
        setState('idle');
      };
      rec.start();
      recorder.current = rec;
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      setState('recording');
    } catch {
      toast.error('Microphone permission was denied');
    }
  };
  const stop = () => {
    clearInterval(timer.current);
    recorder.current?.stop();
  };
  useEffect(() => () => clearInterval(timer.current), []);

  return state === 'recording'
    ? <Button size="sm" variant="danger" icon="stop" onClick={stop}>Stop · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</Button>
    : <Button size="sm" icon="mic" onClick={start}>Voice note</Button>;
}

/** Collect uploads before the parent record exists; returns attachment ids via onChange. */
export function PendingAttachments({ value = [], onChange, kind = 'file', voice = true, accept }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const add = async (file, k = kind, name) => {
    setBusy(true);
    try {
      const a = await uploadFile(file, { kind: k, name });
      onChange([...value, a]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <div className="row wrap">
        <Button size="sm" icon="paperclip" loading={busy} onClick={() => inputRef.current?.click()}>Attach files</Button>
        {voice && <VoiceRecorder onRecorded={(blob) => add(blob, 'voice_note', `voice-note-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`)} />}
        <input ref={inputRef} type="file" multiple hidden accept={accept} onChange={async (e) => { for (const f of e.target.files) await add(f); e.target.value = ''; }} />
      </div>
      {value.length > 0 && (
        <div className="chips">
          {value.map((a) => (
            <span key={a.id} className="tag">
              <Icon name={a.kind === 'voice_note' ? 'mic' : 'file'} size={12} /> &nbsp;{a.original_name} <span className="muted">&nbsp;{fileSize(a.size)}</span>
              <button type="button" className="btn ghost xs" onClick={() => onChange(value.filter((x) => x.id !== a.id))} aria-label="Remove">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AttachmentList({ items }) {
  if (!items?.length) return null;
  return (
    <div className="stack-sm" style={{ marginTop: 6 }}>
      {items.map((a) => (
        a.mime?.startsWith('audio/')
          ? <div key={a.id} className="row"><Icon name="mic" size={14} /><audio controls src={fileUrl(a.id)} style={{ height: 32, maxWidth: 280 }} /></div>
          : a.mime?.startsWith('image/')
            ? <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer"><img src={fileUrl(a.id)} alt={a.original_name} style={{ maxWidth: 160, maxHeight: 110, borderRadius: 6, border: '1px solid var(--border)' }} /></a>
            : <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" className="row small"><Icon name="file" size={14} />{a.original_name} <span className="muted">{fileSize(a.size)}</span></a>
      ))}
    </div>
  );
}

export function EntityAttachments({ entity, entityId, kind = 'file', canUpload = true, title = 'Attachments' }) {
  const { data, reload } = useApi(`/attachments`, { entity, entity_id: entityId });
  const toast = useToast();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const upload = async (files) => {
    setBusy(true);
    try {
      for (const f of files) await uploadFile(f, { entity, entity_id: entityId, kind });
      toast.success('Uploaded');
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      <div className="row between">
        <h3>{title}</h3>
        {canUpload && <Button size="sm" icon="paperclip" loading={busy} onClick={() => inputRef.current?.click()}>Upload</Button>}
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </div>
      {data?.length ? <AttachmentList items={data} /> : <div className="muted small">No files yet</div>}
    </div>
  );
}

// ------------------------------------------------------------------ log activity
const ACTIVITY_ICONS = { call: 'phone', whatsapp: 'whatsapp', email: 'mail', meeting: 'meeting', video: 'video', factory_visit: 'factory', sample_delivery: 'box', requirement: 'file', note: 'note' };

/**
 * Log an interaction. For open leads the next action and follow-up date are mandatory
 * (enforced by the API too), keeping every lead moving.
 */
export function LogActivityModal({ open, onClose, onSaved, customerId, leadId, quotationId, orderId, complaintId, followup, requireNext, defaultType = 'call' }) {
  const toast = useToast();
  const { data: customer } = useApi(open && customerId ? `/customers/${customerId}` : null);
  const [form, setForm] = useState({});
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ type: defaultType, follow_up_date: requireNext ? addDaysStr(todayStr(), 3) : '', next_action: followup?.title && requireNext ? '' : '' });
      setFiles([]);
    }
  }, [open, defaultType, requireNext, followup]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/activities', {
        ...form, customer_id: customerId, lead_id: leadId, quotation_id: quotationId, order_id: orderId, complaint_id: complaintId,
        complete_followup_id: followup?.id, attachment_ids: files.map((f) => f.id),
      });
      toast.success(followup ? 'Logged and follow-up completed' : 'Interaction logged');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Log interaction" subtitle={followup ? `Completing: ${followup.title}` : customer?.name}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="stack">
        <Chips options={ACTIVITY_TYPES.map((t) => ({ value: t.value, label: t.label }))} value={form.type} onChange={(v) => setForm((f) => ({ ...f, type: v || f.type }))} />
        <div className="form-grid">
          <Field label="Contact person">
            <Select value={form.contact_id} onChange={set('contact_id')} placeholder="—" options={(customer?.contacts || []).map((c) => ({ value: c.id, label: `${c.name}${c.designation ? ` (${c.designation})` : ''}` }))} />
          </Field>
          <Field label="When">
            <Input type="datetime-local" value={form.activity_date} onChange={set('activity_date')} max={new Date().toISOString().slice(0, 16)} />
          </Field>
          <Field label="Discussion summary" required className="full">
            <Textarea rows={3} value={form.summary} onChange={set('summary')} placeholder="What was discussed?" />
          </Field>
          <Field label="Customer's response">
            <Textarea rows={2} value={form.customer_response} onChange={set('customer_response')} />
          </Field>
          <Field label="Objections raised">
            <Textarea rows={2} value={form.objections} onChange={set('objections')} placeholder="Price, delivery, specs…" />
          </Field>
          <Field label="Products discussed" className="full">
            <Input value={form.products_discussed} onChange={set('products_discussed')} placeholder="e.g. EM300 meters, GW10 gateway" />
          </Field>
          <Field label="Next action" required={requireNext}>
            <Input value={form.next_action} onChange={set('next_action')} placeholder="e.g. Send revised quotation" />
          </Field>
          <Field label="Follow-up date" required={requireNext} hint={form.follow_up_date ? relativeDay(form.follow_up_date) : 'Creates a reminder'}>
            <Input type="date" value={form.follow_up_date} onChange={set('follow_up_date')} min={todayStr()} />
          </Field>
          <Field label="Attachments & voice notes" className="full">
            <PendingAttachments value={files} onChange={setFiles} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ timeline
const KIND_ICON = { communication: 'phone', lead: 'leads', quotation: 'quotations', order: 'orders', production: 'production', dispatch: 'truck', payment: 'rupee', complaint: 'complaints', sample: 'box', requirement: 'file' };
const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'communication', label: 'Calls, meetings & messages' },
  { value: 'requirement', label: 'Requirements & samples' },
  { value: 'lead', label: 'Leads' },
  { value: 'quotation', label: 'Quotations' },
  { value: 'order', label: 'Orders' },
  { value: 'production', label: 'Production' },
  { value: 'dispatch', label: 'Dispatch' },
  { value: 'payment', label: 'Payments' },
  { value: 'complaint', label: 'Service' },
];

export function Timeline({ items, loading, filterable = true, limit }) {
  const [kind, setKind] = useState('');
  const [showAll, setShowAll] = useState(false);
  if (loading && !items) return <Spinner />;
  const filtered = (items || []).filter((i) => !kind || i.kind === kind || (kind === 'requirement' && i.kind === 'sample'));
  const visible = limit && !showAll ? filtered.slice(0, limit) : filtered;
  const counts = Object.fromEntries(KINDS.map((k) => [k.value, k.value ? (items || []).filter((i) => i.kind === k.value || (k.value === 'requirement' && i.kind === 'sample')).length : (items || []).length]));
  return (
    <div className="stack">
      {filterable && <Chips options={KINDS.filter((k) => !k.value || counts[k.value])} value={kind} onChange={setKind} counts={counts} />}
      {!filtered.length ? <EmptyState icon="clock" title="No activity yet" message="Interactions, quotations, orders and payments appear here in order." /> : (
        <div className="timeline">
          {visible.map((i) => (
            <div key={i.key} className="tl-item">
              <span className={`tl-icon ${i.kind}`}><Icon name={i.kind === 'communication' ? ACTIVITY_ICONS[i.type] || 'phone' : KIND_ICON[i.kind]} size={12} strokeWidth={2.2} /></span>
              <div className="tl-head">
                <span className="tl-title">{i.title}</span>
                {i.amount !== undefined && i.amount !== null && <Badge size="sm" color="slate">{inrCompact(i.amount)}</Badge>}
                {i.refs?.map((r) => <Link key={r.link} to={r.link} className="small">{r.label}</Link>)}
              </div>
              <div className="tl-meta">{dateTime(i.at)}{i.user ? ` · ${i.user}` : ''}</div>
              {i.detail && <div className="tl-body">{i.detail}</div>}
              {(i.customer_response || i.objections || i.next_action || i.products_discussed) && (
                <dl className="tl-detail">
                  {i.customer_response && <><dt>Response</dt><dd>{i.customer_response}</dd></>}
                  {i.objections && <><dt>Objections</dt><dd>{i.objections}</dd></>}
                  {i.products_discussed && <><dt>Products</dt><dd>{i.products_discussed}</dd></>}
                  {i.next_action && <><dt>Next action</dt><dd>{i.next_action}{i.follow_up_date ? ` · ${date(i.follow_up_date)}` : ''}</dd></>}
                </dl>
              )}
              <AttachmentList items={i.attachments} />
            </div>
          ))}
        </div>
      )}
      {limit && filtered.length > limit && !showAll && <Button size="sm" onClick={() => setShowAll(true)}>Show all {filtered.length}</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ contacts quick actions
export function ContactActions({ phone, whatsapp, email, size = 'xs' }) {
  const wa = (whatsapp || phone || '').replace(/[^\d]/g, '');
  return (
    <span className="row" style={{ gap: 2 }}>
      {phone && <a className={`btn ghost ${size} icon`} href={`tel:${phone.replace(/\s/g, '')}`} title={`Call ${phone}`}><Icon name="phone" size={13} /></a>}
      {wa && <a className={`btn ghost ${size} icon`} href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" title="WhatsApp"><Icon name="whatsapp" size={13} /></a>}
      {email && <a className={`btn ghost ${size} icon`} href={`mailto:${email}`} title={email}><Icon name="mail" size={13} /></a>}
    </span>
  );
}

export function ContactForm({ open, onClose, onSaved, customerId, contact }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setForm(contact || { contact_role: 'purchase', preferred_channel: 'phone' }); }, [open, contact]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const save = async () => {
    setBusy(true);
    try {
      if (contact?.id) await api.put(`/contacts/${contact.id}`, form);
      else await api.post(`/customers/${customerId}/contacts`, form);
      toast.success('Contact saved');
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={contact?.id ? 'Edit contact' : 'Add contact'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" required><Input value={form.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Role"><Select value={form.contact_role} onChange={set('contact_role')} options={CONTACT_ROLES} /></Field>
        <Field label="Designation"><Input value={form.designation} onChange={set('designation')} /></Field>
        <Field label="Preferred channel"><Select value={form.preferred_channel} onChange={set('preferred_channel')} options={[{ value: 'phone', label: 'Phone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' }, { value: 'meeting', label: 'In person' }]} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} placeholder="+91 98…" /></Field>
        <Field label="WhatsApp"><Input value={form.whatsapp} onChange={set('whatsapp')} placeholder="Same as phone if blank" /></Field>
        <Field label="Email" className="full"><Input type="email" value={form.email} onChange={set('email')} /></Field>
        <label className="check full"><input type="checkbox" checked={Boolean(form.is_primary)} onChange={set('is_primary')} /> Primary contact</label>
      </div>
    </Modal>
  );
}

export function useCan() {
  const { can } = useAuth();
  return can;
}
