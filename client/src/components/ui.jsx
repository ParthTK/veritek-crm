import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { labelOf, colorOf } from '@shared/constants.js';
import Icon from './Icon.jsx';
import { initials } from '../lib/format.js';

// ------------------------------------------------------------------ toasts
const ToastContext = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((kind, message) => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list, { id, kind, message }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const api = useMemo(() => ({ success: (m) => push('success', m), error: (m) => push('error', m), info: (m) => push('info', m) }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'alert' : 'check'} size={16} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

// ------------------------------------------------------------------ basics
export function Button({ variant, size, icon, loading, children, className = '', to, ...props }) {
  const cls = ['btn', variant, size, !children && icon ? 'icon' : '', className].filter(Boolean).join(' ');
  const content = (
    <>
      {loading ? <Icon name="refresh" size={size === 'sm' || size === 'xs' ? 13 : 15} className="spin" /> : icon && <Icon name={icon} size={size === 'sm' || size === 'xs' ? 14 : 16} />}
      {children}
    </>
  );
  if (to) return <Link to={to} className={cls} {...props}>{content}</Link>;
  return (
    <button type="button" className={cls} disabled={loading || props.disabled} {...props}>
      {content}
    </button>
  );
}

export function Badge({ color = 'slate', children, dot, size, title }) {
  return (
    <span className={`badge ${color} ${size || ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/** Badge for a value from a constants option list (label + colour). */
export function OptionBadge({ list, value, size, dot }) {
  if (!value) return <span className="muted">—</span>;
  return <Badge color={colorOf(list, value)} size={size} dot={dot}>{labelOf(list, value)}</Badge>;
}

export function Tags({ tags }) {
  if (!tags?.length) return null;
  return <span className="row wrap" style={{ gap: 4 }}>{tags.map((t) => <span key={t.name || t} className="tag">{t.name || t}</span>)}</span>;
}

export function Avatar({ name, size }) {
  return <span className={`avatar ${size || ''}`} title={name}>{initials(name)}</span>;
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <Icon name="refresh" className="spin" size={16} />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="error-box row between">
      <span>{error?.message || 'Failed to load'}</span>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function EmptyState({ icon = 'file', title, message, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      {title && <div className="title">{title}</div>}
      {message && <div>{message}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }) {
  return (
    <div className="page-header">
      <div className="grow">
        {crumbs && (
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
                {i < crumbs.length - 1 && <span>/</span>}
              </span>
            ))}
          </div>
        )}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, actions, children, flush, className = '', id }) {
  return (
    <section className={`card ${className}`} id={id}>
      {(title || actions) && (
        <div className="card-head">
          <h2>
            {title} {sub && <span className="sub">{sub}</span>}
          </h2>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.filter(Boolean).map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && t.count !== null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tile({ label, value, foot, to, alert, icon, title }) {
  const inner = (
    <>
      <div className="label">{icon && <Icon name={icon} size={14} />}{label}</div>
      <div className="value">{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </>
  );
  const cls = `tile ${alert ? 'alert' : ''}`;
  return to ? <Link to={to} className={cls} title={title}>{inner}</Link> : <div className={cls} title={title}>{inner}</div>;
}

export function KV({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map(([k, v]) => (
        <FragmentKV key={k} k={k} v={v} />
      ))}
    </dl>
  );
}
function FragmentKV({ k, v }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</dd>
    </>
  );
}

export function Progress({ value, tone }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className={`progress ${tone || ''}`} role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${v}%` }} /></div>;
}

/** Horizontal stage progress; optional onSelect makes stages clickable. */
export function Stepper({ steps, current, onSelect, disabled }) {
  const idx = steps.findIndex((s) => s.value === current);
  return (
    <div className="stepper">
      {steps.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : '';
        const clickable = onSelect && !disabled && i !== idx;
        return (
          <button key={s.value} type="button" className={`step ${state} ${clickable ? 'clickable' : ''}`} onClick={clickable ? () => onSelect(s.value) : undefined}
            title={clickable ? `Move to ${s.label}` : s.label} disabled={!clickable && Boolean(onSelect)} style={{ opacity: 1 }}>
            <span className="bar" />
            <span className="lbl">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ form controls
export function Field({ label, required, hint, error, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label && (
        <label>
          {label}
          {required && <span className="req">*</span>}
        </label>
      )}
      {children}
      {error ? <span className="error">{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Input({ className = '', ...props }) {
  return <input className={`input ${className}`} {...props} value={props.value ?? ''} />;
}

export function Textarea({ className = '', ...props }) {
  return <textarea className={`textarea ${className}`} {...props} value={props.value ?? ''} />;
}

/** options: array of {value,label} | strings. */
export function Select({ options = [], placeholder, className = '', ...props }) {
  return (
    <select className={`select ${className}`} {...props} value={props.value ?? ''}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return <option key={value} value={value}>{label}</option>;
      })}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, ...props }) {
  return (
    <label className="check">
      <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} {...props} />
      {label}
    </label>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…', delay = 300 }) {
  const [text, setText] = useState(value || '');
  const first = useRef(true);
  useEffect(() => setText(value || ''), [value]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const t = setTimeout(() => {
      if ((text || '') !== (value || '')) onChange(text);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div className="search-box">
      <Icon name="search" size={14} />
      <input className="input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

export function Chips({ options, value, onChange, counts }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.value} type="button" className={`chip ${value === o.value ? 'on' : ''}`} onClick={() => onChange(value === o.value && o.value !== '' ? '' : o.value)}>
          {o.label}
          {counts?.[o.value] !== undefined && <span className="n">{counts[o.value]}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ overlays
export function Modal({ open, title, onClose, children, footer, size, subtitle }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const ConfirmContext = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={Boolean(state)} size="sm" title={state?.title || 'Are you sure?'} onClose={() => close(false)}
        footer={<><Button onClick={() => close(false)}>Cancel</Button><Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel || 'Confirm'}</Button></>}>
        <p className="secondary">{state?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmContext);

export function Popover({ trigger, children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className="popover" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>{children({ close: () => setOpen(false) })}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ data table
/**
 * columns: [{ key, label, render(row), align: 'num', sort: 'serverSortKey', width, className }]
 * sort: { key, dir } controlled by parent when server-sorted.
 */
export function DataTable({ columns, rows, rowKey = 'id', onRowClick, sort, onSort, empty, footer, loading, compact, maxHeight }) {
  const cols = columns.filter(Boolean);
  return (
    <div className="table-wrap" style={{ maxHeight, opacity: loading && rows?.length ? 0.6 : 1, transition: 'opacity .15s' }}>
      <table className={`table ${compact ? 'compact' : ''}`}>
        <thead>
          <tr>
            {cols.map((c) => {
              const sortable = onSort && c.sort;
              const active = Boolean(c.sort) && sort?.key === c.sort;
              return (
                <th key={c.key} className={`${c.align === 'num' ? 'num' : ''} ${sortable ? 'sortable' : ''}`} style={{ width: c.width }}
                  onClick={sortable ? () => onSort({ key: c.sort, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' }) : undefined}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.label}
                  {active && <span aria-hidden> {sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {!rows?.length && !loading && (
            <tr>
              <td colSpan={cols.length}>{empty || <EmptyState title="Nothing here yet" message="Try adjusting the filters." />}</td>
            </tr>
          )}
          {!rows?.length && loading && (
            <tr>
              <td colSpan={cols.length}><Spinner /></td>
            </tr>
          )}
          {rows?.map((row, i) => (
            <tr key={row[rowKey] ?? i} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? (e) => !e.target.closest('a,button,input,select,label') && onRowClick(row) : undefined}>
              {cols.map((c) => (
                <td key={c.key} className={`${c.align === 'num' ? 'num' : ''} ${c.className || ''}`}>
                  {c.render ? c.render(row) : row[c.key] ?? <span className="muted">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Pagination({ page = 1, pageSize = 50, count = 0, onChange }) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  if (count <= pageSize) return count ? <div className="pagination"><span>{count} record{count === 1 ? '' : 's'}</span></div> : null;
  const from = (page - 1) * pageSize + 1;
  return (
    <div className="pagination">
      <span>{from}–{Math.min(count, page * pageSize)} of {count}</span>
      <div className="row">
        <Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page" />
        <span>Page {page} of {pages}</span>
        <Button size="sm" icon="chevronRight" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}
