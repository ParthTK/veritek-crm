import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ConfirmProvider, Spinner, ToastProvider, EmptyState, Button } from './components/ui.jsx';
import { MetaProvider } from './components/domain.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Leads = lazy(() => import('./pages/Leads.jsx'));
const LeadDetail = lazy(() => import('./pages/LeadDetail.jsx'));
const Opportunities = lazy(() => import('./pages/Opportunities.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail.jsx'));
const Contacts = lazy(() => import('./pages/Contacts.jsx'));
const Followups = lazy(() => import('./pages/Followups.jsx'));
const Quotations = lazy(() => import('./pages/Quotations.jsx'));
const QuotationBuilder = lazy(() => import('./pages/QuotationBuilder.jsx'));
const QuotationDetail = lazy(() => import('./pages/QuotationDetail.jsx'));
const Orders = lazy(() => import('./pages/Orders.jsx'));
const OrderDetail = lazy(() => import('./pages/OrderDetail.jsx'));
const Production = lazy(() => import('./pages/Production.jsx'));
const Dispatches = lazy(() => import('./pages/Dispatches.jsx'));
const Payments = lazy(() => import('./pages/Payments.jsx'));
const Products = lazy(() => import('./pages/Products.jsx'));
const Campaigns = lazy(() => import('./pages/Campaigns.jsx'));
const CampaignDetail = lazy(() => import('./pages/CampaignDetail.jsx'));
const Complaints = lazy(() => import('./pages/Complaints.jsx'));
const ComplaintDetail = lazy(() => import('./pages/ComplaintDetail.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Team = lazy(() => import('./pages/Team.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const QuotePortal = lazy(() => import('./pages/Portal.jsx').then((m) => ({ default: m.QuotePortal })));
const OrderPortal = lazy(() => import('./pages/Portal.jsx').then((m) => ({ default: m.OrderPortal })));

function Guard({ perm, children }) {
  const { can } = useAuth();
  if (perm && !can(perm)) {
    return <EmptyState icon="shield" title="No access" message="Your role does not include this module. Ask an administrator if you need it." action={<Button to="/">Back to dashboard</Button>} />;
  }
  return children;
}

function Private() {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner label="Starting…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return (
    <MetaProvider>
      <Layout>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/leads" element={<Guard perm="leads.view"><Leads /></Guard>} />
            <Route path="/leads/:id" element={<Guard perm="leads.view"><LeadDetail /></Guard>} />
            <Route path="/opportunities" element={<Guard perm="leads.view"><Opportunities /></Guard>} />
            <Route path="/customers" element={<Guard perm="customers.view"><Customers /></Guard>} />
            <Route path="/customers/:id" element={<Guard perm="customers.view"><CustomerDetail /></Guard>} />
            <Route path="/contacts" element={<Guard perm="customers.view"><Contacts /></Guard>} />
            <Route path="/followups" element={<Followups />} />
            <Route path="/quotations" element={<Guard perm="quotations.view"><Quotations /></Guard>} />
            <Route path="/quotations/new" element={<Guard perm="quotations.edit"><QuotationBuilder /></Guard>} />
            <Route path="/quotations/:id/edit" element={<Guard perm="quotations.edit"><QuotationBuilder /></Guard>} />
            <Route path="/quotations/:id" element={<Guard perm="quotations.view"><QuotationDetail /></Guard>} />
            <Route path="/orders" element={<Guard perm="orders.view"><Orders /></Guard>} />
            <Route path="/orders/:id" element={<Guard perm="orders.view"><OrderDetail /></Guard>} />
            <Route path="/production" element={<Guard perm="production.view"><Production /></Guard>} />
            <Route path="/dispatches" element={<Guard perm="dispatch.view"><Dispatches /></Guard>} />
            <Route path="/payments" element={<Guard perm="payments.view"><Payments /></Guard>} />
            <Route path="/products" element={<Guard perm="products.view"><Products /></Guard>} />
            <Route path="/campaigns" element={<Guard perm="campaigns.view"><Campaigns /></Guard>} />
            <Route path="/campaigns/:id" element={<Guard perm="campaigns.view"><CampaignDetail /></Guard>} />
            <Route path="/complaints" element={<Guard perm="complaints.view"><Complaints /></Guard>} />
            <Route path="/complaints/:id" element={<Guard perm="complaints.view"><ComplaintDetail /></Guard>} />
            <Route path="/reports" element={<Guard perm="reports.view"><Reports /></Guard>} />
            <Route path="/team" element={<Guard perm="team.view"><Team /></Guard>} />
            <Route path="/settings" element={<Guard perm="settings.edit"><Settings /></Guard>} />
            <Route path="/account" element={<Account />} />
            <Route path="*" element={<EmptyState icon="search" title="Page not found" action={<Button to="/">Go to dashboard</Button>} />} />
          </Routes>
        </Suspense>
      </Layout>
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

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <Suspense fallback={<Spinner />}>
              <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route path="/portal/quote/:token" element={<QuotePortal />} />
                <Route path="/portal/order/:token" element={<OrderPortal />} />
                <Route path="/*" element={<Private />} />
              </Routes>
            </Suspense>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
