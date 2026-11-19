import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useRouteError } from 'react-router-dom';
import { isMissingUpdate, loadFresh } from './lib/update.js';
import { AuthProvider, useAuth } from './auth.jsx';
import { ConfirmProvider, Spinner, ToastProvider, EmptyState, Button } from './components/ui.jsx';
import { MetaProvider, useMeta } from './components/domain.jsx';
import { QuickEntryProvider } from './components/QuickEntry.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';

const Overview = lazy(loadFresh(() => import('./pages/Overview.jsx')));
const WorkQueue = lazy(loadFresh(() => import('./pages/WorkQueue.jsx')));
const Followups = lazy(loadFresh(() => import('./pages/Followups.jsx')));
const Dashboard = lazy(loadFresh(() => import('./pages/Dashboard.jsx')));
const Pipeline = lazy(loadFresh(() => import('./pages/Pipeline.jsx')));
const PastCustomers = lazy(loadFresh(() => import('./pages/PastCustomers.jsx')));
const Enquiries = lazy(loadFresh(() => import('./pages/Enquiries.jsx')));
const EnquiryDetail = lazy(loadFresh(() => import('./pages/EnquiryDetail.jsx')));
const Quotations = lazy(loadFresh(() => import('./pages/Quotations.jsx')));
const QuotationBuilder = lazy(loadFresh(() => import('./pages/QuotationBuilder.jsx')));
const QuotationDetail = lazy(loadFresh(() => import('./pages/QuotationDetail.jsx')));
const Orders = lazy(loadFresh(() => import('./pages/Orders.jsx')));
const OrderDetail = lazy(loadFresh(() => import('./pages/OrderDetail.jsx')));
const NewOrder = lazy(loadFresh(() => import('./pages/NewOrder.jsx')));
const Production = lazy(loadFresh(() => import('./pages/Production.jsx')));
const Dispatches = lazy(loadFresh(() => import('./pages/Dispatches.jsx')));
const Customers = lazy(loadFresh(() => import('./pages/Customers.jsx')));
const CustomerProfile = lazy(loadFresh(() => import('./pages/CustomerProfile.jsx')));
const Contacts = lazy(loadFresh(() => import('./pages/Contacts.jsx')));
const Campaigns = lazy(loadFresh(() => import('./pages/Campaigns.jsx')));
const CampaignDetail = lazy(loadFresh(() => import('./pages/CampaignDetail.jsx')));
const Products = lazy(loadFresh(() => import('./pages/Products.jsx')));
const ProductDetail = lazy(loadFresh(() => import('./pages/Products.jsx').then((m) => ({ default: m.ProductDetailPage }))));
const Objects = lazy(loadFresh(() => import('./pages/Objects.jsx')));
const ObjectDetail = lazy(loadFresh(() => import('./pages/ObjectDetail.jsx')));
const ObjectLabels = lazy(loadFresh(() => import('./pages/ObjectLabels.jsx')));
const Reports = lazy(loadFresh(() => import('./pages/Reports.jsx')));
const Payments = lazy(loadFresh(() => import('./pages/Payments.jsx')));
const Complaints = lazy(loadFresh(() => import('./pages/Complaints.jsx')));
const ComplaintDetail = lazy(loadFresh(() => import('./pages/ComplaintDetail.jsx')));
const Team = lazy(loadFresh(() => import('./pages/Team.jsx')));
const Settings = lazy(loadFresh(() => import('./pages/Settings.jsx')));
const Account = lazy(loadFresh(() => import('./pages/Account.jsx')));
const ScanPage = lazy(loadFresh(() => import('./pages/ScanPage.jsx')));
const QuotePortal = lazy(loadFresh(() => import('./pages/Portal.jsx').then((m) => ({ default: m.QuotePortal }))));
const OrderPortal = lazy(loadFresh(() => import('./pages/Portal.jsx').then((m) => ({ default: m.OrderPortal }))));

function Guard({ perm, module, children }) {
  const { can } = useAuth();
  const meta = useMeta();
  // A module that is switched off is simply not there; old links land on the dashboard.
  if (module && !meta.settings.modules?.[module]) return <Navigate to="/" replace />;
  if (perm && !can(...[].concat(perm))) {
    return <EmptyState icon="lock" title="Not available for your role" message="Your access does not include this area. Ask an administrator if you need it." action={<Button to="/">Back to dashboard</Button>} />;
  }
  return children;
}

