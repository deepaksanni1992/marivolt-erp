import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./components/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

import Login from "./pages/Login.jsx";

import Dashboard from "./pages/Dashboard.jsx";
import ItemMaster from "./pages/ItemMaster.jsx";
import Sales from "./pages/Sales.jsx";
import Purchase from "./pages/Purchase.jsx";
import Inventory from "./pages/Inventory.jsx";
import Store from "./pages/Store.jsx";
import Accounts from "./pages/Accounts.jsx";
import Logistics from "./pages/Logistics.jsx";
import RequireRole from "./components/RequireRole";

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
    path="items"
    element={
      <RequireRole allow={["admin"]}>
        <ItemMaster />
      </RequireRole>
    }
  />
          <Route path="sales" element={<Sales />} />
          <Route path="purchase" element={<Purchase />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="store" element={<Store />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="logistics" element={<Logistics />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
