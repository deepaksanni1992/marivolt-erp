import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../../lib/api.js";
import { formatLabelJobSource, LABEL_TEMPLATE_NAME, REPRINT_REASONS } from "../../lib/labelPrinting.js";
import CustomPackingLabelModal from "./CustomPackingLabelModal.jsx";

export default function LabelQueuePanel({ onMessage }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [confirmJob, setConfirmJob] = useState(null);
  const [printedQty, setPrintedQty] = useState("");
  const [confirmLocalError, setConfirmLocalError] = useState("");
  const [confirmLocalSuccess, setConfirmLocalSuccess] = useState("");
  const [reprintJob, setReprintJob] = useState(null);
  const [reprintReason, setReprintReason] = useState(REPRINT_REASONS[0]);
  const [customOpen, setCustomOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["label-jobs", status],
    queryFn: () => apiGet(`/labels/jobs${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  });

  const { data: printersData } = useQuery({
    queryKey: ["label-printers"],
    queryFn: () => apiGet("/labels/printers"),
  });
  const printers = printersData?.items || printersData?.printers || [];

  const retryMut = useMutation({
    mutationFn: (id) => apiPost(`/labels/jobs/${id}/retry`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["label-jobs"] });
      onMessage?.("Label job requeued.");
    },
    onError: (e) => onMessage?.(e.message || String(e)),
  });

  const cancelMut = useMutation({
    mutationFn: (id) => apiPost(`/labels/jobs/${id}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["label-jobs"] });
      onMessage?.("Label job cancelled.");
    },
    onError: (e) => onMessage?.(e.message || String(e)),
  });

  const confirmMut = useMutation({
    mutationFn: ({ id, qty, uncertain }) =>
      apiPost(
        uncertain ? `/labels/jobs/${id}/resolve-uncertain` : `/labels/jobs/${id}/confirm-partial`,
        { printedQty: qty }
      ),
    onSuccess: (res) => {
      const msg =
        res?.message ||
        (Number(res?.confirmedQty) >= 0
          ? `${res.confirmedQty} physical label(s) confirmed.`
          : "Printed quantity confirmed.");
      setConfirmLocalError("");
      setConfirmLocalSuccess(msg);
      qc.invalidateQueries({ queryKey: ["label-jobs"] });
      qc.invalidateQueries({ queryKey: ["asn-receiving-units"] });
      qc.invalidateQueries({ queryKey: ["receiving-progress"] });
      onMessage?.(msg);
      window.setTimeout(() => {
        setConfirmJob(null);
        setConfirmLocalSuccess("");
      }, 1600);
    },
    onError: (e) => {
      const msg = e.message || String(e);
      setConfirmLocalSuccess("");
      setConfirmLocalError(msg);
      onMessage?.(msg);
    },
  });

  const reprintMut = useMutation({
    mutationFn: ({ id, reason }) => apiPost(`/labels/jobs/${id}/reprint`, { reason }),
    onSuccess: () => {
      setReprintJob(null);
      qc.invalidateQueries({ queryKey: ["label-jobs"] });
      onMessage?.("Reprint job queued.");
    },
    onError: (e) => onMessage?.(e.message || String(e)),
  });

  const items = data?.items || [];

  function pendingWaitNote(job) {
    if (String(job.status || "").toUpperCase() !== "PENDING") return "";
    if (job.lastError) return "";
    const want = String(job.windowsPrinterName || "").trim().toLowerCase();
    const p = printers.find((x) => String(x.windowsPrinterName || "").trim().toLowerCase() === want);
    const st = String(p?.printerStatus || "").trim().toUpperCase();
    if (p?.agentStatus === "ONLINE" && st && st !== "READY") {
      return `Waiting for printer — ${st}`;
    }
    return "";
  }

  function openConfirm(job) {
    setConfirmJob(job);
    setPrintedQty(String(job.remainingLabels ?? job.requestedLabels ?? 1));
    setConfirmLocalError("");
    setConfirmLocalSuccess("");
  }

  function submitConfirm() {
    if (!confirmJob || confirmMut.isPending) return;
    setConfirmLocalError("");
    setConfirmLocalSuccess("");
    const qty = Number(printedQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setConfirmLocalError("Enter a non-negative printed quantity.");
      return;
    }
    confirmMut.mutate({
      id: confirmJob._id,
      qty,
      uncertain: String(confirmJob.status || "").toUpperCase() === "UNCERTAIN",
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Label Print Queue</h3>
        <span className="text-[11px] text-slate-500">Template: {LABEL_TEMPLATE_NAME} · 100×50 mm</span>
        <select
          className="ml-auto rounded border px-2 py-1 text-xs"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {["PENDING", "LEASED", "PRINTING", "COMPLETED", "PARTIAL", "FAILED", "UNCERTAIN", "CANCELLED"].map(
            (s) => (
              <option key={s} value={s}>
                {s}
              </option>
            )
          )}
        </select>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs font-semibold"
          onClick={() => qc.invalidateQueries({ queryKey: ["label-jobs"] })}
        >
          Refresh
        </button>
        <button
          type="button"
          className="rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white"
          onClick={() => setCustomOpen(true)}
          data-testid="custom-packing-label-open"
        >
          Custom Label
        </button>
      </div>
      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {error && <p className="text-xs text-rose-600">{error.message}</p>}
      <div className="overflow-auto rounded border border-slate-200">
        <table className="w-full min-w-[900px] text-xs">
          <thead className="bg-slate-100 text-left text-[11px] uppercase text-slate-600">
            <tr>
              <th className="px-2 py-2">Job</th>
              <th className="px-2 py-2">Source</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2 text-right">Req</th>
              <th className="px-2 py-2 text-right">Printed</th>
              <th className="px-2 py-2 text-right">Remain</th>
              <th className="px-2 py-2">Printer</th>
              <th className="px-2 py-2">Agent</th>
              <th className="px-2 py-2">Error</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((j) => (
              <tr
                key={j._id}
                className={`border-t border-slate-100 ${
                  confirmJob && String(confirmJob._id) === String(j._id) ? "bg-amber-50" : ""
                }`}
              >
                <td className="px-2 py-1.5 font-mono">{j.jobNo}</td>
                <td className="px-2 py-1.5">
                  {formatLabelJobSource(j)}
                  {j.isReprint ? " · reprint" : ""}
                </td>
                <td className="px-2 py-1.5 font-semibold" title={pendingWaitNote(j) || undefined}>
                  {j.status}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.requestedLabels}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.printedLabels}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.remainingLabels}</td>
                <td className="px-2 py-1.5">{j.windowsPrinterName}</td>
                <td className="px-2 py-1.5 font-mono">{j.agentId}</td>
                <td
                  className={`max-w-[180px] truncate px-2 py-1.5 ${j.lastError ? "text-rose-700" : "text-slate-600"}`}
                  title={j.lastError || pendingWaitNote(j) || undefined}
                >
                  {j.lastError || pendingWaitNote(j) || "—"}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {["FAILED", "PARTIAL"].includes(j.status) && (
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                        onClick={() => retryMut.mutate(j._id)}
                      >
                        Retry
                      </button>
                    )}
                    {["PARTIAL", "UNCERTAIN"].includes(j.status) && (
                      <button
                        type="button"
                        className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950"
                        onClick={() => openConfirm(j)}
                        data-testid="label-confirm-qty-open"
                      >
                        Confirm qty
                      </button>
                    )}
                    {["PENDING", "LEASED"].includes(j.status) && (
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                        onClick={() => cancelMut.mutate(j._id)}
                      >
                        Cancel
                      </button>
                    )}
                    {j.status === "COMPLETED" && (
                    <button
                      type="button"
                      className="rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                      onClick={() => {
                        setReprintJob(j);
                        setReprintReason(REPRINT_REASONS[0]);
                      }}
                    >
                      Reprint
                    </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!items.length && !isLoading && (
              <tr>
                <td colSpan={10} className="px-2 py-6 text-center text-slate-500">
                  No label jobs
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        PENDING waits for a READY printer. COMPLETED means the agent submitted RAW while READY and the
        Windows spool queue drained — not optical/physical paper confirmation. UNCERTAIN means the spool
        outcome is ambiguous. Use Confirm qty only after you verify the physical label(s) came out.
      </p>

      {confirmJob && (
        <div
          className="sticky bottom-2 z-10 rounded border border-amber-300 bg-amber-50 p-3 text-xs shadow-sm"
          data-testid="label-confirm-qty-panel"
        >
          <p className="font-semibold text-amber-900">
            Confirm how many labels actually printed for {confirmJob.jobNo} ({confirmJob.status})
          </p>
          {confirmJob.status === "UNCERTAIN" ? (
            <p className="mt-1 text-amber-800">
              Warning: some or all physical labels may already have printed. Enter the confirmed
              physical printed quantity. This does not send another print — it only marks the job
              (and ASN RU) as printed when remaining becomes 0.
            </p>
          ) : null}
          {(confirmJob.lines || [])
            .map((ln) => ln.ruNo || ln.labelId)
            .filter(Boolean)
            .slice(0, 3)
            .map((ruNo) => (
              <p key={ruNo} className="mt-1 font-mono text-amber-900">
                RU {ruNo}
              </p>
            ))}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label>
              Printed qty{" "}
              <input
                type="number"
                min="0"
                max={confirmJob.requestedLabels}
                className="ml-1 w-24 rounded border px-1 py-0.5"
                value={printedQty}
                disabled={confirmMut.isPending}
                onChange={(e) => setPrintedQty(e.target.value)}
                data-testid="label-confirm-qty-input"
              />
            </label>
            <button
              type="button"
              className="rounded bg-slate-900 px-2 py-1 font-semibold text-white disabled:opacity-60"
              disabled={confirmMut.isPending}
              onClick={submitConfirm}
              data-testid="label-confirm-qty-submit"
            >
              {confirmMut.isPending ? "Confirming…" : "Confirm"}
            </button>
            <button
              type="button"
              className="rounded border px-2 py-1 disabled:opacity-60"
              disabled={confirmMut.isPending}
              onClick={() => {
                setConfirmJob(null);
                setConfirmLocalError("");
                setConfirmLocalSuccess("");
              }}
            >
              Cancel
            </button>
          </div>
          {confirmLocalError ? (
            <p className="mt-2 font-semibold text-rose-700" data-testid="label-confirm-qty-error">
              {confirmLocalError}
            </p>
          ) : null}
          {confirmLocalSuccess ? (
            <p className="mt-2 font-semibold text-emerald-800" data-testid="label-confirm-qty-success">
              {confirmLocalSuccess}
            </p>
          ) : null}
        </div>
      )}

      {reprintJob && (
        <div className="rounded border border-slate-200 bg-white p-3 text-xs">
          <p className="font-semibold">Reprint {reprintJob.jobNo}</p>
          <select
            className="mt-2 rounded border px-2 py-1"
            value={reprintReason}
            onChange={(e) => setReprintReason(e.target.value)}
          >
            {REPRINT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded bg-slate-900 px-2 py-1 font-semibold text-white"
              onClick={() => reprintMut.mutate({ id: reprintJob._id, reason: reprintReason })}
            >
              Queue reprint
            </button>
            <button type="button" className="rounded border px-2 py-1" onClick={() => setReprintJob(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <CustomPackingLabelModal
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        printers={printers}
        onPrinted={() => {
          qc.invalidateQueries({ queryKey: ["label-jobs"] });
          onMessage?.("Custom packing label queued.");
        }}
        onError={(msg) => onMessage?.(msg)}
      />
    </div>
  );
}
