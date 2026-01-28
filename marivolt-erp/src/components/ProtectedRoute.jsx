import { Navigate, Outlet } from "react-router-dom";

const AUTH_KEY = "marivoltz_auth_v1";

export default function ProtectedRoute() {
  let auth = null;
  try {
    auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
  } catch {
    auth = null;
  }

  if (!auth?.user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
