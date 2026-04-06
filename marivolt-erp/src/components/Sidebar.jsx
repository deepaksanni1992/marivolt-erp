import { NavLink } from "react-router-dom";

export default function Sidebar({ open, onClose }) {
  return (
    <aside
      className={[
        "fixed z-50 h-screen w-64 border-r bg-white",
        "md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
        "transition-transform duration-200 ease-in-out",
      ].join(" ")}
    >
      <div className="flex h-16 items-center justify-between px-4 border-b">
        <div className="flex items-center gap-2">
          <img
            src="/marivolt-logo.png"
            alt="Marivolt logo"
            className="h-9 w-9 rounded-lg object-contain"
          />
          <div>
            <div className="text-sm font-semibold leading-4">Marivoltz</div>
            <div className="text-xs text-gray-500">ERP</div>
          </div>
        </div>

        <button
          className="md:hidden rounded-lg px-2 py-1 text-sm border"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <nav className="max-h-[calc(100vh-4rem)] overflow-y-auto p-3">
        <div className="mb-2 px-2 text-xs font-semibold text-gray-500">Menu</div>
        <ul className="space-y-1">
          <li>
            <NavLink
              to="/dashboard"
              className={({ isActive }) =>
                [
                  "block rounded-xl px-3 py-2 text-sm",
                  isActive
                    ? "bg-gray-900 text-white"
                    : "text-gray-700 hover:bg-gray-100",
                ].join(" ")
              }
              onClick={onClose}
            >
              Dashboard
            </NavLink>
          </li>
        </ul>
      </nav>
    </aside>
  );
}
