// The short forms that carry the daily work: only what the action needs, with sensible defaults for the rest.
import { useEffect, useMemo, useState } from 'react';
import { SELECTABLE_PHASES, PHASES, WORK_STATUSES, labelOf } from '@shared/constants.js';
import { zonedToUtc, addWorkingDays } from '@shared/dates.js';
import { fromMinor, lineQty, round3 } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSave } from '../lib/hooks.js';
import { date, qty as fmtQty, todayLocal, tz, relDay } from '../lib/format.js';
import {
  Button, Field, Input, Select, Textarea, Checkbox, Notice, SaveStatus, ConflictNotice,
} from './ui.jsx';
import {
  useMeta, useOptions, OptionSelect, UserSelect, DateField, PurposeInput, ProductSelect, CustomerPicker,
} from './domain.jsx';

export const fromLocalInput = (v) => (v ? zonedToUtc(v.slice(0, 10), v.slice(11, 16), tz()) : undefined);
const err = (save, k) => save.fields?.[k];

// ------------------------------------------------------------------ follow-up
export function FollowupForm({ task, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const internal = task.kind === 'internal';
  const [f, setF] = useState({
    outcome: '', channel: internal ? 'internal' : 'phone', note: '',
    next_purpose: task.enquiry_id || task.reactivation_case_id ? task.purpose : '', next_date: addWorkingDays(todayLocal(), 2, meta.settings.calendar),
    no_next: false, no_followup_reason: '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const outcomeOpt = useOptions('contact_outcome').find((o) => o.value === f.outcome);
  const enquiryOpen = task.enquiry_id && !['won', 'lost', 'cancelled'].includes(task.enquiry_stage);

  const submit = () => save.run(async (key) => {
    const res = await api.post(`/tasks/${task.id}/complete`, {
      version: task.version, channel: f.channel, outcome: internal ? undefined : f.outcome, note: f.note || undefined,
      next: f.no_next ? undefined : f.next_purpose || f.next_date ? { purpose: f.next_purpose, due_date: f.next_date, owner_id: task.owner_id } : undefined,
      no_followup_reason: f.no_next ? f.no_followup_reason : undefined,
    }, { key });
    onSaved?.(res);
    return res;
  });

  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ConflictNotice save={save} />
      {!internal && (
        <div className="form-grid">
          <Field label="What happened?" required error={err(save, 'outcome')}>
            <OptionSelect category="contact_outcome" value={f.outcome} onChange={(v) => set({ outcome: v })} invalid={Boolean(err(save, 'outcome'))} />
          </Field>
          <Field label="How" error={err(save, 'channel')}>
            <OptionSelect category="channel" value={f.channel} onChange={(v) => set({ channel: v })} exclude={['internal']} />
          </Field>
        </div>
      )}
      <Field label={internal ? 'What was done' : 'Note'} optional={!internal && !outcomeOpt?.requires_note} required={internal || outcomeOpt?.requires_note} error={err(save, 'note')}>
        <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} />
      </Field>
      {!f.no_next && (
        <div className="form-grid">
          <Field label="Next action" error={err(save, 'next.purpose')}>
            <PurposeInput value={f.next_purpose} onChange={(v) => set({ next_purpose: v })} invalid={Boolean(err(save, 'next.purpose'))} />
          </Field>
          <DateField label="Next date" value={f.next_date} onChange={(v) => set({ next_date: v })} error={err(save, 'next.due_date')} />
        </div>
      )}
      <Checkbox label="No further follow-up" checked={f.no_next} onChange={(v) => set({ no_next: v })} />
      {f.no_next && enquiryOpen && (
        <Field label="Why?" required error={err(save, 'next.purpose')}>
          <Input value={f.no_followup_reason} onChange={(e) => set({ no_followup_reason: e.target.value })} placeholder="e.g. Customer will call when the project restarts" />
        </Field>
      )}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <Button type="submit" variant="primary" loading={save.saving} icon="check">Save</Button>
      </div>
    </form>
  );
}

export function RescheduleForm({ task, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ due_date: task.due_date, reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/reschedule`, { ...f, version: task.version }); onSaved?.(r); return r; }); }}>
      <ConflictNotice save={save} />
      <DateField label="New date" value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={err(save, 'due_date')} required />
      <Field label="Reason" required error={err(save, 'reason')}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Customer asked to call next week" /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reschedule</Button></div>
    </form>
  );
}

export function ReassignForm({ task, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ owner_id: task.owner_id, reason: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/reassign`, { ...f, version: task.version }); onSaved?.(r); return r; }); }}>
      <Field label="Assign to" required error={err(save, 'owner_id')}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reassign</Button></div>
    </form>
  );
}

