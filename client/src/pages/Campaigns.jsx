// Exhibitions attended, the customers met there and the enquiries they brought.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CAMPAIGN_STATUSES, toneOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, number } from '../lib/format.js';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, SaveStatus, Select, Spinner, Stat } from '../components/ui.jsx';
import { useMeta } from '../components/domain.jsx';

export const exhibitionDates = (c) => (c.start_date ? `${date(c.start_date, { year: true })}${c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date, { year: true })}` : ''}` : 'Dates not set');

export default function Campaigns() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/campaigns', { type: 'exhibition' });
  const [adding, setAdding] = useState(false);
  const rows = data || [];
  const total = (k) => rows.reduce((n, c) => n + c.metrics[k], 0);
  return (
    <div className="stack">
      <PageHeader title="Exhibitions" actions={can('campaigns.edit') && <Button variant="cta" icon="plus" onClick={() => setAdding(true)}>New exhibition</Button>} />
      {rows.length > 0 && (
        <div className="tiles">
          <Stat k="Exhibitions attended" v={number(rows.filter((c) => ['active', 'completed'].includes(c.status)).length)} />
          <Stat k="Customers visited" v={number(total('visitors'))} />
          <Stat k="Enquiries generated" v={number(total('enquiries'))} />
        </div>
      )}
      {error && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <Spinner />}
      {data && !rows.length && <EmptyState icon="campaigns" title="No exhibitions yet" />}
      <div className="grid grid-3">
        {rows.map((c) => (
          <Card key={c.id} className="clickable">
            <div className="stack-sm" onClick={() => navigate(`/campaigns/${c.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/campaigns/${c.id}`)} style={{ cursor: 'pointer' }}>
              <div className="row between top">
                <div className="grow">
                  <Link to={`/campaigns/${c.id}`} className="strong" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                  <div className="tiny muted">{[c.location, exhibitionDates(c)].filter(Boolean).join(' · ')}</div>
                </div>
                <Badge size="sm" tone={toneOf(CAMPAIGN_STATUSES, c.status)}>{c.status_label}</Badge>
              </div>
              <div className="grid" style={{ gap: 8, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                <MiniStat k="Visited" v={number(c.metrics.visitors)} />
                <MiniStat k="Enquiries" v={number(c.metrics.enquiries)} />
                <MiniStat k="Won" v={number(c.metrics.won)} />
              </div>
            </div>
          </Card>
        ))}
      </div>
      {adding && <CampaignForm onClose={() => setAdding(false)} onSaved={(r) => navigate(`/campaigns/${r.id}`)} />}
    </div>
  );
}

function MiniStat({ k, v }) {
  return <div className="col" style={{ gap: 0 }}><span className="tiny muted">{k}</span><span className="strong" style={{ fontSize: 18 }}>{v}</span></div>;
}

export function CampaignForm({ campaign, onClose, onSaved }) {
  const save = useSave();
  const meta = useMeta();
  const [f, setF] = useState({ name: campaign?.name || '', location: campaign?.location || '', start_date: campaign?.start_date || '', end_date: campaign?.end_date || '', status: campaign?.status || 'planned' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const submit = () => save.run(async () => {
    const r = campaign ? await api.put(`/campaigns/${campaign.id}`, f) : await api.post('/campaigns', { ...f, type: 'exhibition' });
    // The enquiry and customer forms list exhibitions from the reference data, so refresh it.
    meta.reload();
    onSaved(r);
    return r;
  });
  return (
    <Modal open onClose={onClose} title={campaign ? `Edit ${campaign.name}` : 'New exhibition'}
      footer={<><SaveStatus save={save} /><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.saving} onClick={submit}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Name" required className="full" error={save.fields.name}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. ELECRAMA 2026" /></Field>
        <Field label="Location" optional error={save.fields.location}><Input value={f.location} onChange={(e) => set({ location: e.target.value })} /></Field>
        <Field label="Status" error={save.fields.status}><Select value={f.status} onChange={(e) => set({ status: e.target.value })} options={CAMPAIGN_STATUSES} /></Field>
        <Field label="Start" optional error={save.fields.start_date}><Input type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} /></Field>
        <Field label="End" optional error={save.fields.end_date}><Input type="date" value={f.end_date} onChange={(e) => set({ end_date: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
