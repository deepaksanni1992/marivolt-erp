import { useEffect, useId, useRef } from "react";
import LoadingButton from "../erp/LoadingButton.jsx";

/**
 * Optional post-GRN label decision (UX only).
 * Escape / close icon behave as Skip. Does not post GRN or touch stock.
 */
export default function PostGrnLabelDecisionDialog({
  open,
  grnNo = "",
  warehouseCode = "",
  selectedLineCount = 0,
  totalLabelQty = 0,
  isQueueing = false,
  onPrint,
  onSkip,
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocused.current = document.activeElement;
    const skipBtn = panelRef.current?.querySelector("[data-post-grn-skip]");
    (skipBtn instanceof HTMLElement ? skipBtn : panelRef.current)?.focus?.();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!isQueueing) onSkip?.();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [open, isQueueing, onSkip]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Skip label printing"
        tabIndex={-1}
        disabled={isQueueing}
        onClick={() => {
          if (!isQueueing) onSkip?.();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/20"
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            GRN Posted Successfully
          </h2>
          <button
            type="button"
            className="shrink-0 rounded-lg border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
            aria-label="Skip label printing"
            disabled={isQueueing}
            onClick={() => onSkip?.()}
          >
            ×
          </button>
        </div>

        <dl className="space-y-2 text-sm text-slate-700">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">GRN Number</dt>
            <dd className="font-mono font-semibold text-slate-900">{grnNo || "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Warehouse</dt>
            <dd className="font-medium text-slate-900">{warehouseCode || "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Selected Articles</dt>
            <dd className="tabular-nums font-medium text-slate-900">{selectedLineCount}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Labels Available</dt>
            <dd className="tabular-nums font-medium text-slate-900">{totalLabelQty}</dd>
          </div>
        </dl>

        <p id={descId} className="mt-4 text-sm text-slate-600">
          Would you like to print labels now?
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <LoadingButton
            type="button"
            variant="primary"
            loading={isQueueing}
            loadingText="Queueing Labels…"
            disabled={isQueueing || totalLabelQty <= 0}
            onClick={() => onPrint?.()}
          >
            Print Labels
          </LoadingButton>
          <button
            type="button"
            data-post-grn-skip
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isQueueing}
            onClick={() => onSkip?.()}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
