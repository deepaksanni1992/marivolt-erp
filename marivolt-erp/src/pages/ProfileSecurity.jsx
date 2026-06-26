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

export default function ProfileSecurity() {
  const { auth } = useAuth();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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
      setSetup(data);
    },
    onError: (err) => setError(err.message || "Setup failed"),
  });

  const confirmSetup = useMutation({
    mutationFn: () => apiPost("/auth/2fa/confirm", { code: confirmCode }),
    onSuccess: () => {
      setSetup(null);
      setConfirmCode("");
      setMessage("Authenticator enabled for your account.");
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
  const accountLabel = auth?.user?.email || auth?.user?.username || auth?.user?.name || "—";

  return (
    <div className="px-4 py-6">
      <PageHeader
        title="Profile / Security"
        subtitle="Manage your personal Authenticator (TOTP) setup. Each user has a separate secret — never shared."
      />

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : null}
      {message ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </div>
      ) : null}

      <div className="max-w-xl rounded-2xl border border-slate-200 bg-white p-5">
        <p className="text-sm text-slate-600">
          Signed in as <strong>{accountLabel}</strong>
        </p>

        {isLoading ? (
          <p className="mt-4 text-sm text-slate-500">Loading security settings…</p>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <span className="font-medium text-slate-700">Authenticator status</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"
                }`}
              >
                {enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            {enabled ? (
              <>
                <p className="text-slate-600">
                  Enabled: {fmtDate(status.twoFactorEnabledAt)} · Last verified:{" "}
                  {fmtDate(status.twoFactorLastVerifiedAt)}
                </p>
                <div className="rounded-xl border border-slate-200 p-3">
                  <p className="mb-2 font-medium text-slate-800">Disable Authenticator</p>
                  <p className="mb-3 text-xs text-slate-500">
                    Requires your password and a current 6-digit code from your app.
                  </p>
                  <div className="space-y-3">
                    <FormField label="Password">
                      <TextInput
                        type="password"
                        value={disablePassword}
                        onChange={(e) => setDisablePassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </FormField>
                    <FormField label="Authenticator code">
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
              </>
            ) : setup ? (
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="mb-2 font-medium text-slate-800">Scan QR code</p>
                <p className="mb-3 text-xs text-slate-500">
                  Use Google Authenticator, Microsoft Authenticator, or any TOTP app. This QR is unique to your
                  account{setup.company?.name ? ` (${setup.company.name})` : ""}.
                </p>
                {setup.qrDataUrl ? (
                  <img
                    src={setup.qrDataUrl}
                    alt="Authenticator QR code"
                    className="mx-auto h-[220px] w-[220px] rounded-lg border bg-white p-2"
                  />
                ) : null}
                <p className="mt-3 text-xs text-slate-500 break-all">{setup.otpauthUrl}</p>
                <div className="mt-4">
                  <FormField label="Enter 6-digit code to verify">
                    <TextInput
                      inputMode="numeric"
                      maxLength={6}
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                    />
                  </FormField>
                  <div className="mt-3 flex flex-wrap gap-2">
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
              </div>
            ) : (
              <div>
                <p className="mb-3 text-slate-600">
                  Protect your login with a personal Authenticator app. Your secret is stored only on your user
                  record and is never shared with other users.
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
        )}
      </div>
    </div>
  );
}
