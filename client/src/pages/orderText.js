import { PHASES, WORK_STATUSES, labelOf } from '@shared/constants.js';

const FIELD_LABELS = {
  phase: 'Phase', work_status: 'Status', issue_code: 'Delay reason', forecast_dispatch_date: 'Dispatch forecast', forecast_ready_date: 'Expected ready date',
  ready_qty: 'Ready quantity', stage_note: 'Note', estimate_unknown: 'Estimate', confirmed_qty: 'Confirmed quantity', spec: 'Specification', dispatched_qty: 'Dispatched',
  cancelled_qty: 'Cancelled', original_commitment_date: 'Original commitment', hold_review_date: 'Hold review date', status: 'Order', needs_clarification: 'Needs clarification',
  unit_price_minor: 'Unit price', description: 'Description', line: 'Line', new_line: 'New line',
};

/** Human-readable "Phase Production → QC; Delay reason — → Raw material shortage" for an update's changes. */
export function summariseChanges(changes = {}, optionLabel = (c, v) => v) {
  const parts = Object.entries(changes).map(([k, [a, b]]) => {
    const fmt = (v) => {
      if (v === null || v === undefined || v === '') return '—';
      if (k === 'phase') return labelOf(PHASES, v);
      if (k === 'work_status') return labelOf(WORK_STATUSES, v);
      if (k === 'issue_code') return optionLabel('delay_reason', v);
      if (k === 'estimate_unknown' || k === 'needs_clarification') return v ? 'yes' : 'no';
      if (k === 'unit_price_minor') return (v / 100).toFixed(2);
      return v;
    };
    return `${FIELD_LABELS[k] || k.replace(/_/g, ' ')} ${fmt(a)} → ${fmt(b)}`;
  });
  return parts.length ? parts.join('; ') : 'No field changes';
}
