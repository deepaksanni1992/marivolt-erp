import { useEffect, useId, useMemo, useRef, useState } from "react";
import LoadingButton from "../erp/LoadingButton.jsx";
import {
  formatLabelDistribution,
  formatLabelDistributionCompact,
  formatGrnLabelPreviewSummaryLine,
  formatGrnLabelPrintButtonText,
  parseDistributionInput,
  validateGrnLabelLinePrintConfig,
} from "../../lib/grnLabelDistribution.js";

const PREVIEW_CARD_LIMIT = 8;

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
  copies = 1,
  isPrinting = false,
  staleWarning = "",
  onPrint,
  onCancel,
  onLineConfigChange,
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const [editingKey, setEditingKey] = useState("");
  const [draftDistText, setDraftDistText] = useState("");
  const [draftDistError, setDraftDistError] = useState("");
  const [showAllByKey, setShowAllByKey] = useState({});

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

  useEffect(() => {
    if (!open) {
      setEditingKey("");
      setDraftDistText("");
      setDraftDistError("");
      setShowAllByKey({});
    }
  }, [open]);

  const lineValidations = useMemo(
    () =>
      (lines || []).map((ln) =>
        validateGrnLabelLinePrintConfig({
          print: true,
          article: ln.article,
          receivedQty: ln.grnQty,
          labelCount: ln.labelCount,
          labelDistribution: ln.labelDistribution,
        })
      ),
    [lines]
  );

  const hasInvalid = lineValidations.some((v) => !v.ok);
  const printLabel = formatGrnLabelPrintButtonText(totalLabels, copies);
  const copyCount = Math.max(1, Math.floor(Number(copies) || 1));

  if (!open) return null;

  const lineKey = (ln, idx) => String(ln.poLineId || ln.article || idx);

  const startEdit = (ln, idx) => {
    const key = lineKey(ln, idx);
    setEditingKey(key);
    setDraftDistText(formatLabelDistribution(ln.labelDistribution || []));
    setDraftDistError("");
  };

  const applyCustom = (ln, idx) => {
    const parsed = parseDistributionInput(draftDistText);
    const validated = validateGrnLabelLinePrintConfig({
      print: true,
      article: ln.article,
      receivedQty: ln.grnQty,
      labelCount: parsed.length,
      labelDistribution: parsed,
    });
    if (!validated.ok) {
      setDraftDistError(validated.message || "Invalid distribution.");
      return;
    }
    onLineConfigChange?.(ln.poLineId, {
      labelEditMode: "custom",
      labelCount: validated.distribution.length,
      labelDistribution: validated.distribution,
    });
    setEditingKey("");
    setDraftDistError("");
  };

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
        className="relative max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
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
          {copyCount > 1 ? (
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Copies</dt>
              <dd className="tabular-nums">
                {copyCount} × {totalLabels} = {copyCount * totalLabels} printed
              </dd>
            </div>
          ) : null}
        </dl>

        {staleWarning ? (
          <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {staleWarning}
          </div>
        ) : null}

        <div className="mb-3 space-y-1 rounded border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-800">
          {(lines || []).map((ln, idx) => (
            <div key={`sum-${lineKey(ln, idx)}`} className="font-medium break-words">
              {formatGrnLabelPreviewSummaryLine(ln)}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {(lines || []).map((ln, idx) => {
            const key = lineKey(ln, idx);
            const dist = ln.labelDistribution || [];
            const validation = lineValidations[idx];
            const editing = editingKey === key;
            const showAll = Boolean(showAllByKey[key]);
            const previewRows =
              ln.labels || dist.map((qty, i) => ({ index: i + 1, qty }));
            const visibleRows =
              showAll || previewRows.length <= PREVIEW_CARD_LIMIT
                ? previewRows
                : previewRows.slice(0, PREVIEW_CARD_LIMIT);
            return (
              <div key={key} className="rounded border border-slate-200 p-3 text-sm">
                <div className="font-mono font-semibold text-slate-900">{ln.article}</div>
                {ln.description ? (
                  <div className="mt-0.5 text-xs text-slate-600">{ln.description}</div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-end gap-3 text-xs text-slate-600">
                  <div>
                    GRN Qty:{" "}
                    <span className="tabular-nums font-medium text-slate-800">{ln.grnQty}</span>
                  </div>
                  <label className="inline-flex items-center gap-1">
                    No. Labels
                    <input
                      type="number"
                      min="1"
                      step="1"
                      disabled={isPrinting || !onLineConfigChange}
                      className="w-16 rounded border px-1 py-0.5 text-right tabular-nums"
                      value={ln.labelCount ?? dist.length}
                      onChange={(e) => {
                        onLineConfigChange?.(ln.poLineId, {
                          labelEditMode: "count",
                          labelCount: e.target.value,
                        });
                        if (editingKey === key) {
                          setEditingKey("");
                          setDraftDistError("");
                        }
                      }}
                    />
                  </label>
                </div>
                <div className="mt-2 text-xs text-slate-600">
                  Distribution:{" "}
                  <span className="font-medium text-slate-800 break-words">
                    {formatLabelDistributionCompact(dist)}
                  </span>
                </div>
                {validation && !validation.ok ? (
                  <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
                    {validation.message}
                  </div>
                ) : null}
                {editing ? (
                  <div className="mt-2 space-y-1">
                    <label className="block text-[11px] font-semibold uppercase text-slate-500">
                      Edit Distribution
                      <input
                        type="text"
                        className="mt-0.5 w-full rounded border px-2 py-1 font-mono text-xs"
                        value={draftDistText}
                        disabled={isPrinting}
                        placeholder="50 + 50 + 18"
                        onChange={(e) => {
                          setDraftDistText(e.target.value);
                          setDraftDistError("");
                        }}
                      />
                    </label>
                    {draftDistError ? (
                      <div className="text-xs text-red-700">{draftDistError}</div>
                    ) : (
                      <div className="text-[11px] text-slate-500">
                        Enter quantities separated by + or comma. Total must equal GRN Qty {ln.grnQty}.
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold hover:bg-slate-50"
                        disabled={isPrinting}
                        onClick={() => applyCustom(ln, idx)}
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600"
                        disabled={isPrinting}
                        onClick={() => {
                          setEditingKey("");
                          setDraftDistError("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="mt-2 text-[11px] font-semibold text-sky-700 hover:underline disabled:opacity-40"
                    disabled={isPrinting || !onLineConfigChange}
                    onClick={() => startEdit(ln, idx)}
                  >
                    Edit Distribution
                  </button>
                )}
                <ul className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {visibleRows.map((row) => (
                    <li
                      key={row.index}
                      className="flex justify-between rounded border border-slate-100 bg-slate-50 px-2 py-1 text-xs tabular-nums text-slate-700"
                    >
                      <span>#{row.index}</span>
                      <span>Qty {row.qty}</span>
                    </li>
                  ))}
                </ul>
                {previewRows.length > PREVIEW_CARD_LIMIT ? (
                  <button
                    type="button"
                    className="mt-1 text-[11px] font-semibold text-slate-600 hover:underline"
                    onClick={() =>
                      setShowAllByKey((prev) => ({ ...prev, [key]: !showAll }))
                    }
                  >
                    {showAll ? "Show fewer" : `Show all ${previewRows.length} labels`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          This queues physical labels only. It does not post the GRN or change stock. Copies reprint
          the same label set and do not change GRN quantity.
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
            disabled={isPrinting || totalLabels <= 0 || hasInvalid}
            onClick={() => onPrint?.()}
          >
            {printLabel}
          </LoadingButton>
        </div>
      </div>
    </div>
  );
}
