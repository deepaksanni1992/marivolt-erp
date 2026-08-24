import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { apiGet, apiPost } from "../../lib/api.js";
import { useAuth } from "../../context/AuthContext.jsx";
import { PackingLabelPreviewFace } from "./PackingLabelPreviewFace.jsx";
import { REPRINT_REASONS } from "../../lib/labelPrinting.js";
import {
  buildCustomPackingPayload,
  downloadCustomPackingTemplateXlsx,
  emptyCustomPackingHeader,
  emptyCustomPackingTableRow,
  exportCustomPackingRows,
  importCustomPackingSpreadsheetFile,
  rowDerivedTotal,
  rowHasContent,
  summarizeCustomPackingRows,
} from "../../lib/customPackingLabelSpreadsheet.js";

const TERMINAL = new Set(["COMPLETED", "FAILED", "UNCERTAIN", "CANCELLED", "PARTIAL"]);

async function waitForJobTerminal(jobId, { intervalMs = 1500, maxMs = 180000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const data = await apiGet(`/labels/jobs/${jobId}`);
    const job = data.job || data;
    const st = String(job?.status || "").toUpperCase();
    if (TERMINAL.has(st)) return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for printer result");
}

function statusBadge(state) {
  const s = String(state || "NOT_PRINTED").toUpperCase();
  if (s === "PRINTED") return { label: "PRINTED", className: "bg-emerald-100 text-emerald-800" };
  if (s === "PRINTING") return { label: "PRINTING…", className: "bg-sky-100 text-sky-800" };
  if (s === "UNCERTAIN") return { label: "UNCERTAIN", className: "bg-amber-100 text-amber-900" };
  if (s === "FAILED") return { label: "FAILED", className: "bg-rose-100 text-rose-800" };
  return { label: "NOT PRINTED", className: "bg-slate-100 text-slate-600" };
}

/**
 * Manual CUSTOM_PACKING labels — same 100×50 packing face (Article omitted).
 * Row-level Preview / Print / Reprint. Print-only; does not mutate stock.
 */
export default function CustomPackingLabelModal({
  open,
  onClose,
  printerCode = "",
  printers = [],
  onPrinted,
  onError,
}) {
  const { can } = useAuth();
  const canPrint = can("LABELS", "print");
  const canReprint = can("LABELS", "reprint");
  const fileInputRef = useRef(null);
  const [header, setHeader] = useState(emptyCustomPackingHeader());
  const [rows, setRows] = useState([emptyCustomPackingTableRow("1")]);
  const [selectedPrinter, setSelectedPrinter] = useState("");
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewLabels, setPreviewLabels] = useState([]);
  const [previewRowId, setPreviewRowId] = useState("");
  const [previewErr, setPreviewErr] = useState("");
  const [importErr, setImportErr] = useState("");
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  const [confirmTruncation, setConfirmTruncation] = useState(false);
  /** rowId → { status, jobId, originalJobId, contentFingerprint, message } — UI cache; server history is authoritative. */
  const [rowPrintState, setRowPrintState] = useState({});
  const [pendingRowId, setPendingRowId] = useState("");
  const [reprintReason, setReprintReason] = useState(REPRINT_REASONS[0]);
  const hydrateSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setHeader(emptyCustomPackingHeader());
    setRows([emptyCustomPackingTableRow("1")]);
    setSelectedPrinter(printerCode || "");
    setPreviewIdx(0);
    setPreviewLabels([]);
    setPreviewRowId("");
    setPreviewErr("");
    setImportErr("");
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
    setRowPrintState({});
    setPendingRowId("");
    setReprintReason(REPRINT_REASONS[0]);
  }, [open, printerCode]);

  const payload = useMemo(() => buildCustomPackingPayload(header, rows), [header, rows]);
  const localSummary = useMemo(() => summarizeCustomPackingRows(rows), [rows]);

  async function hydrateRowPrintState(nextHeader = header, nextRows = rows) {
    const body = buildCustomPackingPayload(nextHeader, nextRows);
    const seq = ++hydrateSeq.current;
    if (!body.lines.length) {
      if (seq === hydrateSeq.current) setRowPrintState({});
      return;
    }
    try {
      const data = await apiPost("/labels/jobs/from-custom-packing/row-print-status", {
        ...body,
      });
      if (seq !== hydrateSeq.current) return;
      const map = {};
      for (const r of data.rows || []) {
        if (!r.rowId) continue;
        map[r.rowId] = {
          status: r.status || "NOT_PRINTED",
          jobId: r.originalJobId || r.jobId || "",
          originalJobId: r.originalJobId || "",
          contentFingerprint: r.contentFingerprint || "",
          message: r.message || "",
        };
      }
      setRowPrintState(map);
    } catch {
      // Keep last cache; durable state is re-fetched on next successful hydrate.
    }
  }

  // Debounced authoritative hydrate from LabelPrintJob history (survives modal reload / re-import).
  useEffect(() => {
    if (!open) return;
    if (pendingRowId) return;
    if (!payload.lines?.length) return;
    const timer = setTimeout(() => {
      hydrateRowPrintState(header, rows);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate from latest header/rows via payload identity
  }, [open, payload, pendingRowId]);

  function clearPreviewPanel() {
    setPreviewLabels([]);
    setPreviewRowId("");
    setPreviewIdx(0);
    setDescriptionTruncated(false);
    setConfirmTruncation(false);
  }

  function updateHeader(patch) {
    setHeader((prev) => ({ ...prev, ...patch }));
    clearPreviewPanel();
  }

  function updateRow(idx, patch) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    clearPreviewPanel();
  }

  function addRow() {
    setRows((prev) => [...prev, emptyCustomPackingTableRow(String(prev.length + 1))]);
    clearPreviewPanel();
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
    clearPreviewPanel();
  }

  function removeRow(idx) {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
    clearPreviewPanel();
  }

  function clearRows() {
    setRows([emptyCustomPackingTableRow("1")]);
    setRowPrintState({});
    clearPreviewPanel();
  }

  async function handleImportFile(file) {
    if (!file) return;
    setImportErr("");
    try {
      const imported = await importCustomPackingSpreadsheetFile(file);
      setRows(imported);
      setRowPrintState({});
      clearPreviewPanel();
      await hydrateRowPrintState(header, imported);
    } catch (e) {
      const msg = e.message || "Import failed";
      setImportErr(msg);
      onError?.(msg);
    }
  }

  const previewMut = useMutation({
    mutationFn: async (rowId) => {
      if (!rowId) throw new Error("Select a row to preview");
      return apiPost("/labels/jobs/from-custom-packing/preview", {
        ...payload,
        rowId,
        printerCode: selectedPrinter || undefined,
      });
    },
    onSuccess: (data, rowId) => {
      setPreviewLabels(data.labels || []);
      setPreviewRowId(rowId);
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
    mutationFn: async ({ rowId, isReprint, jobId }) => {
      if (!rowId) throw new Error("Select a row to print");
      setPendingRowId(rowId);
      setRowPrintState((prev) => ({
        ...prev,
        [rowId]: { ...(prev[rowId] || {}), status: "PRINTING", message: "" },
      }));

      let job;
      if (isReprint) {
        if (!jobId) throw new Error("Missing previous print job for reprint");
        const res = await apiPost(`/labels/jobs/${jobId}/reprint`, {
          reason: reprintReason || "Custom packing reprint",
          printerCode: selectedPrinter || undefined,
        });
        job = res.job || res;
      } else {
        const res = await apiPost("/labels/jobs/from-custom-packing", {
          ...payload,
          rowId,
          action: "PRINT",
          printerCode: selectedPrinter || undefined,
          confirmDescriptionTruncation: confirmTruncation,
        });
        job = res.job || res;
      }

      const finalJob = await waitForJobTerminal(job._id || job.id);
      return { rowId, job: finalJob, isReprint };
    },
    onSuccess: async ({ job }) => {
      setPendingRowId("");
      const st = String(job.status || "").toUpperCase();
      if (st === "COMPLETED") {
        onPrinted?.(job);
      } else if (st === "UNCERTAIN" || st === "PARTIAL") {
        onError?.(`Job ${job.jobNo || ""} print status uncertain`);
      } else {
        onError?.(job.error || job.lastError || `Job ${job.jobNo || ""} failed`);
      }
      // Authoritative state from persisted LabelPrintJob history (not session-only).
      await hydrateRowPrintState(header, rows);
    },
    onError: (e, vars) => {
      setPendingRowId("");
      const rowId = vars?.rowId;
      if (rowId) {
        setRowPrintState((prev) => ({
          ...prev,
          [rowId]: {
            ...(prev[rowId] || {}),
            status: prev[rowId]?.status === "PRINTED" ? "PRINTED" : "FAILED",
            message: e.message || "Print failed",
          },
        }));
      }
      onError?.(e.message || "Print failed");
      hydrateRowPrintState(header, rows);
    },
  });

  const currentPreview = previewLabels[previewIdx] || null;
  const summary = localSummary;

  if (!open) return null;

  return (
    <Modal
      open={open}
      title="Custom Packing Label — 100×50"
      subtitle="Preview and print each imported row individually. Print-only — does not change stock or documents."
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
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const st = rowPrintState[r.rowId] || { status: "NOT_PRINTED" };
              const badge = statusBadge(st.status);
              const isPreviewing = previewRowId === r.rowId;
              const isPending = pendingRowId === r.rowId || (printMut.isPending && pendingRowId === r.rowId);
              const showReprint = st.status === "PRINTED" && st.jobId;
              const showUncertain = st.status === "UNCERTAIN";
              return (
                <tr
                  key={r.rowId || r.key}
                  className={`border-t border-slate-100 ${isPreviewing ? "bg-sky-50" : ""}`}
                >
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
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}>
                        {badge.label}
                      </span>
                      <button
                        type="button"
                        className="text-[11px] font-semibold text-sky-800 underline disabled:opacity-40"
                        disabled={!rowHasContent(r) || previewMut.isPending}
                        onClick={() => previewMut.mutate(r.rowId)}
                      >
                        Preview
                      </button>
                      {showUncertain ? (
                        <span className="text-[11px] text-amber-800" title={st.message || ""}>
                          Confirm in queue
                        </span>
                      ) : showReprint ? (
                        <button
                          type="button"
                          className="text-[11px] font-semibold text-slate-900 underline disabled:opacity-40"
                          disabled={!canReprint || isPending}
                          onClick={() =>
                            printMut.mutate({ rowId: r.rowId, isReprint: true, jobId: st.jobId })
                          }
                        >
                          {isPending ? "Printing…" : "Reprint"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-[11px] font-semibold text-slate-900 underline disabled:opacity-40"
                          disabled={
                            !canPrint ||
                            !rowHasContent(r) ||
                            isPending ||
                            (descriptionTruncated && previewRowId === r.rowId && !confirmTruncation)
                          }
                          onClick={() => printMut.mutate({ rowId: r.rowId, isReprint: false })}
                        >
                          {isPending ? "Printing…" : "Print"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-[11px] text-slate-700 underline"
                        onClick={() => duplicateRow(idx)}
                      >
                        Duplicate
                      </button>
                      {rows.length > 1 ? (
                        <button
                          type="button"
                          className="text-[11px] text-rose-700 underline"
                          onClick={() => removeRow(idx)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                    {st.message ? <p className="mt-0.5 text-[10px] text-slate-600">{st.message}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mb-3 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
        <span className="font-semibold">Batch summary:</span> Rows: {summary.rowCount} · Physical Labels:{" "}
        {summary.physicalLabels} · Total Quantity Represented: {summary.totalQtyRepresented}
      </div>

      {canReprint ? (
        <label className="mb-3 block text-xs text-slate-600">
          Reprint reason{" "}
          <select
            className="ml-1 rounded border px-2 py-1 text-xs"
            value={reprintReason}
            onChange={(e) => setReprintReason(e.target.value)}
          >
            {REPRINT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {previewErr ? <p className="mb-2 text-xs text-rose-700">{previewErr}</p> : null}

      {descriptionTruncated && previewRowId ? (
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
              {previewRowId ? ` · row selected` : ""}
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
        <p className="mb-3 text-xs text-slate-500">Click Preview on a row to show its 100×50 label face.</p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
