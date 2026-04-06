import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./components/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

import Login from "./pages/Login.jsx";

import Dashboard from "./pages/Dashboard.jsx";
import Sales from "./pages/Sales.jsx";
import Purchase from "./pages/Purchase.jsx";
import Inventory from "./pages/Inventory.jsx";
import Store from "./pages/Store.jsx";
import Accounts from "./pages/Accounts.jsx";
import Logistics from "./pages/Logistics.jsx";
import RequireRole from "./components/RequireRole";

import VerticalMaster from "./pages/masters/VerticalMaster.jsx";
import BrandMaster from "./pages/masters/BrandMaster.jsx";
import EngineModelMaster from "./pages/masters/EngineModelMaster.jsx";
import SpnMaster from "./pages/masters/SpnMaster.jsx";
import MaterialMaster from "./pages/masters/MaterialMaster.jsx";
import MaterialCompatMaster from "./pages/masters/MaterialCompatMaster.jsx";
import ArticleMaster from "./pages/masters/ArticleMaster.jsx";
import SupplierMappingMaster from "./pages/masters/SupplierMappingMaster.jsx";
import ResolveMaterial from "./pages/masters/ResolveMaterial.jsx";

const masterRole = ["admin"];
const resolveRole = ["admin", "staff", "purchase_sales"];

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected */}
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />

          <Route
            path="vertical-master"
            element={
              <RequireRole allow={masterRole}>
                <VerticalMaster />
              </RequireRole>
            }
          />
          <Route
            path="brand-master"
            element={
              <RequireRole allow={masterRole}>
                <BrandMaster />
              </RequireRole>
            }
          />
          <Route
            path="engine-models-master"
            element={
              <RequireRole allow={masterRole}>
                <EngineModelMaster />
              </RequireRole>
            }
          />
          <Route
            path="spn-master"
            element={
              <RequireRole allow={masterRole}>
                <SpnMaster />
              </RequireRole>
            }
          />
          <Route
            path="material-master"
            element={
              <RequireRole allow={masterRole}>
                <MaterialMaster />
              </RequireRole>
            }
          />
          <Route
            path="material-compat"
            element={
              <RequireRole allow={masterRole}>
                <MaterialCompatMaster />
              </RequireRole>
            }
          />
          <Route
            path="article-master"
            element={
              <RequireRole allow={masterRole}>
                <ArticleMaster />
              </RequireRole>
            }
          />
          <Route
            path="supplier-mapping"
            element={
              <RequireRole allow={masterRole}>
                <SupplierMappingMaster />
              </RequireRole>
            }
          />
          <Route
            path="resolve-material"
            element={
              <RequireRole allow={resolveRole}>
                <ResolveMaterial />
              </RequireRole>
            }
          />

          <Route
            path="items"
            element={<Navigate to="/article-master" replace />}
          />
          <Route
            path="sales"
            element={
              <RequireRole allow={["admin", "staff", "purchase_sales"]}>
                <Sales />
              </RequireRole>
            }
          />
          <Route
            path="purchase"
            element={
              <RequireRole allow={["admin", "staff", "purchase_sales"]}>
                <Purchase />
              </RequireRole>
            }
          />
          <Route
            path="inventory"
            element={
              <RequireRole allow={["admin", "staff"]}>
                <Inventory />
              </RequireRole>
            }
          />
          <Route
            path="store"
            element={
              <RequireRole allow={["admin", "staff"]}>
                <Store />
              </RequireRole>
            }
          />
          <Route
            path="accounts"
            element={
              <RequireRole allow={["admin", "staff", "accounts_logistics"]}>
                <Accounts />
              </RequireRole>
            }
          />
          <Route
            path="logistics"
            element={
              <RequireRole allow={["admin", "staff", "accounts_logistics"]}>
                <Logistics />
              </RequireRole>
            }
          />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
