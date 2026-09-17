import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEAD_STAGES, LEAD_STATUSES, LEAD_TEMPERATURES, LEAD_SOURCES, QUOTATION_STATUSES, FOLLOWUP_TYPES, ORDER_STAGES, labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../lib/hooks.js';
import { inrCompact, date, dateTime, relativeDay, daysFromToday } from '../lib/format.js';
import { Badge, Button, Card, ErrorState, KV, OptionBadge, PageHeader, Spinner, Stepper, Tags, EmptyState } from '../components/ui.jsx';
import { ContactActions, LogActivityModal, Timeline } from '../components/domain.jsx';
import { LeadFormModal, MoveLeadModal } from './Leads.jsx';

export default function LeadDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: lead, error, reload } = useApi(`/leads/${id}`);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [move, setMove] = useState(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!lead) return <Spinner />;
  const editable = can('leads.edit');
  const open = lead.status === 'open';
  const contact = lead.contacts.find((c) => c.id === lead.contact_id);
  const overdue = open && daysFromToday(lead.next_follow_up_date) < 0;

  return (
    <div className="stack">
      <PageHeader
        crumbs={[{ label: 'Leads', to: '/leads' }, { label: lead.code }]}
        title={lead.title}
        subtitle={<span className="row wrap" style={{ gap: 8 }}>
          <Link to={`/customers/${lead.customer_id}`}>{lead.customer_name}</Link>
          <span className="muted">·</span>
          {open ? <OptionBadge list={LEAD_STAGES} value={lead.stage} /> : <OptionBadge list={LEAD_STATUSES} value={lead.status} />}
          <OptionBadge list={LEAD_TEMPERATURES} value={lead.temperature} />
          <Tags tags={lead.tags} />
        </span>}
        actions={editable && (
          <>
            <Button icon="phone" onClick={() => setLogging(true)}>Log interaction</Button>
            {open && can('quotations.edit') && <Button icon="quotations" to={`/quotations/new?lead=${lead.id}`}>Create quotation</Button>}
            <Button icon="edit" onClick={() => setEditing(true)}>Edit</Button>
            {open ? (
              <>
                <Button onClick={() => setMove({ status: 'on_hold' })}>Hold</Button>
                <Button variant="danger-ghost" onClick={() => setMove({ status: 'lost' })}>Mark lost</Button>
              </>
            ) : lead.status !== 'won' && <Button variant="primary" onClick={() => setMove({ status: 'open', stage: lead.stage })}>Reopen</Button>}
          </>
        )}
      />

      {open && (
        <Card>
          <div className="stack-sm">
            <Stepper steps={LEAD_STAGES.slice(0, -1)} current={lead.stage} onSelect={editable ? (stage) => setMove({ stage, status: 'open' }) : undefined} />
            <div className="row between wrap small">
              <span className="muted">In this stage for {lead.days_in_stage ?? 0} days · probability {lead.probability}%</span>
              <span className={overdue ? 'danger-text strong' : ''}>
                Next: <strong>{lead.next_action}</strong> · {date(lead.next_follow_up_date)} ({relativeDay(lead.next_follow_up_date)})
              </span>
            </div>
          </div>
        </Card>
      )}
      {!open && lead.win_loss_reason && (
        <div className={lead.status === 'lost' ? 'error-box' : 'info-box'}>
          {lead.status === 'won' ? 'Won' : lead.status === 'lost' ? 'Lost' : 'On hold'}: {lead.win_loss_reason}{lead.competitor ? ` · competitor ${lead.competitor}` : ''} · closed {date(lead.closed_at)}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, 1fr)' }}>
        <div className="stack">
          <Card title="Activity timeline" actions={editable && <Button size="sm" icon="plus" onClick={() => setLogging(true)}>Log</Button>}>
            <Timeline items={lead.timeline} />
          </Card>
        </div>
        <div className="stack">
          <Card title="Lead details">
            <KV items={[
              ['Requirement', lead.requirement],
              ['Product', [lead.product_name, lead.category_name].filter(Boolean).join(' · ')],
              ['Quantity', lead.quantity],
              ['Estimated value', lead.estimated_value !== undefined ? <strong>{inrCompact(lead.estimated_value)}</strong> : null],
              ['Weighted value', lead.estimated_value !== undefined ? inrCompact((lead.estimated_value * lead.probability) / 100) : null],
              ['Expected closing', lead.expected_close_date && <span className={open && daysFromToday(lead.expected_close_date) < 0 ? 'danger-text' : ''}>{date(lead.expected_close_date)}</span>],
              ['Source', labelOf(LEAD_SOURCES, lead.source)],
              ['Campaign', lead.campaign_id && <Link to={`/campaigns/${lead.campaign_id}`}>{lead.campaign_name}</Link>],
              ['Competitor', lead.competitor],
              ['Salesperson', lead.owner_name],
              ['Region', lead.region_name],
              ['Created', dateTime(lead.created_at)],
            ]} />
          </Card>
          <Card title="Contact">
            {contact ? (
              <div className="row between">
                <div className="col" style={{ gap: 0 }}>
                  <strong>{contact.name}</strong>
                  <span className="small muted">{contact.designation}</span>
                  <span className="small">{contact.phone}{contact.email ? ` · ${contact.email}` : ''}</span>
                </div>
                <ContactActions phone={contact.phone} whatsapp={contact.whatsapp} email={contact.email} size="sm" />
              </div>
            ) : <span className="muted">No contact linked</span>}
          </Card>
          <Card title="Quotations" actions={open && can('quotations.edit') && <Button size="sm" to={`/quotations/new?lead=${lead.id}`} icon="plus">New</Button>} flush>
            {lead.quotations.length ? lead.quotations.map((q) => (
              <Link key={q.id} to={`/quotations/${q.id}`} className="action-row">
                <span className="grow"><span className="strong">{q.number}</span> <span className="muted small">v{q.current_version}</span></span>
                <OptionBadge list={QUOTATION_STATUSES} value={q.status} size="sm" />
                <span className="num small">{inrCompact(q.grand_total)}</span>
              </Link>
            )) : <EmptyState title="No quotations yet" />}
            {lead.orders.map((o) => (
              <Link key={o.id} to={`/orders/${o.id}`} className="action-row">
                <span className="grow"><span className="strong">{o.number}</span> <span className="muted small">order</span></span>
                <OptionBadge list={ORDER_STAGES} value={o.stage} size="sm" />
                <span className="num small">{inrCompact(o.grand_total)}</span>
              </Link>
            ))}
          </Card>
          <Card title="Follow-ups" flush>
            {lead.followups.length ? lead.followups.slice(0, 8).map((f) => (
              <div key={f.id} className="action-row">
                <span className="grow truncate small">{f.title}<div className="tiny muted">{labelOf(FOLLOWUP_TYPES, f.type)} · {f.owner_name}</div></span>
                {f.status === 'pending' ? <span className={`small nowrap ${daysFromToday(f.due_date) < 0 ? 'danger-text' : ''}`}>{relativeDay(f.due_date)}</span> : <Badge size="sm" color={f.status === 'done' ? 'green' : 'slate'}>{f.status}</Badge>}
              </div>
            )) : <EmptyState title="No follow-ups" />}
          </Card>
          <Card title="Stage history" flush>
            {lead.history.map((h) => (
              <div key={h.id} className="action-row small">
                <span className="grow">
                  {h.from_stage ? <>{labelOf(LEAD_STAGES, h.from_stage)} → </> : null}
                  <strong>{h.to_status && h.to_status !== 'open' ? labelOf(LEAD_STATUSES, h.to_status) : labelOf(LEAD_STAGES, h.to_stage)}</strong>
                  {h.note && <div className="tiny muted">{h.note}</div>}
                </span>
                <span className="tiny muted nowrap">{date(h.changed_at)} · {h.user_name || 'System'}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <LogActivityModal open={logging} onClose={() => setLogging(false)} onSaved={reload} customerId={lead.customer_id} leadId={lead.id} requireNext={open} />
      <LeadFormModal open={editing} onClose={() => setEditing(false)} onSaved={reload} lead={lead} />
      <MoveLeadModal open={Boolean(move)} onClose={() => setMove(null)} onSaved={reload} lead={lead} stage={move?.stage} status={move?.status} />
    </div>
  );
}
