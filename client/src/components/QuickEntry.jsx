// Global quick entry: new enquiry, follow-up, order update and dispatch from anywhere, with unsaved
// input preserved when switching tabs or closing the drawer by accident.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Drawer, Tabs, Combobox, Field, Button, Notice, useToast, Spinner } from './ui.jsx';
import { useMeta, DueBadge, LineStateBadge } from './domain.jsx';
import { EnquiryForm, FollowupForm, ProductionUpdateForm, DispatchForm, newEnquiryDraft } from './forms.jsx';
import { date } from '../lib/format.js';

const Ctx = createContext(null);
export const useQuickEntry = () => useContext(Ctx);
const DRAFT_KEY = 'veritek.quick.enquiry';

function loadDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
}

export function QuickEntryProvider({ children }) {
  const { user, can } = useAuth();
  const meta = useMeta();
  const [state, setState] = useState({ open: false, tab: 'enquiry', preset: null });
  const [draft, setDraft] = useState(() => loadDraft() || newEnquiryDraft(user, meta));
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, [draft]);
  const open = useCallback((tab, preset = null) => {
    const allowed = { enquiry: can('enquiries.edit'), followup: can('tasks.edit'), update: can('orders.update'), dispatch: can('dispatch.post') };
    const first = Object.keys(allowed).find((k) => allowed[k]);
    setState({ open: true, tab: tab && allowed[tab] ? tab : first, preset });
  }, [can]);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  const dirty = draft.customer || draft.new_customer?.company_name || draft.lines.some((l) => l.product_id || l.requirement || l.qty) || draft.note;
  return (
    <Ctx.Provider value={value}>
      {children}
      <Drawer open={state.open} wide onClose={close} title="Quick entry" subtitle={dirty ? 'Your unsaved enquiry is kept while you switch tabs or close this panel.' : 'Choose an update. Fill only what changed.'}>
        <Tabs value={state.tab} onChange={(tab) => setState((s) => ({ ...s, tab, preset: null }))} tabs={[
          can('enquiries.edit') && { key: 'enquiry', label: 'New enquiry' },
          can('tasks.edit') && { key: 'followup', label: 'Follow-up' },
          can('orders.update') && { key: 'update', label: 'Order update' },
          can('dispatch.post') && { key: 'dispatch', label: 'Dispatch' },
        ]} />
        {state.tab === 'enquiry' && <EnquiryTab draft={draft} setDraft={setDraft} close={close} />}
        {state.tab === 'followup' && <FollowupTab preset={state.preset} close={close} />}
        {state.tab === 'update' && <UpdateTab preset={state.preset} close={close} />}
        {state.tab === 'dispatch' && <DispatchForm customerId={state.preset?.customer_id} orderId={state.preset?.order_id} onSaved={() => { close(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Drawer>
    </Ctx.Provider>
  );
}

function EnquiryTab({ draft, setDraft, close }) {
  const { user } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <div className="stack">
      <EnquiryForm draft={draft} onChange={setDraft} onSaved={(res) => {
        toast.success('Enquiry saved with its first follow-up');
        setDraft(newEnquiryDraft(user, meta));
        close();
        window.dispatchEvent(new Event('data:changed'));
        navigate(`/enquiries/${res.id}`);
      }} />
      <div><Button size="sm" variant="ghost" icon="x" onClick={() => setDraft(newEnquiryDraft(user, meta))}>Clear this draft</Button></div>
    </div>
  );
}

function FollowupTab({ preset, close }) {
  const toast = useToast();
  const [task, setTask] = useState(null);
  const [mine, setMine] = useState(null);
  const [contacts, setContacts] = useState([]);
  const pick = useCallback(async (id) => {
    const t = await api.get(`/tasks/${id}`);
    setTask(t);
    if (t.customer_id) api.get(`/customers/${t.customer_id}`).then((p) => setContacts(p.contacts.filter((c) => c.active))).catch(() => setContacts([]));
  }, []);
  useEffect(() => {
    if (preset?.task_id) pick(preset.task_id);
    else api.get('/tasks', { owner: 'me', bucket: 'open', limit: 40 }).then((r) => setMine(r.rows.filter((t) => ['overdue', 'today'].includes(t.due_state)))).catch(() => setMine([]));
  }, [preset, pick]);
  const load = useCallback(async (q) => (await api.get('/tasks', { q, bucket: 'open', limit: 30 })).rows.map((t) => ({ value: t.id, label: `${t.purpose} — ${t.customer_name || t.order_code || ''}`, sub: `${t.owner_name} · due ${date(t.due_date)}` })), []);
  if (task) {
    return (
      <div className="stack">
        <div className="card soft"><div className="card-body stack-xs">
          <div className="row between"><strong>{task.customer_name || '—'}</strong><DueBadge task={task} /></div>
          <div>{task.purpose}</div>
          <div className="small muted">{task.enquiry_code || task.order_code || ''}{task.product ? ` · ${task.product}` : ''} · owner {task.owner_name}{task.last_outcome_label ? ` · last result: ${task.last_outcome_label}` : ''}</div>
        </div></div>
        {task.purpose_code === 'customer_update' ? (
          <Notice tone="info" action={<Button size="sm" to={`/orders/${task.order_id}`} onClick={close}>Open order</Button>}>Customer updates are recorded against the order date revision, so “informed” links to the exact change.</Notice>
        ) : (
          <FollowupForm task={task} contacts={contacts} onSaved={() => { toast.success('Outcome recorded'); close(); window.dispatchEvent(new Event('data:changed')); }} />
        )}
        <Button size="sm" variant="ghost" onClick={() => setTask(null)}>Choose a different follow-up</Button>
      </div>
    );
  }
  return (
    <div className="stack">
      <Field label="Find a follow-up"><Combobox load={load} onChange={(o) => pick(o.value)} placeholder="Customer, enquiry, order or purpose…" minChars={2} /></Field>
      <div className="strong small">Due for you today or overdue</div>
      {!mine && <Spinner />}
      {mine?.length === 0 && <div className="muted small">Nothing due for you right now.</div>}
      {mine?.map((t) => (
        <button key={t.id} type="button" className="m-card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => pick(t.id)}>
          <div className="row between"><strong>{t.customer_name || t.order_code}</strong><DueBadge task={t} /></div>
          <div className="small">{t.purpose}</div>
        </button>
      ))}
    </div>
  );
}

function UpdateTab({ preset, close }) {
  const toast = useToast();
  const [line, setLine] = useState(null);
  const load = useCallback(async (q) => (await api.get('/order-lines/options', { q })).map((l) => ({ value: l.id, label: `${l.order_code} · ${l.customer_name} · ${l.product}`, sub: `Line ${l.line_no} · promised ${date(l.original_commitment_date)} · ${l.phase_label}`, row: l })), []);
  useEffect(() => {
    if (preset?.line_id) api.get('/order-lines/options', { q: preset.order_code || '' }).then((rows) => setLine(rows.find((r) => r.id === preset.line_id) || null));
  }, [preset]);
  return (
    <div className="stack">
      <Field label="Order / line"><Combobox load={load} value={line?.id} label={line ? `${line.order_code} · ${line.product}` : ''} onChange={(o) => setLine(o.row)} placeholder="Order number, customer, PO or product…" minChars={1} /></Field>
      {line && (
        <>
          <div className="row wrap"><LineStateBadge state={line.status.state} daysLate={line.status.daysLate} /><span className="small muted">{line.customer_name} · promised {date(line.original_commitment_date)}</span></div>
          <ProductionUpdateForm line={line} compact onSaved={(res) => {
            if (res.unchanged) toast.info(res.message);
            else toast.success('Update saved');
            close();
            window.dispatchEvent(new Event('data:changed'));
          }} />
        </>
      )}
    </div>
  );
}
