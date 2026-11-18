// One exhibition: the customers who visited and the enquiries it brought in.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CAMPAIGN_STATUSES, VISIT_OUTCOMES, labelOf, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, number, timeAgo, todayLocal } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, ErrorState, Field, Input, Modal, PageHeader, SaveStatus, Spinner, Stat, Textarea, useConfirm, useToast,
} from '../components/ui.jsx';
import { CustomerPicker, DateField, ReplyBadge, StageBadge } from '../components/domain.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';
import { CampaignForm, exhibitionDates } from './Campaigns.jsx';

function VisitForm({ campaign, visit, onClose, onSaved }) {
  const save = useSave();
  const today = todayLocal();
  const firstDay = campaign.start_date && campaign.start_date > today ? campaign.start_date : campaign.end_date && campaign.end_date < today ? campaign.end_date : today;
  const [f, setF] = useState({
    customer: visit ? { id: visit.customer_id, company_name: visit.customer_name } : null, visited_on: visit?.visited_on || firstDay, interest: visit?.interest || '', notes: visit?.notes || '',
  });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const submit = () => save.run(async () => {
    const body = { customer_id: f.customer?.id, visited_on: f.visited_on, interest: f.interest, notes: f.notes };
    const r = visit ? await api.put(`/campaigns/${campaign.id}/visits/${visit.id}`, body) : await api.post(`/campaigns/${campaign.id}/visits`, body);
    onSaved(r);
    return r;
  });
  return (
    <Modal open onClose={onClose} title={visit ? visit.customer_name : 'Add a visitor'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save</Button></>}>
      <div className="stack-sm">
        {!visit && (
          <Field label="Customer" required error={save.fields.customer_id} hint="New company? Add it under Customers first.">
            <CustomerPicker value={f.customer} onChange={(c) => set({ customer: c })} allowCreate={false} invalid={Boolean(save.fields.customer_id)} />
          </Field>
        )}
        <DateField label="Visited on" value={f.visited_on} onChange={(v) => set({ visited_on: v })} error={save.fields.visited_on} presets={false} />
        <Field label="Interested in" optional error={save.fields.interest}><Input value={f.interest} maxLength={200} onChange={(e) => set({ interest: e.target.value })} /></Field>
        <Field label="Notes" optional error={save.fields.notes}><Textarea rows={2} value={f.notes} maxLength={1000} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const quick = useQuickEntry();
  const { data, error, reload } = useApi(`/campaigns/${id}`);
  const [editing, setEditing] = useState(false);
  const [visitForm, setVisitForm] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { campaign: c, metrics: m, enquiries, visits } = data;
  const canRecord = can('campaigns.edit') || can('enquiries.edit');
  const raiseEnquiry = (customer) => quick.open('enquiry', { customer: customer || null, source_code: 'exhibition', campaign_id: String(c.id), source_event: c.name });
  const removeVisit = async (v) => {
    if (!(await confirm({ title: 'Remove this visitor?', message: `${v.customer_name} will no longer be listed for ${c.name}. Any enquiry stays as it is.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.del(`/campaigns/${c.id}/visits/${v.id}`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Exhibitions', to: '/campaigns' }, { label: c.name }]} title={c.name}
        eyebrow={<Badge size="sm" tone={toneOf(CAMPAIGN_STATUSES, c.status)}>{c.status_label}</Badge>}
        subtitle={[exhibitionDates(c), c.location].filter(Boolean).join(' · ')}
        actions={<>
          {can('campaigns.edit') && <Button icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          {can('enquiries.edit') && <Button variant="cta" icon="plus" onClick={() => raiseEnquiry(null)}>New enquiry</Button>}
        </>} />
      <div className="tiles">
        <Stat k="Customers visited" v={number(m.visitors)} />
        <Stat k="Enquiries generated" v={number(m.enquiries)} />
        <Stat k="Quoted" v={number(m.quoted)} />
        <Stat k="Won" v={number(m.won)} />
      </div>
      <Card title="Customers visited" flush actions={canRecord && <Button size="sm" variant="primary" icon="plus" onClick={() => setVisitForm({})}>Add visitor</Button>}>
        <DataTable rows={visits} columns={[
          { key: 'c', label: 'Customer', render: (v) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${v.customer_id}`} className="strong">{v.customer_name}</Link><span className="tiny muted">{v.city}</span></div> },
          { key: 'd', label: 'Visited', render: (v) => <span className="small nowrap">{date(v.visited_on)}</span> },
          { key: 'i', label: 'Interested in', render: (v) => <span className="small">{v.interest || <span className="muted">—</span>}{v.notes && <div className="tiny muted">{v.notes}</div>}</span> },
          { key: 'o', label: 'Enquiry', render: (v) => (v.enquiry_id ? <Link to={`/enquiries/${v.enquiry_id}`}><Badge size="sm" tone="green">{v.enquiry_code}</Badge></Link> : <Badge size="sm" tone={toneOf(VISIT_OUTCOMES, v.outcome)}>{labelOf(VISIT_OUTCOMES, v.outcome)}</Badge>) },
          canRecord && { key: 'a', label: '', render: (v) => (
            <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
              {!v.enquiry_id && can('enquiries.edit') && <Button size="xs" variant="primary" onClick={() => raiseEnquiry({ id: v.customer_id, company_name: v.customer_name })}>New enquiry</Button>}
              <Button size="xs" onClick={() => setVisitForm(v)}>Edit</Button>
              <Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${v.customer_name}`} onClick={() => removeVisit(v)} />
            </span>
          ) },
        ].filter(Boolean)} empty={<div className="muted small" style={{ padding: 12 }}>No visitors yet.</div>} />
      </Card>
      <Card title="Enquiries generated" flush>
        <DataTable rows={enquiries} onRowClick={(e) => navigate(`/enquiries/${e.id}`)} columns={[
          { key: 'cust', label: 'Customer', render: (e) => <><strong>{e.customer_name}</strong><div className="sub">{e.code}</div></> },
          { key: 'p', label: 'Product', render: (e) => <span className="small">{e.product}</span> },
          { key: 's', label: 'Status', render: (e) => <StageBadge stage={e.stage} size="sm" /> },
          { key: 'f', label: 'Reply', render: (e) => <ReplyBadge replied={Boolean(e.first_response_at)} /> },
          { key: 'o', label: 'Assigned to', render: (e) => <span className="small">{e.owner_name}</span> },
          { key: 'r', label: 'Received', render: (e) => <span className="small">{timeAgo(e.received_at)}</span> },
        ]} empty={<div className="muted small" style={{ padding: 12 }}>No enquiries yet.</div>} />
      </Card>
      {editing && <CampaignForm campaign={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {visitForm && <VisitForm campaign={c} visit={visitForm.id ? visitForm : null} onClose={() => setVisitForm(null)} onSaved={() => { setVisitForm(null); reload(); }} />}
    </div>
  );
}
