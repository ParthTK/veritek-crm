import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters, useSave } from '../lib/hooks.js';
import { date, timeAgo, moneyByCurrency } from '../lib/format.js';
import {
  Badge, Button, Card, Chips, DataTable, ErrorState, PageHeader, Checkbox, Field, Textarea, Notice, SaveStatus, Modal, useToast, SearchBox, Input,
} from '../components/ui.jsx';
import { DueBadge, ReactivationBadge, OptionSelect, UserSelect, DateField, FilterBar, useMeta, useOptions, ProductSelect } from '../components/domain.jsx';
import { FollowupForm } from '../components/forms.jsx';
import Icon from '../components/Icon.jsx';

export default function PastCustomers() {
  const { can } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const [params] = useSearchParams();
  const [f, setF] = useUrlFilters({ segment: 'all' });
  const { data, error, loading, reload } = useApi('/past-customers', { segment: f.segment, filter: f.filter, include_dnc: f.dnc, owner: f.owner, market: f.market || f.segment_market, country: f.country, q: f.q });
  const [selectedId, setSelectedId] = useState(Number(params.get('customer')) || null);
  useEffect(() => {
    if (data?.rows?.length && !data.rows.some((r) => r.id === selectedId)) setSelectedId(data.rows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const row = data?.rows.find((r) => r.id === selectedId);
  const c = data?.counts || {};
  const m = data?.metrics;

  return (
    <div className="stack">
      <PageHeader title="Past customers — what should we do next?" subtitle="Keep the reason, the history and the next action together."
        eyebrow={data && <span className="muted">Past buyer = at least one confirmed order and none in the last {data.threshold} days (setting). Lost prospect = lost opportunity, never purchased.</span>} />
      <div className="row wrap between">
        <Chips value={f.filter ? `f:${f.filter}` : f.segment} onChange={(v) => (v.startsWith('f:') ? setF({ filter: v.slice(2), segment: 'all' }) : setF({ segment: v, filter: '' }))} options={[
          { value: 'all', label: 'All', count: c.all },
          { value: 'past_buyers', label: 'Past buyers', count: c.past_buyers },
          { value: 'lost_prospects', label: 'Lost prospects', count: c.lost_prospects },
          { value: 'f:followup_due', label: 'Follow-up due', count: c.followup_due, tone: 'amber' },
          { value: 'f:not_reviewed', label: 'Not reviewed', count: c.not_reviewed },
          { value: 'f:date_unknown', label: 'Last order date unknown', count: c.date_unknown },
        ]} />
        <div className="row wrap">
          <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer…" />
          <Checkbox label="Show do-not-contact" checked={f.dnc === '1'} onChange={(v) => setF({ dnc: v ? '1' : '' })} />
        </div>
      </div>
      <FilterBar value={{ owner: f.owner, segment: f.market, country: f.country }} onChange={(p) => setF({ owner: p.owner ?? f.owner, market: p.segment ?? f.market, country: p.country ?? f.country })} fields={['owner', 'segment', 'country']} />
      {error && <ErrorState error={error} onRetry={reload} />}
      <div className="split wide">
        <div className="stack">
          <Card flush>
            <DataTable loading={loading} rows={data?.rows} selectedKey={selectedId} onRowClick={(r) => setSelectedId(r.id)}
              empty={<div className="empty">No customers in this view.</div>}
              columns={[
                { key: 'customer', label: 'Customer', render: (r) => <><strong>{r.company_name}</strong>{r.do_not_contact ? <> <Badge size="sm" tone="slate" icon="ban">Do not contact</Badge></> : null}<div className="sub">{[r.city, r.country_code].filter(Boolean).join(', ')} · {r.owner_name}</div></> },
                { key: 'last', label: 'Last activity', render: (r) => (r.kind === 'past_buyer'
                  ? <span className="small">Last order:<br /><strong>{r.last_order_date ? timeAgo(r.last_order_date) : 'unknown'}</strong></span>
                  : <span className="small">Quote lost:<br /><strong>{r.lost_enquiry ? timeAgo(r.lost_enquiry.decided_at) : '—'}</strong></span>) },
                { key: 'why', label: 'Why no purchase?', render: (r) => (r.why ? <Badge tone={r.why.code === 'unknown' ? 'slate' : r.why.code === 'price' ? 'red' : 'amber'}>{r.why.label}</Badge> : <span className="muted small">Not recorded</span>) },
                { key: 'next', label: 'Next action', render: (r) => (r.next_action ? <span className="stack-xs"><span className="small">{r.next_action.purpose}</span><DueBadge task={r.next_action} /></span> : <span className="muted small">None</span>) },
                { key: 'status', label: 'Status', render: (r) => <ReactivationBadge status={r.status} /> },
              ]}
              card={(r) => <><div className="row between"><strong>{r.company_name}</strong><ReactivationBadge status={r.status} /></div><div className="small">{r.why ? `Why: ${r.why.label}` : 'Reason not recorded'}</div>{r.next_action && <div className="row"><DueBadge task={r.next_action} /><span className="small">{r.next_action.purpose}</span></div>}</>}
            />
          </Card>
          {m && (
            <Card title="What this tells you" sub={`last 90 days`}>
              <div className="grid grid-4">
                <div className="stat"><span className="k">Customers contacted</span><span className="v">{m.contacted}</span><span className="d">of {m.cases} reconnect cases</span></div>
                <div className="stat"><span className="k">Responses received</span><span className="v">{m.responses}</span></div>
                <div className="stat"><span className="k">Opportunities reopened</span><span className="v">{m.reopened}</span></div>
                <div className="stat"><span className="k">Won back</span><span className="v">{m.won_back}</span><span className="d">{can('values.view') ? moneyByCurrency(m.won_back_value) : ''}</span></div>
              </div>
              {m.reasons.length > 0 && <div className="small muted mt-12">Why customers stopped buying (recorded reasons): {m.reasons.map((x) => `${x.label} ${x.n}`).join(' · ')}</div>}
            </Card>
          )}
        </div>
        <div className="sticky-side">{row && <SidePanel key={row.id} row={row} threshold={data.threshold} onSaved={reload} />}</div>
      </div>
    </div>
  );
}

function SidePanel({ row, threshold, onSaved }) {
  const { can } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const save = useSave();
  const actions = useOptions('reactivation_action');
  const [form, setForm] = useState({ reason_code: row.case?.reason_code || '', note: '', action_type: 'call', due_date: row.next_action?.due_date || '', owner_id: row.next_action?.owner_id || row.owner_id, override_dnc: false });
  const [modal, setModal] = useState(null);
  const [task, setTask] = useState(null);
  const set = (p) => setForm((x) => ({ ...x, ...p }));
  const reasonOpt = useOptions('lost_reason').find((o) => o.value === form.reason_code);
  const dnc = save.error?.code === 'do_not_contact';
  const caseOpen = row.case?.open;
  const openTask = async () => {
    const t = await api.get(`/tasks/${row.next_action.id}`);
    const p = await api.get(`/customers/${row.id}`);
    setTask({ ...t, contacts: p.contacts.filter((x) => x.active) });
    setModal('contact');
  };
  return (
    <Card title={<Link to={`/customers/${row.id}`}>{row.company_name}</Link>} actions={<Badge tone={row.kind === 'past_buyer' ? 'green' : 'violet'}>{row.kind === 'past_buyer' ? 'Past customer' : 'Lost prospect'}</Badge>}>
      <div className="stack">
        <div className="card soft"><div className="card-body stack-xs small">
          <div><Icon name="calendar" size={14} /> <strong>Last purchase:</strong> {row.last_order_date ? date(row.last_order_date, { year: true }) : row.kind === 'past_buyer' ? 'Unknown (historical record)' : 'Never'}{row.legacy_source && row.last_order_date ? <span className="muted"> · from {row.legacy_source}</span> : null}</div>
          <div><Icon name="inbox" size={14} /> <strong>Last enquiry:</strong> {row.last_enquiry_at ? date(row.last_enquiry_at, { year: true }) : '—'}{row.open_enquiries ? ` · ${row.open_enquiries} open now` : ''}{row.active_orders ? ` · ${row.active_orders} active order(s)` : ''}</div>
          <div><Icon name="flag" size={14} /> <strong>Reason recorded:</strong> {row.why ? <>{row.why.label}{row.why.enquiry_id && <> — <Link to={`/enquiries/${row.why.enquiry_id}`}>{row.why.enquiry_code}</Link></>}{row.why.note ? ` (“${row.why.note}”)` : ''}</> : 'none'}</div>
          <div><Icon name="phone" size={14} /> <strong>Last contact:</strong> {row.last_contact ? `${row.last_contact.outcome_label || ''} · ${date(row.last_contact.occurred_at)} by ${row.last_contact.reported_by_name || row.last_contact.by_name || '—'}` : 'none recorded'}</div>
          {row.do_not_contact ? <Notice tone="warn">Do not contact: {row.dnc_reason}</Notice> : null}
        </div></div>
        {can('past.edit') && (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/past-customers/${row.id}/update`, form); toast.success('Saved — reminder set'); onSaved(); }); }}>
            <h3>Record a simple update</h3>
            <Field label="Why no purchase?" hint="Belongs to this reconnect case — not a permanent label" error={save.fields.reason_code}>
              <OptionSelect category="lost_reason" value={form.reason_code} onChange={(v) => set({ reason_code: v })} placeholder="Not known yet" />
            </Field>
            {form.reason_code === 'unknown' && <div className="tiny muted">Unknown is fine — set the next action to ask for feedback rather than guessing.</div>}
            <Field label="Note" optional={!reasonOpt?.requires_note} required={reasonOpt?.requires_note} error={save.fields.note}><Textarea rows={2} value={form.note} onChange={(e) => set({ note: e.target.value })} placeholder="e.g. Required delivery was 7 days" /></Field>
            <div className="form-grid">
              <Field label="Next action"><OptionSelect category="reactivation_action" value={form.action_type} onChange={(v) => set({ action_type: v })} /></Field>
              <Field label="Owner" error={save.fields.owner_id}><UserSelect value={form.owner_id} onChange={(v) => set({ owner_id: v })} /></Field>
            </div>
            <DateField label="Follow-up date" required value={form.due_date} onChange={(v) => set({ due_date: v })} error={save.fields.due_date} />
            {dnc && <Notice tone="warn" title="Do-not-contact preference">{save.error.message}<div className="mt-8"><input type="checkbox" id="dnc-ok" checked={form.override_dnc} onChange={(e) => set({ override_dnc: e.target.checked })} /> <label htmlFor="dnc-ok">I have a valid reason to contact them</label></div></Notice>}
            <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="cta" loading={save.saving} disabled={!actions.length}>Save & set reminder</Button></div>
          </form>
        )}
        {can('past.edit') && (
          <div className="row wrap">
            {row.next_action && <Button size="sm" icon="phone" onClick={() => openTask().catch((e) => toast.error(e.message))}>Record contact</Button>}
            {can('enquiries.edit') && <Button size="sm" icon="plus" onClick={() => setModal('enquiry')}>New enquiry from this</Button>}
            {caseOpen && <Button size="sm" icon="x" variant="ghost" onClick={() => setModal('close')}>Not pursuing / won back</Button>}
          </div>
        )}
      </div>
      <Modal open={modal === 'contact'} onClose={() => setModal(null)} title={`Record contact — ${row.company_name}`} subtitle={task?.purpose}>
        {task && <FollowupForm task={task} contacts={task.contacts} onSaved={() => { toast.success('Contact recorded'); setModal(null); onSaved(); }} />}
      </Modal>
      <Modal open={modal === 'enquiry'} onClose={() => setModal(null)} title="New linked enquiry" subtitle="A fresh requirement found while reconnecting. The original acquisition source is kept.">
        <LinkedEnquiryForm customerId={row.id} ownerId={row.owner_id} onSaved={(res) => { toast.success('Enquiry opened — status set to Opportunity reopened'); setModal(null); onSaved(); window.location.assign(`/enquiries/${res.id}`); }} />
      </Modal>
      <Modal open={modal === 'close'} size="sm" onClose={() => setModal(null)} title="Close reconnect case">
        <CloseCaseForm row={row} onSaved={() => { toast.success('Case closed'); setModal(null); onSaved(); }} />
      </Modal>
    </Card>
  );
}

function LinkedEnquiryForm({ customerId, ownerId, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ product_id: null, requirement: '', qty: '', owner_id: ownerId, override_dnc: false });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async (key) => { const r = await api.post(`/past-customers/${customerId}/enquiry`, { owner_id: f.owner_id, override_dnc: f.override_dnc, lines: [{ product_id: f.product_id, requirement: f.product_id ? undefined : f.requirement || 'Unspecified / needs clarification', qty: f.qty === '' ? null : Number(f.qty) }] }, { key }); onSaved(r); }); }}>
      <Field label="Product"><ProductSelect value={f.product_id} onChange={(v) => setF({ ...f, product_id: v })} /></Field>
      {!f.product_id && <Field label="Requirement"><Input value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} /></Field>}
      <Field label="Quantity" optional><Input type="number" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
      <Field label="Owner"><UserSelect value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} /></Field>
      {save.error?.code === 'do_not_contact' && <Checkbox label="I have a valid reason to contact this customer" checked={f.override_dnc} onChange={(v) => setF({ ...f, override_dnc: v })} />}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Open enquiry</Button></div>
    </form>
  );
}

function CloseCaseForm({ row, onSaved }) {
  const save = useSave();
  const [f, setF] = useState({ status: 'not_pursuing', reason_code: '', note: '', review_date: '', order_id: '' });
  const reason = useOptions('reactivation_close_reason').find((o) => o.value === f.reason_code);
  const { data: orders } = useApi(f.status === 'won_back' ? '/orders' : null, { customer_id: row.id, view: 'all' });
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/reactivation/${row.case.id}/close`, f); onSaved(); }); }}>
      <Field label="Outcome"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="not_pursuing">Not pursuing</option><option value="won_back">Won back (needs a confirmed order)</option></select></Field>
      {f.status === 'not_pursuing' ? (
        <>
          <Field label="Reason" required error={save.fields.reason_code}><OptionSelect category="reactivation_close_reason" value={f.reason_code} onChange={(v) => setF({ ...f, reason_code: v })} /></Field>
          <Field label="Note" optional={!reason?.requires_note} error={save.fields.note}><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <DateField label="Review again on" value={f.review_date} onChange={(v) => setF({ ...f, review_date: v })} hint="Optional — the customer comes back to this list then" />
        </>
      ) : (
        <Field label="Confirmed order" required error={save.fields.order_id}>
          <select className="select" value={f.order_id} onChange={(e) => setF({ ...f, order_id: e.target.value })}>
            <option value="">Choose…</option>
            {(orders?.rows || []).filter((o) => o.status === 'confirmed').map((o) => <option key={o.id} value={o.id}>{o.code} · {date(o.received_date)}</option>)}
          </select>
        </Field>
      )}
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant="primary" loading={save.saving}>Close case</Button></div>
    </form>
  );
}
