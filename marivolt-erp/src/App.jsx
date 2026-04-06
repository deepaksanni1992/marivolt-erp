import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./components/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ItemMaster from "./pages/ItemMaster.jsx";
import Purchase from "./pages/Purchase.jsx";
import Sales from "./pages/Sales.jsx";
import Inventory from "./pages/Inventory.jsx";
import Logistics from "./pages/Logistics.jsx";
import Accounts from "./pages/Accounts.jsx";
import BOMPage from "./pages/BOM.jsx";
import Kitting from "./pages/Kitting.jsx";
import DeKitting from "./pages/DeKitting.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="items" element={<ItemMaster />} />
          <Route path="purchase" element={<Purchase />} />
          <Route path="sales" element={<Sales />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="logistics" element={<Logistics />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="bom" element={<BOMPage />} />
          <Route path="kitting" element={<Kitting />} />
          <Route path="dekitting" element={<DeKitting />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