function PrivateShell() {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner label="Starting…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <MetaProvider>
      <QuickEntryProvider>
        <Layout>
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </Layout>
      </QuickEntryProvider>
    </MetaProvider>
  );
}

function LoginRoute() {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (user) return <Navigate to={location.state?.from || '/'} replace />;
  return <Login />;
}

/** Customer-facing pages: no sign-in, no app chrome. */
function PublicShell() {
  return (
    <Suspense fallback={<Spinner />}>
      <Outlet />
    </Suspense>
  );
}

/** Shown instead of a page that failed: after an update, or any other error. */
function PageError() {
  const error = useRouteError();
  const update = isMissingUpdate(error);
  return (
    <div className="error-page">
      <EmptyState icon="refresh" title={update ? 'The CRM has been updated' : 'Something went wrong on this page'}
        message={update ? 'Reload the page to get the new version.' : 'Reload the page to try again. If it happens again, tell your administrator what you were doing.'}
        action={<div className="row"><Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload</Button><Button onClick={() => window.location.assign('/')}>Dashboard</Button></div>} />
    </div>
  );
}

const g = (perm, el, module) => <Guard perm={perm} module={module}>{el}</Guard>;
const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute />, errorElement: <PageError /> },
  {
    element: <PublicShell />,
    errorElement: <PageError />,
    children: [
      { path: '/o/:publicId', element: <ScanPage /> },
      { path: '/portal/quote/:token', element: <QuotePortal /> },
      { path: '/portal/order/:token', element: <OrderPortal /> },
    ],
  },
  {
    path: '/',
    element: <PrivateShell />,
    errorElement: <PageError />,
    children: [
      { index: true, element: g('dashboard.view', <Overview />) },
      { path: 'queue', element: g('queue.view', <WorkQueue />, 'workQueue') },
      { path: 'followups', element: g('tasks.edit', <Followups />) },
      { path: 'analytics', element: g('analytics.view', <Dashboard />, 'salesDashboard') },
      { path: 'past-customers', element: g('past.view', <PastCustomers />, 'pastCustomers') },
      { path: 'pipeline', element: g(['enquiries.view', 'orders.view'], <Pipeline />) },
      { path: 'enquiries', element: g('enquiries.view', <Enquiries />) },
      { path: 'enquiries/:id', element: g('enquiries.view', <EnquiryDetail />) },
      { path: 'quotations', element: g('quotes.view', <Quotations />) },
      { path: 'quotations/new', element: g('quotes.edit', <QuotationBuilder />) },
      { path: 'quotations/:id/edit', element: g('quotes.edit', <QuotationBuilder />) },
      { path: 'quotations/:id', element: g('quotes.view', <QuotationDetail />) },
      { path: 'orders', element: g('orders.view', <Orders />) },
      { path: 'orders/new', element: g('orders.edit', <NewOrder />) },
      { path: 'orders/:id', element: g('orders.view', <OrderDetail />) },
      { path: 'production', element: g('orders.view', <Production />) },
      { path: 'dispatches', element: g('orders.view', <Dispatches />) },
      { path: 'customers', element: g('customers.view', <Customers />) },
      { path: 'customers/:id', element: g('customers.view', <CustomerProfile />) },
      { path: 'contacts', element: g('customers.view', <Contacts />, 'contacts') },
      { path: 'campaigns', element: g('campaigns.view', <Campaigns />) },
      { path: 'campaigns/:id', element: g('campaigns.view', <CampaignDetail />) },
      { path: 'products', element: g('products.view', <Products />) },
      { path: 'products/:id', element: g('products.view', <ProductDetail />) },
      { path: 'objects', element: g('objects.view', <Objects />) },
      { path: 'objects/labels', element: g('objects.view', <ObjectLabels />) },
      { path: 'objects/:id', element: g('objects.view', <ObjectDetail />) },
      { path: 'reports', element: g('reports.view', <Reports />, 'reports') },
      { path: 'payments', element: g('finance.view', <Payments />, 'payments') },
      { path: 'complaints', element: g('complaints.view', <Complaints />, 'complaints') },
      { path: 'complaints/:id', element: g('complaints.view', <ComplaintDetail />, 'complaints') },
      { path: 'team', element: g(['team.view', 'quotes.approve'], <Team />, 'team') },
      { path: 'settings', element: g('settings.manage', <Settings />) },
      { path: 'account', element: <Account /> },
      { path: '*', element: <EmptyState icon="search" title="Page not found" action={<Button to="/">Go to dashboard</Button>} /> },
    ],
  },
]);

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
