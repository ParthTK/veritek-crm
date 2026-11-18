// Who needs a follow-up: the list on the left; on the right, who to call, what happened and what comes next.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import {
  Button, Card, Chips, DataTable, ErrorState, PageHeader, Select, Spinner, Modal, useToast, SearchBox,
} from '../components/ui.jsx';
import { DueBadge, StageBadge, Timeline, usePeople } from '../components/domain.jsx';
import { FollowupForm, RescheduleForm, ReassignForm, CancelTaskForm } from '../components/forms.jsx';

export default function Followups() {
  const { user, can } = useAuth();
  const toast = useToast();
  const people = usePeople();
  const [f, setF] = useUrlFilters({ bucket: 'overdue', owner: can('tasks.manage_any') ? '' : 'me' });
  const { data, error, loading, reload } = useApi('/tasks', { bucket: f.bucket, owner: f.owner, q: f.q });
  const [selected, setSelected] = useState(null);
  const [context, setContext] = useState(null);
  const [modal, setModal] = useState(null);

  const select = useCallback(async (row) => {
    setSelected(row);
    setContext(null);
    try {
      const task = await api.get(`/tasks/${row.id}`);
      const [profile, timeline] = task.customer_id && can('customers.view')
        ? await Promise.all([api.get(`/customers/${task.customer_id}`), api.get(`/customers/${task.customer_id}/timeline`, { limit: 3 })])
        : [null, []];
      const contacts = profile?.contacts?.filter((c) => c.active) || [];
      setContext({ task, contact: contacts.find((c) => c.is_primary) || contacts[0] || null, timeline });
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
  const t = selected && context?.task;
  const contact = context?.contact;

  return (
    <div className="stack">
      <PageHeader title="Follow-ups" />
      <div className="row wrap between">
        <Chips value={f.bucket} onChange={(v) => setF({ bucket: v })} options={[
          { value: 'overdue', label: 'Overdue', count: counts.overdue ?? '…', tone: 'red' },
          { value: 'today', label: 'Today', count: counts.today ?? '…', tone: 'amber' },
          { value: 'upcoming', label: 'Upcoming', count: counts.upcoming ?? '…' },
        ]} />
        <div className="row wrap">
          <Select aria-label="Assigned to" value={f.owner} onChange={(e) => setF({ owner: e.target.value })} options={[{ value: 'me', label: 'Mine' }, ...people.map((p) => ({ value: String(p.id), label: p.name }))]} placeholder="Everyone" />
          <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer…" />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="split wide">
        <Card flush>
          <DataTable loading={loading} rows={data?.rows} selectedKey={selected?.id} onRowClick={select}
            empty={<div className="empty">Nothing here.</div>}
            columns={[
              { key: 'customer', label: 'Customer', render: (r) => <strong>{r.customer_name || r.order_code || '—'}</strong> },
              { key: 'purpose', label: 'Next action', render: (r) => r.purpose },
              { key: 'owner', label: 'Assigned to', render: (r) => r.owner_name },
              { key: 'due', label: 'Due', render: (r) => <DueBadge task={r} /> },
            ]}
            card={(r) => <><div className="row between"><strong>{r.customer_name || r.order_code}</strong><DueBadge task={r} /></div><div className="small">{r.purpose}</div><div className="tiny muted">{r.owner_name}</div></>}
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
                </div>
                <div className="strong">{t.purpose}</div>
                {contact && <div className="small">{contact.name}{contact.phone_raw && <> · <a href={`tel:${contact.phone_raw.replace(/\s/g, '')}`}>{contact.phone_raw}</a></>}</div>}
                {context.timeline.length > 0 && <><div className="divider" /><Timeline items={context.timeline} compact /></>}
                <div className="divider" />
                {!canAct(t) ? <div className="muted small">Only the person assigned, a coordinator or management can update this.</div>
                  : t.purpose_code === 'customer_update' ? (
                    <Button variant="primary" to={`/orders/${t.order_id}`}>Open {t.order_code}</Button>
                  ) : (
                    <>
                      <FollowupForm key={t.id} task={t} onSaved={() => done('Saved')} />
                      <div className="row wrap">
                        <Button size="sm" variant="ghost" icon="calendar" onClick={() => setModal('reschedule')}>Reschedule</Button>
                        <Button size="sm" variant="ghost" icon="user" onClick={() => setModal('reassign')}>Reassign</Button>
                        <Button size="sm" variant="ghost" icon="x" onClick={() => setModal('cancel')}>Cancel</Button>
                      </div>
                    </>
                  )}
              </div>
            </Card>
          )}
        </div>
      </div>
      <Modal open={Boolean(modal)} size="sm" onClose={() => setModal(null)} title={{ reschedule: 'Reschedule follow-up', reassign: 'Reassign follow-up', cancel: 'Cancel follow-up' }[modal]}>
        {modal === 'reschedule' && t && <RescheduleForm task={t} onSaved={() => done('Rescheduled')} />}
        {modal === 'reassign' && t && <ReassignForm task={t} onSaved={() => done('Reassigned')} />}
        {modal === 'cancel' && t && <CancelTaskForm task={t} onSaved={() => done('Cancelled')} />}
      </Modal>
    </div>
  );
}
