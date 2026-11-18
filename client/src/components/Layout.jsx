import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ROLES, labelOf } from '@shared/constants.js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { timeAgo } from '../lib/format.js';
import Icon from './Icon.jsx';
import { Avatar, Button, Logo, Popover } from './ui.jsx';
import { useMeta } from './domain.jsx';
import { useQuickEntry } from './QuickEntry.jsx';

// Items with a `module` appear only while that module is switched on (Settings data: modules).
const NAV = [
  { group: null, items: [
    { to: '/', label: 'Dashboard', icon: 'home', perm: 'dashboard.view', end: true },
    { to: '/followups', label: 'Follow-ups', icon: 'calendar', perm: 'tasks.edit', badge: 'followups' },
    { to: '/queue', label: 'Work queue', icon: 'queue', perm: 'queue.view', badge: 'queue', module: 'workQueue' },
    { to: '/analytics', label: 'Sales dashboard', icon: 'dashboard', perm: 'analytics.view', module: 'salesDashboard' },
  ] },
  { group: 'Sales', items: [
    { to: '/customers', label: 'Customers', icon: 'users', perm: 'customers.view' },
    { to: '/contacts', label: 'Contacts', icon: 'contacts', perm: 'customers.view', module: 'contacts' },
    { to: '/enquiries', label: 'Enquiries', icon: 'inbox', perm: 'enquiries.view' },
    { to: '/quotations', label: 'Quotations', icon: 'quotation', perm: 'quotes.view' },
    { to: '/pipeline', label: 'Sales pipeline', icon: 'pipeline', perm: ['enquiries.view', 'orders.view'] },
    { to: '/campaigns', label: 'Exhibitions', icon: 'campaigns', perm: 'campaigns.view' },
    { to: '/past-customers', label: 'Past customers', icon: 'history', perm: 'past.view', module: 'pastCustomers' },
  ] },
  { group: 'Orders', items: [
    { to: '/orders', label: 'Orders', icon: 'box', perm: 'orders.view' },
    { to: '/production', label: 'Production', icon: 'factory', perm: 'orders.view' },
    { to: '/dispatches', label: 'Dispatch', icon: 'truck', perm: 'orders.view' },
    { to: '/payments', label: 'Payments', icon: 'payment', perm: 'finance.view', module: 'payments' },
    { to: '/complaints', label: 'Complaints', icon: 'wrench', perm: 'complaints.view', module: 'complaints' },
  ] },
  { group: 'Setup', items: [
    { to: '/products', label: 'Products', icon: 'products', perm: 'products.view' },
    { to: '/reports', label: 'Reports', icon: 'chart', perm: 'reports.view', module: 'reports' },
    { to: '/team', label: 'Team & approvals', icon: 'team', perm: ['team.view', 'quotes.approve'], badge: 'approvals', module: 'team' },
    { to: '/settings', label: 'Settings', icon: 'settings', perm: 'settings.manage' },
  ] },
  { group: 'QR', items: [
    { to: '/objects', label: 'QR codes', icon: 'qr', perm: 'objects.view' },
  ] },
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
      <input value={q} placeholder="Search customers, enquiries, orders…" aria-label="Search everything"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(results.length - 1, h + 1));
          if (e.key === 'ArrowUp') setHl((h) => Math.max(0, h - 1));
          if (e.key === 'Enter' && results[hl]) go(results[hl]);
          if (e.key === 'Escape') setOpen(false);
        }} />
      {open && q.trim().length >= 2 && (
        <div className="search-results" role="listbox">
          {results.length === 0 && <div className="muted small" style={{ padding: 10 }}>No matches</div>}
          {results.map((r, i) => (
            <a key={r.link + r.label} href={r.link} className={i === hl ? 'hl' : ''} onClick={(e) => { e.preventDefault(); go(r); }}>
              <span className="badge sm">{r.type}</span>
              <span className="grow truncate">{r.label}</span>
              <span className="muted small truncate" style={{ maxWidth: 170 }}>{r.sub}</span>
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
        <Icon name="bell" size={19} />
        {unread > 0 && <span style={{ position: 'absolute', top: 3, right: 2, background: 'var(--danger)', color: '#fff', fontSize: 10, borderRadius: 8, padding: '0 4px', lineHeight: '15px', fontWeight: 700 }}>{unread > 99 ? '99+' : unread}</span>}
      </button>
    )}>
      {({ close }) => (
        <div className="notif">
          <div className="card-head"><h2>Notifications</h2><Button size="xs" variant="ghost" onClick={async () => { await api.post('/notifications/read'); load(); }}>Mark all read</Button></div>
          <div className="notif-list">
            {!rows && <div className="loading">Loading…</div>}
            {rows?.length === 0 && <div className="empty">You're all caught up</div>}
            {rows?.map((n) => (
              <a key={n.id} href={n.link || '#'} className={`notif-item ${n.read_at ? '' : 'unread'}`} onClick={async (e) => {
                e.preventDefault();
                if (!n.read_at) await api.post('/notifications/read', { ids: [n.id] }).catch(() => {});
                close();
                if (n.link) navigate(n.link);
              }}>
                <span className="dot" style={{ marginTop: 6, background: n.severity === 'danger' ? 'var(--danger)' : 'var(--brand)' }} />
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

export default function Layout({ children }) {
  const { user, logout, can } = useAuth();
  const meta = useMeta();
  const quick = useQuickEntry();
  const [navOpen, setNavOpen] = useState(false);
  const [counts, setCounts] = useState({ followups: 0, queue: 0, unread: 0, approvals: 0 });
  const [theme, setTheme] = useTheme();
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    const load = () => {
      api.get('/notifications', { unread: 1, limit: 1 }).then((r) => setCounts((c) => ({ ...c, unread: r.unread }))).catch(() => {});
      if (can('tasks.edit')) api.get('/tasks', { owner: 'me', bucket: 'overdue', limit: 1 }).then((r) => setCounts((c) => ({ ...c, followups: (r.counts.overdue || 0) + (r.counts.today || 0) }))).catch(() => {});
      if (meta.settings.modules?.team && can('quotes.approve')) api.get('/approvals', { status: 'pending' }).then((rows) => setCounts((c) => ({ ...c, approvals: rows.filter((a) => a.can_decide).length }))).catch(() => {});
    };
    load();
    const t = setInterval(load, 60000);
    window.addEventListener('data:changed', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('data:changed', load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand" aria-label={`${meta.settings.company.name} — overview`}>
          <Logo plate width="100%" />
        </Link>
        <nav className="nav">
          {NAV.map((section) => {
            const items = section.items.filter((i) => can(...[].concat(i.perm)) && (!i.module || meta.settings.modules?.[i.module]));
            if (!items.length) return null;
            return (
              <div key={section.group || 'main'} style={{ display: 'contents' }}>
                {section.group && <div className="nav-group">{section.group}</div>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end}>
                    <Icon name={i.icon} size={18} />
                    <span>{i.label}</span>
                    {i.badge && counts[i.badge] > 0 && <span className="count" title={i.badge === 'approvals' ? 'Waiting for your approval' : 'Due today or overdue'}>{counts[i.badge]}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {meta.env !== 'production' && <span className="env-badge">{meta.env}</span>}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="btn ghost icon menu-btn" onClick={() => setNavOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <GlobalSearch />
          <div className="grow" />
          {can('enquiries.edit') && <Button variant="cta" icon="plus" onClick={() => quick.open()}><span className="hide-mobile">New enquiry</span></Button>}
          <Notifications unread={counts.unread} onChange={(n) => setCounts((c) => ({ ...c, unread: n }))} />
          <Popover trigger={({ toggle }) => (
            <button type="button" className="btn ghost" onClick={toggle} style={{ height: 42 }} aria-label="Account menu">
              <Avatar name={user.name} />
              <span className="col hide-mobile" style={{ gap: 0, alignItems: 'flex-start', lineHeight: 1.2 }}>
                <span className="small strong">{user.name}</span>
                <span className="tiny muted">{labelOf(ROLES, user.role)}</span>
              </span>
              <Icon name="chevronDown" size={14} />
            </button>
          )}>
            {({ close }) => (
              <div className="menu">
                <div className="small muted" style={{ padding: '6px 10px' }}>{user.email}</div>
                <button type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? '' : 'dark')}>
                  <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} /> Theme: {theme || 'system'}
                </button>
                <Link to="/account" onClick={close}><Icon name="shield" size={15} /> Password & sign-in security</Link>
                <div className="sep" />
                <button type="button" onClick={logout}><Icon name="logout" size={15} /> Sign out</button>
              </div>
            )}
          </Popover>
        </header>
        {user.must_change_password && location.pathname !== '/account' && (
          <div className="banner danger"><Icon name="lock" size={15} /><span className="grow">Please set your own password before continuing.</span><Link to="/account">Change password</Link></div>
        )}
        <main className="content" id="main">{children}</main>
      </div>
    </div>
  );
}
