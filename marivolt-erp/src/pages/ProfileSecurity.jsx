import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api.js";
import { useAuth } from "../context/AuthContext.jsx";
import PageHeader from "../components/erp/PageHeader.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function manualKeyFromSetup(setup) {
  if (setup?.manualEntryKey) return String(setup.manualEntryKey).trim();
  const url = String(setup?.otpauthUrl || "");
  if (!url) return "";
  try {
    return new URL(url).searchParams.get("secret") || "";
  } catch {
    const match = url.match(/[?&]secret=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

export default function ProfileSecurity() {
  const { auth } = useAuth();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const user = auth?.user || {};
  const userName = user.name || "—";
  const loginId = user.email || user.username || "—";

  const { data: status, isLoading } = useQuery({
    queryKey: ["twoFactorStatus"],
    queryFn: () => apiGet("/auth/2fa/status"),
  });

  const startSetup = useMutation({
    mutationFn: () => apiPost("/auth/2fa/setup"),
    onSuccess: (data) => {
      setError("");
      setMessage("");
      setConfirmCode("");
      setCopied(false);
      setSetup(data);
    },
    onError: (err) => setError(err.message || "Setup failed"),
  });

  const confirmSetup = useMutation({
    mutationFn: () => apiPost("/auth/2fa/confirm", { code: confirmCode }),
    onSuccess: () => {
      setSetup(null);
      setConfirmCode("");
      setMessage("Two-Factor Authentication enabled for your account.");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["twoFactorStatus"] });
    },
    onError: (err) => setError(err.message || "Confirmation failed"),
  });

  const disable2fa = useMutation({
    mutationFn: () => apiPost("/auth/2fa/disable", { password: disablePassword, code: disableCode }),
    onSuccess: () => {
      setDisablePassword("");
      setDisableCode("");
      setMessage("Authenticator disabled for your account.");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["twoFactorStatus"] });
    },
    onError: (err) => setError(err.message || "Disable failed"),
  });

  const enabled = !!status?.twoFactorEnabled;
  const manualKey = manualKeyFromSetup(setup);

  async function copyManualKey() {
    if (!manualKey) return;
    try {
      await navigator.clipboard.writeText(manualKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  return (
    <div className="px-4 py-6">
      <PageHeader
        title="Security"
        subtitle="Manage your personal Authenticator (TOTP). This applies only to your login — not other users."
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}
      {message ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}

      <div className="max-w-xl space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">User name</dt>
              <dd className="mt-1 font-medium text-slate-900">{userName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email / login</dt>
              <dd className="mt-1 text-slate-800">{loginId}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Two-Factor Authentication</h2>

          {isLoading ? (
            <p className="mt-4 text-sm text-slate-500">Loading…</p>
          ) : enabled ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-900">
                <p className="font-semibold">✓ Two-Factor Authentication Enabled</p>
                <p className="mt-1 text-emerald-800">Enabled date: {fmtDate(status.twoFactorEnabledAt)}</p>
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <p className="mb-3 font-medium text-slate-800">Disable Authenticator</p>
                <p className="mb-3 text-xs text-slate-500">
                  Requires your current password and a current 6-digit code from your Authenticator app.
                </p>
                <div className="space-y-3">
                  <FormField label="Current password">
                    <TextInput
                      type="password"
                      value={disablePassword}
                      onChange={(e) => setDisablePassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </FormField>
                  <FormField label="Current authenticator code">
                    <TextInput
                      inputMode="numeric"
                      maxLength={6}
                      value={disableCode}
                      onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                    />
                  </FormField>
                  <button
                    type="button"
                    disabled={disable2fa.isPending || !disablePassword || disableCode.length !== 6}
                    onClick={() => disable2fa.mutate()}
                    className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-800 disabled:opacity-60"
                  >
                    {disable2fa.isPending ? "Disabling…" : "Disable Authenticator"}
                  </button>
                </div>
              </div>
            </div>
          ) : setup ? (
            <div className="mt-4 space-y-4 text-sm">
              <p className="text-slate-600">
                Scan the QR code with Google Authenticator, Microsoft Authenticator, or any TOTP app. This setup is
                unique to <strong>{loginId}</strong>
                {setup.company?.name ? ` (${setup.company.name})` : ""}.
              </p>

              {setup.qrDataUrl ? (
                <img
                  src={setup.qrDataUrl}
                  alt="Authenticator QR code"
                  className="mx-auto h-[220px] w-[220px] rounded-lg border bg-white p-2"
                />
              ) : null}

              {manualKey ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Manual setup key
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-800">
                      {manualKey}
                    </code>
                    <button
                      type="button"
                      onClick={copyManualKey}
                      className="rounded-lg border px-2 py-1 text-xs hover:bg-white"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              ) : null}

              <FormField label="Verification code">
                <TextInput
                  inputMode="numeric"
                  maxLength={6}
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="Enter 6-digit code"
                />
              </FormField>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={confirmSetup.isPending || confirmCode.length !== 6}
                  onClick={() => confirmSetup.mutate()}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                >
                  {confirmSetup.isPending ? "Verifying…" : "Verify & enable"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSetup(null);
                    setConfirmCode("");
                  }}
                  className="rounded-xl border px-4 py-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <p className="mb-1 text-sm text-slate-600">
                Status: <span className="font-medium text-slate-800">Disabled</span>
              </p>
              <p className="mb-4 text-xs text-slate-500">
                When enabled, you will enter a code from your Authenticator app after your password at login.
              </p>
              <button
                type="button"
                disabled={startSetup.isPending}
                onClick={() => startSetup.mutate()}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {startSetup.isPending ? "Preparing…" : "Enable Authenticator"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
