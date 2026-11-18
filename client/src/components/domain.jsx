// Domain building blocks shared across pages: reference data, pickers, status labels, timeline, documents.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ENQUIRY_STAGES, LINE_STATES, OUTCOMES, PHASES, COMM_STATES, DISPATCH_STATUSES, REACTIVATION_STATUSES, QUOTE_STATUSES, APPROVAL_STATUSES, COUNTRIES, SEGMENTS, ROLES, DEPARTMENTS, labelOf, toneOf, TASK_PURPOSES, dialFor,
} from '@shared/constants.js';
import { datePresets } from '@shared/dates.js';
import { splitPhone, joinPhone, tidyPhoneNumber } from '@shared/rules.js';
import { api, openFile, uploadFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { date, dateTime, relDay, setZone, todayLocal, fileSize, money } from '../lib/format.js';
import Icon, { CHANNEL_ICON } from './Icon.jsx';
import { Badge, Button, Combobox, Field, Input, Select, Spinner, useToast, Notice, Card } from './ui.jsx';

// ------------------------------------------------------------------ reference data
const MetaContext = createContext(null);
export function MetaProvider({ children }) {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/meta').then((m) => {
    setZone(m.timezone, m.today);
    setMeta(m);
  }).catch(setError), []);
  useEffect(() => {
    load();
  }, [load]);
  if (error) return <div className="content"><Notice tone="danger" title="Could not load the application">{error.message} <Button size="sm" onClick={load}>Retry</Button></Notice></div>;
  if (!meta) return <Spinner label="Loading…" />;
  return <MetaContext.Provider value={{ ...meta, reload: load }}>{children}</MetaContext.Provider>;
}
export const useMeta = () => useContext(MetaContext);

export function useOptions(category, { includeInactive = false, keep } = {}) {
  const meta = useMeta();
  return useMemo(() => (meta.dropdowns[category] || [])
    .filter((o) => o.active || includeInactive || o.code === keep)
    .map((o) => ({ value: o.code, label: o.active ? o.label : `${o.label} (no longer used)`, requires_note: o.requires_note })), [meta, category, includeInactive, keep]);
}
export function useOptionLabel() {
  const meta = useMeta();
  return useCallback((category, code) => (code ? meta.dropdowns[category]?.find((o) => o.code === code)?.label || String(code).replace(/_/g, ' ') : ''), [meta]);
}
export function usePeople({ activeOnly = true } = {}) {
  const meta = useMeta();
  return useMemo(() => meta.people.filter((p) => !activeOnly || p.active), [meta, activeOnly]);
}

export function OptionSelect({ category, value, onChange, placeholder = 'Choose…', invalid, id, exclude = [] }) {
  const options = useOptions(category, { keep: value }).filter((o) => !exclude.includes(o.value));
  return <Select id={id} options={options} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} invalid={invalid} />;
}

/** Named people — including department heads who do not sign in — shown with their department. */
export function UserSelect({ value, onChange, placeholder = 'Choose a person…', invalid, id, filter }) {
  const people = usePeople();
  const options = people.filter((p) => !filter || filter(p)).map((p) => ({ value: String(p.id), label: `${p.name}${p.department ? ` — ${labelOf(DEPARTMENTS, p.department)}` : ''}` }));
  return <Select id={id} options={options} value={value ? String(value) : ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} placeholder={placeholder} invalid={invalid} />;
}

export function personName(meta, id) {
  return meta.people.find((p) => p.id === id)?.name || '—';
}

export function ProductSelect({ value, onChange, invalid, id, allowUnspecified = true }) {
  const meta = useMeta();
  const options = [
    ...(allowUnspecified ? [{ value: '', label: 'Unspecified / needs clarification', sub: 'Describe the requirement instead' }] : []),
    ...meta.products.filter((p) => p.active || p.id === value).map((p) => ({ value: p.id, label: p.code, sub: `${p.name}${p.family ? ` · ${p.family}` : ''}` })),
  ];
  const current = meta.products.find((p) => p.id === value);
  return <Combobox id={id} value={value ?? ''} label={current ? current.code : allowUnspecified && value === null ? 'Unspecified / needs clarification' : ''} options={options} onChange={(o) => onChange(o.value === '' ? null : o.value)} placeholder="Search model…" invalid={invalid} />;
}

