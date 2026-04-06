const AUTH_KEY = "marivoltz_auth_v1";

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
        You are signed in{label ? ` as ${label}` : ""}. Operational modules are not
        exposed in this build (shell only).
      </p>
      <p className="mt-4 text-sm text-gray-500">
        API: <code className="rounded bg-gray-100 px-1">GET /api/health</code> and{" "}
        <code className="rounded bg-gray-100 px-1">/api/auth/*</code> only.
      </p>
    </div>
  );
}
