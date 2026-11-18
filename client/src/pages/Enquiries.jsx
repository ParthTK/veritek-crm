import { Link, useNavigate } from 'react-router-dom';
import { ENQUIRY_STAGES, TEMPERATURES, labelOf, toneOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { downloadAuthed } from '../api.js';
import { compactByCurrency, compactMoney, date, qty, relDay, timeAgo } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Pagination, SearchBox, Segmented, Select, Spinner, Stat, useToast, EmptyState } from '../components/ui.jsx';
import { DueBadge, StageBadge, QuoteBadge, FilterBar, useOptions, useMeta, ReplyBadge } from '../components/domain.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';

export default function Enquiries() {
  const { can } = useAuth();
  const quick = useQuickEntry();
  const toast = useToast();
  const [f, setF] = useUrlFilters({ stage: 'open', page: '1', view: 'list' });
  const pipeline = f.view === 'pipeline';
  return (
    <div className="stack">
      <PageHeader title="Enquiries" subtitle={pipeline ? 'Open opportunities by stage, with value, probability and the expected decision date.' : 'Response, quotation, decision and follow-up for every enquiry.'}
        actions={<>
          <Segmented label="View" value={pipeline ? 'pipeline' : 'list'} onChange={(v) => setF({ view: v })} options={[{ value: 'list', label: 'List' }, { value: 'pipeline', label: 'Stage board' }]} />
          {can('export.lists') && !pipeline && <Button icon="download" onClick={() => downloadAuthed('/export/enquiries.csv', f).catch((e) => toast.error(e.message))}>Export</Button>}
          {can('enquiries.edit') && <Button variant="cta" icon="plus" onClick={() => quick.open('enquiry')}>New enquiry</Button>}
        </>} />
      {pipeline ? <PipelineBoard f={f} setF={setF} /> : <EnquiryList f={f} setF={setF} />}
    </div>
  );
}

function ExtraFilters({ f, setF }) {
  const meta = useMeta();
  return (
    <>
      <Select aria-label="Temperature" value={f.temperature || ''} onChange={(e) => setF({ temperature: e.target.value })} options={TEMPERATURES} placeholder="Any temperature" />
      {meta.regions.length > 0 && <Select aria-label="Region" value={f.region_id || ''} onChange={(e) => setF({ region_id: e.target.value })} options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} placeholder="All regions" />}
    </>
  );
}

