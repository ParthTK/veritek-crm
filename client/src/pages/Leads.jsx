import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  LEAD_STAGES, LEAD_STATUSES, LEAD_TEMPERATURES, LEAD_SOURCES, CUSTOMER_TYPES, INDUSTRIES, COMPETITORS, LOSS_REASONS, WIN_REASONS, labelOf,
} from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { inrCompact, date, relativeDay, daysFromToday, todayStr, addDaysStr, downloadCsv } from '../lib/format.js';
import {
  Button, Card, DataTable, Field, Input, Modal, OptionBadge, PageHeader, Pagination, SearchBox, Select, Textarea, Tags, useToast, Chips, Badge,
} from '../components/ui.jsx';
import { CustomerPicker, UserSelect, useMeta, SALES_ROLES } from '../components/domain.jsx';

export function FollowUpCell({ lead }) {
  if (lead.status !== 'open') return <span className="muted small">—</span>;
  const d = daysFromToday(lead.next_follow_up_date);
  return (
    <div className="col" style={{ gap: 0, maxWidth: 240 }}>
      <span className="truncate small">{lead.next_action || <span className="danger-text">No next action</span>}</span>
      <span className={`tiny ${d < 0 ? 'danger-text strong' : d === 0 ? 'warning-text strong' : 'muted'}`}>{lead.next_follow_up_date ? relativeDay(lead.next_follow_up_date) : 'No date'}</span>
    </div>
  );
}

