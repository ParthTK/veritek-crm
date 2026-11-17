import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { initials, time } from '../lib/format.js';

// ------------------------------------------------------------------ toasts
const ToastContext = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((kind, message) => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list, { id, kind, message }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
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
export function Button({ variant, size, icon, iconRight, loading, children, className = '', to, type = 'button', ...props }) {
  const cls = ['btn', variant, size, !children && icon ? 'icon' : '', className].filter(Boolean).join(' ');
  const iconSize = size === 'sm' || size === 'xs' ? 14 : 16;
  const content = (
    <>
      {loading ? <Icon name="refresh" size={iconSize} className="spin" /> : icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </>
  );
  if (to) return <Link to={to} className={cls} {...props}>{content}</Link>;
  return <button type={type} className={cls} disabled={loading || props.disabled} {...props}>{content}</button>;
}

export function Badge({ tone = 'slate', children, icon, size, title }) {
  return (
    <span className={`badge ${tone} ${size || ''}`} title={title}>
      {icon && <Icon name={icon} size={size === 'sm' ? 12 : 13} strokeWidth={2.2} />}
      {children}
    </span>
  );
}

export function Avatar({ name }) {
  return <span className="avatar" title={name}>{initials(name)}</span>;
}

export function Spinner({ label = 'Loading…' }) {
  return <div className="loading"><Icon name="refresh" className="spin" size={16} />{label}</div>;
}

export function Notice({ tone = 'info', icon, title, children, action }) {
  const ic = icon || { warn: 'alert', danger: 'alert', success: 'checkCircle', info: 'info' }[tone] || 'info';
  return (
    <div className={`notice ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={ic} size={17} />
      <div className="grow">
        {title && <div className="strong">{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <Notice tone="danger" action={onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}>
      {error?.message || 'Failed to load'}
    </Notice>
  );
}

export function EmptyState({ icon = 'inbox', title, message, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      {title && <div className="title">{title}</div>}
      {message && <div>{message}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions, crumbs }) {
  return (
    <div className="page-header">
      <div className="grow">
        {crumbs && (
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
                {i < crumbs.length - 1 && <span aria-hidden>/</span>}
              </span>
            ))}
          </div>
        )}
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
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
          <h2>{title}{sub && <span className="sub">{sub}</span>}</h2>
          {actions && <div className="row wrap">{actions}</div>}
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
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && t.count !== null && <span className={`count ${t.tone || ''}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chips({ options, value, onChange }) {
  return (
    <div className="chips" role="group">
      {options.filter(Boolean).map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} className={`chip ${value === o.value ? 'on' : ''} ${o.tone || ''}`} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={15} />}
          {o.label}
          {o.count !== undefined && o.count !== null && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Tile({ label, value, foot, to, alert, icon, title }) {
  const inner = (
    <>
      {icon && <span className="tile-icon"><Icon name={icon} size={20} /></span>}
      <span className="grow">
        <div className="label">{label}</div>
        <div className={`value ${typeof value === 'string' && value.length > 11 ? 'long' : ''}`}>{value}</div>
        {foot && <div className="foot">{foot}</div>}
      </span>
    </>
  );
  const cls = `tile ${alert ? 'alert' : ''}`;
  return to ? <Link to={to} className={cls} title={title}>{inner}</Link> : <div className={cls} title={title}>{inner}</div>;
}

export function Stat({ k, v, d }) {
  return <div className="stat"><span className="k">{k}</span><span className="v">{v}</span>{d && <span className="d">{d}</span>}</div>;
}

export function Facts({ items }) {
  return (
    <dl className="facts">
      {items.filter(Boolean).map(([k, v]) => (
        <FactRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}
function FactRow({ k, v }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</dd>
    </>
  );
}

// ------------------------------------------------------------------ form controls
export function Field({ label, required, optional, hint, error, children, className = '', htmlFor }) {
  return (
    <div className={`field ${className}`}>
      {label && (
        <label htmlFor={htmlFor}>
          {label}
          {required && <span className="req" aria-hidden>*</span>}
          {optional && <span className="opt">(optional)</span>}
        </label>
      )}
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Input({ className = '', invalid, ...props }) {
  return <input className={`input ${invalid ? 'invalid' : ''} ${className}`} aria-invalid={invalid || undefined} {...props} value={props.value ?? ''} />;
}

export function Textarea({ className = '', invalid, ...props }) {
  return <textarea className={`textarea ${invalid ? 'invalid' : ''} ${className}`} aria-invalid={invalid || undefined} {...props} value={props.value ?? ''} />;
}

/** options: [{ value, label }] | strings. */
export function Select({ options = [], placeholder, className = '', invalid, ...props }) {
  return (
    <select className={`select ${invalid ? 'invalid' : ''} ${className}`} aria-invalid={invalid || undefined} {...props} value={props.value ?? ''}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return <option key={value} value={value} disabled={o.disabled}>{label}</option>;
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

export function SearchBox({ value, onChange, placeholder = 'Search…', delay = 300, autoFocus }) {
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
      <Icon name="search" size={15} />
      <input className="input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} aria-label={placeholder} autoFocus={autoFocus} />
    </div>
  );
}

/**
 * Searchable dropdown. `load(q)` returns options [{ value, label, sub }] (async allowed), or pass static
 * `options` that are filtered locally. Keyboard: arrows, Enter, Escape.
 */
export function Combobox({ value, label: selectedLabel, onChange, options, load, placeholder = 'Search…', invalid, id, disabled, minChars = 0, renderEmpty }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hl, setHl] = useState(0);
  const ref = useRef(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return undefined;
    if (q.length < minChars) {
      setItems([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = load ? await load(q) : (options || []).filter((o) => `${o.label} ${o.sub || ''}`.toLowerCase().includes(q.toLowerCase()));
      if (!cancelled) {
        setItems((res || []).slice(0, 50));
        setHl(0);
      }
    }, load ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, load, options, minChars]);
  useEffect(() => {
    const onDoc = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const choose = (o) => {
    onChange(o);
    setOpen(false);
    setQ('');
  };
  const shown = selectedLabel ?? (options || []).find((o) => String(o.value) === String(value))?.label ?? '';
  return (
    <div className="combo" ref={ref}>
      <input
        id={id} className={`input ${invalid ? 'invalid' : ''}`} disabled={disabled} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        value={open ? q : shown} placeholder={shown || placeholder}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHl((h) => Math.min(items.length - 1, h + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
          if (e.key === 'Enter' && open && items[hl]) { e.preventDefault(); choose(items[hl]); }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (items.length > 0 || renderEmpty) && (
        <div className="combo-list" role="listbox" id={listId}>
          {items.map((o, i) => (
            <div key={`${o.value}-${i}`} role="option" aria-selected={i === hl} className={`combo-opt ${i === hl ? 'hl' : ''}`} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
              <span>{o.label}</span>
              {o.sub && <span className="s">{o.sub}</span>}
            </div>
          ))}
          {!items.length && renderEmpty?.(q, () => setOpen(false))}
        </div>
      )}
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

export function Drawer({ open, title, subtitle, onClose, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="drawer-overlay" onMouseDown={onClose} />
      <aside className={`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="drawer-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
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
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className="popover" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>{children({ close: () => setOpen(false) })}</div>}
    </div>
  );
}

/** Shows saving / saved-at / error-with-retry so a failed save is never mistaken for success. */
export function SaveStatus({ save }) {
  if (save.saving) return <span className="save-status"><Icon name="refresh" size={13} className="spin" />Saving…</span>;
  if (save.error && !save.conflict) {
    const network = save.error.status === 0;
    return (
      <span className="save-status error">
        <Icon name="alert" size={14} />
        {network ? 'Not saved — connection problem. Your entries are kept.' : save.error.message}
        {network && <Button size="xs" onClick={save.retry}>Retry</Button>}
      </span>
    );
  }
  if (save.savedAt) return <span className="save-status"><Icon name="check" size={13} />Saved at {time(save.savedAt)}</span>;
  return null;
}

/** When someone else saved first: never silently overwrite — show what is there now and let the user decide. */
export function ConflictNotice({ save, onReload, fields = [] }) {
  if (!save.conflict) return null;
  const cur = save.conflict.details?.current || {};
  const stale = save.conflict.code === 'stale_report';
  return (
    <Notice tone="warn" title={stale ? 'A newer update already exists' : 'Someone else saved changes first'}
      action={onReload && <Button size="sm" onClick={onReload}>Load latest</Button>}>
      <div className="small">{save.conflict.message}</div>
      {fields.length > 0 && (
        <div className="small mt-8">
          Current saved values: {fields.filter(([k]) => cur[k] !== undefined).map(([k, label, fmt]) => `${label}: ${fmt ? fmt(cur[k]) : cur[k] ?? '—'}`).join(' · ')}
        </div>
      )}
    </Notice>
  );
}

// ------------------------------------------------------------------ data table
/**
 * columns: [{ key, label, render(row), align: 'num', sort, width }]. On phones, `card(row)` renders a
 * readable card instead of shrinking the table.
 */
export function DataTable({ columns, rows, rowKey = 'id', onRowClick, sort, onSort, empty, loading, compact, card, selectedKey, maxHeight }) {
  const cols = columns.filter(Boolean);
  return (
    <>
      <div className={`table-wrap ${card ? 'responsive' : ''}`} style={{ maxHeight, opacity: loading && rows?.length ? 0.6 : 1 }}>
        <table className={`table ${compact ? 'compact' : ''}`}>
          <thead>
            <tr>
              {cols.map((c) => {
                const sortable = onSort && c.sort;
                const active = Boolean(c.sort) && sort?.key === c.sort;
                return (
                  <th key={c.key} className={`${c.align === 'num' ? 'num' : ''} ${sortable ? 'sortable' : ''}`} style={{ width: c.width }} scope="col"
                    onClick={sortable ? () => onSort({ key: c.sort, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' }) : undefined}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.label}
                    {active && <span aria-hidden> {sort.dir === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!rows?.length && !loading && <tr><td colSpan={cols.length}>{empty || <EmptyState title="Nothing here" message="No records match these filters." />}</td></tr>}
            {!rows?.length && loading && <tr><td colSpan={cols.length}><Spinner /></td></tr>}
            {rows?.map((row, i) => {
              const k = (typeof rowKey === 'function' ? rowKey(row) : row[rowKey]) ?? i;
              return (
                <tr key={k} className={`${onRowClick ? 'clickable' : ''} ${selectedKey !== undefined && selectedKey === k ? 'selected' : ''}`}
                  onClick={onRowClick ? (e) => !e.target.closest('a,button,input,select,label') && onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined} onKeyDown={onRowClick ? (e) => e.key === 'Enter' && e.target === e.currentTarget && onRowClick(row) : undefined}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.align === 'num' ? 'num' : ''}>{c.render ? c.render(row) : row[c.key] ?? <span className="muted">—</span>}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {card && (
        <div className="mobile-cards">
          {!rows?.length && !loading && (empty || <EmptyState title="Nothing here" message="No records match these filters." />)}
          {rows?.map((row, i) => (
            <div key={(typeof rowKey === 'function' ? rowKey(row) : row[rowKey]) ?? i} className="m-card" onClick={onRowClick ? () => onRowClick(row) : undefined} role={onRowClick ? 'button' : undefined} tabIndex={onRowClick ? 0 : undefined}>
              {card(row)}
            </div>
          ))}
        </div>
      )}
    </>
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
