import { Navigate, Outlet } from "react-router-dom";
import { AUTH_KEY } from "../lib/api.js";

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
