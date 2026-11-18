// What a change of enquiry status needs: a lost or cancel reason, a review date, a next action. Used on the
// enquiry page and when a card is dragged on the stage board.
import { useState } from 'react';
import { api } from '../api.js';
import { useSave } from '../lib/hooks.js';
import { Button, Field, Input, Notice, SaveStatus, Textarea } from './ui.jsx';
import { DateField, OptionSelect, PurposeInput, UserSelect, useOptions } from './domain.jsx';

export default function StageForm({ enquiry, stage, hasTask, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ lost_reason_code: '', lost_note: '', competitor: '', cancel_reason_code: '', cancel_note: '', hold_review_date: '', hold_reason: '', next_purpose: '', next_date: '', next_owner: enquiry.owner_id, no_followup_reason: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const lostOpt = useOptions('lost_reason').find((o) => o.value === f.lost_reason_code);
  const needsNext = ['new', 'clarification', 'quote_to_prepare', 'awaiting_decision'].includes(stage) || (stage === 'quote_sent' && !hasTask);
  return (
    <form className="stack-sm" onSubmit={(ev) => { ev.preventDefault(); save.run(async () => {
      await api.post(`/enquiries/${enquiry.id}/stage`, {
        stage, version: enquiry.version, ...f, hold_review_date: f.hold_review_date || undefined,
        next: f.next_purpose || f.next_date ? { purpose: f.next_purpose, due_date: f.next_date, owner_id: f.next_owner } : undefined, no_followup_reason: f.no_followup_reason || undefined,
      });
      onSaved();
    }); }}>
      {save.fields.stage && <Notice tone="danger">{save.fields.stage}</Notice>}
      {stage === 'lost' && (
        <>
          <Field label="Lost reason" required error={save.fields.lost_reason_code}><OptionSelect category="lost_reason" value={f.lost_reason_code} onChange={(v) => set({ lost_reason_code: v })} /></Field>
          {f.lost_reason_code === 'unknown' && <Notice tone="info">A feedback task (“Ask why they did not proceed”) will be created — better than a guessed reason.</Notice>}
          <Field label="Note" optional={!lostOpt?.requires_note} required={lostOpt?.requires_note} error={save.fields.lost_note}><Textarea rows={2} value={f.lost_note} onChange={(e) => set({ lost_note: e.target.value })} /></Field>
          <Field label="Competitor" optional><Input value={f.competitor} onChange={(e) => set({ competitor: e.target.value })} /></Field>
        </>
      )}
      {stage === 'cancelled' && (
        <>
          <Field label="Why cancelled" required error={save.fields.cancel_reason_code} hint="Withdrawn, duplicate or invalid — not a commercial loss"><OptionSelect category="enquiry_cancel_reason" value={f.cancel_reason_code} onChange={(v) => set({ cancel_reason_code: v })} /></Field>
          <Field label="Note" optional error={save.fields.cancel_note}><Input value={f.cancel_note} onChange={(e) => set({ cancel_note: e.target.value })} /></Field>
        </>
      )}
      {stage === 'on_hold' && (
        <>
          <DateField label="Review date" required value={f.hold_review_date} onChange={(v) => set({ hold_review_date: v })} error={save.fields.hold_review_date} />
          <Field label="Reason" optional><Input value={f.hold_reason} onChange={(e) => set({ hold_reason: e.target.value })} /></Field>
        </>
      )}
      {stage === 'won' && <Notice tone="info">Won needs a linked confirmed order covering the accepted scope. Usually this happens automatically when the accepted quotation is converted.</Notice>}
      {needsNext && (
        <>
          <div className="small muted">{hasTask ? 'An open next action already exists — add another only if needed.' : stage === 'awaiting_decision' ? 'Awaiting decision needs a next follow-up.' : 'An open enquiry needs a next action.'}</div>
          <div className="form-grid">
            <Field label="Next action" className="full" error={save.fields['next.purpose']}><PurposeInput value={f.next_purpose} onChange={(v) => set({ next_purpose: v })} /></Field>
            <DateField label="Due" value={f.next_date} onChange={(v) => set({ next_date: v })} error={save.fields['next.due_date']} />
            <Field label="Owner"><UserSelect value={f.next_owner} onChange={(v) => set({ next_owner: v })} /></Field>
          </div>
        </>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}
