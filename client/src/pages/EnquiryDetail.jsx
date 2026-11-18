import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ENQUIRY_STAGES, ENQUIRY_LINE_OUTCOMES, TEMPERATURES, labelOf, toneOf, CURRENCIES } from '@shared/constants.js';
import { fromMinor } from '@shared/rules.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, qty, toLocalInput, todayLocal, relDay, compactMoney } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Field, Input, Modal, Notice, PageHeader, Popover, SaveStatus, Select, Spinner, Textarea, Checkbox, useToast, Facts, Segmented,
} from '../components/ui.jsx';
import {
  StageBadge, QuoteBadge, ApprovalBadge, DueBadge, Timeline, Attachments, OptionSelect, UserSelect, DateField, PurposeInput, Money, FilePick, useOptions, useMeta, useOptionLabel, JourneyCard, ReplyBadge } from '../components/domain.jsx';
import { FollowupForm, RescheduleForm, fromLocalInput } from '../components/forms.jsx';

export default function EnquiryDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(`/enquiries/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { enquiry: e, lines, quotations, orders, tasks, activities, history, attachments, missing, children } = data;
  const openTasks = tasks.filter((t) => t.status === 'open');
  const edit = can('enquiries.edit');
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const timeline = [
    ...activities.map((a) => ({ key: `a${a.id}`, at: a.occurred_at, entered_at: a.entered_at, group: a.kind === 'quotation' ? 'quotations' : a.customer_contact ? (a.channel === 'email' ? 'emails' : 'calls') : 'internal', icon: a.channel, title: `${a.channel_label} — ${a.outcome_label || a.outcome}`, detail: a.note, actor: a.entered_by_name, reported_by: a.reported_by_name, contact: a.contact_name, backdated: a.backdated, customer_contact: Boolean(a.customer_contact) })),
    ...history.filter((h) => ['stage_changed', 'reopened', 'created', 'no_followup', 'line_outcome', 'owner_changed'].includes(h.kind)).map((h) => ({
      key: `h${h.id}`, at: h.occurred_at || h.created_at, entered_at: h.created_at, group: 'enquiries', icon: 'enquiry', actor: h.actor_name, detail: h.note,
      title: h.kind === 'stage_changed' ? `Stage: ${labelOf(ENQUIRY_STAGES, h.data?.from)} → ${labelOf(ENQUIRY_STAGES, h.data?.to)}${h.data?.reason ? ` (${h.data.reason})` : ''}` : h.kind === 'created' ? 'Enquiry received' : h.kind === 'reopened' ? 'Reopened' : h.kind === 'no_followup' ? 'No further follow-up planned' : h.kind === 'owner_changed' ? 'Owner changed' : 'Line outcome recorded',
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Enquiries', to: '/enquiries' }, { label: e.code }]}
        eyebrow={<>{e.code} · {e.source_label}{e.source_event ? ` (${e.source_event})` : ''} · received {e.received_unknown ? 'date unknown' : dateTime(e.received_at)}</>}
        title={<><Link to={`/customers/${e.customer_id}`}>{e.customer_name}</Link> <StageBadge stage={e.stage} /> <ReplyBadge replied={Boolean(e.first_response_at)} size="md" /></>}
        subtitle={<>Owner {e.owner_name}{e.contact_name ? ` · contact ${e.contact_name}${e.contact_phone ? ` (${e.contact_phone})` : ''}` : ''}{e.first_response_at ? ` · first response ${dateTime(e.first_response_at)}` : ' · no response recorded yet'}</>}
        actions={edit && (e.open ? (
          <>
            {!quotations.some((q) => q.revisions.some((r) => r.status === 'draft')) && can('quotes.edit') && <Button icon="plus" onClick={async () => { try { const res = await api.post('/quotations', { enquiry_id: e.id }); toast.success('Draft quotation created from the enquiry lines — price it in the builder'); navigate(`/quotations/${res.quotation_id}/edit`); } catch (err) { toast.error(err.message); } }}>New quotation</Button>}
            <Popover trigger={({ toggle }) => <Button variant="primary" iconRight="chevronDown" onClick={toggle}>Change status</Button>}>
              {({ close }) => (
                <div className="menu">
                  {ENQUIRY_STAGES.filter((s) => s.value !== e.stage && s.value !== 'quote_sent').map((s) => (
                    <button key={s.value} type="button" onClick={() => { close(); setModal({ type: 'stage', stage: s.value }); }}><Badge size="sm" tone={s.tone}>{s.label}</Badge></button>
                  ))}
                  <div className="sep" /><div className="tiny muted" style={{ padding: '4px 10px' }}>“Quotation sent” is set by issuing a quotation.</div>
                </div>
              )}
            </Popover>
          </>
        ) : (
          <>
            <Button icon="plus" onClick={() => setModal({ type: 'linked' })}>New linked enquiry</Button>
            <Button onClick={() => setModal({ type: 'reopen' })}>Reopen</Button>
          </>
        ))}
      />
      <JourneyCard enquiryId={e.id} version={e.version} />
      {missing.length > 0 && e.open && <Notice tone="warn" title="Missing before quotation or order confirmation">{missing.join(' · ')}</Notice>}
      {e.stage === 'lost' && <Notice tone="danger" title={`Lost — ${e.lost_reason || 'reason not recorded'}`}>{e.lost_note}{e.competitor ? ` Competitor: ${e.competitor}.` : ''} Decided {date(e.decided_at)}. This reason belongs to this opportunity only.</Notice>}
      {e.stage === 'cancelled' && <Notice tone="info" title={`Cancelled — ${e.cancel_reason}`}>{e.cancel_note}{e.duplicate_of_code ? ` Duplicate of ${e.duplicate_of_code}.` : ''} Not counted as a commercial loss.</Notice>}
      {e.stage === 'on_hold' && <Notice tone="warn" title={`On hold until ${date(e.hold_review_date)}`}>{e.hold_reason}</Notice>}
      {(e.parent_enquiry_id || children.length > 0) && (
        <div className="small">Linked: {e.parent_enquiry_id && <Link to={`/enquiries/${e.parent_enquiry_id}`}>earlier {e.parent_code}</Link>} {children.map((c) => <Link key={c.id} to={`/enquiries/${c.id}`}> later {c.code}</Link>)}</div>
      )}

      <div className="split wide">
        <div className="stack">
          <Card title="Products / requirement" flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th className="num">Quantity</th><th className="num">Ordered</th><th>Outcome</th><th /></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.product_code ? <strong>{l.product_code}</strong> : <Badge tone="amber">Needs clarification</Badge>} {l.product_name || l.requirement}{l.spec && <div className="sub">{l.spec}</div>}</td>
                      <td className="num">{l.qty === null ? <span className="muted">Unknown</span> : qty(l.qty, l.unit)}</td>
                      <td className="num">{l.ordered_qty ? qty(l.ordered_qty) : '—'}{l.lost_qty > 0 && <div className="sub">lost {qty(l.lost_qty)}</div>}</td>
                      <td><Badge tone={toneOf(ENQUIRY_LINE_OUTCOMES, l.outcome)}>{labelOf(ENQUIRY_LINE_OUTCOMES, l.outcome)}</Badge>{l.outcome === 'open' && l.won_qty > 0 && <div className="sub">{qty(l.won_qty)} converted · {l.open_qty === null ? 'rest open' : `${qty(l.open_qty)} open`}</div>}</td>
                      <td>{edit && l.outcome === 'open' && e.open && <Button size="xs" variant="ghost" onClick={() => setModal({ type: 'line_lost', line: l })}>{l.won_qty > 0 ? 'Mark remainder lost' : 'Mark lost'}</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {quotations.map((q) => (
            <Card key={q.id} title={<Link to={`/quotations/${q.id}`}>Quotation {q.number}</Link>} sub={`prepared by ${q.prepared_by_name || '—'}`}
              actions={can('quotes.edit') && !q.revisions.some((r) => r.status === 'draft') && !q.revisions.some((r) => r.status === 'accepted') && e.open && <Button size="sm" icon="plus" onClick={async () => { try { await api.post(`/quotations/${q.id}/revisions`); done('New draft revision created — earlier revisions stay retrievable'); } catch (err) { toast.error(err.message); } }}>New revision</Button>}>
              <div className="stack">
                {q.revisions.map((r) => <Revision key={r.id} q={q} r={r} enquiry={e} onAction={setModal} />)}
              </div>
            </Card>
          ))}
          {!quotations.length && e.open && <Notice tone="info">No quotation yet. A draft quotation does not count as sent — issue it once it has gone to the customer.</Notice>}

          {orders.length > 0 && (
            <Card title="Orders from this enquiry">
              {orders.map((o) => <div key={o.id} className="row between"><Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link><span className="small">{o.status === 'draft' ? 'Draft' : o.closed_at ? 'Closed' : 'Active'} · received {date(o.received_date)}{o.po_reference ? ` · PO ${o.po_reference}` : ''}</span></div>)}
            </Card>
          )}

          <Card title="History"><Timeline items={timeline} /></Card>
        </div>

        <div className="stack sticky-side">
          <Card title="Next action" actions={edit && e.open && <Button size="sm" variant="ghost" icon="plus" onClick={() => setModal({ type: 'task' })}>Add</Button>}>
            {!openTasks.length && <div className="small muted">{e.open ? (e.no_followup_reason ? `No follow-up: ${e.no_followup_reason}` : 'No next action — an open enquiry needs one.') : 'Closed.'}</div>}
            <div className="stack-sm">
              {openTasks.map((t) => (
                <div key={t.id} className="m-card">
                  <div className="row between"><strong className="small">{t.purpose}</strong><DueBadge task={t} /></div>
                  <div className="tiny muted">{t.owner_name}{t.reschedule_count ? ` · rescheduled ${t.reschedule_count}× (originally ${date(t.original_due_date)})` : ''}</div>
                  {can('tasks.edit') && <div className="row"><Button size="xs" variant="primary" onClick={() => setModal({ type: 'complete', task: t })}>Record outcome</Button><Button size="xs" onClick={() => setModal({ type: 'reschedule', task: t })}>Reschedule</Button></div>}
                </div>
              ))}
            </div>
          </Card>
          <Card title="Opportunity" actions={edit && <Button size="sm" variant="ghost" icon="edit" onClick={() => setModal({ type: 'opportunity' })}>Edit</Button>}>
            <Facts items={[
              ['Title', e.title],
              can('values.view') && ['Estimated value', e.est_value_minor ? compactMoney(e.est_value_minor, e.est_currency) : <span className="muted">Not estimated</span>],
              ['Probability', e.probability !== null && e.probability !== undefined ? `${e.probability}%` : <span className="muted">Stage default ({ENQUIRY_STAGES.find((x) => x.value === e.stage)?.probability ?? 0}%)</span>],
              ['Temperature', e.temperature ? <Badge size="sm" tone={toneOf(TEMPERATURES, e.temperature)}>{labelOf(TEMPERATURES, e.temperature)}</Badge> : null],
              ['Decision expected', e.expected_decision_date ? <span className={e.expected_decision_date < todayLocal() && e.open ? 'danger-text strong' : ''}>{date(e.expected_decision_date, { year: true })} ({relDay(e.expected_decision_date)})</span> : null],
              [e.source_code === 'exhibition' ? 'Exhibition' : 'Event', e.campaign_id ? <Link to={`/campaigns/${e.campaign_id}`}>{e.campaign_name || 'Campaign'}</Link> : null],
            ]} />
          </Card>
          <Card title="Details">
            <Facts items={[
              ['Received', e.received_unknown ? 'Unknown (historical)' : dateTime(e.received_at)],
              ['Reply', e.first_response_at ? <><ReplyBadge replied /> {dateTime(e.first_response_at)}</> : <ReplyBadge replied={false} />],
              ['Source', `${e.source_label}${e.source_event ? ` — ${e.source_event}` : ''}`],
              ['Owner', e.owner_name],
              ['Reopened', e.reopened_count ? `${e.reopened_count}×` : null],
              ['Note', e.requirement_note],
            ]} />
          </Card>
          <Card title="Documents"><Attachments items={attachments} entityType="enquiry" entityId={e.id} onChange={reload} /></Card>
        </div>
      </div>

      <Modal open={modal?.type === 'opportunity'} onClose={() => setModal(null)} title="Opportunity details" subtitle="Used for the pipeline value and forecast">
        {modal?.type === 'opportunity' && <OpportunityForm enquiry={e} onSaved={() => done('Opportunity details saved')} />}
      </Modal>
      <Modal open={modal?.type === 'stage'} onClose={() => setModal(null)} title={`Change status to “${labelOf(ENQUIRY_STAGES, modal?.stage)}”`}>
        {modal?.type === 'stage' && <StageForm enquiry={e} stage={modal.stage} hasTask={openTasks.length > 0} onSaved={() => done('Status updated')} />}
      </Modal>
      <Modal open={modal?.type === 'reopen'} onClose={() => setModal(null)} title="Reopen enquiry">
        {modal?.type === 'reopen' && <ReopenForm enquiry={e} onSaved={() => done('Enquiry reopened')} />}
      </Modal>
      <Modal open={modal?.type === 'linked'} onClose={() => setModal(null)} title="New linked enquiry" subtitle="A materially new request becomes a new enquiry linked to this one.">
        {modal?.type === 'linked' && <LinkedForm enquiry={e} />}
      </Modal>
      <Modal open={modal?.type === 'line_lost'} size="sm" onClose={() => setModal(null)} title="Mark line lost">
        {modal?.type === 'line_lost' && <LineLostForm line={modal.line} onSaved={() => done('Line outcome recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'complete'} onClose={() => setModal(null)} title="Record outcome" subtitle={modal?.task?.purpose}>
        {modal?.type === 'complete' && <FollowupForm task={{ ...modal.task, enquiry_stage: e.stage, enquiry_code: e.code }} onSaved={() => done('Outcome recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'reschedule'} size="sm" onClose={() => setModal(null)} title="Reschedule">
        {modal?.type === 'reschedule' && <RescheduleForm task={modal.task} onSaved={() => done('Rescheduled')} />}
      </Modal>
      <Modal open={modal?.type === 'task'} size="sm" onClose={() => setModal(null)} title="Add next action">
        {modal?.type === 'task' && <TaskForm enquiry={e} onSaved={() => done('Next action added')} />}
      </Modal>
      <Modal open={modal?.type === 'edit_rev'} size="xl" onClose={() => setModal(null)} title={`Edit draft ${modal?.q?.number} rev ${modal?.r?.revision_no}`}>
        {modal?.type === 'edit_rev' && <DraftEditor r={modal.r} onSaved={() => done('Draft saved')} />}
      </Modal>
      <Modal open={modal?.type === 'issue'} onClose={() => setModal(null)} title={`Issue ${modal?.q?.number} rev ${modal?.r?.revision_no}`} subtitle="Record that it was actually sent">
        {modal?.type === 'issue' && <IssueForm r={modal.r} enquiry={e} onSaved={() => done('Quotation issued — follow-up scheduled')} />}
      </Modal>
      <Modal open={modal?.type === 'outcome'} onClose={() => setModal(null)} title={modal?.outcome === 'accepted' ? 'Customer accepted' : modal?.outcome === 'rejected' ? 'Customer rejected' : 'Awaiting decision'}>
        {modal?.type === 'outcome' && <OutcomeForm r={modal.r} outcome={modal.outcome} hasTask={openTasks.length > 0} onSaved={() => done('Outcome recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'convert'} size="xl" onClose={() => setModal(null)} title={`Convert ${modal?.q?.number} rev ${modal?.r?.revision_no} to an order`} subtitle="Review what is copied; add only the order details that are missing.">
        {modal?.type === 'convert' && <ConvertForm r={modal.r} enquiry={e} onDone={() => { reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Modal>
    </div>
  );
}

function Revision({ q, r, enquiry, onAction }) {
  const { can } = useAuth();
  const optionLabel = useOptionLabel();
  const total = r.total_minor;
  return (
    <div className="line-card">
      <div className="line-head">
        <strong>Revision {r.revision_no}</strong>
        <QuoteBadge status={r.status} />
        {r.status === 'draft' && r.approval_role && <ApprovalBadge status={r.approval_status} />}
        {r.expired && ['issued', 'accepted'].includes(r.status) && <Badge tone="amber">Validity expired {date(r.validity_date)}</Badge>}
        <span className="small muted grow">{r.sent_at ? `Sent ${dateTime(r.sent_at)} by ${r.sent_channel}${r.issued_by_name ? ` (${r.issued_by_name})` : ''}` : 'Not sent'}{r.validity_date ? ` · valid to ${date(r.validity_date)}` : ''}</span>
        <span className="strong"><Money minor={total} currency={r.currency} /></span>
      </div>
      <div style={{ padding: '10px 16px' }} className="stack-sm">
        <table className="table compact">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Line value</th></tr></thead>
          <tbody>{r.lines.map((l) => <tr key={l.index}><td>{l.product_code ? <strong>{l.product_code}</strong> : null} {l.description}{l.spec ? <div className="sub">{l.spec}</div> : null}</td><td className="num">{l.qty === null ? 'Unknown' : qty(l.qty, l.unit)}</td><td className="num"><Money minor={l.unit_price_minor} currency={r.currency} /></td><td className="num"><Money minor={l.line_total_minor} currency={r.currency} /></td></tr>)}</tbody>
        </table>
        {(r.delivery_terms || r.payment_terms || r.summary) && <div className="small muted">{[r.delivery_terms && `Delivery: ${r.delivery_terms} (indicative — not a dispatch commitment)`, r.payment_terms && `Payment: ${r.payment_terms}`, r.summary].filter(Boolean).join(' · ')}</div>}
        {r.rejection_reason_code && <div className="small">Rejected: {optionLabel('lost_reason', r.rejection_reason_code)} {r.decision_note}</div>}
        {r.attachments?.length > 0 && <Attachments items={r.attachments} canUpload={false} />}
        {can('quotes.edit') && enquiry.open && (
          <div className="row wrap">
            {r.status === 'draft' && <><Button size="sm" icon="edit" to={`/quotations/${q.id}/edit`}>Edit in quotation builder</Button><Button size="sm" variant="primary" icon="arrowRight" onClick={() => onAction({ type: 'issue', q, r })}>Record as sent</Button></>}
            {r.status === 'issued' && <><Button size="sm" variant="primary" onClick={() => onAction({ type: 'outcome', r, outcome: 'accepted' })}>Accepted</Button><Button size="sm" onClick={() => onAction({ type: 'outcome', r, outcome: 'awaiting' })}>Awaiting decision</Button><Button size="sm" variant="danger-ghost" onClick={() => onAction({ type: 'outcome', r, outcome: 'rejected' })}>Rejected</Button></>}
            {['issued', 'accepted'].includes(r.status) && can('orders.edit') && <Button size="sm" variant="cta" icon="box" onClick={() => onAction({ type: 'convert', q, r })}>Convert accepted quote to order</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

function StageForm({ enquiry, stage, hasTask, onSaved }) {
  const { user } = useAuth();
  const save = useSave();
  const meta = useMeta();
  const [f, setF] = useState({ lost_reason_code: '', lost_note: '', competitor: '', cancel_reason_code: '', cancel_note: '', hold_review_date: '', hold_reason: '', next_purpose: '', next_date: '', next_owner: enquiry.owner_id, no_followup_reason: '' });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const lostOpt = useOptions('lost_reason').find((o) => o.value === f.lost_reason_code);
  const needsNext = ['new', 'clarification', 'quote_to_prepare', 'awaiting_decision'].includes(stage);
  return (
    <form className="stack-sm" onSubmit={(ev) => { ev.preventDefault(); save.run(async () => {
      await api.post(`/enquiries/${enquiry.id}/stage`, {
        stage, version: enquiry.version, ...f, hold_review_date: f.hold_review_date || undefined,
        next: f.next_purpose || f.next_date ? { purpose: f.next_purpose, due_date: f.next_date, owner_id: f.next_owner } : undefined, no_followup_reason: f.no_followup_reason || undefined,
      });
      onSaved();
    }); }}>
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

function ReopenForm({ enquiry, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ reason: '', stage: 'new', purpose: 'Follow up reopened enquiry', due_date: '', owner_id: enquiry.owner_id });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/enquiries/${enquiry.id}/reopen`, { reason: f.reason, stage: f.stage, next: { purpose: f.purpose, due_date: f.due_date, owner_id: f.owner_id } }); onSaved(); }); }}>
      <Notice tone="info">If this is a materially new request, create a linked new enquiry instead — it keeps both outcomes clear.</Notice>
      <Field label="Reason for reopening" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Reopen as"><Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} options={ENQUIRY_STAGES.filter((s) => s.open && s.value !== 'quote_sent')} /></Field>
      <div className="form-grid">
        <Field label="Next action" className="full"><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
        <DateField label="Due" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date']} />
        <Field label="Owner"><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reopen</Button></div>
    </form>
  );
}