export function CountrySelect({ value, onChange, id }) {
  return <Select id={id} options={COUNTRIES} value={value} onChange={(e) => onChange(e.target.value || null)} placeholder="Unknown" />;
}

/**
 * A phone number with its country code, saved together ("+91 98200 11111"). Until a code is chosen or a number
 * is typed, the code follows the customer's country. "Other" is for a country not on the list: the whole number
 * is typed with its + code.
 */
export function PhoneInput({ value, onChange, country, id, invalid }) {
  const [picked, setPicked] = useState(null);
  const { dial, number } = splitPhone(value);
  const other = !dial && number.startsWith('+');
  const code = other ? '' : dial || picked || dialFor(country) || dialFor('IN');
  const pick = (next) => {
    setPicked(next);
    const digits = number.replace(/^\+\s*/, '');
    if (!next) onChange(`+${digits}`);
    else if (digits) onChange(joinPhone(next, digits));
    else onChange('');
  };
  const tidy = () => {
    const clean = tidyPhoneNumber(code, number);
    if (clean !== number) onChange(joinPhone(code, clean));
  };
  return (
    <div className="phone-input">
      <label className="phone-code">
        <span>{code ? `+${code}` : 'Other'}</span>
        <Icon name="chevronDown" size={12} />
        <select aria-label="Country code" value={code} onChange={(e) => pick(e.target.value)}>
          {COUNTRIES.map((c) => <option key={c.value} value={c.dial}>+{c.dial} {c.label}</option>)}
          <option value="">Other</option>
        </select>
      </label>
      <Input id={id} invalid={invalid} inputMode="tel" autoComplete="tel" placeholder={other ? '+33 1 23 45 67 89' : '98200 11111'} value={number} onChange={(e) => onChange(joinPhone(code, e.target.value))} onBlur={tidy} onKeyDown={(e) => { if (e.key === 'Enter') tidy(); }} />
    </div>
  );
}

/** Date input with presets (Today, Next working day, +2 working days, +1 week…). */
export function DateField({ label, value, onChange, error, required, hint, id, presets = true, min }) {
  const meta = useMeta();
  const list = presets ? datePresets(todayLocal(), meta.settings.calendar) : [];
  return (
    <Field label={label} required={required} error={error} hint={hint} htmlFor={id}>
      <Input id={id} type="date" value={value || ''} min={min} onChange={(e) => onChange(e.target.value)} invalid={Boolean(error)} />
      {presets && (
        <div className="presets">
          {list.map((p) => <button key={p.label} type="button" className={value === p.value ? 'on' : ''} onClick={() => onChange(p.value)}>{p.label}</button>)}
        </div>
      )}
    </Field>
  );
}

export function PurposeInput({ value, onChange, invalid, id, list = 'task-purposes' }) {
  return (
    <>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} list={list} placeholder="e.g. Confirm purchase decision" invalid={invalid} />
      <datalist id={list}>{TASK_PURPOSES.map((p) => <option key={p} value={p} />)}</datalist>
    </>
  );
}

export function FilterBar({ value, onChange, fields = ['owner', 'segment', 'country', 'family'] }) {
  const meta = useMeta();
  const people = usePeople({ activeOnly: false });
  return (
    <div className="filter-bar">
      {fields.includes('owner') && (
        <Select aria-label="Owner" value={value.owner || ''} onChange={(e) => onChange({ owner: e.target.value })} placeholder="All owners"
          options={people.filter((p) => ['admin', 'coordinator', 'sales', 'accounts'].includes(p.group)).map((p) => ({ value: String(p.id), label: p.name }))} />
      )}
      {fields.includes('segment') && <Select aria-label="Market" value={value.segment || ''} onChange={(e) => onChange({ segment: e.target.value })} placeholder="Domestic & export" options={SEGMENTS} />}
      {fields.includes('country') && <Select aria-label="Country" value={value.country || ''} onChange={(e) => onChange({ country: e.target.value })} placeholder="All countries" options={COUNTRIES} />}
      {fields.includes('family') && <Select aria-label="Product family" value={value.family || ''} onChange={(e) => onChange({ family: e.target.value })} placeholder="All product families" options={meta.families} />}
    </div>
  );
}

