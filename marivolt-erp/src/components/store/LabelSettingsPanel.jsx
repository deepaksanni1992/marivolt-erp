import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "../../lib/api.js";
import { LABEL_TEMPLATE_NAME } from "../../lib/labelPrinting.js";

function statusBadge(status) {
  const s = String(status || "OFFLINE").toUpperCase();
  const cls =
    s === "ONLINE"
      ? "bg-emerald-100 text-emerald-800"
      : s === "DISABLED"
        ? "bg-slate-200 text-slate-700"
        : "bg-amber-100 text-amber-900";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{s}</span>;
}

function fmtTime(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

export default function LabelSettingsPanel() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const [agentSearch, setAgentSearch] = useState({ q: "", warehouse: "", branch: "", status: "", printer: "" });
  const [secretOnce, setSecretOnce] = useState(null);
  const [agentForm, setAgentForm] = useState({
    name: "Warehouse Agent 01",
    warehouseCode: "MAIN",
    branchName: "",
    department: "",
    description: "Receiving Counter",
    computerName: "",
    windowsVersion: "",
  });
  const [printerForm, setPrinterForm] = useState({
    code: "RONGTA1",
    displayName: "Receiving Printer",
    printerModel: "RP420",
    agentId: "",
    windowsPrinterName: "",
    warehouseCode: "MAIN",
    branchName: "",
    connectionKind: "USB",
    isDefault: false,
    isWarehouseDefault: true,
    remarks: "",
  });
  const [form, setForm] = useState(null);
  const [bootstrapTokenEdit, setBootstrapTokenEdit] = useState("");

  const agentQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (agentSearch.q) p.set("q", agentSearch.q);
    if (agentSearch.warehouse) p.set("warehouseCode", agentSearch.warehouse);
    if (agentSearch.branch) p.set("branch", agentSearch.branch);
    if (agentSearch.status) p.set("status", agentSearch.status);
    if (agentSearch.printer) p.set("printer", agentSearch.printer);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  }, [agentSearch]);

  const { data: settings } = useQuery({
    queryKey: ["label-settings"],
    queryFn: () => apiGet("/labels/settings"),
  });
  const { data: agents, isFetching: agentsLoading } = useQuery({
    queryKey: ["label-agents", agentQuery],
    queryFn: () => apiGet(`/labels/agents${agentQuery}`),
  });
  const { data: printers } = useQuery({
    queryKey: ["label-printers"],
    queryFn: () => apiGet("/labels/printers?includeInactive=1"),
  });

  const s = form || settings || {};

  const saveMut = useMutation({
    mutationFn: (body) => apiPut("/labels/settings", body),
    onSuccess: (data) => {
      setForm(null);
      setBootstrapTokenEdit("");
      qc.setQueryData(["label-settings"], data);
      setMsg("Label settings saved.");
    },
    onError: (e) => setMsg(e.message || String(e)),
  });

  const regAgentMut = useMutation({
    mutationFn: (body) => apiPost("/labels/agents", body),
    onSuccess: (data) => {
      setSecretOnce(data);
      qc.invalidateQueries({ queryKey: ["label-agents"] });
      setMsg("Agent registered — copy the secret now.");
    },
    onError: (e) => setMsg(e.message || String(e)),
  });

  const printerMut = useMutation({
    mutationFn: (body) => apiPost("/labels/printers", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["label-printers"] });
      setMsg("Printer saved.");
    },
    onError: (e) => setMsg(e.message || String(e)),
  });

  const agentAction = useMutation({
    mutationFn: ({ id, action, body }) => apiPost(`/labels/agents/${id}/${action}`, body || {}),
    onSuccess: (data, vars) => {
      if (vars.action === "rotate-secret" && data?.secret) setSecretOnce(data);
      qc.invalidateQueries({ queryKey: ["label-agents"] });
      setMsg(`${vars.action} ok for ${vars.id}`);
    },
    onError: (e) => setMsg(e.message || String(e)),
  });

  const printerAction = useMutation({
    mutationFn: ({ id, action }) => apiPost(`/labels/printers/${id}/${action}`, {}),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["label-printers"] });
      setMsg(`Printer ${vars.action} ok`);
    },
    onError: (e) => setMsg(e.message || String(e)),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Label Printing</h2>
        <p className="text-sm text-slate-600">
          Fixed size {settings?.labelSize?.widthMm || 100}×{settings?.labelSize?.heightMm || 50} mm · Template{" "}
          {LABEL_TEMPLATE_NAME}. Multi-agent / multi-printer enterprise mode — GRN posting stays independent.
        </p>
        {msg && <p className="mt-2 text-xs text-slate-700">{msg}</p>}
        {secretOnce && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
            <p>
              Agent ID:{" "}
              <span className="font-mono font-semibold">{secretOnce.agent?.agentId || secretOnce.agentId}</span>
            </p>
            <p>
              Secret (copy once): <span className="font-mono font-semibold">{secretOnce.secret}</span>
            </p>
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="grid max-w-xl gap-3 rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="font-semibold text-slate-800">Settings</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(s.enabled)}
            onChange={(e) => setForm({ ...s, enabled: e.target.checked })}
          />
          Enable label printing
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(s.autoPrintAfterGrn)}
            onChange={(e) => setForm({ ...s, autoPrintAfterGrn: e.target.checked })}
          />
          Auto print after GRN (UI default hint)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={s.allowManualReprint !== false}
            onChange={(e) => setForm({ ...s, allowManualReprint: e.target.checked })}
          />
          Allow manual reprint
        </label>
        <label className="block">
          Company default printer code
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={s.defaultPrinterCode || ""}
            onChange={(e) => setForm({ ...s, defaultPrinterCode: e.target.value.toUpperCase() })}
          />
        </label>
        <label className="block">
          Max labels per job
          <input
            type="number"
            min="1"
            className="mt-1 w-full rounded border px-2 py-1"
            value={s.maxPerJob ?? 200}
            onChange={(e) => setForm({ ...s, maxPerJob: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          Default copies
          <input
            type="number"
            min="1"
            className="mt-1 w-full rounded border px-2 py-1"
            value={s.defaultCopies ?? 1}
            onChange={(e) => setForm({ ...s, defaultCopies: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          Agent bootstrap token{" "}
          {settings?.hasAgentBootstrapToken ? (
            <span className="text-[10px] text-emerald-700">(set — enter new value to rotate)</span>
          ) : (
            <span className="text-[10px] text-slate-500">(hashed at rest; company-scoped)</span>
          )}
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs"
            placeholder="Paste token agents will use on first install"
            value={bootstrapTokenEdit}
            onChange={(e) => setBootstrapTokenEdit(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(s.agentBootstrapEnabled)}
            onChange={(e) => setForm({ ...s, agentBootstrapEnabled: e.target.checked })}
          />
          Bootstrap enabled
        </label>
        <label className="block">
          Bootstrap warehouse scope (optional)
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={s.agentBootstrapWarehouse || ""}
            onChange={(e) =>
              setForm({ ...s, agentBootstrapWarehouse: e.target.value.toUpperCase() })
            }
            placeholder="e.g. MAIN — empty = any warehouse"
          />
        </label>
        <label className="block">
          Bootstrap expires at (ISO, optional)
          <input
            className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs"
            value={s.agentBootstrapExpiresAt || ""}
            onChange={(e) => setForm({ ...s, agentBootstrapExpiresAt: e.target.value })}
            placeholder="2026-12-31T23:59:59.000Z"
          />
        </label>
        <label className="block">
          Bootstrap max uses (0 = unlimited)
          <input
            type="number"
            min="0"
            className="mt-1 w-full rounded border px-2 py-1"
            value={s.agentBootstrapMaxUses ?? 0}
            onChange={(e) => setForm({ ...s, agentBootstrapMaxUses: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          onClick={() => {
            const body = { ...(form || s) };
            if (bootstrapTokenEdit.trim()) body.agentBootstrapToken = bootstrapTokenEdit.trim();
            saveMut.mutate(body);
          }}
        >
          Save settings
        </button>
      </div>

      {/* Register agent */}
      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="font-semibold">Register Print Agent</h3>
        <p className="mt-1 text-xs text-slate-500">
          Prefer agent first-launch wizard (auto-detects computer / OS / printers). Admin registration remains
          supported.
        </p>
        <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {[
            ["name", "Friendly agent name"],
            ["warehouseCode", "Warehouse code"],
            ["branchName", "Branch"],
            ["department", "Department (optional)"],
            ["description", "Description"],
            ["computerName", "Computer name (optional override)"],
            ["windowsVersion", "Windows version (optional)"],
          ].map(([key, label]) => (
            <label key={key} className="block text-xs">
              {label}
              <input
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                value={agentForm[key] || ""}
                onChange={(e) =>
                  setAgentForm({
                    ...agentForm,
                    [key]: key === "warehouseCode" ? e.target.value.toUpperCase() : e.target.value,
                  })
                }
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          onClick={() => regAgentMut.mutate(agentForm)}
        >
          Register
        </button>
      </div>

      {/* Agent dashboard */}
      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Print Agent Dashboard</h3>
          {agentsLoading ? <span className="text-[11px] text-slate-500">Refreshing…</span> : null}
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            className="rounded border px-2 py-1 text-xs"
            placeholder="Search computer / name"
            value={agentSearch.q}
            onChange={(e) => setAgentSearch({ ...agentSearch, q: e.target.value })}
          />
          <input
            className="rounded border px-2 py-1 text-xs"
            placeholder="Warehouse"
            value={agentSearch.warehouse}
            onChange={(e) => setAgentSearch({ ...agentSearch, warehouse: e.target.value.toUpperCase() })}
          />
          <input
            className="rounded border px-2 py-1 text-xs"
            placeholder="Branch"
            value={agentSearch.branch}
            onChange={(e) => setAgentSearch({ ...agentSearch, branch: e.target.value })}
          />
          <input
            className="rounded border px-2 py-1 text-xs"
            placeholder="Printer"
            value={agentSearch.printer}
            onChange={(e) => setAgentSearch({ ...agentSearch, printer: e.target.value })}
          />
          <select
            className="rounded border px-2 py-1 text-xs"
            value={agentSearch.status}
            onChange={(e) => setAgentSearch({ ...agentSearch, status: e.target.value })}
          >
            <option value="">All statuses</option>
            <option value="ONLINE">Online</option>
            <option value="OFFLINE">Offline</option>
            <option value="DISABLED">Disabled</option>
          </select>
        </div>
        <div className="overflow-auto">
          <table className="w-full min-w-[1100px] text-xs">
            <thead className="bg-slate-100 text-left text-[11px] uppercase text-slate-600">
              <tr>
                <th className="px-2 py-2">Agent</th>
                <th className="px-2 py-2">Computer</th>
                <th className="px-2 py-2">Warehouse</th>
                <th className="px-2 py-2">Printers</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Version</th>
                <th className="px-2 py-2">Heartbeat</th>
                <th className="px-2 py-2 text-right">Pending</th>
                <th className="px-2 py-2 text-right">Done today</th>
                <th className="px-2 py-2 text-right">Failed today</th>
                <th className="px-2 py-2">Last error</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(agents?.items || []).map((a) => (
                <tr key={a._id || a.agentId} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-semibold">{a.name || a.agentId}</div>
                    <div className="font-mono text-[10px] text-slate-500">{a.agentId}</div>
                    {a.branchName ? <div className="text-[10px] text-slate-500">{a.branchName}</div> : null}
                  </td>
                  <td className="px-2 py-1.5 font-mono">{a.computerName || "—"}</td>
                  <td className="px-2 py-1.5">
                    {a.warehouseCode || "—"}
                    {a.warehouseName ? <div className="text-[10px] text-slate-500">{a.warehouseName}</div> : null}
                  </td>
                  <td className="px-2 py-1.5">
                    {(a.printers || []).length
                      ? (a.printers || []).map((p) => (
                          <div key={p.code} className="font-mono text-[10px]">
                            {p.code}
                          </div>
                        ))
                      : (a.availablePrinters || []).slice(0, 2).map((n) => (
                          <div key={n} className="text-[10px] text-slate-500">
                            {n}
                          </div>
                        )) || "—"}
                  </td>
                  <td className="px-2 py-1.5">{statusBadge(a.effectiveStatus)}</td>
                  <td className="px-2 py-1.5 font-mono">{a.appVersion || "—"}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{fmtTime(a.lastHeartbeatAt)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{a.pendingJobs ?? 0}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{a.completedToday ?? 0}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{a.failedToday ?? 0}</td>
                  <td className="max-w-[140px] truncate px-2 py-1.5 text-rose-700" title={a.lastError}>
                    {a.lastError || "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                        onClick={() =>
                          agentAction.mutate({ id: a.agentId, action: "test-connection" })
                        }
                      >
                        Test Connection
                      </button>
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                        onClick={() => agentAction.mutate({ id: a.agentId, action: "test-print" })}
                      >
                        Test Print
                      </button>
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                        onClick={() => {
                          if (window.confirm(`Rotate secret for ${a.agentId}?`)) {
                            agentAction.mutate({ id: a.agentId, action: "rotate-secret" });
                          }
                        }}
                      >
                        Rotate Secret
                      </button>
                      {a.isActive === false ? (
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                          onClick={() => agentAction.mutate({ id: a.agentId, action: "enable" })}
                        >
                          Enable
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                          onClick={() => agentAction.mutate({ id: a.agentId, action: "disable" })}
                        >
                          Disable
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!(agents?.items || []).length && (
                <tr>
                  <td colSpan={12} className="px-2 py-6 text-center text-slate-500">
                    No print agents registered
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Printer form + dashboard */}
      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="font-semibold">Add / Edit Printer</h3>
        <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs">
            Printer code
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.code}
              onChange={(e) => setPrinterForm({ ...printerForm, code: e.target.value.toUpperCase() })}
            />
          </label>
          <label className="block text-xs">
            Printer name
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.displayName}
              onChange={(e) => setPrinterForm({ ...printerForm, displayName: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            Model
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.printerModel}
              onChange={(e) => setPrinterForm({ ...printerForm, printerModel: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            Assigned agent
            <select
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.agentId}
              onChange={(e) => setPrinterForm({ ...printerForm, agentId: e.target.value })}
            >
              <option value="">Select agent</option>
              {(agents?.items || []).map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.name || a.agentId} ({a.computerName || "—"})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Windows printer name
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              list="detected-printers"
              value={printerForm.windowsPrinterName}
              onChange={(e) => setPrinterForm({ ...printerForm, windowsPrinterName: e.target.value })}
            />
            <datalist id="detected-printers">
              {(agents?.items || [])
                .flatMap((a) => a.availablePrinters || [])
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .map((n) => (
                  <option key={n} value={n} />
                ))}
            </datalist>
          </label>
          <label className="block text-xs">
            Connection
            <select
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.connectionKind}
              onChange={(e) => setPrinterForm({ ...printerForm, connectionKind: e.target.value })}
            >
              <option value="USB">USB</option>
              <option value="NETWORK">Network</option>
              <option value="WINDOWS_QUEUE">Windows Queue</option>
            </select>
          </label>
          <label className="block text-xs">
            Warehouse
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.warehouseCode}
              onChange={(e) =>
                setPrinterForm({ ...printerForm, warehouseCode: e.target.value.toUpperCase() })
              }
            />
          </label>
          <label className="block text-xs">
            Branch
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.branchName}
              onChange={(e) => setPrinterForm({ ...printerForm, branchName: e.target.value })}
            />
          </label>
          <label className="block text-xs">
            Remarks
            <input
              className="mt-0.5 w-full rounded border px-2 py-1"
              value={printerForm.remarks}
              onChange={(e) => setPrinterForm({ ...printerForm, remarks: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(printerForm.isWarehouseDefault)}
              onChange={(e) => setPrinterForm({ ...printerForm, isWarehouseDefault: e.target.checked })}
            />
            Warehouse default
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={Boolean(printerForm.isDefault)}
              onChange={(e) => setPrinterForm({ ...printerForm, isDefault: e.target.checked })}
            />
            Company default
          </label>
        </div>
        <button
          type="button"
          className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          onClick={() => printerMut.mutate(printerForm)}
        >
          Save printer
        </button>
      </div>

      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="mb-2 font-semibold">Printer Dashboard</h3>
        <div className="overflow-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead className="bg-slate-100 text-left text-[11px] uppercase text-slate-600">
              <tr>
                <th className="px-2 py-2">Printer</th>
                <th className="px-2 py-2">Model</th>
                <th className="px-2 py-2">Warehouse</th>
                <th className="px-2 py-2">Assigned agent</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Last print</th>
                <th className="px-2 py-2 text-right">Queue</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(printers?.items || []).map((p) => (
                <tr key={p._id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5">
                    <div className="font-semibold">{p.displayName || p.code}</div>
                    <div className="font-mono text-[10px] text-slate-500">
                      {p.code} · {p.windowsPrinterName}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {p.connectionKind || "USB"}
                      {p.isDefault ? " · company default" : ""}
                      {p.isWarehouseDefault ? " · warehouse default" : ""}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">{p.printerModel || "—"}</td>
                  <td className="px-2 py-1.5">{p.warehouseCode || "—"}</td>
                  <td className="px-2 py-1.5">
                    <div className="font-mono">{p.agentId}</div>
                    <div className="text-[10px] text-slate-500">{p.agentComputerName || p.agentName || ""}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    {statusBadge(p.isActive === false ? "DISABLED" : p.agentStatus || "OFFLINE")}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{fmtTime(p.lastPrintAt)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.currentQueue ?? 0}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                        onClick={() => {
                          setPrinterForm({
                            code: p.code,
                            displayName: p.displayName || "",
                            printerModel: p.printerModel || "",
                            agentId: p.agentId || "",
                            windowsPrinterName: p.windowsPrinterName || "",
                            warehouseCode: p.warehouseCode || "",
                            branchName: p.branchName || "",
                            connectionKind: p.connectionKind || "USB",
                            isDefault: Boolean(p.isDefault),
                            isWarehouseDefault: Boolean(p.isWarehouseDefault),
                            remarks: p.remarks || "",
                          });
                          setMsg(`Editing ${p.code} — update form and Save printer.`);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                        onClick={() => printerAction.mutate({ id: p.code, action: "test-print" })}
                      >
                        Test Print
                      </button>
                      {p.isActive === false ? (
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                          onClick={() => printerAction.mutate({ id: p.code, action: "enable" })}
                        >
                          Enable
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                          onClick={() => printerAction.mutate({ id: p.code, action: "disable" })}
                        >
                          Disable
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold text-rose-700"
                        onClick={() => {
                          if (window.confirm(`Soft-delete printer ${p.code}?`)) {
                            printerAction.mutate({ id: p.code, action: "delete" });
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!(printers?.items || []).length && (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-slate-500">
                    No printers configured
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
