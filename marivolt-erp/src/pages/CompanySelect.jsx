import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function CompanySelect() {
  const nav = useNavigate();
  const { auth, selectCompany } = useAuth();
  const [companyId, setCompanyId] = useState(auth?.companies?.[0]?.id || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const companies = useMemo(() => auth?.companies || [], [auth?.companies]);

  async function onSubmit(e) {
    e.preventDefault();
    if (!companyId) return;
    setError("");
    setLoading(true);
    try {
      await selectCompany(companyId);
      nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Failed to select company");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Select Company</h1>
        <p className="mt-1 text-gray-600">Choose your working company for this session</p>
        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="space-y-2">
            {companies.map((c) => (
              <label
                key={c.id}
                className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2 ${
                  companyId === c.id ? "border-gray-900 bg-gray-50" : "border-gray-200"
                }`}
              >
                <div>
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-gray-500">{c.code}</div>
                </div>
                <input
                  type="radio"
                  name="company"
                  checked={companyId === c.id}
                  onChange={() => setCompanyId(c.id)}
                />
              </label>
            ))}
          </div>
          <button
            disabled={loading || !companyId}
            className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Continuing..." : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
