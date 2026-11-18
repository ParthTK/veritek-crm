import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, DEPARTMENTS, PERMISSIONS as P, PERMISSION_LABELS, CURRENCIES, TAG_COLORS, SEGMENTS, labelOf, groupOf } from '@shared/constants.js';
import { api, downloadAuthed, newKey } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { date, dateTime, timeAgo, fileSize } from '../lib/format.js';
import {
  Badge, Button, Card, Checkbox, DataTable, ErrorState, Field, Input, Modal, Notice, PageHeader, SaveStatus, Select, Spinner, Tabs, Textarea, useToast, Pagination,
} from '../components/ui.jsx';
import { UserSelect, useMeta } from '../components/domain.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Settings() {
  const { can } = useAuth();
  const [f, setF] = useUrlFilters({ tab: 'people' });
  return (
    <div className="stack">
      <PageHeader title="Settings" subtitle="People and access, company and commercial policy, master lists, dropdowns, reminder rules, imports and system health." />
      <Tabs value={f.tab} onChange={(tab) => setF({ tab })} tabs={[
        { key: 'people', label: 'People & access' }, { key: 'commercial', label: 'Company & commercial' }, { key: 'masters', label: 'Regions, factories & rules' }, { key: 'dropdowns', label: 'Dropdowns' },
        { key: 'rules', label: 'Calendar & rules' }, { key: 'imports', label: 'Imports' }, { key: 'system', label: 'System & backups' }, can('audit.view') && { key: 'audit', label: 'Audit log' },
      ]} />
      {f.tab === 'people' && <People />}
      {f.tab === 'dropdowns' && <Dropdowns />}
      {f.tab === 'commercial' && <Commercial />}
      {f.tab === 'masters' && <Masters />}
      {f.tab === 'rules' && <Rules />}
      {f.tab === 'imports' && <Imports />}
      {f.tab === 'system' && <System />}
      {f.tab === 'audit' && <Audit />}
    </div>
  );
}

// ------------------------------------------------------------------ people
function People() {
  const { data, error, reload } = useApi('/admin/users');
  const meta = useMeta();
  const toast = useToast();
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const done = (m) => {
    toast.success(m);
    setModal(null);
    reload();
    meta.reload();
  };
  return (
    <div className="stack">
      <Notice tone="info">Each person has their own account — there is no shared login. Department heads who do not sign in can still be named owners of actions; the coordinator records updates on their behalf.</Notice>
      <Card flush title="People" actions={<Button variant="cta" icon="plus" onClick={() => setModal({ type: 'edit' })}>Add person</Button>}>
        <DataTable rows={data} columns={[
          { key: 'name', label: 'Name', render: (u) => <><strong>{u.name}</strong>{!u.active && <Badge size="sm"> Deactivated {date(u.deactivated_at)}</Badge>}<div className="sub">{u.email || 'no sign-in'}</div></> },
          { key: 'role', label: 'Role', render: (u) => <>{labelOf(ROLES, u.role)}{u.values_access ? <div className="sub">may see commercial values</div> : null}</> },
          { key: 'dept', label: 'Department', render: (u) => <>{labelOf(DEPARTMENTS, u.department) || '—'}{u.designation && <div className="sub">{u.designation}</div>}</> },
          { key: 'where', label: 'Region / factory', render: (u) => u.region_name || u.factory_name || <span className="muted">—</span> },
          { key: 'manager', label: 'Escalates to', render: (u) => u.manager_name || '—' },
          { key: 'tasks', label: 'Open tasks', render: (u) => u.open_tasks },
          { key: 'login', label: 'Last sign-in', render: (u) => (u.login_enabled ? (u.last_login_at ? timeAgo(u.last_login_at) : 'never') : '—') },
          { key: 'act', label: '', render: (u) => <div className="row"><Button size="xs" onClick={() => setModal({ type: 'edit', user: u })}>Edit</Button>{u.active ? <Button size="xs" variant="danger-ghost" onClick={() => setModal({ type: 'deactivate', user: u })}>Deactivate</Button> : <Button size="xs" onClick={async () => { await api.post(`/admin/users/${u.id}/reactivate`); done('Reactivated'); }}>Reactivate</Button>}</div> },
        ]} />
      </Card>
      <PermissionMatrix />
      <Modal open={modal?.type === 'edit'} onClose={() => setModal(null)} title={modal?.user ? `Edit ${modal.user.name}` : 'Add person'}>
        {modal?.type === 'edit' && <UserForm user={modal.user} people={data} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'deactivate'} onClose={() => setModal(null)} title={`Deactivate ${modal?.user?.name}`}>
        {modal?.type === 'deactivate' && <DeactivateForm user={modal.user} onSaved={() => done('Deactivated — open work reassigned, history keeps their name')} />}
      </Modal>
    </div>
  );
}

