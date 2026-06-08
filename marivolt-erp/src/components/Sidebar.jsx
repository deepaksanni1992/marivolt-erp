import { NavLink } from "react-router-dom";
import { useState } from "react";

const dashboardGroup = {
  label: "Dashboard",
  items: [
    { to: "/dashboard", label: "ERP BI Dashboard" },
    { to: "/customs/dashboard", label: "Customs Dashboard" },
    { to: "/dashboard/data-health", label: "Data Health Dashboard" },
  ],
};

const flatLinks = [
  { to: "/items", label: "Item Master" },
  { to: "/purchase", label: "Purchase" },
  { to: "/sales", label: "Sales" },
  { to: "/store", label: "Store" },
  { to: "/logistics", label: "Logistics" },
  { to: "/accounts", label: "Accounts" },
  { to: "/bom", label: "BOM" },
  { to: "/kitting", label: "Kitting" },
  { to: "/dekitting", label: "De-Kitting" },
  { to: "/audit", label: "Audit Trail" },
  { to: "/settings", label: "Settings" },
];

const customsGroup = {
  label: "Customs",
  items: [
    { to: "/customs/stock", label: "Customs Stock" },
    { to: "/customs/ledger", label: "Customs Stock Ledger" },
    { to: "/customs/invoices", label: "Customs Invoice" },
    { to: "/customs/reconciliation", label: "Customs Reconciliation" },
  ],
};

const documentsGroup = {
  label: "Documents",
  items: [
    { to: "/documents", label: "Documents" },
    { to: "/traceability/article", label: "Article Traceability" },
  ],
};

function linkClass(isActive) {
  return [
    "block rounded-xl px-3 py-2 text-sm",
    isActive ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100",
  ].join(" ");
}

export default function Sidebar({ open, onClose }) {
  const [dashboardOpen, setDashboardOpen] = useState(true);
  const [customsOpen, setCustomsOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(true);

  return (
    <aside
      className={[
        "fixed z-50 h-screen w-64 border-r bg-white",
        "md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
        "transition-transform duration-200 ease-in-out",
      ].join(" ")}
    >
      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <img src="/marivolt-logo.png" alt="Marivolt logo" className="h-9 w-9 rounded-lg object-contain" />
          <div>
            <div className="text-sm font-semibold leading-4">Marivoltz</div>
            <div className="text-xs text-gray-500">ERP</div>
          </div>
        </div>
        <button className="rounded-lg border px-2 py-1 text-sm md:hidden" onClick={onClose}>
          Close
        </button>
      </div>

      <nav className="max-h-[calc(100vh-4rem)] overflow-y-auto p-3">
        <div className="mb-2 px-2 text-xs font-semibold text-gray-500">Menu</div>
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => setDashboardOpen((v) => !v)}
            >
              <span>{dashboardGroup.label}</span>
              <span className="text-xs text-gray-400">{dashboardOpen ? "▾" : "▸"}</span>
            </button>
            {dashboardOpen ? (
              <ul className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-2">
                {dashboardGroup.items.map(({ to, label }) => (
                  <li key={to}>
                    <NavLink to={to} className={({ isActive }) => linkClass(isActive)} onClick={onClose} end={to === "/dashboard"}>
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>

          {flatLinks.slice(0, 5).map(({ to, label }) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => linkClass(isActive)} onClick={onClose}>
                {label}
              </NavLink>
            </li>
          ))}

          <li>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => setCustomsOpen((v) => !v)}
            >
              <span>{customsGroup.label}</span>
              <span className="text-xs text-gray-400">{customsOpen ? "▾" : "▸"}</span>
            </button>
            {customsOpen ? (
              <ul className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-2">
                {customsGroup.items.map(({ to, label }) => (
                  <li key={to}>
                    <NavLink to={to} className={({ isActive }) => linkClass(isActive)} onClick={onClose}>
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>

          <li>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
              onClick={() => setDocumentsOpen((v) => !v)}
            >
              <span>{documentsGroup.label}</span>
              <span className="text-xs text-gray-400">{documentsOpen ? "▾" : "▸"}</span>
            </button>
            {documentsOpen ? (
              <ul className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-2">
                {documentsGroup.items.map(({ to, label }) => (
                  <li key={to}>
                    <NavLink to={to} className={({ isActive }) => linkClass(isActive)} onClick={onClose} end={to === "/documents"}>
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>

          {flatLinks.slice(5).map(({ to, label }) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => linkClass(isActive)} onClick={onClose}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
