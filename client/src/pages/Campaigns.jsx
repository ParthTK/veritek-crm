import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CAMPAIGN_TYPES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inr, inrCompact, number, pct, date } from '../lib/format.js';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, Tile, useToast, EmptyState } from '../components/ui.jsx';
import { UserSelect, useMeta } from '../components/domain.jsx';

export default function Campaigns() {
  const { can } = useAuth();
  const { data, reload } = useApi('/campaigns');
  const [editing, setEditing] = useState(null);
  if (!data) return <Spinner />;
  const totals = data.reduce((a, c) => ({
    cost: a.cost + c.cost, leads: a.leads + c.metrics.leads, orders: a.orders + c.metrics.orders, revenue: a.revenue + (c.metrics.revenue || 0),
  }), { cost: 0, leads: 0, orders: 0, revenue: 0 });

  return (
    <div className="stack">
      <PageHeader title="Exhibitions & campaigns" subtitle="Leads collected, conversion and return on every event"
        actions={can('campaigns.edit') && <Button variant="primary" icon="plus" onClick={() => setEditing({})}>New campaign</Button>} />
      <div className="tiles">
        <Tile label="Campaigns" value={number(data.length)} />
        <Tile label="Total spend" value={inrCompact(totals.cost)} />
        <Tile label="Leads collected" value={number(totals.leads)} foot={totals.leads ? `${inr(Math.round(totals.cost / totals.leads))} per lead` : ''} />
        <Tile label="Orders won" value={number(totals.orders)} />
        <Tile label="Revenue generated" value={inrCompact(totals.revenue)} foot={totals.cost ? `${number(totals.revenue / totals.cost, 1)}× return on spend` : ''} />
      </div>
      <div className="grid grid-3">
        {data.map((c) => {
          const m = c.metrics;
          return (
            <Card key={c.id} title={<Link to={`/campaigns/${c.id}`}>{c.name}</Link>} sub={labelOf(CAMPAIGN_TYPES, c.type)}
              actions={<Badge color={c.status === 'completed' ? 'slate' : c.status === 'active' ? 'green' : 'blue'}>{c.status}</Badge>}>
              <div className="stack-sm">
                <div className="small muted">{c.location} · {date(c.start_date)}{c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date)}` : ''}{c.stall ? ` · ${c.stall}` : ''}</div>
                <div className="grid grid-3" style={{ gap: 8 }}>
                  <div><div className="tiny muted">Leads</div><strong>{number(m.leads)}</strong></div>
                  <div><div className="tiny muted">Quotations</div><strong>{number(m.quotations)}</strong></div>
                  <div><div className="tiny muted">Orders</div><strong>{number(m.orders)}</strong></div>
                  {m.revenue !== undefined && <div><div className="tiny muted">Revenue</div><strong>{inrCompact(m.revenue)}</strong></div>}
                  {m.cost !== undefined && <div><div className="tiny muted">Cost</div><strong>{inrCompact(m.cost)}</strong></div>}
                  <div><div className="tiny muted">Conversion</div><strong>{pct(m.conversion_pct)}</strong></div>
                </div>
                {m.roi_multiple !== null && m.roi_multiple !== undefined && (
                  <div className={`small ${m.roi_multiple >= 1 ? 'success-text' : 'warning-text'}`}>
                    {number(m.roi_multiple, 1)}× revenue against spend{m.pipeline_value ? ` · ${inrCompact(m.pipeline_value)} still open` : ''}
                  </div>
                )}
                <Button size="sm" to={`/campaigns/${c.id}`}>Open report</Button>
              </div>
            </Card>
          );
        })}
        {!data.length && <EmptyState title="No campaigns yet" message="Add an exhibition, dealer meet or product launch to track its leads and ROI." />}
      </div>
      {editing && <CampaignModal campaign={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

export function CampaignModal({ campaign, onClose, onSaved }) {
  const toast = useToast();
  const meta = useMeta();
  const [form, setForm] = useState(campaign || { type: 'exhibition', status: 'planned' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    setBusy(true);
    try {
      if (campaign?.id) await api.put(`/campaigns/${campaign.id}`, form);
      else await api.post('/campaigns', form);
      toast.success('Campaign saved');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={campaign?.id ? `Edit ${campaign.name}` : 'New campaign'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" required className="full"><Input value={form.name} onChange={set('name')} placeholder="e.g. Elecrama 2026" /></Field>
        <Field label="Type"><Select value={form.type} onChange={set('type')} options={CAMPAIGN_TYPES} /></Field>
        <Field label="Status"><Select value={form.status} onChange={set('status')} options={[{ value: 'planned', label: 'Planned' }, { value: 'active', label: 'Running' }, { value: 'completed', label: 'Completed' }]} /></Field>
        <Field label="Location"><Input value={form.location} onChange={set('location')} /></Field>
        <Field label="Stall / booth"><Input value={form.stall} onChange={set('stall')} /></Field>
        <Field label="Start date"><Input type="date" value={form.start_date} onChange={set('start_date')} /></Field>
        <Field label="End date"><Input type="date" value={form.end_date} onChange={set('end_date')} /></Field>
        <Field label="Cost of participation (₹)"><Input type="number" min="0" value={form.cost} onChange={set('cost')} /></Field>
        <Field label="Target leads"><Input type="number" min="0" value={form.target_leads} onChange={set('target_leads')} /></Field>
        <Field label="Owner" className="full"><UserSelect value={form.owner_id} onChange={set('owner_id')} /></Field>
        <Field label="Description" className="full"><Textarea rows={2} value={form.description} onChange={set('description')} /></Field>
      </div>
    </Modal>
  );
}