export function CancelTaskForm({ task, onSaved }) {
  const save = useSave();
  const [reason, setReason] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/tasks/${task.id}/cancel`, { reason, version: task.version }); onSaved?.(r); return r; }); }}>
      <Field label="Reason" required error={err(save, 'reason')}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving}>Cancel follow-up</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ production update
/** Stage, expected dispatch date and how many are ready; a delay reason only when there is a delay. */
export function ProductionUpdateForm({ line, onSaved }) {
  const meta = useMeta();
  const { user, can } = useAuth();
  const save = useSave();
  const q = line.quantities || lineQty(line);
  const init = useMemo(() => ({
    phase: line.phase === 'dispatched' ? 'ready' : line.phase, issue_code: line.issue_code || '', stage_note: line.stage_note || '',
    forecast_dispatch_date: line.forecast_dispatch_date || '', ready_qty: line.ready_qty ?? '', ready_reduction_reason: '', note: '', delayed: Boolean(line.issue_code),
  }), [line]);
  const [f, setF] = useState(init);
  useEffect(() => setF(init), [init]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const late = f.forecast_dispatch_date && line.original_commitment_date && f.forecast_dispatch_date > line.original_commitment_date;
  const backward = SELECTABLE_PHASES.indexOf(f.phase) < SELECTABLE_PHASES.indexOf(line.phase === 'dispatched' ? 'ready' : line.phase);
  const newIssue = f.delayed && f.issue_code && f.issue_code !== (line.issue_code || '');
  const issueOpt = useOptions('delay_reason').find((o) => o.value === f.issue_code);
  const blocked = line.needs_clarification;

  const submit = () => save.run(async () => {
    const res = await api.post(`/order-lines/${line.id}/update`, {
      version: line.version, reported_by_id: user.id, note: f.note || undefined, phase: f.phase, stage_note: f.delayed ? f.stage_note : undefined,
      issue_code: f.delayed ? f.issue_code || null : line.issue_code ? null : undefined, resolve_issue: !f.delayed && line.issue_code ? true : undefined,
      forecast_dispatch_date: f.forecast_dispatch_date || null, ready_qty: f.ready_qty === '' ? undefined : Number(f.ready_qty), ready_reduction_reason: f.ready_reduction_reason || undefined,
      // A new delay gets an owner straight away: whoever reported it, to look at it on the next working day.
      action: newIssue && !line.action_task_id ? { owner_id: user.id, due_date: addWorkingDays(todayLocal(), 1, meta.settings.calendar), purpose: `Resolve delay: ${issueOpt?.label || 'production'}` } : undefined,
    });
    onSaved?.(res);
    return res;
  });

  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ConflictNotice save={save} fields={[['phase', 'Stage', (v) => labelOf(PHASES, v)], ['work_status', 'Status', (v) => labelOf(WORK_STATUSES, v)], ['forecast_dispatch_date', 'Expected dispatch', date]]} />
      {blocked && <Notice tone="warn">Confirm the specification on the order before this goes into production.</Notice>}
      <div className="form-grid">
        <Field label="Stage" error={err(save, 'phase')}>
          {/* Ready means all of it is built, unless a smaller quantity is typed: without a ready quantity, Dispatch would need an override to send it. */}
          <Select value={f.phase} onChange={(e) => set({ phase: e.target.value, ...(e.target.value === 'ready' && f.ready_qty === '' ? { ready_qty: String(round3(q.confirmed - q.cancelled)) } : {}) })} options={SELECTABLE_PHASES.map((p) => ({ value: p, label: labelOf(PHASES, p), disabled: blocked && p !== 'received' }))} />
        </Field>
        <Field label="Expected dispatch" error={err(save, 'forecast_dispatch_date')} hint={line.original_commitment_date ? `Promised ${date(line.original_commitment_date)}` : 'No date promised yet'}>
          <Input type="date" value={f.forecast_dispatch_date} onChange={(e) => set({ forecast_dispatch_date: e.target.value })} />
        </Field>
        <Field label="Quantity ready" optional hint={`Out of ${fmtQty(q.confirmed - q.cancelled)}`} error={err(save, 'ready_qty')}>
          <Input type="number" min={0} step="any" value={f.ready_qty} onChange={(e) => set({ ready_qty: e.target.value })} />
        </Field>
        {line.ready_qty !== null && f.ready_qty !== '' && Number(f.ready_qty) < line.ready_qty && (
          <Field label="Why fewer than before?" required error={err(save, 'ready_reduction_reason')}><Input value={f.ready_reduction_reason} onChange={(e) => set({ ready_reduction_reason: e.target.value })} /></Field>
        )}
      </div>
      {line.phase === 'qc' && f.phase === 'ready' && !can('qc.pass') && <Notice tone="warn">Only Quality can pass a line from QC to ready.</Notice>}
      <Checkbox label="There is a delay" checked={f.delayed} onChange={(v) => set({ delayed: v, issue_code: v ? f.issue_code : '' })} />
      {f.delayed && (
        <div className="form-grid">
          <Field label="Reason" required error={err(save, 'issue_code')}><OptionSelect category="delay_reason" value={f.issue_code} onChange={(v) => set({ issue_code: v })} /></Field>
          <Field label="Detail" optional={!issueOpt?.requires_note} required={issueOpt?.requires_note} error={err(save, 'stage_note')}><Input value={f.stage_note} onChange={(e) => set({ stage_note: e.target.value })} maxLength={300} placeholder="e.g. Waiting for displays" /></Field>
        </div>
      )}
      {err(save, 'action.owner_id') && <Notice tone="danger">{err(save, 'action.owner_id')}</Notice>}
      {late && <div className="small warning-text">This is after the promised date.</div>}
      <Field label="Note" optional={!backward} required={backward} error={err(save, 'note')} hint={backward ? 'Say why it is moving back' : undefined}><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
      <div className="row between wrap">
        <SaveStatus save={save} />
        <Button type="submit" variant="cta" loading={save.saving}>Save update</Button>
      </div>
    </form>
  );
}

/** Marks what is left on an order as ready for dispatch, item by item, with the quantity ready. */
export function ReadyForm({ lines, onSaved }) {
  const { user } = useAuth();
  const open = lines.filter((l) => l.status?.active !== false && l.quantities.remaining > 0);
  const [qty, setQty] = useState(() => Object.fromEntries(open.map((l) => [l.id, String(round3(l.quantities.confirmed - l.quantities.cancelled))])));
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    const failed = {};
    const saved = new Set(done);
    for (const l of open.filter((x) => !saved.has(x.id))) {
      try {
        await api.post(`/order-lines/${l.id}/update`, { version: l.version, reported_by_id: user.id, phase: 'ready', ready_qty: Number(qty[l.id]) });
        saved.add(l.id);
      } catch (e) {
        failed[l.id] = e.fields ? Object.values(e.fields).join(' ') : e.message;
      }
    }
    setDone(saved);
    setErrors(failed);
    setSaving(false);
    if (!Object.keys(failed).length) onSaved?.();
  };
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Item</th><th className="num">Left to send</th><th className="num" style={{ width: 120 }}>Ready</th></tr></thead>
          <tbody>
            {open.map((l) => (
              <tr key={l.id}>
                <td>
                  <strong>{l.product}</strong><div className="sub">{done.has(l.id) ? 'Saved' : l.phase_label}</div>
                  {errors[l.id] && <div className="tiny danger-text">{errors[l.id]}</div>}
                </td>
                <td className="num">{fmtQty(l.quantities.remaining, l.unit)}</td>
                <td><Input type="number" min={0} step="any" className="num" value={qty[l.id]} disabled={done.has(l.id)} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} aria-label={`Quantity ready of ${l.product}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!open.length && <Notice tone="info">Nothing is left to make on this order.</Notice>}
      <div className="row between"><span className="small muted">Ready counts everything built so far, including what has already been sent.</span><Button type="submit" variant="cta" loading={saving} disabled={!open.length}>Mark ready</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ telling the customer about a new date
