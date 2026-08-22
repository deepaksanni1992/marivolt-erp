import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import LoadingButton from "../erp/LoadingButton.jsx";
import { apiPost } from "../../lib/api.js";
import { PackingLabelPreviewFace } from "./PackingLabelPreviewFace.jsx";
import {
  buildCustomPackingPayload,
  downloadCustomPackingTemplateXlsx,
  emptyCustomPackingHeader,
  emptyCustomPackingTableRow,
  exportCustomPackingRows,
  importCustomPackingSpreadsheetFile,
  rowDerivedTotal,
  summarizeCustomPackingRows,
} from "../../lib/customPackingLabelSpreadsheet.js";

/**
 * Manual CUSTOM_PACKING labels — same 100×50 packing face (Article omitted).
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
  const fileInputRef = useRef(null);
  const [header, setHeader] = useState(emptyCustomPackingHeader());
  const [rows, setRows] = useState([emptyCustomPackingTableRow("1")]);
  const [selectedPrinter, setSelectedPrinter] = useState("");
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewLabels, setPreviewLabels] = useState([]);
  const [previewSummary, setPreviewSummary] = useState(null);
  const [previewErr, setPreviewErr] = useState("");
  const [importErr, setImportErr] = useState("");
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  const [confirmTruncation, setConfirmTruncation] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHeader(emptyCustomPackingHeader());
    setRows([emptyCustomPackingTableRow("1")]);
    setSelectedPrinter(printerCode || "");
    setPreviewIdx(0);
    setPreviewLabels([]);
    setPreviewSummary(null);
    setPreviewErr("");
    setImportErr("");
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
  }, [open, printerCode]);

  const payload = useMemo(() => buildCustomPackingPayload(header, rows), [header, rows]);
  const localSummary = useMemo(() => summarizeCustomPackingRows(rows), [rows]);
  const printBlockedByOverflow = descriptionTruncated && !confirmTruncation;

  function invalidatePreview() {
    setPreviewLabels([]);
    setPreviewSummary(null);
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
  }

  function updateHeader(patch) {
    setHeader((prev) => ({ ...prev, ...patch }));
    invalidatePreview();
  }

  function updateRow(idx, patch) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    invalidatePreview();
  }

  function addRow() {
    setRows((prev) => [...prev, emptyCustomPackingTableRow(String(prev.length + 1))]);
    invalidatePreview();
  }

  function duplicateRow(idx) {
    setRows((prev) => {
      const src = prev[idx];
      if (!src) return prev;
      const copy = emptyCustomPackingTableRow(String(prev.length + 1), {
        partNo: src.partNo,
        description: src.description,
        qty: src.qty,
        labelCount: src.labelCount,
      });
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    invalidatePreview();
  }

  function removeRow(idx) {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    invalidatePreview();
  }

  function clearRows() {
    setRows([emptyCustomPackingTableRow("1")]);
    invalidatePreview();
  }

  async function handleImportFile(file) {
    if (!file) return;
    setImportErr("");
    try {
      const imported = await importCustomPackingSpreadsheetFile(file);
      setRows(imported);
      invalidatePreview();
    } catch (e) {
      const msg = e.message || "Import failed";
      setImportErr(msg);
      onError?.(msg);
    }
  }

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!payload.lines.length) throw new Error("Add at least one row");
      return apiPost("/labels/jobs/from-custom-packing/preview", {
        ...payload,
        printerCode: selectedPrinter || undefined,
      });
    },
    onSuccess: (data) => {
      setPreviewLabels(data.labels || []);
      setPreviewSummary(data.summary || null);
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
      if (!payload.lines.length) throw new Error("Add at least one row");
      if (!previewLabels.length) throw new Error("Preview labels before printing");
      return apiPost("/labels/jobs/from-custom-packing", {
        ...payload,
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
  const summary = previewSummary || localSummary;

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="Custom Packing Label — 100×50"
      subtitle="Batch header applies to all rows. Print-only — does not change stock or documents."
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
          + Add Row
        </button>
        <button type="button" className="rounded border px-2 py-1 text-xs" onClick={clearRows}>
          Clear All
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs"
          onClick={() => fileInputRef.current?.click()}
        >
          Import Excel/CSV
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs"
          onClick={() => exportCustomPackingRows(rows)}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs"
          onClick={() => downloadCustomPackingTemplateXlsx().catch((e) => setImportErr(e.message))}
        >
          Download Template
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            handleImportFile(file);
          }}
        />
      </div>

      <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase text-slate-600">Common header (all labels)</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["customerName", "Customer"],
            ["customerRef", "Customer Ref."],
            ["brand", "Brand"],
            ["modelName", "Model"],
          ].map(([key, label]) => (
            <label key={key} className="text-xs text-slate-600">
              {label}
              <input
                className="mt-0.5 w-full rounded border bg-white px-2 py-1 text-sm"
                value={header[key]}
                onChange={(e) => updateHeader({ [key]: e.target.value })}
                autoComplete="off"
              />
            </label>
          ))}
        </div>
      </div>

      {importErr ? <p className="mb-2 whitespace-pre-wrap text-xs text-rose-700">{importErr}</p> : null}

      <div className="mb-3 max-h-[40vh] overflow-auto rounded-xl border border-slate-200">
        <table className="min-w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-100 text-slate-700">
            <tr>
              <th className="px-2 py-2">S. No.</th>
              <th className="px-2 py-2">Part No.</th>
              <th className="px-2 py-2">Description</th>
              <th className="px-2 py-2 text-right">Qty</th>
              <th className="px-2 py-2 text-right">No. of Labels</th>
              <th className="px-2 py-2 text-right">Total</th>
              <th className="px-2 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key} className="border-t border-slate-100">
                <td className="px-2 py-1">
                  <input
                    className="w-16 rounded border px-1 py-0.5 text-sm"
                    value={r.serialNo}
                    onChange={(e) => updateRow(idx, { serialNo: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full min-w-[7rem] rounded border px-1 py-0.5 text-sm"
                    value={r.partNo}
                    onChange={(e) => updateRow(idx, { partNo: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    className="w-full min-w-[10rem] rounded border px-1 py-0.5 text-sm"
                    value={r.description}
                    onChange={(e) => updateRow(idx, { description: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="w-20 rounded border px-1 py-0.5 text-right text-sm"
                    value={r.qty}
                    onChange={(e) => updateRow(idx, { qty: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1 text-right">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    className="w-20 rounded border px-1 py-0.5 text-right text-sm"
                    value={r.labelCount}
                    onChange={(e) => updateRow(idx, { labelCount: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1 text-right font-medium text-slate-700">{rowDerivedTotal(r)}</td>
                <td className="px-2 py-1">
                  <div className="flex gap-2">
                    <button type="button" className="text-[11px] text-slate-700 underline" onClick={() => duplicateRow(idx)}>
                      Duplicate
                    </button>
                    {rows.length > 1 ? (
                      <button type="button" className="text-[11px] text-rose-700 underline" onClick={() => removeRow(idx)}>
                        Delete
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mb-3 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
        <span className="font-semibold">Print summary:</span> Rows: {summary.rowCount} · Physical Labels:{" "}
        {summary.physicalLabels} · Total Quantity Represented: {summary.totalQtyRepresented}
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
