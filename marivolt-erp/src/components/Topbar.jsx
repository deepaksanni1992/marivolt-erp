import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";

export default function Topbar({ onMenuClick }) {
  const nav = useNavigate();
  const { auth, logout, selectCompany } = useAuth();
  const [headerQ, setHeaderQ] = useState("");

  function submitHeaderSearch(e) {
    e?.preventDefault?.();
    const q = headerQ.trim();
    if (!q) return;
    nav(`/search?q=${encodeURIComponent(q)}`);
  }

  function onLogout() {
    logout();
    nav("/login");
  }

  async function onSwitchCompany(e) {
    const nextCompanyId = e.target.value;
    if (!nextCompanyId || nextCompanyId === auth?.company?.id) return;
    try {
      await selectCompany(nextCompanyId);
      nav("/dashboard");
    } catch (err) {
      window.alert(err.message || "Failed to switch company");
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

        <form onSubmit={submitHeaderSearch} className="mx-4 hidden flex-1 max-w-xl md:flex">
          <input
            type="search"
            value={headerQ}
            onChange={(e) => setHeaderQ(e.target.value)}
            placeholder="Search ERP — document, article, customer, BL, BOE…"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:bg-white"
          />
        </form>

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
          <button
            type="button"
            onClick={() => nav("/profile/security")}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Security
          </button>
          <button
            onClick={onLogout}
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Logout
          </button>
          <div className="h-9 w-9 rounded-full bg-gray-200" />
        </div>
      </div>
    </header>
  );
}
