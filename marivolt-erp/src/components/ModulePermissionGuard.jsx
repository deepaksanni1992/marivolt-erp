import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { canAccessPath } from "../lib/rbacAccess.js";
import AccessDenied from "../pages/AccessDenied.jsx";

export default function ModulePermissionGuard({ children }) {
  const { role, can, permissionsReady, permissionFailed, logout } = useAuth();
  const location = useLocation();
  const pathname = location.pathname || "/";
  const isProfile = pathname === "/profile" || pathname.startsWith("/profile/");

  if (pathname === "/") return children;
  if (isProfile) return children;

  if (permissionFailed) {
    return (
      <div
        className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800"
        data-testid="permissions-failed"
      >
        <h1 className="text-xl font-semibold">Permissions unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your access list could not be loaded. No modules are available until this succeeds. Sign in
          again or retry.
        </p>
        <button
          type="button"
          className="mt-4 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() => logout()}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (!permissionsReady) {
    return (
      <div className="py-10 text-center text-sm text-slate-600" data-testid="permissions-loading">
        Checking permissions…
      </div>
    );
  }

  if (!canAccessPath(pathname, { role, can, permissionsReady: true })) {
    return <AccessDenied />;
  }

  return children;
}
