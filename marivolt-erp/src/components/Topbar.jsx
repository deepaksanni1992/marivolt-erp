import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function Topbar({ onMenuClick }) {
  const nav = useNavigate();
  const { auth, logout, selectCompany } = useAuth();

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
      // eslint-disable-next-line no-alert
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
