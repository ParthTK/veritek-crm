import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Segmented, Select, Spinner, Modal, useToast, SearchBox, Stat,
} from '../components/ui.jsx';
import { DueBadge, StageBadge, Timeline, usePeople } from '../components/domain.jsx';
import { FollowupForm, RescheduleForm, ReassignForm, CancelTaskForm } from '../components/forms.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';

export default function Followups() {
  const { user, can } = useAuth();
  const toast = useToast();
  const quick = useQuickEntry();
  const people = usePeople();
  const [f, setF] = useUrlFilters({ bucket: 'overdue', owner: can('tasks.manage_any') ? '' : 'me' });
  const { data, error, loading, reload } = useApi('/tasks', { bucket: f.bucket, owner: f.owner, kind: f.kind, promise: f.promise, q: f.q });
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [modal, setModal] = useState(null);
  const perf = useApi(can('reports.view') ? '/reports/followup_performance' : null, { from: new Date().toISOString().slice(0, 8) + '01' });

  const select = useCallback(async (row) => {
    setSelected(row);
    setContext(null);
    try {
      const task = await api.get(`/tasks/${row.id}`);
      const [profile, timeline] = task.customer_id && can('customers.view')
        ? await Promise.all([api.get(`/customers/${task.customer_id}`), api.get(`/customers/${task.customer_id}/timeline`, { limit: 5 })])
        : [null, []];
      setContext({ task, contacts: profile?.contacts?.filter((c) => c.active) || [], timeline, health: profile?.health || [] });
    } catch (err) {
      toast.error(err.message);
    }
  }, [can, toast]);
  useEffect(() => {
    if (data?.rows?.length && (!selected || !data.rows.some((r) => r.id === selected.id))) select(data.rows[0]);
    if (data && !data.rows.length) setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    setSelected(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const counts = data?.counts || {};
  const canAct = (t) => t && (t.owner_id === user.id || can('tasks.manage_any') || (user.group === 'sales' && t.kind === 'customer'));
  const t = context?.task;

  return (
    <div className="stack">
      <PageHeader title="Who needs a follow-up?" subtitle="Every open enquiry has an owner and a next action. One save records what happened and schedules what comes next."
        actions={can('enquiries.edit') && <Button variant="cta" icon="plus" onClick={() => quick.open('enquiry')}>Quick entry</Button>} />
      <div className="row wrap between">
        <Chips value={f.bucket} onChange={(v) => setF({ bucket: v })} options={[
          { value: 'overdue', label: 'Overdue', count: counts.overdue ?? '…', tone: 'red' },
          { value: 'today', label: 'Today', count: counts.today ?? '…', tone: 'amber' },
          { value: 'upcoming', label: 'Upcoming', count: counts.upcoming ?? '…' },
        ]} />
        <div className="row wrap">
          <Select aria-label="Owner" value={f.owner} onChange={(e) => setF({ owner: e.target.value })} options={[{ value: 'me', label: 'My follow-ups' }, ...people.map((p) => ({ value: String(p.id), label: p.name }))]} placeholder="Everyone I can see" />
          <Segmented label="Kind" value={f.kind || ''} onChange={(v) => setF({ kind: v })} options={[{ value: '', label: 'All' }, { value: 'customer', label: 'Customer contact' }, { value: 'internal', label: 'Internal' }]} />
          <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer, enquiry, order…" />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="split wide">
        <Card flush>
          <DataTable loading={loading} rows={data?.rows} selectedKey={selected?.id} onRowClick={select}
            empty={<div className="empty">{f.bucket === 'overdue' ? 'No overdue follow-ups in this view.' : 'Nothing in this list.'}</div>}
            columns={[
              { key: 'customer', label: 'Customer', render: (r) => <><strong>{r.customer_name || r.order_code || '—'}</strong>{r.do_not_contact ? <> <Badge size="sm" tone="slate">Do not contact</Badge></> : null}</> },
              { key: 'product', label: 'Product', render: (r) => r.product || <span className="muted">—</span> },
              { key: 'purpose', label: 'Next action', render: (r) => <>{r.purpose}{r.reschedule_count > 0 && <div className="sub">Rescheduled {r.reschedule_count}× · originally {date(r.original_due_date)}</div>}</> },
              { key: 'owner', label: 'Owner', render: (r) => r.owner_name },
              { key: 'due', label: 'Due', render: (r) => <DueBadge task={r} /> },
            ]}
            card={(r) => <><div className="row between"><strong>{r.customer_name || r.order_code}</strong><DueBadge task={r} /></div><div className="small">{r.purpose}</div><div className="tiny muted">{r.owner_name}{r.product ? ` · ${r.product}` : ''}</div></>}
          />
        </Card>
        <div className="sticky-side">
          {selected && !context && <Card><Spinner /></Card>}
          {t && (
            <Card title={t.customer_id && can('customers.view') ? <Link to={`/customers/${t.customer_id}`}>{t.customer_name}</Link> : t.customer_name || t.order_code}>
              <div className="stack-sm">
                <div className="row wrap">
                  {t.enquiry_stage && <StageBadge stage={t.enquiry_stage} />}
                  <DueBadge task={t} />
                  {t.enquiry_code && <Link className="small" to={`/enquiries/${t.enquiry_id}`}>{t.enquiry_code}</Link>}
                  {t.order_code && <Link className="small" to={`/orders/${t.order_id}`}>{t.order_code}</Link>}
                  {context.health.map((h) => <Badge key={h.code} size="sm" tone={h.tone}>{h.label}</Badge>)}
                </div>
                <div className="strong">{t.purpose}</div>
                <div className="small muted">Owner {t.owner_name}{t.escalated_at ? ' · escalated to manager' : ''} · created by {t.source.replace(/_/g, ' ')}</div>
                {context.timeline.length > 0 && <><div className="divider" /><Timeline items={context.timeline} compact /></>}
                <div className="divider" />
                {!canAct(t) ? <div className="muted small">Only the owner, the coordinator or management can update this task.</div>
                  : t.purpose_code === 'customer_update' ? (
                    <div className="stack-sm"><div className="small">Customer updates are recorded against the specific date revision on the order.</div><Button variant="primary" to={`/orders/${t.order_id}`}>Open {t.order_code}</Button></div>
                  ) : (
                    <>
                      <FollowupForm key={t.id} task={t} contacts={context.contacts} onSaved={() => done('Outcome recorded')} />
                      <div className="row wrap">
                        <Button size="sm" variant="ghost" icon="calendar" onClick={() => setModal('reschedule')}>Reschedule</Button>
                        <Button size="sm" variant="ghost" icon="user" onClick={() => setModal('reassign')}>Reassign</Button>
                        <Button size="sm" variant="ghost" icon="x" onClick={() => setModal('cancel')}>Cancel task</Button>
                      </div>
                    </>
                  )}
              </div>
            </Card>
          )}
        </div>
      </div>
      {perf.data && (
        <Card>
          <div className="row wrap between">
            <strong>Follow-up performance this month</strong>
            <div className="row wrap">
              {perf.data.metrics.filter((m) => ['total', 'completed_on_time', 'completed_late', 'open_overdue', 'rescheduled'].includes(m.key)).map((m) => <Stat key={m.key} k={m.label} v={m.count} />)}
            </div>
            <span className="tiny muted">Figures depend on recorded updates. <Link to="/reports?r=followup_performance">Details by owner</Link></span>
          </div>
        </Card>
      )}
      <Modal open={Boolean(modal)} size="sm" onClose={() => setModal(null)} title={{ reschedule: 'Reschedule follow-up', reassign: 'Reassign follow-up', cancel: 'Cancel follow-up' }[modal]}>
        {modal === 'reschedule' && t && <RescheduleForm task={t} onSaved={() => done('Rescheduled — the original date is kept')} />}
        {modal === 'reassign' && t && <ReassignForm task={t} onSaved={() => done('Reassigned')} />}
        {modal === 'cancel' && t && <CancelTaskForm task={t} onSaved={() => done('Task cancelled')} />}
      </Modal>
    </div>
  );
}
