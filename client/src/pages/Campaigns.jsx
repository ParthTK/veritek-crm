// Exhibitions & campaigns: each event with its enquiry funnel, quotations, orders, revenue and cost.
// Money stays per currency; ROI only where cost and revenue share a currency.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CAMPAIGN_TYPES, CAMPAIGN_STATUSES, CURRENCIES, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave, useUrlFilters } from '../lib/hooks.js';
import { date, number, pct, compactByCurrency, compactMoney } from '../lib/format.js';
import { Badge, Button, Card, Chips, EmptyState, ErrorState, Field, Input, Modal, PageHeader, SaveStatus, Select, Spinner, Textarea } from '../components/ui.jsx';
import { UserSelect } from '../components/domain.jsx';

export default function Campaigns() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [f, setFilter] = useUrlFilters();
  const { data, error, loading, reload } = useApi('/campaigns', { status: f.status, type: f.type });
  const [editing, setEditing] = useState(null);
  const values = can('values.view');
  return (
    <div className="stack">
      <PageHeader title="Exhibitions & campaigns" subtitle="Enquiries, follow-ups, quotations and orders from each event — with cost and return where the currency matches"
        actions={can('campaigns.edit') && <Button variant="primary" icon="plus" onClick={() => setEditing({})}>New campaign</Button>} />
      <div className="row wrap between">
        <Chips options={[{ value: '', label: 'All' }, ...CAMPAIGN_STATUSES]} value={f.status || ''} onChange={(v) => setFilter({ status: v })} />
        <Select aria-label="Type" value={f.type || ''} onChange={(e) => setFilter({ type: e.target.value })} placeholder="All types" options={CAMPAIGN_TYPES} style={{ width: 'auto' }} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <Spinner />}
      {data && !data.length && <EmptyState icon="campaigns" title="No campaigns yet" message="Create one per exhibition, dealer meet or launch, then tag the enquiries it brings in." />}
      <div className="grid grid-3">
        {(data || []).map((c) => {
          const m = c.metrics;
          return (
            <Card key={c.id} className="clickable">
              <div className="stack-sm" onClick={() => navigate(`/campaigns/${c.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/campaigns/${c.id}`)} style={{ cursor: 'pointer' }}>
                <div className="row between top">
                  <div className="grow">
                    <Link to={`/campaigns/${c.id}`} className="strong" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    <div className="tiny muted">{c.type_label}{c.location ? ` · ${c.location}` : ''}</div>
                    <div className="tiny muted">{c.start_date ? `${date(c.start_date)}${c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date)}` : ''}` : 'Dates not set'}{c.owner_name ? ` · ${c.owner_name}` : ''}</div>
                  </div>
                  <Badge size="sm" tone={toneOf(CAMPAIGN_STATUSES, c.status)}>{c.status_label}</Badge>
                </div>
                <div className="grid grid-3" style={{ gap: 8 }}>
                  <MiniStat k="Enquiries" v={number(m.enquiries)} d={c.target_leads ? `of ${c.target_leads} target` : null} />
                  <MiniStat k="Quoted" v={number(m.quoted)} />
                  <MiniStat k="Won" v={number(m.won)} d={m.conversion_pct !== null ? `${pct(m.conversion_pct)} conversion` : null} />
                </div>
                {m.target_progress_pct !== null && <div className="progress" title={`${m.target_progress_pct}% of the enquiry target`}><span style={{ width: `${Math.min(100, m.target_progress_pct)}%` }} /></div>}
                {values && (
                  <div className="small">
                    <div className="row between"><span className="muted">Order value</span><strong>{compactByCurrency(m.revenue)}</strong></div>
                    <div className="row between"><span className="muted">Open pipeline</span><span>{compactByCurrency(m.pipeline)}</span></div>
                    <div className="row between"><span className="muted">Cost</span><span>{m.cost_minor ? compactMoney(m.cost_minor, m.cost_currency) : '—'}{m.roi_multiple !== null && m.roi_multiple !== undefined ? ` · ${number(m.roi_multiple, 1)}× return` : ''}</span></div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      {editing && <CampaignForm campaign={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); reload(); if (r?.id) navigate(`/campaigns/${r.id}`); }} />}
    </div>
  );
}

function MiniStat({ k, v, d }) {
  return <div className="col" style={{ gap: 0 }}><span className="tiny muted">{k}</span><span className="strong" style={{ fontSize: 18 }}>{v}</span>{d && <span className="tiny muted">{d}</span>}</div>;
}

export function CampaignForm({ campaign, onClose, onSaved }) {
  const save = useSave();
  const [f, setF] = useState(() => ({
    name: campaign?.name || '', type: campaign?.type || 'exhibition', status: campaign?.status || 'planned', location: campaign?.location || '', stall: campaign?.stall || '',
    start_date: campaign?.start_date || '', end_date: campaign?.end_date || '', cost: campaign?.cost_minor ? String(campaign.cost_minor / 100) : '', cost_currency: campaign?.cost_currency || 'INR',
    target_leads: campaign?.target_leads ?? '', description: campaign?.description || '', owner_id: campaign?.owner_id || null,
  }));
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const err = (k) => save.fields?.[k];
  const submit = () => save.run(async () => {
    const r = campaign ? await api.put(`/campaigns/${campaign.id}`, f) : await api.post('/campaigns', f);
    onSaved(r);
    return r;
  });
  return (
    <Modal open size="lg" onClose={onClose} title={campaign ? `Edit ${campaign.name}` : 'New campaign'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save campaign</Button></>}>
      <div className="form-grid">
        <Field label="Name" required className="full" error={err('name')}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. ELECRAMA 2026" /></Field>
        <Field label="Type" error={err('type')}><Select value={f.type} onChange={(e) => set({ type: e.target.value })} options={CAMPAIGN_TYPES} /></Field>
        <Field label="Status" error={err('status')}><Select value={f.status} onChange={(e) => set({ status: e.target.value })} options={CAMPAIGN_STATUSES} /></Field>
        <Field label="Start" error={err('start_date')}><Input type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} /></Field>
        <Field label="End" error={err('end_date')}><Input type="date" value={f.end_date} onChange={(e) => set({ end_date: e.target.value })} /></Field>
        <Field label="Location" optional><Input value={f.location} onChange={(e) => set({ location: e.target.value })} /></Field>
        <Field label="Stall / reference" optional><Input value={f.stall} onChange={(e) => set({ stall: e.target.value })} /></Field>
        <Field label="Cost" optional error={err('cost')} hint="Stall, travel, collateral — before tax">
          <div className="row"><Input inputMode="decimal" value={f.cost} onChange={(e) => set({ cost: e.target.value })} /><Select value={f.cost_currency} onChange={(e) => set({ cost_currency: e.target.value })} options={CURRENCIES} style={{ width: 96 }} aria-label="Cost currency" /></div>
        </Field>
        <Field label="Enquiry target" optional error={err('target_leads')}><Input type="number" min={0} value={f.target_leads} onChange={(e) => set({ target_leads: e.target.value })} /></Field>
        <Field label="Owner" optional error={err('owner_id')}><UserSelect value={f.owner_id} onChange={(v) => set({ owner_id: v })} filter={(p) => ['admin', 'coordinator', 'sales'].includes(p.group)} /></Field>
        <Field label="Description" optional className="full"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}
