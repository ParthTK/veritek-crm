import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LEAD_STAGES, LEAD_TEMPERATURES, OPPORTUNITY_FROM_STAGE, stageIndex } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, relativeDay, daysFromToday } from '../lib/format.js';
import { Badge, Button, Checkbox, OptionBadge, PageHeader, Select, Spinner, Tile, SearchBox } from '../components/ui.jsx';
import { UserSelect, useMeta, SALES_ROLES } from '../components/domain.jsx';
import { MoveLeadModal } from './Leads.jsx';

export default function Opportunities() {
  const { can } = useAuth();
  const meta = useMeta();
  const [f, setFilter] = useUrlFilters();
  const [early, setEarly] = useState(false);
  const { data, reload, loading } = useApi('/leads/pipeline', { q: f.q, assigned_to: f.assigned_to, region_id: f.region_id, category_id: f.category_id, temperature: f.temperature });
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);
  const [move, setMove] = useState(null);

  if (!data) return <Spinner />;
  const fromIdx = stageIndex(LEAD_STAGES, OPPORTUNITY_FROM_STAGE);
  const stages = data.stages.filter((s) => early || stageIndex(LEAD_STAGES, s.stage) >= fromIdx);
  const allItems = data.stages.flatMap((s) => s.items);
  const visible = stages.flatMap((s) => s.items);
  const editable = can('leads.edit');

  return (
    <div className="stack">
      <PageHeader title="Opportunities" subtitle="Qualified pipeline by stage — drag a card to move it; every move records the next action"
        actions={<Button to="/leads" icon="leads">List view</Button>} />
      <div className="tiles">
        <Tile label="Open opportunities" value={visible.length} foot={`${inrCompact(visible.reduce((s, l) => s + (l.estimated_value || 0), 0))} total value`} />
        {data.forecast.map((fc) => (
          <Tile key={fc.days} label={`Forecast · closing in ${fc.days} days`} value={inrCompact(fc.weighted_value)} foot={`${fc.count} deals · ${inrCompact(fc.value)} unweighted`} title="Weighted by probability of conversion" />
        ))}
        <Tile label="Follow-ups overdue" value={allItems.filter((l) => l.overdue).length} alert={allItems.some((l) => l.overdue)} foot="Across open leads" to="/leads?followup=overdue" />
      </div>
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Search opportunities" />
        <UserSelect className="sm" roles={SALES_ROLES} value={f.assigned_to} onChange={(e) => setFilter({ assigned_to: e.target.value })} placeholder="Any salesperson" />
        <Select className="sm" value={f.region_id} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="Any region" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} />
        <Select className="sm" value={f.category_id} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="Any product" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="sm" value={f.temperature} onChange={(e) => setFilter({ temperature: e.target.value })} placeholder="Any temperature" options={LEAD_TEMPERATURES} />
        <Checkbox label="Include early-stage enquiries" checked={early} onChange={setEarly} />
      </div>
      <div className="kanban" style={{ opacity: loading ? 0.7 : 1 }}>
        {stages.map((s) => (
          <div key={s.stage} className={`kcol ${overStage === s.stage ? 'drop' : ''}`}
            onDragOver={(e) => { if (dragId && editable) { e.preventDefault(); setOverStage(s.stage); } }}
            onDragLeave={() => setOverStage(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOverStage(null);
              const lead = allItems.find((l) => l.id === dragId);
              if (lead && lead.stage !== s.stage) setMove({ lead, stage: s.stage });
              setDragId(null);
            }}>
            <div className="kcol-head">
              <div className="row between"><strong className="small">{s.label}</strong><span className="pill-count">{s.count}</span></div>
              {s.value !== undefined && <div className="tiny muted">{inrCompact(s.value)} · weighted {inrCompact(s.weighted_value)}</div>}
            </div>
            <div className="kcol-body">
              {s.items.map((l) => (
                <div key={l.id} className={`kcard ${dragId === l.id ? 'dragging' : ''}`} draggable={editable} onDragStart={() => setDragId(l.id)} onDragEnd={() => setDragId(null)}>
                  <div className="row between top">
                    <Link to={`/leads/${l.id}`} className="strong small" style={{ lineHeight: 1.3 }}>{l.customer_name}</Link>
                    <OptionBadge list={LEAD_TEMPERATURES} value={l.temperature} size="sm" />
                  </div>
                  <div className="small secondary truncate" title={l.title}>{l.title}</div>
                  <div className="row between" style={{ marginTop: 6 }}>
                    <strong className="small num">{inrCompact(l.estimated_value)}</strong>
                    <span className="tiny muted">{l.probability}% · {l.owner_name?.split(' ')[0]}</span>
                  </div>
                  <div className={`tiny truncate ${l.overdue ? 'danger-text strong' : 'muted'}`} style={{ marginTop: 4 }} title={l.next_action}>
                    {l.next_action} · {relativeDay(l.next_follow_up_date)}
                  </div>
                  {l.expected_close_date && daysFromToday(l.expected_close_date) < 0 && <Badge size="sm" color="amber">Close date passed</Badge>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <MoveLeadModal open={Boolean(move)} onClose={() => setMove(null)} onSaved={reload} lead={move?.lead} stage={move?.stage} status="open" />
    </div>
  );
}
