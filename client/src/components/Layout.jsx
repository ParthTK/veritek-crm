import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ROLES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { timeAgo } from '../lib/format.js';
import Icon from './Icon.jsx';
import { Avatar, Button, Popover } from './ui.jsx';
import { useMeta } from './domain.jsx';

const NAV = [
  { group: null, items: [{ to: '/', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view', end: true }] },
  {
    group: 'Sales',
    items: [
      { to: '/leads', label: 'Leads', icon: 'leads', perm: 'leads.view' },
      { to: '/opportunities', label: 'Opportunities', icon: 'pipeline', perm: 'leads.view' },
      { to: '/customers', label: 'Customers', icon: 'customers', perm: 'customers.view' },
      { to: '/contacts', label: 'Contacts', icon: 'contacts', perm: 'customers.view' },
      { to: '/followups', label: 'Follow-Ups', icon: 'followups', perm: 'dashboard.view', badge: 'followups' },
      { to: '/quotations', label: 'Quotations', icon: 'quotations', perm: 'quotations.view' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { to: '/orders', label: 'Sales Orders', icon: 'orders', perm: 'orders.view' },
      { to: '/production', label: 'Production Tracking', icon: 'production', perm: 'production.view' },
      { to: '/dispatches', label: 'Dispatches', icon: 'truck', perm: 'dispatch.view' },
      { to: '/payments', label: 'Payments', icon: 'payments', perm: 'payments.view' },
    ],
  },
  {
    group: 'Catalogue & market',
    items: [
      { to: '/products', label: 'Products', icon: 'products', perm: 'products.view' },
      { to: '/campaigns', label: 'Exhibitions & Campaigns', icon: 'campaigns', perm: 'campaigns.view' },
      { to: '/complaints', label: 'Complaints & Service', icon: 'complaints', perm: 'complaints.view' },
    ],
  },
  {
    group: 'Management',
    items: [
      { to: '/reports', label: 'Reports', icon: 'reports', perm: 'reports.view' },
      { to: '/team', label: 'Team & Approvals', icon: 'team', perm: 'team.view', badge: 'approvals' },
      { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.edit' },
    ],
  },
];

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const navigate = useNavigate();
  const ref = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const t = setTimeout(() => api.get('/search', { q }).then((r) => { setResults(r); setHl(0); }).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        ref.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const go = (r) => {
    navigate(r.link);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="search" ref={ref}>
      <Icon name="search" size={16} />
      <input
        value={q} placeholder="Search customers, leads, quotes, orders, PO, serial no…  (Ctrl+K)" aria-label="Global search"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(results.length - 1, h + 1));
          if (e.key === 'ArrowUp') setHl((h) => Math.max(0, h - 1));
          if (e.key === 'Enter' && results[hl]) go(results[hl]);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q.trim().length >= 2 && (
        <div className="search-results">
          {results.length === 0 && <div className="muted small" style={{ padding: 10 }}>No matches</div>}
          {results.map((r, i) => (
            <a key={r.link + r.label} href={r.link} className={i === hl ? 'hl' : ''} onClick={(e) => { e.preventDefault(); go(r); }}>
              <span className="badge sm">{r.type}</span>
              <span className="grow truncate">{r.label}</span>
              <span className="muted small truncate" style={{ maxWidth: 160 }}>{r.sub}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications({ unread, onChange }) {
  const [rows, setRows] = useState(null);
  const navigate = useNavigate();
  const load = () => api.get('/notifications', { limit: 40 }).then((r) => { setRows(r.rows); onChange(r.unread); });
  return (
    <Popover trigger={({ toggle }) => (
      <button type="button" className="btn ghost icon" onClick={() => { toggle(); load(); }} aria-label={`Notifications, ${unread} unread`} style={{ position: 'relative' }}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="count" style={{ position: 'absolute', top: 2, right: 0, background: '#c0392b', color: '#fff', fontSize: 10, borderRadius: 8, padding: '0 4px', lineHeight: '15px' }}>{unread > 99 ? '99+' : unread}</span>}
      </button>
    )}>
      {({ close }) => (
        <div className="notif">
          <div className="card-head">
            <h2>Notifications</h2>
            <Button size="xs" variant="ghost" onClick={async () => { await api.post('/notifications/read'); load(); }}>Mark all read</Button>
          </div>
          <div className="notif-list">
            {!rows && <div className="loading">Loading…</div>}
            {rows?.length === 0 && <div className="empty">You're all caught up</div>}
            {rows?.map((n) => (
              <a key={n.id} href={n.link || '#'} className={`notif-item ${n.read_at ? '' : 'unread'}`} onClick={async (e) => {
                e.preventDefault();
                if (!n.read_at) await api.post('/notifications/read', { ids: [n.id] }).catch(() => {});
                close();
                onChange(Math.max(0, unread - (n.read_at ? 0 : 1)));
                if (n.link) navigate(n.link);
              }}>
                <span className={`sev ${n.severity}`} />
                <span className="grow">
                  <div className="strong small">{n.title}</div>
                  {n.message && <div className="small secondary">{n.message}</div>}
                  <div className="tiny muted">{timeAgo(n.created_at)}</div>
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('veritek.theme') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem('veritek.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

function DemoNotice() {
  const { demo } = useMeta();
  const [hidden, setHidden] = useState(false);
  if (!demo || hidden) return null;
  return (
    <div className="demo-strip">
      <Icon name="alert" size={14} />
      <span className="grow">
        <strong>Demo deployment.</strong> Each server instance holds its own copy of a data snapshot, so anything you add or change here is temporary and uploads are not kept. Sign in as any role and click around freely.
      </span>
      <button type="button" onClick={() => setHidden(true)} aria-label="Dismiss">×</button>
    </div>
  );
}

export default function Layout({ children }) {
  const { user, logout, can } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [counts, setCounts] = useState({ followups: 0, approvals: 0, unread: 0 });
  const [theme, setTheme] = useTheme();
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    const load = () => {
      api.get('/notifications', { unread: 1, limit: 1 }).then((r) => setCounts((c) => ({ ...c, unread: r.unread }))).catch(() => {});
      api.get('/followups', { bucket: 'overdue', limit: 1 }).then((r) => setCounts((c) => ({ ...c, followups: (r.counts.overdue || 0) + (r.counts.today || 0) }))).catch(() => {});
      if (can('approvals.decide')) api.get('/approvals').then((r) => setCounts((c) => ({ ...c, approvals: r.filter((a) => a.can_decide).length }))).catch(() => {});
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <span className="brand-mark">
            <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden><path d="M8 9l8 15 8-15" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span>
            <div className="brand-name">Veritek CRM</div>
            <div className="brand-sub">Sales · Orders · Service</div>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((section) => {
            const items = section.items.filter((i) => can(i.perm));
            if (!items.length) return null;
            return (
              <div key={section.group || 'main'} style={{ display: 'contents' }}>
                {section.group && <div className="nav-group">{section.group}</div>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end}>
                    <Icon name={i.icon} size={17} />
                    <span>{i.label}</span>
                    {i.badge && counts[i.badge] > 0 && <span className="count">{counts[i.badge]}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">Lead → Quote → PO → Production → Dispatch → Payment → Service → Repeat</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="btn ghost icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <GlobalSearch />
          <div className="grow" />
          <Notifications unread={counts.unread} onChange={(n) => setCounts((c) => ({ ...c, unread: n }))} />
          <Popover trigger={({ toggle }) => (
            <button type="button" className="btn ghost" onClick={toggle} style={{ height: 40 }}>
              <Avatar name={user.name} />
              <span className="col" style={{ gap: 0, alignItems: 'flex-start', lineHeight: 1.2 }}>
                <span className="small strong">{user.name}</span>
                <span className="tiny muted">{labelOf(ROLES, user.role)}{user.region_name ? ` · ${user.region_name}` : ''}</span>
              </span>
              <Icon name="chevronDown" size={14} />
            </button>
          )}>
            {({ close }) => (
              <div className="menu">
                <div className="small muted" style={{ padding: '6px 10px' }}>{user.email}</div>
                <button type="button" onClick={() => { setTheme(theme === 'dark' ? 'light' : theme === 'light' ? '' : 'dark'); }}>
                  <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} /> Theme: {theme || 'system'}
                </button>
                <Link to="/account" onClick={close}><Icon name="shield" size={15} /> Change password</Link>
                <button type="button" onClick={logout}><Icon name="logout" size={15} /> Sign out</button>
              </div>
            )}
          </Popover>
        </header>
        <DemoNotice />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
