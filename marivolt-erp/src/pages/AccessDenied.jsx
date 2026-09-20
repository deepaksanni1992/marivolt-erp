import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { firstAuthorizedPath } from "../lib/rbacAccess.js";

export default function AccessDenied() {
  const { role, can, permissionsReady } = useAuth();
  const home = firstAuthorizedPath({ role, can, permissionsReady });

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-rose-600">403</p>
      <h1 className="mt-1 text-xl font-semibold">Access denied</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your account does not have permission to open this page. If you need access, ask an
        administrator to update your role.
      </p>
      <Link
        to={home}
        className="mt-4 inline-flex rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
      >
        Go to an allowed page
      </Link>
    </div>
  );
}