function EnquiryList({ f, setF }) {
  const navigate = useNavigate();
  const meta = useMeta();
  const { can } = useAuth();
  const sources = useOptions('enquiry_source');
  const { data, error, loading, reload } = useApi('/enquiries', { ...f, view: undefined });
  const sc = data?.stage_counts || {};
  const open = ENQUIRY_STAGES.filter((s) => s.open).reduce((n, s) => n + (sc[s.value] || 0), 0);
  const values = can('values.view');
  return (
    <>
      <Chips value={f.stage} onChange={(v) => setF({ stage: v })} options={[
        { value: 'open', label: 'All open', count: open },
        ...ENQUIRY_STAGES.filter((s) => s.open).map((s) => ({ value: s.value, label: s.label, count: sc[s.value] || 0 })),
        { value: 'won', label: 'Won', count: sc.won || 0 }, { value: 'lost', label: 'Lost', count: sc.lost || 0 }, { value: 'cancelled', label: 'Cancelled', count: sc.cancelled || 0 },
        { value: 'all', label: 'Everything' },
      ]} />
      <Chips value={f.reply || ''} onChange={(v) => setF({ reply: v })} options={[
        { value: '', label: 'Any reply status' },
        { value: 'unreplied', label: 'Not replied', tone: 'red', count: data?.reply_counts?.unreplied },
        { value: 'replied', label: 'Replied', count: data?.reply_counts?.replied },
      ]} />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Enquiry, customer, product…" />
        <Select aria-label="Source" value={f.source || ''} onChange={(e) => setF({ source: e.target.value })} options={sources} placeholder="All sources" />
        {meta.campaigns.length > 0 && <Select aria-label="Campaign" value={f.campaign_id || ''} onChange={(e) => setF({ campaign_id: e.target.value })} options={meta.campaigns.map((c) => ({ value: String(c.id), label: c.name }))} placeholder="Any exhibition / event" />}
        <Select aria-label="Flags" value={f.no_next ? 'no_next' : f.no_response ? 'no_response' : ''} onChange={(e) => setF({ no_next: e.target.value === 'no_next' ? '1' : '', no_response: e.target.value === 'no_response' ? '1' : '' })}
          options={[{ value: 'no_next', label: 'Without a next action' }, { value: 'no_response', label: 'No first response yet' }]} placeholder="All" />
        <ExtraFilters f={f} setF={setF} />
        <FilterBar value={f} onChange={setF} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/enquiries/${r.id}`)}
          columns={[
            { key: 'customer', label: 'Customer', render: (r) => <><strong>{r.customer_name}</strong><div className="sub">{r.code} · {r.source_label}{r.source_event ? ` · ${r.source_event}` : ''}</div></> },
            { key: 'product', label: 'Product', render: (r) => <>{r.title ? <div className="small strong">{r.title}</div> : null}{r.product}{r.line_count > 1 && <span className="muted"> +{r.line_count - 1}</span>}<div className="sub">{r.qty ? qty(r.qty, r.unit) : 'Qty unknown'}</div>{r.missing_lines > 0 && <Badge size="sm" tone="amber">Details missing</Badge>}</> },
            { key: 'stage', label: 'Status', render: (r) => <span className="stack-xs"><span className="row wrap" style={{ gap: 4 }}><StageBadge stage={r.stage} />{r.temperature && <Badge size="sm" tone={toneOf(TEMPERATURES, r.temperature)}>{labelOf(TEMPERATURES, r.temperature)}</Badge>}</span>{r.quote_ref && <span className="tiny muted">{r.quote_ref} <QuoteBadge status={r.quote_status} size="sm" /></span>}</span> },
            { key: 'reply', label: 'Reply', render: (r) => <span className="stack-xs"><ReplyBadge replied={Boolean(r.first_response_at)} />{r.first_response_at && <span className="tiny muted">{timeAgo(r.first_response_at)}</span>}</span> },
            values && { key: 'value', label: 'Est. value', align: 'num', render: (r) => (r.est_value_minor ? <span className="small">{compactMoney(r.est_value_minor, r.est_currency)}{r.probability !== null && r.probability !== undefined ? <div className="tiny muted">{r.probability}%</div> : null}</span> : <span className="muted">—</span>) },
            { key: 'next', label: 'Next action', render: (r) => (r.next_task ? r.next_task.purpose : r.stage === 'lost' ? <span className="small">Lost: {r.lost_reason}</span> : r.no_followup_reason ? <span className="muted small">No follow-up: {r.no_followup_reason}</span> : ['won', 'cancelled'].includes(r.stage) ? <span className="muted">—</span> : <Badge tone="red">No next action</Badge>) },
            { key: 'due', label: 'Due', render: (r) => (r.next_task ? <DueBadge task={r.next_task} /> : <span className="muted">—</span>) },
            { key: 'owner', label: 'Owner', render: (r) => r.owner_name },
            { key: 'received', label: 'Received', render: (r) => <span className="small">{r.received_unknown ? 'Unknown' : timeAgo(r.received_at)}</span> },
          ]}
          card={(r) => <><div className="row between"><strong>{r.customer_name}</strong><StageBadge stage={r.stage} size="sm" /></div><div className="small">{r.product} · {r.qty ? qty(r.qty, r.unit) : 'qty unknown'}</div>{r.next_task && <div className="row"><DueBadge task={r.next_task} /><span className="small">{r.next_task.purpose}</span></div>}</>}
        />
        <Pagination page={Number(f.page) || 1} pageSize={data?.pageSize || 100} count={data?.count || 0} onChange={(p) => setF({ page: String(p) })} />
      </Card>
      <div className="small muted">“Details missing” means a product or quantity is still unknown — it is never filled in automatically.</div>
    </>
  );
}

/** Kanban of open stages. Stage changes happen on the enquiry (they need reasons and next actions). */
function PipelineBoard({ f, setF }) {
  const { can } = useAuth();
  const values = can('values.view');
  const { data, error, loading, reload } = useApi('/enquiries/pipeline', { owner: f.owner, segment: f.segment, region_id: f.region_id, temperature: f.temperature });
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <>
      <div className="filter-bar">
        <ExtraFilters f={f} setF={setF} />
        <FilterBar value={f} onChange={setF} fields={['owner', 'segment']} />
      </div>
      {!data && loading && <Spinner />}
      {data && values && (
        <div className="tiles">
          <Stat k="Weighted, decision in 30 days" v={compactByCurrency(data.forecast.d30)} d={`by ${date(data.horizon.d30)}`} />
          <Stat k="31–60 days" v={compactByCurrency(data.forecast.d60)} />
          <Stat k="61–90 days" v={compactByCurrency(data.forecast.d90)} />
          <Stat k="Not forecast" v={`${data.forecast.undated + data.forecast.unvalued}`} d={`${data.forecast.undated} without a decision date · ${data.forecast.unvalued} without a value`} />
        </div>
      )}
      {data && !data.total && <EmptyState icon="pipeline" title="No open opportunities" message="Open enquiries appear here by stage." />}
      {data && data.total > 0 && (
        <div className="kanban">
          {data.columns.map((col) => (
            <div key={col.stage} className="kcol">
              <div className="kcol-head">
                <span className="row between"><StageBadge stage={col.stage} size="sm" /><span className="tiny muted">{col.cards.length}</span></span>
                {values && Object.keys(col.value_by_currency).length > 0 && <span className="tiny">{compactByCurrency(col.value_by_currency)} <span className="muted">· weighted {compactByCurrency(col.weighted_by_currency)}</span></span>}
              </div>
              <div className="kcol-body">
                {col.cards.map((c) => (
                  <Link key={c.id} to={`/enquiries/${c.id}`} className="kcard">
                    <div className="row between" style={{ gap: 6 }}>
                      <span className="strong small truncate">{c.customer_name}</span>
                      {c.temperature && <Badge size="sm" tone={toneOf(TEMPERATURES, c.temperature)}>{labelOf(TEMPERATURES, c.temperature)}</Badge>}
                    </div>
                    <div className="tiny muted truncate">{c.code} · {c.title || c.product}</div>
                    {values && c.value_minor !== null && <div className="small mt-8"><strong>{compactMoney(c.value_minor, c.currency)}</strong> <span className="tiny muted">{c.value_basis === 'quoted' ? 'quoted' : 'estimate'} · {c.probability_effective}%</span></div>}
                    {values && c.value_minor === null && <div className="tiny warning-text mt-8">No value yet</div>}
                    <div className="tiny mt-8">{c.expected_decision_date ? <span className={c.overdue_decision ? 'danger-text strong' : ''}>Decision {relDay(c.expected_decision_date)}</span> : <span className="muted">No decision date</span>}</div>
                    <div className="tiny muted">{c.owner_name}{c.next_due ? ` · next ${relDay(c.next_due)}` : ' · no next action'}</div>
                  </Link>
                ))}
                {!col.cards.length && <div className="tiny muted" style={{ padding: 8 }}>Nothing here</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="small muted">Value is the latest issued quotation (before tax), else the estimate; weighted by the enquiry's probability or its stage default. Values stay per currency.</div>
    </>
  );
}
