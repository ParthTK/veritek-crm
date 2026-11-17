import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SELECTABLE_PHASES, PHASES, WORK_STATUSES, labelOf } from '@shared/constants.js';
import { api, downloadAuthed } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { date, qty, timeAgo } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, SearchBox, Segmented, Modal, Field, Select, Input, Notice, SaveStatus, useToast,
} from '../components/ui.jsx';
import { LineStateBadge, PhaseLabel, OutcomeBadges, CommBadge, FilterBar, OptionSelect, UserSelect, Money } from '../components/domain.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';

const CHIPS = [
  ['', 'All'], ['overdue', 'Dispatch overdue', 'red'], ['at_risk', 'Forecast late', 'amber'], ['issue', 'Issue reported'], ['not_informed', 'Customer not informed', 'red'],
  ['ready_waiting', 'Ready to dispatch'], ['stale', 'Needs fresh update', 'amber'], ['no_action', 'No next action'], ['uncommitted', 'No committed date'], ['estimate_unknown', 'Estimate unknown'],
];

export default function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const quick = useQuickEntry();
  const toast = useToast();
  const [f, setF] = useUrlFilters({ view: 'active' });
  const { data, error, loading, reload } = useApi('/orders', f);
  const [bulk, setBulk] = useState(false);
  const counts = data?.counts || {};
  return (
    <div className="stack">
      <PageHeader title={f.view === 'active' ? 'Active orders' : 'Orders'} subtitle="Remaining quantities, original promises, current forecasts, delays and dispatch progress."
        actions={<>
          {can('export.lists') && <Button icon="download" onClick={() => downloadAuthed('/export/orders.csv', f).catch((e) => toast.error(e.message))}>Export lines</Button>}
          {can('orders.update') && f.view === 'active' && <Button icon="layers" onClick={() => setBulk(true)}>Bulk update</Button>}
          {can('dispatch.post') && <Button icon="truck" onClick={() => quick.open('dispatch')}>Record dispatch</Button>}
          {can('orders.edit') && <Button variant="cta" icon="plus" to="/orders/new">Direct order</Button>}
        </>} />
      <div className="row wrap between">
        <Segmented label="View" value={f.view} onChange={(v) => setF({ view: v, state: '' })} options={[{ value: 'active', label: 'Active' }, { value: 'drafts', label: 'Drafts' }, { value: 'closed', label: 'Closed' }, { value: 'all', label: 'All' }]} />
        <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Order, PO, customer, product…" />
      </div>
      {f.view === 'active' && <Chips value={f.state || ''} onChange={(v) => setF({ state: v })} options={CHIPS.map(([value, label, tone]) => ({ value, label, tone, count: value ? counts[value] : data?.rows ? undefined : undefined }))} />}
      <FilterBar value={f} onChange={setF} />
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/orders/${r.id}`)}
          empty={<div className="empty">No orders in this view.</div>}
          columns={[
            { key: 'order', label: 'Order', render: (r) => <><strong>{r.code}</strong>{r.pinned && <Badge size="sm" tone="violet" icon="pin">Pinned</Badge>}<div className="sub">{r.po_reference ? `PO ${r.po_reference}` : 'No PO ref'} · {date(r.received_date)}</div></> },
            { key: 'customer', label: 'Customer', render: (r) => r.customer_name },
            { key: 'lines', label: 'Lines', render: (r) => <>{r.lines.slice(0, 2).map((l) => <div key={l.id} className="small">{qty(l.quantities.remaining, l.unit)} of {qty(l.quantities.confirmed)} × {l.product}</div>)}{r.lines.length > 2 && <div className="sub">+{r.lines.length - 2} more</div>}</> },
            { key: 'phase', label: 'Phase', render: (r) => (r.status === 'draft' ? <Badge>Draft</Badge> : r.active ? <PhaseLabel phase={r.phase} /> : <OutcomeBadges outcome={r.outcome} size="sm" />) },
            { key: 'state', label: 'Status', render: (r) => (r.status !== 'confirmed' ? null : !r.active ? <OutcomeBadges outcome={r.outcome} size="sm" /> : <span className="stack-xs">
              {r.overdue ? <LineStateBadge state="overdue" daysLate={r.max_days_late} pastAgreed={r.past_agreed} /> : r.at_risk ? <LineStateBadge state="at_risk" /> : r.issue ? <LineStateBadge state="issue" /> : r.uncommitted ? <LineStateBadge state="uncommitted" /> : <LineStateBadge state="on_track" />}
              {r.ready_waiting > 0 && <Badge size="sm" tone="teal">Ready to dispatch</Badge>}
            </span>) },
            { key: 'due', label: 'Original promise', render: (r) => (r.earliest_due ? <>{date(r.earliest_due)}{r.latest_due && r.latest_due !== r.earliest_due && <div className="sub">to {date(r.latest_due)}</div>}</> : <span className="muted">—</span>) },
            { key: 'informed', label: 'Customer informed', render: (r) => (r.comm_pending ? <CommBadge state="pending" size="sm" /> : <span className="muted small">{r.delayed ? 'Yes' : '—'}</span>) },
            { key: 'update', label: 'Last update', render: (r) => (r.active ? <span className="small">{r.last_update_at ? timeAgo(r.last_update_at) : 'never'}{r.stale_lines > 0 && <div><Badge size="sm" tone="amber">Needs update</Badge></div>}</span> : null) },
            { key: 'owner', label: 'Owner', render: (r) => r.owner_name },
            can('values.view') && { key: 'value', label: 'Open value', align: 'num', render: (r) => Object.entries(r.remaining_value_by_currency || {}).map(([c, v]) => <div key={c}><Money minor={v} currency={c} /></div>) },
          ]}
          card={(r) => <><div className="row between"><strong>{r.code} · {r.customer_name}</strong>{r.overdue ? <LineStateBadge state="overdue" daysLate={r.max_days_late} size="sm" /> : r.at_risk ? <LineStateBadge state="at_risk" size="sm" /> : null}</div>
            {r.lines.slice(0, 2).map((l) => <div key={l.id} className="small">{qty(l.quantities.remaining, l.unit)} × {l.product} · promised {date(l.original_commitment_date)}</div>)}
            <div className="row wrap"><PhaseLabel phase={r.phase} />{r.comm_pending > 0 && <CommBadge state="pending" size="sm" />}{r.stale_lines > 0 && <Badge size="sm" tone="amber">Needs update</Badge>}</div></>}
        />
      </Card>
      <div className="small muted">An order with several late lines is counted once. Delays are measured against the original committed dispatch date; a customer-agreed revision is shown alongside, never instead.</div>
      <Modal open={bulk} size="xl" onClose={() => setBulk(false)} title="Bulk update" subtitle="Preview the affected lines, confirm once, and see the result for every line.">
        {bulk && <BulkUpdate rows={data?.rows || []} onDone={() => { reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Modal>
    </div>
  );
}

function BulkUpdate({ rows, onDone }) {
  const { user } = useAuth();
  const toast = useToast();
  const save = useSave();
  const lines = useMemo(() => rows.flatMap((o) => o.lines.filter((l) => l.quantities.remaining > 0).map((l) => ({ ...l, order: o }))), [rows]);
  const [sel, setSel] = useState(new Set());
  const [ch, setCh] = useState({ mode: 'status', phase: '', work_status: '', issue_code: '', stage_note: '', forecast_dispatch_date: '', reported_by_id: null });
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const changes = () => (ch.mode === 'still' ? { still_on_track: true } : {
    ...(ch.phase && { phase: ch.phase }), ...(ch.work_status && { work_status: ch.work_status }), ...(ch.issue_code && { issue_code: ch.issue_code }),
    ...(ch.stage_note && { stage_note: ch.stage_note }), ...(ch.forecast_dispatch_date && { forecast_dispatch_date: ch.forecast_dispatch_date }),
  });
  const body = () => ({ line_ids: [...sel], changes: changes(), reported_by_id: ch.reported_by_id || undefined });
  const toggle = (id) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
    setPreview(null);
  };
  if (result) {
    return (
      <div className="stack-sm">
        <Notice tone={result.failed ? 'warn' : 'success'} title={`${result.applied} line(s) updated${result.failed ? `, ${result.failed} failed` : ''}`}>Every line is listed below — nothing was skipped silently.</Notice>
        <ResultTable results={result.results} />
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <div className="table-wrap" style={{ maxHeight: 280 }}>
        <table className="table compact">
          <thead><tr><th><input type="checkbox" aria-label="Select all" checked={sel.size === lines.length && lines.length > 0} onChange={(e) => { setSel(e.target.checked ? new Set(lines.map((l) => l.id)) : new Set()); setPreview(null); }} /></th><th>Order / line</th><th>Phase</th><th>Status</th><th>Promised</th></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} onClick={() => toggle(l.id)} className="clickable">
              <td><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`${l.order.code} line ${l.line_no}`} /></td>
              <td><strong>{l.order.code}</strong> · {l.order.customer_name} · {l.product}</td>
              <td className="small">{l.phase_label}</td><td><LineStateBadge state={l.state} daysLate={l.days_late} size="sm" /></td><td className="small">{date(l.original_commitment_date)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="small muted">Closed lines are excluded. Dispatch quantities can never be bulk-created — each dispatch is allocated to its lines.</div>
      <Segmented value={ch.mode} onChange={(v) => { setCh({ ...ch, mode: v }); setPreview(null); }} options={[{ value: 'status', label: 'Change status / reason / forecast' }, { value: 'still', label: 'Confirm still on track' }]} />
      {ch.mode === 'status' && (
        <div className="form-grid three">
          <Field label="Phase" optional><Select value={ch.phase} onChange={(e) => setCh({ ...ch, phase: e.target.value })} options={SELECTABLE_PHASES.map((p) => ({ value: p, label: labelOf(PHASES, p) }))} placeholder="No change" /></Field>
          <Field label="Status" optional><Select value={ch.work_status} onChange={(e) => setCh({ ...ch, work_status: e.target.value })} options={WORK_STATUSES} placeholder="No change" /></Field>
          <Field label="Delay reason" optional><OptionSelect category="delay_reason" value={ch.issue_code} onChange={(v) => setCh({ ...ch, issue_code: v })} placeholder="No change" /></Field>
          <Field label="Stage / note" optional><Input value={ch.stage_note} onChange={(e) => setCh({ ...ch, stage_note: e.target.value })} /></Field>
          <Field label="Dispatch forecast" optional><Input type="date" value={ch.forecast_dispatch_date} onChange={(e) => setCh({ ...ch, forecast_dispatch_date: e.target.value })} /></Field>
        </div>
      )}
      {['admin', 'coordinator'].includes(user.group) && <Field label="Reported by" required><UserSelect value={ch.reported_by_id} onChange={(v) => setCh({ ...ch, reported_by_id: v })} /></Field>}
      {preview && <><div className="strong small">Preview — {preview.valid} line(s) will change</div><ResultTable results={preview.results} preview /></>}
      <div className="row between wrap">
        <SaveStatus save={save} />
        <div className="row">
          <Button disabled={!sel.size} loading={save.saving} onClick={() => save.run(async () => setPreview(await api.post('/order-lines/bulk/preview', body())))}>Preview</Button>
          <Button variant="cta" disabled={!preview || !preview.valid} loading={save.saving} onClick={() => save.run(async (key) => {
            const r = await api.post('/order-lines/bulk/apply', body(), { key });
            setResult(r);
            toast.success(`${r.applied} line(s) updated`);
            onDone();
          })}>Confirm & apply</Button>
        </div>
      </div>
    </div>
  );
}

function ResultTable({ results, preview }) {
  return (
    <div className="table-wrap" style={{ maxHeight: 260 }}>
      <table className="table compact">
        <thead><tr><th>Line</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>{results.map((r) => (
          <tr key={r.line_id}>
            <td>{r.order_code} · line {r.line_no} · {r.product}</td>
            <td>{r.ok ? (r.unchanged ? <Badge>No change</Badge> : <Badge tone="green">{preview ? 'Will update' : 'Updated'}</Badge>) : r.skipped ? <Badge>Excluded</Badge> : <Badge tone="red">Failed</Badge>}</td>
            <td className="small">{r.error ? `${r.error}${r.fields ? `: ${Object.values(r.fields).join('; ')}` : ''}` : r.changes ? Object.entries(r.changes).map(([k, [a, b]]) => `${k.replace(/_/g, ' ')} ${a ?? '—'} → ${b ?? '—'}`).join('; ') : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