function UserForm({ user, onSaved }) {
  const save = useSave();
  const meta = useMeta();
  const [f, setF] = useState({ name: user?.name || '', email: user?.email || '', phone: user?.phone || '', role: user?.role || 'staff', department: user?.department || '', designation: user?.designation || '', region_id: user?.region_id ? String(user.region_id) : '', factory_id: user?.factory_id ? String(user.factory_id) : '', manager_id: user?.manager_id || null, values_access: Boolean(user?.values_access), password: '' });
  const login = ROLES.find((r) => r.value === f.role)?.login;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { const body = { ...f, region_id: f.region_id || null, factory_id: f.factory_id || null }; if (user) await api.put(`/admin/users/${user.id}`, { ...body, password: f.password || undefined }); else await api.post('/admin/users', body); onSaved(); }); }}>
      <div className="form-grid">
        <Field label="Name" required error={save.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Role" error={save.fields.role}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={ROLES} /></Field>
        <Field label="Department"><Select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} options={DEPARTMENTS} placeholder="—" /></Field>
        <Field label="Designation" optional><Input value={f.designation} onChange={(e) => setF({ ...f, designation: e.target.value })} placeholder="e.g. Area Sales Manager — West" /></Field>
        <Field label="Escalates to" hint="Overdue blocker actions escalate here"><UserSelect value={f.manager_id} onChange={(v) => setF({ ...f, manager_id: v })} /></Field>
        <Field label="Sales region" required={f.role === 'regional_manager'} optional={f.role !== 'regional_manager'} error={save.fields.region_id} hint={f.role === 'regional_manager' ? 'They see customers in this region' : undefined}><Select value={f.region_id} onChange={(e) => setF({ ...f, region_id: e.target.value })} placeholder="None" options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} /></Field>
        <Field label="Factory" optional error={save.fields.factory_id} hint={groupOf(f.role) === 'production' ? 'Production and QC see orders for this factory' : undefined}><Select value={f.factory_id} onChange={(e) => setF({ ...f, factory_id: e.target.value })} placeholder="None" options={meta.factories.map((x) => ({ value: String(x.id), label: x.name }))} /></Field>
        <Field label="Email" required={login} error={save.fields.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone" optional><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        {login && <Field label={user ? 'Reset password' : 'First password'} required={!user} error={save.fields.password} hint="They must change it at first sign-in" className="full"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
        {['production', 'service'].includes(groupOf(f.role)) && <div className="full"><Checkbox label="May see commercial values (prices and order values)" checked={f.values_access} onChange={(v) => setF({ ...f, values_access: v })} /></div>}
      </div>
      <div className="small muted">{ROLES.find((r) => r.value === f.role)?.description}</div>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

function DeactivateForm({ user, onSaved }) {
  const save = useSave();
  const { data: work } = useApi(`/admin/users/${user.id}/open-work`);
  const [to, setTo] = useState(null);
  const total = work ? Object.values(work).reduce((s, n) => s + n, 0) : 0;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/admin/users/${user.id}/deactivate`, { reassign_to: to }); onSaved(); }); }}>
      <div className="small">Sign-in stops immediately. Their name stays on every historical record.</div>
      {!work ? <Spinner /> : total ? (
        <>
          <Notice tone="warn" title="Open work to reassign first">{Object.entries(work).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')}</Notice>
          <Field label="Reassign all open work to" required error={save.fields.reassign_to}><UserSelect value={to} onChange={setTo} filter={(p) => p.id !== user.id} /></Field>
        </>
      ) : <Notice tone="success">No open work assigned.</Notice>}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="danger" loading={save.saving}>Deactivate</Button></div>
    </form>
  );
}

const MATRIX = [
  ['Customers & profiles', ['customers.view', 'customers.edit', 'customers.merge', 'customers.archive']], ['Enquiries', ['enquiries.view', 'enquiries.edit']],
  ['Quotations', ['quotes.view', 'quotes.edit', 'quotes.approve', 'quotes.expired_override']],
  ['Orders', ['orders.view', 'orders.edit', 'orders.update', 'orders.communicate', 'orders.cancel', 'orders.amend', 'orders.authorise', 'qc.pass']],
  ['Dispatch', ['dispatch.post', 'dispatch.override', 'dispatch.reverse']], ['Commercial values', ['values.view', 'margin.view', 'finance.full']],
  ['Products & prices', ['products.view', 'products.edit']], ['Campaigns', ['campaigns.view', 'campaigns.edit']], ['Objects & QR', ['objects.view', 'objects.edit', 'objects.manage']],
  ['Team & targets', ['team.view', 'targets.edit']], ['Dashboards & reports', ['dashboard.view', 'analytics.view', 'reports.view', 'export.lists', 'export.full']],
  ['Imports', ['imports.run']], ['Payments', ['finance.view', 'finance.edit', 'finance.holds']], ['Complaints', ['complaints.view', 'complaints.edit']],
  ['Settings & audit', ['settings.manage', 'users.manage', 'audit.view']],
];
function PermissionMatrix() {
  const roles = ROLES.filter((r) => r.login);
  return (
    <Card title="Permission matrix" sub="enforced on the server for every request, list, file and export">
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>Area</th>{roles.map((r) => <th key={r.value}>{r.label}</th>)}</tr></thead>
          <tbody>{MATRIX.map(([area, perms]) => (
            <tr key={area}><td className="strong">{area}</td>{roles.map((r) => <td key={r.value} className="small" title={perms.filter((p) => ROLE_PERMS[r.value]?.includes(p)).map((p) => PERMISSION_LABELS[p] || p).join('\n')}>{perms.filter((p) => ROLE_PERMS[r.value]?.includes(p)).map((p) => p.split('.')[1].replace(/_/g, ' ')).join(', ') || <span className="muted">—</span>}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}
// Mirrors shared/constants PERMISSIONS for display only (the server enforces them).
const ROLE_PERMS = Object.fromEntries(ROLES.map((r) => [r.value, Object.keys(P).filter((k) => P[k].includes(r.value))]));

// ------------------------------------------------------------------ dropdowns
function Dropdowns() {
  const { data, error, reload } = useApi('/admin/dropdowns');
  const meta = useMeta();
  const toast = useToast();
  const [cat, setCat] = useState('delay_reason');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const current = data.find((d) => d.category === cat);
  const act = async (fn, msg) => {
    try {
      await fn();
      toast.success(msg);
      reload();
      meta.reload();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <div className="split menu-left">
      <Card flush><nav className="menu">{data.map((d) => <button key={d.category} type="button" onClick={() => setCat(d.category)} style={d.category === cat ? { background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 650 } : undefined}>{d.label}</button>)}</nav></Card>
      <Card title={current.label} sub="stable codes, editable labels — a used value is deactivated, never deleted">
        <table className="table compact">
          <thead><tr><th>Label</th><th>Code</th><th>Needs note</th><th>Used</th><th>Active</th><th /></tr></thead>
          <tbody>{current.options.map((o) => (
            <tr key={o.id}>
              <td><Input className="sm" defaultValue={o.label} onBlur={(e) => e.target.value !== o.label && act(() => api.put(`/admin/dropdown-options/${o.id}`, { label: e.target.value }), 'Label updated')} /></td>
              <td className="mono">{o.code}</td>
              <td><input type="checkbox" checked={Boolean(o.requires_note)} onChange={(e) => act(() => api.put(`/admin/dropdown-options/${o.id}`, { requires_note: e.target.checked }), 'Updated')} aria-label="Requires note" /></td>
              <td>{o.used}</td>
              <td><input type="checkbox" checked={Boolean(o.active)} onChange={(e) => act(() => api.put(`/admin/dropdown-options/${o.id}`, { active: e.target.checked }), e.target.checked ? 'Activated' : 'Deactivated for new selections')} aria-label="Active" /></td>
              <td>{!o.used && !o.system && <Button size="xs" variant="danger-ghost" onClick={() => act(() => api.del(`/admin/dropdown-options/${o.id}`), 'Deleted')}>Delete</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
        <form className="row wrap mt-12" onSubmit={(e) => { e.preventDefault(); act(() => api.post(`/admin/dropdowns/${cat}`, { label, requires_note: note }), 'Value added').then(() => setLabel('')); }}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New value label" style={{ maxWidth: 280 }} />
          <Checkbox label="Needs a note" checked={note} onChange={setNote} />
          <Button type="submit" icon="plus" disabled={!label.trim()}>Add</Button>
        </form>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ company & commercial policy
function useSettingsSave(reload) {
  const meta = useMeta();
  const toast = useToast();
  return async (section, body) => {
    try {
      await api.put(`/admin/settings/${section}`, body);
      toast.success('Saved');
      reload();
      meta.reload();
    } catch (err) {
      toast.error(err.details?.fields ? Object.values(err.details.fields).join('; ') : err.message);
    }
  };
}

function Commercial() {
  const { data, error, reload } = useApi('/admin/settings');
  const saveSection = useSettingsSave(reload);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  return (
    <div className="grid grid-2">
      <CompanyCard company={data.company} onSave={(b) => saveSection('company', b)} />
      <ApprovalsCard approvals={data.approvals} onSave={(b) => saveSection('approvals', b)} />
      <QuotationCard quotation={data.quotation} onSave={(b) => saveSection('quotation', b)} />
      <RemindersCard reminders={data.reminders} onSave={(b) => saveSection('reminders', b)} />
      <Card title="Products & price list"><div className="small muted">Models, prices, minimum price, cost, GST, configurator options and datasheets are managed on the Products page.</div><div className="mt-12"><Button to="/products" icon="products">Open products & prices</Button></div></Card>
    </div>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function CompanyCard({ company, onSave }) {
  const [f, setF] = useState(company);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  return (
    <Card title="Company profile" sub="printed on quotations and the customer pages">
      <div className="form-grid">
        <Field label="Company name" className="full"><Input value={f.name || ''} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Short name"><Input value={f.short || ''} onChange={(e) => set({ short: e.target.value })} /></Field>
        <Field label="GSTIN"><Input value={f.gstin || ''} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
        <Field label="Address" className="full"><Textarea rows={2} value={f.address || ''} onChange={(e) => set({ address: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone || ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email || ''} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="Website"><Input value={f.website || ''} onChange={(e) => set({ website: e.target.value })} /></Field>
        <Field label="Reporting currency" hint="Targets and charts use it; other currencies are never converted"><Select value={f.currency || 'INR'} onChange={(e) => set({ currency: e.target.value })} options={CURRENCIES} /></Field>
        <Field label="Financial year starts in"><Select value={String(f.fiscalYearStartMonth || 4)} onChange={(e) => set({ fiscalYearStartMonth: Number(e.target.value) })} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} /></Field>
      </div>
      <div className="mt-12"><Button variant="primary" onClick={() => onSave(f)}>Save company profile</Button></div>
    </Card>
  );
}

function ApprovalsCard({ approvals, onSave }) {
  const [f, setF] = useState(approvals);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  return (
    <Card title="Quotation approvals" sub="when a quotation needs a manager's sign-off">
      <div className="form-grid">
        <Field label="Regional manager above (% discount)"><Input type="number" min={0} max={100} value={f.discountManagerPct} onChange={(e) => set({ discountManagerPct: e.target.value })} /></Field>
        <Field label="Sales head above (% discount)"><Input type="number" min={0} max={100} value={f.discountHeadPct} onChange={(e) => set({ discountHeadPct: e.target.value })} /></Field>
        <Field label="Minimum margin (%)" hint="Below it the sales head approves"><Input type="number" min={0} max={100} value={f.minMarginPct} onChange={(e) => set({ minMarginPct: e.target.value })} /></Field>
        <Field label="Below minimum selling price needs"><Select value={f.belowMinPriceRole || 'management'} onChange={(e) => set({ belowMinPriceRole: e.target.value })} options={['regional_manager', 'sales_head', 'management', 'super_admin'].map((r) => ({ value: r, label: labelOf(ROLES, r) }))} /></Field>
        <Field label="Large quotation (₹, incl. GST)" hint="Management and the sales head are told when one is issued"><Input type="number" min={0} value={f.largeQuotationValue ?? ''} onChange={(e) => set({ largeQuotationValue: e.target.value })} /></Field>
        <div className="full"><Checkbox label="A quotation that needs approval cannot be issued until it is approved" checked={Boolean(f.requireBeforeIssue)} onChange={(v) => set({ requireBeforeIssue: v })} /></div>
      </div>
      <div className="mt-12"><Button variant="primary" onClick={() => onSave(f)}>Save approval policy</Button></div>
    </Card>
  );
}

function QuotationCard({ quotation, onSave }) {
  const [f, setF] = useState(quotation);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  return (
    <Card title="Quotation defaults" sub="pre-filled on every new quotation">
      <div className="form-grid">
        <Field label="Validity (days)"><Input type="number" min={1} max={365} value={f.defaultValidityDays} onChange={(e) => set({ defaultValidityDays: e.target.value })} /></Field>
        <Field label="GST on freight / installation (%)"><Input type="number" min={0} max={40} value={f.freightGstRate} onChange={(e) => set({ freightGstRate: e.target.value })} /></Field>
        <Field label="Payment terms" className="full"><Input value={f.defaultPaymentTerms || ''} onChange={(e) => set({ defaultPaymentTerms: e.target.value })} /></Field>
        <Field label="Delivery" className="full"><Input value={f.defaultDelivery || ''} onChange={(e) => set({ defaultDelivery: e.target.value })} /></Field>
        <Field label="Warranty" className="full"><Input value={f.defaultWarranty || ''} onChange={(e) => set({ defaultWarranty: e.target.value })} /></Field>
      </div>
      <div className="mt-12"><Button variant="primary" onClick={() => onSave(f)}>Save quotation defaults</Button></div>
    </Card>
  );
}

function RemindersCard({ reminders, onSave }) {
  const [f, setF] = useState(reminders);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  return (
    <Card title="Sales reminders" sub="raised by the reminder evaluator as tasks and alerts">
      <div className="form-grid">
        <Field label="Follow up an issued quotation after (working days)"><Input type="number" min={0} value={f.quotationFollowupWorkingDays} onChange={(e) => set({ quotationFollowupWorkingDays: e.target.value })} /></Field>
        <Field label="Warn before quotation expiry (days)"><Input type="number" min={0} value={f.quotationExpiryWarnDays} onChange={(e) => set({ quotationExpiryWarnDays: e.target.value })} /></Field>
        <Field label="Ask for sample feedback after (days)"><Input type="number" min={0} value={f.sampleFeedbackDays} onChange={(e) => set({ sampleFeedbackDays: e.target.value })} /></Field>
        <Field label="Payment reminder before due date (days)"><Input type="number" min={0} value={f.paymentReminderDays} onChange={(e) => set({ paymentReminderDays: e.target.value })} /></Field>
        <Field label="Repeat-order prompt after (orders)"><Input type="number" min={1} value={f.repeatOrderMinOrders} onChange={(e) => set({ repeatOrderMinOrders: e.target.value })} /></Field>
        <div className="full stack-xs">
          <Checkbox label="Prompt for repeat orders from regular buyers" checked={Boolean(f.repeatOrderEnabled)} onChange={(v) => set({ repeatOrderEnabled: v })} />
          <Checkbox label="Daily and weekly summaries for management" checked={Boolean(f.managementSummaries)} onChange={(v) => set({ managementSummaries: v })} />
        </div>
      </div>
      <div className="mt-12"><Button variant="primary" onClick={() => onSave(f)}>Save reminders</Button></div>
    </Card>
  );
}

export function ObjectsCard({ objects, onSave }) {
  const [f, setF] = useState(objects);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  return (
    <Card title="QR codes & scan pages" sub="printed codes point at the public address — keep it stable">
      <div className="form-grid">
        <Field label="Public address for codes" className="full" hint="e.g. https://crm.veritekindia.com — blank uses this server's address"><Input value={f.publicBaseUrl || ''} onChange={(e) => set({ publicBaseUrl: e.target.value })} placeholder="https://" /></Field>
        <Field label="Brand colour"><div className="row"><input type="color" value={f.brandColor || '#3f1069'} onChange={(e) => set({ brandColor: e.target.value })} aria-label="Brand colour" style={{ width: 44, height: 36, border: 0, background: 'none' }} /><Input value={f.brandColor || ''} onChange={(e) => set({ brandColor: e.target.value })} /></div></Field>
        <Field label="Message for archived objects" className="full"><Input value={f.archivedMessage || ''} onChange={(e) => set({ archivedMessage: e.target.value })} /></Field>
        <div className="full row wrap">
          <Checkbox label="Labels show the name" checked={f.labelShowName !== false} onChange={(v) => set({ labelShowName: v })} />
          <Checkbox label="Labels show the object ID" checked={f.labelShowId !== false} onChange={(v) => set({ labelShowId: v })} />
          <Checkbox label="Labels show the company" checked={f.labelShowCompany !== false} onChange={(v) => set({ labelShowCompany: v })} />
        </div>
      </div>
      <div className="mt-12"><Button variant="primary" onClick={() => onSave(f)}>Save QR settings</Button></div>
    </Card>
  );
}

// ------------------------------------------------------------------ master lists
function Masters() {
  const { data, error, reload } = useApi('/admin/masters');
  const meta = useMeta();
  const toast = useToast();
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const done = (m) => {
    toast.success(m);
    setModal(null);
    reload();
    meta.reload();
  };
  const remove = async (kind, row) => {
    try {
      const r = await api.del(`/admin/masters/${kind}/${row.id}`);
      done(r.deactivated ? 'In use — deactivated instead' : 'Removed');
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <div className="grid grid-2">
      <Card title="Sales regions" sub="customers are placed in a region from their state" flush actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'regions' })}>Add</Button>}>
        <DataTable compact rows={data.regions} columns={[
          { key: 'n', label: 'Region', render: (r) => <><strong>{r.name}</strong>{!r.active && <Badge size="sm"> Inactive</Badge>}<div className="sub">{r.states || 'No states listed'}</div></> },
          { key: 'u', label: 'Customers / people', align: 'num', render: (r) => `${r.customers} / ${r.users}` },
          { key: 'a', label: '', render: (r) => <div className="row"><Button size="xs" variant="ghost" icon="edit" aria-label={`Edit ${r.name}`} onClick={() => setModal({ kind: 'regions', row: r })} /><Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${r.name}`} onClick={() => remove('regions', r)} /></div> },
        ]} />
      </Card>
      <Card title="Factories" sub="production and QC see orders for their factory" flush actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'factories' })}>Add</Button>}>
        <DataTable compact rows={data.factories} columns={[
          { key: 'n', label: 'Factory', render: (r) => <><strong>{r.name}</strong>{!r.active && <Badge size="sm"> Inactive</Badge>}<div className="sub">{r.location || ''}</div></> },
          { key: 'o', label: 'Orders', align: 'num', render: (r) => r.orders },
          { key: 'a', label: '', render: (r) => <div className="row"><Button size="xs" variant="ghost" icon="edit" aria-label={`Edit ${r.name}`} onClick={() => setModal({ kind: 'factories', row: r })} /><Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${r.name}`} onClick={() => remove('factories', r)} /></div> },
        ]} />
      </Card>
      <Card title="Enquiry assignment rules" sub="who gets a new enquiry when the customer has no owner — lowest priority number wins" flush actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'assignment_rules' })}>Add rule</Button>}>
        <DataTable compact rows={data.assignment_rules} columns={[
          { key: 'p', label: '#', render: (r) => r.priority },
          { key: 'w', label: 'When', render: (r) => <span className="small">{[r.region_name && `Region ${r.region_name}`, r.category_name && `Family ${r.category_name}`, r.segment && labelOf(SEGMENTS, r.segment)].filter(Boolean).join(' + ')}</span> },
          { key: 'u', label: 'Assign to', render: (r) => <>{r.user_name}{!r.active && <Badge size="sm"> Off</Badge>}</> },
          { key: 'a', label: '', render: (r) => <div className="row"><Button size="xs" variant="ghost" icon="edit" aria-label="Edit rule" onClick={() => setModal({ kind: 'assignment_rules', row: r })} /><Button size="xs" variant="ghost" icon="trash" aria-label="Remove rule" onClick={() => remove('assignment_rules', r)} /></div> },
        ]} empty={<div className="muted small" style={{ padding: 12 }}>No rules — new enquiries go to the customer's owner.</div>} />
      </Card>
      <Card title="Customer tags" flush actions={<Button size="sm" icon="plus" onClick={() => setModal({ kind: 'tags' })}>Add</Button>}>
        <DataTable compact rows={data.tags} columns={[
          { key: 'n', label: 'Tag', render: (r) => <Badge size="sm" tone={r.color}>{r.name}</Badge> },
          { key: 'u', label: 'Customers', align: 'num', render: (r) => r.uses },
          { key: 'a', label: '', render: (r) => <div className="row"><Button size="xs" variant="ghost" icon="edit" aria-label={`Edit ${r.name}`} onClick={() => setModal({ kind: 'tags', row: r })} /><Button size="xs" variant="ghost" icon="trash" aria-label={`Remove ${r.name}`} onClick={() => remove('tags', r)} /></div> },
        ]} />
      </Card>
      <Modal open={Boolean(modal)} size="sm" onClose={() => setModal(null)} title={modal ? `${modal.row ? 'Edit' : 'Add'} ${{ regions: 'region', factories: 'factory', tags: 'tag', assignment_rules: 'assignment rule' }[modal.kind]}` : ''}>
        {modal && <MasterForm kind={modal.kind} row={modal.row} onSaved={() => done('Saved')} />}
      </Modal>
    </div>
  );
}

function MasterForm({ kind, row, onSaved }) {
  const meta = useMeta();
  const save = useSave();
  const [f, setF] = useState(() => ({
    name: row?.name || '', states: row?.states || '', location: row?.location || '', color: row?.color || 'slate', active: row ? Boolean(row.active ?? 1) : true, sort_order: row?.sort_order ?? 0,
    user_id: row?.user_id || null, region_id: row?.region_id ? String(row.region_id) : '', category_id: row?.category_id ? String(row.category_id) : '', segment: row?.segment || '', priority: row?.priority ?? 10,
  }));
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const body = () => {
    if (kind === 'regions') return { name: f.name, states: f.states, active: f.active, sort_order: f.sort_order };
    if (kind === 'factories') return { name: f.name, location: f.location, active: f.active };
    if (kind === 'tags') return { name: f.name, color: f.color };
    return { user_id: f.user_id, region_id: f.region_id || null, category_id: f.category_id || null, segment: f.segment || null, priority: f.priority, active: f.active };
  };
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { if (row) await api.put(`/admin/masters/${kind}/${row.id}`, body()); else await api.post(`/admin/masters/${kind}`, body()); onSaved(); }); }}>
      {kind !== 'assignment_rules' && <Field label="Name" required error={save.fields.name}><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>}
      {kind === 'regions' && <Field label="States" optional hint="Comma separated — customers in these states join the region"><Textarea rows={2} value={f.states} onChange={(e) => set({ states: e.target.value })} /></Field>}
      {kind === 'regions' && <Field label="Sort order"><Input type="number" value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} /></Field>}
      {kind === 'factories' && <Field label="Location" optional><Input value={f.location} onChange={(e) => set({ location: e.target.value })} /></Field>}
      {kind === 'tags' && <Field label="Colour"><Select value={f.color} onChange={(e) => set({ color: e.target.value })} options={TAG_COLORS} /></Field>}
      {kind === 'assignment_rules' && (
        <>
          <Field label="Assign to" required error={save.fields.user_id}><UserSelect value={f.user_id} onChange={(v) => set({ user_id: v })} filter={(p) => ['sales', 'admin', 'coordinator'].includes(p.group)} /></Field>
          <Field label="Region" optional error={save.fields.region_id}><Select value={f.region_id} onChange={(e) => set({ region_id: e.target.value })} placeholder="Any region" options={meta.regions.map((r) => ({ value: String(r.id), label: r.name }))} /></Field>
          <Field label="Product family" optional error={save.fields.category_id}><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })} placeholder="Any family" options={meta.categories.map((c) => ({ value: String(c.id), label: c.name }))} /></Field>
          <Field label="Market" optional error={save.fields.segment}><Select value={f.segment} onChange={(e) => set({ segment: e.target.value })} placeholder="Domestic & export" options={SEGMENTS} /></Field>
          <Field label="Priority" hint="Lower numbers are checked first"><Input type="number" min={1} value={f.priority} onChange={(e) => set({ priority: e.target.value })} /></Field>
        </>
      )}
      {kind !== 'tags' && row && <Checkbox label="Active" checked={f.active} onChange={(v) => set({ active: v })} />}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Save</Button></div>
    </form>
  );
}

// ------------------------------------------------------------------ rules
function Rules() {
  const { data, error, reload } = useApi('/admin/settings');
  const meta = useMeta();
  const toast = useToast();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const saveSection = async (section, body) => {
    try {
      await api.put(`/admin/settings/${section}`, body);
      toast.success('Saved');
      reload();
      meta.reload();
    } catch (err) {
      toast.error(err.details?.fields ? Object.values(err.details.fields).join('; ') : err.message);
    }
  };
  return (
    <div className="grid grid-2">
      <CalendarCard cal={data.calendar} onSave={(b) => saveSection('calendar', b)} />
      <SectionCard title="Reminder & alert rules" sub="proposed pilot defaults — confirm with Veritek" values={data.rules} onSave={(b) => saveSection('rules', b)} fields={[
        ['dormantDays', 'Past customer after (days without a confirmed order)'], ['staleWorkingDays', 'Order update is stale after (working days)'], ['readyGraceWorkingDays', 'Ready but not dispatched after (working days)'],
        ['enquiryResponseWorkingDays', 'Enquiry reply due within (working days)'], ['pipelineQuoteDraftWorkingDays', 'Pipeline: quotation to be sent within (working days)'], ['pipelineQuoteDecisionWorkingDays', 'Pipeline: customer decision expected within (working days)'],
        ['pipelineConfirmationWorkingDays', 'Pipeline: order to be confirmed within (working days)'], ['pipelineAdvanceWorkingDays', 'Pipeline: advance expected within (working days)'], ['escalateAfterWorkingDays', 'Escalate overdue blocker actions after (working days)'],
        ['reactivationDailyCapPerOwner', 'Automatic reconnect tasks per owner per day'], ['noteMaxLength', 'Maximum note length (characters)'],
      ]} />
      <Card title="Access policy">
        <AccessForm access={data.access} escalation={data.escalation} onSave={saveSection} />
      </Card>
      <Card title="Scheduler & backups">
        <SchedulerForm scheduler={data.scheduler} backup={data.backup} onSave={saveSection} />
      </Card>
    </div>
  );
}

function CalendarCard({ cal, onSave }) {
  const [f, setF] = useState({ ...cal, holiday: '' });
  return (
    <Card title="Working calendar" sub="used for due-date presets, freshness and reminders — never for commitment dates">
      <div className="stack-sm">
        <Field label="Time zone"><Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <Field label="Working days"><div className="row wrap">{DAYS.map((d, i) => <Checkbox key={d} label={d} checked={f.workingDays.includes(i)} onChange={(v) => setF({ ...f, workingDays: v ? [...f.workingDays, i] : f.workingDays.filter((x) => x !== i) })} />)}</div></Field>
        <div className="form-grid"><Field label="Working hours from"><Input type="time" value={f.workStart} onChange={(e) => setF({ ...f, workStart: e.target.value })} /></Field><Field label="to"><Input type="time" value={f.workEnd} onChange={(e) => setF({ ...f, workEnd: e.target.value })} /></Field></div>
        <Field label="Holidays"><div className="row wrap">{f.holidays.map((h) => <span key={h} className="tag">{date(h, { year: true })} <button type="button" className="btn link" onClick={() => setF({ ...f, holidays: f.holidays.filter((x) => x !== h) })}>×</button></span>)}</div>
          <div className="row"><Input type="date" value={f.holiday} onChange={(e) => setF({ ...f, holiday: e.target.value })} /><Button onClick={() => f.holiday && setF({ ...f, holidays: [...f.holidays, f.holiday], holiday: '' })}>Add</Button></div></Field>
        <div><Button variant="primary" onClick={() => onSave({ timezone: f.timezone, workingDays: f.workingDays, holidays: f.holidays, workStart: f.workStart, workEnd: f.workEnd })}>Save calendar</Button></div>
      </div>
    </Card>
  );
}

function SectionCard({ title, sub, values, fields, onSave }) {
  const [f, setF] = useState(values);
  return (
    <Card title={title} sub={sub}>
      <div className="stack-sm">
        {fields.map(([k, label]) => <Field key={k} label={label}><Input type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ maxWidth: 140 }} /></Field>)}
        <div><Button variant="primary" onClick={() => onSave(f)}>Save rules</Button></div>
      </div>
    </Card>
  );
}

function AccessForm({ access, escalation, onSave }) {
  const [f, setF] = useState({ ...access, defaultManagerId: escalation.defaultManagerId });
  return (
    <div className="stack-sm">
      <Field label="Sales users can see" hint="Management and the coordinator always see everything"><Select value={f.salesScope} onChange={(e) => setF({ ...f, salesScope: e.target.value })} options={[{ value: 'own', label: 'Only customers they own or work on' }, { value: 'all', label: 'All customers' }]} /></Field>
      <Checkbox label="Coordinator mode: production updates entered by the coordinator must name the source person" checked={f.coordinatorMode} onChange={(v) => setF({ ...f, coordinatorMode: v })} />
      <Checkbox label="Production / QC users see commercial values" checked={f.productionSeesValues} onChange={(v) => setF({ ...f, productionSeesValues: v })} />
      <Checkbox label="Assign new enquiries automatically using the assignment rules" checked={Boolean(f.autoAssignEnquiries)} onChange={(v) => setF({ ...f, autoAssignEnquiries: v })} />
      <Field label="Do-not-contact customers"><Select value={f.dncPolicy} onChange={(e) => setF({ ...f, dncPolicy: e.target.value })} options={[{ value: 'warn', label: 'Warn and require a reason before outreach' }, { value: 'block', label: 'Block outreach' }]} /></Field>
      <Field label="Default escalation manager"><UserSelect value={f.defaultManagerId} onChange={(v) => setF({ ...f, defaultManagerId: v })} /></Field>
      <div><Button variant="primary" onClick={async () => { await onSave('access', { salesScope: f.salesScope, coordinatorMode: f.coordinatorMode, productionSeesValues: f.productionSeesValues, dncPolicy: f.dncPolicy, autoAssignEnquiries: f.autoAssignEnquiries }); await onSave('escalation', { defaultManagerId: f.defaultManagerId }); }}>Save access policy</Button></div>
    </div>
  );
}

function SchedulerForm({ scheduler, backup, onSave }) {
  const [s, setS] = useState(scheduler);
  const [b, setB] = useState(backup);
  return (
    <div className="stack-sm">
      <Checkbox label="Run the reminder evaluator automatically" checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} />
      <Field label="Every (minutes)"><Input type="number" min={1} value={s.intervalMinutes} onChange={(e) => setS({ ...s, intervalMinutes: e.target.value })} style={{ maxWidth: 120 }} /></Field>
      <div><Button onClick={() => onSave('scheduler', s)}>Save scheduler</Button></div>
      <div className="divider" />
      <Checkbox label="Daily automatic backup (database + documents)" checked={b.enabled} onChange={(v) => setB({ ...b, enabled: v })} />
      <div className="form-grid"><Field label="After hour (local)"><Input type="number" min={0} max={23} value={b.hour} onChange={(e) => setB({ ...b, hour: e.target.value })} /></Field><Field label="Keep backups"><Input type="number" min={1} value={b.keep} onChange={(e) => setB({ ...b, keep: e.target.value })} /></Field></div>
      <div><Button onClick={() => onSave('backup', b)}>Save backup settings</Button></div>
    </div>
  );
}

// ------------------------------------------------------------------ imports
function Imports() {
  const toast = useToast();
  const templates = useApi('/imports/templates');
  const batches = useApi('/imports/batches');
  const [type, setType] = useState('customers');
  const [upload, setUpload] = useState(null);
  const [cfg, setCfg] = useState({ sheet: '', mapping: {}, date_format: 'DD/MM/YYYY', source_system: 'old-sheet' });
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [batchKey] = useState(newKey());
  const [open, setOpen] = useState(null);
  const tpl = templates.data?.find((t) => t.key === type);
  const sheet = upload?.sheets.find((s) => s.name === cfg.sheet) || upload?.sheets[0];
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const onFile = (file) => run(async () => {
    const res = await api('/imports/upload', { method: 'POST', raw: file, query: { name: file.name, type } });
    setUpload(res);
    setCfg((c) => ({ ...c, sheet: res.sheets[0]?.name, mapping: res.suggested || {} }));
    setPreview(null);
    setResult(null);
  });
  return (
    <div className="stack">
      <Card title="1. Choose what to import" sub="Prioritise active orders, open enquiries and priority past customers — perfect history is not needed before going live.">
        <div className="row wrap">
          <Select value={type} onChange={(e) => { setType(e.target.value); setUpload(null); setPreview(null); setResult(null); }} options={(templates.data || []).map((t) => ({ value: t.key, label: t.label }))} />
          <Button icon="download" onClick={() => downloadAuthed(`/imports/templates/${type}.csv`).catch((e) => toast.error(e.message))}>Download template</Button>
          <Button icon="download" variant="ghost" onClick={() => downloadAuthed(`/imports/templates/${type}/guide.csv`).catch((e) => toast.error(e.message))}>Column guide</Button>
        </div>
        {tpl && <div className="small muted mt-8">Columns: {tpl.columns.map((c) => `${c.label}${c.required ? '*' : ''}`).join(', ')}. Blank dates and quantities stay unknown — they are never filled with today or 1.</div>}
      </Card>
      <Card title="2. Upload and map" sub="CSV or XLSX">
        <input type="file" accept=".csv,.xlsx,.txt" onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
        {upload && (
          <div className="stack-sm mt-12">
            {upload.previously_imported.length > 0 && <Notice tone="warn">This exact file was imported before (batch {upload.previously_imported.map((b) => `#${b.id}`).join(', ')}). Re-importing skips rows that were already imported.</Notice>}
            <div className="row wrap">
              {upload.sheets.length > 1 && <Field label="Sheet"><Select value={cfg.sheet} onChange={(e) => setCfg({ ...cfg, sheet: e.target.value })} options={upload.sheets.map((s) => s.name)} /></Field>}
              <Field label="Date format"><Select value={cfg.date_format} onChange={(e) => setCfg({ ...cfg, date_format: e.target.value })} options={['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']} /></Field>
              <Field label="Source system" hint="Recorded on every imported record"><Input value={cfg.source_system} onChange={(e) => setCfg({ ...cfg, source_system: e.target.value })} /></Field>
            </div>
            <div className="table-wrap"><table className="table compact"><thead><tr><th>Field</th><th>Column in your file</th><th>Sample</th></tr></thead><tbody>
              {tpl.columns.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}{c.required && <span className="danger-text">*</span>}<div className="sub">{c.help}</div></td>
                  <td><Select value={cfg.mapping[c.key] ?? ''} onChange={(e) => setCfg({ ...cfg, mapping: { ...cfg.mapping, [c.key]: e.target.value === '' ? undefined : Number(e.target.value) } })} options={sheet.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))} placeholder="— not in file —" /></td>
                  <td className="small muted">{cfg.mapping[c.key] !== undefined ? sheet.sample.map((r) => r[cfg.mapping[c.key]]).filter(Boolean).slice(0, 2).join(' · ') : ''}</td>
                </tr>
              ))}
            </tbody></table></div>
            <div><Button variant="primary" loading={busy} onClick={() => run(async () => setPreview(await api.post('/imports/preview', { upload_id: upload.upload_id, type, ...cfg, decisions })))}>3. Preview & validate</Button> <span className="small muted">Nothing is saved at this step.</span></div>
          </div>
        )}
      </Card>
      {preview && !result && (
        <Card title="3. Preview" sub={preview.note}>
          <div className="row wrap mb-12">{Object.entries(preview.counts).map(([k, n]) => <Badge key={k} tone={k === 'error' ? 'red' : k === 'needs_decision' ? 'amber' : k === 'insert' ? 'green' : 'slate'}>{k.replace('_', ' ')}: {n}</Badge>)}</div>
          {preview.unknown_products.length > 0 && <Notice tone="warn">Unknown products: {preview.unknown_products.join(', ')} — add them in Products, or they are kept as text needing clarification.</Notice>}
          {preview.reconciliation.length > 0 && <div className="small mb-12">Order quantities to reconcile: {preview.reconciliation.map((o) => `${o.order_ref}: ${o.confirmed} ordered, ${o.dispatched} dispatched, ${o.cancelled} cancelled, ${o.remaining} remaining`).join(' · ')}</div>}
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table className="table compact">
              <thead><tr><th>Row</th><th>Record</th><th>Action</th><th>Messages</th><th>Duplicate decision</th></tr></thead>
              <tbody>{preview.rows.map((r) => (
                <tr key={r.row_number}>
                  <td>{r.row_number}</td><td>{r.summary}</td>
                  <td><Badge tone={r.action === 'error' ? 'red' : r.action === 'needs_decision' ? 'amber' : r.action === 'insert' ? 'green' : 'slate'}>{r.action.replace('_', ' ')}</Badge></td>
                  <td className="small">{[...r.errors, ...r.warnings].join('; ')}{r.matches?.length > 0 && <div className="sub">Matches: {r.matches.map((m) => `${m.company_name} (${m.reasons.join(', ')})`).join('; ')}</div>}</td>
                  <td>{(r.action === 'needs_decision' || decisions[r.row_number]) && (
                    <Select className="sm" value={decisions[r.row_number] || ''} onChange={(e) => setDecisions({ ...decisions, [r.row_number]: e.target.value })} placeholder="Choose…"
                      options={[{ value: 'create', label: 'Create new' }, { value: 'skip', label: 'Skip row' }, ...(r.matches || []).map((m) => ({ value: `link:${m.id}`, label: `Link to ${m.company_name}` }))]} />
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="row mt-12">
            <Button loading={busy} onClick={() => run(async () => setPreview(await api.post('/imports/preview', { upload_id: upload.upload_id, type, ...cfg, decisions })))}>Re-check with decisions</Button>
            <Button variant="cta" loading={busy} onClick={() => run(async () => { const r = await api.post('/imports/commit', { batch_key: batchKey, upload_id: upload.upload_id, type, ...cfg, decisions }); setResult(r); batches.reload(); })}>4. Commit import</Button>
          </div>
          <div className="small muted mt-8">Rows that need a duplicate decision and have none are skipped (never merged). The batch can be retried safely — rows already imported are not duplicated.</div>
        </Card>
      )}
      {result && <BatchResult detail={result} onChange={(d) => { setResult(d); batches.reload(); }} />}
      <Card flush title="Import history">
        <DataTable rows={batches.data || []} onRowClick={async (b) => setOpen(await api.get(`/imports/batches/${b.id}`))} columns={[
          { key: 'id', label: 'Batch', render: (b) => `#${b.id}` }, { key: 'type', label: 'Type', render: (b) => b.type.replace('_', ' ') }, { key: 'file', label: 'File', render: (b) => b.file_name },
          { key: 'counts', label: 'Result', render: (b) => Object.entries(b.counts).map(([k, n]) => `${k} ${n}`).join(' · ') }, { key: 'status', label: 'Status', render: (b) => (b.rolled_back_at ? <Badge tone="red">Rolled back</Badge> : <Badge tone="green">{b.status}</Badge>) },
          { key: 'when', label: 'When', render: (b) => `${dateTime(b.created_at)} · ${b.created_by_name}` },
        ]} />
      </Card>
      <Modal open={Boolean(open)} size="xl" onClose={() => setOpen(null)} title={`Import batch #${open?.batch?.id}`}>{open && <BatchResult detail={open} onChange={(d) => { setOpen(d); batches.reload(); }} />}</Modal>
    </div>
  );
}

function BatchResult({ detail, onChange }) {
  const toast = useToast();
  const { can } = useAuth();
  const b = detail.batch;
  return (
    <Card title={`Import result — batch #${b.id}`} actions={<>
      <Button size="sm" icon="download" onClick={() => downloadAuthed(`/imports/batches/${b.id}/log.csv`).catch((e) => toast.error(e.message))}>Result log</Button>
      {!b.rolled_back_at && <Button size="sm" onClick={async () => { try { onChange(await api.post(`/imports/batches/${b.id}/retry`, {})); toast.success('Failed rows retried'); } catch (e) { toast.error(e.message); } }}>Retry failed rows</Button>}
      {!b.rolled_back_at && can('settings.manage') && <Button size="sm" variant="danger-ghost" onClick={async () => { const reason = window.prompt('Reason for rolling back this batch:'); if (!reason) return; try { onChange(await api.post(`/imports/batches/${b.id}/rollback`, { reason })); toast.success('Batch rolled back'); } catch (e) { toast.error(`${e.message}${e.details?.blockers ? ` — ${e.details.blockers.join('; ')}` : ''}`); } }}>Roll back</Button>}
    </>}>
      <div className="row wrap mb-12">{Object.entries(b.counts).map(([k, n]) => <Badge key={k} tone={k === 'failed' ? 'red' : k === 'inserted' ? 'green' : 'slate'}>{k}: {n}</Badge>)}</div>
      {detail.reconciliation && <div className="small mb-12">Imported orders: {detail.reconciliation.map((o) => `${o.code} (${o.external_id}): ${o.confirmed} ordered, ${o.dispatched} dispatched, ${o.cancelled} cancelled, ${o.remaining} remaining`).join(' · ')}</div>}
      <div className="table-wrap" style={{ maxHeight: 320 }}>
        <table className="table compact"><thead><tr><th>Row</th><th>Result</th><th>Record</th><th>Message</th></tr></thead>
          <tbody>{detail.rows.map((r) => <tr key={r.row_number}><td>{r.row_number}</td><td><Badge tone={r.status === 'failed' ? 'red' : r.status === 'inserted' ? 'green' : 'slate'}>{r.status}</Badge></td><td>{r.entity_type ? `${r.entity_type} #${r.entity_id}` : '—'}</td><td className="small">{r.message}</td></tr>)}</tbody>
        </table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ system
function System() {
  const { data, error, reload } = useApi('/admin/system');
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [restore, setRestore] = useState(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const act = async (name, fn) => {
    setBusy(name);
    try {
      await fn();
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="grid grid-2">
        <Card title="Reminder evaluator" actions={<Button size="sm" loading={busy === 'run'} onClick={() => act('run', async () => { const r = await api.post('/admin/scheduler/run'); toast.success(`Run ${r.status || 'done'}`); })}>Run now</Button>}>
          <div className="small muted mb-8">{data.scheduler.settings.enabled ? `Runs every ${data.scheduler.settings.intervalMinutes} minutes.` : 'Automatic runs are off.'} Running twice never duplicates alerts.</div>
          <table className="table compact"><thead><tr><th>Started</th><th>Trigger</th><th>Status</th></tr></thead>
            <tbody>{data.scheduler.runs.map((r) => <tr key={r.id}><td>{dateTime(r.started_at)}</td><td>{r.trigger}</td><td><Badge tone={r.status === 'ok' ? 'green' : r.status === 'running' ? 'blue' : 'red'}>{r.status}</Badge>{r.error && <div className="sub danger-text">{r.error.map((e) => `${e.rule}: ${e.message}`).join('; ')}</div>}</td></tr>)}</tbody></table>
          <div className="small mt-8">Open alerts: {data.scheduler.open_alerts.map((a) => `${a.rule.replace(/_/g, ' ')} ${a.n}`).join(' · ') || 'none'}</div>
        </Card>
        <Card title="Backups" actions={<><Button size="sm" loading={busy === 'backup'} onClick={() => act('backup', async () => { const b = await api.post('/admin/backups'); toast[b.status === 'failed' ? 'error' : 'success'](`Backup ${b.status}`); })}>Back up now</Button><Button size="sm" loading={busy === 'restore'} onClick={() => act('restore', async () => setRestore(await api.post('/admin/backups/restore-test')))}>Restore test</Button></>}>
          <div className="small muted mb-8">Database and documents are backed up together. {data.backups.settings.enabled ? `Daily after ${data.backups.settings.hour}:00, keeping ${data.backups.settings.keep}.` : 'Automatic backups are off.'}</div>
          {restore && <Notice tone={restore.ok ? 'success' : 'danger'} title={`Restore test ${restore.ok ? 'passed' : 'failed'}`}>{restore.checks.map((c) => <div key={c.name}>{c.ok ? '✓' : '✗'} {c.name} — {c.detail}</div>)}</Notice>}
          <table className="table compact"><thead><tr><th>When</th><th>Status</th><th>Size</th></tr></thead>
            <tbody>{data.backups.list.map((b) => <tr key={b.id}><td>{dateTime(b.started_at)} <span className="sub">{b.trigger}</span></td><td><Badge tone={b.status === 'ok' ? 'green' : b.status === 'failed' ? 'red' : 'amber'}>{b.status}</Badge>{b.error && <div className="sub">{b.error}</div>}</td><td className="small">{fileSize(b.db_bytes)} + {b.files ?? 0} files ({fileSize(b.file_bytes)})</td></tr>)}</tbody></table>
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Quantity reconciliation" sub="current-state quantities vs dispatch and cancellation events">
          {data.quantity_reconciliation.mismatches.length ? <Notice tone="danger">{data.quantity_reconciliation.mismatches.length} line(s) differ from their events.</Notice> : <Notice tone="success">All order line quantities match their events.</Notice>}
        </Card>
        <Card title="Data ownership" sub="Veritek can export everything at any time">
          <div className="stack-sm">
            <div className="small">Full export: every customer, transaction, history and document as CSV files plus the stored documents, in one ZIP.</div>
            <div><Button icon="download" loading={busy === 'export'} onClick={() => act('export', () => downloadAuthed('/admin/export/full.zip', null, 'veritek-export.zip'))}>Download full export</Button></div>
            <div className="small muted">Database: {data.database.path} · {fileSize(data.database.bytes)} · migrations {data.database.migrations.map((m) => m.version).join(', ')}</div>
          </div>
        </Card>
      </div>
      <Card title="Recent errors" sub="application, reminder and backup failures">
        {!data.errors.length ? <div className="small muted">No errors logged.</div> : (
          <table className="table compact"><thead><tr><th>When</th><th>Where</th><th>Message</th></tr></thead>
            <tbody>{data.errors.map((e) => <tr key={e.id}><td>{dateTime(e.at)}</td><td className="mono">{e.method} {e.path}</td><td className="small">{e.message}</td></tr>)}</tbody></table>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ audit
function Audit() {
  const [f, setF] = useState({ entity_type: '', action: '', page: 1 });
  const { data, error, reload } = useApi('/admin/audit', f);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <Card flush title="Audit log" sub="every change: who, when, from where, and what changed — no one can erase it">
      <div className="row wrap" style={{ padding: 12 }}>
        <Select value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value, page: 1 })} options={['customer', 'contact', 'enquiry', 'quote_revision', 'order', 'order_line', 'dispatch', 'task', 'activity', 'user', 'settings', 'import_batch', 'attachment', 'invoice', 'complaint'].map((x) => ({ value: x, label: x.replace('_', ' ') }))} placeholder="All records" />
        <Input placeholder="Action contains…" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })} style={{ maxWidth: 220 }} />
      </div>
      {!data ? <Spinner /> : (
        <>
          <DataTable rows={data.rows} columns={[
            { key: 'when', label: 'When', render: (a) => dateTime(a.created_at) }, { key: 'who', label: 'Who', render: (a) => a.actor_name || 'System' },
            { key: 'what', label: 'Record', render: (a) => `${a.entity_type}${a.entity_id ? ` #${a.entity_id}` : ''}` }, { key: 'action', label: 'Action', render: (a) => a.action },
            { key: 'changes', label: 'Changes', render: (a) => <span className="mono" style={{ fontSize: 11, wordBreak: 'break-word' }}>{a.changes ? JSON.stringify(a.changes).slice(0, 220) : ''}</span> },
            { key: 'src', label: 'Source', render: (a) => <span className="small">{a.source}{a.request_id ? ` · ${a.request_id}` : ''}</span> },
          ]} />
          <Pagination page={data.page} pageSize={data.pageSize} count={data.count} onChange={(p) => setF({ ...f, page: p })} />
        </>
      )}
    </Card>
  );
}

export { Link, Textarea };
