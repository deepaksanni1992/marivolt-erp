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
    onSuccess: () => {
      setConfirmJob(null);
      qc.invalidateQueries({ queryKey: ["label-jobs"] });
      onMessage?.("Printed quantity confirmed.");
    },
    onError: (e) => onMessage?.(e.message || String(e)),
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
              <tr key={j._id} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-mono">{j.jobNo}</td>
                <td className="px-2 py-1.5">
                  {formatLabelJobSource(j)}
                  {j.isReprint ? " · reprint" : ""}
                </td>
                <td className="px-2 py-1.5 font-semibold">{j.status}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.requestedLabels}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.printedLabels}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{j.remainingLabels}</td>
                <td className="px-2 py-1.5">{j.windowsPrinterName}</td>
                <td className="px-2 py-1.5 font-mono">{j.agentId}</td>
                <td className="max-w-[180px] truncate px-2 py-1.5 text-rose-700" title={j.lastError}>
                  {j.lastError || "—"}
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
                        className="rounded border px-1.5 py-0.5 text-[11px] font-semibold"
                        onClick={() => {
                          setConfirmJob(j);
                          setPrintedQty(String(j.remainingLabels || 0));
                        }}
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

      {confirmJob && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs">
          <p className="font-semibold text-amber-900">
            Confirm how many labels actually printed for {confirmJob.jobNo} ({confirmJob.status})
          </p>
          {confirmJob.status === "UNCERTAIN" ? (
            <p className="mt-1 text-amber-800">
              Warning: some or all physical labels may already have printed. Enter the confirmed
              physical printed quantity. Remaining labels will be calculated from requested − confirmed.
              Windows spooler cannot prove exact physical count.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label>
              Printed qty{" "}
              <input
                type="number"
                min="0"
                max={confirmJob.requestedLabels}
                className="ml-1 w-24 rounded border px-1 py-0.5"
                value={printedQty}
                onChange={(e) => setPrintedQty(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded bg-slate-900 px-2 py-1 font-semibold text-white"
              onClick={() =>
                confirmMut.mutate({
                  id: confirmJob._id,
                  qty: Number(printedQty) || 0,
                  uncertain: confirmJob.status === "UNCERTAIN",
                })
              }
            >
              Confirm
            </button>
            <button type="button" className="rounded border px-2 py-1" onClick={() => setConfirmJob(null)}>
              Cancel
            </button>
          </div>
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
