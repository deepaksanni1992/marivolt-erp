import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import LoadingButton from "../erp/LoadingButton.jsx";
import { apiPost } from "../../lib/api.js";
import { emptyCustomPackingLabelRow } from "../../lib/labelPrinting.js";
import { PackingLabelPreviewFace } from "./PackingLabelPreviewFace.jsx";

/**
 * Manual CUSTOM_PACKING labels — same 100×50 packing face.
 * Print-only; does not mutate stock/GRN/allocation/packing.
 */
export default function CustomPackingLabelModal({
  open,
  onClose,
  printerCode = "",
  printers = [],
  onPrinted,
  onError,
}) {
  const [rows, setRows] = useState([emptyCustomPackingLabelRow()]);
  const [selectedPrinter, setSelectedPrinter] = useState("");
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewLabels, setPreviewLabels] = useState([]);
  const [previewErr, setPreviewErr] = useState("");
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  const [confirmTruncation, setConfirmTruncation] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows([emptyCustomPackingLabelRow()]);
    setSelectedPrinter(printerCode || "");
    setPreviewIdx(0);
    setPreviewLabels([]);
    setPreviewErr("");
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
  }, [open, printerCode]);

  const printBlockedByOverflow = descriptionTruncated && !confirmTruncation;

  const payloadLines = useMemo(
    () =>
      rows.map((r) => ({
        customerName: r.customerName,
        customerRef: r.customerRef,
        brand: r.brand,
        modelName: r.modelName,
        article: r.article,
        serialNo: r.serialNo,
        partNo: r.partNo,
        description: r.description,
        labelQty: r.labelQty,
        totalQty: String(r.totalQty ?? "").trim() === "" ? "" : r.totalQty,
        copies: r.copies,
      })),
    [rows]
  );

  function updateRow(idx, patch) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setPreviewLabels([]);
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
  }

  function addRow() {
    setRows((prev) => [...prev, emptyCustomPackingLabelRow()]);
  }

  function removeRow(idx) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!payloadLines.length) throw new Error("Add at least one label");
      return apiPost("/labels/jobs/from-custom-packing/preview", {
        lines: payloadLines,
        printerCode: selectedPrinter || undefined,
      });
    },
    onSuccess: (data) => {
      setPreviewLabels(data.labels || []);
      setPreviewIdx(0);
      setPreviewErr("");
      const overflow = data.descriptionTruncated === true || data.requiresTruncationConfirmation === true;
      setDescriptionTruncated(overflow);
      if (!overflow) setConfirmTruncation(false);
    },
    onError: (e) => {
      setPreviewErr(e.message || "Preview failed");
      onError?.(e.message || "Preview failed");
    },
  });

  const printMut = useMutation({
    mutationFn: async () => {
      if (!payloadLines.length) throw new Error("Add at least one label");
      if (!previewLabels.length) throw new Error("Preview labels before printing");
      return apiPost("/labels/jobs/from-custom-packing", {
        lines: payloadLines,
        printerCode: selectedPrinter || undefined,
        confirmDescriptionTruncation: confirmTruncation,
      });
    },
    onSuccess: (data) => {
      onPrinted?.(data.job);
      onClose?.();
    },
    onError: (e) => onError?.(e.message || "Print failed"),
  });

  const currentPreview = previewLabels[previewIdx] || null;

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="Custom Packing Label — 100×50"
      subtitle="Manual entry. Same layout as packing labels. Print-only — does not change stock or documents."
      onClose={onClose}
      wide
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-600">
          Printer{" "}
          <select
            className="ml-1 rounded border px-2 py-1 text-xs"
            value={selectedPrinter}
            onChange={(e) => setSelectedPrinter(e.target.value)}
          >
            <option value="">Default route</option>
            {(printers || []).map((p) => (
              <option key={p.code || p._id} value={p.code || ""}>
                {p.code || p.windowsPrinterName || p._id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="rounded border px-2 py-1 text-xs font-semibold" onClick={addRow}>
          + Add Label
        </button>
      </div>

      <div className="mb-3 max-h-[40vh] space-y-3 overflow-y-auto">
        {rows.map((r, idx) => (
          <div key={r.key} className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase text-slate-600">Label {idx + 1}</div>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className="text-xs text-rose-700 underline"
                  onClick={() => removeRow(idx)}
                >
                  Remove
                </button>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ["customerName", "Customer"],
                ["customerRef", "Customer Ref."],
                ["brand", "Brand"],
                ["modelName", "Model"],
                ["article", "Article"],
                ["serialNo", "S. No."],
                ["partNo", "Part No."],
              ].map(([key, label]) => (
                <label key={key} className="text-xs text-slate-600">
                  {label}
                  <input
                    className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                    value={r[key]}
                    onChange={(e) => updateRow(idx, { [key]: e.target.value })}
                    autoComplete="off"
                  />
                </label>
              ))}
            </div>
            <label className="mt-2 block text-xs text-slate-600">
              Description
              <textarea
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                rows={3}
                value={r.description}
                onChange={(e) => updateRow(idx, { description: e.target.value })}
              />
            </label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <label className="text-xs text-slate-600">
                Label Qty
                <input
                  type="number"
                  min={1}
                  className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                  value={r.labelQty}
                  onChange={(e) => updateRow(idx, { labelQty: e.target.value })}
                />
              </label>
              <label className="text-xs text-slate-600">
                Total Qty
                <input
                  type="number"
                  min={1}
                  className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                  value={r.totalQty}
                  placeholder="optional"
                  onChange={(e) => updateRow(idx, { totalQty: e.target.value })}
                />
              </label>
              <label className="text-xs text-slate-600">
                Copies
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
                  value={r.copies}
                  onChange={(e) => updateRow(idx, { copies: e.target.value })}
                />
              </label>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              QTY prints as{" "}
              {String(r.totalQty || "").trim()
                ? `${r.labelQty || "?"} of ${r.totalQty}`
                : String(r.labelQty || "?")}
              . Copies only repeat stickers.
            </p>
          </div>
        ))}
      </div>

      {previewErr ? <p className="mb-2 text-xs text-rose-700">{previewErr}</p> : null}

      {descriptionTruncated ? (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <p className="font-semibold">Description exceeds printable area. Review label before printing.</p>
          <p className="mt-1">Printed text will be truncated.</p>
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmTruncation}
              onChange={(e) => setConfirmTruncation(e.target.checked)}
            />
            <span>Print with truncated description</span>
          </label>
        </div>
      ) : null}

      {currentPreview ? (
        <div className="mb-3 rounded border bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase text-slate-600">
              Preview {previewIdx + 1}/{previewLabels.length} (100 × 50 mm)
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs disabled:opacity-40"
                disabled={previewIdx <= 0}
                onClick={() => setPreviewIdx((i) => Math.max(0, i - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs disabled:opacity-40"
                disabled={previewIdx >= previewLabels.length - 1}
                onClick={() => setPreviewIdx((i) => Math.min(previewLabels.length - 1, i + 1))}
              >
                Next
              </button>
            </div>
          </div>
          <PackingLabelPreviewFace rows={currentPreview.previewRows || []} />
        </div>
      ) : (
        <p className="mb-3 text-xs text-slate-500">Preview required before print.</p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onClose}>
          Cancel
        </button>
        <LoadingButton
          type="button"
          className="rounded-xl border px-3 py-2 text-sm font-medium"
          loading={previewMut.isPending}
          onClick={() => previewMut.mutate()}
        >
          Preview
        </LoadingButton>
        <LoadingButton
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          loading={printMut.isPending}
          disabled={!previewLabels.length || printBlockedByOverflow}
          onClick={() => printMut.mutate()}
        >
          Print
        </LoadingButton>
      </div>
    </Modal>
  );
}
