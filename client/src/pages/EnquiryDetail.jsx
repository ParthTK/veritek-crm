// One enquiry: what they asked for, where it stands, its quotations and orders, and the next follow-up.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ENQUIRY_STAGES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, qty } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Field, Input, Modal, Notice, PageHeader, Popover, SaveStatus, Select, Spinner, Textarea, useToast, Facts,
} from '../components/ui.jsx';
import {
  StageBadge, QuoteBadge, DueBadge, Timeline, Attachments, UserSelect, DateField, PurposeInput, Money, JourneyCard, ReplyBadge,
} from '../components/domain.jsx';
import { FollowupForm, RescheduleForm } from '../components/forms.jsx';
import StageForm from '../components/StageForm.jsx';

export default function EnquiryDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(`/enquiries/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { enquiry: e, lines, quotations, orders, tasks, activities, history, attachments } = data;
  const openTasks = tasks.filter((t) => t.status === 'open');
  const edit = can('enquiries.edit');
  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const newQuotation = async () => {
    try {
      const res = await api.post('/quotations', { enquiry_id: e.id });
      navigate(`/quotations/${res.quotation_id}/edit`);
    } catch (err) {
      toast.error(err.message);
    }
  };
  const timeline = [
    ...activities.map((a) => ({ key: `a${a.id}`, at: a.occurred_at, entered_at: a.entered_at, group: a.kind === 'quotation' ? 'quotations' : a.customer_contact ? (a.channel === 'email' ? 'emails' : 'calls') : 'internal', icon: a.channel, title: `${a.channel_label} — ${a.outcome_label || a.outcome}`, detail: a.note, actor: a.entered_by_name, reported_by: a.reported_by_name, contact: a.contact_name, backdated: a.backdated, customer_contact: Boolean(a.customer_contact) })),
    ...history.filter((h) => ['stage_changed', 'reopened', 'created', 'no_followup', 'owner_changed'].includes(h.kind)).map((h) => ({
      key: `h${h.id}`, at: h.occurred_at || h.created_at, entered_at: h.created_at, group: 'enquiries', icon: 'enquiry', actor: h.actor_name, detail: h.note,
      title: h.kind === 'stage_changed' ? `${labelOf(ENQUIRY_STAGES, h.data?.from)} → ${labelOf(ENQUIRY_STAGES, h.data?.to)}${h.data?.reason ? ` (${h.data.reason})` : ''}` : h.kind === 'created' ? 'Enquiry received' : h.kind === 'reopened' ? 'Reopened' : h.kind === 'no_followup' ? 'No further follow-up' : 'Reassigned',
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Enquiries', to: '/enquiries' }, { label: e.code }]}
        title={<><Link to={`/customers/${e.customer_id}`}>{e.customer_name}</Link> <StageBadge stage={e.stage} /> <ReplyBadge replied={Boolean(e.first_response_at)} size="md" /></>}
        subtitle={[e.contact_name && `${e.contact_name}${e.contact_phone ? ` · ${e.contact_phone}` : ''}`, `Assigned to ${e.owner_name}`].filter(Boolean).join('  ·  ')}
        actions={edit && (e.open ? (
          <>
            {can('quotes.edit') && !quotations.some((q) => q.revisions.some((r) => r.status === 'draft')) && <Button icon="plus" onClick={newQuotation}>New quotation</Button>}
            <Popover trigger={({ toggle }) => <Button variant="primary" iconRight="chevronDown" onClick={toggle}>Change status</Button>}>
              {({ close }) => (
                <div className="menu">
                  {ENQUIRY_STAGES.filter((s) => s.value !== e.stage && s.value !== 'quote_sent').map((s) => (
                    <button key={s.value} type="button" onClick={() => { close(); setModal({ type: 'stage', stage: s.value }); }}><Badge size="sm" tone={s.tone}>{s.label}</Badge></button>
                  ))}
                </div>
              )}
            </Popover>
          </>
        ) : <Button onClick={() => setModal({ type: 'reopen' })}>Reopen</Button>)}
      />
      <JourneyCard enquiryId={e.id} version={e.version} />
      {e.stage === 'lost' && <Notice tone="danger" title={`Lost — ${e.lost_reason || 'no reason recorded'}`}>{e.lost_note}</Notice>}
      {e.stage === 'cancelled' && <Notice tone="info" title={`Cancelled — ${e.cancel_reason}`}>{e.cancel_note}</Notice>}
      {e.stage === 'on_hold' && <Notice tone="warn" title={`On hold until ${date(e.hold_review_date)}`}>{e.hold_reason}</Notice>}

      <div className="split wide">
        <div className="stack">
          <Card title="What they need" flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th className="num">Quantity</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.product_code && <strong>{l.product_code} </strong>}{l.product_name || l.requirement}{l.spec && <div className="sub">{l.spec}</div>}</td>
                      <td className="num">{l.qty === null ? <span className="muted">Not known</span> : qty(l.qty, l.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {quotations.length > 0 && (
            <Card title="Quotations" flush>
              <div className="alert-list">
                {quotations.map((q) => {
                  const r = q.revisions[0];
                  return (
                    <Link key={q.id} to={`/quotations/${q.id}`} className="alert-row">
                      <span className="who">{q.number}</span>
                      <span className="grow" />
                      {can('values.view') && <span className="small"><Money minor={r.total_minor} currency={r.currency} empty="—" /></span>}
                      <QuoteBadge status={r.status} size="sm" />
                    </Link>
                  );
                })}
              </div>
            </Card>
          )}
          {orders.length > 0 && (
            <Card title="Orders" flush>
              <div className="alert-list">
                {orders.map((o) => <Link key={o.id} to={`/orders/${o.id}`} className="alert-row"><span className="who">{o.code}</span><span className="small muted grow">{date(o.received_date)}{o.po_reference ? ` · PO ${o.po_reference}` : ''}</span></Link>)}
              </div>
            </Card>
          )}
          <Card title="History"><Timeline items={timeline} /></Card>
        </div>

        <div className="stack sticky-side">
          <Card title="Next action" actions={edit && e.open && <Button size="sm" variant="ghost" icon="plus" onClick={() => setModal({ type: 'task' })}>Add</Button>}>
            {!openTasks.length && <div className="small muted">{e.open ? (e.no_followup_reason ? `No follow-up: ${e.no_followup_reason}` : 'None yet.') : 'Closed.'}</div>}
            <div className="stack-sm">
              {openTasks.map((t) => (
                <div key={t.id} className="m-card">
                  <div className="row between"><strong className="small">{t.purpose}</strong><DueBadge task={t} /></div>
                  <div className="tiny muted">{t.owner_name}</div>
                  {can('tasks.edit') && <div className="row"><Button size="xs" variant="primary" onClick={() => setModal({ type: 'complete', task: t })}>Update</Button><Button size="xs" onClick={() => setModal({ type: 'reschedule', task: t })}>Reschedule</Button></div>}
                </div>
              ))}
            </div>
          </Card>
          <Card title="Details" actions={edit && <Button size="sm" variant="ghost" icon="edit" onClick={() => setModal({ type: 'edit' })}>Edit</Button>}>
            <Facts items={[
              ['Enquiry', e.code],
              ['Received', e.received_unknown ? 'Not known' : dateTime(e.received_at)],
              ['Replied', e.first_response_at ? dateTime(e.first_response_at) : 'Not yet'],
              ['Source', `${e.source_label}${e.source_event ? ` — ${e.source_event}` : ''}`],
              e.campaign_id ? ['Exhibition', <Link to={`/campaigns/${e.campaign_id}`}>{e.campaign_name || 'Open'}</Link>] : null,
              ['Assigned to', e.owner_name],
              ['Notes', e.requirement_note],
            ]} />
          </Card>
          <Card title="Documents"><Attachments items={attachments} entityType="enquiry" entityId={e.id} onChange={reload} /></Card>
        </div>
      </div>

      <Modal open={modal?.type === 'stage'} onClose={() => setModal(null)} title={`Change status to “${labelOf(ENQUIRY_STAGES, modal?.stage)}”`}>
        {modal?.type === 'stage' && <StageForm enquiry={e} stage={modal.stage} hasTask={openTasks.length > 0} onSaved={() => done('Status updated')} />}
      </Modal>
      <Modal open={modal?.type === 'reopen'} size="sm" onClose={() => setModal(null)} title="Reopen enquiry">
        {modal?.type === 'reopen' && <ReopenForm enquiry={e} onSaved={() => done('Enquiry reopened')} />}
      </Modal>
      <Modal open={modal?.type === 'edit'} size="sm" onClose={() => setModal(null)} title="Edit enquiry">
        {modal?.type === 'edit' && <EditForm enquiry={e} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'complete'} onClose={() => setModal(null)} title="Update follow-up" subtitle={modal?.task?.purpose}>
        {modal?.type === 'complete' && <FollowupForm task={{ ...modal.task, enquiry_stage: e.stage, enquiry_code: e.code }} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'reschedule'} size="sm" onClose={() => setModal(null)} title="Reschedule">
        {modal?.type === 'reschedule' && <RescheduleForm task={modal.task} onSaved={() => done('Rescheduled')} />}
      </Modal>
      <Modal open={modal?.type === 'task'} size="sm" onClose={() => setModal(null)} title="Add next action">
        {modal?.type === 'task' && <TaskForm enquiry={e} onSaved={() => done('Next action added')} />}
      </Modal>
    </div>
  );
}

function EditForm({ enquiry: e, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ owner_id: e.owner_id, requirement_note: e.requirement_note || '' });
  return (
    <form className="stack-sm" onSubmit={(ev) => { ev.preventDefault(); save.run(async () => { await api.put(`/enquiries/${e.id}`, { ...f, version: e.version }); onSaved(); }); }}>
      {save.conflict && <Notice tone="warn">Someone else updated this enquiry. Reload to see their changes.</Notice>}
      <Field label="Assigned to" error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
      <Field label="Notes" optional error={save.fields.requirement_note}><Textarea rows={3} value={f.requirement_note} onChange={(ev) => setF({ ...f, requirement_note: ev.target.value })} maxLength={1000} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function ReopenForm({ enquiry, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ reason: '', stage: 'new', due_date: '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/enquiries/${enquiry.id}/reopen`, { reason: f.reason, stage: f.stage, next: { purpose: 'Follow up reopened enquiry', due_date: f.due_date, owner_id: enquiry.owner_id } }); onSaved(); }); }}>
      <Field label="Why reopen it?" required error={save.fields.reason}><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Field label="Status"><Select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} options={ENQUIRY_STAGES.filter((s) => s.open && s.value !== 'quote_sent')} /></Field>
      <DateField label="Follow up on" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date']} />
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Reopen</Button></div>
    </form>
  );
}

function TaskForm({ enquiry, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ purpose: '', due_date: '', owner_id: enquiry.owner_id });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post('/tasks', { ...f, enquiry_id: enquiry.id, kind: 'customer' }); onSaved(); }); }}>
      <Field label="Next action" required error={save.fields.purpose}><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
      <DateField label="Date" required value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields.due_date} />
      <Field label="Assigned to" required error={save.fields.owner_id}><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Add</Button></div>
    </form>
  );
}
