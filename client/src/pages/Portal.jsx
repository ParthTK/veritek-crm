// Customer-facing pages: no login, reached through a shared link.
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { inr, number, date, dateTime } from '../lib/format.js';
import { Badge, Button, Card, Field, Input, KV, Spinner, useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';

function PortalShell({ company, title, subtitle, children }) {
  return (
    <div className="portal">
      <div className="row between" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="row" style={{ gap: 10 }}>
            <span className="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32" aria-hidden><path d="M8 9l8 15 8-15" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            <strong>{company?.name}</strong>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>{company?.address}</div>
        </div>
        <div className="right small muted">
          <div>{company?.phone}</div>
          <div>{company?.email}</div>
        </div>
      </div>
      <h1 style={{ marginBottom: 4 }}>{title}</h1>
      <div className="muted" style={{ marginBottom: 16 }}>{subtitle}</div>
      {children}
      <div className="small muted" style={{ marginTop: 28, textAlign: 'center' }}>This page is shared with you by {company?.name}. Questions? Reply to the email or call the number above.</div>
    </div>
  );
}

export function QuotePortal() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ action: '', name: '', message: '' });
  const [sent, setSent] = useState(false);

  const load = () => api.get(`/public/quotations/${token}${params.get('preview') ? '?preview=1' : ''}`).then(setData, (err) => setError(err.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) return <div className="portal"><div className="error-box">{error}</div></div>;
  if (!data) return <Spinner />;
  const t = data.totals;

  const respond = async (action) => {
    if (!form.name.trim()) {
      toast.error('Please enter your name');
      return;
    }
    try {
      await api.post(`/public/quotations/${token}/respond`, { ...form, action });
      setSent(true);
      toast.success(action === 'accept' ? 'Thank you — we will follow up right away' : 'Sent to the sales team');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <PortalShell company={data.company} title={`Quotation ${data.number}`} subtitle={`${data.subject || ''} · version ${data.version}${data.valid_until ? ` · valid until ${date(data.valid_until)}` : ''}`}>
      <div className="stack">
        {data.status === 'accepted' && <div className="info-box">You accepted this quotation. Our team is preparing the order confirmation.</div>}
        {data.status === 'expired' && <div className="warn-box">This quotation has expired. Contact us for a fresh price.</div>}
        <div className="doc">
          <div className="row between top" style={{ gap: 20, marginBottom: 14 }}>
            <div>
              <div className="tiny muted">PREPARED FOR</div>
              <div className="strong">{data.customer.name}</div>
              <div className="small" style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{data.customer.billing_address}</div>
              {data.customer.gstin && <div className="small muted">GSTIN {data.customer.gstin}</div>}
              {data.contact.name && <div className="small">Kind attention: {data.contact.name}</div>}
            </div>
            <div className="right small">
              <div className="tiny muted">YOUR CONTACT</div>
              <div className="strong">{data.owner.name}</div>
              <div>{data.owner.phone}</div>
              <div>{data.owner.email}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr><th style={{ width: 26 }}>#</th><th>Description</th><th className="right" style={{ width: 70 }}>Qty</th><th className="right" style={{ width: 90 }}>Rate</th><th className="right" style={{ width: 60 }}>Disc</th><th className="right" style={{ width: 95 }}>Taxable</th><th className="right" style={{ width: 50 }}>GST</th><th className="right" style={{ width: 100 }}>Amount</th></tr>
            </thead>
            <tbody>
              {data.items.map((it, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><div className="strong">{it.description}</div>{it.specs && <div className="small muted">{it.specs}</div>}{it.hsn && <div className="tiny muted">HSN {it.hsn}</div>}</td>
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
          <div className="row between top" style={{ marginTop: 16, gap: 28 }}>
            <div className="small" style={{ maxWidth: 380 }}>
              <KV items={[['Payment terms', data.terms.payment], ['Delivery', data.terms.delivery], ['Warranty', data.terms.warranty], data.terms.notes && ['Notes', data.terms.notes]]} />
            </div>
            <div className="totals" style={{ minWidth: 250 }}>
              <span className="muted">Gross value</span><span className="num">{inr(t.subtotal)}</span>
              {t.discount_total > 0 && <><span className="muted">Discount</span><span className="num">− {inr(t.discount_total)}</span></>}
              {t.freight > 0 && <><span className="muted">Freight</span><span className="num">{inr(t.freight)}</span></>}
              {t.installation > 0 && <><span className="muted">Installation</span><span className="num">{inr(t.installation)}</span></>}
              <span className="muted">Taxable value</span><span className="num">{inr(t.taxable_total)}</span>
              <span className="muted">GST</span><span className="num">{inr(t.tax_total)}</span>
              <span className="grand">Grand total</span><span className="grand num">{inr(t.grand_total)}</span>
            </div>
          </div>
        </div>

        {data.can_respond && !sent && (
          <Card title="Your response">
            <div className="stack">
              <div className="form-grid">
                <Field label="Your name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
                <Field label="Message / what you need changed"><Input value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} /></Field>
              </div>
              <div className="row wrap">
                <Button variant="primary" icon="check" onClick={() => respond('accept')}>Accept quotation</Button>
                <Button icon="edit" onClick={() => respond('revision')}>Request a revision</Button>
                <Button variant="ghost" icon="mail" onClick={() => respond('comment')}>Send a comment</Button>
              </div>
              <div className="tiny muted">Accepting here tells our sales team to raise the order confirmation; your purchase order is still required.</div>
            </div>
          </Card>
        )}
        {sent && <div className="info-box">Thank you — your response has reached {data.owner.name}.</div>}
        <Button icon="printer" onClick={() => window.print()} className="no-print">Print / save as PDF</Button>
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
  if (error) return <div className="portal"><div className="error-box">{error}</div></div>;
  if (!data) return <Spinner />;

  return (
    <PortalShell company={data.company} title={`Order ${data.number}`} subtitle={`Against your PO ${data.customer_po_number || '—'} placed on ${date(data.order_date)}`}>
      <div className="stack">
        <Card title="Where your order is">
          <div className="stack">
            <div className="row wrap" style={{ gap: 16 }}>
              {data.milestones.map((m) => (
                <div key={m.key} className="row" style={{ gap: 8 }}>
                  <Badge color={m.done ? 'green' : 'slate'} size="sm">{m.done ? <Icon name="check" size={12} /> : '·'}</Badge>
                  <span className={m.done ? 'strong' : 'muted'}>{m.label}{m.partial ? ' (partial)' : ''}</span>
                </div>
              ))}
            </div>
            <div className="divider" style={{ margin: 0 }} />
            <KV items={[
              ['Current status', <strong>{data.stage_label}</strong>],
              ['Expected delivery', <span>{date(data.expected_delivery_date)} {data.revised ? <Badge color="amber" size="sm">revised</Badge> : null}</span>],
              ['Production completion', data.planned_completion ? date(data.planned_completion) : '—'],
            ]} />
          </div>
        </Card>

        <Card title="Items" flush>
          <table className="table compact">
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Manufactured</th><th className="num">Dispatched</th></tr></thead>
            <tbody>
              {data.items.map((i, n) => (
                <tr key={n}>
                  <td>{i.description}</td>
                  <td className="num">{number(i.qty)} {i.unit}</td>
                  <td className="num">{number(i.qty_produced)}</td>
                  <td className="num">{number(i.qty_dispatched)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {data.dispatches.length > 0 && (
          <Card title="Shipments" flush>
            {data.dispatches.map((d) => (
              <div key={d.number} className="action-row">
                <Icon name="truck" size={16} />
                <span className="grow small">
                  <strong>{d.number}</strong>{d.dispatch_type === 'partial' ? ' · partial shipment' : ''}
                  <div className="tiny muted">{[d.transporter, d.vehicle_number, d.lr_number && `LR ${d.lr_number}`, d.boxes && `${d.boxes} boxes`].filter(Boolean).join(' · ')}</div>
                </span>
                <span className="small">{d.delivered_date ? `Delivered ${date(d.delivered_date)}` : d.expected_delivery_date ? `Expected ${date(d.expected_delivery_date)}` : `Dispatched ${date(d.dispatch_date)}`}</span>
                {d.tracking_url && <a href={d.tracking_url} target="_blank" rel="noreferrer" className="small">Track</a>}
              </div>
            ))}
          </Card>
        )}

        {data.updates.length > 0 && (
          <Card title="Progress updates" flush>
            {data.updates.map((u, n) => (
              <div key={n} className="action-row">
                <span className="grow small">{u.note}</span>
                <span className="tiny muted nowrap">{dateTime(u.created_at)}</span>
              </div>
            ))}
          </Card>
        )}
      </div>
    </PortalShell>
  );
}
