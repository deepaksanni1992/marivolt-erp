import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./components/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { useAuth } from "./context/AuthContext.jsx";
import { defaultHomePathForRole } from "./lib/rbac.js";

import Login from "./pages/Login.jsx";
import TwoFactorVerify from "./pages/TwoFactorVerify.jsx";
import CompanySelect from "./pages/CompanySelect.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import DataHealthDashboard from "./pages/DataHealthDashboard.jsx";
import StockBucketIntegrity from "./pages/StockBucketIntegrity.jsx";
import ReservationIntegrity from "./pages/ReservationIntegrity.jsx";
import ItemMaster from "./pages/ItemMaster.jsx";
import ProcurementFoundation from "./pages/ProcurementFoundation.jsx";
import Sales from "./pages/Sales.jsx";
import Inventory from "./pages/Inventory.jsx";
import Store from "./pages/StoreModule.jsx";
import AsnPage from "./pages/Asn.jsx";
import CustomsDashboard from "./pages/CustomsDashboard.jsx";
import CustomsStock from "./pages/CustomsStock.jsx";
import CustomsStockLedger from "./pages/CustomsStockLedger.jsx";
import CustomsInvoice from "./pages/CustomsInvoice.jsx";
import CustomsAllocationReports from "./pages/CustomsAllocationReports.jsx";
import CustomsReconciliation from "./pages/CustomsReconciliation.jsx";
import GlobalSearch from "./pages/GlobalSearch.jsx";
import ArticleTraceability from "./pages/ArticleTraceability.jsx";
import Logistics from "./pages/Logistics.jsx";
import Accounts from "./pages/Accounts.jsx";
import BOMPage from "./pages/BOM.jsx";
import Kitting from "./pages/Kitting.jsx";
import DeKitting from "./pages/DeKitting.jsx";
import Documents from "./pages/Documents.jsx";
import AuditTrail from "./pages/AuditTrail.jsx";
import Settings from "./pages/Settings.jsx";
import MyProfile from "./pages/MyProfile.jsx";
import ProfileSecurity from "./pages/ProfileSecurity.jsx";

function HomeRedirect() {
  const { role } = useAuth();
  return <Navigate to={defaultHomePathForRole(role)} replace />;
}

function CatchAllRedirect() {
  const { isLoggedIn, requiresCompanySelection, requires2FA, authReady, role } = useAuth();
  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 text-sm text-gray-600">
        Checking session…
      </div>
    );
  }
  if (requiresCompanySelection) return <Navigate to="/select-company" replace />;
  if (requires2FA) return <Navigate to="/verify-2fa" replace />;
  if (isLoggedIn) return <Navigate to={defaultHomePathForRole(role)} replace />;
  return <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/verify-2fa" element={<TwoFactorVerify />} />
      <Route path="/select-company" element={<CompanySelect />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<HomeRedirect />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="dashboard/data-health" element={<DataHealthDashboard />} />
          <Route path="dashboard/stock-bucket-integrity" element={<StockBucketIntegrity />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="inventory/integrity/reservation" element={<ReservationIntegrity />} />
          <Route path="items" element={<ItemMaster />} />
          <Route path="purchase" element={<ProcurementFoundation />} />
          <Route path="asn" element={<AsnPage />} />
          <Route path="asn/:id" element={<AsnPage />} />
          <Route path="sales" element={<Sales />} />
          <Route path="store" element={<Store />} />
          <Route path="customs/dashboard" element={<CustomsDashboard />} />
          <Route path="customs/stock" element={<CustomsStock />} />
          <Route path="customs/ledger" element={<CustomsStockLedger />} />
          <Route path="customs/invoices" element={<CustomsInvoice />} />
          <Route path="customs/invoices/:id" element={<CustomsInvoice />} />
          <Route path="customs/allocation-reports" element={<CustomsAllocationReports />} />
          <Route path="customs/reconciliation" element={<CustomsReconciliation />} />
          <Route path="search" element={<GlobalSearch />} />
          <Route path="traceability/article" element={<ArticleTraceability />} />
          <Route path="logistics" element={<Logistics />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="documents" element={<Documents />} />
          <Route path="bom" element={<BOMPage />} />
          <Route path="kitting" element={<Kitting />} />
          <Route path="dekitting" element={<DeKitting />} />
          <Route path="audit" element={<AuditTrail />} />
          <Route path="settings" element={<Settings />} />
          <Route path="profile" element={<MyProfile />} />
          <Route path="profile/security" element={<ProfileSecurity />} />
        </Route>
      </Route>

      <Route path="*" element={<CatchAllRedirect />} />
    </Routes>
  );
}