export function CommunicationForm({ order, lines, onSaved }) {
  const save = useSave();
  const pending = lines.filter((l) => l.comm?.state === 'pending').map((l) => l.id);
  const active = lines.filter((l) => l.status?.active);
  const [f, setF] = useState({ line_ids: pending.length ? pending : active.map((l) => l.id), channel: 'phone', outcome: '', agreed_date: '', note: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const accepted = f.outcome === 'accepted_revised_date';
  const latest = active.filter((l) => f.line_ids.includes(l.id)).map((l) => l.forecast_dispatch_date).filter(Boolean).sort().at(-1);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => {
      const r = await api.post(`/orders/${order.id}/communications`, { ...f, agreed_date: f.agreed_date || undefined }, { key });
      onSaved?.(r);
      return r;
    }); }}>
      <div className="form-grid">
        <Field label="How" required error={err(save, 'channel')}><OptionSelect category="channel" value={f.channel} onChange={(v) => set({ channel: v })} exclude={['internal']} /></Field>
        <Field label="Customer's response" required error={err(save, 'outcome')}><OptionSelect category="customer_update_outcome" value={f.outcome} onChange={(v) => set({ outcome: v, agreed_date: v === 'accepted_revised_date' && !f.agreed_date ? latest || '' : f.agreed_date })} /></Field>
        {accepted && <DateField label="Date they agreed to" required value={f.agreed_date} onChange={(v) => set({ agreed_date: v })} error={err(save, 'agreed_date')} presets={false} />}
        <Field label="Note" optional className="full" error={err(save, 'note')}><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
      </div>
      {err(save, 'line_ids') && <Notice tone="danger">{err(save, 'line_ids')}</Notice>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
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
  const [f, setF] = useState({ dispatch_date: todayLocal(), carrier: '', tracking_no: '', vehicle_number: '', notes: '', override_reason: '' });
  useEffect(() => {
    if (!customer?.id) return;
    api.get('/order-lines/options', { customer_id: customer.id }).then((rows) => {
      const shown = orderId ? rows.filter((r) => r.order_id === orderId) : rows;
      setLines(shown);
      // Coming from an order: start with what is ready to go.
      if (orderId) setQtys(Object.fromEntries(shown.filter((l) => l.quantities.readyNotDispatched > 0).map((l) => [l.id, Math.min(l.quantities.readyNotDispatched, l.quantities.remaining)])));
    });
  }, [customer?.id, orderId]);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const chosen = (lines || []).filter((l) => Number(qtys[l.id]) > 0);
  const notReady = chosen.some((l) => Number(qtys[l.id]) > (l.quantities.readyNotDispatched ?? 0));
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => {
      const r = await api.post('/dispatches', {
        lines: chosen.map((l) => ({ line_id: l.id, qty: Number(qtys[l.id]) })), dispatch_date: f.dispatch_date, carrier: f.carrier, tracking_no: f.tracking_no,
        vehicle_number: f.vehicle_number, notes: f.notes, override_reason: f.override_reason || undefined,
      }, { key });
      onSaved?.(r);
      return r;
    }); }}>
      {!fixedCustomer && <Field label="Customer" required><CustomerPicker value={customer} onChange={setCustomer} allowCreate={false} onNewCustomer={() => {}} /></Field>}
      {customer?.id && !lines && <div className="muted small">Loading…</div>}
      {lines && !lines.length && <Notice tone="info">Nothing left to dispatch for this customer.</Notice>}
      {lines?.length > 0 && (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Item</th><th className="num">Left to send</th><th className="num">Ready</th><th className="num" style={{ width: 120 }}>Send now</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.order_code}</strong> · {l.product}</td>
                  <td className="num">{fmtQty(l.quantities.remaining, l.unit)}</td>
                  <td className="num">{l.quantities.readyNotDispatched === null ? '—' : fmtQty(l.quantities.readyNotDispatched)}</td>
                  <td className="num">
                    <Input type="number" min={0} max={l.quantities.remaining} step="any" value={qtys[l.id] ?? ''} invalid={Boolean(save.fields[`lines.${chosen.indexOf(l)}.qty`])} onChange={(e) => setQtys({ ...qtys, [l.id]: e.target.value })} aria-label={`Quantity for ${l.order_code} ${l.product}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {Object.entries(save.fields).filter(([k]) => k.startsWith('lines')).map(([k, v]) => <Notice key={k} tone="danger">{v}</Notice>)}
      <div className="form-grid">
        <Field label="Dispatch date" required error={err(save, 'dispatch_date')}><Input type="date" max={todayLocal()} value={f.dispatch_date} onChange={(e) => set({ dispatch_date: e.target.value })} /></Field>
        <Field label="Transporter" optional><Input value={f.carrier} onChange={(e) => set({ carrier: e.target.value })} /></Field>
        <Field label="LR / tracking number" optional><Input value={f.tracking_no} onChange={(e) => set({ tracking_no: e.target.value })} /></Field>
        <Field label="Vehicle number" optional><Input value={f.vehicle_number} onChange={(e) => set({ vehicle_number: e.target.value })} /></Field>
        <Field label="Note" optional className="full"><Input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      {notReady && (
        <Field label="Why send more than is marked ready?" required error={err(save, 'override_reason')} hint={can('dispatch.override') ? undefined : 'Only a coordinator or management can do this'}>
          <Input value={f.override_reason} onChange={(e) => set({ override_reason: e.target.value })} />
        </Field>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving} disabled={!chosen.length}>Save dispatch</Button></div>
    </form>
  );
}

/** Transporter details often arrive after the goods have left. */
export function TransportForm({ dispatch: d, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ carrier: d.carrier || '', tracking_no: d.tracking_no || '', vehicle_number: d.vehicle_number || '', notes: d.notes || '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/dispatches/${d.id}`, f); onSaved?.(); }); }}>
      <Field label="Transporter" optional error={err(save, 'carrier')}><Input value={f.carrier} onChange={(e) => set({ carrier: e.target.value })} /></Field>
      <Field label="LR / tracking number" optional error={err(save, 'tracking_no')}><Input value={f.tracking_no} onChange={(e) => set({ tracking_no: e.target.value })} /></Field>
      <Field label="Vehicle number" optional error={err(save, 'vehicle_number')}><Input value={f.vehicle_number} onChange={(e) => set({ vehicle_number: e.target.value })} /></Field>
      <Field label="Note" optional error={err(save, 'notes')}><Input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

