// One quotation: the document itself, where it stands, and the next step.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ROLES, QUOTE_STATUSES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, useSave } from '../lib/hooks.js';
import { date, number, qty as fmtQty } from '../lib/format.js';
import {
  Badge, Button, Card, ErrorState, Facts, Field, Logo, Modal, Notice, PageHeader, SaveStatus, Select, Spinner, Textarea, useToast,
} from '../components/ui.jsx';
import { Money, QuoteBadge, StageBadge, useMeta, JourneyCard } from '../components/domain.jsx';
import { ConvertForm, IssueForm, OutcomeForm } from '../components/QuoteForms.jsx';

export default function QuotationDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const { data: q, error, reload } = useApi(`/quotations/${id}`);
  const [revNo, setRevNo] = useState(null);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!q) return <Spinner />;
  const cur = q.current;
  const shown = q.revisions.find((r) => r.revision_no === revNo) || cur;
  const edit = can('quotes.edit');
  // Internal approval only applies when it is switched on in the settings.
  const approvals = meta.settings.approvals?.enabled && cur.status === 'draft' && cur.approval_role;
  const blocked = approvals && meta.settings.approvals.requireBeforeIssue && cur.approval_status !== 'approved';
  const convertible = q.revisions.find((r) => r.status === 'accepted' && r.conversion?.some((l) => l.remaining_qty === null || l.remaining_qty > 0));
  const hasDraft = q.revisions.some((r) => r.status === 'draft');
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
      <div className="no-print stack">
        <PageHeader crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: q.number }]}
          eyebrow={<>{q.number}{q.revisions.length > 1 ? ` · version ${cur.revision_no}` : ''} <QuoteBadge status={cur.status} size="sm" />{cur.expired && <> <Badge size="sm" tone="amber">Expired</Badge></>}</>}
          title={<Link to={`/customers/${q.customer_id}`}>{q.customer_name}</Link>}
          subtitle={<>Assigned to {q.owner_name || '—'}{q.enquiry_id && <> · <Link to={`/enquiries/${q.enquiry_id}`}>{q.enquiry_code}</Link> <StageBadge stage={q.enquiry_stage} size="sm" /></>}</>}
          actions={<>
            <Button icon="printer" onClick={() => window.print()}>Print / PDF</Button>
            {edit && cur.status === 'draft' && cur.approval_status !== 'pending' && <Button icon="edit" to={`/quotations/${q.id}/edit`}>Edit</Button>}
            {edit && cur.status === 'draft' && <Button variant="cta" icon="arrowRight" disabled={blocked} onClick={() => setModal({ type: 'issue' })}>Mark as sent</Button>}
            {edit && cur.status === 'issued' && <>
              <Button onClick={() => setModal({ type: 'outcome', outcome: 'rejected' })}>Rejected</Button>
              <Button variant="cta" icon="check" onClick={() => setModal({ type: 'outcome', outcome: 'accepted' })}>Approved</Button>
            </>}
            {convertible && can('orders.edit') && <Button variant="cta" icon="box" onClick={() => setModal({ type: 'convert', r: convertible })}>Create order</Button>}
            {edit && !hasDraft && ['issued', 'rejected'].includes(cur.status) && <Button icon="plus" loading={busy} onClick={() => act(() => api.post(`/quotations/${q.id}/revisions`, { change_note: 'Revised offer' }), 'New version created')}>New version</Button>}
          </>} />
        {approvals && (
          <Notice tone="warn" title={cur.approval_status === 'pending' ? `Waiting for ${labelOf(ROLES, cur.approval_role)} to approve` : cur.approval_status === 'approved' ? 'Approved internally' : `Needs approval by ${labelOf(ROLES, cur.approval_role)}`}
            action={<div className="row">
              {edit && ['required', 'rejected'].includes(cur.approval_status) && <Button size="sm" variant="primary" loading={busy} onClick={() => act(() => api.post(`/quote-revisions/${cur.id}/submit`), 'Sent for approval')}>Ask for approval</Button>}
              {edit && cur.approval_status === 'pending' && <Button size="sm" loading={busy} onClick={() => act(() => api.post(`/quote-revisions/${cur.id}/withdraw`), 'Withdrawn')}>Withdraw</Button>}
              {q.can_decide && <><Button size="sm" variant="primary" onClick={() => setModal({ type: 'decide', decision: 'approved' })}>Approve</Button><Button size="sm" variant="danger-ghost" onClick={() => setModal({ type: 'decide', decision: 'rejected' })}>Reject</Button></>}
            </div>}>{cur.approval_reasons?.join('; ')}</Notice>
        )}
        <JourneyCard quotationId={q.id} version={`${cur.id}-${cur.status}`} />
      </div>
      <div className="split wide">
        <div className="stack">
          {q.revisions.length > 1 && (
            <div className="row no-print"><span className="small muted">Showing</span>
              <Select value={String(shown.revision_no)} onChange={(e) => setRevNo(Number(e.target.value))} options={q.revisions.map((r) => ({ value: String(r.revision_no), label: `Version ${r.revision_no} — ${labelOf(QUOTE_STATUSES, r.status)}` }))} style={{ width: 'auto' }} />
            </div>
          )}
          <QuoteDocument q={q} r={shown} company={meta.settings.company} />
        </div>
        <div className="stack sticky-side no-print">
          <Card title="Status">
            <Facts items={[
              ['Status', <QuoteBadge status={shown.status} />],
              ['Sent', shown.sent_at ? `${date(shown.sent_at)} · ${shown.channel_label || shown.sent_channel}` : 'Not yet'],
              ['Valid until', shown.validity_date ? <span className={shown.expired ? 'danger-text strong' : ''}>{date(shown.validity_date)}</span> : null],
              ['Decided', shown.decided_at ? date(shown.decided_at) : null],
              ['Reason', shown.rejection_reason ? `${shown.rejection_reason}${shown.decision_note ? ` — ${shown.decision_note}` : ''}` : null],
              ['Note', shown.acceptance_note],
            ].filter(([, v]) => v !== null && v !== undefined && v !== '')} />
          </Card>
          {q.orders.length > 0 && (
            <Card title="Orders">
              <div className="stack-xs">{q.orders.map((o) => <Link key={o.id} to={`/orders/${o.id}`} className="small strong">{o.code}</Link>)}</div>
            </Card>
          )}
        </div>
      </div>
      <Modal open={modal?.type === 'issue'} size="sm" onClose={() => setModal(null)} title="Mark as sent">
        {modal?.type === 'issue' && <IssueForm r={cur} ownerId={q.owner_id} onSaved={() => done('Marked as sent')} />}
      </Modal>
      <Modal open={modal?.type === 'outcome'} size="sm" onClose={() => setModal(null)} title={modal?.outcome === 'accepted' ? 'Approved by the customer' : 'Rejected by the customer'}>
        {modal?.type === 'outcome' && <OutcomeForm r={cur} outcome={modal.outcome} onSaved={() => done('Saved')} />}
      </Modal>
      <Modal open={modal?.type === 'convert'} size="xl" onClose={() => setModal(null)} title="Create order">
        {modal?.type === 'convert' && <ConvertForm r={modal.r} />}
      </Modal>
      <Modal open={modal?.type === 'decide'} size="sm" onClose={() => setModal(null)} title={modal?.decision === 'approved' ? 'Approve quotation' : 'Reject quotation'}>
        {modal?.type === 'decide' && <DecideForm approvalId={q.pending_approval_id} decision={modal.decision} onSaved={() => done('Saved')} />}
      </Modal>
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
          {r.status === 'draft' && <Badge tone="amber" size="sm">Not sent yet</Badge>}
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
                <td>{l.product_code && <strong>{l.product_code} </strong>}{l.description}{l.spec && <div className="tiny muted">{l.spec}</div>}</td>
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

function DecideForm({ approvalId, decision, onSaved }) {
  const save = useSave();
  const [comments, setComments] = useState('');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); save.run(async () => { await api.post(`/approvals/${approvalId}/decide`, { decision, comments }); onSaved(); }); }}>
      <Field label={decision === 'approved' ? 'Comment' : 'Reason'} required={decision === 'rejected'} optional={decision === 'approved'} error={save.fields.comments}><Textarea rows={2} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={500} /></Field>
      <div className="row between"><SaveStatus save={save} /><Button type="submit" variant={decision === 'approved' ? 'primary' : 'danger'} loading={save.saving}>{decision === 'approved' ? 'Approve' : 'Reject'}</Button></div>
    </form>
  );
}
