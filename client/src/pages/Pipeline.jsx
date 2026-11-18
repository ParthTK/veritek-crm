// The sales pipeline: every live deal across the whole journey — enquiry, quotation, confirmation, payment,
// production, dispatch — with where it is now and, when it is stuck, exactly why.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { compactMoney, date } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, Drawer, EmptyState, ErrorState, Facts, PageHeader, SearchBox, Segmented, Select, Spinner,
} from '../components/ui.jsx';
import { DealReasons, PaymentBadge, SalesJourney, usePeople } from '../components/domain.jsx';

const TONE = { red: 'red', amber: 'amber' };

function StuckBadge({ deal }) {
  if (deal.status !== 'active') return <Badge size="sm" tone="slate">{deal.status === 'completed' ? 'Completed' : 'Closed'}</Badge>;
  return deal.stuck ? <Badge size="sm" tone={TONE[deal.severity]}>Stuck</Badge> : <Badge size="sm" tone="green">Moving</Badge>;
}

function DealCard({ deal, onOpen }) {
  const main = deal.reasons.find((r) => r.severity === 'red' || r.severity === 'amber');
  const more = deal.reasons.filter((r) => r.severity === 'red' || r.severity === 'amber').length - 1;
  return (
    <button type="button" className={`kcard deal ${deal.severity || ''}`} onClick={() => onOpen(deal)}>
      <span className="row between" style={{ gap: 6 }}><strong className="small">{deal.code}</strong><span className="tiny muted nowrap">{deal.days_in_stage} d here</span></span>
      <span className="small strong truncate">{deal.customer_name}</span>
      <span className="tiny muted truncate">{deal.title}</span>
      {main && <span className={`tiny strong ${deal.severity === 'red' ? 'danger-text' : 'warning-text'}`}>{main.text}{more > 0 ? ` · +${more} more` : ''}</span>}
      <span className="row between wrap" style={{ gap: 4 }}><span className="tiny muted truncate">{deal.owner_name}</span><PaymentBadge payment={deal.payment} /></span>
    </button>
  );
}

export function DealDrawer({ deal, onClose }) {
  const { can } = useAuth();
  if (!deal) return null;
  const blocking = deal.reasons.some((r) => r.severity === 'red' || r.severity === 'amber');
  return (
    <Drawer open wide onClose={onClose} title={`${deal.code} · ${deal.customer_name}`} subtitle={deal.title}>
      <div className="stack">
        <SalesJourney deal={deal} />
        <Card title={blocking ? 'Why it is stuck' : 'Status'} sub={`${deal.days_in_stage} days at ${deal.stage_label}`}>
          {deal.reasons.length ? <DealReasons deal={deal} /> : <div className="small muted">Nothing is blocking this one.</div>}
        </Card>
        <Card title="Details">
          <Facts items={[
            ['Assigned to', deal.owner_name],
            ['Next action', deal.next_action ? `${deal.next_action.purpose} · ${date(deal.next_action.due_date)}${deal.next_action.owner_name ? ` · ${deal.next_action.owner_name}` : ''}` : 'None planned'],
            ['Source', deal.exhibition ? <Link to={`/campaigns/${deal.exhibition.id}`}>{deal.exhibition.name}</Link> : deal.source_label],
            ['Payment', deal.payment ? <PaymentBadge payment={deal.payment} /> : null],
            can('values.view') && deal.value_minor ? ['Value', compactMoney(deal.value_minor, deal.currency)] : null,
          ].filter(Boolean)} />
        </Card>
        <div className="row wrap">
          <Button to={`/customers/${deal.customer_id}`} icon="users">Customer</Button>
          {deal.enquiry && <Button to={`/enquiries/${deal.enquiry.id}`} icon="inbox">Enquiry {deal.enquiry.code}</Button>}
          {deal.quotation && <Button to={`/quotations/${deal.quotation.id}`} icon="quotation">Quotation {deal.quotation.number}</Button>}
          {deal.order && <Button to={`/orders/${deal.order.id}`} icon="box">Order {deal.order.code}</Button>}
        </div>
      </div>
    </Drawer>
  );
}

