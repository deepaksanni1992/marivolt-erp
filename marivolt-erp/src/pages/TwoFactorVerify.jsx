import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function TwoFactorVerify() {
  const nav = useNavigate();
  const { auth, verify2FA, requires2FA } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!auth?.twoFactorTicket && !requires2FA) {
      nav("/login", { replace: true });
    }
  }, [auth?.twoFactorTicket, requires2FA, nav]);

  const userLabel = auth?.user?.email || auth?.user?.username || auth?.user?.name || "your account";

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await verify2FA(code.trim());
      if (data?.requiresCompanySelection) nav("/select-company", { replace: true });
      else nav("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Authenticator verification</h1>
        <p className="mt-1 text-sm text-gray-600">
          Enter the 6-digit code from your Authenticator app for <strong>{userLabel}</strong>.
        </p>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <label className="text-sm text-gray-600">6-digit code</label>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-center text-lg tracking-[0.35em] font-mono"
              placeholder="000000"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Verifying…" : "Verify & continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
