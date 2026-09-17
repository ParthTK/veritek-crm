import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ORDER_STAGES, PRIORITIES, MATERIAL_STATUSES, QC_STATUSES } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, number, relativeDay, daysFromToday } from '../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, OptionBadge, PageHeader, Progress, SearchBox, Select, Tile, Spinner } from '../components/ui.jsx';
import { useMeta } from '../components/domain.jsx';
import { ProductionModal } from './OrderDetail.jsx';

export default function Production() {
  const { can } = useAuth();
  const meta = useMeta();
  const [f, setFilter] = useUrlFilters();
  const { data, loading, reload } = useApi('/production', f);
  const [editing, setEditing] = useState(null);
  const canEdit = can('production.edit');

  if (!data) return <Spinner />;
  let rows = data.rows;
  if (f.attention === '1') rows = rows.filter((o) => o.production_delayed || o.is_delayed || o.at_risk || o.material_status === 'shortage' || o.qc_status === 'failed');

  return (
    <div className="stack">
      <PageHeader title="Production tracking" subtitle="What sales needs to know about the shop floor — plan, progress, constraints and revised dates" />
      <div className="tiles">
        <Tile label="Orders in production" value={number(data.summary.count)} />
        <Tile label="Delayed" value={number(data.summary.delayed)} alert={data.summary.delayed > 0} foot="Past planned completion or delivery" />
        <Tile label="At risk" value={number(data.summary.at_risk)} foot="Completion after committed delivery" alert={data.summary.at_risk > 0} />
        <Tile label="Material shortage" value={number(data.summary.shortage)} alert={data.summary.shortage > 0} />
        <Tile label="Awaiting quality check" value={number(data.summary.qc_pending)} />
        <Tile label="Due this week" value={number(data.summary.due_this_week)} />
      </div>
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Order, PO, customer" />
        <Select className="sm" value={f.factory_id} onChange={(e) => setFilter({ factory_id: e.target.value })} placeholder="All units" options={meta.factories.map((x) => ({ value: x.id, label: x.name }))} />
        <Select className="sm" value={f.stage} onChange={(e) => setFilter({ stage: e.target.value })} placeholder="All stages" options={ORDER_STAGES.slice(3, 10)} />
        <Select className="sm" value={f.priority} onChange={(e) => setFilter({ priority: e.target.value })} placeholder="Any priority" options={PRIORITIES} />
        <Checkbox label="Needs attention" checked={f.attention === '1'} onChange={(v) => setFilter({ attention: v ? '1' : '' })} />
      </div>
      <Card flush>
        <DataTable rows={rows} loading={loading} columns={[
          { key: 'order', label: 'Order', render: (o) => (
            <div className="col" style={{ gap: 0, maxWidth: 220 }}>
              <Link to={`/orders/${o.id}`} className="strong">{o.number}</Link>
              <span className="tiny muted truncate">{o.customer_name}</span>
              <span className="tiny muted">Received {date(o.order_date)}</span>
            </div>
          ) },
          { key: 'priority', label: 'Priority', render: (o) => <OptionBadge list={PRIORITIES} value={o.priority} size="sm" /> },
          { key: 'stage', label: 'Stage', render: (o) => <OptionBadge list={ORDER_STAGES} value={o.stage} /> },
          { key: 'items', label: 'Items', render: (o) => (
            <div className="small" style={{ maxWidth: 240 }}>
              {o.items.slice(0, 2).map((i) => <div key={i.id} className="truncate">{i.description} <span className="muted">× {number(i.qty)}</span></div>)}
              {o.items.length > 2 && <div className="tiny muted">+{o.items.length - 2} more</div>}
            </div>
          ) },
          { key: 'progress', label: 'Produced', render: (o) => (
            <div style={{ minWidth: 120 }}>
              <Progress value={o.progress_pct} tone={o.progress_pct >= 100 ? 'good' : undefined} />
              <span className="tiny muted">{number(o.qty_produced)} / {number(o.qty_ordered)} · {o.progress_pct}%</span>
            </div>
          ) },
          { key: 'plan', label: 'Completion', render: (o) => {
            const completion = o.revised_completion || o.planned_completion;
            return (
              <div className="col" style={{ gap: 0 }}>
                <span className={o.production_delayed ? 'danger-text strong' : ''}>{date(completion)}</span>
                <span className="tiny muted">{o.actual_completion ? `done ${date(o.actual_completion)}` : completion ? relativeDay(completion) : 'not planned'}{o.revised_completion ? ' · revised' : ''}</span>
              </div>
            );
          } },
          { key: 'material', label: 'Material', render: (o) => (
            <div className="col" style={{ gap: 2, maxWidth: 170 }}>
              <OptionBadge list={MATERIAL_STATUSES} value={o.material_status} size="sm" />
              {o.material_constraint && <span className="tiny muted truncate" title={o.material_constraint}>{o.material_constraint}</span>}
            </div>
          ) },
          { key: 'qc', label: 'QC', render: (o) => <OptionBadge list={QC_STATUSES} value={o.qc_status} size="sm" /> },
          { key: 'delivery', label: 'Committed delivery', render: (o) => (
            <div className="col" style={{ gap: 0 }}>
              <span className={o.is_delayed ? 'danger-text strong' : daysFromToday(o.delivery_date) <= 7 ? 'warning-text' : ''}>{date(o.delivery_date)}</span>
              {o.at_risk && <Badge size="sm" color="amber">At risk</Badge>}
              {o.is_delayed && <span className="tiny danger-text">{o.delay_days} days late</span>}
            </div>
          ) },
          can('finance.values') && { key: 'value', label: 'Value', align: 'num', render: (o) => inrCompact(o.grand_total) },
          canEdit && { key: 'act', label: '', render: (o) => <Button size="xs" onClick={async () => setEditing(await api.get(`/orders/${o.id}`))}>Update</Button> },
        ]} empty={<div className="empty">Nothing in production right now.</div>} />
      </Card>
      <div className="small muted">Delay reasons and revised dates recorded here appear on the order, in the customer tracking link, and in the order-delay report.</div>
      {editing && <ProductionModal open onClose={() => setEditing(null)} order={editing} onSaved={reload} />}
    </div>
  );
}
