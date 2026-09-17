import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES, COMPLAINT_SEVERITIES, WARRANTY_STATUSES, RESOLUTION_TYPES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { date, dateTime, number } from '../lib/format.js';
import { Badge, Button, Card, ErrorState, Field, Input, KV, Modal, OptionBadge, PageHeader, Select, Spinner, Textarea, useToast } from '../components/ui.jsx';
import { AttachmentList, LogActivityModal, PendingAttachments, UserSelect } from '../components/domain.jsx';

export default function ComplaintDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { can } = useAuth();
  const { data: k, error, reload } = useApi(`/complaints/${id}`);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!k) return <Spinner />;
  const editable = can('complaints.edit');
  const closed = ['resolved', 'closed'].includes(k.status);

  const update = async (patch, msg) => {
    try {
      await api.put(`/complaints/${k.id}`, patch);
      toast.success(msg || 'Updated');
      reload();
      setModal(null);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Complaints & service', to: '/complaints' }, { label: k.number }]}
        title={<span className="row wrap" style={{ gap: 10 }}>{k.number}<OptionBadge list={COMPLAINT_STATUSES} value={k.status} /><OptionBadge list={COMPLAINT_SEVERITIES} value={k.severity} /><OptionBadge list={WARRANTY_STATUSES} value={k.warranty_status} /></span>}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Link to={`/customers/${k.customer_id}`}>{k.customer_name}</Link>
          <span className="muted small">{labelOf(COMPLAINT_CATEGORIES, k.category)} · registered {date(k.created_at)} by {k.created_by_name}</span>
          {k.order_number && <Link className="small" to={`/orders/${k.order_id}`}>{k.order_number}</Link>}
        </span>}
        actions={editable && (
          <>
            <Button icon="phone" onClick={() => setModal({ log: true })}>Log call</Button>
            {!closed && <Button icon="edit" onClick={() => setModal({ edit: true })}>Update</Button>}
            {!closed && <Button variant="primary" icon="check" onClick={() => setModal({ resolve: true })}>Resolve</Button>}
            {k.status === 'resolved' && <Button onClick={() => update({ status: 'closed' }, 'Complaint closed')}>Close</Button>}
            {closed && !k.feedback_rating && <Button icon="star" onClick={() => setModal({ feedback: true })}>Record feedback</Button>}
          </>
        )}
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(280px, 1fr)', alignItems: 'start' }}>
        <div className="stack">
          <Card title="The problem">
            <p style={{ whiteSpace: 'pre-wrap' }}>{k.description}</p>
            {k.attachments.length > 0 && <><div className="divider" /><div className="small muted">Photos, videos and voice notes from site</div><AttachmentList items={k.attachments} /></>}
          </Card>

          <Card title="Service progress">
            <div className="stack">
              <div className="row wrap" style={{ gap: 12 }}>
                {['open', 'assigned', 'site_visit', 'in_progress', 'resolved', 'closed'].map((s, i, arr) => {
                  const done = arr.indexOf(k.status) >= i || (k.status === 'awaiting_parts' && i <= 3);
                  return (
                    <span key={s} className="row" style={{ gap: 6, opacity: done ? 1 : 0.45 }}>
                      <Badge color={done ? 'green' : 'slate'} size="sm">{i + 1}</Badge>
                      <span className="small">{labelOf(COMPLAINT_STATUSES, s)}</span>
                    </span>
                  );
                })}
              </div>
              <div className="divider" style={{ margin: 0 }} />
              <KV items={[
                ['Assigned technician', k.assigned_to_name],
                ['Site visit', k.site_visit_date ? `${date(k.site_visit_date)}${k.site_visit_notes ? ` — ${k.site_visit_notes}` : ''}` : 'Not scheduled'],
                ['Root cause', k.root_cause],
                ['Resolution', k.resolution_type && `${labelOf(RESOLUTION_TYPES, k.resolution_type)}${k.resolution_notes ? ` — ${k.resolution_notes}` : ''}`],
                ['Resolved on', k.resolved_at ? `${dateTime(k.resolved_at)} (${number((new Date(k.resolved_at) - new Date(k.created_at)) / 86400000, 1)} days)` : null],
                ['Closed on', k.closed_at ? dateTime(k.closed_at) : null],
                ['Customer feedback', k.feedback_rating ? `${'★'.repeat(k.feedback_rating)}${'☆'.repeat(5 - k.feedback_rating)}${k.feedback_comment ? ` — “${k.feedback_comment}”` : ''}` : null],
              ]} />
            </div>
          </Card>

          {k.activities.length > 0 && (
            <Card title="Conversations" flush>
              {k.activities.map((a) => (
                <div key={a.id} className="action-row">
                  <span className="grow small">{a.summary}{a.customer_response && <div className="tiny muted">Response: {a.customer_response}</div>}</span>
                  <span className="tiny muted nowrap">{date(a.activity_date)} · {a.user_name}</span>
                </div>
              ))}
            </Card>
          )}

          {k.history.length > 0 && (
            <Card title="Change log" flush>
              {k.history.map((h) => (
                <div key={h.id} className="action-row small">
                  <span className="grow">{Object.entries(h.details || {}).map(([key, v]) => `${key.replace(/_/g, ' ')}: ${v}`).join(' · ')}</span>
                  <span className="tiny muted nowrap">{date(h.created_at)} · {h.user_name}</span>
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="stack">
          <Card title="Product & warranty">
            <KV items={[
              ['Product', k.product_name],
              ['SKU', k.sku],
              ['Category', k.category_name],
              ['Serial number', k.serial_number && <span className="mono">{k.serial_number}</span>],
              ['Invoice', k.invoice_number && `${k.invoice_number}${k.invoice_date ? ` · ${date(k.invoice_date)}` : ''}`],
              ['Installation date', k.installation_date && date(k.installation_date)],
              ['Warranty', labelOf(WARRANTY_STATUSES, k.warranty_status)],
            ]} />
          </Card>
          <Card title="Customer">
            <KV items={[
              ['Company', <Link to={`/customers/${k.customer_id}`}>{k.customer_name}</Link>],
              ['City', k.city],
              ['Contact', k.contact_name && `${k.contact_name}${k.contact_phone ? ` · ${k.contact_phone}` : ''}`],
            ]} />
          </Card>
          {k.same_product.length > 0 && (
            <Card title="Other complaints on this product" sub={`${k.same_product.length} in total`} flush>
              {k.same_product.map((o) => (
                <Link key={o.id} to={`/complaints/${o.id}`} className="action-row">
                  <span className="grow small">{o.number}<div className="tiny muted">{o.customer_name} · {labelOf(COMPLAINT_CATEGORIES, o.category)}</div></span>
                  <OptionBadge list={COMPLAINT_STATUSES} value={o.status} size="sm" />
                </Link>
              ))}
            </Card>
          )}
        </div>
      </div>

      <UpdateModal open={Boolean(modal?.edit)} onClose={() => setModal(null)} complaint={k} onSaved={reload} />
      <ResolveModal open={Boolean(modal?.resolve)} onClose={() => setModal(null)} complaint={k} onSaved={reload} />
      <FeedbackModal open={Boolean(modal?.feedback)} onClose={() => setModal(null)} complaint={k} onSaved={reload} />
      <LogActivityModal open={Boolean(modal?.log)} onClose={() => setModal(null)} onSaved={reload} customerId={k.customer_id} complaintId={k.id} />
    </div>
  );
}

function UpdateModal({ open, onClose, complaint, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [files, setFiles] = useState([]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  useEffect(() => {
    if (!open) return;
    setForm({
      status: complaint.status, assigned_to: complaint.assigned_to || '', severity: complaint.severity,
      site_visit_date: complaint.site_visit_date || '', site_visit_notes: complaint.site_visit_notes || '', warranty_status: complaint.warranty_status,
    });
  }, [open, complaint]);
  const save = async () => {
    try {
      await api.put(`/complaints/${complaint.id}`, { ...form, attachment_ids: files.map((x) => x.id) });
      toast.success('Complaint updated');
      onSaved();
      onClose();
      setFiles([]);
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Update ${complaint.number}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Status"><Select value={form.status} onChange={set('status')} options={COMPLAINT_STATUSES.filter((s) => !['resolved', 'closed'].includes(s.value))} /></Field>
        <Field label="Severity"><Select value={form.severity} onChange={set('severity')} options={COMPLAINT_SEVERITIES} /></Field>
        <Field label="Assigned technician"><UserSelect roles={['service', 'quality']} value={form.assigned_to} onChange={set('assigned_to')} /></Field>
        <Field label="Warranty status"><Select value={form.warranty_status} onChange={set('warranty_status')} options={WARRANTY_STATUSES} /></Field>
        <Field label="Site visit date"><Input type="date" value={form.site_visit_date} onChange={set('site_visit_date')} /></Field>
        <Field label="Site visit notes" className="full"><Textarea rows={2} value={form.site_visit_notes} onChange={set('site_visit_notes')} /></Field>
        <Field label="Add photos / videos" className="full"><PendingAttachments value={files} onChange={setFiles} kind="photo" accept="image/*,video/*,application/pdf" /></Field>
      </div>
    </Modal>
  );
}

function ResolveModal({ open, onClose, complaint, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ status: 'resolved' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    try {
      await api.put(`/complaints/${complaint.id}`, form);
      toast.success('Complaint resolved — sales will collect feedback');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Resolve ${complaint.number}`} subtitle="Root cause and resolution are mandatory so quality can act on trends"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Mark resolved</Button></>}>
      <div className="form-grid">
        <Field label="Root cause" required className="full"><Textarea rows={2} value={form.root_cause} onChange={set('root_cause')} placeholder="e.g. Firmware watchdog bug causing modem hang" /></Field>
        <Field label="Resolution" required><Select value={form.resolution_type} onChange={set('resolution_type')} placeholder="Select…" options={RESOLUTION_TYPES} /></Field>
        <Field label="Resolved by"><UserSelect roles={['service', 'quality']} value={form.assigned_to} onChange={set('assigned_to')} placeholder={complaint.assigned_to_name} /></Field>
        <Field label="What was done" className="full"><Textarea rows={2} value={form.resolution_notes} onChange={set('resolution_notes')} /></Field>
      </div>
    </Modal>
  );
}

function FeedbackModal({ open, onClose, complaint, onSaved }) {
  const toast = useToast();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Customer feedback"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
        try {
          await api.put(`/complaints/${complaint.id}`, { feedback_rating: rating, feedback_comment: comment });
          toast.success('Feedback recorded');
          onSaved();
          onClose();
        } catch (err) {
          toast.error(err.message);
        }
      }}>Save</Button></>}>
      <div className="stack">
        <Field label="Satisfaction">
          <div className="row">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className={`btn ${rating >= n ? 'primary' : ''} sm`} onClick={() => setRating(n)}>{n}★</button>
            ))}
          </div>
        </Field>
        <Field label="Comment"><Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