// ------------------------------------------------------------------ status labels (always text + colour)
export const StageBadge = ({ stage, size }) => <Badge tone={toneOf(ENQUIRY_STAGES, stage)} size={size}>{labelOf(ENQUIRY_STAGES, stage)}</Badge>;
export const QuoteBadge = ({ status, size }) => (status ? <Badge tone={toneOf(QUOTE_STATUSES, status)} size={size}>{labelOf(QUOTE_STATUSES, status)}</Badge> : null);
export const ApprovalBadge = ({ status, size }) => (status && status !== 'not_required' ? <Badge tone={toneOf(APPROVAL_STATUSES, status)} size={size} icon={status === 'approved' ? 'check' : 'shield'}>{labelOf(APPROVAL_STATUSES, status)}</Badge> : null);
export const ReactivationBadge = ({ status }) => <Badge tone={toneOf(REACTIVATION_STATUSES, status)}>{labelOf(REACTIVATION_STATUSES, status)}</Badge>;

export function LineStateBadge({ state, daysLate, size, pastAgreed }) {
  const s = LINE_STATES.find((x) => x.value === state) || LINE_STATES[4];
  const label = state === 'overdue' && daysLate ? `Overdue ${daysLate} day${daysLate === 1 ? '' : 's'}` : s.label;
  return <Badge tone={s.tone} icon={s.icon} size={size} title={pastAgreed ? 'Also past the customer-agreed date' : undefined}>{label}{pastAgreed ? ' · past agreed date' : ''}</Badge>;
}

export function OutcomeBadges({ outcome = [], size }) {
  return <span className="row wrap" style={{ gap: 4 }}>{outcome.map((o) => <Badge key={o} tone={toneOf(OUTCOMES, o)} size={size}>{labelOf(OUTCOMES, o)}</Badge>)}</span>;
}

export function CommBadge({ state, size }) {
  if (!state || state === 'not_needed') return <span className="muted small">Not needed</span>;
  return <Badge tone={toneOf(COMM_STATES, state)} icon={state === 'pending' ? 'alert' : 'check'} size={size}>{state === 'pending' ? 'No — not informed' : 'Yes — informed'}</Badge>;
}

export function PhaseLabel({ phase }) {
  if (phase === 'mixed') return <Badge tone="violet" icon="layers">Mixed phases</Badge>;
  if (phase === 'draft') return <Badge tone="slate">Draft</Badge>;
  if (phase === 'closed') return <Badge tone="slate">Closed</Badge>;
  return <span className="strong small">{labelOf(PHASES, phase)}</span>;
}

/** Due label in the business zone: Overdue / Today / Tomorrow / date. */
export function DueBadge({ task, date: d, state }) {
  const due = task?.due_date || d;
  const st = task?.due_state || state;
  if (!due) return <span className="muted">—</span>;
  if (st === 'overdue') return <Badge tone="red" icon="clock">{relDay(due) === 'Today' ? `Overdue (${task?.due_time || 'today'})` : relDay(due)}</Badge>;
  if (st === 'today') return <Badge tone="green">Today{task?.due_time ? ` ${task.due_time}` : ''}</Badge>;
  const r = relDay(due);
  return <Badge tone={r === 'Tomorrow' ? 'amber' : 'slate'}>{r}</Badge>;
}

export function HealthLabels({ labels = [] }) {
  return <span className="row wrap" style={{ gap: 6 }}>{labels.map((l) => <Badge key={l.code} tone={l.tone}>{l.label}</Badge>)}</span>;
}

/** A money value. `empty` replaces "Unknown" where a blank means "not filled in yet" (e.g. the price list). */
export function Money({ minor, currency, empty }) {
  const { user } = useAuth();
  if (!user?.permissions.includes('values.view')) return <span className="muted small" title="Commercial values are hidden for your role">Hidden</span>;
  if (minor === null || minor === undefined) return empty ? <span className="muted">{empty}</span> : <span className="muted" title="Price not recorded — not zero">Unknown</span>;
  return <span className="num">{money(minor, currency)}</span>;
}

/** One plain payment status for an order. */
export function PaymentBadge({ payment, size = 'sm' }) {
  if (!payment) return null;
  return <Badge size={size} tone={payment.tone} title={payment.hold_reason || undefined}>{payment.label}</Badge>;
}

export function DispatchBadge({ dispatch: d }) {
  if (d.status === 'posted') return d.delivered_at ? <Badge size="sm" tone="green">Delivered {date(d.delivered_at)}</Badge> : <Badge size="sm" tone="blue">In transit</Badge>;
  return <Badge size="sm" tone={toneOf(DISPATCH_STATUSES, d.status)}>{labelOf(DISPATCH_STATUSES, d.status)}</Badge>;
}