export default function Leads() {
  const { can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [f, setFilter, clear] = useUrlFilters({ status: 'open' });
  const [creating, setCreating] = useState(false);
  const query = { ...f, status: f.status === 'all' ? '' : f.status, pageSize: 50 };
  const { data, loading, reload } = useApi('/leads', query);
  const sort = f.sort ? { key: f.sort, dir: f.dir || 'desc' } : null;

  const columns = [
    { key: 'code', label: 'Lead', sort: 'code', render: (l) => (
      <div className="col" style={{ gap: 0, maxWidth: 280 }}>
        <Link to={`/leads/${l.id}`} className="strong truncate">{l.title}</Link>
        <span className="tiny muted">{l.code} · {date(l.created_at)}</span>
        <Tags tags={l.tags} />
      </div>
    ) },
    { key: 'customer', label: 'Customer', sort: 'customer', render: (l) => (
      <div className="col" style={{ gap: 0, maxWidth: 220 }}>
        <Link to={`/customers/${l.customer_id}`} className="truncate">{l.customer_name}</Link>
        <span className="tiny muted truncate">{[l.contact_name, l.city].filter(Boolean).join(' · ')}</span>
      </div>
    ) },
    { key: 'stage', label: 'Stage', sort: 'stage', render: (l) => (l.status === 'open' ? <OptionBadge list={LEAD_STAGES} value={l.stage} /> : <OptionBadge list={LEAD_STATUSES} value={l.status} />) },
    { key: 'temperature', label: 'Temp.', sort: 'temperature', render: (l) => <OptionBadge list={LEAD_TEMPERATURES} value={l.temperature} size="sm" /> },
    { key: 'value', label: 'Est. value', align: 'num', sort: 'value', render: (l) => <span className="num">{inrCompact(l.estimated_value)}</span> },
    { key: 'probability', label: 'Prob.', align: 'num', sort: 'probability', render: (l) => `${l.probability}%` },
    { key: 'follow_up', label: 'Next action', sort: 'follow_up', render: (l) => <FollowUpCell lead={l} /> },
    { key: 'owner', label: 'Salesperson', sort: 'owner', render: (l) => l.owner_name || <Badge color="amber">Unassigned</Badge> },
    { key: 'source', label: 'Source', render: (l) => <span className="small">{labelOf(LEAD_SOURCES, l.source)}{l.campaign_name ? <div className="tiny muted truncate" style={{ maxWidth: 140 }}>{l.campaign_name}</div> : null}</span> },
  ];

  const exportCsv = async () => {
    const all = await api.get('/leads', { ...query, pageSize: 500, page: 1 });
    downloadCsv('leads.csv', [
      { key: 'code', label: 'Code' }, { key: 'title', label: 'Title' }, { key: 'customer_name', label: 'Customer' }, { key: 'city', label: 'City' },
      { key: 'stage', label: 'Stage', csv: (l) => labelOf(LEAD_STAGES, l.stage) }, { key: 'status', label: 'Status' }, { key: 'temperature', label: 'Temperature' },
      { key: 'estimated_value', label: 'Estimated value' }, { key: 'probability', label: 'Probability' }, { key: 'expected_close_date', label: 'Expected close' },
      { key: 'next_action', label: 'Next action' }, { key: 'next_follow_up_date', label: 'Follow-up date' }, { key: 'owner_name', label: 'Salesperson' },
      { key: 'source', label: 'Source', csv: (l) => labelOf(LEAD_SOURCES, l.source) }, { key: 'campaign_name', label: 'Campaign' }, { key: 'competitor', label: 'Competitor' },
    ], all.rows);
  };

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Every enquiry in a structured pipeline — no lead without a next action"
        actions={(
          <>
            <Button icon="download" onClick={exportCsv}>Export</Button>
            <Button to="/opportunities" icon="pipeline">Pipeline board</Button>
            {can('leads.edit') && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New lead</Button>}
          </>
        )}
      />
      <div className="filter-bar">
        <SearchBox value={f.q} onChange={(q) => setFilter({ q })} placeholder="Search lead, customer, requirement" />
        <Chips
          options={[{ value: 'overdue', label: 'Follow-up overdue' }, { value: 'today', label: 'Due today' }]}
          value={f.followup || ''} onChange={(v) => setFilter({ followup: v })}
        />
        <Select className="sm" value={f.status} onChange={(e) => setFilter({ status: e.target.value })} options={[...LEAD_STATUSES, { value: 'all', label: 'All statuses' }]} />
        <Select className="sm" value={f.stage} onChange={(e) => setFilter({ stage: e.target.value })} placeholder="Any stage" options={LEAD_STAGES} />
        <Select className="sm" value={f.temperature} onChange={(e) => setFilter({ temperature: e.target.value })} placeholder="Any temperature" options={LEAD_TEMPERATURES} />
        <Select className="sm" value={f.source} onChange={(e) => setFilter({ source: e.target.value })} placeholder="Any source" options={LEAD_SOURCES} />
        <Select className="sm" value={f.campaign_id} onChange={(e) => setFilter({ campaign_id: e.target.value })} placeholder="Any campaign" options={meta.campaigns.map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="sm" value={f.category_id} onChange={(e) => setFilter({ category_id: e.target.value })} placeholder="Any product" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} />
        <Select className="sm" value={f.region_id} onChange={(e) => setFilter({ region_id: e.target.value })} placeholder="Any region" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} />
        <UserSelect className="sm" roles={SALES_ROLES} value={f.assigned_to} onChange={(e) => setFilter({ assigned_to: e.target.value })} placeholder="Any salesperson" />
        {Object.keys(f).some((k) => !['status', 'page', 'sort', 'dir'].includes(k) || (k === 'status' && f.status !== 'open')) && <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>}
      </div>
      <Card flush>
        {data && (
          <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 20 }}>
            <span><strong>{data.count}</strong> <span className="muted">leads</span></span>
            {data.sums?.value !== undefined && <span><span className="muted">Value</span> <strong>{inrCompact(data.sums.value)}</strong></span>}
            {data.sums?.weighted_value !== undefined && <span><span className="muted">Weighted</span> <strong>{inrCompact(data.sums.weighted_value)}</strong></span>}
          </div>
        )}
        <DataTable columns={columns} rows={data?.rows} loading={loading} sort={sort} onSort={(s) => setFilter({ sort: s.key, dir: s.dir })}
          onRowClick={(l) => navigate(`/leads/${l.id}`)} />
        <Pagination page={Number(f.page) || 1} pageSize={50} count={data?.count || 0} onChange={(page) => setFilter({ page })} />
      </Card>
      <LeadFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/leads/${id}`)} />
    </div>
  );
}

// ------------------------------------------------------------------ create / edit
export function LeadFormModal({ open, onClose, onSaved, lead, defaults }) {
  const meta = useMeta();
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState({});
  const [newCompany, setNewCompany] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: products } = useApi(open ? '/products' : null, { active: 1 });
  const { data: customer } = useApi(open && form.customer_id ? `/customers/${form.customer_id}` : null);

  useEffect(() => {
    if (!open) return;
    setNewCompany(null);
    setForm(lead ? { ...lead, tags: (lead.tags || []).map((t) => t.name).join(', ') } : {
      temperature: 'warm', source: 'website', next_action: 'Call to understand requirement', next_follow_up_date: todayStr(),
      expected_close_date: addDaysStr(todayStr(), 45), ...defaults,
    });
  }, [open, lead, defaults]);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const categoryProducts = useMemo(() => (products || []).filter((p) => !form.category_id || p.category_id === Number(form.category_id)), [products, form.category_id]);

  const suggestValue = (productId, qty) => {
    const p = (products || []).find((x) => x.id === Number(productId));
    if (p?.standard_price && qty) setForm((s) => ({ ...s, estimated_value: Math.round(p.standard_price * Number(qty)) }));
  };

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, tags: String(form.tags || '').split(',').map((t) => t.trim()).filter(Boolean), new_customer: newCompany || undefined };
      if (lead) {
        await api.put(`/leads/${lead.id}`, body);
        toast.success('Lead updated');
        onSaved?.(lead.id);
      } else {
        const res = await api.post('/leads', body);
        toast.success('Lead created and follow-up scheduled');
        onSaved?.(res.id);
      }
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setNc = (k) => (e) => setNewCompany((s) => ({ ...s, [k]: e.target.value }));

  return (
    <Modal open={open} onClose={onClose} size="lg" title={lead ? `Edit ${lead.code}` : 'New lead'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{lead ? 'Save changes' : 'Create lead'}</Button></>}>
      <div className="form-grid">
        <div className="form-section">Customer</div>
        {!lead && (
          <Field label="Company" required className="full" hint={newCompany ? 'A prospect customer will be created' : 'Search existing customers or type a new company name'}>
            {newCompany ? (
              <div className="row"><Input value={newCompany.name} onChange={setNc('name')} /><Button size="sm" onClick={() => setNewCompany(null)}>Pick existing</Button></div>
            ) : (
              <CustomerPicker value={form.customer_id} onChange={(id) => setForm((s) => ({ ...s, customer_id: id, contact_id: '' }))} allowCreate onCreate={(name) => setNewCompany({ name, customer_type: 'direct', contact_role: 'purchase' })} />
            )}
          </Field>
        )}
        {newCompany ? (
          <>
            <Field label="Customer type"><Select value={newCompany.customer_type} onChange={setNc('customer_type')} options={CUSTOMER_TYPES} /></Field>
            <Field label="Industry"><Select value={newCompany.industry} onChange={setNc('industry')} placeholder="—" options={INDUSTRIES} /></Field>
            <Field label="Region"><Select value={newCompany.region_id} onChange={setNc('region_id')} placeholder="—" options={meta.regions.map((r) => ({ value: r.id, label: r.name }))} /></Field>
            <Field label="State / City"><div className="row"><Input placeholder="State" value={newCompany.state} onChange={setNc('state')} /><Input placeholder="City" value={newCompany.city} onChange={setNc('city')} /></div></Field>
            <Field label="Contact person"><Input value={newCompany.contact_name} onChange={setNc('contact_name')} /></Field>
            <Field label="Designation"><Input value={newCompany.designation} onChange={setNc('designation')} /></Field>
            <Field label="Phone / WhatsApp"><Input value={newCompany.phone} onChange={setNc('phone')} /></Field>
            <Field label="Email"><Input type="email" value={newCompany.email} onChange={setNc('email')} /></Field>
          </>
        ) : (
          <Field label="Contact person">
            <Select value={form.contact_id} onChange={set('contact_id')} placeholder={form.customer_id ? 'Primary contact' : 'Select customer first'}
              options={(customer?.contacts || []).map((c) => ({ value: c.id, label: `${c.name}${c.designation ? ` — ${c.designation}` : ''}` }))} />
          </Field>
        )}

        <div className="form-section">Requirement</div>
        <Field label="Lead title" className="full" hint="Leave blank to use the requirement"><Input value={form.title} onChange={set('title')} placeholder="e.g. APFC panel for new plant" /></Field>
        <Field label="Product requirement" className="full"><Textarea rows={2} value={form.requirement} onChange={set('requirement')} /></Field>
        <Field label="Product category"><Select value={form.category_id} onChange={(e) => setForm((s) => ({ ...s, category_id: e.target.value, product_id: '' }))} placeholder="—" options={meta.categories.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Product"><Select value={form.product_id} onChange={(e) => { set('product_id')(e); suggestValue(e.target.value, form.quantity); }} placeholder="—" options={categoryProducts.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name}` }))} /></Field>
        <Field label="Required quantity"><Input type="number" min="0" value={form.quantity} onChange={(e) => { set('quantity')(e); suggestValue(form.product_id, e.target.value); }} /></Field>
        <Field label="Estimated value (₹)" hint={form.estimated_value ? inrCompact(form.estimated_value) : 'Suggested from price master × quantity'}><Input type="number" min="0" value={form.estimated_value} onChange={set('estimated_value')} /></Field>

        <div className="form-section">Qualification</div>
        <Field label="Lead source"><Select value={form.source} onChange={set('source')} options={LEAD_SOURCES} /></Field>
        <Field label="Exhibition / campaign"><Select value={form.campaign_id} onChange={set('campaign_id')} placeholder="—" options={meta.campaigns.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Temperature"><Select value={form.temperature} onChange={set('temperature')} options={LEAD_TEMPERATURES} /></Field>
        <Field label="Probability of conversion (%)" hint="Defaults from the pipeline stage"><Input type="number" min="0" max="100" value={form.probability} onChange={set('probability')} /></Field>
        <Field label="Expected closing date"><Input type="date" value={form.expected_close_date} onChange={set('expected_close_date')} /></Field>
        <Field label="Competitor involved"><Input list="competitors" value={form.competitor} onChange={set('competitor')} /><datalist id="competitors">{COMPETITORS.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Salesperson" hint={!form.assigned_to && !lead ? 'Blank = auto-assign by region / product rules' : undefined}>
          <UserSelect roles={SALES_ROLES} value={form.assigned_to} onChange={set('assigned_to')} placeholder="Auto-assign" disabled={user.role === 'sales_executive' && Boolean(lead)} />
        </Field>
        <Field label="Tags" hint="Comma separated"><Input list="tags" value={form.tags} onChange={set('tags')} placeholder="Urgent Requirement, Export Potential" /><datalist id="tags">{meta.tags.map((t) => <option key={t.id} value={t.name} />)}</datalist></Field>

        <div className="form-section">Next action (required)</div>
        <Field label="Next action" required><Input value={form.next_action} onChange={set('next_action')} /></Field>
        <Field label="Next follow-up date" required hint={form.next_follow_up_date ? relativeDay(form.next_follow_up_date) : undefined}><Input type="date" value={form.next_follow_up_date} onChange={set('next_follow_up_date')} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ stage move / close
export function MoveLeadModal({ open, onClose, onSaved, lead, stage, status }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && lead) {
      setForm({
        stage: stage || lead.stage, status: status || 'open', next_action: lead.next_action, next_follow_up_date: lead.next_follow_up_date && lead.next_follow_up_date >= todayStr() ? lead.next_follow_up_date : addDaysStr(todayStr(), 2),
        win_loss_reason: '', competitor: lead.competitor, note: '',
      });
    }
  }, [open, lead, stage, status]);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e?.target ? e.target.value : e }));
  const closing = form.status === 'won' || form.status === 'lost';
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/leads/${lead.id}/move`, form);
      toast.success(form.status === 'open' ? `Moved to ${labelOf(LEAD_STAGES, form.stage)}` : `Lead marked ${labelOf(LEAD_STATUSES, form.status).toLowerCase()}`);
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (!lead) return null;
  const title = form.status === 'open' ? `Move to “${labelOf(LEAD_STAGES, form.stage)}”` : form.status === 'won' ? 'Mark lead won' : form.status === 'lost' ? 'Mark lead lost' : 'Put lead on hold';
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={`${lead.code} · ${lead.title}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={form.status === 'lost' ? 'danger' : 'primary'} loading={busy} onClick={save}>Confirm</Button></>}>
      <div className="form-grid">
        {form.status === 'open' && (
          <>
            <Field label="Stage" className="full"><Select value={form.stage} onChange={set('stage')} options={LEAD_STAGES.slice(0, -1)} /></Field>
            <Field label="Next action" required><Input value={form.next_action} onChange={set('next_action')} /></Field>
            <Field label="Follow-up date" required hint={relativeDay(form.next_follow_up_date)}><Input type="date" value={form.next_follow_up_date} onChange={set('next_follow_up_date')} /></Field>
          </>
        )}
        {closing && (
          <>
            <Field label={form.status === 'won' ? 'Reason for winning' : 'Reason for losing'} required={form.status === 'lost'}>
              <Select value={form.win_loss_reason} onChange={set('win_loss_reason')} placeholder="Select…" options={form.status === 'won' ? WIN_REASONS : LOSS_REASONS} />
            </Field>
            <Field label="Competitor"><Input list="competitors2" value={form.competitor} onChange={set('competitor')} /><datalist id="competitors2">{COMPETITORS.map((c) => <option key={c} value={c} />)}</datalist></Field>
          </>
        )}
        {form.status === 'won' && <div className="info-box full">Usually a lead is won by converting its accepted quotation into a sales order — that happens automatically there.</div>}
        <Field label="Note" className="full"><Textarea rows={2} value={form.note} onChange={set('note')} /></Field>
      </div>
    </Modal>
  );
}
