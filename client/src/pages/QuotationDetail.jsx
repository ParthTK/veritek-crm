// One quotation: the customer-facing document for any revision, internal pricing checks (margin, approval),
// the approval trail, issue evidence, outcome, conversion to an order, revision comparison and history.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ROLES, PRICE_LISTS, QUOTE_STATUSES, labelOf } from '@shared/constants.js';
import { api, openFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, dateTime, number, pct, qty as fmtQty, money } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Facts, Field, Logo, Modal, Notice, PageHeader, SaveStatus, Select, Spinner, Tabs, Textarea, useConfirm, useToast, EmptyState,
} from '../components/ui.jsx';
import { ApprovalBadge, Money, QuoteBadge, StageBadge, useMeta } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';
import { ConvertForm, IssueForm, OutcomeForm } from './EnquiryDetail.jsx';

const HISTORY = {
  approval_requested: 'Sent for internal approval', approved: 'Approved', approval_rejected: 'Approval rejected', accepted: 'Customer accepted', rejected: 'Customer rejected',
  viewed: 'Customer opened the link', revision_requested: 'Customer asked for a revision',
};

export default function QuotationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: q, error, reload } = useApi(`/quotations/${id}`);
  const [tab, setTab] = useState('document');
  const [revNo, setRevNo] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!q) return <Spinner />;
  const cur = q.current;
  const shown = q.revisions.find((r) => r.revision_no === revNo) || cur;
  const edit = can('quotes.edit');
  const requireBeforeIssue = meta.settings.approvals?.requireBeforeIssue;
  const blockedIssue = cur.status === 'draft' && cur.approval_role && requireBeforeIssue && cur.approval_status !== 'approved';
  const issuedRev = q.revisions.find((r) => ['issued', 'accepted', 'rejected'].includes(r.status));
  const portalUrl = issuedRev ? `${window.location.origin}/portal/quote/${q.public_token}` : null;
  const convertible = q.revisions.find((r) => ['issued', 'accepted'].includes(r.status) && r.conversion?.some((l) => l.remaining_qty === null || l.remaining_qty > 0));
  const enquiry = { id: q.enquiry_id, owner_id: q.owner_id, customer_name: q.customer_name, contact_name: q.contact_name };

  const done = (msg) => {
    toast.success(msg);
    setModal(null);
    reload();
    window.dispatchEvent(new Event('data:changed'));
  };
  const act = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      done(msg);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="no-print">
        <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: q.number }]}
          eyebrow={<>{q.number} · revision {cur.revision_no} <QuoteBadge status={cur.status} size="sm" /> {cur.status === 'draft' && <ApprovalBadge status={cur.approval_status} size="sm" />} {cur.expired && <Badge size="sm" tone="amber">Validity expired</Badge>}</>}
          title={<><Link to={`/customers/${q.customer_id}`}>{q.customer_name}</Link>{q.subject ? ` — ${q.subject}` : ''}</>}
          subtitle={<>Owner {q.owner_name || '—'} · {labelOf(PRICE_LISTS, cur.price_list || q.price_list)} · {cur.currency}{q.enquiry_id && <> · enquiry <Link to={`/enquiries/${q.enquiry_id}`}>{q.enquiry_code}</Link> <StageBadge stage={q.enquiry_stage} size="sm" /></>}</>}
          actions={<>
            <Button icon="printer" onClick={() => { setTab('document'); setTimeout(() => window.print(), 50); }}>Print / PDF</Button>
            {portalUrl && <Button icon="link" onClick={async () => { try { await navigator.clipboard.writeText(portalUrl); toast.success('Customer link copied — the customer sees the latest issued revision only'); } catch { window.prompt('Copy the customer link', portalUrl); } }}>Copy customer link</Button>}
            {edit && <Button icon="copy" loading={busy} onClick={async () => {
              if (!(await confirm({ title: 'Duplicate quotation?', message: 'A new draft quotation (with its own enquiry) is created for the same customer, with catalogue items re-priced at today’s price list.', confirmLabel: 'Duplicate' }))) return;
              setBusy(true);
              try {
                const r = await api.post('/quotations/duplicate', { quotation_id: q.id });
                toast.success('Duplicate created');
                navigate(`/quotations/${r.quotation_id}/edit`);
              } catch (e) {
                toast.error(e.message);
              } finally {
                setBusy(false);
              }
            }}>Duplicate</Button>}
          </>} />
        <NextStep q={q} cur={cur} edit={edit} can={can} busy={busy} blockedIssue={blockedIssue} convertible={convertible} setModal={setModal} act={act} />
      </div>

      <div className="no-print">
        <Tabs value={tab} onChange={setTab} tabs={[
          { key: 'document', label: 'Quotation' },
          { key: 'revisions', label: 'Revisions', count: q.revisions.length },
          { key: 'approvals', label: 'Approvals', count: q.approvals.length || null },
          { key: 'orders', label: 'Orders & conversion', count: q.orders.length || null },
          { key: 'history', label: 'History' },
        ]} />
      </div>

      {tab === 'document' && (
        <div className="split wide">
          <div className="stack">
            {q.revisions.length > 1 && (
              <div className="row no-print"><span className="small muted">Showing</span>
                <Select value={String(shown.revision_no)} onChange={(e) => setRevNo(Number(e.target.value))} options={q.revisions.map((r) => ({ value: String(r.revision_no), label: `Revision ${r.revision_no} — ${labelOf(QUOTE_STATUSES, r.status)}` }))} style={{ width: 'auto' }} />
              </div>
            )}
            <QuoteDocument q={q} r={shown} company={meta.settings.company} />
          </div>
          <div className="stack sticky-side no-print">
            <InternalPanel q={q} r={shown} />
            <Card title="Issue & response">
              <Facts items={[
                ['Status', <QuoteBadge status={shown.status} />],
                ['Created', `${dateTime(shown.created_at)}${shown.created_by_name ? ` by ${shown.created_by_name}` : ''}`],
                ['Sent', shown.sent_at ? `${dateTime(shown.sent_at)} · ${shown.channel_label || shown.sent_channel}${shown.issued_by_name ? ` · ${shown.issued_by_name}` : ''}` : 'Not sent'],
                ['Valid until', shown.validity_date ? <span className={shown.expired ? 'danger-text strong' : ''}>{date(shown.validity_date)}{shown.expired ? ' (expired)' : ''}</span> : null],
                ['Opened by customer', shown.viewed_at ? dateTime(shown.viewed_at) : shown.status === 'issued' ? 'Not yet' : null],
                ['Customer response', shown.customer_response],
                ['Decided', shown.decided_at ? dateTime(shown.decided_at) : null],
                ['Acceptance', shown.acceptance_type ? `${shown.acceptance_type.toUpperCase()}${shown.acceptance_note ? ` — ${shown.acceptance_note}` : ''}` : null],
                ['Rejection', shown.rejection_reason ? `${shown.rejection_reason}${shown.decision_note ? ` — ${shown.decision_note}` : ''}` : null],
                ['Change note', shown.change_note],
              ]} />
              {q.documents.filter((d) => d.revision_no === shown.revision_no).map((d) => (
                <button key={d.id} type="button" className="btn link mt-8" onClick={() => openFile(d.id).catch((e) => toast.error(e.message))}><Icon name="paperclip" size={14} /> {d.original_name}</button>
              ))}
            </Card>
          </div>
        </div>
      )}
      {tab === 'revisions' && <Revisions q={q} onShow={(n) => { setRevNo(n); setTab('document'); }} />}
      {tab === 'approvals' && (
        <Card title="Approval trail" flush>
          {!q.approvals.length && <EmptyState icon="shield" title="No approvals requested" message="Quotations within the discount and margin policy need no approval." />}
          {q.approvals.map((a) => (
            <div key={a.id} className="alert-row">
              <span className="grow">
                <strong>Revision {a.revision_no}</strong> · needs {labelOf(ROLES, a.required_role)} <Badge size="sm" tone={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : a.status === 'pending' ? 'amber' : 'slate'}>{a.status}</Badge>
                <div className="small secondary">{a.reasons.join(' · ')}</div>
                {a.comments && <div className="small">“{a.comments}”</div>}
              </span>
              <span className="tiny muted">asked by {a.requested_by_name} {dateTime(a.requested_at)}{a.decided_at ? ` · ${a.status} by ${a.decided_by_name || '—'} ${dateTime(a.decided_at)}` : ''}</span>
            </div>
          ))}
        </Card>
      )}
      {tab === 'orders' && (
        <div className="stack">
          <Card title="Orders from this quotation" flush>
            {!q.orders.length && <EmptyState icon="box" title="Not converted yet" message="Convert the accepted revision when the purchase order arrives." />}
            {q.orders.map((o) => (
              <Link key={o.id} to={`/orders/${o.id}`} className="alert-row">
                <strong>{o.code}</strong><span className="grow small">from revision {o.revision_no} · received {date(o.received_date)}</span><Badge size="sm" tone={o.status === 'confirmed' ? 'blue' : 'slate'}>{o.status}</Badge>
              </Link>
            ))}
          </Card>
          {q.revisions.filter((r) => r.conversion).map((r) => (
            <Card key={r.id} title={`Revision ${r.revision_no}: quoted vs ordered`} flush>
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Item</th><th className="num">Quoted</th><th className="num">Ordered</th><th className="num">Not ordered</th></tr></thead>
                  <tbody>{r.conversion.map((l) => (
                    <tr key={l.index}><td>{l.product_code && <strong>{l.product_code} </strong>}{l.description}</td><td className="num">{fmtQty(l.qty, l.unit)}</td><td className="num">{l.converted_qty ? fmtQty(l.converted_qty) : '—'}</td>
                      <td className="num">{l.remaining_qty === null ? 'Unknown' : l.remaining_qty > 0 ? <strong>{fmtQty(l.remaining_qty)}</strong> : '—'}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
      {tab === 'history' && (
        <Card title="History" flush>
          {!q.history.length && <EmptyState title="Nothing recorded yet" />}
          {q.history.map((h) => (
            <div key={h.id} className="alert-row">
              <span className="grow"><strong>{HISTORY[h.kind] || h.kind.replace(/_/g, ' ')}</strong>{h.data?.revision ? ` · revision ${h.data.revision}` : ''}{h.data?.via ? ` · via ${h.data.via}` : ''}{h.note && <div className="small secondary">{h.note}</div>}</span>
              <span className="tiny muted">{h.actor_name || 'System'} · {dateTime(h.occurred_at || h.created_at)}</span>
            </div>
          ))}
        </Card>
      )}

      <Modal open={modal?.type === 'issue'} onClose={() => setModal(null)} title={`Issue ${q.number} rev ${cur.revision_no}`} subtitle="Record that it was actually sent to the customer">
        {modal?.type === 'issue' && <IssueForm r={cur} enquiry={enquiry} onSaved={() => done('Quotation issued — follow-up scheduled')} />}
      </Modal>
      <Modal open={modal?.type === 'outcome'} onClose={() => setModal(null)} title={modal?.outcome === 'accepted' ? 'Customer accepted' : modal?.outcome === 'rejected' ? 'Customer rejected' : 'Awaiting decision'}>
        {modal?.type === 'outcome' && <OutcomeForm r={modal.r} outcome={modal.outcome} hasTask onSaved={() => done('Outcome recorded')} />}
      </Modal>
      <Modal open={modal?.type === 'convert'} size="xl" onClose={() => setModal(null)} title={`Convert ${q.number} rev ${modal?.r?.revision_no} to an order`} subtitle="Review what is copied; add only the order details that are missing.">
        {modal?.type === 'convert' && <ConvertForm r={modal.r} enquiry={enquiry} onDone={() => { reload(); window.dispatchEvent(new Event('data:changed')); }} />}
      </Modal>
      <Modal open={modal?.type === 'decide'} size="sm" onClose={() => setModal(null)} title={modal?.decision === 'approved' ? 'Approve quotation' : 'Reject approval'}>
        {modal?.type === 'decide' && <DecideForm approvalId={q.pending_approval_id} decision={modal.decision} onSaved={() => done(modal.decision === 'approved' ? 'Approved — the owner can issue it now' : 'Rejected — the owner has been told')} />}
      </Modal>
    </div>
  );
}

/** The one or two things to do next, depending on where the current revision stands. */
function NextStep({ q, cur, edit, can, busy, blockedIssue, convertible, setModal, act }) {
  const toast = useToast();
  if (cur.status === 'draft') {
    return (
      <div className="card" style={{ padding: 14 }}>
        <div className="row wrap between">
          <div className="grow">
            <div className="strong">Draft revision {cur.revision_no} — not sent to the customer</div>
            <div className="small muted">
              {!cur.approval_role ? 'Within the discount and margin policy.' : cur.approval_status === 'pending' ? `Waiting for ${labelOf(ROLES, cur.approval_role)} (or above) to approve.` : cur.approval_status === 'approved' ? `Approved by ${cur.approved_by_name || '—'} ${dateTime(cur.approved_at)}.` : cur.approval_status === 'rejected' ? 'The approver rejected these terms — revise the prices and ask again.' : `Needs approval by ${labelOf(ROLES, cur.approval_role)} or above: ${cur.approval_reasons.join('; ')}.`}
            </div>
          </div>
          <div className="row wrap">
            {edit && cur.approval_status !== 'pending' && <Button icon="edit" to={`/quotations/${q.id}/edit`}>Edit draft</Button>}
            {edit && cur.approval_role && ['required', 'rejected'].includes(cur.approval_status) && <Button variant="primary" icon="send" loading={busy} onClick={() => act(() => api.post(`/quote-revisions/${cur.id}/submit`), 'Sent for approval')}>Ask for approval</Button>}
            {edit && cur.approval_status === 'pending' && <Button loading={busy} onClick={() => act(() => api.post(`/quote-revisions/${cur.id}/withdraw`), 'Withdrawn from approval — you can edit the draft')}>Withdraw from approval</Button>}
            {q.can_decide && <><Button variant="primary" icon="check" onClick={() => setModal({ type: 'decide', decision: 'approved' })}>Approve</Button><Button variant="danger-ghost" onClick={() => setModal({ type: 'decide', decision: 'rejected' })}>Reject</Button></>}
            {edit && <Button variant="cta" icon="arrowRight" disabled={blockedIssue} title={blockedIssue ? 'Approve it before it is issued' : undefined} onClick={() => setModal({ type: 'issue' })}>Record as sent</Button>}
          </div>
        </div>
        {blockedIssue && cur.approval_status !== 'pending' && <div className="tiny muted mt-8">Issuing is blocked until the revision is approved (policy setting).</div>}
      </div>
    );
  }
  const hasDraft = q.revisions.some((r) => r.status === 'draft');
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row wrap between">
        <div className="grow">
          <div className="strong">{cur.status === 'issued' ? `Issued ${dateTime(cur.sent_at)} — awaiting the customer’s decision` : cur.status === 'accepted' ? `Accepted ${dateTime(cur.decided_at)}${q.orders.length ? '' : ' — convert it to an order'}` : cur.status === 'rejected' ? `Rejected ${dateTime(cur.decided_at)}` : labelOf(QUOTE_STATUSES, cur.status)}</div>
          {cur.customer_response && <div className="small">{cur.customer_response}</div>}
          {cur.expired && <div className="small warning-text">Validity expired {date(cur.validity_date)} — an expired quotation needs the coordinator or management to confirm the terms before conversion.</div>}
        </div>
        <div className="row wrap">
          {edit && cur.status === 'issued' && <>
            <Button variant="primary" onClick={() => setModal({ type: 'outcome', r: cur, outcome: 'accepted' })}>Accepted</Button>
            <Button onClick={() => setModal({ type: 'outcome', r: cur, outcome: 'awaiting' })}>Awaiting decision</Button>
            <Button variant="danger-ghost" onClick={() => setModal({ type: 'outcome', r: cur, outcome: 'rejected' })}>Rejected</Button>
          </>}
          {convertible && can('orders.edit') && <Button variant="cta" icon="box" onClick={() => setModal({ type: 'convert', r: convertible })}>Convert to order</Button>}
          {edit && !hasDraft && cur.status !== 'accepted' && <Button icon="plus" loading={busy} onClick={() => act(() => api.post(`/quotations/${q.id}/revisions`, { change_note: 'Revised offer' }), 'New draft revision — earlier revisions stay as issued')}>New revision</Button>}
          {edit && cur.status === 'accepted' && q.enquiry_id && <Button variant="ghost" onClick={() => toast.info('A fresh requirement from this customer becomes a new linked enquiry — open the enquiry to create it.')}>New requirement?</Button>}
        </div>
      </div>
    </div>
  );
}

/** Customer-facing layout: what the customer received (or will receive) for this revision. */
export function QuoteDocument({ q, r, company }) {
  const showValues = r.lines.some((l) => l.unit_price_minor !== undefined);
  return (
    <div className="doc">
      <div className="row between top wrap" style={{ gap: 16 }}>
        <div>
          <Logo plate height={50} className="doc-logo" />
          {company.address && <div className="tiny muted" style={{ maxWidth: 320 }}>{company.address}</div>}
          <div className="tiny muted">{[company.phone, company.email, company.website].filter(Boolean).join(' · ')}</div>
          {company.gstin && <div className="tiny muted">GSTIN {company.gstin}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <h2 style={{ fontSize: 22 }}>Quotation</h2>
          <div className="strong mono">{q.number} / R{r.revision_no}</div>
          <div className="small">Date {date(r.sent_at || r.created_at, { year: true })}</div>
          {r.validity_date && <div className="small">Valid until {date(r.validity_date, { year: true })}</div>}
          {r.status === 'draft' && <Badge tone="amber" size="sm">Draft — not issued</Badge>}
        </div>
      </div>
      <div className="divider" />
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div>
          <div className="tiny muted">To</div>
          <div className="strong">{q.customer_name}</div>
          {q.billing_address && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{q.billing_address}</div>}
          {!q.billing_address && <div className="small">{[q.city, q.state].filter(Boolean).join(', ')}</div>}
          {q.customer_gstin && <div className="tiny muted">GSTIN {q.customer_gstin}</div>}
          {q.contact_name && <div className="small mt-8">Attn: {q.contact_name}{q.contact_designation ? `, ${q.contact_designation}` : ''}</div>}
        </div>
        <div>
          {q.subject && <><div className="tiny muted">Subject</div><div className="strong">{q.subject}</div></>}
          <div className="tiny muted mt-8">Your contact</div>
          <div className="small">{q.owner_name}{q.owner_phone ? ` · ${q.owner_phone}` : ''}{q.owner_email ? ` · ${q.owner_email}` : ''}</div>
        </div>
      </div>
      <div className="table-wrap mt-16">
        <table>
          <thead>
            <tr><th>#</th><th>Item</th><th>HSN</th><th className="num">Qty</th>{showValues && <><th className="num">Unit price</th><th className="num">Disc.</th><th className="num">GST</th><th className="num">Amount</th></>}</tr>
          </thead>
          <tbody>
            {r.lines.map((l, i) => (
              <tr key={l.index ?? i}>
                <td>{i + 1}</td>
                <td>{l.product_code && <strong>{l.product_code} </strong>}{l.description}{l.spec && <div className="tiny muted">{l.spec}</div>}{l.lead_time_days !== null && l.lead_time_days !== undefined && <div className="tiny muted">Lead time ~{l.lead_time_days} days</div>}</td>
                <td className="small">{l.hsn || '—'}</td>
                <td className="num">{l.qty === null ? 'TBC' : fmtQty(l.qty, l.unit)}</td>
                {showValues && <>
                  <td className="num"><Money minor={l.unit_price_minor} currency={r.currency} /></td>
                  <td className="num">{l.discount_pct ? `${number(l.discount_pct, 2)}%` : '—'}</td>
                  <td className="num">{number(l.gst_rate, 2)}%</td>
                  <td className="num"><Money minor={l.line_total_minor} currency={r.currency} /></td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showValues && r.total_minor !== undefined && (
        <div className="row end mt-12">
          <div className="totals" style={{ minWidth: 300 }}>
            <span className="muted">Sub-total</span><span className="num"><Money minor={r.subtotal_minor} currency={r.currency} /></span>
            {r.discount_total_minor > 0 && <><span className="muted">Discount</span><span className="num">−<Money minor={r.discount_total_minor} currency={r.currency} /></span></>}
            {r.freight_minor > 0 && <><span className="muted">Freight</span><span className="num"><Money minor={r.freight_minor} currency={r.currency} /></span></>}
            {r.installation_minor > 0 && <><span className="muted">Installation</span><span className="num"><Money minor={r.installation_minor} currency={r.currency} /></span></>}
            <span>Total before tax</span><span className="num strong"><Money minor={r.total_minor} currency={r.currency} /></span>
            <span className="muted">GST</span><span className="num"><Money minor={r.tax_total_minor} currency={r.currency} /></span>
            <span className="grand">Grand total ({r.currency})</span><span className="grand num"><Money minor={r.grand_total_minor} currency={r.currency} /></span>
          </div>
        </div>
      )}
      <div className="divider" />
      <Facts items={[
        ['Payment terms', r.payment_terms],
        ['Delivery', r.delivery_terms ? `${r.delivery_terms} (indicative)` : null],
        ['Warranty', r.warranty_terms],
        ['Notes', r.notes],
      ]} />
      <div className="tiny muted mt-12">Prices are exclusive of GST unless stated. Delivery periods are estimates and are confirmed on order acceptance.</div>
    </div>
  );
}

/** Margin, cost and approval reasons — never part of the customer document. */
function InternalPanel({ q, r }) {
  const { can } = useAuth();
  const meta = useMeta();
  if (!can('values.view')) return null;
  const minMargin = meta.settings.approvals?.minMarginPct;
  return (
    <Card title="Internal pricing check">
      <Facts items={[
        ['Price list', labelOf(PRICE_LISTS, r.price_list || q.price_list)],
        r.list_total_minor !== undefined && ['At list price', <Money minor={r.list_total_minor} currency={r.currency} />],
        ['Overall discount', pct(r.discount_pct)],
        ['Largest line discount', pct(r.max_line_discount_pct)],
        can('margin.view') && ['Cost', r.cost_total_minor === null ? 'Unknown' : <Money minor={r.cost_total_minor} currency={r.currency} />],
        can('margin.view') && ['Margin', r.margin_pct === null || r.margin_pct === undefined ? 'Unknown' : <span className={minMargin !== undefined && r.margin_pct < minMargin ? 'danger-text strong' : 'strong'}>{pct(r.margin_pct)}</span>],
        can('margin.view') && r.below_min_price ? ['Minimum price', <span className="danger-text">Below on one or more lines</span>] : null,
        ['Approval', r.approval_role ? <span><ApprovalBadge status={r.approval_status} size="sm" /> {labelOf(ROLES, r.approval_role)}</span> : 'Within policy'],
      ]} />
      {r.approval_reasons?.length > 0 && <ul className="small secondary" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{r.approval_reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      {r.approved_by_name && <div className="small mt-8">Approved by {r.approved_by_name} {dateTime(r.approved_at)}</div>}
    </Card>
  );
}

function Revisions({ q, onShow }) {
  const [a, setA] = useState(q.revisions[1]?.revision_no ?? q.revisions[0].revision_no);
  const [b, setB] = useState(q.revisions[0].revision_no);
  const ra = q.revisions.find((r) => r.revision_no === Number(a));
  const rb = q.revisions.find((r) => r.revision_no === Number(b));
  const diff = useMemo(() => diffRevisions(ra, rb), [ra, rb]);
  const opts = q.revisions.map((r) => ({ value: String(r.revision_no), label: `Revision ${r.revision_no}` }));
  return (
    <div className="stack">
      <Card title="All revisions" sub="Issued revisions never change; each change is a new revision" flush>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Revision</th><th>Status</th><th className="num">Total before tax</th><th className="num">Discount</th><th>Sent</th><th>Valid until</th><th>Change note</th><th /></tr></thead>
            <tbody>{q.revisions.map((r) => (
              <tr key={r.id}>
                <td><strong>R{r.revision_no}</strong><div className="sub">{dateTime(r.created_at)}</div></td>
                <td><QuoteBadge status={r.status} size="sm" /> {r.status === 'draft' && <ApprovalBadge status={r.approval_status} size="sm" />}</td>
                <td className="num"><Money minor={r.total_minor} currency={r.currency} /></td>
                <td className="num">{pct(r.discount_pct)}</td>
                <td>{r.sent_at ? dateTime(r.sent_at) : <span className="muted">—</span>}</td>
                <td>{date(r.validity_date)}</td>
                <td className="small">{r.change_note || '—'}</td>
                <td><Button size="xs" onClick={() => onShow(r.revision_no)}>View</Button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
      {q.revisions.length > 1 && (
        <Card title="Compare revisions" actions={<div className="row"><Select value={String(a)} onChange={(e) => setA(e.target.value)} options={opts} aria-label="From revision" /><Icon name="arrowRight" size={14} /><Select value={String(b)} onChange={(e) => setB(e.target.value)} options={opts} aria-label="To revision" /></div>}>
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Discount</th><th className="num">Line value</th></tr></thead>
              <tbody>{diff.rows.map((d) => (
                <tr key={d.key} className={d.kind === 'added' ? 'diff-add' : d.kind === 'removed' ? 'diff-del' : ''}>
                  <td>{d.label}{d.kind !== 'same' && d.kind !== 'changed' && <div className="sub">{d.kind === 'added' ? `Added in R${b}` : `Removed in R${b}`}</div>}</td>
                  {['qty', 'unit_price_minor', 'discount_pct', 'line_total_minor'].map((k) => (
                    <td key={k} className={`num ${d.changed.includes(k) ? 'diff-chg' : ''}`}>
                      {d.changed.includes(k) && d.from ? <><span className="muted" style={{ textDecoration: 'line-through' }}>{fmtField(k, d.from[k], ra.currency)}</span> → </> : null}
                      {fmtField(k, (d.to || d.from)[k], rb.currency)}
                    </td>
                  ))}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="row wrap mt-12 small">
            <span>Total before tax: <strong>{money(ra.total_minor, ra.currency)}</strong> → <strong>{money(rb.total_minor, rb.currency)}</strong></span>
            <span>· Discount {pct(ra.discount_pct)} → {pct(rb.discount_pct)}</span>
            {['payment_terms', 'delivery_terms', 'warranty_terms', 'validity_date'].filter((k) => (ra[k] || '') !== (rb[k] || '')).map((k) => <span key={k}>· {k.replace(/_/g, ' ')} changed</span>)}
          </div>
        </Card>
      )}
    </div>
  );
}

const fmtField = (k, v, currency) => {
  if (v === null || v === undefined) return '—';
  if (k === 'qty') return fmtQty(v);
  if (k === 'discount_pct') return `${number(v, 2)}%`;
  return money(v, currency);
};

function diffRevisions(a, b) {
  if (!a || !b) return { rows: [] };
  const key = (l) => `${l.product_id || 'c'}:${l.product_id ? JSON.stringify((l.config?.options || []).map((o) => o.id).sort()) : l.description}`;
  const fromMap = new Map(a.lines.map((l) => [key(l), l]));
  const rows = [];
  for (const l of b.lines) {
    const k = key(l);
    const prev = fromMap.get(k);
    fromMap.delete(k);
    const changed = prev ? ['qty', 'unit_price_minor', 'discount_pct', 'line_total_minor'].filter((f) => (prev[f] ?? null) !== (l[f] ?? null)) : [];
    rows.push({ key: k, label: `${l.product_code ? `${l.product_code} ` : ''}${l.description}`, from: prev, to: l, changed, kind: !prev ? 'added' : changed.length ? 'changed' : 'same' });
  }
  for (const [k, l] of fromMap) rows.push({ key: k, label: `${l.product_code ? `${l.product_code} ` : ''}${l.description}`, from: l, to: null, changed: [], kind: 'removed' });
  return { rows };
}

function DecideForm({ approvalId, decision, onSaved }) {
  const save = useSave();
  const [comments, setComments] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/approvals/${approvalId}/decide`, { decision, comments }); onSaved(); }); }}>
      {decision === 'approved' ? <Notice tone="info">Approving lets the owner issue these exact prices. Any later change to the draft needs a fresh approval.</Notice> : <Notice tone="warn">The owner is told the reason and revises the offer.</Notice>}
      <Field label={decision === 'approved' ? 'Comment' : 'Reason for rejecting'} required={decision === 'rejected'} optional={decision === 'approved'} error={save.fields.comments}>
        <Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={500} />
      </Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={decision === 'approved' ? 'primary' : 'danger'} loading={save.saving}>{decision === 'approved' ? 'Approve' : 'Reject'}</Button></div>
    </form>
  );
}