export default function Pipeline() {
  const people = usePeople({ activeOnly: false });
  const [f, setF] = useUrlFilters({ view: 'board' });
  const { data, error, loading, reload } = useApi('/pipeline', { q: f.q, owner: f.owner, stage: f.stage, stuck: f.stuck });
  const [open, setOpen] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const stages = data?.stages || [];
  const shownStages = stages.filter((s) => !f.stage || s.value === f.stage);
  return (
    <div className="stack">
      <PageHeader title="Sales pipeline" subtitle={data ? `${data.total} live · ${data.stuck} stuck` : 'Loading…'}
        actions={<Segmented label="View" value={f.view} onChange={(v) => setF({ view: v })} options={[{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }]} />} />
      <div className="stage-strip" role="group" aria-label="Journey stages">
        {stages.map((s) => (
          <button key={s.value} type="button" className={`stage ${f.stage === s.value ? 'on' : ''}`} aria-pressed={f.stage === s.value} onClick={() => setF({ stage: f.stage === s.value ? '' : s.value })}>
            <span className="l">{s.label}</span>
            <span className="n">{s.count}</span>
            <span className={`s ${s.stuck ? 'bad' : ''}`}>{s.stuck ? `${s.stuck} stuck` : 'None stuck'}</span>
          </button>
        ))}
      </div>
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer…" />
        <Select aria-label="Assigned to" value={f.owner || ''} onChange={(e) => setF({ owner: e.target.value })} placeholder="Everyone" options={people.map((p) => ({ value: String(p.id), label: p.name }))} />
        <Chips value={f.stuck || ''} onChange={(v) => setF({ stuck: v })} options={[{ value: '', label: 'All' }, { value: '1', label: 'Stuck', tone: 'red' }]} />
      </div>
      {!data && loading && <Spinner />}
      {data && !data.count && (
        <EmptyState icon="pipeline" title={data.total ? 'No deals match these filters' : 'Nothing in the pipeline yet'}
          message={data.total ? 'Clear a filter to see more.' : 'Add a customer, then an enquiry. It moves along here by itself.'}
          action={!data.total && <Button variant="primary" icon="users" to="/customers">Go to customers</Button>} />
      )}
      {data && data.count > 0 && f.view === 'board' && (
        <div className="kanban">
          {shownStages.map((s) => {
            const items = data.items.filter((d) => d.stage === s.value);
            return (
              <div key={s.value} className="kcol">
                <div className="kcol-head"><strong>{s.label}</strong><span className="tiny muted">{items.length} shown{s.stuck ? ` · ${s.stuck} stuck` : ''}</span></div>
                <div className="kcol-body">
                  {items.map((d) => <DealCard key={d.key} deal={d} onOpen={setOpen} />)}
                  {!items.length && <div className="tiny muted" style={{ padding: 8 }}>Nothing here</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {data && data.count > 0 && f.view === 'list' && (
        <Card flush>
          <DataTable rows={data.items} rowKey="key" onRowClick={setOpen} columns={[
            { key: 'c', label: 'Customer', render: (d) => <><strong>{d.customer_name}</strong><div className="sub">{d.code} · {d.title}</div></> },
            { key: 'st', label: 'Stage', render: (d) => <span className="stack-xs"><span className="small strong">{d.stage_label}</span><StuckBadge deal={d} /></span> },
            { key: 'why', label: 'Why it is stuck', render: (d) => (d.reasons.length ? <DealReasons deal={d} limit={2} /> : <span className="muted small">Nothing blocking</span>) },
            { key: 'days', label: 'Days here', align: 'num', render: (d) => d.days_in_stage },
            { key: 'pay', label: 'Payment', render: (d) => <PaymentBadge payment={d.payment} /> },
            { key: 'next', label: 'Next action', render: (d) => (d.next_action ? <span className="small">{d.next_action.purpose}<div className="tiny muted">{date(d.next_action.due_date)}</div></span> : <span className="muted small">None</span>) },
            { key: 'o', label: 'Assigned to', render: (d) => <span className="small">{d.owner_name}</span> },
          ]} />
        </Card>
      )}
      <DealDrawer deal={open} onClose={() => setOpen(null)} />
    </div>
  );
}
