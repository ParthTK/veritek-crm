import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { date, dateTime, timeAgo, qty } from '../lib/format.js';
import { Badge, Button, Card, DataTable, ErrorState, PageHeader, Spinner, Tabs, Drawer, useToast, SearchBox } from '../components/ui.jsx';
import { DueBadge, LineStateBadge, CommBadge, StageBadge } from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';

export default function WorkQueue() {
  const toast = useToast();
  const quick = useQuickEntry();
  const [f, setF] = useUrlFilters({ tab: 'new_inputs' });
  const { data, error, reload } = useApi('/queue');
  const [task, setTask] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    api.get('/search', { q }).then(setFound).catch(() => setFound([]));
  }, [q]);
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('data:changed', on);
    return () => window.removeEventListener('data:changed', on);
  }, [reload]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const c = data.counts;
  const open = async (id) => {
    try {
      const t = await api.get(`/tasks/${id}`);
      const contacts = t.customer_id ? (await api.get(`/customers/${t.customer_id}`)).contacts.filter((x) => x.active) : [];
      setTask({ ...t, contacts });
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="stack">
      <PageHeader title="Work queue" subtitle="Everything the coordinator needs to chase today, without going through several pages per update."
        actions={<><Button icon="refresh" onClick={reload}>Refresh</Button><Button variant="cta" icon="plus" onClick={() => quick.open()}>Quick entry</Button></>} />
      <SearchBox value={q} onChange={setQ} placeholder="Find by company, phone, enquiry ID, order ID or customer PO…" />
      {found && (
        <Card title="Search results" flush>
          {!found.length && <div className="empty small">No matches.</div>}
          <div className="alert-list">{found.map((r) => <Link key={r.link + r.label} to={r.link} className="alert-row"><Badge size="sm">{r.type}</Badge><span className="who grow">{r.label}</span><span className="small muted">{r.sub}</span></Link>)}</div>
        </Card>
      )}
      <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[
        { key: 'new_inputs', label: 'New inputs', count: c.new_inputs },
        { key: 'followups_due', label: 'Follow-ups due', count: c.followups_due, tone: 'red' },
        { key: 'orders_needing_updates', label: 'Orders needing updates', count: c.orders_needing_updates },
        { key: 'missing_information', label: 'Missing information', count: c.missing_information },
      ]} />
      {f.tab === 'new_inputs' && (
        <div className="stack">
          <Card title="New enquiries awaiting a first response" flush>
            <DataTable rows={data.new_inputs.enquiries} empty={<div className="empty small">All new enquiries have been responded to.</div>} columns={[
              { key: 'code', label: 'Enquiry', render: (e) => <Link to={`/enquiries/${e.id}`}><strong>{e.code}</strong></Link> },
              { key: 'customer', label: 'Customer', render: (e) => e.company_name },
              { key: 'product', label: 'Product', render: (e) => e.product },
              { key: 'source', label: 'Source', render: (e) => e.source_label },
              { key: 'owner', label: 'Owner', render: (e) => e.owner_name },
              { key: 'received', label: 'Received', render: (e) => timeAgo(e.received_at) },
            ]} />
          </Card>
          <Card title="Draft orders with details missing" flush>
            <DataTable rows={data.new_inputs.drafts} empty={<div className="empty small">No draft orders.</div>} columns={[
              { key: 'code', label: 'Order', render: (o) => <Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link> },
              { key: 'customer', label: 'Customer', render: (o) => o.company_name }, { key: 'owner', label: 'Owner', render: (o) => o.owner_name }, { key: 'created', label: 'Entered', render: (o) => timeAgo(o.created_at) },
            ]} />
          </Card>
          <Card title="Technical issues to convert into complaints" flush>
            <DataTable rows={data.new_inputs.technical} empty={<div className="empty small">None.</div>} columns={[
              { key: 'customer', label: 'Customer', render: (a) => <Link to={`/customers/${a.customer_id}`}>{a.company_name}</Link> },
              { key: 'note', label: 'Note', render: (a) => a.note }, { key: 'when', label: 'When', render: (a) => dateTime(a.occurred_at) },
              { key: 'act', label: '', render: (a) => <Button size="xs" to={`/complaints?from_activity=${a.id}&customer=${a.customer_id}`}>Register complaint</Button> },
            ]} />
          </Card>
        </div>
      )}
      {f.tab === 'followups_due' && (
        <Card flush>
          <DataTable rows={data.followups_due} empty={<div className="empty small">No follow-ups due today or overdue.</div>} columns={[
            { key: 'customer', label: 'Customer', render: (t) => (t.customer_id ? <Link to={`/customers/${t.customer_id}`}>{t.customer_name}</Link> : t.order_code) },
            { key: 'purpose', label: 'Next action', render: (t) => <>{t.purpose}<div className="sub">{t.kind === 'internal' ? 'Internal' : 'Customer contact'}{t.enquiry_code ? ` · ${t.enquiry_code}` : ''}{t.order_code ? ` · ${t.order_code}` : ''}</div></> },
            { key: 'owner', label: 'Owner', render: (t) => <>{t.owner_name}{!t.owner_active ? <Badge size="sm" tone="red">inactive</Badge> : null}</> },
            { key: 'last', label: 'Last result', render: (t) => t.last_outcome_label || '—' },
            { key: 'due', label: 'Due', render: (t) => <DueBadge task={t} /> },
            { key: 'act', label: '', render: (t) => (t.purpose_code === 'customer_update' ? <Button size="xs" to={`/orders/${t.order_id}`}>Open order</Button> : <Button size="xs" variant="primary" onClick={() => open(t.id)}>Record</Button>) },
          ]} />
        </Card>
      )}
      {f.tab === 'orders_needing_updates' && (
        <Card flush>
          <DataTable rows={data.orders_needing_updates} empty={<div className="empty small">All active orders have current updates.</div>} columns={[
            { key: 'order', label: 'Order', render: (o) => <><Link to={`/orders/${o.id}`}><strong>{o.code}</strong></Link><div className="sub">{o.customer_name}</div></> },
            { key: 'why', label: 'Needs', render: (o) => <div className="row wrap" style={{ gap: 4 }}>{o.reasons.map((r) => <Badge key={r} size="sm" tone={/overdue|not informed/i.test(r) ? 'red' : 'amber'}>{r}</Badge>)}</div> },
            { key: 'lines', label: 'Lines', render: (o) => o.lines.filter((l) => l.quantities.remaining > 0).slice(0, 3).map((l) => <div key={l.id} className="small">{l.product} · {l.phase_label} · last update {l.source_update_at ? timeAgo(l.source_update_at) : 'never'}</div>) },
            { key: 'act', label: '', render: (o) => { const l = o.lines.find((x) => x.quantities.remaining > 0); return l ? <Button size="xs" variant="primary" onClick={() => quick.open('update', { line_id: l.id, order_code: o.code })}>Update</Button> : null; } },
          ]} />
        </Card>
      )}
      {f.tab === 'missing_information' && (
        <div className="stack">
          {data.missing_information.filter((g) => g.count).map((g) => (
            <Card key={g.code} title={g.label} sub={`${g.count} · ${g.help}`} flush>
              <DataTable rows={g.items.map((it, i) => ({ ...it, _k: i }))} rowKey="_k" columns={[
                { key: 'label', label: 'Record', render: (it) => <Link to={it.link}>{it.label}</Link> },
                { key: 'detail', label: 'Issue', render: (it) => it.detail },
                { key: 'resolver', label: 'Who should resolve', render: (it) => it.resolver },
              ]} />
            </Card>
          ))}
          {!data.missing_information.some((g) => g.count) && <Card><div className="empty">No data-quality issues found.</div></Card>}
        </div>
      )}
      <Drawer open={Boolean(task)} onClose={() => setTask(null)} title={task?.customer_name} subtitle={task?.purpose}>
        {task && <FollowupForm task={task} contacts={task.contacts} onSaved={() => { toast.success('Outcome recorded'); setTask(null); reload(); }} />}
      </Drawer>
    </div>
  );
}

export { date, qty, LineStateBadge, CommBadge, StageBadge };
