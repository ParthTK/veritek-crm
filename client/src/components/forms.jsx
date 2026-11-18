// The short forms that carry the daily work. Each one: only the fields needed for the action, prefilled
// where known, validation next to the field, input kept on failure, and a retry that cannot duplicate.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SELECTABLE_PHASES, PHASES, WORK_STATUSES, labelOf } from '@shared/constants.js';
import { zonedToUtc, addWorkingDays } from '@shared/dates.js';
import { lineQty } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSave } from '../lib/hooks.js';
import { date, qty as fmtQty, toLocalInput, todayLocal, tz, relDay } from '../lib/format.js';
import {
  Button, Field, Input, Select, Textarea, Checkbox, Notice, SaveStatus, ConflictNotice, Segmented, Badge,
} from './ui.jsx';
import {
  useMeta, useOptions, OptionSelect, UserSelect, DateField, PurposeInput, ProductSelect, CustomerPicker, FilePick, CommBadge, LineStateBadge,
} from './domain.jsx';

export const fromLocalInput = (v) => (v ? zonedToUtc(v.slice(0, 10), v.slice(11, 16), tz()) : undefined);
const err = (save, k) => save.fields?.[k];

/** "Entering on someone else's behalf?" — reported by and when it actually happened (back-entry is audited). */
function SourceFields({ value, onChange, save, required, showWhen = true, label = 'Reported by' }) {
  const [other, setOther] = useState(Boolean(value.reported_by_name));
  return (
    <div className="form-grid">
      <Field label={label} required={required} error={err(save, 'reported_by_id')} hint={required ? 'Coordinator mode: who gave you this update?' : 'Leave blank if it was you'}>
        {other ? (
          <Input value={value.reported_by_name || ''} placeholder="Name of the person" onChange={(e) => onChange({ reported_by_name: e.target.value, reported_by_id: null })} />
        ) : (
          <UserSelect value={value.reported_by_id} onChange={(v) => onChange({ reported_by_id: v, reported_by_name: '' })} placeholder="Choose the source person…" invalid={Boolean(err(save, 'reported_by_id'))} />
        )}
        <button type="button" className="btn link small" onClick={() => setOther(!other)}>{other ? 'Choose from the list' : 'Not in the list? Type a name'}</button>
      </Field>
      {showWhen && (
        <Field label="When it happened / as of" hint="Defaults to now. Earlier times are kept as back-entries." error={err(save, 'occurred_at') || err(save, 'as_of')}>
          <Input type="datetime-local" value={value.when || ''} max={toLocalInput()} onChange={(e) => onChange({ when: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ follow-up completion
export function FollowupForm({ task, onSaved, contacts = [] }) {
  const meta = useMeta();
  const { user } = useAuth();
  const save = useSave();
  const internal = task.kind === 'internal';
  const [f, setF] = useState({
    outcome: '', channel: internal ? 'internal' : 'phone', note: '', contact_id: '', when: '', reported_by_id: null, reported_by_name: '',
    next_purpose: task.enquiry_id || task.reactivation_case_id ? task.purpose : '', next_date: addWorkingDays(todayLocal(), 2, meta.settings.calendar), next_owner: task.owner_id,
    no_next: false, no_followup_reason: '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const outcomeOpt = useOptions('contact_outcome').find((o) => o.value === f.outcome);
  const enquiryOpen = task.enquiry_id && !['won', 'lost', 'cancelled'].includes(task.enquiry_stage);

  const submit = () => save.run(async (key) => {
    const body = {
      version: task.version, channel: f.channel, outcome: internal ? undefined : f.outcome, note: f.note || undefined, contact_id: f.contact_id || undefined,
      occurred_at: fromLocalInput(f.when), reported_by_id: f.reported_by_id || undefined, reported_by_name: f.reported_by_name || undefined,
      next: f.no_next ? undefined : f.next_purpose || f.next_date ? { purpose: f.next_purpose, due_date: f.next_date, owner_id: f.next_owner } : undefined,
      no_followup_reason: f.no_next ? f.no_followup_reason : undefined,
    };
    const res = await api.post(`/tasks/${task.id}/complete`, body, { key });
    onSaved?.(res);
    return res;
  });

  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ConflictNotice save={save} />
      {!internal && (
        <div className="form-grid">
          <Field label="What happened?" required error={err(save, 'outcome')} className="full">
            <OptionSelect category="contact_outcome" value={f.outcome} onChange={(v) => set({ outcome: v })} invalid={Boolean(err(save, 'outcome'))} placeholder="Choose the outcome…" />
          </Field>
          <Field label="How" error={err(save, 'channel')}>
            <OptionSelect category="channel" value={f.channel} onChange={(v) => set({ channel: v })} exclude={['internal']} />
          </Field>
          <Field label="With" optional>
            <Select value={f.contact_id} onChange={(e) => set({ contact_id: e.target.value })} placeholder="Contact person" options={contacts.map((c) => ({ value: String(c.id), label: c.name || c.phone_raw || c.email_raw }))} />
          </Field>
        </div>
      )}
      <Field label={internal ? 'What was done' : 'Note'} optional={!internal && !outcomeOpt?.requires_note} required={internal || outcomeOpt?.requires_note} error={err(save, 'note')} hint="Keep it short — attach longer documents instead">
        <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} />
      </Field>
      {f.outcome === 'no_answer' && <Notice tone="info">Recorded as a contact attempt — it does not count as a response from the customer.</Notice>}
      {f.outcome === 'order_confirmed' && task.enquiry_id && <Notice tone="info">The enquiry becomes Won once the confirmed order is entered. <Link to={`/enquiries/${task.enquiry_id}`}>Open enquiry {task.enquiry_code}</Link></Notice>}
      {f.outcome === 'not_interested' && task.enquiry_id && <Notice tone="info">If the opportunity is closed, mark the enquiry Lost with its reason. <Link to={`/enquiries/${task.enquiry_id}`}>Open {task.enquiry_code}</Link></Notice>}

      <div className="divider" />
      {!f.no_next && (
        <div className="form-grid">
          <Field label="Next action" className="full" error={err(save, 'next.purpose')}>
            <PurposeInput value={f.next_purpose} onChange={(v) => set({ next_purpose: v })} invalid={Boolean(err(save, 'next.purpose'))} />
          </Field>
          <DateField label="Next date" value={f.next_date} onChange={(v) => set({ next_date: v })} error={err(save, 'next.due_date')} />
          <Field label="Owner" error={err(save, 'next.owner_id')}><UserSelect value={f.next_owner} onChange={(v) => set({ next_owner: v })} /></Field>
        </div>
      )}
      <Checkbox label={enquiryOpen ? 'No further follow-up (record why)' : 'No next action needed'} checked={f.no_next} onChange={(v) => set({ no_next: v })} />
      {f.no_next && enquiryOpen && (
        <Field label="Why no follow-up?" required error={err(save, 'next.purpose')}>
          <Input value={f.no_followup_reason} onChange={(e) => set({ no_followup_reason: e.target.value })} placeholder="e.g. Customer will call when the project restarts" />
        </Field>
      )}
      {['admin', 'coordinator'].includes(user.group) && (
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>Entering on someone else's behalf, or for an earlier time?</summary>
          <div className="mt-8"><SourceFields value={f} onChange={set} save={save} /></div>
        </details>
      )}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <Button type="submit" variant="primary" loading={save.saving} icon="check">{f.no_next ? 'Save outcome' : 'Save & schedule follow-up'}</Button>
      </div>
      <div className="tiny muted">This records what happened. It does not send anything to the customer.</div>
    </form>
  );
}

export function RescheduleForm({ task, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ due_date: task.due_date, reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/reschedule`, { ...f, version: task.version }); onSaved?.(r); return r; }); }}>
      <ConflictNotice save={save} />
      <div className="small muted">Currently due {date(task.due_date)}{task.original_due_date !== task.due_date ? ` (originally ${date(task.original_due_date)})` : ''}. The original date and every change stay visible in history and reports.</div>
      <DateField label="New due date" value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={err(save, 'due_date')} required />
      <Field label="Reason" required error={err(save, 'reason')}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer asked to call after their audit" /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reschedule</Button></div>
    </form>
  );
}

export function ReassignForm({ task, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ owner_id: task.owner_id, reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/reassign`, { ...f, version: task.version }); onSaved?.(r); return r; }); }}>
      <div className="small muted">The due date stays as it is; the previous owner is kept in history.</div>
      <Field label="New owner" required error={err(save, 'owner_id')}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <Field label="Reason" optional><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reassign</Button></div>
    </form>
  );
}

export function CancelTaskForm({ task, onSaved }) {
  const save = useSave();
  const [reason, setReason] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/cancel`, { reason, version: task.version }); onSaved?.(r); return r; }); }}>
      <Notice tone="warn">A cancelled task stays in history and never counts as a completed customer contact.</Notice>
      <Field label="Reason" required error={err(save, 'reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving}>Cancel task</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ production quick update
/**
 * Phase and status only for normal progress. Delay fields appear when an issue is reported or the expected
 * date is beyond the commitment. Ready date and dispatch forecast are labelled separately.
 */
export function ProductionUpdateForm({ line, order, onSaved, compact }) {
  const meta = useMeta();
  const { user, can } = useAuth();
  const save = useSave();
  const q = line.quantities || lineQty(line);
  const coordinatorMode = meta.settings.access.coordinatorMode && ['admin', 'coordinator'].includes(user.group);
  const init = useMemo(() => ({
    phase: line.phase === 'dispatched' ? 'ready' : line.phase, work_status: line.work_status, issue_code: line.issue_code || '', stage_note: line.stage_note || '',
    forecast_ready_date: line.forecast_ready_date || '', forecast_dispatch_date: line.forecast_dispatch_date || '', estimate_unknown: Boolean(line.estimate_unknown),
    ready_qty: line.ready_qty ?? '', ready_reduction_reason: '', hold_review_date: line.hold_review_date || '', note: '',
    action_owner: null, action_due: '', action_purpose: '', reported_by_id: null, reported_by_name: '', when: '', show_issue: Boolean(line.issue_code),
    qc_summary: line.qc_summary || '', share_with_customer: false,
  }), [line]);
  const [f, setF] = useState(init);
  useEffect(() => setF(init), [init]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const late = f.forecast_dispatch_date && line.original_commitment_date && f.forecast_dispatch_date > line.original_commitment_date;
  const backward = SELECTABLE_PHASES.indexOf(f.phase) < SELECTABLE_PHASES.indexOf(line.phase === 'dispatched' ? 'ready' : line.phase);
  const newIssue = f.issue_code && f.issue_code !== (line.issue_code || '');
  const needsAction = (newIssue || (f.estimate_unknown && !line.estimate_unknown)) && !line.action_task_id;
  const issueOpt = useOptions('delay_reason').find((o) => o.value === f.issue_code);
  const disabled = line.needs_clarification;

  const submit = (extra = {}) => save.run(async () => {
    const body = {
      version: line.version, reported_by_id: f.reported_by_id || undefined, reported_by_name: f.reported_by_name || undefined, as_of: fromLocalInput(f.when), note: f.note || undefined,
      phase: f.phase, work_status: f.work_status, stage_note: f.stage_note,
      issue_code: f.show_issue ? f.issue_code || null : line.issue_code ? null : undefined, resolve_issue: !f.show_issue && line.issue_code ? true : undefined,
      forecast_ready_date: f.forecast_ready_date || null, forecast_dispatch_date: f.estimate_unknown ? null : f.forecast_dispatch_date || null, estimate_unknown: f.estimate_unknown,
      ready_qty: f.ready_qty === '' ? undefined : Number(f.ready_qty), ready_reduction_reason: f.ready_reduction_reason || undefined,
      hold_review_date: f.work_status === 'on_hold' ? f.hold_review_date : undefined,
      qc_summary: ['qc', 'ready'].includes(f.phase) && f.qc_summary !== (line.qc_summary || '') ? f.qc_summary : undefined,
      share_with_customer: f.share_with_customer || undefined,
      action: f.action_owner || f.action_due ? { owner_id: f.action_owner, due_date: f.action_due, purpose: f.action_purpose || undefined } : undefined,
      ...extra,
    };
    const res = await api.post(`/order-lines/${line.id}/update`, body);
    onSaved?.(res);
    return res;
  });

  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ConflictNotice save={save} fields={[['phase', 'Phase', (v) => labelOf(PHASES, v)], ['work_status', 'Status', (v) => labelOf(WORK_STATUSES, v)], ['forecast_dispatch_date', 'Dispatch forecast', date], ['source_update_at', 'Last update']]} />
      {save.conflict?.code === 'stale_report' && (
        <div className="row wrap">
          <Button size="sm" onClick={() => submit({ historical: true })}>Record as a historical entry only</Button>
          <Button size="sm" onClick={() => submit({ correction: true })}>Apply as a correction (note required)</Button>
        </div>
      )}
      {disabled && <Notice tone="warn" title="Specification needs clarification">This line cannot move into production until the specification is clarified.</Notice>}
      <div className="form-grid">
        <Field label="Phase" error={err(save, 'phase')}>
          <Select value={f.phase} onChange={(e) => set({ phase: e.target.value })} options={SELECTABLE_PHASES.map((p) => ({ value: p, label: labelOf(PHASES, p), disabled: disabled && p !== 'received' }))} />
        </Field>
        <Field label="Status" error={err(save, 'work_status')}>
          <Select value={f.work_status} onChange={(e) => set({ work_status: e.target.value })} options={WORK_STATUSES} />
        </Field>
      </div>
      {backward && <Notice tone="warn">Moving back a phase (for example QC → Production for rework) needs a short reason in the note below.</Notice>}
      {line.phase === 'qc' && f.phase === 'ready' && !can('qc.pass') && <Notice tone="warn">Only QC (or the coordinator on QC's behalf) can pass a line from QC to ready.</Notice>}
      {['qc', 'ready'].includes(f.phase) && (
        <Field label="QC summary" optional error={err(save, 'qc_summary')} hint="e.g. Accuracy test passed, IR test 500 V OK — shown on the order line">
          <Input value={f.qc_summary} onChange={(e) => set({ qc_summary: e.target.value })} maxLength={300} />
        </Field>
      )}
      {f.work_status === 'on_hold' && (
        <DateField label="Review date for the hold" required value={f.hold_review_date} onChange={(v) => set({ hold_review_date: v })} error={err(save, 'hold_review_date')} />
      )}
      <Checkbox label={line.issue_code ? 'Issue still active (untick to mark it resolved)' : 'Report an issue / delay'} checked={f.show_issue} onChange={(v) => set({ show_issue: v, issue_code: v ? f.issue_code : '' })} />
      {(f.show_issue || late) && (
        <div className="form-grid">
          <Field label="Delay reason" required={f.show_issue} error={err(save, 'issue_code')}>
            <OptionSelect category="delay_reason" value={f.issue_code} onChange={(v) => set({ issue_code: v, show_issue: Boolean(v) || f.show_issue })} placeholder="Choose a broad reason…" />
          </Field>
          <Field label="Stage / note" optional={!issueOpt?.requires_note} required={issueOpt?.requires_note} error={err(save, 'stage_note')} hint='e.g. "Waiting for displays"'>
            <Input value={f.stage_note} onChange={(e) => set({ stage_note: e.target.value })} maxLength={300} />
          </Field>
        </div>
      )}
      <div className="form-grid">
        <DateField label="Expected ready date" value={f.forecast_ready_date} onChange={(v) => set({ forecast_ready_date: v, forecast_dispatch_date: f.forecast_dispatch_date && v > f.forecast_dispatch_date ? v : f.forecast_dispatch_date })} error={err(save, 'forecast_ready_date')} presets={false} />
        <Field label="Dispatch forecast" error={err(save, 'forecast_dispatch_date')} hint={`Original promise ${date(line.original_commitment_date) || 'not committed'}`}>
          <Input type="date" value={f.estimate_unknown ? '' : f.forecast_dispatch_date} disabled={f.estimate_unknown} onChange={(e) => set({ forecast_dispatch_date: e.target.value })} />
          <Checkbox label="Estimate unknown" checked={f.estimate_unknown} onChange={(v) => set({ estimate_unknown: v })} />
        </Field>
      </div>
      {late && <Notice tone="warn">This forecast is after the original commitment ({date(line.original_commitment_date)}). The sales owner gets a task to inform the customer — the customer has not agreed to it yet.</Notice>}
      {(needsAction || f.show_issue || f.estimate_unknown) && (
        <div className="form-grid">
          <Field label="Next action owner" required={needsAction} error={err(save, 'action.owner_id')} hint={line.action_task_id ? 'An action is already open — add another only if needed' : 'A named person, not just a department'}>
            <UserSelect value={f.action_owner} onChange={(v) => set({ action_owner: v })} invalid={Boolean(err(save, 'action.owner_id'))} />
          </Field>
          <DateField label="Action due" required={needsAction} value={f.action_due} onChange={(v) => set({ action_due: v })} error={err(save, 'action.due_date')} />
          <Field label="Action" optional className="full"><Input value={f.action_purpose} onChange={(e) => set({ action_purpose: e.target.value })} placeholder={f.estimate_unknown ? 'Obtain revised estimate' : 'e.g. Confirm display delivery date'} /></Field>
        </div>
      )}
      <div className="form-grid">
        <Field label="Total quantity ready now" optional hint={`Includes the ${fmtQty(q.dispatched)} already dispatched · max ${fmtQty(q.confirmed - q.cancelled)}`} error={err(save, 'ready_qty')}>
          <Input type="number" min={0} step="any" value={f.ready_qty} onChange={(e) => set({ ready_qty: e.target.value })} />
        </Field>
        {line.ready_qty !== null && f.ready_qty !== '' && Number(f.ready_qty) < line.ready_qty && (
          <Field label="Reason for the lower ready total" required error={err(save, 'ready_reduction_reason')}><Input value={f.ready_reduction_reason} onChange={(e) => set({ ready_reduction_reason: e.target.value })} placeholder="Correction or rework" /></Field>
        )}
      </div>
      <Field label="Note" optional={!backward} required={backward} error={err(save, 'note')}><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
      {f.note && <Checkbox label="Share this note with the customer on their tracking page" checked={f.share_with_customer} onChange={(v) => set({ share_with_customer: v })} />}
      <SourceFields value={f} onChange={set} save={save} required={coordinatorMode} />
      <div className="row between wrap">
        <SaveStatus save={save} />
        <div className="row wrap">
          <Button onClick={() => submit({ still_on_track: true, phase: undefined, work_status: undefined, stage_note: undefined, forecast_ready_date: undefined, forecast_dispatch_date: undefined, estimate_unknown: undefined, issue_code: undefined, resolve_issue: undefined })} loading={save.saving} title="Confirms the line is on track without other changes">No change — still on track</Button>
          <Button type="submit" variant="cta" loading={save.saving}>Save update</Button>
        </div>
      </div>
      {save.savedAt && save.error === null && compact && <div className="tiny muted">An unchanged save does not count as fresh production information.</div>}
    </form>
  );
}

// ------------------------------------------------------------------ customer communication
export function CommunicationForm({ order, lines, contacts = [], onSaved }) {
  const save = useSave();
  const pending = lines.filter((l) => l.comm?.state === 'pending').map((l) => l.id);
  const active = lines.filter((l) => l.status?.active);
  const [f, setF] = useState({
    line_ids: pending.length ? pending : active.map((l) => l.id), channel: 'phone', contact_id: order.contact_id ? String(order.contact_id) : '', outcome: '', agreed_date: '', note: '', when: '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const toggle = (id) => set({ line_ids: f.line_ids.includes(id) ? f.line_ids.filter((x) => x !== id) : [...f.line_ids, id] });
  const accepted = f.outcome === 'accepted_revised_date';
  const latest = active.filter((l) => f.line_ids.includes(l.id)).map((l) => l.forecast_dispatch_date).filter(Boolean).sort().at(-1);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => {
      const r = await api.post(`/orders/${order.id}/communications`, { ...f, contact_id: f.contact_id || undefined, agreed_date: f.agreed_date || undefined, occurred_at: fromLocalInput(f.when) }, { key });
      onSaved?.(r);
      return r;
    }); }}>
      <Notice tone="info">Record a conversation that actually happened. Creating a task or saving a tracking number does not inform the customer.</Notice>
      <Field label="Lines discussed" error={err(save, 'line_ids')}>
        <div className="stack-xs">
          {active.map((l) => (
            <label key={l.id} className="check">
              <input type="checkbox" checked={f.line_ids.includes(l.id)} onChange={() => toggle(l.id)} />
              <span>Line {l.line_no}: {l.product} — promised {date(l.original_commitment_date)}, now {l.estimate_unknown ? 'estimate unknown' : date(l.forecast_dispatch_date)} <CommBadge state={l.comm?.state} size="sm" /></span>
            </label>
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label="How" required error={err(save, 'channel')}><OptionSelect category="channel" value={f.channel} onChange={(v) => set({ channel: v })} exclude={['internal']} /></Field>
        <Field label="With" optional><Select value={f.contact_id} onChange={(e) => set({ contact_id: e.target.value })} placeholder="Contact person" options={contacts.map((c) => ({ value: String(c.id), label: c.name || c.phone_raw || c.email_raw }))} /></Field>
        <Field label="Customer response" required error={err(save, 'outcome')} className="full"><OptionSelect category="customer_update_outcome" value={f.outcome} onChange={(v) => set({ outcome: v, agreed_date: v === 'accepted_revised_date' && !f.agreed_date ? latest || '' : f.agreed_date })} /></Field>
        {accepted && <DateField label="Date the customer agreed" required value={f.agreed_date} onChange={(v) => set({ agreed_date: v })} error={err(save, 'agreed_date')} presets={false} hint="Stored as a separate agreed revision — the original promise is kept" />}
        <Field label="What was said" optional className="full" error={err(save, 'note')}><Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
        <Field label="When" hint="Defaults to now"><Input type="datetime-local" value={f.when} max={toLocalInput()} onChange={(e) => set({ when: e.target.value })} /></Field>
      </div>
      {f.outcome === 'customer_cancelled' && <Notice tone="warn">Also record the cancellation against the affected quantity on the order line.</Notice>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Record customer update</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ dispatch
export function DispatchForm({ customerId: fixedCustomer, orderId, onSaved }) {
  const { can } = useAuth();
  const save = useSave();
  const [customer, setCustomer] = useState(fixedCustomer ? { id: fixedCustomer } : null);
  const [lines, setLines] = useState(null);
  const [qtys, setQtys] = useState({});
  const [f, setF] = useState({
    mode: 'now', dispatch_date: todayLocal(), planned_date: '', reference: '', carrier: '', tracking_no: '', tracking_url: '', vehicle_number: '', eway_bill: '', boxes: '', weight_kg: '',
    expected_arrival: '', invoice_ref: '', notes: '', override_reason: '', doc: null,
  });
  const [posted, setPosted] = useState(null);
  const planned = f.mode === 'plan';
  useEffect(() => {
    if (!customer?.id) return;
    api.get('/order-lines/options', { customer_id: customer.id }).then((rows) => setLines(orderId ? rows.filter((r) => r.order_id === orderId).concat(rows.filter((r) => r.order_id !== orderId)) : rows));
  }, [customer?.id, orderId]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const chosen = (lines || []).filter((l) => Number(qtys[l.id]) > 0);
  const notReady = !planned && chosen.some((l) => Number(qtys[l.id]) > (l.quantities.readyNotDispatched ?? 0));
  if (posted?.status === 'planned') {
    return (
      <div className="stack-sm">
        <Notice tone="success" title={`Dispatch ${posted.code} planned`}>Nothing is deducted until it is posted as actually dispatched. Post it from the dispatch register once it leaves.</Notice>
        <div><Button variant="primary" onClick={() => onSaved?.(posted)}>Done</Button></div>
      </div>
    );
  }
  if (posted) return <DispatchNotify dispatch={posted} onDone={() => onSaved?.(posted)} />;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => {
      const r = await api.post('/dispatches', {
        lines: chosen.map((l) => ({ line_id: l.id, qty: Number(qtys[l.id]) })), planned: planned || undefined, dispatch_date: planned ? undefined : f.dispatch_date, planned_date: planned ? f.planned_date : undefined,
        reference: f.reference, carrier: f.carrier, tracking_no: f.tracking_no, tracking_url: f.tracking_url || undefined, vehicle_number: f.vehicle_number, eway_bill: f.eway_bill,
        boxes: f.boxes === '' ? undefined : f.boxes, weight_kg: f.weight_kg === '' ? undefined : f.weight_kg,
        expected_arrival: f.expected_arrival || undefined, invoice_ref: f.invoice_ref, notes: f.notes, override_reason: f.override_reason || undefined, document_id: f.doc?.id,
      }, { key });
      setPosted(r);
      return r;
    }); }}>
      <Segmented label="Dispatch type" value={f.mode} onChange={(mode) => set({ mode })} options={[{ value: 'now', label: 'Dispatched now' }, { value: 'plan', label: 'Plan a dispatch' }]} />
      {planned && <div className="small muted">A plan reserves nothing and changes no balance. Post it once the goods have actually left.</div>}
      {!fixedCustomer && <Field label="Customer" required><CustomerPicker value={customer} onChange={setCustomer} allowCreate={false} onNewCustomer={() => {}} /></Field>}
      {customer?.id && !lines && <div className="muted small">Loading open lines…</div>}
      {lines && !lines.length && <Notice tone="info">No active order lines with a remaining balance for this customer.</Notice>}
      {lines?.length > 0 && (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Order / line</th><th className="num">Remaining</th><th className="num">Ready, not sent</th><th>Promised</th><th className="num" style={{ width: 120 }}>{planned ? 'Plan to send' : 'Dispatch now'}</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.order_code}</strong> · {l.product}<div className="sub">Line {l.line_no} <LineStateBadge state={l.status.state} daysLate={l.status.daysLate} size="sm" /></div></td>
                  <td className="num">{fmtQty(l.quantities.remaining, l.unit)}</td>
                  <td className="num">{l.quantities.readyNotDispatched === null ? <span className="muted" title="Readiness not recorded">unknown</span> : fmtQty(l.quantities.readyNotDispatched)}</td>
                  <td>{date(l.original_commitment_date)}</td>
                  <td className="num">
                    <Input type="number" min={0} max={l.quantities.remaining} step="any" value={qtys[l.id] ?? ''} invalid={Boolean(save.fields[`lines.${chosen.indexOf(l)}.qty`])} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} aria-label={`Quantity for ${l.order_code} line ${l.line_no}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {Object.entries(save.fields).filter(([k]) => k.startsWith('lines')).map(([k, v]) => <Notice key={k} tone="danger">{v}</Notice>)}
      <div className="form-grid">
        {planned ? (
          <Field label="Planned dispatch date" required error={err(save, 'planned_date')}>
            <Input type="date" min={todayLocal()} value={f.planned_date} onChange={(e) => set({ planned_date: e.target.value })} />
          </Field>
        ) : (
          <Field label="Actual dispatch date" required error={err(save, 'dispatch_date')} hint="Only an actual dispatch reduces the balance — not a plan">
            <Input type="date" max={todayLocal()} value={f.dispatch_date} onChange={(e) => set({ dispatch_date: e.target.value })} />
          </Field>
        )}
        <Field label="Packing / dispatch ref" optional><Input value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></Field>
        <Field label="Carrier" optional><Input value={f.carrier} onChange={(e) => set({ carrier: e.target.value })} /></Field>
        <Field label="Tracking / LR / AWB" optional><Input value={f.tracking_no} onChange={(e) => set({ tracking_no: e.target.value })} /></Field>
        <Field label="Tracking link" optional error={err(save, 'tracking_url')}><Input value={f.tracking_url} onChange={(e) => set({ tracking_url: e.target.value })} placeholder="https://" /></Field>
        <Field label="Vehicle number" optional><Input value={f.vehicle_number} onChange={(e) => set({ vehicle_number: e.target.value })} /></Field>
        <Field label="E-way bill" optional><Input value={f.eway_bill} onChange={(e) => set({ eway_bill: e.target.value })} /></Field>
        <Field label="Boxes" optional error={err(save, 'boxes')}><Input type="number" min={0} value={f.boxes} onChange={(e) => set({ boxes: e.target.value })} /></Field>
        <Field label="Weight (kg)" optional error={err(save, 'weight_kg')}><Input type="number" min={0} step="any" value={f.weight_kg} onChange={(e) => set({ weight_kg: e.target.value })} /></Field>
        <Field label="Expected arrival" optional><Input type="date" value={f.expected_arrival} onChange={(e) => set({ expected_arrival: e.target.value })} /></Field>
        <Field label="Invoice reference" optional><Input value={f.invoice_ref} onChange={(e) => set({ invoice_ref: e.target.value })} /></Field>
        <Field label="Proof / document" optional className="full"><FilePick value={f.doc} onChange={(doc) => set({ doc })} label="Attach LR / packing list" /></Field>
      </div>
      {notReady && (
        <Field label="Reason to dispatch quantity not recorded as ready" required error={err(save, 'override_reason')} hint={can('dispatch.override') ? 'Allowed for the coordinator and management' : 'Only the coordinator or management can override'}>
          <Input value={f.override_reason} onChange={(e) => set({ override_reason: e.target.value })} placeholder="e.g. Readiness not reported for older stock" />
        </Field>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={planned ? 'primary' : 'cta'} loading={save.saving} disabled={!chosen.length}>{planned ? 'Save plan' : 'Post dispatch'}</Button></div>
    </form>
  );
}

/** After posting: has the customer been told? Left pending unless a real contact is recorded. */
export function DispatchNotify({ dispatch, onDone }) {
  const save = useSave();
  const [channel, setChannel] = useState('email');
  return (
    <div className="stack-sm">
      <Notice tone="success" title={`Dispatch ${dispatch.code} posted`}>Remaining quantities have been recalculated.</Notice>
      <div className="strong">Has the customer been told about this dispatch?</div>
      <div className="small muted">A saved tracking number alone does not prove the customer was informed.</div>
      <div className="row wrap">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'phone', label: 'Phone call' }]} />
        <Button variant="primary" loading={save.saving} onClick={() => save.run(async () => { await api.post(`/dispatches/${dispatch.id}/notify`, { channel }); onDone(); })}>Yes — record it</Button>
        <Button onClick={onDone}>Not yet — leave pending</Button>
      </div>
      <SaveStatus save={save} />
    </div>
  );
}

