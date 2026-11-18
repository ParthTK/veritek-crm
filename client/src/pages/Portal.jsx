// Customer-facing pages reached through a shared link (no sign-in): the quotation (view, accept or ask for
// a revision) and order tracking. Only customer-safe fields are ever returned by the server.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, dateTime, money, number, qty as fmtQty } from '../lib/format.js';
import { Badge, Button, Card, Facts, Field, Input, Logo, Notice, Spinner, Textarea, useToast } from '../components/ui.jsx';
import { JourneyStepper } from '../components/domain.jsx';
import Icon from '../components/Icon.jsx';

function PortalShell({ company, title, subtitle, children }) {
  return (
    <div className="portal">
      <div className="row between wrap" style={{ marginBottom: 20, gap: 12 }}>
        <div>
          <Logo plate height={46} />
          {company?.address && <div className="small muted" style={{ marginTop: 8, maxWidth: 420 }}>{company.address}</div>}
        </div>
        <div className="small muted" style={{ textAlign: 'right' }}>
          {company?.phone && <div>{company.phone}</div>}
          {company?.email && <div>{company.email}</div>}
          {company?.website && <div>{company.website}</div>}
        </div>
      </div>
      <h1 style={{ marginBottom: 4 }}>{title}</h1>
      {subtitle && <div className="muted" style={{ marginBottom: 16 }}>{subtitle}</div>}
      {children}
      <div className="small muted" style={{ marginTop: 28, textAlign: 'center' }}>Shared with you by {company?.name}. Questions? Reply to the email or call the number above.</div>
    </div>
  );
}

function Failure({ message }) {
  return <div className="portal"><Notice tone="danger" title="This link cannot be opened">{message}</Notice></div>;
}

