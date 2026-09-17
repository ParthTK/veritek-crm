import { useEffect, useState } from 'react';

import { api } from '../api.js';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { dateTime, timeAgo, inr, number } from '../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, useToast, EmptyState } from '../components/ui.jsx';
import { useMeta, UserSelect } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

export default function Settings() {
  const [f, setFilter] = useUrlFilters({ tab: 'company' });
  return (
    <div className="stack">
      <PageHeader title="Settings" subtitle="Company details, approval policy, automation, lead assignment and access control" />
      <Tabs value={f.tab} onChange={(tab) => setFilter({ tab })} tabs={[
        { key: 'company', label: 'Company' },
        { key: 'policy', label: 'Approvals & follow-ups' },
        { key: 'automation', label: 'Automation' },
        { key: 'assignment', label: 'Lead assignment' },
        { key: 'masters', label: 'Regions, units & tags' },
        { key: 'roles', label: 'Roles & permissions' },
        { key: 'audit', label: 'Audit log' },
      ]} />
      {f.tab === 'company' && <SettingsGroup groupKey="company" title="Company profile" fields={[
        ['name', 'Company name', 'text'], ['gstin', 'GSTIN', 'text'], ['address', 'Registered address', 'textarea'],
        ['phone', 'Phone', 'text'], ['email', 'Sales email', 'text'], ['website', 'Website', 'text'],
      ]} />}
      {f.tab === 'policy' && (
        <div className="stack">
          <SettingsGroup groupKey="approvals" title="Approval policy" hint="Applied automatically when a quotation is submitted" fields={[
            ['discountManagerPct', 'Discount above this % needs Regional Manager approval', 'number'],
            ['discountHeadPct', 'Discount above this % needs Sales Head approval', 'number'],
            ['minMarginPct', 'Margin below this % needs Sales Head approval', 'number'],
            ['largeQuotationValue', 'Notify management for quotations above (₹)', 'number'],
          ]} />
          <SettingsGroup groupKey="followups" title="Follow-up & reminder rules" fields={[
            ['escalateAfterDays', 'Escalate a follow-up to the manager after (days overdue)', 'number'],
            ['noResponseDays', 'Flag “no response” after (days)', 'number'],
            ['quotationExpiryWarnDays', 'Warn before quotation expiry (days)', 'number'],
            ['sampleFeedbackDays', 'Chase sample feedback after (days)', 'number'],
            ['quotationFollowupDays', 'Auto follow-up after sending a quotation (days)', 'number'],
          ]} />
          <SettingsGroup groupKey="customers" title="Customer activity" fields={[['dormantAfterDays', 'Mark a customer dormant after (days without an order)', 'number']]} />
          <SettingsGroup groupKey="quotation" title="Quotation defaults" fields={[
            ['defaultValidityDays', 'Default validity (days)', 'number'],
            ['freightGstRate', 'GST rate on freight & installation (%)', 'number'],
            ['defaultPaymentTerms', 'Default payment terms', 'textarea'],
            ['defaultDelivery', 'Default delivery timeline', 'textarea'],
            ['defaultWarranty', 'Default warranty', 'textarea'],
          ]} />
        </div>
      )}
      {f.tab === 'automation' && <Automation />}
      {f.tab === 'assignment' && <AssignmentRules />}
      {f.tab === 'masters' && <Masters />}
      {f.tab === 'roles' && <RolesMatrix />}
      {f.tab === 'audit' && <AuditLog />}
    </div>
  );
}

