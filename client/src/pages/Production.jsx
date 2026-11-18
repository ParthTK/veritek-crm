// Production board: every active order line by broad phase, most urgent first, with its blocker, forecast
// and how fresh the information is. Updating a card uses the same quick update as the order page.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PRIORITIES, labelOf, toneOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, qty, relDay, timeAgo } from '../lib/format.js';
import { Badge, Button, Chips, Drawer, EmptyState, ErrorState, PageHeader, Select, Spinner } from '../components/ui.jsx';
import { LineStateBadge, useMeta, PaymentBadge } from '../components/domain.jsx';
import { ProductionUpdateForm } from '../components/forms.jsx';

export default function Production() {
  const { user, can } = useAuth();
  const meta = useMeta();
  const [f, setFilter] = useUrlFilters({ factory_id: user.factory_id ? String(user.factory_id) : '' });
  const { data, error, loading, reload } = useApi('/production/board', { factory_id: f.factory_id, priority: f.priority, state: f.state });
  const [editing, setEditing] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const canUpdate = can('orders.update');
  return (
    <div className="stack">
      <PageHeader title="Production board" subtitle={data ? `${data.total} active line${data.total === 1 ? '' : 's'} · most urgent first in each phase` : 'Loading…'}
        actions={<>
          <Select aria-label="Factory" value={f.factory_id || ''} onChange={(e) => setFilter({ factory_id: e.target.value })} placeholder="All factories" options={meta.factories.map((x) => ({ value: String(x.id), label: x.name }))} style={{ width: 'auto' }} />
          <Select aria-label="Priority" value={f.priority || ''} onChange={(e) => setFilter({ priority: e.target.value })} placeholder="Any priority" options={PRIORITIES} style={{ width: 'auto' }} />
        </>} />
      <Chips value={f.state || ''} onChange={(v) => setFilter({ state: v })} options={[
        { value: '', label: 'All lines' }, { value: 'delayed', label: 'Delayed or at risk', tone: 'red' }, { value: 'issue', label: 'Issue reported', tone: 'amber' }, { value: 'stale', label: 'Not updated recently', tone: 'amber' },
      ]} />
      {f.factory_id && <div className="tiny muted">Lines without a factory are shown too, until one is assigned.</div>}
      {!data && loading && <Spinner />}
      {data && !data.total && <EmptyState icon="factory" title="Nothing in production here" message="No active lines match these filters." />}
      {data && data.total > 0 && (
        <div className="kanban">
          {data.columns.map((col) => (
            <div key={col.phase} className="kcol">
              <div className="kcol-head"><strong>{col.label}</strong><span className="tiny muted">{col.lines.length} line{col.lines.length === 1 ? '' : 's'} · {col.lines.filter((l) => ['overdue', 'at_risk'].includes(l.state)).length} late or at risk</span></div>
              <div className="kcol-body">
                {col.lines.map((l) => (
                  <div key={l.id} className="kcard">
                    <div className="row between" style={{ gap: 6 }}>
                      <Link to={`/orders/${l.order_id}`} className="strong small">{l.order_code}</Link>
                      <span className="row" style={{ gap: 4 }}>
                        {l.priority && l.priority !== 'normal' && <Badge size="sm" tone={toneOf(PRIORITIES, l.priority)}>{labelOf(PRIORITIES, l.priority)}</Badge>}
                        <LineStateBadge state={l.state} daysLate={l.days_late} size="sm" />
                      </span>
                    </div>
                    <div className="row between" style={{ gap: 4 }}><span className="tiny muted truncate">{l.customer_name}</span><PaymentBadge payment={l.payment} /></div>
                    <div className="small mt-8"><strong>{l.product}</strong> · {qty(l.quantities.remaining, l.unit)} to go{l.quantities.ready !== null && l.quantities.ready !== undefined ? ` · ${qty(l.quantities.readyNotDispatched)} ready` : ''}</div>
                    <div className="tiny muted">{l.work_status_label}{l.needs_clarification ? ' · specification to clarify' : ''}</div>
                    {l.issue_label && <div className="tiny warning-text strong">{l.issue_label}{l.stage_note ? ` — ${l.stage_note}` : ''}</div>}
                    {l.qc_summary && <div className="tiny">QC: {l.qc_summary}</div>}
                    <div className="tiny mt-8">
                      Promised {l.original_commitment_date ? date(l.original_commitment_date) : 'not committed'}
                      {' · '}forecast {l.estimate_unknown ? <span className="warning-text">unknown</span> : l.forecast_dispatch_date ? relDay(l.forecast_dispatch_date) : '—'}
                    </div>
                    <div className="row between mt-8">
                      <span className={`tiny ${l.stale ? 'warning-text strong' : 'muted'}`} title={l.freshness?.threshold ? `Stale after ${l.freshness.threshold} working days` : undefined}>{l.freshness?.as_of ? `Updated ${timeAgo(l.freshness.as_of)}` : 'No update yet'}{l.stale ? ' · stale' : ''}</span>
                      {canUpdate && <Button size="xs" variant="primary" onClick={() => setEditing(l)}>Update</Button>}
                    </div>
                  </div>
                ))}
                {!col.lines.length && <div className="tiny muted" style={{ padding: 8 }}>Nothing here</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <Drawer open={Boolean(editing)} onClose={() => setEditing(null)} title={editing ? `${editing.order_code} · line ${editing.line_no}` : ''} subtitle={editing ? `${editing.product} — ${editing.customer_name}` : ''}>
        {editing && <ProductionUpdateForm line={editing} order={{ id: editing.order_id, status: 'confirmed' }} compact onSaved={() => { setEditing(null); reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Drawer>
    </div>
  );
}