function LinkedForm({ enquiry }) {
  const navigate = useNavigate();
  const save = useSave();
  const [f, setF] = useState({ source_code: 'existing_customer', requirement: '', qty: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => { const r = await api.post(`/enquiries/${enquiry.id}/linked`, { source_code: f.source_code, lines: [{ requirement: f.requirement || 'Unspecified / needs clarification', qty: f.qty === '' ? null : Number(f.qty) }] }, { key }); navigate(`/enquiries/${r.id}`); }); }}>
      <Field label="Source" required error={save.fields.source_code}><OptionSelect category="enquiry_source" value={f.source_code} onChange={(v) => setF({ ...f, source_code: v })} /></Field>
      <Field label="Requirement"><Input value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} placeholder="Products can be refined on the new enquiry" /></Field>
      <Field label="Quantity" optional><Input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Create linked enquiry</Button></div>
    </form>
  );
}

function LineLostForm({ line, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ reason_code: '', note: '' });
  const opt = useOptions('lost_reason').find((o) => o.value === f.reason_code);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/enquiry-lines/${line.id}/outcome`, { outcome: 'lost', ...f }); onSaved(); }); }}>
      <div className="small">{line.won_qty > 0 ? `${qty(line.won_qty)} converted; the remaining ${line.open_qty === null ? 'scope' : qty(line.open_qty)} will be recorded as lost.` : 'The whole line will be recorded as lost.'}</div>
      <Field label="Reason" required error={save.fields.reason_code}><OptionSelect category="lost_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>
      <Field label="Note" optional={!opt?.requires_note} error={save.fields.note}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function TaskForm({ enquiry, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ purpose: '', due_date: '', owner_id: enquiry.owner_id, customer_promise: false });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post('/tasks', { ...f, enquiry_id: enquiry.id, kind: 'customer' }); onSaved(); }); }}>
      <Field label="Next action" required error={save.fields.purpose}><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
      <DateField label="Due" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields.due_date} />
      <Field label="Owner" required error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <Checkbox label="This is a promise to the customer (e.g. send a quote or datasheet)" checked={f.customer_promise} onChange={(v) => setF({ ...f, customer_promise: v })} />
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Add</Button></div>
    </form>
  );
}

function DraftEditor({ r, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({
    currency: r.currency, validity_date: r.validity_date || '', delivery_terms: r.delivery_terms || '', payment_terms: r.payment_terms || '', summary: r.summary || '',
    lines: r.lines.map((l) => ({ ...l, qty: l.qty ?? '', unit_price: (l.net_unit_price_minor ?? l.unit_price_minor) === null || (l.net_unit_price_minor ?? l.unit_price_minor) === undefined ? '' : fromMinor(l.net_unit_price_minor ?? l.unit_price_minor) })),
  });
  const setLine = (i, p) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/quote-revisions/${r.id}`, { ...f, version: r.version, lines: f.lines.map((l) => ({ ...l, qty: l.qty === '' ? null : Number(l.qty), unit_price: l.unit_price, unit_price_minor: undefined })) }); onSaved(); }); }}>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Description</th><th>Specification</th><th style={{ width: 110 }}>Qty</th><th style={{ width: 150 }}>Unit price</th></tr></thead>
          <tbody>{f.lines.map((l, i) => (
            <tr key={i}>
              <td><Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><Input value={l.spec || ''} onChange={(e) => setLine(i, { spec: e.target.value })} /></td>
              <td><Input type="number" min={0} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} invalid={Boolean(save.fields[`lines.${i}.qty`])} /></td>
              <td><Input inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} placeholder="blank = not priced" invalid={Boolean(save.fields[`lines.${i}.unit_price`])} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="form-grid three">
        <Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} options={CURRENCIES} /></Field>
        <Field label="Valid until"><Input type="date" value={f.validity_date} onChange={(e) => setF({ ...f, validity_date: e.target.value })} /></Field>
        <Field label="Indicative delivery"><Input value={f.delivery_terms} onChange={(e) => setF({ ...f, delivery_terms: e.target.value })} /></Field>
        <Field label="Payment terms" className="full"><Input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></Field>
        <Field label="Summary" optional className="full"><Textarea rows={2} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save draft</Button></div>
    </form>
  );
}

