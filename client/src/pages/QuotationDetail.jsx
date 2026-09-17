import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QUOTATION_STATUSES, QUOTE_AWAITING, PRIORITIES, ROLES, LOSS_REASONS, WIN_REASONS, COMPETITORS, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inr, inrCompact, number, pct, date, dateTime, relativeDay, daysFromToday, todayStr, addDaysStr } from '../lib/format.js';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, KV, Modal, OptionBadge, PageHeader, Select, Spinner, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { PendingAttachments, useMeta, LogActivityModal } from '../components/domain.jsx';

export default function QuotationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const { can, user } = useAuth();
  const { data: q, error, reload } = useApi(`/quotations/${id}`);
  const [versionNo, setVersionNo] = useState(null);
  const [modal, setModal] = useState(null);
  const [compareWith, setCompareWith] = useState(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!q) return <Spinner />;
  const version = q.versions.find((v) => v.version_no === (versionNo ?? q.current_version)) || q.current;
  const isCurrent = version.version_no === q.current_version;
  const editable = can('quotations.edit');
  const marginVisible = can('margin.view');
  const pendingApproval = q.approvals.find((a) => a.status === 'pending');
  const portalUrl = `${window.location.origin}/portal/quote/${q.public_token}`;
  const awaiting = QUOTE_AWAITING.includes(q.status);

  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      reload();
      setModal(null);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Quotations', to: '/quotations' }, { label: q.number }]}
        title={<span className="row wrap" style={{ gap: 10 }}>{q.number}<OptionBadge list={QUOTATION_STATUSES} value={q.status} />{q.order_number && <Link className="small" to={`/orders/${q.order_id}`}>→ {q.order_number}</Link>}</span>}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Link to={`/customers/${q.customer_id}`}>{q.customer_name}</Link>
          {q.lead_code && <Link className="small" to={`/leads/${q.lead_id}`}>{q.lead_code}</Link>}
          <span className="muted small">{q.subject}</span>
          {q.valid_until && <span className={`small ${awaiting && daysFromToday(q.valid_until) <= 3 ? 'warning-text strong' : 'muted'}`}>Valid until {date(q.valid_until)}{awaiting ? ` (${relativeDay(q.valid_until)})` : ''}</span>}
        </span>}
        actions={(
          <>
            <Button icon="printer" onClick={() => window.print()} className="no-print">Print</Button>
            {q.public_token && <Button icon="link" onClick={() => { navigator.clipboard?.writeText(portalUrl); toast.success('Customer link copied'); }}>Copy link</Button>}
            {editable && q.status === 'draft' && <><Button icon="edit" to={`/quotations/${q.id}/edit`}>Edit</Button><Button variant="primary" icon="send" onClick={() => act(() => api.post(`/quotations/${q.id}/submit`), 'Submitted')}>Submit for approval</Button></>}
            {editable && q.status === 'approval_pending' && <Button onClick={() => act(() => api.post(`/quotations/${q.id}/withdraw`), 'Withdrawn to draft')}>Withdraw</Button>}
            {q.can_decide && pendingApproval && <><Button variant="danger-ghost" onClick={() => setModal({ decide: 'rejected' })}>Reject</Button><Button variant="primary" icon="check" onClick={() => setModal({ decide: 'approved' })}>Approve</Button></>}
            {editable && q.status === 'approved' && <Button variant="primary" icon="send" onClick={() => setModal({ send: true })}>Send to customer</Button>}
            {editable && awaiting && (
              <>
                <Button icon="edit" to={`/quotations/${q.id}/edit`}>Revise</Button>
                <Button icon="send" onClick={() => setModal({ send: true })}>Re-send</Button>
                <Button onClick={() => setModal({ respond: true })}>Record response</Button>
              </>
            )}
            {editable && ['rejected', 'expired'].includes(q.status) && <Button icon="refresh" to={`/quotations/${q.id}/edit`}>Revise &amp; reopen</Button>}
            {can('orders.edit') && ['accepted', ...QUOTE_AWAITING].includes(q.status) && <Button variant="primary" icon="orders" onClick={() => setModal({ convert: true })}>Convert to order</Button>}
            {editable && <Button icon="copy" onClick={async () => { const r = await api.post('/quotations/duplicate', { quotation_id: q.id }).catch((e) => toast.error(e.message)); if (r) navigate(`/quotations/${r.id}/edit`); }}>Duplicate</Button>}
          </>
        )}
      />

      {pendingApproval && (
        <div className="warn-box">
          <div className="row between wrap">
            <span><strong>Awaiting {labelOf(ROLES, pendingApproval.required_role)} approval</strong> — requested by {pendingApproval.requested_by_name} on {date(pendingApproval.requested_at)}: {pendingApproval.reasons.join('; ')}</span>
            {q.can_decide && <span className="row"><Button size="sm" onClick={() => setModal({ decide: 'rejected' })}>Reject</Button><Button size="sm" variant="primary" onClick={() => setModal({ decide: 'approved' })}>Approve</Button></span>}
          </div>
        </div>
      )}
      {q.status === 'rejected' && q.rejection_reason && <div className="error-box">Customer rejected: {q.rejection_reason}</div>}
      {q.customer_feedback && awaiting && <div className="info-box">Customer feedback: {q.customer_feedback}</div>}
      {q.viewed_at && <div className="small muted no-print">Customer opened this quotation on {dateTime(q.viewed_at)}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 330px', alignItems: 'start' }}>
        <div className="stack">
          {q.versions.length > 1 && (
            <div className="row between wrap no-print">
              <Tabs value={String(version.version_no)} onChange={(v) => setVersionNo(Number(v))}
                tabs={q.versions.map((v) => ({ key: String(v.version_no), label: `Version ${v.version_no}${v.version_no === q.current_version ? ' (current)' : ''}` }))} />
              <Button size="sm" icon="compare" onClick={() => setCompareWith(compareWith ? null : q.versions.find((v) => v.version_no !== version.version_no)?.version_no)}>
                {compareWith ? 'Hide comparison' : 'Compare versions'}
              </Button>
            </div>
          )}
          {compareWith && <VersionCompare q={q} a={q.versions.find((v) => v.version_no === compareWith)} b={version} onPick={setCompareWith} marginVisible={marginVisible} />}

          <Card className="doc-card">
            <QuotationDocument q={q} version={version} company={meta.settings.company} />
          </Card>

          {marginVisible && (
            <Card title="Internal margin & approval" className="no-print">
              <div className="grid grid-4">
                <div><div className="muted small">Cost of goods</div><strong>{inr(version.cost_total)}</strong></div>
                <div><div className="muted small">Gross margin</div><strong className={version.margin_pct !== null && version.margin_pct < (meta.settings.approvals?.minMarginPct ?? 22) ? 'danger-text' : 'success-text'}>{version.margin_pct === null ? '—' : pct(version.margin_pct)}</strong></div>
                <div><div className="muted small">Effective discount</div><strong>{pct(version.discount_pct)}</strong></div>
                <div><div className="muted small">Highest line discount</div><strong>{pct(version.max_line_discount_pct)}</strong></div>
              </div>
              {version.approval_role ? (
                <div className="warn-box" style={{ marginTop: 12 }}>Requires {labelOf(ROLES, version.approval_role)} approval: {version.approval_reasons.join('; ')}</div>
              ) : <div className="info-box" style={{ marginTop: 12 }}>Within discount and margin policy.</div>}
            </Card>
          )}

          {q.approvals.length > 0 && (
            <Card title="Approval history" flush className="no-print">
              {q.approvals.map((a) => (
                <div key={a.id} className="action-row">
                  <Badge color={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : a.status === 'pending' ? 'amber' : 'slate'}>{a.status}</Badge>
                  <span className="grow small">
                    v{a.version_no} · {labelOf(ROLES, a.required_role)} · {a.reasons.join('; ')}
                    {a.comments && <div className="tiny muted">“{a.comments}”</div>}
                  </span>
                  <span className="tiny muted nowrap">{a.requested_by_name} → {a.decided_by_name || '—'}<div>{date(a.decided_at || a.requested_at)}</div></span>
                </div>
              ))}
            </Card>
          )}
        </div>

        <div className="stack no-print">
          <Card title="Status & history" flush>
            <div style={{ padding: '10px 14px' }}>
              <KV items={[
                ['Owner', q.owner_name],
                ['Contact', q.contact_name && `${q.contact_name}${q.contact_designation ? ` (${q.contact_designation})` : ''}`],
                ['Created', `${date(q.created_at)} · v${q.current_version}`],
                ['Sent', q.sent_at ? dateTime(q.sent_at) : 'Not sent yet'],
                ['Customer viewed', q.viewed_at ? dateTime(q.viewed_at) : '—'],
                ['Decision', q.decided_at ? dateTime(q.decided_at) : '—'],
              ]} />
            </div>
            <div className="divider" style={{ margin: 0 }} />
            {q.events.slice(0, 12).map((e) => (
              <div key={e.id} className="action-row small">
                <span className="grow">{eventLabel(e)}{e.note && <div className="tiny muted">{e.note}</div>}</span>
                <span className="tiny muted nowrap">{date(e.created_at)}<div>{e.user_name}</div></span>
              </div>
            ))}
          </Card>
          <Card title="Share with customer">
            <div className="stack-sm">
              <div className="small muted">Send this link — opening it marks the quotation as viewed, and the customer can accept or request a revision.</div>
              <Input value={portalUrl} readOnly onFocus={(e) => e.target.select()} />
              <div className="row wrap">
                <Button size="sm" icon="mail" onClick={() => { window.location.href = `mailto:${q.contact_email || ''}?subject=${encodeURIComponent(`Quotation ${q.number} from ${meta.settings.company?.name || 'Veritek'}`)}&body=${encodeURIComponent(`Dear ${q.contact_name || 'Sir/Madam'},\n\nPlease find our quotation ${q.number} here:\n${portalUrl}\n\nRegards,\n${user.name}`)}`; }}>Email</Button>
                <Button size="sm" icon="whatsapp" onClick={() => window.open(`https://wa.me/${(q.contact_whatsapp || q.contact_phone || '').replace(/\D/g, '')}?text=${encodeURIComponent(`Quotation ${q.number}: ${portalUrl}`)}`, '_blank')}>WhatsApp</Button>
                <Button size="sm" icon="eye" onClick={() => window.open(`${portalUrl}?preview=1`, '_blank')}>Preview</Button>
              </div>
            </div>
          </Card>
          {editable && <Card title="Log a conversation"><Button icon="phone" onClick={() => setModal({ log: true })}>Log interaction about this quotation</Button></Card>}
        </div>
      </div>

      {/* modals */}
      <Modal open={Boolean(modal?.decide)} onClose={() => setModal(null)} size="sm"
        title={modal?.decide === 'approved' ? 'Approve quotation' : 'Reject quotation'} subtitle={`${q.number} v${q.current_version} · ${inr(q.current.grand_total)}`}>
        <DecideForm q={q} decision={modal?.decide} approval={pendingApproval} onDone={() => act(() => Promise.resolve(), 'Decision recorded')} />
      </Modal>
      <SendModal open={Boolean(modal?.send)} onClose={() => setModal(null)} q={q} onDone={() => act(() => Promise.resolve(), 'Marked as sent')} />
      <RespondModal open={Boolean(modal?.respond)} onClose={() => setModal(null)} q={q} onDone={() => act(() => Promise.resolve(), 'Response recorded')} />
      <ConvertModal open={Boolean(modal?.convert)} onClose={() => setModal(null)} q={q} onDone={(orderId) => navigate(`/orders/${orderId}`)} />
      <LogActivityModal open={Boolean(modal?.log)} onClose={() => setModal(null)} onSaved={reload} customerId={q.customer_id} quotationId={q.id} leadId={q.lead_id} requireNext={Boolean(q.lead_id)} />
    </div>
  );
}

