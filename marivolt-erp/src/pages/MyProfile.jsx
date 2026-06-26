import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import PageHeader from "../components/erp/PageHeader.jsx";

export default function MyProfile() {
  const { auth } = useAuth();
  const user = auth?.user || {};
  const loginId = user.email || user.username || "—";

  return (
    <div className="px-4 py-6">
      <PageHeader title="My Profile" subtitle="Your personal account details." />

      <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-5 text-sm">
        <dl className="space-y-4">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">User name</dt>
            <dd className="mt-1 text-base font-medium text-slate-900">{user.name || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email / login</dt>
            <dd className="mt-1 text-slate-800">{loginId}</dd>
          </div>
          {user.username && user.email ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Username</dt>
              <dd className="mt-1 text-slate-800">{user.username}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Role</dt>
            <dd className="mt-1 text-slate-800">{user.role || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Company</dt>
            <dd className="mt-1 text-slate-800">
              {auth?.company?.name ? `${auth.company.name} (${auth.company.code})` : "—"}
            </dd>
          </div>
        </dl>
        <p className="mt-6 text-xs text-slate-500">
          To manage Authenticator login, open{" "}
          <Link to="/profile/security" className="font-medium text-slate-700 underline">
            Security
          </Link>{" "}
          from the profile menu.
        </p>
      </div>
    </div>
  );
}
