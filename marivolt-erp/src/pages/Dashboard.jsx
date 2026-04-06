import { AUTH_KEY } from "../lib/api.js";

function getUserLabel() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    const u = auth?.user;
    if (!u) return "";
    return u.name || u.email || u.username || "";
  } catch {
    return "";
  }
}

export default function Dashboard() {
  const label = getUserLabel();

  return (
    <div className="rounded-2xl border bg-white p-8">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        You are signed in{label ? ` as ${label}` : ""}. Use the sidebar to open Item Master,
        Purchase, Sales, Inventory, Logistics, Accounts, BOM, Kitting, and De-Kitting.
      </p>
      <p className="mt-4 text-sm text-gray-500">
        API base: <code className="rounded bg-gray-100 px-1">/api/*</code> with JWT from login.
      </p>
    </div>
  );
}
