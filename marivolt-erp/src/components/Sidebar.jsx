import { NavLink } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { isStoreOperatorRole } from "../lib/rbac.js";
import { SIDEBAR_NAV, filterSidebarNav } from "../lib/rbacAccess.js";

function linkClass(isActive) {
  return ["erp-sidebar__link", isActive ? "erp-sidebar__link--active" : ""].filter(Boolean).join(" ");
}

export default function Sidebar({ open, onClose }) {
  const { role, can, permissionsReady, permissionFailed } = useAuth();
  const storeOnly = permissionsReady && isStoreOperatorRole(role);
  const [openGroups, setOpenGroups] = useState(() => ({
    dashboard: true,
    inventory: true,
    master: true,
    sales: true,
    customs: true,
    documents: true,
  }));

  const nav =
    permissionsReady && !permissionFailed
      ? filterSidebarNav(SIDEBAR_NAV, { role, can, permissionsReady: true })
      : [];

  function toggleGroup(id) {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <aside
      className={[
        "erp-sidebar fixed z-50 h-screen w-64 border-r",
        "md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
        "transition-transform duration-200 ease-in-out",
      ].join(" ")}
    >
      <div className="erp-sidebar__logo flex h-16 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <img src="/marivolt-logo.png" alt="Marivolt logo" className="h-9 w-9 rounded-lg object-contain" />
          <div>
            <div className="text-sm font-semibold leading-4">Marivoltz</div>
            <div className="erp-sidebar__subtitle text-xs">ERP</div>
          </div>
        </div>
        <button
          type="button"
          className="erp-sidebar__close-btn rounded-lg border px-2 py-1 text-sm md:hidden"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <nav className="max-h-[calc(100vh-4rem)] overflow-y-auto p-3">
        <div className="erp-sidebar__section-header mb-2 px-2 text-xs">Menu</div>
        <ul className="erp-sidebar__menu">
          {permissionFailed ? (
            <li className="px-2 py-2 text-xs text-slate-500" data-testid="sidebar-permissions-failed">
              Permissions unavailable
            </li>
          ) : !permissionsReady ? (
            <li className="px-2 py-2 text-xs text-slate-500" data-testid="sidebar-permissions-loading">
              Loading permissions…
            </li>
          ) : storeOnly ? (
            <li>
              <NavLink to="/store" className={({ isActive }) => linkClass(isActive)} onClick={onClose}>
                Store
              </NavLink>
            </li>
          ) : (
            nav.map((entry) => {
              if (entry.type === "group") {
                const expanded = openGroups[entry.id] !== false;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="erp-sidebar__group-btn"
                      onClick={() => toggleGroup(entry.id)}
                    >
                      <span>{entry.label}</span>
                      <span className="erp-sidebar__chevron">{expanded ? "▾" : "▸"}</span>
                    </button>
                    {expanded ? (
                      <ul className="erp-sidebar__submenu">
                        {entry.items.map(({ to, label }) => (
                          <li key={to}>
                            <NavLink
                              to={to}
                              className={({ isActive }) => linkClass(isActive)}
                              onClick={onClose}
                              end={to === "/dashboard" || to === "/inventory" || to === "/sales" || to === "/documents"}
                            >
                              {label}
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              }
              return (
                <li key={entry.to}>
                  <NavLink to={entry.to} className={({ isActive }) => linkClass(isActive)} onClick={onClose}>
                    {entry.label}
                  </NavLink>
                </li>
              );
            })
          )}
        </ul>
      </nav>
    </aside>
  );
}
