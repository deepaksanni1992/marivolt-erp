import { useEffect, useId, useRef } from "react";
import LoadingButton from "../erp/LoadingButton.jsx";
import {
  formatLabelDistribution,
  formatGrnLabelPreviewSummaryLine,
} from "../../lib/grnLabelDistribution.js";

/**
 * Preview physical GRN label distribution before queueing (pre- or post-print).
 * Print / Cancel only — never posts GRN.
 */
export default function GrnLabelPreviewModal({
  open,
  title = "Preview & Print Labels",
  draftRef = "",
  poNo = "",
  lines = [],
  totalLabels = 0,
  isPrinting = false,
  staleWarning = "",
  onPrint,
  onCancel,
}) {
  const titleId = useId();
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e) => {
      if (e.key === "Escape" && !isPrinting) {
        e.preventDefault();
        onCancel?.();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, isPrinting, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Cancel label preview"
        tabIndex={-1}
        disabled={isPrinting}
        onClick={() => {
          if (!isPrinting) onCancel?.();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {title}
          </h2>
          <button
            type="button"
            className="rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
            disabled={isPrinting}
            onClick={() => onCancel?.()}
          >
            ×
          </button>
        </div>

        <dl className="mb-3 space-y-1 text-sm text-slate-700">
          {poNo ? (
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">PO</dt>
              <dd className="font-mono font-semibold">{poNo}</dd>
            </div>
          ) : null}
          {draftRef ? (
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Draft ref</dt>
              <dd className="max-w-[60%] truncate font-mono text-[11px]" title={draftRef}>
                {draftRef}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Total physical labels</dt>
            <dd className="tabular-nums text-base font-bold text-slate-900">{totalLabels}</dd>
          </div>
        </dl>

        {staleWarning ? (
          <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {staleWarning}
          </div>
        ) : null}

        <div className="mb-3 space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-800">
          {(lines || []).map((ln) => (
            <div key={`sum-${ln.poLineId || ln.article}`} className="font-medium">
              {formatGrnLabelPreviewSummaryLine(ln)}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {(lines || []).map((ln) => (
            <div key={`${ln.poLineId || ln.article}`} className="rounded border border-slate-200 p-3 text-sm">
              <div className="font-mono font-semibold text-slate-900">{ln.article}</div>
              <div className="mt-1 text-xs text-slate-600">
                GRN Qty: <span className="tabular-nums font-medium text-slate-800">{ln.grnQty}</span>
                {" · "}
                No. Labels: <span className="tabular-nums font-medium text-slate-800">{ln.labelCount}</span>
              </div>
              <div className="mt-1 text-xs text-slate-600">
                Distribution:{" "}
                <span className="font-medium text-slate-800">
                  {ln.distributionText || formatLabelDistribution(ln.labelDistribution || [])}
                </span>
              </div>
              <ul className="mt-2 space-y-0.5 text-xs text-slate-700">
                {(ln.labels || (ln.labelDistribution || []).map((qty, i) => ({ index: i + 1, qty }))).map((row) => (
                  <li key={row.index} className="flex justify-between tabular-nums">
                    <span>#{row.index}</span>
                    <span>Qty {row.qty}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          This queues physical labels only. It does not post the GRN or change stock. Review the
          distribution above before printing — large quantities enqueue one physical label per row.
        </p>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            disabled={isPrinting}
            onClick={() => onCancel?.()}
          >
            Cancel
          </button>
          <LoadingButton
            type="button"
            variant="primary"
            loading={isPrinting}
            loadingText="Queueing…"
            disabled={isPrinting || totalLabels <= 0}
            onClick={() => onPrint?.()}
          >
            Print
          </LoadingButton>
        </div>
      </div>
    </div>
  );
}
