import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ENQUIRY_STAGES, labelOf } from '@shared/constants.js';
import { useAuth } from '../auth.jsx';
import { useApi, useUrlFilters } from '../lib/hooks.js';
import { api } from '../api.js';
import { qty, relDay, timeAgo } from '../lib/format.js';
import { Badge, Button, Card, Chips, DataTable, ErrorState, Modal, PageHeader, Pagination, SearchBox, Segmented, Spinner, useToast, EmptyState } from '../components/ui.jsx';
import { DueBadge, StageBadge, FilterBar, ReplyBadge } from '../components/domain.jsx';
import { useQuickEntry } from '../components/QuickEntry.jsx';
import StageForm from '../components/StageForm.jsx';

export default function Enquiries() {
  const { can } = useAuth();
  const quick = useQuickEntry();
  const [f, setF] = useUrlFilters({ stage: 'open', page: '1', view: 'list' });
  const board = f.view === 'pipeline';
  return (
    <div className="stack">
      <PageHeader title="Enquiries"
        actions={<>
          <Segmented label="View" value={board ? 'pipeline' : 'list'} onChange={(v) => setF({ view: v })} options={[{ value: 'list', label: 'List' }, { value: 'pipeline', label: 'Board' }]} />
          {can('enquiries.edit') && <Button variant="cta" icon="plus" onClick={() => quick.open('enquiry')}>New enquiry</Button>}
        </>} />
      {board ? <PipelineBoard f={f} setF={setF} /> : <EnquiryList f={f} setF={setF} />}
    </div>
  );
}