export function QuotePortal() {
  const { token } = useParams();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const load = () => api.get(`/public/quotations/${token}`).then(setData, (err) => setError(err.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (error) return <Failure message={error} />;
  if (!data) return <Spinner />;
  const t = data.totals;
  const m = (v) => (v === null || v === undefined ? '—' : money(v, data.currency));

  const respond = async (action) => {
    if (!form.name.trim()) {
      toast.error('Please enter your name');
      return;
    }
    if (action === 'revise' && !form.note.trim()) {
      toast.error('Tell us what should change');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/public/quotations/${token}/respond`, { action, name: form.name, note: form.note });
      setSent(action);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalShell company={data.company} title={`Quotation ${data.number}`}
      subtitle={[data.subject, `revision ${data.revision_no}`, data.sent_at && `sent ${date(data.sent_at, { year: true })}`, data.validity_date && `valid until ${date(data.validity_date, { year: true })}`].filter(Boolean).join(' · ')}>
      <div className="stack">
        {data.status === 'accepted' && <Notice tone="success" title="You accepted this quotation">Our team is preparing the order confirmation{data.decided_at ? ` (accepted ${dateTime(data.decided_at)})` : ''}.</Notice>}
        {data.status === 'rejected' && <Notice tone="info">This quotation is closed. Contact us if your requirement has changed.</Notice>}
        {data.expired && <Notice tone="warn" title="This quotation has expired">Contact us for an updated offer.</Notice>}
        {data.customer_response && data.status === 'issued' && <Notice tone="info">Your message: {data.customer_response}</Notice>}
        <div className="doc">
          <div className="row between top wrap" style={{ gap: 20, marginBottom: 14 }}>
            <div>
              <div className="tiny muted">PREPARED FOR</div>
              <div className="strong">{data.customer?.company_name}</div>
              <div className="small">{data.customer?.city}</div>
            </div>
            {data.owner && (
              <div className="small" style={{ textAlign: 'right' }}>
                <div className="tiny muted">YOUR CONTACT</div>
                <div className="strong">{data.owner.name}</div>
                {data.owner.phone && <div>{data.owner.phone}</div>}
                {data.owner.email && <div>{data.owner.email}</div>}
              </div>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Description</th><th>HSN</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Disc.</th><th className="num">GST</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><span className="strong">{l.product_code ? `${l.product_code} — ` : ''}{l.description}</span>{l.spec && <div className="small muted">{l.spec}</div>}</td>
                    <td className="small">{l.hsn || '—'}</td>
                    <td className="num">{fmtQty(l.qty, l.unit)}</td>
                    <td className="num">{m(l.unit_price_minor)}</td>
                    <td className="num">{l.discount_pct ? `${number(l.discount_pct, 2)}%` : '—'}</td>
                    <td className="num">{number(l.gst_rate, 2)}%</td>
                    <td className="num">{m(l.line_total_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row between top wrap" style={{ marginTop: 16, gap: 28 }}>
            <div className="small" style={{ maxWidth: 420 }}>
              <Facts items={[['Payment terms', data.payment_terms], ['Delivery', data.delivery_terms ? `${data.delivery_terms} (estimate)` : null], ['Warranty', data.warranty_terms], ['Notes', data.notes]]} />
            </div>
            <div className="totals" style={{ minWidth: 260 }}>
              <span className="muted">Gross value</span><span className="num">{m(t.subtotal_minor)}</span>
              {t.discount_total_minor > 0 && <><span className="muted">Discount</span><span className="num">− {m(t.discount_total_minor)}</span></>}
              {t.freight_minor > 0 && <><span className="muted">Freight</span><span className="num">{m(t.freight_minor)}</span></>}
              {t.installation_minor > 0 && <><span className="muted">Installation</span><span className="num">{m(t.installation_minor)}</span></>}
              <span className="muted">Taxable value</span><span className="num">{m(t.total_minor)}</span>
              <span className="muted">GST</span><span className="num">{m(t.tax_total_minor)}</span>
              <span className="grand">Grand total ({data.currency})</span><span className="grand num">{m(t.grand_total_minor)}</span>
            </div>
          </div>
        </div>

        {data.status === 'issued' && !data.expired && !sent && (
          <Card title="Your response" className="no-print">
            <div className="stack">
              <div className="form-grid">
                <Field label="Your name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoComplete="name" /></Field>
                <Field label="Message" optional hint="Needed if you want something changed"><Textarea rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} maxLength={1000} /></Field>
              </div>
              <div className="row wrap">
                <Button variant="primary" icon="check" loading={busy} onClick={() => respond('accept')}>Accept quotation</Button>
                <Button icon="edit" loading={busy} onClick={() => respond('revise')}>Request a revision</Button>
              </div>
              <div className="tiny muted">Accepting here tells our sales team to raise the order confirmation; your purchase order is still required.</div>
            </div>
          </Card>
        )}
        {sent && <Notice tone="success">{sent === 'accept' ? 'Thank you — we will confirm the order with you shortly.' : 'Thank you — your request has reached our sales team.'}</Notice>}
        <div className="no-print"><Button icon="printer" onClick={() => window.print()}>Print / save as PDF</Button></div>
      </div>
    </PortalShell>
  );
}

export function OrderPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get(`/public/orders/${token}`).then(setData, (err) => setError(err.message));
  }, [token]);
  if (error) return <Failure message={error} />;
  if (!data) return <Spinner />;
  const dispatchedAll = data.outcome === 'fully_dispatched';
  return (
    <PortalShell company={data.company} title={`Order ${data.code}`} subtitle={[data.po_reference && `Your PO ${data.po_reference}`, `received ${date(data.received_date, { year: true })}`, data.customer?.company_name].filter(Boolean).join(' · ')}>
      <div className="stack">
        <Card title="Where your order is">
          {data.phase === 'mixed' ? <div className="small">Items are at different stages — see each line below.</div> : <JourneyStepper phase={data.phase} dispatched={dispatchedAll} />}
          {data.closed && <Notice tone="success">This order is complete.</Notice>}
        </Card>
        <Card title="Items" flush>
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>Item</th><th>Stage</th><th className="num">Ordered</th><th className="num">Dispatched</th><th className="num">To come</th><th>Dispatch date</th></tr></thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td><strong>{l.product}</strong>{l.description && l.description !== l.product && <div className="sub">{l.description}</div>}</td>
                    <td className="small">{l.phase_label}</td>
                    <td className="num">{fmtQty(l.quantities.confirmed, l.unit)}{l.quantities.cancelled > 0 && <div className="sub">{fmtQty(l.quantities.cancelled)} cancelled</div>}</td>
                    <td className="num">{fmtQty(l.quantities.dispatched)}</td>
                    <td className="num">{fmtQty(l.quantities.remaining)}</td>
                    <td className="small">{l.agreed_date ? <>{date(l.agreed_date)} <Badge size="sm" tone="amber">revised</Badge></> : l.promised_date ? date(l.promised_date) : <span className="muted">To be confirmed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        {data.dispatches.length > 0 && (
          <Card title="Shipments" flush>
            {data.dispatches.map((d) => (
              <div key={d.code} className="alert-row">
                <Icon name="truck" size={16} />
                <span className="grow small">
                  <strong>{d.code}</strong> · {d.items}
                  <div className="tiny muted">{[d.carrier, d.tracking_no && `LR/AWB ${d.tracking_no}`].filter(Boolean).join(' · ')}</div>
                </span>
                <span className="small">{d.delivered_at ? `Delivered ${date(d.delivered_at)}` : d.expected_arrival ? `Dispatched ${date(d.dispatch_date)} · expected ${date(d.expected_arrival)}` : `Dispatched ${date(d.dispatch_date)}`}</span>
                {d.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer" className="small">Track</a>}
              </div>
            ))}
          </Card>
        )}
        {data.notes.length > 0 && (
          <Card title="Updates from us" flush>
            {data.notes.map((u, n) => (
              <div key={n} className="alert-row"><span className="grow small">{u.note}</span><span className="tiny muted nowrap">{dateTime(u.occurred_at)}</span></div>
            ))}
          </Card>
        )}
        {data.owner && <div className="small muted">Your contact: <strong>{data.owner.name}</strong>{data.owner.phone ? ` · ${data.owner.phone}` : ''}{data.owner.email ? ` · ${data.owner.email}` : ''}</div>}
      </div>
    </PortalShell>
  );
}
