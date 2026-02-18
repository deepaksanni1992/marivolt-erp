import { NavLink } from "react-router-dom";

const AUTH_KEY = "marivoltz_auth_v1";

function getRole() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.user?.role || "staff";
  } catch {
    return "staff";
  }
}

export default function Sidebar({ open, onClose }) {
  const role = getRole();

  const navItems = [
    { name: "Dashboard", to: "/dashboard", roles: ["admin", "staff", "purchase_sales", "accounts_logistics"] },
    { name: "Sales", to: "/sales", roles: ["admin", "staff", "purchase_sales"] },
    { name: "Purchase", to: "/purchase", roles: ["admin", "staff", "purchase_sales"] },
    { name: "Inventory", to: "/inventory", roles: ["admin", "staff"] },
    { name: "Store", to: "/store", roles: ["admin", "staff"] },
    { name: "Logistics (Import/Export)", to: "/logistics", roles: ["admin", "staff", "accounts_logistics"] },
    { name: "Item Master", to: "/items", roles: ["admin", "staff"] },
    { name: "Accounts", to: "/accounts", roles: ["admin", "staff", "accounts_logistics"] },
  ];

  const visibleItems = navItems.filter((x) => x.roles.includes(role));

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
            <div className="text-xs text-gray-500">
              ERP System • <b>{role}</b>
            </div>
          </div>
        </div>

        <button
          className="md:hidden rounded-lg px-2 py-1 text-sm border"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <nav className="p-3">
        <div className="mb-2 px-2 text-xs font-semibold text-gray-500">
          MODULES
        </div>

        <ul className="space-y-1">
          {visibleItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
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
                {item.name}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
