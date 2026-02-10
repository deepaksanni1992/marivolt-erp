import { useNavigate } from "react-router-dom";

const AUTH_KEY = "marivoltz_auth_v1";

export default function Topbar({ onMenuClick }) {
  const nav = useNavigate();

  function logout() {
    localStorage.removeItem(AUTH_KEY);
    nav("/login");
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
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={logout}
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