// ------------------------------------------------------------------ cancellation
export function CancelQtyForm({ line, onSaved }) {
  const save = useSave();
  const q = line.quantities || lineQty(line);
  const [f, setF] = useState({ qty: q.remaining, reason_code: '', note: '', requested_source: 'customer', requested_by_name: '' });
  const reason = useOptions('cancel_reason').find((o) => o.value === f.reason_code);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => { const r = await api.post(`/order-lines/${line.id}/cancel`, { ...f, version: line.version }, { key }); onSaved?.(r); return r; }); }}>
      <ConflictNotice save={save} />
      <div className="small muted">Only the remaining {fmtQty(q.remaining, line.unit)} can be cancelled. Dispatched quantity ({fmtQty(q.dispatched)}) is never erased — returns are recorded separately.</div>
      <div className="form-grid">
        <Field label="Quantity to cancel" required error={err(save, 'qty')}><Input type="number" min={0} max={q.remaining} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Requested by" required>
          <Segmented value={f.requested_source} onChange={(v) => setF({ ...f, requested_source: v })} options={[{ value: 'customer', label: 'Customer' }, { value: 'internal', label: 'Internal' }]} />
        </Field>
        <Field label="Reason" required error={err(save, 'reason_code')} className="full"><OptionSelect category="cancel_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>
        <Field label="Note" optional={!reason?.requires_note} required={reason?.requires_note} error={err(save, 'note')} className="full"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving}>Cancel quantity</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ fast enquiry capture
