// Production board: every active item by stage, most urgent first. Update moves it along.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, qty } from '../lib/format.js';
import { Button, Chips, Drawer, EmptyState, ErrorState, PageHeader, Spinner } from '../components/ui.jsx';
import { LineStateBadge, PaymentBadge } from '../components/domain.jsx';
import { ProductionUpdateForm } from '../components/forms.jsx';

export default function Production() {
  const { can } = useAuth();
  const [f, setFilter] = useUrlFilters();
  const { data, error, loading, reload } = useApi('/production/board', { state: f.state });
  const [editing, setEditing] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const canUpdate = can('orders.update');
  return (
    <div className="stack">
      <PageHeader title="Production" />
      <Chips value={f.state || ''} onChange={(v) => setFilter({ state: v })} options={[{ value: '', label: 'All' }, { value: 'delayed', label: 'Delayed', tone: 'red' }]} />
      {!data && loading && <Spinner />}
      {data && !data.total && <EmptyState icon="factory" title="Nothing in production" />}
      {data && data.total > 0 && (
        <div className="kanban">
          {data.columns.map((col) => (
            <div key={col.phase} className="kcol">
              <div className="kcol-head"><strong>{col.label}</strong><span className="tiny muted">{col.lines.length}</span></div>
              <div className="kcol-body">
                {col.lines.map((l) => (
                  <div key={l.id} className="kcard">
                    <div className="row between" style={{ gap: 6 }}>
                      <Link to={`/orders/${l.order_id}`} className="strong small">{l.order_code}</Link>
                      <LineStateBadge state={l.state} daysLate={l.days_late} size="sm" />
                    </div>
                    <div className="row between" style={{ gap: 4 }}><span className="tiny muted truncate">{l.customer_name}</span><PaymentBadge payment={l.payment} /></div>
                    <div className="small mt-8"><strong>{l.product}</strong> · {qty(l.quantities.remaining, l.unit)} to go{l.quantities.ready !== null && l.quantities.ready !== undefined ? ` · ${qty(l.quantities.readyNotDispatched)} ready` : ''}</div>
                    {l.needs_clarification ? <div className="tiny warning-text strong">Specification to confirm</div> : null}
                    {l.issue_label && <div className="tiny warning-text strong">{l.issue_label}{l.stage_note ? ` — ${l.stage_note}` : ''}</div>}
                    <div className="row between mt-8">
                      <span className="tiny muted">{l.original_commitment_date ? `By ${date(l.original_commitment_date)}` : 'No date yet'}</span>
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
      <Drawer open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.order_code || ''} subtitle={editing ? `${editing.product} — ${editing.customer_name}` : ''}>
        {editing && <ProductionUpdateForm line={editing} onSaved={() => { setEditing(null); reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Drawer>
    </div>
  );
}
