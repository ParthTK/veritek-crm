import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { COMPLAINT_STATUSES, COMPLAINT_SEVERITIES, WARRANTY_STATUSES } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, todayLocal } from '../lib/format.js';
import { Badge, Button, Card, ErrorState, Facts, Field, Input, Modal, Notice, PageHeader, SaveStatus, Select, Spinner, Textarea, useToast } from '../components/ui.jsx';
import { Attachments, DueBadge, OptionSelect, UserSelect, DateField, PurposeInput } from '../components/domain.jsx';
import { SeverityBadge, WarrantyBadge } from './Complaints.jsx';
import { FollowupForm } from '../components/forms.jsx';

export default function ComplaintDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useApi(`/complaints/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const k = data.complaint;
  const done = (m) => {
    toast.success(m);
    setModal(null);
    reload();
  };
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Complaints', to: '/complaints' }, { label: k.code }]} title={<>{k.code} · <Link to={`/customers/${k.customer_id}`}>{k.company_name}</Link></>}
        eyebrow={<><Badge tone={k.open ? 'amber' : 'green'}>{k.status_label}</Badge> <SeverityBadge value={k.severity} /> <WarrantyBadge value={k.warranty_status} /></>} subtitle={`${k.category} · received ${date(k.received_date, { year: true })} · owner ${k.owner_name} · ${k.age_days} day${k.age_days === 1 ? '' : 's'} ${k.open ? 'open' : 'to resolve'}`}
        actions={can('complaints.edit') && <>
          {k.open && <Button icon="map" onClick={() => setModal('visit')}>{k.site_visit_date ? 'Site visit details' : 'Plan site visit'}</Button>}
          {!k.open && <Button icon="star" onClick={() => setModal('feedback')}>{k.feedback_rating ? 'Edit feedback' : 'Record feedback'}</Button>}
          <Button variant="primary" onClick={() => setModal('update')}>Update status</Button>
        </>} />
      <div className="split">
        <div className="stack">
          <Card title="Reported">
            <div className="stack-sm">
              <div>{k.description}</div>
              <Facts items={[
                ['Reported by', k.contact_name ? `${k.contact_name}${k.contact_phone ? ` · ${k.contact_phone}` : ''}` : null],
                ['Order', k.order_id ? <Link to={`/orders/${k.order_id}`}>{k.order_code}</Link> : 'Not linked'],
                ['Product', k.product_id ? <Link to={`/products/${k.product_id}`}>{k.product}{k.product_name ? ` — ${k.product_name}` : ''}</Link> : k.product],
                ['Serial / batch', k.serial_batch || 'Not provided'],
                ['Original dispatch', k.dispatch_code],
                ['Invoice', [k.invoice_ref, k.invoice_date && date(k.invoice_date, { year: true })].filter(Boolean).join(' · ')],
                ['Installed', k.installation_date ? date(k.installation_date, { year: true }) : null],
                ['Warranty', <WarrantyBadge value={k.warranty_status} />],
                ['First response', k.first_response_at ? dateTime(k.first_response_at) : 'Not yet'],
              ]} />
            </div>
          </Card>
          <Card title="Investigation & resolution">
            <Facts items={[
              ['Confirmed root cause', k.root_cause ? `${k.root_cause}${k.root_cause_note ? ` — ${k.root_cause_note}` : ''}` : 'Not established yet'],
              ['Resolution action', k.resolution],
              ['Resolution summary', k.resolution_summary],
              ['Resolved', k.resolved_date ? date(k.resolved_date, { year: true }) : null],
              ['Site visit', k.site_visit_date ? `${date(k.site_visit_date, { year: true })}${k.site_visit_notes ? ` — ${k.site_visit_notes}` : ''}` : null],
              ['Customer rating', k.feedback_rating ? `${'★'.repeat(k.feedback_rating)}${'☆'.repeat(5 - k.feedback_rating)} (${k.feedback_rating}/5)` : null],
              ['Customer feedback', k.customer_feedback],
              ['Return / replacement', [k.return_reference, k.replacement_order_code && <Link key="r" to={`/orders/${k.replacement_order_id}`}>replacement {k.replacement_order_code}</Link>].filter(Boolean)],
            ]} />
            <div className="tiny muted mt-8">Returns and replacements reference the original shipment — it is never deleted or reduced.</div>
          </Card>
          <Card title="Contacts & notes">
            {data.activities.map((a) => <div key={a.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><strong>{dateTime(a.occurred_at)}</strong> · {a.channel_label} · {a.outcome_label} {a.note && `— ${a.note}`}</div>)}
            {!data.activities.length && <div className="muted small">No contact recorded yet.</div>}
          </Card>
        </div>
        <div className="stack">
          <Card title="Next action">
            {data.tasks.filter((t) => t.status === 'open').map((t) => (
              <div key={t.id} className="m-card"><div className="row between"><span className="small strong">{t.purpose}</span><DueBadge task={t} /></div><div className="tiny muted">{t.owner_name}</div>
                {can('tasks.edit') && <Button size="xs" onClick={() => setModal({ task: t })}>Record outcome</Button>}</div>
            ))}
            {!data.tasks.some((t) => t.status === 'open') && <div className="muted small">{k.open ? (k.status === 'awaiting_customer' ? `Waiting for the customer — review ${date(k.review_date)}` : 'No next action set.') : 'Closed.'}</div>}
          </Card>
          <Card title="Documents"><Attachments items={data.attachments} entityType="complaint" entityId={k.id} onChange={reload} /></Card>
          {data.same_product?.length > 0 && (
            <Card title="Other complaints on this product">
              <div className="stack-xs">{data.same_product.map((x) => <Link key={x.id} to={`/complaints/${x.id}`} className="small"><strong>{x.code}</strong> · {x.company_name} · {x.category} · {date(x.received_date)}</Link>)}</div>
            </Card>
          )}
          {data.history?.length > 0 && (
            <Card title="History">
              <div className="stack-xs">{data.history.map((h) => <div key={h.id} className="small"><span className="muted">{dateTime(h.created_at)}</span> · {h.kind.replace(/_/g, ' ')}{h.actor_name ? ` · ${h.actor_name}` : ''}{h.note ? <div className="tiny muted">{h.note}</div> : null}</div>)}</div>
            </Card>
          )}
        </div>
      </div>
      <Modal open={modal === 'visit'} onClose={() => setModal(null)} title="Site visit" subtitle="Planning a visit creates a task for the owner on that date">
        {modal === 'visit' && <VisitForm k={k} onSaved={() => done('Site visit saved')} />}
      </Modal>
      <Modal open={modal === 'feedback'} size="sm" onClose={() => setModal(null)} title="Customer feedback">
        {modal === 'feedback' && <FeedbackForm k={k} onSaved={() => done('Feedback saved')} />}
      </Modal>
      <Modal open={modal === 'update'} onClose={() => setModal(null)} title="Update complaint">
        {modal === 'update' && <UpdateForm k={k} hasTask={data.tasks.some((t) => t.status === 'open')} onSaved={() => done('Complaint updated')} />}
      </Modal>
      <Modal open={Boolean(modal?.task)} onClose={() => setModal(null)} title="Record outcome">
        {modal?.task && <FollowupForm task={modal.task} onSaved={() => done('Recorded')} />}
      </Modal>
    </div>
  );
}

function UpdateForm({ k, hasTask, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ severity: k.severity || 'medium', warranty_status: k.warranty_status || 'unknown', status: k.status, root_cause_code: k.root_cause_code || '', root_cause_note: k.root_cause_note || '', resolution_code: k.resolution_code || '', resolution_summary: k.resolution_summary || '', resolved_date: k.resolved_date || todayLocal(), customer_feedback: k.customer_feedback || '', review_date: k.review_date || '', return_reference: k.return_reference || '', purpose: '', due_date: '', owner_id: k.owner_id });
  const closing = ['resolved', 'closed'].includes(f.status);
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => {
      await api.put(`/complaints/${k.id}`, { ...f, version: k.version, next: f.due_date ? { purpose: f.purpose, due_date: f.due_date, owner_id: f.owner_id } : undefined });
      onSaved();
    }); }}>
      <div className="form-grid three">
        <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={COMPLAINT_STATUSES} /></Field>
        <Field label="Severity" error={save.fields.severity}><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} options={COMPLAINT_SEVERITIES} /></Field>
        <Field label="Warranty" error={save.fields.warranty_status}><Select value={f.warranty_status} onChange={(e) => setF({ ...f, warranty_status: e.target.value })} options={WARRANTY_STATUSES} /></Field>
      </div>
      <div className="form-grid">
        <Field label="Confirmed root cause" optional hint="Only once established — not the reported symptom"><OptionSelect category="complaint_root_cause" value={f.root_cause_code} onChange={(v) => setF({ ...f, root_cause_code: v })} placeholder="Not established" /></Field>
        <Field label="Root cause note" optional error={save.fields.root_cause_note}><Input value={f.root_cause_note} onChange={(e) => setF({ ...f, root_cause_note: e.target.value })} /></Field>
      </div>
      {f.status === 'awaiting_customer' && <DateField label="Review date" required value={f.review_date} onChange={(v) => setF({ ...f, review_date: v })} error={save.fields.review_date} />}
      {closing && (
        <div className="form-grid">
          <Field label="Resolution action" required error={save.fields.resolution_code}><OptionSelect category="complaint_resolution" value={f.resolution_code} onChange={(v) => setF({ ...f, resolution_code: v })} /></Field>
          <Field label="Resolved on" required><Input type="date" value={f.resolved_date} onChange={(e) => setF({ ...f, resolved_date: e.target.value })} /></Field>
          <Field label="Resolution summary" required className="full" error={save.fields.resolution_summary}><Textarea rows={2} value={f.resolution_summary} onChange={(e) => setF({ ...f, resolution_summary: e.target.value })} /></Field>
          <Field label="Customer feedback / acceptance" optional className="full"><Input value={f.customer_feedback} onChange={(e) => setF({ ...f, customer_feedback: e.target.value })} /></Field>
          <Field label="Return / replacement reference" optional className="full"><Input value={f.return_reference} onChange={(e) => setF({ ...f, return_reference: e.target.value })} /></Field>
        </div>
      )}
      {!closing && f.status !== 'awaiting_customer' && (
        <>
          <div className="small muted">{hasTask ? 'A next action is already open — add another only if needed.' : 'An open complaint needs a next action, date and owner.'}</div>
          <div className="form-grid">
            <Field label="Next action" className="full"><PurposeInput value={f.purpose} onChange={(v) => setF({ ...f, purpose: v })} /></Field>
            <DateField label="Due" value={f.due_date} onChange={(v) => setF({ ...f, due_date: v })} error={save.fields['next.due_date']} />
            <Field label="Owner"><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
          </div>
        </>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function VisitForm({ k, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ site_visit_date: k.site_visit_date || '', site_visit_notes: k.site_visit_notes || '', owner_id: k.owner_id });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/complaints/${k.id}`, { version: k.version, site_visit_date: f.site_visit_date || null, site_visit_notes: f.site_visit_notes, next: f.site_visit_date && f.site_visit_date !== k.site_visit_date ? { purpose: 'Site visit', due_date: f.site_visit_date, owner_id: f.owner_id } : undefined }); onSaved(); }); }}>
      <DateField label="Visit date" value={f.site_visit_date} onChange={(v) => setF({ ...f, site_visit_date: v })} error={save.fields.site_visit_date} presets={false} />
      <Field label="Engineer / owner"><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} filter={(p) => ['service', 'admin', 'coordinator', 'production', 'sales'].includes(p.group)} /></Field>
      <Field label="Findings at site" optional error={save.fields.site_visit_notes}><Textarea rows={3} value={f.site_visit_notes} onChange={(e) => setF({ ...f, site_visit_notes: e.target.value })} maxLength={1000} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function FeedbackForm({ k, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ feedback_rating: k.feedback_rating || '', customer_feedback: k.customer_feedback || '' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.put(`/complaints/${k.id}`, { version: k.version, ...f }); onSaved(); }); }}>
      <Field label="How satisfied is the customer?" error={save.fields.feedback_rating}>
        <div className="row" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((n) => <Button key={n} size="sm" variant={Number(f.feedback_rating) === n ? 'primary' : undefined} onClick={() => setF({ ...f, feedback_rating: n })} aria-pressed={Number(f.feedback_rating) === n}>{'★'.repeat(n)}</Button>)}
        </div>
      </Field>
      <Field label="What they said" optional><Textarea rows={2} value={f.customer_feedback} onChange={(e) => setF({ ...f, customer_feedback: e.target.value })} maxLength={1000} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

export { Notice };
