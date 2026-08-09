import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { defaultHomePathForRole, isStoreOperatorRole, storeOperatorAllowedPath } from "../lib/rbac.js";

export default function ProtectedRoute() {
  const { isLoggedIn, requiresCompanySelection, requires2FA, authReady, role } = useAuth();
  const location = useLocation();

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 text-sm text-gray-600">
        Checking session…
      </div>
    );
  }
  if (requires2FA) {
    return <Navigate to="/verify-2fa" replace />;
  }
  if (requiresCompanySelection) {
    return <Navigate to="/select-company" replace />;
  }
  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (isStoreOperatorRole(role) && !storeOperatorAllowedPath(location.pathname)) {
    return <Navigate to={defaultHomePathForRole(role)} replace />;
  }

  return <Outlet />;
}
