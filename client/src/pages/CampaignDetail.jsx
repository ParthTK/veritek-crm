import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CAMPAIGN_TYPES, LEAD_STAGES, LEAD_STATUSES, LEAD_TEMPERATURES, labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inr, inrCompact, number, pct, date, relativeDay, downloadCsv } from '../lib/format.js';
import { Badge, Button, Card, DataTable, ErrorState, KV, OptionBadge, PageHeader, Spinner, Tile } from '../components/ui.jsx';
import { BarChartH } from '../components/charts.jsx';
import { CampaignModal } from './Campaigns.jsx';

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: c, error, reload } = useApi(`/campaigns/${id}`);
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!c) return <Spinner />;
  const m = c.metrics;
  const funnel = [
    { stage: 'Leads collected', count: m.leads },
    { stage: 'Assigned', count: m.assigned },
    { stage: 'Contacted', count: m.contacted },
    { stage: 'Meetings held', count: m.meetings },
    { stage: 'Requirement qualified', count: m.qualified },
    { stage: 'Quotations sent', count: m.quoted_leads },
    { stage: 'Orders won', count: m.won },
  ];

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Exhibitions & campaigns', to: '/campaigns' }, { label: c.name }]}
        title={c.name}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Badge>{labelOf(CAMPAIGN_TYPES, c.type)}</Badge>
          <Badge color={c.status === 'completed' ? 'slate' : c.status === 'active' ? 'green' : 'blue'}>{c.status}</Badge>
          <span className="muted small">{c.location} · {date(c.start_date)}{c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date)}` : ''}{c.stall ? ` · ${c.stall}` : ''}</span>
        </span>}
        actions={(
          <>
            <Button icon="download" onClick={() => downloadCsv(`${c.name}-leads.csv`, [
              { key: 'code', label: 'Lead' }, { key: 'customer_name', label: 'Customer' }, { key: 'city', label: 'City' }, { key: 'title', label: 'Requirement' },
              { key: 'stage', label: 'Stage', csv: (l) => labelOf(LEAD_STAGES, l.stage) }, { key: 'status', label: 'Status' }, { key: 'estimated_value', label: 'Value' },
              { key: 'owner_name', label: 'Salesperson' }, { key: 'activity_count', label: 'Activities' }, { key: 'quotation_count', label: 'Quotations' },
            ], c.leads)}>Export leads</Button>
            <Button to={`/leads?campaign_id=${c.id}&status=all`}>Open in leads</Button>
            {can('campaigns.edit') && <Button icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          </>
        )}
      />

      <div className="tiles">
        <Tile label="Leads collected" value={number(m.leads)} foot={c.target_leads ? `Target ${number(c.target_leads)}` : ''} />
        <Tile label="Leads assigned" value={number(m.assigned)} foot={`${number(m.leads - m.assigned)} unassigned`} alert={m.leads > m.assigned} />
        <Tile label="Meetings completed" value={number(m.meetings)} foot={`${number(m.contacted)} contacted at least once`} />
        <Tile label="Quotations sent" value={number(m.quotations)} foot={m.quoted_value !== undefined ? inrCompact(m.quoted_value) : ''} />
        <Tile label="Orders converted" value={number(m.orders)} foot={`${number(m.won)} leads won · ${number(m.lost)} lost`} />
        {m.revenue !== undefined && <Tile label="Revenue generated" value={inrCompact(m.revenue)} foot={m.influenced_revenue ? `+ ${inrCompact(m.influenced_revenue)} follow-on business` : 'Direct from campaign leads'} />}
        <Tile label="Conversion rate" value={pct(m.conversion_pct)} foot={`${number(m.open)} still open`} />
        {m.cost !== undefined && <Tile label="Cost vs revenue" value={m.roi_multiple === null ? '—' : `${number(m.roi_multiple, 1)}×`} foot={`Spend ${inrCompact(m.cost)}${m.cost_per_lead ? ` · ${inr(m.cost_per_lead)}/lead` : ''}`} alert={m.roi_multiple !== null && m.roi_multiple < 1} />}
      </div>

      <div className="grid grid-2">
        <Card title="Campaign funnel" sub="From badge scan to purchase order">
          <BarChartH data={funnel} label="stage" series={[{ key: 'count', label: 'Leads' }]} />
        </Card>
        <Card title="Details">
          <KV items={[
            ['Owner', c.owner_name],
            ['Cost of participation', m.cost !== undefined ? inr(m.cost) : null],
            ['Open pipeline from campaign', m.pipeline_value !== undefined ? inr(m.pipeline_value) : null],
            ['Revenue (direct)', m.revenue !== undefined ? inr(m.revenue) : null],
            ['Follow-on revenue from these customers', m.influenced_revenue !== undefined ? inr(m.influenced_revenue) : null],
            ['Description', c.description],
          ]} />
        </Card>
      </div>

      <Card title="Performance by salesperson" flush>
        <DataTable rows={c.by_salesperson} rowKey="name" columns={[
          { key: 'name', label: 'Salesperson' },
          { key: 'leads', label: 'Leads', align: 'num' },
          { key: 'contacted', label: 'Contacted', align: 'num' },
          { key: 'quoted', label: 'Quoted', align: 'num' },
          { key: 'won', label: 'Won', align: 'num' },
          { key: 'value', label: 'Won value', align: 'num', render: (r) => (r.value === undefined ? '—' : inrCompact(r.value)) },
          { key: 'conv', label: 'Conversion', align: 'num', render: (r) => pct(r.leads ? (r.won / r.leads) * 100 : 0) },
        ]} />
      </Card>

      <Card title={`Leads from ${c.name}`} flush>
        <DataTable rows={c.leads} onRowClick={(l) => navigate(`/leads/${l.id}`)} columns={[
          { key: 'code', label: 'Lead', render: (l) => <div className="col" style={{ gap: 0, maxWidth: 260 }}><Link to={`/leads/${l.id}`} className="strong truncate">{l.title}</Link><span className="tiny muted">{l.code} · {date(l.created_at)}</span></div> },
          { key: 'customer', label: 'Customer', render: (l) => <div className="col" style={{ gap: 0 }}><Link to={`/customers/${l.customer_id}`}>{l.customer_name}</Link><span className="tiny muted">{l.city}</span></div> },
          { key: 'stage', label: 'Stage', render: (l) => (l.status === 'open' ? <OptionBadge list={LEAD_STAGES} value={l.stage} /> : <OptionBadge list={LEAD_STATUSES} value={l.status} />) },
          { key: 'temp', label: 'Temp.', render: (l) => <OptionBadge list={LEAD_TEMPERATURES} value={l.temperature} size="sm" /> },
          { key: 'value', label: 'Value', align: 'num', render: (l) => (l.estimated_value === undefined ? '—' : inrCompact(l.estimated_value)) },
          { key: 'activity', label: 'Touches', align: 'num', render: (l) => l.activity_count },
          { key: 'quotes', label: 'Quotes', align: 'num', render: (l) => l.quotation_count },
          { key: 'owner', label: 'Salesperson', render: (l) => l.owner_name || <Badge color="amber" size="sm">Unassigned</Badge> },
          { key: 'next', label: 'Next action', render: (l) => (l.status === 'open' ? <span className="small">{l.next_action}<div className="tiny muted">{relativeDay(l.next_follow_up_date)}</div></span> : '—') },
        ]} />
      </Card>

      {editing && <CampaignModal campaign={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}
