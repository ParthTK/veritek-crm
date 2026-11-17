import { useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadAuthed } from '../api.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { dateTime, number } from '../lib/format.js';
import { addDays } from '@shared/dates.js';
import { Button, Card, DataTable, ErrorState, Field, Input, Modal, Notice, PageHeader, Select, Spinner, useToast } from '../components/ui.jsx';
import { FilterBar, useOptions } from '../components/domain.jsx';
import { todayLocal } from '../lib/format.js';

const GROUP_LABELS = {
  source: 'Source', owner: 'Owner', month: 'Month', country: 'Country', family: 'Product family', reason: 'Reason', category: 'Category', product: 'Product', root_cause: 'Root cause', customer: 'Customer',
  campaign: 'Campaign', type: 'Campaign type', stage: 'Stage', region: 'Region', status: 'Status', day: 'Day', week: 'Week',
};

export default function Reports() {
  const toast = useToast();
  const list = useApi('/reports');
  const [f, setF] = useUrlFilters({ r: 'enquiry_conversion', from: addDays(todayLocal(), -89), to: todayLocal() });
  const { r: key, ...query } = f;
  const report = useApi(`/reports/${key}`, query);
  const sources = useOptions('enquiry_source');
  const [drill, setDrill] = useState(null);
  const d = report.data;
  const exportCsv = (extra = {}) => downloadAuthed(`/reports/${key}/export.csv`, { ...query, ...extra }).catch((e) => toast.error(e.message));
  const maxCount = d ? Math.max(1, ...d.table.rows.map((r) => r.count ?? r.total ?? 0)) : 1;
  return (
    <div className="stack">
      <PageHeader title="Reports" subtitle="Every figure has a stated definition, a denominator and a drill-down to the records behind it." actions={<Button icon="dashboard" to="/analytics">Sales dashboard</Button>} />
      <div className="split menu-left">
        <Card flush>
          <nav className="menu" aria-label="Reports">
            {list.data?.map((r) => (
              <button key={r.key} type="button" onClick={() => setF({ r: r.key, group: '', basis: '', kind: '' })} style={key === r.key ? { background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 650 } : undefined}>
                {r.title}
              </button>
            ))}
          </nav>
        </Card>
        <div className="stack">
          {report.error && <ErrorState error={report.error} onRetry={report.reload} />}
          {!d && !report.error && <Spinner />}
          {d && (
            <>
              <Card title={d.title} actions={<Button icon="download" onClick={() => exportCsv()}>Export records ({d.record_count})</Button>}>
                <div className="stack-sm">
                  <Notice tone="info" title="Definition">{d.definition}</Notice>
                  <div className="row wrap">
                    <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value })} /></Field>
                    <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value })} /></Field>
                    {d.groups.length > 0 && <Field label="Group by"><Select value={f.group || d.groups[0]} onChange={(e) => setF({ group: e.target.value })} options={d.groups.map((g) => ({ value: g, label: GROUP_LABELS[g] || g }))} /></Field>}
                    {d.bases && <Field label="Measured from"><Select value={f.basis || 'received'} onChange={(e) => setF({ basis: e.target.value })} options={[{ value: 'received', label: 'Enquiry received' }, { value: 'requested', label: 'Quotation requested' }]} /></Field>}
                    {d.kinds && <Field label="Task kind"><Select value={f.kind || ''} onChange={(e) => setF({ kind: e.target.value })} options={[{ value: 'customer', label: 'Customer contact' }, { value: 'internal', label: 'Internal' }]} placeholder="Both (shown separately below)" /></Field>}
                    {['enquiry_conversion', 'lost_reasons', 'first_response', 'quote_turnaround', 'source_country_product'].includes(key) && <Field label="Source"><Select value={f.source || ''} onChange={(e) => setF({ source: e.target.value })} options={sources} placeholder="All sources" /></Field>}
                  </div>
                  <FilterBar value={f} onChange={setF} />
                  <div className="tiny muted">Generated {dateTime(d.generated_at)} · times in {d.timezone} · period {f.from} to {f.to} (business dates).</div>
                </div>
              </Card>
              <div className="grid grid-3">
                <div className="stat">
                  <span className="k">{d.headline.label}</span>
                  <span className="v">{typeof d.headline.value === 'number' ? `${number(d.headline.value, 1)}${d.headline.unit === '%' ? '%' : d.headline.unit ? ` ${d.headline.unit}` : ''}` : d.headline.value ?? '—'}</span>
                  {d.headline.denominator !== undefined && <span className="d">{d.headline.numerator !== undefined ? `${d.headline.numerator} of ${d.headline.denominator}` : `based on ${d.headline.denominator} record(s)`}</span>}
                </div>
                {d.extra.map((x) => (
                  <div key={x.label} className="stat"><span className="k">{x.label}</span><span className="v" style={{ fontSize: typeof x.value === 'string' && x.value.length > 14 ? 15 : undefined }}>{typeof x.value === 'number' ? `${number(x.value, 1)}${x.unit === '%' ? '%' : ''}` : x.value || '—'}</span>{x.denominator !== undefined && <span className="d">{x.numerator !== undefined ? `${x.numerator} of ${x.denominator}` : `of ${x.denominator}`}</span>}</div>
                ))}
              </div>
              <Card title="Counts" sub="click to see the exact records">
                <div className="row wrap">
                  {d.metrics.map((m) => <button key={m.key} type="button" className="chip" onClick={() => setDrill({ metric: m.key, title: m.label })}>{m.label}<span className="n">{m.count}</span></button>)}
                </div>
                {d.exclusions.length > 0 && (
                  <div className="mt-12 small">
                    <strong>Excluded or shown separately: </strong>
                    {d.exclusions.map((x, i) => <span key={x.label}>{i > 0 && ' · '}{x.metric ? <button type="button" className="btn link" onClick={() => setDrill({ metric: x.metric, title: x.label })}>{x.label}: {x.count}</button> : `${x.label}: ${x.count}`}</span>)}
                  </div>
                )}
              </Card>
              <Card title={`By ${GROUP_LABELS[f.group || d.groups[0]] || 'group'}`} flush>
                <DataTable rows={d.table.rows.map((r, i) => ({ ...r, _k: `${r.group}-${r.currency || ''}-${i}` }))} rowKey="_k" onRowClick={d.groups.length ? (r) => setDrill({ group_value: r.group, title: String(r.group) }) : undefined}
                  columns={d.table.columns.map((c, i) => ({
                    key: c.key, label: c.label, align: i > 0 && typeof d.table.rows[0]?.[c.key] === 'number' ? 'num' : undefined,
                    render: (r) => (i === 1 && typeof r[c.key] === 'number' ? <span className="row" style={{ justifyContent: 'flex-end' }}><span className="bar" style={{ width: 90 }}><span style={{ width: `${(r[c.key] / maxCount) * 100}%` }} /></span>{r[c.key]}</span>
                      : c.key.includes('conversion') || c.key === 'rate' ? (r[c.key] === null ? '—' : `${r[c.key]}%`) : r[c.key] ?? '—'),
                  }))} empty={<div className="empty small">No records in this period.</div>} />
              </Card>
              {d.secondary && (
                <Card title={d.secondary.title} flush>
                  <DataTable rows={d.secondary.rows} rowKey="group" columns={d.secondary.columns.map(([k, label]) => ({ key: k, label }))} />
                </Card>
              )}
              <div className="small muted">Order value is not revenue or margin. Calls logged are activity, not sales output. Currencies are never added together.</div>
            </>
          )}
        </div>
      </div>
      <Modal open={Boolean(drill)} size="xl" onClose={() => setDrill(null)} title={drill?.title} subtitle={d?.title}>
        {drill && <Drill reportKey={key} query={{ ...query, ...drill, title: undefined }} onExport={() => exportCsv({ metric: drill.metric, group_value: drill.group_value })} />}
      </Modal>
    </div>
  );
}

function Drill({ reportKey, query, onExport }) {
  const { data, error } = useApi(`/reports/${reportKey}/records`, query);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Spinner />;
  return (
    <div className="stack-sm">
      <div className="row between"><strong>{data.count} record(s)</strong><Button size="sm" icon="download" onClick={onExport}>Export these records</Button></div>
      <DataTable rows={data.rows.map((r, i) => ({ ...r, _k: i }))} rowKey="_k" maxHeight={480} columns={[
        ...data.columns.map((c, i) => ({ key: c.key, label: c.label, render: (r) => (i === 0 ? <Link to={r._link}>{r[c.key] ?? '—'}</Link> : r[c.key] === null || r[c.key] === undefined || r[c.key] === '' ? <span className="muted">unknown</span> : String(r[c.key]).replace(/_/g, ' ')) })),
      ]} />
    </div>
  );
}
