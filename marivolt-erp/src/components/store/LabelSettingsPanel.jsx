import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "../../lib/api.js";
import { LABEL_TEMPLATE_NAME } from "../../lib/labelPrinting.js";

export default function LabelSettingsPanel() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const [agentForm, setAgentForm] = useState({ name: "Warehouse PC", warehouseCode: "MAIN" });
  const [secretOnce, setSecretOnce] = useState(null);
  const [printerForm, setPrinterForm] = useState({
    code: "RONGTA1",
    displayName: "Rongta USB",
    agentId: "",
    windowsPrinterName: "",
    warehouseCode: "MAIN",
    isDefault: true,
  });

  const { data: settings } = useQuery({
    queryKey: ["label-settings"],
    queryFn: () => apiGet("/labels/settings"),
  });
  const { data: agents } = useQuery({
    queryKey: ["label-agents"],
    queryFn: () => apiGet("/labels/agents"),
  });
  const { data: printers } = useQuery({
    queryKey: ["label-printers"],
    queryFn: () => apiGet("/labels/printers"),
  });

  const [form, setForm] = useState(null);
  const s = form || settings || {};

  const saveMut = useMutation({
    mutationFn: (body) => apiPut("/labels/settings", body),
    onSuccess: (data) => {
      setForm(null);
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Label Printing</h2>
        <p className="text-sm text-slate-600">
          Fixed size {settings?.labelSize?.widthMm || 100}×{settings?.labelSize?.heightMm || 50} mm · Template{" "}
          {LABEL_TEMPLATE_NAME}. Printing is independent of GRN stock posting.
        </p>
        {msg && <p className="mt-2 text-xs text-slate-700">{msg}</p>}
      </div>

      <div className="grid max-w-xl gap-3 rounded border border-slate-200 bg-white p-4 text-sm">
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
          Default printer code
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
        <button
          type="button"
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          onClick={() => saveMut.mutate(form || s)}
        >
          Save settings
        </button>
      </div>

      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="font-semibold">Register Print Agent</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            className="rounded border px-2 py-1"
            placeholder="Name"
            value={agentForm.name}
            onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
          />
          <input
            className="rounded border px-2 py-1"
            placeholder="Warehouse code"
            value={agentForm.warehouseCode}
            onChange={(e) => setAgentForm({ ...agentForm, warehouseCode: e.target.value.toUpperCase() })}
          />
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={() => regAgentMut.mutate(agentForm)}
          >
            Register agent
          </button>
        </div>
        {secretOnce && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs">
            <p>
              Agent ID: <span className="font-mono font-semibold">{secretOnce.agent?.agentId}</span>
            </p>
            <p>
              Secret (copy once): <span className="font-mono font-semibold">{secretOnce.secret}</span>
            </p>
          </div>
        )}
        <ul className="mt-3 space-y-1 text-xs text-slate-600">
          {(agents?.items || []).map((a) => (
            <li key={a._id}>
              <span className="font-mono">{a.agentId}</span> · {a.name} · {a.effectiveStatus || a.status} ·{" "}
              {a.computerName || "—"}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded border border-slate-200 bg-white p-4 text-sm">
        <h3 className="font-semibold">ERP Printer (maps to Windows queue)</h3>
        <div className="mt-2 grid max-w-xl gap-2">
          <input
            className="rounded border px-2 py-1"
            placeholder="Code"
            value={printerForm.code}
            onChange={(e) => setPrinterForm({ ...printerForm, code: e.target.value.toUpperCase() })}
          />
          <input
            className="rounded border px-2 py-1"
            placeholder="Display name"
            value={printerForm.displayName}
            onChange={(e) => setPrinterForm({ ...printerForm, displayName: e.target.value })}
          />
          <input
            className="rounded border px-2 py-1"
            placeholder="Agent ID"
            value={printerForm.agentId}
            onChange={(e) => setPrinterForm({ ...printerForm, agentId: e.target.value.toUpperCase() })}
          />
          <input
            className="rounded border px-2 py-1"
            placeholder="Windows printer name (exact)"
            value={printerForm.windowsPrinterName}
            onChange={(e) => setPrinterForm({ ...printerForm, windowsPrinterName: e.target.value })}
          />
          <button
            type="button"
            className="w-fit rounded bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={() => printerMut.mutate(printerForm)}
          >
            Save printer
          </button>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-slate-600">
          {(printers?.items || []).map((p) => (
            <li key={p._id}>
              <span className="font-mono">{p.code}</span> → {p.windowsPrinterName} (agent {p.agentId})
              {p.isDefault ? " · default" : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
