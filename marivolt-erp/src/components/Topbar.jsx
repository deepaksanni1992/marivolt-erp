import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import UserMenu from "./UserMenu.jsx";
import { notify } from "../lib/notifications.js";
import { defaultHomePathForRole, isStoreOperatorRole } from "../lib/rbac.js";

export default function Topbar({ onMenuClick }) {
  const nav = useNavigate();
  const { auth, selectCompany, role } = useAuth();
  const [headerQ, setHeaderQ] = useState("");
  const storeOnly = isStoreOperatorRole(role);

  function submitHeaderSearch(e) {
    e?.preventDefault?.();
    if (storeOnly) return;
    const q = headerQ.trim();
    if (!q) return;
    nav(`/search?q=${encodeURIComponent(q)}`);
  }

  async function onSwitchCompany(e) {
    const nextCompanyId = e.target.value;
    if (!nextCompanyId || nextCompanyId === auth?.company?.id) return;
    try {
      const data = await selectCompany(nextCompanyId);
      nav(defaultHomePathForRole(data?.user?.role || role));
    } catch (err) {
      notify.error(err.message || "Failed to switch company");
    }
  }

  return (
    <header className="sticky top-0 z-30 h-16 border-b bg-white/90 backdrop-blur">
      <div className="flex h-full items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-2">
          <button
            className="md:hidden rounded-lg border px-3 py-2 text-sm"
            onClick={onMenuClick}
          >
            ☰
          </button>
          <img
            src="/marivolt-logo.png"
            alt="Marivolt logo"
            className="h-7 w-7 rounded-md object-contain"
          />
          <div className="font-semibold">Marivoltz ERP</div>
          {auth?.company?.name && (
            <span className="ml-2 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
              {auth.company.name} ({auth.company.code})
            </span>
          )}
        </div>

        {!storeOnly ? (
          <form onSubmit={submitHeaderSearch} className="mx-4 hidden flex-1 max-w-xl md:flex">
            <input
              type="search"
              value={headerQ}
              onChange={(e) => setHeaderQ(e.target.value)}
              placeholder="Search ERP — document, article, customer, BL, BOE…"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
            />
          </form>
        ) : (
          <div className="mx-4 hidden flex-1 md:block" />
        )}

        <div className="flex items-center gap-3">
          {!!auth?.companies?.length && (
            <select
              className="rounded-xl border px-3 py-2 text-sm"
              value={auth?.company?.id || ""}
              onChange={onSwitchCompany}
            >
              {auth.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          )}
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
