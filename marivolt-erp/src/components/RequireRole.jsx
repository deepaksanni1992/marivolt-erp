// src/components/RequireRole.jsx
import { Navigate } from "react-router-dom";

const AUTH_KEY = "marivoltz_auth_v1";

function getUser() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.user || null;
  } catch {
    return null;
  }
}

export default function RequireRole({ allow = [], children }) {
  const user = getUser();

  // 1) Not logged in → go to login
  if (!user) return <Navigate to="/login" replace />;

  // 2) Role not allowed → show Access Denied UI
  const userRole = String(user.role || "").toLowerCase();
  const allowedRoles = allow.map((r) => String(r).toLowerCase());

  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    return (
      <div className="rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Access Denied</h1>
        <p className="mt-2 text-gray-600">
          You don&apos;t have permission to open this page.
        </p>
        <p className="mt-2 text-gray-600">
          Your role: <b>{user.role}</b>
        </p>
      </div>
    );
  }
  

  // 3) Allowed → show page
  return children;
}