const VIEWS = [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost'], ['all', 'All']];

function EnquiryList({ f, setF }) {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/enquiries', { ...f, view: undefined });
  const sc = data?.stage_counts || {};
  const open = ENQUIRY_STAGES.filter((s) => s.open).reduce((n, s) => n + (sc[s.value] || 0), 0);
  const count = { open, won: sc.won || 0, lost: sc.lost || 0 };
  return (
    <>
      <div className="row wrap between">
        <Chips value={f.reply === 'unreplied' ? 'unreplied' : f.stage} onChange={(v) => setF(v === 'unreplied' ? { stage: 'open', reply: 'unreplied' } : { stage: v, reply: '' })} options={[
          ...VIEWS.map(([value, label]) => ({ value, label, count: count[value] })),
          { value: 'unreplied', label: 'Not replied', tone: 'red', count: data?.reply_counts?.unreplied },
        ]} />
        <div className="row wrap">
          <SearchBox value={f.q} onChange={(v) => setF({ q: v })} placeholder="Customer or product…" />
          <FilterBar value={f} onChange={setF} fields={['owner']} />
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      <Card flush>
        <DataTable loading={loading} rows={data?.rows} onRowClick={(r) => navigate(`/enquiries/${r.id}`)}
          empty={<div className="empty">No enquiries here.</div>}
          columns={[
            { key: 'customer', label: 'Customer', render: (r) => <><strong>{r.customer_name}</strong><div className="sub">{r.code} · {r.source_label}</div></> },
            { key: 'product', label: 'Product', render: (r) => <>{r.product}{r.line_count > 1 && <span className="muted"> +{r.line_count - 1}</span>}{r.qty ? <div className="sub">{qty(r.qty, r.unit)}</div> : null}</> },
            { key: 'stage', label: 'Status', render: (r) => <StageBadge stage={r.stage} /> },
            { key: 'reply', label: 'Reply', render: (r) => <ReplyBadge replied={Boolean(r.first_response_at)} /> },
            { key: 'next', label: 'Next action', render: (r) => (r.next_task ? <span className="stack-xs"><span className="small">{r.next_task.purpose}</span><DueBadge task={r.next_task} /></span> : r.stage === 'lost' ? <span className="small muted">Lost: {r.lost_reason}</span> : ['won', 'cancelled'].includes(r.stage) ? <span className="muted">—</span> : <Badge tone="red">None</Badge>) },
            { key: 'owner', label: 'Assigned to', render: (r) => r.owner_name },
            { key: 'received', label: 'Received', render: (r) => <span className="small">{r.received_unknown ? '—' : timeAgo(r.received_at)}</span> },
          ]}
          card={(r) => <><div className="row between"><strong>{r.customer_name}</strong><StageBadge stage={r.stage} size="sm" /></div><div className="small">{r.product}</div>{r.next_task && <div className="row"><DueBadge task={r.next_task} /><span className="small">{r.next_task.purpose}</span></div>}</>}
        />
        <Pagination page={Number(f.page) || 1} pageSize={data?.pageSize || 100} count={data?.count || 0} onChange={(p) => setF({ page: String(p) })} />
      </Card>
    </>
  );
}

// Moves into these always need details first. Every other move is tried straight away and asks only if it must.
const ASK_FIRST = ['on_hold', 'lost', 'cancelled'];
const CLOSING = ['won', 'lost', 'cancelled'];

/**
 * Kanban of open stages. Drag a card to another column to change its stage; while dragging, Won, Lost and
 * Cancelled appear as drop areas. The server decides what a move needs: when it asks for a next action, or the
 * stage always needs details, the status form opens and the card moves once it is saved.
 */
function PipelineBoard({ f, setF }) {
  const { can } = useAuth();
  const toast = useToast();
  const canMove = can('enquiries.edit');
  const { data, error, loading, reload } = useApi('/enquiries/pipeline', { owner: f.owner });
  const held = useRef(null); // the card being dragged, readable at once by the drag events
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null); // a move waiting for its details
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;

  const stageName = (stage) => labelOf(ENQUIRY_STAGES, stage);
  const moved = (card, to) => toast.success(`${card.customer_name} moved to ${stageName(to)}`);
  const move = async (card, to) => {
    if (card.stage === to) return;
    if (ASK_FIRST.includes(to)) {
      setPending({ card, to });
      return;
    }
    setBusy(card.id);
    try {
      await api.post(`/enquiries/${card.id}/stage`, { stage: to, version: card.version });
      moved(card, to);
    } catch (err) {
      if (err.fields?.stage) toast.error(err.fields.stage);
      else if (err.fields?.['next.purpose']) setPending({ card, to });
      else toast.error(err.message);
    }
    await reload();
    setBusy(null);
  };
  const endDrag = () => {
    held.current = null;
    setDragging(null);
    setOver(null);
  };
  const startDrag = (e, card) => {
    held.current = card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/enquiry', String(card.id));
    const box = e.currentTarget.getBoundingClientRect();
    e.dataTransfer.setDragImage(e.currentTarget, e.clientX - box.left, e.clientY - box.top);
    // After the browser has taken its picture of the card: changing the page during this event can cancel the drag.
    setTimeout(() => setDragging(card), 0);
  };
  const dropTarget = (stage) => (canMove ? {
    onDragOver: (e) => {
      if (!held.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== stage) setOver(stage);
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOver((s) => (s === stage ? null : s));
    },
    onDrop: (e) => {
      e.preventDefault();
      const card = held.current;
      endDrag();
      if (card) move(card, stage);
    },
  } : {});
  // Near either end of the board, keep scrolling so that every column can be reached with a card in hand.
  const scrollAtEdges = (e) => {
    if (!held.current) return;
    const el = e.currentTarget;
    const { left, right } = el.getBoundingClientRect();
    if (e.clientX > right - 70) el.scrollLeft += 24;
    else if (e.clientX < left + 70) el.scrollLeft -= 24;
  };

  return (
    <>
      <div className="filter-bar"><FilterBar value={f} onChange={setF} fields={['owner']} /></div>
      {!data && loading && <Spinner />}
      {data && !data.total && <EmptyState icon="pipeline" title="No open opportunities" message="New enquiries appear here." />}
      {data && data.total > 0 && (
        <div className="kanban" onDragOver={canMove ? scrollAtEdges : undefined}>
          {data.columns.map((col) => (
            <div key={col.stage} className={`kcol ${over === col.stage ? 'drop-over' : ''}`} data-stage={col.stage} {...dropTarget(col.stage)}>
              <div className="kcol-head">
                <span className="row between"><StageBadge stage={col.stage} size="sm" /><span className="tiny muted">{col.cards.length}</span></span>
              </div>
              <div className="kcol-body">
                {col.cards.map((c) => (
                  <Link key={c.id} to={`/enquiries/${c.id}`} data-enquiry={c.id} className={`kcard ${busy === c.id ? 'busy' : ''} ${dragging?.id === c.id ? 'dragging' : ''}`}
                    draggable={canMove && busy !== c.id} onDragStart={(e) => startDrag(e, c)} onDragEnd={endDrag}>
                    <div className="strong small truncate">{c.customer_name}</div>
                    <div className="tiny muted truncate">{c.code} · {c.title || c.product}</div>
                    <div className="tiny muted mt-8">{c.owner_name}{c.next_due ? ` · follow up ${relDay(c.next_due)}` : ' · no next action'}</div>
                  </Link>
                ))}
                {!col.cards.length && <div className="tiny muted" style={{ padding: 8 }}>{canMove ? 'Drag an enquiry here' : 'Nothing here'}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {dragging && (
        <div className="kclose-bar" role="group" aria-label="Close this enquiry">
          {CLOSING.map((stage) => <div key={stage} data-stage={stage} className={`kclose ${stage} ${over === stage ? 'drop-over' : ''}`} {...dropTarget(stage)}>{stageName(stage)}</div>)}
        </div>
      )}
      <Modal open={Boolean(pending)} onClose={() => setPending(null)} title={pending ? `Move ${pending.card.customer_name} to “${stageName(pending.to)}”` : ''}>
        {pending && <StageForm enquiry={pending.card} stage={pending.to} hasTask={Boolean(pending.card.next_due || pending.card.next_purpose)} onSaved={() => { moved(pending.card, pending.to); setPending(null); reload(); }} />}
      </Modal>
    </>
  );
}