export function IssueForm({ r, enquiry, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const [f, setF] = useState({ sent: toLocalInput(), channel: 'email', doc: null, summary: r.summary || '', validity_date: r.validity_date || '', purpose: 'Follow up quotation', due_date: '', owner_id: enquiry.owner_id });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/quote-revisions/${r.id}/issue`, { sent_at: fromLocalInput(f.sent), channel: f.channel, document_id: f.doc?.id, summary: f.summary, validity_date: f.validity_date, next: { purpose: f.purpose, due_date: f.due_date, owner_id: f.owner_id } });
      onSaved();
    }); }}>
      <div className="form-grid">
        <Field label="Sent at" required error={save.fields.sent_at}><Input type="datetime-local" max={toLocalInput()} value={f.sent} onChange={(e) => setF({ ...f, sent: e.target.value })} /></Field>
        <Field label="Sent by" required error={save.fields.channel}><OptionSelect category="channel" value={f.channel} onChange={(v) => setF({ ...f, channel: v })} exclude={['internal']} /></Field>
        <Field label="Valid until" required error={save.fields.validity_date}><Input type="date" value={f.validity_date} onChange={(e) => setF({ ...f, validity_date: e.target.value })} /></Field>
        <Field label="Issued document" error={save.fields.document_id} hint="Attach the PDF that was sent, or record a summary"><FilePick value={f.doc} onChange={(doc) => setF({ ...f, doc })} entityType="enquiry" entityId={enquiry.id} label="Attach issued quotation" /></Field>
        <Field label="Summary" className="full" optional={Boolean(f.doc)}><Textarea rows={2} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      </div>
      {save.fields.lines && <Notice tone="danger">{save.fields.lines}</Notice>}
      <div className="form-section">Follow-up</div>
      <div className="form-grid">
        <Field label="Next action" className="full" error={save.fields['next.purpose']}><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
        <DateField label="Due" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date']} />
        <Field label="Owner" required error={save.fields['next.owner_id']}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Record as sent</Button></div>
    </form>
  );
}

export function OutcomeForm({ r, outcome, hasTask, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ acceptance_type: 'po', note: '', doc: null, reason_code: '', close_enquiry: true, competitor: '', purpose: 'Confirm purchase decision', due_date: '', owner_id: null });
  const opt = useOptions('lost_reason').find((o) => o.value === f.reason_code);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.post(`/quote-revisions/${r.id}/outcome`, {
        outcome, acceptance_type: f.acceptance_type, note: f.note, document_id: f.doc?.id, reason_code: f.reason_code, close_enquiry: f.close_enquiry, competitor: f.competitor,
        next: f.due_date ? { purpose: f.purpose, due_date: f.due_date, owner_id: f.owner_id } : undefined,
      });
      onSaved();
    }); }}>
      {outcome === 'accepted' && (
        <>
          <Field label="How did they accept?"><Segmented value={f.acceptance_type} onChange={(v) => setF({ ...f, acceptance_type: v })} options={[{ value: 'po', label: 'Purchase order' }, { value: 'written', label: 'Written' }, { value: 'verbal', label: 'Verbal' }]} /></Field>
          {f.acceptance_type !== 'verbal' && <Field label="PO / written acceptance" optional><FilePick value={f.doc} onChange={(doc) => setF({ ...f, doc })} label="Attach PO" /></Field>}
          <Field label={f.acceptance_type === 'verbal' ? 'Who confirmed, and when' : 'Note'} required={f.acceptance_type === 'verbal'} error={save.fields.note}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <div className="small muted">Next: convert the accepted quotation to an order. The enquiry becomes Won when the confirmed order covers the accepted scope.</div>
        </>
      )}
      {outcome === 'rejected' && (
        <>
          <Field label="Reason" required error={save.fields.reason_code}><OptionSelect category="lost_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>
          <Field label="Note" optional={!opt?.requires_note} error={save.fields.note}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="Competitor" optional><Input value={f.competitor} onChange={(e) => setF({ ...f, competitor: e.target.value })} /></Field>
          <Checkbox label="Close the enquiry as lost with this reason" checked={f.close_enquiry} onChange={(v) => setF({ ...f, close_enquiry: v })} />
        </>
      )}
      {outcome === 'awaiting' && (
        <>
          <div className="small muted">{hasTask ? 'An open follow-up exists; add another only if the date changes.' : 'Awaiting decision needs a next follow-up.'}</div>
          <div className="form-grid">
            <Field label="Next action" className="full"><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
            <DateField label="Due" value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date'] || save.fields['next.purpose']} />
            <Field label="Owner"><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
          </div>
        </>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

/** Review screen: everything copied from the accepted revision; only order-specific details are asked for. */
export function ConvertForm({ r, enquiry, onDone }) {
  const { can } = useAuth();
  const { data } = useApi(`/quote-revisions/${r.id}`);
  const save = useSave();
  const [f, setF] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!data || f) return;
    setF({
      po_reference: '', received_date: todayLocal(), confirmation_type: 'po', confirmation_note: '', doc: null, payment_terms: data.payment_terms || '', delivery_address: '', shipping_mode: '',
      expired_terms_confirmed: false, expired_note: '', confirm_duplicate_po: false,
      lines: data.conversion.map((l) => ({ index: l.index, qty: l.remaining_qty ?? l.qty ?? '', date: '', uncommitted: false, spec: l.spec || '', unit_price: l.unit_price_minor === null ? '' : fromMinor(l.unit_price_minor) })),
    });
  }, [data, f]);
  if (!data || !f) return <Spinner />;
  if (result) {
    return (
      <div className="stack-sm">
        <Notice tone="success" title={`Order ${result.order_code} ${result.order_status === 'confirmed' ? 'confirmed' : 'saved as draft'}`}>Linked to {data.number} revision {data.revision_no}. A retried click returns this same order.</Notice>
        {result.unconverted.length > 0 && <Notice tone="warn" title="Unconverted scope remains on the enquiry">{result.unconverted.map((l) => `${l.description}: ${l.remaining_qty === null ? 'quantity unknown' : `${qty(l.remaining_qty)} not ordered`}`).join(' · ')}. Keep it open, or mark it lost on the enquiry.</Notice>}
        <div className="row"><Button variant="primary" to={`/orders/${result.order_id}`}>Open {result.order_code}</Button></div>
      </div>
    );
  }
  const setLine = (i, p) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const submit = (confirm) => save.run(async (key) => {
    const res = await api.post(`/quote-revisions/${r.id}/convert`, {
      confirm, po_reference: f.po_reference, received_date: f.received_date, confirmation_type: f.confirmation_type, confirmation_note: f.confirmation_note, confirmation_document_id: f.doc?.id,
      payment_terms: f.payment_terms, delivery_address: f.delivery_address, shipping_mode: f.shipping_mode, expired_terms_confirmed: f.expired_terms_confirmed, expired_note: f.expired_note,
      confirm_duplicate_po: f.confirm_duplicate_po,
      lines: f.lines.filter((l) => Number(l.qty) > 0).map((l) => ({ index: l.index, qty: Number(l.qty), spec: l.spec, unit_price: l.unit_price, ...(l.uncommitted ? { commitment_state: 'uncommitted' } : { original_commitment_date: l.date }) })),
    }, { key });
    setResult(res);
    onDone();
    return res;
  });
  const dupPo = save.error?.code === 'duplicate_po';
  return (
    <div className="stack-sm">
      <div className="small muted">Customer: <strong>{enquiry.customer_name}</strong>{enquiry.contact_name ? ` · contact ${enquiry.contact_name}` : ''} · currency {data.currency} · documents are linked by reference, not re-uploaded.</div>
      {data.expired && (
        <Notice tone="warn" title={`This quotation expired on ${date(data.validity_date)}`}>
          {can('quotes.expired_override') ? (
            <div className="stack-xs mt-8">
              <Checkbox label="The customer has confirmed they accept these terms" checked={f.expired_terms_confirmed} onChange={(v) => setF({ ...f, expired_terms_confirmed: v })} />
              <Input placeholder="Who confirmed, and when" value={f.expired_note} onChange={(e) => setF({ ...f, expired_note: e.target.value })} />
              {(save.fields.expired_terms_confirmed || save.fields.expired_note) && <span className="small danger-text">{save.fields.expired_terms_confirmed || save.fields.expired_note}</span>}
            </div>
          ) : 'Only the coordinator or management can convert an expired quotation after confirming the terms.'}
        </Notice>
      )}
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Item</th><th className="num">Quoted</th><th className="num">Already converted</th><th style={{ width: 110 }}>Accepted qty</th><th style={{ width: 130 }}>Net unit price</th><th style={{ width: 210 }}>Committed dispatch date</th></tr></thead>
          <tbody>
            {data.conversion.map((l, i) => (
              <tr key={l.index}>
                <td><strong>{l.product_code || ''}</strong> {l.description}<Input className="sm mt-8" placeholder="Specification / variant" value={f.lines[i].spec} onChange={(e) => setLine(i, { spec: e.target.value })} /></td>
                <td className="num">{qty(l.qty, l.unit)}</td>
                <td className="num">{l.converted_qty ? qty(l.converted_qty) : '—'}</td>
                <td><Input type="number" min={0} max={l.remaining_qty ?? undefined} value={f.lines[i].qty} onChange={(e) => setLine(i, { qty: e.target.value })} invalid={Boolean(save.fields[`lines.${i}.qty`] || save.fields[`lines.${i}.confirmed_qty`])} /></td>
                <td><Input inputMode="decimal" value={f.lines[i].unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></td>
                <td>
                  <Input type="date" disabled={f.lines[i].uncommitted} value={f.lines[i].date} onChange={(e) => setLine(i, { date: e.target.value })} invalid={Boolean(save.fields[`lines.${i}.original_commitment_date`])} />
                  <Checkbox label="Not agreed yet" checked={f.lines[i].uncommitted} onChange={(v) => setLine(i, { uncommitted: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Object.entries(save.fields).filter(([k]) => k.startsWith('lines')).map(([k, v]) => <div key={k} className="small danger-text">{v}</div>)}
      <div className="small muted">Accepting less than quoted is fine — the unconverted remainder stays visible on the enquiry. A quotation delivery estimate is not a dispatch commitment.</div>
      <div className="form-grid three">
        <Field label="Customer PO reference" optional error={save.fields.po_reference}><Input value={f.po_reference} onChange={(e) => setF({ ...f, po_reference: e.target.value })} /></Field>
        <Field label="Order received" required error={save.fields.received_date}><Input type="date" max={todayLocal()} value={f.received_date} onChange={(e) => setF({ ...f, received_date: e.target.value })} /></Field>
        <Field label="Confirmation"><Segmented value={f.confirmation_type} onChange={(v) => setF({ ...f, confirmation_type: v })} options={[{ value: 'po', label: 'PO' }, { value: 'written', label: 'Written' }, { value: 'verbal', label: 'Verbal' }]} /></Field>
        <Field label="PO / acceptance document" optional><FilePick value={f.doc} onChange={(doc) => setF({ ...f, doc })} entityType="enquiry" entityId={enquiry.id} label="Attach PO" /></Field>
        <Field label={f.confirmation_type === 'verbal' ? 'Who confirmed, and when' : 'Confirmation note'} optional={f.confirmation_type !== 'verbal'}><Input value={f.confirmation_note} onChange={(e) => setF({ ...f, confirmation_note: e.target.value })} /></Field>
        <Field label="Payment terms" optional><Input value={f.payment_terms} onChange={(e) => setF({ ...f, payment_terms: e.target.value })} /></Field>
        <Field label="Delivery address" optional className="full"><Input value={f.delivery_address} onChange={(e) => setF({ ...f, delivery_address: e.target.value })} /></Field>
      </div>
      {dupPo && <Notice tone="warn" title="Possible duplicate order">{save.error.message}<div className="mt-8"><Checkbox label="This is a different order — continue" checked={f.confirm_duplicate_po} onChange={(v) => setF({ ...f, confirm_duplicate_po: v })} /></div></Notice>}
      {save.fields.customer_id && <Notice tone="danger">{save.fields.customer_id}</Notice>}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <div className="row"><Button onClick={() => submit(false)} loading={save.saving}>Save as draft</Button><Button variant="cta" onClick={() => submit(true)} loading={save.saving}>Confirm order</Button></div>
      </div>
    </div>
  );
}

function OpportunityForm({ enquiry: e, onSaved }) {
  const meta = useMeta();
  const { can } = useAuth();
  const save = useSave();
  const [f, setF] = useState({
    title: e.title || '', est_value: e.est_value_minor ? fromMinor(e.est_value_minor) : '', est_currency: e.est_currency || 'INR', probability: e.probability ?? '',
    temperature: e.temperature || '', expected_decision_date: e.expected_decision_date || '', campaign_id: e.campaign_id ? String(e.campaign_id) : '',
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  return (
    <form className="stack-sm" onSubmit={(ev) => { ev.preventDefault(); save.run(async () => {
      const body = { ...f, version: e.version, campaign_id: f.campaign_id || null, probability: f.probability === '' ? null : Number(f.probability) };
      if (!can('values.view')) { delete body.est_value; delete body.est_currency; }
      await api.put(`/enquiries/${e.id}`, body);
      onSaved();
    }); }}>
      {save.conflict && <Notice tone="warn">Someone else updated this enquiry — reload to see their changes.</Notice>}
      <div className="form-grid">
        <Field label="Title" optional className="full" error={save.fields.title}><Input value={f.title} onChange={(x) => set({ title: x.target.value })} placeholder="e.g. Energy meters for the new plant" maxLength={160} /></Field>
        {can('values.view') && <Field label="Estimated value (before tax)" optional error={save.fields.est_value} hint="Replaced by the issued quotation value once quoted"><div className="row"><Input inputMode="decimal" value={f.est_value} onChange={(x) => set({ est_value: x.target.value })} /><Select value={f.est_currency} onChange={(x) => set({ est_currency: x.target.value })} options={CURRENCIES} style={{ width: 96 }} aria-label="Currency" /></div></Field>}
        <Field label="Probability %" optional error={save.fields.probability} hint="Blank uses the stage default"><Input type="number" min={0} max={100} step={5} value={f.probability} onChange={(x) => set({ probability: x.target.value })} /></Field>
        <Field label="Temperature" optional><Select value={f.temperature} onChange={(x) => set({ temperature: x.target.value })} placeholder="Not set" options={TEMPERATURES} /></Field>
        <Field label="Decision expected by" optional error={save.fields.expected_decision_date}><Input type="date" value={f.expected_decision_date} onChange={(x) => set({ expected_decision_date: x.target.value })} /></Field>
        {meta.campaigns.length > 0 && <Field label="Campaign / event" optional className="full" error={save.fields.campaign_id}><Select value={f.campaign_id} onChange={(x) => set({ campaign_id: x.target.value })} placeholder="None" options={meta.campaigns.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>}
      </div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

export { relDay };