export function DeliveredForm({ dispatch, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ delivered_at: todayLocal(), received_by_name: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/dispatches/${dispatch.id}/delivered`, f); onSaved?.(); }); }}>
      <Field label="Delivered on" required error={err(save, 'delivered_at')}><Input type="date" min={dispatch.dispatch_date || undefined} max={todayLocal()} value={f.delivered_at} onChange={(e) => setF({ ...f, delivered_at: e.target.value })} /></Field>
      <Field label="Received by" optional error={err(save, 'received_by_name')}><Input value={f.received_by_name} onChange={(e) => setF({ ...f, received_by_name: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

/** One line of explanation for an action that has to be justified, such as a reversal. */
export function ReasonForm({ label, button, note, danger, onSubmit }) {
  const save = useSave();
  const [reason, setReason] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(() => onSubmit(reason)); }}>
      {note && <div className="small muted">{note}</div>}
      <Field label={label} required error={err(save, 'reason') || err(save, 'evidence')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={danger ? 'danger' : 'primary'} loading={save.saving}>{button}</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ payment
/** Money received against an order: an advance, part payment or the balance. `amountMinor` fills in the amount expected. */
export function PaymentForm({ order, amountMinor, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ amount: amountMinor ? fromMinor(amountMinor) : '', effective_date: todayLocal(), reference: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const r = await api.post(`/finance/orders/${order.id}/advances`, f); onSaved?.(r); return r; }); }}>
      <div className="form-grid">
        <Field label={`Amount received (${order.currency || 'INR'})`} required error={err(save, 'amount')}><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Date" required error={err(save, 'effective_date')}><Input type="date" max={todayLocal()} value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} /></Field>
        <Field label="Reference" optional className="full" hint="UTR or cheque number" error={err(save, 'reference')}><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving}>Save payment</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ cancelling part of an order
export function CancelQtyForm({ line, onSaved }) {
  const save = useSave();
  const q = line.quantities || lineQty(line);
  const [f, setF] = useState({ qty: q.remaining, reason_code: '', note: '', requested_source: 'customer', requested_by_name: '' });
  const reason = useOptions('cancel_reason').find((o) => o.value === f.reason_code);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => { const r = await api.post(`/order-lines/${line.id}/cancel`, { ...f, version: line.version }, { key }); onSaved?.(r); return r; }); }}>
      <ConflictNotice save={save} />
      <div className="form-grid">
        <Field label="Quantity to cancel" required error={err(save, 'qty')} hint={`${fmtQty(q.remaining, line.unit)} left`}><Input type="number" min={0} max={q.remaining} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Reason" required error={err(save, 'reason_code')}><OptionSelect category="cancel_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>
        <Field label="Note" optional={!reason?.requires_note} required={reason?.requires_note} error={err(save, 'note')} className="full"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving}>Cancel quantity</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ new enquiry
const emptyLine = () => ({ product_id: null, requirement: '', spec: '', qty: '', unit: 'pcs' });
export function newEnquiryDraft(user, meta) {
  return {
    customer: null, new_customer: null, contact_id: '', lines: [emptyLine()], source_code: '', source_event: '', campaign_id: '', owner_id: user.group === 'sales' ? user.id : null,
    next_purpose: 'Respond to enquiry', next_date: addWorkingDays(todayLocal(), meta.settings.rules.enquiryResponseWorkingDays, meta.settings.calendar),
    note: '',
  };
}

/** Who it is from, what they want, how it came in, who handles it and when to follow up. */
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
  const pickExhibition = (value) => set({ campaign_id: value, source_event: meta.campaigns.find((c) => String(c.id) === value)?.name || '' });
  const dup = save.error?.code === 'possible_duplicate' ? save.error.details.matches : null;

  const submit = (confirmNotDuplicate = false) => save.run(async (key) => {
    const nc = d.new_customer;
    const res = await api.post('/enquiries', {
      customer_id: d.customer?.id, contact_id: d.contact_id || undefined,
      new_customer: !d.customer?.id && nc ? {
        company_name: nc.company_name, country_code: nc.country_code, city: nc.city, confirm_not_duplicate: confirmNotDuplicate || undefined,
        contacts: [{ name: nc.contact_name, phone: nc.phone, email: nc.email }],
      } : undefined,
      lines: d.lines.map((l) => ({ product_id: l.product_id, requirement: l.product_id ? undefined : l.requirement || 'Unspecified / needs clarification', spec: l.spec, qty: l.qty === '' ? null : Number(l.qty), unit: l.unit })),
      source_code: d.source_code, source_event: d.source_event, campaign_id: d.source_code === 'exhibition' ? d.campaign_id || undefined : undefined, owner_id: d.owner_id, requirement_note: d.note,
      next: { purpose: d.next_purpose, owner_id: d.owner_id, due_date: d.next_date },
    }, { key });
    onSaved?.(res);
    return res;
  });

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <Field label="Customer" required error={err(save, 'customer_id') || err(save, 'contacts')}>
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
      {d.customer?.id && contacts.length > 1 && (
        <Field label="Contact"><Select value={d.contact_id} onChange={(e) => set({ contact_id: e.target.value })} options={contacts.map((c) => ({ value: String(c.id), label: [c.name, c.phone_raw, c.email_raw].filter(Boolean).join(' · ') }))} /></Field>
      )}
      <div className="stack-sm">
        {d.lines.map((l, i) => (
          <div key={i} className="form-grid" style={{ alignItems: 'end' }}>
            <Field label="Product" error={err(save, `lines.${i}.product_id`)}><ProductSelect value={l.product_id} onChange={(v) => setLine(i, { product_id: v })} /></Field>
            <div className="row" style={{ alignItems: 'end' }}>
              {!l.product_id && <Field label="What do they need?" className="grow" error={err(save, `lines.${i}.requirement`)}><Input value={l.requirement} onChange={(e) => setLine(i, { requirement: e.target.value })} placeholder="e.g. meters for 3 panels" /></Field>}
              <Field label="Qty" optional error={err(save, `lines.${i}.qty`)}><Input type="number" min={0} step="any" style={{ width: 90 }} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></Field>
              {d.lines.length > 1 && <Button size="sm" variant="ghost" icon="trash" aria-label="Remove product" onClick={() => set({ lines: d.lines.filter((_, j) => j !== i) })} />}
            </div>
          </div>
        ))}
        <div><Button size="sm" icon="plus" onClick={() => set({ lines: [...d.lines, emptyLine()] })}>Add product</Button></div>
      </div>
      <div className="form-grid">
        <Field label="Source" required error={err(save, 'source_code')}><OptionSelect category="enquiry_source" value={d.source_code} onChange={(v) => set({ source_code: v, campaign_id: '', source_event: '' })} /></Field>
        {d.source_code === 'exhibition' && (
          <Field label="Which exhibition" required error={err(save, 'campaign_id')} hint={exhibitions.length ? undefined : 'Add it under Exhibitions first'}>
            <Select value={d.campaign_id} onChange={(e) => pickExhibition(e.target.value)} placeholder="Choose…" options={exhibitions.map((c) => ({ value: String(c.id), label: c.name }))} invalid={Boolean(err(save, 'campaign_id'))} />
          </Field>
        )}
        {sourceOpt?.requires_note && <Field label="Which one?" required error={err(save, 'source_event')}><Input value={d.source_event} onChange={(e) => set({ source_event: e.target.value })} /></Field>}
        <Field label="Assigned to" required error={err(save, 'owner_id')}><UserSelect value={d.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} invalid={Boolean(err(save, 'owner_id'))} /></Field>
        <DateField label="Follow up on" value={d.next_date} onChange={(v) => set({ next_date: v })} error={err(save, 'next.due_date')} />
        <Field label="Notes" optional className="full" error={err(save, 'requirement_note')}><Textarea rows={2} value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
      </div>
      {err(save, 'next.purpose') && <Notice tone="danger">{err(save, 'next.purpose')}</Notice>}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <Button type="submit" variant="primary" loading={save.saving} icon="check">Save enquiry</Button>
      </div>
    </form>
  );
}

export { relDay };