const EVENT_TEXT = {
  created: 'Drafted', edited: 'Edited', revised: 'Revised', submitted: 'Submitted for approval', auto_approved: 'Auto-approved (within policy)',
  approved: 'Approved internally', approval_rejected: 'Approval rejected', withdrawn: 'Withdrawn', sent: 'Sent to customer', resent: 'Re-sent',
  viewed: 'Viewed by customer', responded: 'Customer responded', revision_requested: 'Revision requested', negotiation: 'In negotiation',
  accepted: 'Accepted by customer', rejected: 'Rejected', expired: 'Expired', converted: 'Converted to order',
};
const eventLabel = (e) => `${EVENT_TEXT[e.event] || e.event}${e.version_no ? ` · v${e.version_no}` : ''}`;

export function QuotationDocument({ q, version, company }) {
  return (
    <div className="doc">
      <div className="row between top" style={{ marginBottom: 18 }}>
        <div>
          <h2 style={{ fontSize: 18 }}>{company?.name}</h2>
          <div className="small muted" style={{ maxWidth: 320 }}>{company?.address}</div>
          <div className="small muted">GSTIN {company?.gstin} · {company?.phone} · {company?.email}</div>
        </div>
        <div className="right">
          <div className="strong" style={{ fontSize: 16 }}>QUOTATION</div>
          <div className="small">{q.number} · Version {version.version_no}</div>
          <div className="small muted">Date {date(version.created_at)}</div>
          {q.valid_until && <div className="small muted">Valid until {date(q.valid_until)}</div>}
        </div>
      </div>
      <div className="row between top" style={{ gap: 24, marginBottom: 16 }}>
        <div>
          <div className="tiny muted">TO</div>
          <div className="strong">{q.customer_name}</div>
          <div className="small" style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>{q.billing_address}</div>
          {q.customer_gstin && <div className="small muted">GSTIN {q.customer_gstin}</div>}
          {q.contact_name && <div className="small">Kind attention: {q.contact_name}{q.contact_designation ? `, ${q.contact_designation}` : ''}</div>}
        </div>
        <div className="small right">
          <div className="tiny muted">SUBJECT</div>
          <div style={{ maxWidth: 280 }}>{q.subject}</div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>Description</th>
            <th style={{ width: 70 }}>HSN</th>
            <th className="right" style={{ width: 60 }}>Qty</th>
            <th className="right" style={{ width: 90 }}>Rate</th>
            <th className="right" style={{ width: 60 }}>Disc</th>
            <th className="right" style={{ width: 95 }}>Taxable</th>
            <th className="right" style={{ width: 55 }}>GST</th>
            <th className="right" style={{ width: 100 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {version.items.map((it, i) => (
            <tr key={it.id}>
              <td>{i + 1}</td>
              <td>
                <div className="strong">{it.description}</div>
                {it.specs && <div className="small muted">{it.specs}</div>}
                {it.sku && <div className="tiny muted">SKU {it.sku}</div>}
              </td>
              <td className="small">{it.hsn}</td>
              <td className="right num">{number(it.qty)} {it.unit}</td>
              <td className="right num">{inr(it.unit_price)}</td>
              <td className="right num">{it.discount_pct ? `${number(it.discount_pct, 1)}%` : '—'}</td>
              <td className="right num">{inr(it.taxable)}</td>
              <td className="right num">{it.gst_rate}%</td>
              <td className="right num">{inr(it.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row between top" style={{ marginTop: 16, gap: 32 }}>
        <div className="small" style={{ maxWidth: 380 }}>
          <KV items={[
            ['Payment terms', version.payment_terms],
            ['Delivery', version.delivery_terms],
            ['Warranty', version.warranty_terms],
            ['Validity', `${version.validity_days} days from quotation date`],
            version.notes && ['Notes', version.notes],
          ]} />
        </div>
        <div className="totals" style={{ minWidth: 260 }}>
          <span className="muted">Gross value</span><span className="num">{inr(version.subtotal)}</span>
          {version.discount_total > 0 && <><span className="muted">Discount</span><span className="num">− {inr(version.discount_total)}</span></>}
          {version.freight > 0 && <><span className="muted">Freight</span><span className="num">{inr(version.freight)}</span></>}
          {version.installation > 0 && <><span className="muted">Installation</span><span className="num">{inr(version.installation)}</span></>}
          <span className="muted">Taxable value</span><span className="num">{inr(version.taxable_total)}</span>
          <span className="muted">GST</span><span className="num">{inr(version.tax_total)}</span>
          <span className="grand">Grand total</span><span className="grand num">{inr(version.grand_total)}</span>
        </div>
      </div>
      <div className="small muted" style={{ marginTop: 20 }}>
        For {company?.name} · {q.owner_name}{q.owner_phone ? ` · ${q.owner_phone}` : ''}{q.owner_email ? ` · ${q.owner_email}` : ''}
      </div>
    </div>
  );
}

function VersionCompare({ q, a, b, onPick, marginVisible }) {
  const [left, right] = useMemo(() => (a.version_no < b.version_no ? [a, b] : [b, a]), [a, b]);
  const keyOf = (it) => `${it.product_id || 'custom'}:${it.description}`;
  const rows = useMemo(() => {
    const map = new Map();
    for (const it of left.items) map.set(keyOf(it), { key: keyOf(it), before: it });
    for (const it of right.items) {
      const k = keyOf(it);
      map.set(k, { ...(map.get(k) || { key: k }), after: it });
    }
    return [...map.values()];
  }, [left, right]);
  const headerDiffs = [
    ['Payment terms', left.payment_terms, right.payment_terms], ['Delivery', left.delivery_terms, right.delivery_terms],
    ['Warranty', left.warranty_terms, right.warranty_terms], ['Freight', inr(left.freight), inr(right.freight)],
    ['Installation', inr(left.installation), inr(right.installation)], ['Validity', `${left.validity_days} days`, `${right.validity_days} days`],
  ].filter(([, x, y]) => x !== y);

  return (
    <Card title={`Comparing version ${left.version_no} → ${right.version_no}`} className="no-print"
      actions={<Select className="sm" value={String(left.version_no)} onChange={(e) => onPick(Number(e.target.value))} options={q.versions.filter((v) => v.version_no !== right.version_no).map((v) => ({ value: String(v.version_no), label: `Compare with v${v.version_no}` }))} />}>
      <div className="grid grid-2 small" style={{ marginBottom: 12 }}>
        <div><strong>Version {left.version_no}</strong> · {left.created_by_name} · {date(left.created_at)}<div className="muted">{left.change_note}</div></div>
        <div><strong>Version {right.version_no}</strong> · {right.created_by_name} · {date(right.created_at)}<div className="muted">{right.change_note}</div></div>
      </div>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Discount</th><th className="num">Line total</th><th>Change</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const before = r.before;
              const after = r.after;
              const changed = before && after && (before.qty !== after.qty || before.unit_price !== after.unit_price || before.discount_pct !== after.discount_pct);
              const cls = !before ? 'diff-add' : !after ? 'diff-del' : changed ? 'diff-chg' : '';
              const cell = (fmt, key) => (
                <span className="num">
                  {before && <span className={after && before[key] !== after[key] ? 'diff-del' : ''}>{fmt(before[key])}</span>}
                  {after && (!before || before[key] !== after[key]) && <> {before ? '→ ' : ''}<span className={before ? 'diff-add' : ''}>{fmt(after[key])}</span></>}
                </span>
              );
              return (
                <tr key={r.key} className={cls}>
                  <td>{(after || before).description}</td>
                  <td className="num">{cell((v) => number(v), 'qty')}</td>
                  <td className="num">{cell((v) => inr(v), 'unit_price')}</td>
                  <td className="num">{cell((v) => `${number(v, 1)}%`, 'discount_pct')}</td>
                  <td className="num">{cell((v) => inr(v), 'total')}</td>
                  <td className="small">{!before ? 'Added' : !after ? 'Removed' : changed ? 'Price / quantity changed' : 'Unchanged'}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Grand total</td>
              <td className="num">{inr(left.grand_total)} → <strong>{inr(right.grand_total)}</strong></td>
              <td className={right.grand_total < left.grand_total ? 'danger-text' : 'success-text'}>{right.grand_total === left.grand_total ? 'No change' : `${right.grand_total < left.grand_total ? '−' : '+'}${inr(Math.abs(right.grand_total - left.grand_total))}`}</td>
            </tr>
            <tr>
              <td colSpan={4}>Effective discount{marginVisible ? ' · margin' : ''}</td>
              <td className="num">{pct(left.discount_pct)} → {pct(right.discount_pct)}{marginVisible && left.margin_pct !== null && ` · ${pct(left.margin_pct)} → ${pct(right.margin_pct)}`}</td>
              <td className="small">{right.created_by_name} made this change</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {headerDiffs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="small strong">Terms changed</div>
          {headerDiffs.map(([label, x, y]) => <div key={label} className="small"><span className="muted">{label}:</span> <span className="diff-del">{x || '—'}</span> → <span className="diff-add">{y || '—'}</span></div>)}
        </div>
      )}
    </Card>
  );
}

function DecideForm({ q, decision, approval, onDone }) {
  const toast = useToast();
  const [comments, setComments] = useState(decision === 'approved' ? 'Approved' : '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/approvals/${approval.id}/decide`, { decision, comments });
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected and returned to draft');
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="small muted">{approval?.reasons.join('; ')}</div>
      <div className="grid grid-3 small">
        <div><div className="muted">Discount</div><strong>{pct(approval?.discount_pct)}</strong></div>
        <div><div className="muted">Margin</div><strong>{approval?.margin_pct === null ? '—' : pct(approval?.margin_pct)}</strong></div>
        <div><div className="muted">Value</div><strong>{inrCompact(approval?.amount)}</strong></div>
      </div>
      <Field label="Comments" required={decision === 'rejected'}><Textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} placeholder={decision === 'approved' ? 'Optional note for the salesperson' : 'Explain what must change'} /></Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant={decision === 'approved' ? 'primary' : 'danger'} loading={busy} onClick={submit}>{decision === 'approved' ? 'Approve' : 'Reject'}</Button>
      </div>
    </div>
  );
}

function SendModal({ open, onClose, q, onDone }) {
  const toast = useToast();
  const [channel, setChannel] = useState('email');
  const [validUntil, setValidUntil] = useState(addDaysStr(todayStr(), q.current?.validity_days || 30));
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/quotations/${q.id}/send`, { channel, valid_until: validUntil });
      toast.success('Marked as sent — a follow-up has been scheduled');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Send quotation" subtitle={`${q.number} v${q.current_version} to ${q.customer_name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={send} icon="send">Mark as sent</Button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Sent via"><Select value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'courier', label: 'Printed / courier' }, { value: 'portal', label: 'Customer link' }]} /></Field>
          <Field label="Valid until" hint={relativeDay(validUntil)}><Input type="date" value={validUntil} min={todayStr()} onChange={(e) => setValidUntil(e.target.value)} /></Field>
        </div>
        <div className="info-box small">A follow-up task is created automatically, and the lead moves to “Quotation sent”. Use the share buttons to actually deliver the PDF or link.</div>
      </div>
    </Modal>
  );
}

function RespondModal({ open, onClose, q, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ status: 'responded', note: '', reason: '', mark_lead_lost: false, competitor: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/quotations/${q.id}/status`, form);
      toast.success('Response recorded');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Record customer response" subtitle={q.number}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Save</Button></>}>
      <div className="stack">
        <Field label="What happened?">
          <Select value={form.status} onChange={set('status')} options={[
            { value: 'viewed', label: 'Customer acknowledged / viewed' },
            { value: 'responded', label: 'Customer responded' },
            { value: 'negotiation', label: 'Under negotiation' },
            { value: 'revision_requested', label: 'Revision requested' },
            { value: 'accepted', label: 'Accepted — PO expected' },
            { value: 'rejected', label: 'Rejected / lost' },
          ]} />
        </Field>
        <Field label="Notes" hint="Customer's words, objections, what they asked for"><Textarea rows={3} value={form.note} onChange={set('note')} /></Field>
        {form.status === 'rejected' && (
          <>
            <Field label="Reason" required><Select value={form.reason} onChange={set('reason')} placeholder="Select…" options={LOSS_REASONS} /></Field>
            <Field label="Lost to competitor"><Input list="cmp" value={form.competitor} onChange={set('competitor')} /><datalist id="cmp">{COMPETITORS.map((c) => <option key={c} value={c} />)}</datalist></Field>
            {q.lead_id && <Checkbox label="Also mark the linked lead as lost" checked={form.mark_lead_lost} onChange={(v) => setForm((f) => ({ ...f, mark_lead_lost: v }))} />}
          </>
        )}
        {form.status === 'revision_requested' && <div className="info-box small">Use “Revise” afterwards to create the next version with the new prices.</div>}
      </div>
    </Modal>
  );
}

function ConvertModal({ open, onClose, q, onDone }) {
  const toast = useToast();
  const meta = useMeta();
  const [form, setForm] = useState({ po_date: todayStr(), priority: 'normal', advance_pct: 30, win_reason: '' });
  const [po, setPo] = useState([]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post(`/quotations/${q.id}/convert`, { ...form, po_attachment_id: po[0]?.id });
      toast.success('Sales order created — production and accounts notified');
      onDone(res.id);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const advanceValue = (q.current?.grand_total || 0) * (Number(form.advance_pct) || 0) / 100;
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Convert to sales order" subtitle={`${q.number} v${q.current_version} · ${inr(q.current?.grand_total)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} icon="orders">Create sales order</Button></>}>
      <div className="form-grid">
        <Field label="Customer PO number" required><Input value={form.customer_po_number} onChange={set('customer_po_number')} autoFocus placeholder="As printed on the customer's PO" /></Field>
        <Field label="PO date"><Input type="date" value={form.po_date} onChange={set('po_date')} /></Field>
        <Field label="PO document" className="full" hint="Attach the customer's purchase order"><PendingAttachments value={po} onChange={setPo} voice={false} kind="po" /></Field>
        <Field label="Expected delivery date" hint="Blank = quoted lead time"><Input type="date" value={form.expected_delivery_date} onChange={set('expected_delivery_date')} min={todayStr()} /></Field>
        <Field label="Production priority"><Select value={form.priority} onChange={set('priority')} options={PRIORITIES} /></Field>
        <Field label="Factory / unit"><Select value={form.factory_id} onChange={set('factory_id')} placeholder="Default unit" options={meta.factories.map((f) => ({ value: f.id, label: f.name }))} /></Field>
        <Field label="Advance required (%)" hint={form.advance_pct > 0 ? `${inr(advanceValue)} to be collected before production` : 'No advance — credit terms'}>
          <Input type="number" min="0" max="100" value={form.advance_pct} onChange={set('advance_pct')} />
        </Field>
        <Field label="Why did we win?"><Select value={form.win_reason} onChange={set('win_reason')} placeholder="—" options={WIN_REASONS} /></Field>
        <Field label="Internal notes" className="full"><Textarea rows={2} value={form.internal_notes} onChange={set('internal_notes')} placeholder="Special instructions for commercial / production" /></Field>
        <div className="info-box full small">The order is created with the quoted items and prices, the linked lead is marked won, and commercial and accounts are notified.</div>
      </div>
    </Modal>
  );
}