const emptyLine = () => ({ product_id: null, requirement: '', spec: '', qty: '', unit: 'pcs' });
export function newEnquiryDraft(user, meta) {
  return {
    customer: null, new_customer: null, contact_id: '', lines: [emptyLine()], source_code: '', source_event: '', campaign_id: '', owner_id: user.group === 'sales' ? user.id : null,
    next_purpose: 'Respond to enquiry', next_date: addWorkingDays(todayLocal(), meta.settings.rules.enquiryResponseWorkingDays, meta.settings.calendar),
    note: '', received: '', doc: null, confirm_not_duplicate: false,
  };
}

/**
 * Single-page enquiry capture: customer (search or quick-create with phone OR email), product lines (known
 * model or "Unspecified" with a short requirement; quantity may be unknown), source, owner and next action.
 */
export function EnquiryForm({ draft, onChange, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const [contacts, setContacts] = useState([]);
  const d = draft;
  const set = (patch) => onChange({ ...d, ...patch });
  const setLine = (i, patch) => set({ lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  useEffect(() => {
    if (!d.customer?.id) {
      setContacts([]);
      return;
    }
    api.get(`/customers/${d.customer.id}`).then((p) => {
      setContacts(p.contacts.filter((c) => c.active));
      if (!d.contact_id) {
        const primary = p.contacts.find((c) => c.is_primary && c.active) || p.contacts[0];
        if (primary) onChange({ ...d, contact_id: String(primary.id), owner_id: d.owner_id || p.customer.owner_id });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.customer?.id]);
  const sourceOpt = useOptions('enquiry_source').find((o) => o.value === d.source_code);
  const exhibitions = meta.campaigns.filter((c) => c.type === 'exhibition');
  const otherEvents = meta.campaigns.filter((c) => c.type !== 'exhibition');
  const pickCampaign = (value) => set({ campaign_id: value, source_event: meta.campaigns.find((c) => String(c.id) === value)?.name || '' });
  const dup = save.error?.code === 'possible_duplicate' ? save.error.details.matches : null;

  const submit = (confirmNotDuplicate = false) => save.run(async (key) => {
    const nc = d.new_customer;
    const body = {
      customer_id: d.customer?.id, contact_id: d.contact_id || undefined,
      new_customer: !d.customer?.id && nc ? {
        company_name: nc.company_name, country_code: nc.country_code, city: nc.city, provisional: nc.provisional, confirm_not_duplicate: confirmNotDuplicate || undefined,
        contacts: [{ name: nc.contact_name, phone: nc.phone, email: nc.email }],
      } : undefined,
      lines: d.lines.map((l) => ({ product_id: l.product_id, requirement: l.product_id ? undefined : l.requirement || 'Unspecified / needs clarification', spec: l.spec, qty: l.qty === '' ? null : Number(l.qty), unit: l.unit })),
      source_code: d.source_code, source_event: d.source_event, campaign_id: ['exhibition', 'campaign'].includes(d.source_code) ? d.campaign_id || undefined : undefined, owner_id: d.owner_id, requirement_note: d.note, received_at: fromLocalInput(d.received),
      next: { purpose: d.next_purpose, owner_id: d.owner_id, due_date: d.next_date }, attachment_ids: d.doc ? [d.doc.id] : undefined,
    };
    const res = await api.post('/enquiries', body, { key });
    onSaved?.(res);
    return res;
  });
  const missing = [
    ...d.lines.flatMap((l, i) => [!l.product_id && `line ${i + 1}: product to clarify`, l.qty === '' && `line ${i + 1}: quantity unknown`]).filter(Boolean),
  ];

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <Field label="Customer / company" required error={err(save, 'customer_id') || err(save, 'contacts')}>
        <CustomerPicker value={d.customer} onChange={(c) => onChange({ ...d, customer: c, contact_id: '', new_customer: c ? null : d.new_customer })} newCustomer={d.new_customer} onNewCustomer={(nc) => onChange({ ...d, new_customer: nc, customer: nc ? null : d.customer })} invalid={Boolean(err(save, 'customer_id'))} />
      </Field>
      {dup && (
        <div className="match-card" role="alert">
          <div className="strong small">This may be an existing customer:</div>
          {dup.map((m) => (
            <div key={m.id} className="row between mt-8"><span className="small"><strong>{m.company_name}</strong> — {m.reasons.join('; ')}</span>
              <Button size="xs" onClick={() => { onChange({ ...d, customer: { id: m.id, company_name: m.company_name }, new_customer: null }); save.reset(); }}>Use this customer</Button></div>
          ))}
          <Button size="sm" className="mt-8" onClick={() => submit(true)}>It is a different company — create it</Button>
        </div>
      )}
      {d.customer?.id && contacts.length > 0 && (
        <Field label="Contact"><Select value={d.contact_id} onChange={(e) => set({ contact_id: e.target.value })} options={contacts.map((c) => ({ value: String(c.id), label: [c.name, c.phone_raw, c.email_raw].filter(Boolean).join(' · ') }))} /></Field>
      )}
      <div className="stack-sm">
        <div className="strong small">Products / requirement</div>
        {d.lines.map((l, i) => (
          <div key={i} className="form-grid three" style={{ alignItems: 'end' }}>
            <Field label={`Product ${d.lines.length > 1 ? i + 1 : ''}`} error={err(save, `lines.${i}.product_id`)}><ProductSelect value={l.product_id} onChange={(v) => setLine(i, { product_id: v })} /></Field>
            {!l.product_id ? (
              <Field label="Requirement" hint="Short description" error={err(save, `lines.${i}.requirement`)}><Input value={l.requirement} onChange={(e) => setLine(i, { requirement: e.target.value })} placeholder="e.g. meters for 3 panels" /></Field>
            ) : (
              <Field label="Variant / specification" optional><Input value={l.spec} onChange={(e) => setLine(i, { spec: e.target.value })} /></Field>
            )}
            <Field label="Quantity" optional hint="Leave blank if not known yet" error={err(save, `lines.${i}.qty`)}>
              <div className="row"><Input type="number" min={0} step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /><OptionSelect category="unit" value={l.unit} onChange={(v) => setLine(i, { unit: v })} />
                {d.lines.length > 1 && <Button size="sm" variant="ghost" icon="trash" aria-label="Remove line" onClick={() => set({ lines: d.lines.filter((_, j) => j !== i) })} />}</div>
            </Field>
          </div>
        ))}
        <div><Button size="sm" icon="plus" onClick={() => set({ lines: [...d.lines, emptyLine()] })}>Add another product</Button></div>
      </div>
      <div className="form-grid">
        <Field label="Source" required error={err(save, 'source_code')}><OptionSelect category="enquiry_source" value={d.source_code} onChange={(v) => set({ source_code: v, campaign_id: '', source_event: '' })} /></Field>
        {d.source_code === 'exhibition' ? (
          <Field label="Exhibition" required error={err(save, 'campaign_id')} hint={exhibitions.length ? 'The enquiry counts towards this exhibition' : 'No exhibitions yet — add one under Exhibitions first'}>
            <Select value={d.campaign_id} onChange={(e) => pickCampaign(e.target.value)} placeholder="Choose the exhibition" options={exhibitions.map((c) => ({ value: String(c.id), label: c.name }))} invalid={Boolean(err(save, 'campaign_id'))} />
          </Field>
        ) : d.source_code === 'campaign' && otherEvents.length > 0 ? (
          <Field label="Event" optional error={err(save, 'campaign_id')} hint="Counts towards the event's results"><Select value={d.campaign_id} onChange={(e) => pickCampaign(e.target.value)} placeholder="Choose the event" options={otherEvents.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
        ) : (
          <Field label="Source detail" optional={!sourceOpt?.requires_note} required={sourceOpt?.requires_note} error={err(save, 'source_event')}><Input value={d.source_event} onChange={(e) => set({ source_event: e.target.value })} /></Field>
        )}
        <Field label="Owner" required error={err(save, 'owner_id')}><UserSelect value={d.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} invalid={Boolean(err(save, 'owner_id'))} /></Field>
        <Field label="Next action" error={err(save, 'next.purpose')}><PurposeInput value={d.next_purpose} onChange={(v) => set({ next_purpose: v })} /></Field>
        <DateField label="Next action date" value={d.next_date} onChange={(v) => set({ next_date: v })} error={err(save, 'next.due_date')} />
        <Field label="Received" hint="Defaults to now" error={err(save, 'received_at')}><Input type="datetime-local" value={d.received} max={toLocalInput()} onChange={(e) => set({ received: e.target.value })} /></Field>
        <Field label="Note" optional className="full" error={err(save, 'requirement_note')}><Textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} placeholder="Paste the message or call note" /></Field>
        <Field label="Attachment" optional className="full"><FilePick value={d.doc} onChange={(doc) => set({ doc })} label="Attach message, photo or specification" /></Field>
      </div>
      {missing.length > 0 && <div className="small muted"><Icon14 /> Saved as provisional detail — {missing.join(', ')}. This stays visible until clarified.</div>}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <Button type="submit" variant="primary" loading={save.saving} icon="check">Save enquiry</Button>
      </div>
      <div className="tiny muted">The system fills in the enquiry number, entry time, customer history link, status “New” and the follow-up reminder.</div>
    </form>
  );
}

function Icon14() {
  return <Badge size="sm" tone="amber">Missing</Badge>;
}

export { relDay };
