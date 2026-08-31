import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import LoadingButton from "../erp/LoadingButton.jsx";
import { apiPost } from "../../lib/api.js";
import {
  PACKING_LABEL_ALREADY_PRINTED_TOAST,
  PACKING_STANDARD_TEMPLATE_CODE,
  PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE,
  PACKING_QR_LANDSCAPE_V1_UI_LABEL,
  PACKING_QR_LANDSCAPE_V1_PRINT_HINT,
  buildPackingLabelSelections,
  defaultPackingLabelRows,
  selectAllPackingLabelRows,
  selectAvailablePackingLabelRows,
} from "../../lib/labelPrinting.js";
import { PackingLabelPreviewFace } from "./PackingLabelPreviewFace.jsx";
import { PackingQrLandscapePreview } from "./PackingQrLandscapePreview.jsx";

/**
 * Packing Labels — multi-select + manual qty + preview + print.
 * Does not mutate allocation/packing/stock; print is label-only.
 */
function PackingLabelsForm({
  onClose,
  mode = "PRE_PACKING",
  packing = null,
  allocation = null,
  lines = [],
  documentReferences = null,
  printerCode = "",
  printers = [],
  canPrint = true,
  canReprint = false,
  onPrinted,
  onError,
  onRequestReprint,
}) {
  const [rows, setRows] = useState(() => defaultPackingLabelRows(lines, { mode }));
  const [selectedPrinter, setSelectedPrinter] = useState(printerCode || "");
  const [templateCode, setTemplateCode] = useState(PACKING_STANDARD_TEMPLATE_CODE);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewLabels, setPreviewLabels] = useState([]);
  const [previewErr, setPreviewErr] = useState("");
  const [descriptionTruncated, setDescriptionTruncated] = useState(false);
  const [confirmTruncation, setConfirmTruncation] = useState(false);
  const [alreadyPrintedJob, setAlreadyPrintedJob] = useState(null);
  const [previewMeta, setPreviewMeta] = useState(null);
  const titleNo = packing?.packingNo || allocation?.allocationNo || "";
  const isLandscapePreview = templateCode === PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE;

  const selectedCount = useMemo(() => rows.filter((r) => r.selected).length, [rows]);

  const printBlockedByOverflow = descriptionTruncated && !confirmTruncation;
  const landscapePrintBlocked =
    isLandscapePreview &&
    previewMeta &&
    previewMeta.printEnabled !== true &&
    previewMeta.canQueueFirstPrint !== true;

  const previewMut = useMutation({
    mutationFn: async () => {
      const selections = buildPackingLabelSelections(rows);
      if (!selections.length) throw new Error("Select at least one line");
      return apiPost("/labels/jobs/from-packing/preview", {
        mode,
        packingId: packing?._id || undefined,
        allocationId: allocation?._id || packing?.allocationId || undefined,
        selections,
        printerCode: selectedPrinter || undefined,
        templateCode,
      });
    },
    onSuccess: (data) => {
      setPreviewLabels(data.labels || []);
      setPreviewIdx(0);
      setPreviewErr("");
      setPreviewMeta({
        printEnabled: data.printEnabled === true,
        canQueueFirstPrint: data.canQueueFirstPrint === true,
        printBlockedCode: data.printBlockedCode || "",
        printBlockedMessage: data.printBlockedMessage || "",
        vesselPlantSourceMissing: data.vesselPlantSourceMissing === true,
      });
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
      const selections = buildPackingLabelSelections(rows);
      if (!selections.length) throw new Error("Select at least one line");
      if (printBlockedByOverflow) {
        throw new Error("Confirm truncated description before printing.");
      }
      if (landscapePrintBlocked) {
        throw new Error(previewMeta?.printBlockedMessage || PACKING_QR_LANDSCAPE_V1_PRINT_HINT);
      }
      const body = {
        mode,
        packingId: packing?._id || undefined,
        allocationId: allocation?._id || packing?.allocationId || undefined,
        selections,
        printerCode: selectedPrinter || undefined,
        templateCode,
      };
      // Server generates selection-aware hashed idempotency for PRE and POSTED.
      if (mode === "REPRINT") {
        body.mode = "REPRINT";
        body.reason = "Packing label reprint";
      }
      if (descriptionTruncated || confirmTruncation) {
        body.confirmDescriptionTruncation = true;
      }
      return apiPost("/labels/jobs/from-packing", body);
    },
    onSuccess: (data) => {
      const status = String(data?.job?.status || data?.queueState || "").toUpperCase();
      if (data?.reused === true && status === "COMPLETED") {
        setAlreadyPrintedJob(data.job || data);
        onPrinted?.(data, { keepOpen: true });
        return;
      }
      onPrinted?.(data);
      onClose?.();
    },
    onError: (e) => {
      const msg = e.message || "Print failed";
      if (
        e.code === "LABEL_DESCRIPTION_OVERFLOW" ||
        /truncat|exceeds printable/i.test(msg)
      ) {
        setDescriptionTruncated(true);
      }
      onError?.(msg);
    },
  });

  const currentPreview = previewLabels[previewIdx] || null;
  const currentOverflow =
    currentPreview?.descriptionTruncated === true ||
    (currentPreview?.previewRows || []).some((r) => r.descriptionTruncated === true);

  return (
    <Modal open onClose={onClose} title={`Packing Labels — ${titleNo || "—"}`} wide>
      <div className="mb-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
          onClick={() => setRows((prev) => selectAllPackingLabelRows(prev))}
        >
          Select All Allocated
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
          onClick={() => setRows((prev) => selectAvailablePackingLabelRows(prev, { mode }))}
        >
          Select Available Only
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
          onClick={() => setRows((prev) => prev.map((r) => ({ ...r, selected: false })))}
        >
          Clear Selection
        </button>
        <span className="self-center text-xs text-slate-500">{selectedCount} selected</span>
      </div>

      {mode === "PRE_PACKING" ? (
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
          Pre-packing / manual labels. Printing does not change allocation, reservation, packing qty, or stock.
        </p>
      ) : null}

      <div className="mb-3 overflow-auto">
        <table className="min-w-[960px] w-full text-xs">
          <thead className="bg-slate-100 uppercase text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left">Sel</th>
              <th className="px-2 py-2 text-left">S. No.</th>
              <th className="px-2 py-2 text-left">Article</th>
              <th className="px-2 py-2 text-left">Description</th>
              <th className="px-2 py-2 text-left">Part No.</th>
              <th className="px-2 py-2 text-right">Allocated</th>
              <th className="px-2 py-2 text-right">{mode === "PRE_PACKING" ? "Available" : "Packed"}</th>
              <th className="px-2 py-2 text-right">Label Qty</th>
              <th className="px-2 py-2 text-right">Copies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.key} className="border-t">
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) => (x.key === r.key ? { ...x, selected: e.target.checked } : x))
                      )
                    }
                  />
                </td>
                <td className="px-2 py-1.5">{idx + 1}</td>
                <td className="px-2 py-1.5 font-mono">{r.article}</td>
                <td className="max-w-[180px] px-2 py-1.5" title={r.description}>
                  <span className="line-clamp-2">{r.description || "—"}</span>
                </td>
                <td className="px-2 py-1.5 font-mono">{r.partNumber || "—"}</td>
                <td className="px-2 py-1.5 text-right">{r.allocatedQty}</td>
                <td className="px-2 py-1.5 text-right">{r.capQty}</td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, Number(r.capQty) || 1)}
                    className="w-20 rounded border px-1 py-0.5 text-right"
                    value={r.labelQty}
                    disabled={!r.selected}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) =>
                          x.key === r.key ? { ...x, labelQty: e.target.value } : x
                        )
                      )
                    }
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    className="w-16 rounded border px-1 py-0.5 text-right"
                    value={r.copies}
                    disabled={!r.selected}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((x) => (x.key === r.key ? { ...x, copies: e.target.value } : x))
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">
          Printer
          <select
            className="mt-1 block w-full rounded border px-2 py-1.5 text-sm"
            value={selectedPrinter}
            onChange={(e) => setSelectedPrinter(e.target.value)}
          >
            <option value="">Auto-route</option>
            {(printers || []).map((p) => (
              <option key={p._id || p.code} value={p.code}>
                {p.code} — {p.windowsPrinterName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          Template
          <select
            className="mt-1 block w-full rounded border px-2 py-1.5 text-sm"
            value={templateCode}
            onChange={(e) => {
              setTemplateCode(e.target.value);
              setPreviewLabels([]);
              setPreviewIdx(0);
              setPreviewErr("");
              setPreviewMeta(null);
              setDescriptionTruncated(false);
              setConfirmTruncation(false);
            }}
          >
            <option value={PACKING_STANDARD_TEMPLATE_CODE}>Packing Standard 100×50</option>
            <option value={PACKING_QR_LANDSCAPE_V1_TEMPLATE_CODE}>
              {PACKING_QR_LANDSCAPE_V1_UI_LABEL}
            </option>
          </select>
        </label>
        <div className="text-xs text-slate-500 sm:col-span-2">
          Customer: {documentReferences?.customerName || allocation?.customerName || packing?.customerName || "—"}
          <br />
          Customer Ref.: {documentReferences?.customerReference || packing?.customerReference || "—"}
        </div>
      </div>

      {isLandscapePreview ? (
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
          {previewMeta?.printEnabled
            ? "Preview uses persisted label identity. The QR token matches the print payload."
            : previewMeta?.canQueueFirstPrint
              ? "PREVIEW — permanent MAR-PL identities are minted at first print. Vessel/Plant stays blank unless a dedicated source field exists."
              : previewMeta?.printBlockedMessage || PACKING_QR_LANDSCAPE_V1_PRINT_HINT}
        </p>
      ) : null}

      {previewErr ? <p className="mb-2 text-xs text-rose-700">{previewErr}</p> : null}

      {alreadyPrintedJob ? (
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
          {PACKING_LABEL_ALREADY_PRINTED_TOAST}
        </p>
      ) : null}

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
              Preview {previewIdx + 1}/{previewLabels.length}{" "}
              {isLandscapePreview ? "(100 × 150 mm landscape)" : "(100 × 50 mm)"}
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
          {currentOverflow && !isLandscapePreview ? (
            <p className="mb-2 text-xs font-medium text-amber-800">
              Description exceeds printable area. Review label before printing.
            </p>
          ) : null}
          {isLandscapePreview ? (
            <PackingQrLandscapePreview
              svg={currentPreview.svg || ""}
              layout={currentPreview.layout || null}
              blocked={currentPreview.overflow === true || currentPreview.layout?.ok === false}
              errors={currentPreview.overflowCodes || currentPreview.layout?.errorCodes || []}
              identityReady={currentPreview.layout?.qr?.validIdentity === true}
            />
          ) : (
            <PackingLabelPreviewFace rows={currentPreview.previewRows || []} />
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={onClose}>
          Cancel
        </button>
        <LoadingButton
          type="button"
          variant="secondary"
          loading={previewMut.isPending}
          loadingText="Preview…"
          disabled={selectedCount <= 0}
          onClick={() => previewMut.mutate()}
        >
          Preview Selected
        </LoadingButton>
        {alreadyPrintedJob ? (
          <LoadingButton
            type="button"
            variant="primary"
            disabled={!canReprint}
            onClick={() => onRequestReprint?.(alreadyPrintedJob)}
          >
            Reprint Packing Labels
          </LoadingButton>
        ) : (
          <LoadingButton
            type="button"
            variant="primary"
            loading={printMut.isPending}
            loadingText="Queueing…"
            disabled={!canPrint || selectedCount <= 0 || printBlockedByOverflow || printMut.isPending || landscapePrintBlocked}
            onClick={() => printMut.mutate()}
          >
            Print Selected
          </LoadingButton>
        )}
      </div>
    </Modal>
  );
}

export default function PackingLabelsModal(props) {
  if (!props.open) return null;
  const key = `${props.mode || "PRE_PACKING"}:${props.packing?._id || ""}:${props.allocation?._id || ""}:${props.printerCode || ""}`;
  return <PackingLabelsForm key={key} {...props} />;
}
