// One exhibition or event: the customers met there, the enquiries it generated, its funnel from enquiry to
// order, follow-up by salesperson, and cost against order value.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CAMPAIGN_STATUSES, VISIT_OUTCOMES, labelOf, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, number, pct, compactByCurrency, compactMoney, downloadCsv } from '../lib/format.js';
import {
  Badge, Button, Card, DataTable, ErrorState, Facts, Field, Input, Modal, PageHeader, SaveStatus, Select, Spinner, Stat, Textarea, useConfirm, useToast,
} from '../components/ui.jsx';
import { CustomerPicker, DateField, Money, ReplyBadge, StageBadge, UserSelect } from '../components/domain.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';
import { BarChartH } from '../components/charts.jsx';
import { CampaignForm } from './Campaigns.jsx';

function VisitForm({ campaign, visit, onClose, onSaved }) {
  const save = useSave();
  const [f, setF] = useState(() => ({
    customer: visit ? { id: visit.customer_id, company_name: visit.customer_name } : null,
    visited_on: visit?.visited_on || (campaign.start_date && campaign.start_date > new Date().toISOString().slice(0, 10) ? campaign.start_date : campaign.end_date && campaign.end_date < new Date().toISOString().slice(0, 10) ? campaign.end_date : new Date().toISOString().slice(0, 10)),
    met_by: visit?.met_by || null, interest: visit?.interest || '', notes: visit?.notes || '', outcome: visit?.outcome === 'enquiry' ? 'follow_up' : visit?.outcome || 'follow_up',
  }));
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const err = (k) => save.fields?.[k];
  const submit = () => save.run(async () => {
    const body = { customer_id: f.customer?.id, visited_on: f.visited_on, met_by: f.met_by ?? undefined, interest: f.interest, notes: f.notes, outcome: f.outcome };
    const r = visit ? await api.put(`/campaigns/${campaign.id}/visits/${visit.id}`, body) : await api.post(`/campaigns/${campaign.id}/visits`, body);
    onSaved(r);
    return r;
  });
  return (
    <Modal open onClose={onClose} title={visit ? `Visit — ${visit.customer_name}` : 'Add a customer who visited'} subtitle={campaign.name}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save</Button></>}>
      <div className="stack">
        {!visit && (
          <Field label="Customer" required error={err('customer_id')} hint="New company? Add it under Customers first, so its details are complete.">
            <CustomerPicker value={f.customer} onChange={(c) => set({ customer: c })} allowCreate={false} invalid={Boolean(err('customer_id'))} />
          </Field>
        )}
        <div className="form-grid">
          <DateField label="Visited on" value={f.visited_on} onChange={(v) => set({ visited_on: v })} error={err('visited_on')} presets={false} />
          <Field label="Met by" optional error={err('met_by')}><UserSelect value={f.met_by} onChange={(v) => set({ met_by: v })} placeholder="You" /></Field>
          <Field label="Interested in" optional className="full" error={err('interest')}><Input value={f.interest} maxLength={200} onChange={(e) => set({ interest: e.target.value })} placeholder="e.g. multifunction meters for MCC panels" /></Field>
          {visit?.enquiry_id ? null : <Field label="Outcome" error={err('outcome')}><Select value={f.outcome} onChange={(e) => set({ outcome: e.target.value })} options={VISIT_OUTCOMES.filter((o) => o.value !== 'enquiry')} /></Field>}
          <Field label="Notes" optional className="full" error={err('notes')}><Textarea rows={3} value={f.notes} maxLength={1000} onChange={(e) => set({ notes: e.target.value })} placeholder="What was discussed, what they asked for" /></Field>
        </div>
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
  const { campaign: c, metrics: m, enquiries, visits, by_salesperson: people } = data;
  const values = can('values.view');
  const exhibition = c.type === 'exhibition';
  const canRecord = can('campaigns.edit') || can('enquiries.edit');
  const raiseEnquiry = (customer) => quick.open('enquiry', {
    customer: customer || null, source_code: exhibition ? 'exhibition' : 'campaign', campaign_id: String(c.id), source_event: c.name,
  });
  const removeVisit = async (v) => {
    if (!(await confirm({ title: 'Remove this visit?', message: `${v.customer_name} will no longer be listed as visiting ${c.name}. Any enquiry stays as it is.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.del(`/campaigns/${c.id}/visits/${v.id}`);
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };
  const funnel = [
    ...(exhibition ? [{ step: 'Customers visited', n: m.visitors }] : []),
    { step: 'Enquiries', n: m.enquiries }, { step: 'Assigned', n: m.assigned }, { step: 'Contacted', n: m.contacted }, { step: 'Meetings', n: m.meetings },
    { step: 'Qualified', n: m.qualified }, { step: 'Quoted', n: m.quoted }, { step: 'Won', n: m.won },
  ];
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Exhibitions', to: '/campaigns' }, { label: c.name }]} title={c.name}
        eyebrow={<>{c.type_label} <Badge size="sm" tone={toneOf(CAMPAIGN_STATUSES, c.status)}>{c.status_label}</Badge></>}
        subtitle={[c.start_date && `${date(c.start_date, { year: true })}${c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date, { year: true })}` : ''}`, c.location, c.stall && `stall ${c.stall}`, c.owner_name && `owner ${c.owner_name}`].filter(Boolean).join(' · ')}
        actions={<>
          {can('enquiries.edit') && <Button icon="plus" onClick={() => raiseEnquiry(null)}>New enquiry from this {exhibition ? 'exhibition' : 'event'}</Button>}
          <Button icon="download" onClick={() => downloadCsv(`${c.name}-enquiries.csv`, [
            { key: 'code', label: 'Enquiry' }, { key: 'customer_name', label: 'Customer' }, { key: 'city', label: 'City' }, { key: 'product', label: 'Product' },
            { key: 'stage', label: 'Stage' }, { key: 'owner_name', label: 'Owner' }, { key: 'received_at', label: 'Received' }, { key: 'contacts', label: 'Contacts logged' }, { key: 'quotes', label: 'Quotations sent' },
          ], enquiries)}>Export enquiries</Button>
          {can('campaigns.edit') && <Button variant="primary" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
        </>} />
      {c.description && <div className="secondary">{c.description}</div>}
      <div className="tiles">
        {exhibition && <Stat k="Customers visited" v={number(m.visitors)} d={`${number(m.visitors_with_enquiry)} raised an enquiry · ${number(m.visitors_to_follow_up)} to follow up`} />}
        <Stat k="Enquiries generated" v={number(m.enquiries)} d={c.target_leads ? `${m.target_progress_pct}% of the ${c.target_leads} target` : `${number(m.open)} still open`} />
        {!exhibition && <Stat k="Contacted" v={number(m.contacted)} d={`${number(m.meetings)} with a meeting or visit`} />}
        <Stat k="Quoted" v={number(m.quoted)} d={values ? compactByCurrency(m.quoted_value) : null} />
        <Stat k="Won" v={number(m.won)} d={m.conversion_pct !== null ? `${pct(m.conversion_pct)} of enquiries · ${number(m.lost)} lost` : null} />
      </div>
      {exhibition && (
        <Card title="Customers visited" sub={`${visits.length}`} flush actions={canRecord && <Button size="sm" variant="primary" icon="plus" onClick={() => setVisitForm({})}>Add visitor</Button>}>
          <DataTable rows={visits} columns={[
            { key: 'c', label: 'Customer', render: (v) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${v.customer_id}`} className="strong">{v.customer_name}</Link><span className="tiny muted">{[v.city, v.contact_name].filter(Boolean).join(' · ')}</span></div> },
            { key: 'd', label: 'Visited', render: (v) => <span className="small nowrap">{date(v.visited_on)}</span> },
            { key: 'i', label: 'Interested in / notes', render: (v) => <span className="small">{v.interest || <span className="muted">—</span>}{v.notes && <div className="tiny muted">{v.notes}</div>}</span> },
            { key: 'm', label: 'Met by', render: (v) => <span className="small">{v.met_by_name || '—'}</span> },
            { key: 'o', label: 'Outcome', render: (v) => (v.enquiry_id ? <Link to={`/enquiries/${v.enquiry_id}`}><Badge size="sm" tone="green">{v.enquiry_code}</Badge></Link> : <Badge size="sm" tone={toneOf(VISIT_OUTCOMES, v.outcome)}>{labelOf(VISIT_OUTCOMES, v.outcome)}</Badge>) },
            canRecord && { key: 'a', label: '', render: (v) => (
              <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                {!v.enquiry_id && can('enquiries.edit') && <Button size="xs" variant="primary" onClick={() => raiseEnquiry({ id: v.customer_id, company_name: v.customer_name })}>Raise enquiry</Button>}
                <Button size="xs" onClick={() => setVisitForm(v)}>Edit</Button>
                <Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${v.customer_name}`} onClick={() => removeVisit(v)} />
              </span>
            ) },
          ].filter(Boolean)} empty={<div className="muted small" style={{ padding: 12 }}>No visitors recorded yet. Add each customer you meet at the stall.</div>} />
        </Card>
      )}
      {values && (
        <div className="grid grid-2">
          <Card title="Return on the event" sub="Per currency; ROI only where cost and order value share a currency">
            <Facts items={[
              ['Cost', m.cost_minor ? <Money minor={m.cost_minor} currency={m.cost_currency} /> : 'Not recorded'],
              ['Cost per enquiry', m.cost_per_enquiry_minor ? <Money minor={m.cost_per_enquiry_minor} currency={m.cost_currency} /> : '—'],
              ['Order value from these enquiries', compactByCurrency(m.revenue)],
              ['Open pipeline', compactByCurrency(m.pipeline)],
              ['Return on cost', m.roi_multiple !== null && m.roi_multiple !== undefined ? `${number(m.roi_multiple, 1)}× (${m.cost_currency})` : '—'],
              ['Later orders from the same customers', compactByCurrency(m.influenced_revenue)],
            ]} />
            <div className="tiny muted mt-8">Order value is before tax and net of cancellations; it is not revenue or margin. “Later orders” are other orders from these customers since the event — influence, not attribution.</div>
          </Card>
          <Card title="Funnel"><BarChartH data={funnel} label="step" series={[{ key: 'n', label: 'Count' }]} format="number" /></Card>
        </div>
      )}
      {!values && <Card title="Funnel"><BarChartH data={funnel} label="step" series={[{ key: 'n', label: 'Count' }]} format="number" /></Card>}
      <Card title="Follow-up by salesperson" flush>
        <DataTable compact rows={people} rowKey="name" columns={[
          { key: 'name', label: 'Owner', render: (p) => <strong>{p.name}</strong> },
          { key: 'e', label: 'Enquiries', align: 'num', render: (p) => number(p.enquiries) },
          { key: 'c', label: 'Replied', align: 'num', render: (p) => <span className={p.contacted < p.enquiries ? 'warning-text' : ''}>{number(p.contacted)}</span> },
          { key: 'q', label: 'Quoted', align: 'num', render: (p) => number(p.quoted) },
          { key: 'o', label: 'Open', align: 'num', render: (p) => number(p.open) },
          { key: 'w', label: 'Won', align: 'num', render: (p) => number(p.won) },
          { key: 'l', label: 'Lost', align: 'num', render: (p) => number(p.lost) },
        ]} empty={<div className="muted small" style={{ padding: 12 }}>No enquiries linked to this event yet.</div>} />
      </Card>
      <Card title="Enquiries generated" sub={`${enquiries.length}`} flush>
        <DataTable rows={enquiries} onRowClick={(e) => navigate(`/enquiries/${e.id}`)} columns={[
          { key: 'code', label: 'Enquiry', render: (e) => <Link to={`/enquiries/${e.id}`} className="strong">{e.code}</Link> },
          { key: 'cust', label: 'Customer', render: (e) => <div className="col" style={{ gap: 0 }}><span>{e.customer_name}</span><span className="tiny muted">{e.city}</span></div> },
          { key: 'p', label: 'Product', render: (e) => <span className="small">{e.product}</span> },
          { key: 's', label: 'Stage', render: (e) => <StageBadge stage={e.stage} size="sm" /> },
          values && { key: 'v', label: 'Est. value', align: 'num', render: (e) => (e.est_value_minor ? compactMoney(e.est_value_minor, e.est_currency) : '—') },
          { key: 'o', label: 'Owner', render: (e) => <span className="small">{e.owner_name}</span> },
          { key: 'r', label: 'Received', render: (e) => <span className="small">{dateTime(e.received_at)}</span> },
          { key: 'f', label: 'Reply', render: (e) => <ReplyBadge replied={Boolean(e.first_response_at)} /> },
        ].filter(Boolean)} />
      </Card>
      {editing && <CampaignForm campaign={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
      {visitForm && <VisitForm campaign={c} visit={visitForm.id ? visitForm : null} onClose={() => setVisitForm(null)} onSaved={() => { setVisitForm(null); reload(); }} />}
    </div>
  );
}
