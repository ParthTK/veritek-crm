// One campaign: funnel from enquiry to order, follow-up by salesperson, and cost against order value.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CAMPAIGN_STATUSES, toneOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { date, dateTime, number, pct, compactByCurrency, compactMoney, downloadCsv } from '../lib/format.js';
import { Badge, Button, Card, DataTable, ErrorState, PageHeader, Spinner, Stat, Facts } from '../components/ui.jsx';
import { Money, StageBadge } from '../components/domain.jsx';
import { BarChartH } from '../components/charts.jsx';
import { CampaignForm } from './Campaigns.jsx';

export default function CampaignDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useApi(`/campaigns/${id}`);
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const { campaign: c, metrics: m, enquiries, by_salesperson: people } = data;
  const values = can('values.view');
  const funnel = [
    { step: 'Enquiries', n: m.enquiries }, { step: 'Assigned', n: m.assigned }, { step: 'Contacted', n: m.contacted }, { step: 'Meetings', n: m.meetings },
    { step: 'Qualified', n: m.qualified }, { step: 'Quoted', n: m.quoted }, { step: 'Won', n: m.won },
  ];
  return (
    <div className="stack">
      <PageHeader crumbs={[{ label: 'Campaigns', to: '/campaigns' }, { label: c.name }]} title={c.name}
        eyebrow={<>{c.type_label} <Badge size="sm" tone={toneOf(CAMPAIGN_STATUSES, c.status)}>{c.status_label}</Badge></>}
        subtitle={[c.start_date && `${date(c.start_date, { year: true })}${c.end_date && c.end_date !== c.start_date ? ` – ${date(c.end_date, { year: true })}` : ''}`, c.location, c.stall && `stall ${c.stall}`, c.owner_name && `owner ${c.owner_name}`].filter(Boolean).join(' · ')}
        actions={<>
          <Button icon="inbox" to={`/enquiries?campaign_id=${c.id}&stage=all`}>Open in enquiries</Button>
          <Button icon="download" onClick={() => downloadCsv(`${c.name}-enquiries.csv`, [
            { key: 'code', label: 'Enquiry' }, { key: 'customer_name', label: 'Customer' }, { key: 'city', label: 'City' }, { key: 'product', label: 'Product' },
            { key: 'stage', label: 'Stage' }, { key: 'owner_name', label: 'Owner' }, { key: 'received_at', label: 'Received' }, { key: 'contacts', label: 'Contacts logged' }, { key: 'quotes', label: 'Quotations sent' },
          ], enquiries)}>Export enquiries</Button>
          {can('campaigns.edit') && <Button variant="primary" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
        </>} />
      {c.description && <div className="secondary">{c.description}</div>}
      <div className="tiles">
        <Stat k="Enquiries" v={number(m.enquiries)} d={c.target_leads ? `${m.target_progress_pct}% of the ${c.target_leads} target` : `${number(m.open)} still open`} />
        <Stat k="Contacted" v={number(m.contacted)} d={`${number(m.meetings)} with a meeting or visit`} />
        <Stat k="Quoted" v={number(m.quoted)} d={values ? compactByCurrency(m.quoted_value) : null} />
        <Stat k="Won" v={number(m.won)} d={m.conversion_pct !== null ? `${pct(m.conversion_pct)} of enquiries · ${number(m.lost)} lost` : null} />
      </div>
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
          <Card title="Funnel"><BarChartH data={funnel} label="step" series={[{ key: 'n', label: 'Enquiries' }]} format="number" /></Card>
        </div>
      )}
      {!values && <Card title="Funnel"><BarChartH data={funnel} label="step" series={[{ key: 'n', label: 'Enquiries' }]} format="number" /></Card>}
      <Card title="Follow-up by salesperson" flush>
        <DataTable compact rows={people} rowKey="name" columns={[
          { key: 'name', label: 'Owner', render: (p) => <strong>{p.name}</strong> },
          { key: 'e', label: 'Enquiries', align: 'num', render: (p) => number(p.enquiries) },
          { key: 'c', label: 'Contacted', align: 'num', render: (p) => <span className={p.contacted < p.enquiries ? 'warning-text' : ''}>{number(p.contacted)}</span> },
          { key: 'q', label: 'Quoted', align: 'num', render: (p) => number(p.quoted) },
          { key: 'o', label: 'Open', align: 'num', render: (p) => number(p.open) },
          { key: 'w', label: 'Won', align: 'num', render: (p) => number(p.won) },
          { key: 'l', label: 'Lost', align: 'num', render: (p) => number(p.lost) },
        ]} empty={<div className="muted small" style={{ padding: 12 }}>No enquiries tagged to this campaign yet.</div>} />
      </Card>
      <Card title="Enquiries from this campaign" sub={`${enquiries.length}`} flush>
        <DataTable rows={enquiries} onRowClick={(e) => navigate(`/enquiries/${e.id}`)} columns={[
          { key: 'code', label: 'Enquiry', render: (e) => <Link to={`/enquiries/${e.id}`} className="strong">{e.code}</Link> },
          { key: 'cust', label: 'Customer', render: (e) => <div className="col" style={{ gap: 0 }}><span>{e.customer_name}</span><span className="tiny muted">{e.city}</span></div> },
          { key: 'p', label: 'Product', render: (e) => <span className="small">{e.product}</span> },
          { key: 's', label: 'Stage', render: (e) => <StageBadge stage={e.stage} size="sm" /> },
          values && { key: 'v', label: 'Est. value', align: 'num', render: (e) => (e.est_value_minor ? compactMoney(e.est_value_minor, e.est_currency) : '—') },
          { key: 'o', label: 'Owner', render: (e) => <span className="small">{e.owner_name}</span> },
          { key: 'r', label: 'Received', render: (e) => <span className="small">{dateTime(e.received_at)}</span> },
          { key: 'f', label: 'First response', render: (e) => (e.first_response_at ? <span className="small">{dateTime(e.first_response_at)}</span> : <Badge size="sm" tone="red">Not contacted</Badge>) },
        ]} />
      </Card>
      {editing && <CampaignForm campaign={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}