function SettingsGroup({ groupKey, title, hint, fields }) {
  const toast = useToast();
  const { data, reload } = useApi('/settings');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data[groupKey]);
  }, [data, groupKey]);
  if (!form) return <Card title={title}><Spinner /></Card>;
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/settings/${groupKey}`, form);
      toast.success('Settings saved');
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={title} sub={hint} actions={<Button variant="primary" size="sm" loading={busy} onClick={save}>Save</Button>}>
      <div className="form-grid">
        {fields.map(([key, label, type]) => (
          <Field key={key} label={label} className={type === 'textarea' ? 'full' : ''} hint={key === 'largeQuotationValue' ? inr(form[key]) : undefined}>
            {type === 'textarea'
              ? <Textarea rows={2} value={form[key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [key]: e.target.value }))} />
              : <Input type={type} value={form[key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))} />}
          </Field>
        ))}
      </div>
    </Card>
  );
}

function Automation() {
  const toast = useToast();
  const { data, reload } = useApi('/automation');
  const settings = useApi('/settings');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const cfg = settings.data?.automation;

  const toggle = async (key, value) => {
    setBusy(true);
    try {
      await api.put('/settings/automation', { ...cfg, [key]: value });
      settings.reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const res = await api.post('/automation/run', {});
      const total = res.results.reduce((s, r) => s + (r.affected || 0), 0);
      toast.success(`Automation ran: ${total} action${total === 1 ? '' : 's'} taken`);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setRunning(false);
    }
  };
  if (!data || !cfg) return <Spinner />;
  return (
    <div className="stack">
      <Card title="Automation rules" sub={`Runs every ${cfg.intervalMinutes} minutes · last run ${data.last_run ? timeAgo(data.last_run) : 'never'}`}
        actions={<><Checkbox label="Automation enabled" checked={cfg.enabled} onChange={(v) => toggle('enabled', v)} disabled={busy} /><Button size="sm" icon="play" loading={running} onClick={runNow}>Run now</Button></>} flush>
        {data.rules.map((r) => (
          <div key={r.key} className="action-row">
            <Icon name="sparkle" size={15} />
            <span className="grow">
              <div>{r.label}</div>
              <div className="tiny muted">{r.last ? `Last run ${timeAgo(r.last.run_at)} · ${r.last.message}` : 'Not run yet'}</div>
            </span>
            {r.setting
              ? <Checkbox label={cfg[r.setting] ? 'On' : 'Off'} checked={Boolean(cfg[r.setting])} onChange={(v) => toggle(r.setting, v)} disabled={busy} />
              : <Badge color="green">Always on</Badge>}
          </div>
        ))}
      </Card>
      <Card title="Run history" flush>
        <DataTable rows={data.log.slice(0, 60)} compact columns={[
          { key: 'rule', label: 'Rule' },
          { key: 'message', label: 'Result' },
          { key: 'affected', label: 'Actions', align: 'num' },
          { key: 'run_at', label: 'When', render: (r) => <span className="small muted">{dateTime(r.run_at)}</span> },
        ]} empty={<EmptyState title="No runs yet" />} />
      </Card>
    </div>
  );
}

function AssignmentRules() {
  const toast = useToast();
  const meta = useMeta();
  const { data, reload } = useApi('/assignment-rules');
  const [form, setForm] = useState({ priority: 10 });
  const add = async () => {
    try {
      await api.post('/assignment-rules', form);
      toast.success('Rule added');
      setForm({ priority: 10 });
      reload();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="stack">
      <Card title="Automatic lead assignment" sub="New leads without a salesperson are matched top-down: the most specific active rule wins, otherwise the least-loaded executive in the region gets the lead">
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <Field label="Region"><Select value={form.region_id} onChange={(e) => setForm((f) => ({ ...f, region_id: e.target.value }))} placeholder="Any region" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} /></Field>
          <Field label="Product category"><Select value={form.category_id} onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))} placeholder="Any category" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Assign to"><UserSelect roles={['sales_executive', 'regional_manager', 'sales_head']} value={form.user_id} onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))} placeholder="Select…" /></Field>
          <Field label="Priority" hint="Lower runs first"><Input type="number" style={{ width: 90 }} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} /></Field>
          <Button variant="primary" icon="plus" onClick={add}>Add rule</Button>
        </div>
      </Card>
      <Card flush>
        <DataTable rows={data} columns={[
          { key: 'region', label: 'Region', render: (r) => r.region_name || <span className="muted">Any</span> },
          { key: 'category', label: 'Product category', render: (r) => r.category_name || <span className="muted">Any</span> },
          { key: 'user', label: 'Assign to', render: (r) => r.user_name },
          { key: 'priority', label: 'Priority', align: 'num' },
          { key: 'active', label: 'Active', render: (r) => <Checkbox checked={Boolean(r.active)} onChange={async (v) => { await api.put(`/assignment-rules/${r.id}`, { active: v }); reload(); }} /> },
          { key: 'act', label: '', render: (r) => <Button size="xs" variant="ghost" icon="trash" aria-label="Delete rule" onClick={async () => { await api.del(`/assignment-rules/${r.id}`); reload(); }} /> },
        ]} empty={<EmptyState title="No rules" message="Leads are assigned to the least-loaded executive in the customer's region." />} />
      </Card>
    </div>
  );
}

function Masters() {
  const toast = useToast();
  const meta = useMeta();
  const [modal, setModal] = useState(null);
  const save = async (kind, item) => {
    try {
      if (item.id) await api.put(`/${kind}/${item.id}`, item);
      else await api.post(`/${kind}`, item);
      toast.success('Saved');
      meta.reload();
      setModal(null);
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="grid grid-3">
      <Card title="Regions" actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'regions', item: {} })}>Add</Button>} flush>
        {meta.regions.map((r) => (
          <div key={r.id} className="action-row">
            <span className="grow small"><strong>{r.name}</strong><div className="tiny muted">{r.states}</div></span>
            <Button size="xs" variant="ghost" icon="edit" aria-label="Edit region" onClick={() => setModal({ kind: 'regions', item: r })} />
          </div>
        ))}
      </Card>
      <Card title="Factories / units" actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'factories', item: {} })}>Add</Button>} flush>
        {meta.factories.map((r) => (
          <div key={r.id} className="action-row">
            <span className="grow small"><strong>{r.name}</strong><div className="tiny muted">{r.location}</div></span>
            <Button size="xs" variant="ghost" icon="edit" aria-label="Edit unit" onClick={() => setModal({ kind: 'factories', item: r })} />
          </div>
        ))}
      </Card>
      <Card title="Tags" sub="Used across customers and leads" flush>
        {meta.tags.map((t) => (
          <div key={t.id} className="action-row">
            <span className="grow small"><Badge color={t.color}>{t.name}</Badge></span>
            <span className="tiny muted">{t.uses} uses</span>
            <Button size="xs" variant="ghost" icon="trash" aria-label="Delete tag" onClick={async () => { await api.del(`/tags/${t.id}`); meta.reload(); }} />
          </div>
        ))}
        {!meta.tags.length && <EmptyState title="No tags yet" />}
      </Card>
      {modal && (
        <Modal open size="sm" onClose={() => setModal(null)} title={modal.item.id ? 'Edit' : 'Add'}
          footer={<><Button onClick={() => setModal(null)}>Cancel</Button><Button variant="primary" onClick={() => save(modal.kind, modal.item)}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Name" required className="full"><Input value={modal.item.name || ''} onChange={(e) => setModal((m) => ({ ...m, item: { ...m.item, name: e.target.value } }))} /></Field>
            <Field label={modal.kind === 'regions' ? 'States covered' : 'Location'} className="full">
              <Input value={(modal.kind === 'regions' ? modal.item.states : modal.item.location) || ''}
                onChange={(e) => setModal((m) => ({ ...m, item: { ...m.item, [modal.kind === 'regions' ? 'states' : 'location']: e.target.value } }))} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RolesMatrix() {
  const { data } = useApi('/roles');
  if (!data) return <Spinner />;
  const perms = Object.keys(data.permissions);
  return (
    <Card title="Roles & permissions" sub="Access is also limited by scope: region for regional managers, assigned customers for executives, and unit for production teams" flush>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th style={{ minWidth: 190 }}>Permission</th>
              {data.roles.map((r) => <th key={r.value} className="num" style={{ writingMode: 'vertical-rl', height: 120, padding: 6 }}>{r.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p}>
                <td className="small">{p}</td>
                {data.roles.map((r) => (
                  <td key={r.value} className="num">{data.permissions[p].includes(r.value) ? <Icon name="check" size={14} className="success-text" /> : <span className="muted">·</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AuditLog() {
  const [f, setF] = useState({});
  const { data } = useApi('/audit', f);
  return (
    <Card title="Audit log" sub="Price changes, approvals, user changes and settings edits" flush
      actions={<Select className="sm" value={f.entity || ''} onChange={(e) => setF({ entity: e.target.value })} placeholder="All records" options={['quotation', 'approval', 'order', 'customer', 'product', 'payment', 'invoice', 'credit_note', 'user', 'settings', 'automation', 'targets'].map((v) => ({ value: v, label: v }))} />}>
      <DataTable rows={data} compact columns={[
        { key: 'created_at', label: 'When', render: (r) => <span className="small">{dateTime(r.created_at)}</span> },
        { key: 'user', label: 'Who', render: (r) => r.user_name || 'System' },
        { key: 'entity', label: 'Record', render: (r) => <span className="small">{r.entity}{r.entity_id ? ` #${r.entity_id}` : ''}</span> },
        { key: 'action', label: 'Action', render: (r) => <Badge size="sm" color={r.action === 'price_change' ? 'amber' : r.action === 'rejected' ? 'red' : 'slate'}>{r.action}</Badge> },
        { key: 'details', label: 'Details', render: (r) => <span className="small muted">{Array.isArray(r.details)
          ? r.details.map((d) => `${d.field}: ${d.from} → ${d.to}`).join(', ')
          : r.details ? Object.entries(r.details).filter(([, v]) => v !== null && v !== undefined).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}</span> },
      ]} empty={<EmptyState title="Nothing logged yet" />} />
    </Card>
  );
}
