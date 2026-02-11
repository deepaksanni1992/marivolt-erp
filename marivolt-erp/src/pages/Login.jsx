import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../lib/api.js";

const AUTH_KEY = "marivoltz_auth_v1";

export default function Login() {
  const nav = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setForm({ email: "", password: "" });
  }, []);

  function onChange(e) {
    setForm((p) => ({ ...p, [e.target.name]: e.target.value }));
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const formData = new FormData(e.currentTarget);
      const emailInput = String(formData.get("email") || "").trim();
      const passwordInput = String(formData.get("password") || "");
      const email = emailInput || form.email.trim();
      const password = passwordInput || form.password;

      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || "Login failed");
      }

      const data = await res.json(); // { token, user }
      localStorage.setItem(AUTH_KEY, JSON.stringify({ ...data, ts: Date.now() }));
      nav("/dashboard");
    } catch (e2) {
      setError(e2.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border bg-white p-6">
        <h1 className="text-xl font-semibold">Marivoltz ERP</h1>
        <p className="mt-1 text-gray-600">Login to continue</p>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="mt-4 space-y-3"
          autoComplete="new-password"
        >
          <input
            type="text"
            name="fakeEmail"
            autoComplete="username"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />
          <input
            type="password"
            name="fakePassword"
            autoComplete="current-password"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />
          <div>
            <label className="text-sm text-gray-600">Username or Email</label>
            <input
              name="email"
              value={form.email}
              onChange={onChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Enter username or email"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck="false"
            />
          </div>

          <div>
            <label className="text-sm text-gray-600">Password</label>
            <input
              name="password"
              type="password"
              value={form.password}
              onChange={onChange}
              className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Enter password"
              autoComplete="new-password"
            />
          </div>

          <button
            disabled={loading}
            className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Logging in..." : "Login"}
          </button>

        </form>
      </div>
    </div>
  );
}