export const transportText = (d) => [d.carrier, d.tracking_no && `LR ${d.tracking_no}`, d.vehicle_number].filter(Boolean).join(' · ');

export function ReplyBadge({ replied, size = 'sm' }) {
  return <Badge size={size} tone={replied ? 'green' : 'red'}>{replied ? 'Replied' : 'Not replied'}</Badge>;
}

/** Enquiry → quotation → confirmation → payment → production → dispatch, showing where this deal is now. */
export function SalesJourney({ deal }) {
  return (
    <div className="journey sales" aria-label={`Sales journey: now at ${deal.stage_label}`}>
      {deal.steps.map((s) => {
        const cls = s.state === 'done' ? 'done' : s.state === 'current' ? `current ${deal.severity === 'red' ? 'stuck' : deal.severity === 'amber' ? 'hold' : ''}` : s.state === 'closed' ? 'current hold' : '';
        return (
          <div key={s.key} className={`step ${cls}`}>
            <span className="node">{s.state === 'done' && <Icon name="check" size={14} strokeWidth={3} />}</span>
            <span className="strong">{s.label}</span>
            {s.detail && <span className="tiny muted">{s.link ? <Link to={s.link}>{s.detail}</Link> : s.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Why a deal is stuck, worst first. */
export function DealReasons({ deal, limit }) {
  const shown = limit ? deal.reasons.slice(0, limit) : deal.reasons;
  return (
    <ul className="reasons">
      {shown.map((r) => <li key={r.text} className={r.severity}>{r.text}</li>)}
      {limit && deal.reasons.length > limit && <li className="info">+{deal.reasons.length - limit} more</li>}
    </ul>
  );
}

/** The journey of one enquiry, quotation or order, shown at the top of its page. */
export function JourneyCard({ enquiryId, quotationId, orderId, version }) {
  const [deal, setDeal] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api.get('/pipeline/journey', { enquiry_id: enquiryId, quotation_id: quotationId, order_id: orderId }).then((r) => { if (live) setDeal(r.journey); }, () => { if (live) setDeal(null); });
    load();
    window.addEventListener('data:changed', load);
    return () => {
      live = false;
      window.removeEventListener('data:changed', load);
    };
  }, [enquiryId, quotationId, orderId, version]);
  if (!deal) return null;
  const blocking = deal.status === 'active' && deal.reasons.some((r) => r.severity === 'red' || r.severity === 'amber');
  return (
    <Card className="no-print" title="Sales journey" sub={deal.status === 'completed' ? 'completed' : deal.status === 'active' ? `at ${deal.stage_label} for ${deal.days_in_stage} day${deal.days_in_stage === 1 ? '' : 's'}` : deal.status}
      actions={<Button size="sm" variant="ghost" to="/pipeline">Open pipeline</Button>}>
      <SalesJourney deal={deal} />
      {blocking && <div className="mt-8"><div className="tiny muted strong">Why it is stuck</div><DealReasons deal={deal} limit={4} /></div>}
    </Card>
  );
}

export function JourneyStepper({ phase, workStatus, dispatched }) {
  const steps = PHASES;
  const current = dispatched ? 'dispatched' : phase;
  const idx = steps.findIndex((s) => s.value === current);
  return (
    <div className="journey" aria-label={`Journey: ${labelOf(PHASES, current)}`}>
      {steps.map((s, i) => {
        const state = i < idx || (dispatched && i === idx) ? 'done' : i === idx ? 'current' : '';
        return (
          <div key={s.value} className={`step ${state} ${state === 'current' && workStatus === 'on_hold' ? 'hold' : ''}`}>
            <span className="node">{state === 'done' && <Icon name="check" size={14} strokeWidth={3} />}</span>
            <span>{s.label}{state === 'current' && workStatus === 'on_hold' ? ' (on hold)' : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ customer picker with duplicate warnings
/**
 * Search first; quick-create a company with at least one contact method (phone OR email). Before creating,
 * possible existing matches are shown — choosing one avoids a duplicate; nothing merges automatically.
 */
export function CustomerPicker({ value, onChange, allowCreate = true, invalid, id, newCustomer, onNewCustomer }) {
  const [creating, setCreating] = useState(Boolean(newCustomer));
  const [matches, setMatches] = useState([]);
  const load = useCallback(async (q) => {
    if (q.trim().length < 2) return [];
    const res = await api.get('/customers', { q, pageSize: 12 });
    return res.rows.map((c) => ({ value: c.id, label: c.company_name, sub: [c.code, c.city, c.country_code, c.primary_contact].filter(Boolean).join(' · '), row: c }));
  }, []);
  const nc = newCustomer || { company_name: '', country_code: 'IN', city: '', contact_name: '', phone: '', email: '' };
  const setNc = (patch) => onNewCustomer({ ...nc, ...patch });
  const timer = useRef(null);
  useEffect(() => {
    if (!creating) return undefined;
    clearTimeout(timer.current);
    if ((nc.company_name || '').length < 3 && !nc.phone && !nc.email) {
      setMatches([]);
      return undefined;
    }
    timer.current = setTimeout(() => {
      api.get('/customers/match', { name: nc.company_name, phone: nc.phone, email: nc.email, country: nc.country_code }).then(setMatches).catch(() => {});
    }, 350);
    return () => clearTimeout(timer.current);
  }, [creating, nc.company_name, nc.phone, nc.email, nc.country_code]);

  if (creating) {
    return (
      <div className="stack-sm">
        <div className="form-grid">
          <Field label="Company name" required className="full"><Input value={nc.company_name} onChange={(e) => setNc({ company_name: e.target.value })} /></Field>
          <Field label="Contact person" optional><Input value={nc.contact_name} onChange={(e) => setNc({ contact_name: e.target.value })} /></Field>
          <Field label="Phone" hint="Phone or email is needed"><PhoneInput value={nc.phone} country={nc.country_code} onChange={(v) => setNc({ phone: v })} /></Field>
          <Field label="Email"><Input value={nc.email} onChange={(e) => setNc({ email: e.target.value })} type="email" /></Field>
          <Field label="City" optional><Input value={nc.city} onChange={(e) => setNc({ city: e.target.value })} /></Field>
          <Field label="Country"><CountrySelect value={nc.country_code} onChange={(v) => setNc({ country_code: v })} /></Field>
        </div>
        {matches.length > 0 && (
          <div className="match-card" role="alert">
            <div className="strong small">Possible existing customer — use it instead of creating a duplicate?</div>
            {matches.slice(0, 3).map((m) => (
              <div key={m.id} className="row between mt-8" style={{ gap: 8 }}>
                <span className="small"><strong>{m.company_name}</strong> {m.city ? `· ${m.city}` : ''} — {m.reasons.join('; ')}</span>
                <Button size="xs" onClick={() => { setCreating(false); onNewCustomer(null); onChange({ id: m.id, company_name: m.company_name }); }}>Use this</Button>
              </div>
            ))}
            <div className="small mt-8">Different company? Continue — you will be asked to confirm it is separate.</div>
          </div>
        )}
        <Button size="sm" variant="link" onClick={() => { setCreating(false); onNewCustomer(null); }}>Search existing customers instead</Button>
      </div>
    );
  }
  return (
    <div className="stack-xs">
      <Combobox id={id} value={value?.id} label={value?.company_name || ''} load={load} onChange={(o) => onChange({ id: o.value, company_name: o.label, row: o.row })}
        placeholder="Search customers…" invalid={invalid} minChars={2}
        renderEmpty={(q, close) => (allowCreate && q.length >= 2 ? (
          <div className="combo-opt" onMouseDown={(e) => { e.preventDefault(); close(); setCreating(true); onNewCustomer({ ...nc, company_name: q }); onChange(null); }}>
            <span><Icon name="plus" size={13} /> Add new company “{q}”</span>
            <span className="s">Quick-create with a phone or email</span>
          </div>
        ) : <div className="combo-opt"><span className="s">No matches</span></div>)}
      />
      {allowCreate && <Button size="sm" variant="link" onClick={() => { setCreating(true); onNewCustomer({ ...nc }); onChange(null); }}>+ New company</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ timeline
const GROUP_ICON = { calls: 'phone', emails: 'mail', quotations: 'quotation', orders: 'box', complaints: 'complaint', internal: 'note', enquiries: 'inbox', payments: 'payment' };
export const TIMELINE_FILTERS = [
  { value: 'all', label: 'All' }, { value: 'calls', label: 'Calls & messages' }, { value: 'emails', label: 'Emails' }, { value: 'quotations', label: 'Quotations' },
  { value: 'enquiries', label: 'Enquiries' }, { value: 'orders', label: 'Order events' }, { value: 'complaints', label: 'Complaints' }, { value: 'internal', label: 'Internal notes' },
];

export function Timeline({ items = [], compact }) {
  if (!items.length) return <div className="muted small">Nothing recorded yet.</div>;
  return (
    <div className="timeline">
      {items.map((i) => (
        <div key={i.key || i.id} className="tl-item">
          <span className={`tl-icon ${i.group || ''}`}><Icon name={CHANNEL_ICON[i.icon] || GROUP_ICON[i.group] || 'file'} size={12} /></span>
          <div className="tl-head">
            <span className="tl-title">{i.link ? <Link to={i.link}>{i.title}</Link> : i.title}</span>
          </div>
          <div className="tl-meta">
            {dateTime(i.at)}
            {i.actor && ` · entered by ${i.actor}`}
            {i.reported_by && i.reported_by !== i.actor && ` · reported by ${i.reported_by}`}
            {i.contact && ` · with ${i.contact}`}
            {i.backdated && <Badge size="sm" tone="amber"> Back-entered {dateTime(i.entered_at)}</Badge>}
            {i.historical && <Badge size="sm" tone="slate">Historical entry</Badge>}
            {i.customer_contact === false && <Badge size="sm" tone="slate">Internal — not customer contact</Badge>}
          </div>
          {!compact && i.detail && <div className="tl-body">{i.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ documents
export function Attachments({ items = [], entityType, entityId, onChange, canUpload = true }) {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const onFiles = async (files) => {
    setBusy(true);
    try {
      for (const f of files) {
        const r = await uploadFile(f, { entity_type: entityType, entity_id: entityId });
        toast.success(r.reused ? `${f.name}: identical file already stored — linked by reference` : `${f.name} uploaded`);
      }
      onChange?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-sm">
      {!items.length && <div className="muted small">No documents yet.</div>}
      {items.map((a) => (
        <div key={`${a.id}-${a.entity_type || ''}`} className="row between" style={{ gap: 8 }}>
          <button type="button" className="btn link" onClick={() => openFile(a.id).catch((e) => toast.error(e.message))}>
            <Icon name="paperclip" size={14} /> {a.original_name}
          </button>
          <span className="muted small nowrap">{fileSize(a.size)} · {date(a.uploaded_at)}{a.via ? ` · via ${a.via}` : ''}</span>
        </div>
      ))}
      {canUpload && can('attachments.upload') && entityType && (
        <>
          <input ref={inputRef} type="file" hidden multiple onChange={(e) => { onFiles([...e.target.files]); e.target.value = ''; }}
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt,.eml,.msg,.pptx" />
          <div><Button size="sm" icon="upload" loading={busy} onClick={() => inputRef.current?.click()}>Attach document</Button> <span className="muted tiny">PDF, images, Office, CSV, email — max 20 MB</span></div>
        </>
      )}
    </div>
  );
}

/** Uploads a single file and returns its id (used inside forms before the record exists). */
export function FilePick({ value, onChange, label = 'Attach document', entityType, entityId }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  return (
    <span className="row wrap">
      <input ref={ref} type="file" hidden onChange={async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true);
        try {
          const r = await uploadFile(f, { entity_type: entityType, entity_id: entityId });
          onChange({ id: r.id, name: r.original_name });
        } catch (err) {
          toast.error(err.message);
        } finally {
          setBusy(false);
        }
      }} />
      <Button size="sm" icon="paperclip" loading={busy} onClick={() => ref.current?.click()}>{value ? 'Replace' : label}</Button>
      {value && <span className="small"><Icon name="file" size={13} /> {value.name} <button type="button" className="btn link" onClick={() => onChange(null)}>Remove</button></span>}
    </span>
  );
}

export function PinButton({ type, id, pinned, onChange }) {
  const { can } = useAuth();
  const toast = useToast();
  if (!can('pins.manage')) return null;
  return (
    <Button size="sm" icon="pin" variant={pinned ? 'primary' : undefined} onClick={async () => {
      try {
        await api.post('/pins', { entity_type: type, entity_id: id, pinned: !pinned });
        onChange?.();
      } catch (err) {
        toast.error(err.message);
      }
    }}>{pinned ? 'Pinned' : 'Pin to overview'}</Button>
  );
}

export function roleLabel(role) {
  return labelOf(ROLES, role);
}
