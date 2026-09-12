import { useEffect, useId, useMemo, useState } from "react";
import { apiPost } from "../../lib/api.js";
import { isAsnReceivingGrn } from "../../lib/asnUi.js";
import {
  buildGrnLabelPreviewRows,
  buildPostedGrnLabelLines,
  buildPostedGrnLabelPrintBody,
  buildPostedGrnPreviewRequest,
  formatLabelDistributionCompact,
  patchPostedGrnLabelLine,
  POSTED_GRN_PRINTER_REQUIRED,
  sumPhysicalLabelQty,
} from "../../lib/labelPrinting.js";
import {
  describePrinterDestination,
  filterPrintersForGrnLabels,
  groupPrintersByAgent,
  LABEL_PURPOSE_GRN,
} from "../../lib/labelPrinterRouting.js";
import LoadingButton from "../erp/LoadingButton.jsx";
import LabelPrintDestinationBanner from "./LabelPrintDestinationBanner.jsx";

const POSTED_STATUSES = new Set(["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"]);

/**
 * Posted GRN Print / Reprint: explicit printer, Article barcodes, no job until Print.
 */
export default function PostedGrnLabelsDialog({
  open,
  grn = null,
  printers = [],
  onClose,
  onQueued,
}) {
  const titleId = useId();
  const [printerCode, setPrinterCode] = useState("");
  const [copies, setCopies] = useState(1);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState("");
  const [previewNote, setPreviewNote] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [printing, setPrinting] = useState(false);

  const compatible = useMemo(() => filterPrintersForGrnLabels(printers), [printers]);
  const groups = useMemo(() => groupPrintersByAgent(compatible), [compatible]);
  const selectedPrinter = useMemo(
    () => compatible.find((p) => p.code === printerCode) || null,
    [compatible, printerCode]
  );
  const destination = useMemo(
    () =>
      describePrinterDestination(selectedPrinter, {
        purpose: LABEL_PURPOSE_GRN,
        fallbackSize: "100×50 mm",
      }),
    [selectedPrinter]
  );

  useEffect(() => {
    if (!open || !grn) {
      setPrinterCode("");
      setCopies(1);
      setLines([]);
      setError("");
      setPreviewNote("");
      setPreviewing(false);
      setPrinting(false);
      return undefined;
    }
    setLines(buildPostedGrnLabelLines(grn));
    setPrinterCode("");
    setCopies(1);
    setError("");
    setPreviewNote("");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape" && !printing && !previewing) {
        e.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, grn, printing, previewing, onClose]);

  const previewRows = useMemo(() => buildGrnLabelPreviewRows(lines), [lines]);
  const totalLabels = useMemo(() => sumPhysicalLabelQty(lines) * Math.max(1, copies), [lines, copies]);
  const busy = previewing || printing;
  const posted = POSTED_STATUSES.has(String(grn?.status || "").toUpperCase());

  if (!open || !grn) return null;

  const warehouseCode =
    String(grn.warehouseCode || "").trim() ||
    String(lines.find((l) => l.warehouse)?.warehouse || "").trim();

  const runPreview = async () => {
    setError("");
    setPreviewNote("");
    const built = buildPostedGrnPreviewRequest({ printerCode, warehouseCode });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setPreviewing(true);
    try {
      await apiPost("/labels/printers/resolve", built.body);
      const printBuilt = buildPostedGrnLabelPrintBody({ grn, printerCode, copies, lines });
      if (!printBuilt.ok) {
        setError(printBuilt.error);
        return;
      }
      setPreviewNote(
        `Ready: ${sumPhysicalLabelQty(lines)} physical label(s) × ${Math.max(1, copies)} copy set to ${printerCode}. No job queued until Print.`
      );
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const runPrint = async () => {
    setError("");
    const built = buildPostedGrnLabelPrintBody({ grn, printerCode, copies, lines });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setPrinting(true);
    try {
      const data = await apiPost("/labels/jobs/from-grn", built.body);
      const count = Number(data?.job?.requestedLabels) || sumPhysicalLabelQty(lines) * Math.max(1, copies);
      onQueued?.(data, built.body);
      onClose?.();
      return count;
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Cancel posted GRN labels"
        tabIndex={-1}
        disabled={busy}
        onClick={() => {
          if (!busy) onClose?.();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            Print / Reprint GRN labels
          </h2>
          <button
            type="button"
            className="rounded border px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-40"
            disabled={busy}
            onClick={() => onClose?.()}
          >
            ×
          </button>
        </div>

        <p className="mb-3 text-sm text-slate-700">
          {grn.grnNo} · Item qty is stock quantity. No. labels is how many physical stickers to queue.
        </p>
        {isAsnReceivingGrn(grn) ? (
          <p className="mb-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
            ASN-sourced posted GRN. These are Article barcodes (same as other GRN labels), not RU
            identity labels. RU labels are not reprinted here.
          </p>
        ) : null}
        {!posted ? (
          <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
            GRN must be posted before labels can be queued.
          </p>
        ) : null}

        <label className="mb-2 block text-xs font-semibold uppercase text-slate-500">
          Printer
          <select
            className="mt-1 w-full rounded border px-2 py-2 text-sm font-normal normal-case text-slate-900"
            value={printerCode}
            disabled={busy}
            onChange={(e) => {
              setPrinterCode(e.target.value);
              setError("");
              setPreviewNote("");
            }}
          >
            <option value="">Select printer</option>
            {groups.map((g) => (
              <optgroup
                key={g.agentId}
                label={`${g.computerName || g.agentName || g.agentId} (${g.agentId})`}
              >
                {g.printers.map((p) => (
                  <option key={p._id || p.code} value={p.code}>
                    {p.code} — {p.displayName || p.windowsPrinterName} ({p.language || "TSPL"}{" "}
                    {p.widthMm && p.heightMm ? `${p.widthMm}×${p.heightMm}` : "100×50"})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {!compatible.length ? (
          <p className="mb-2 text-xs text-rose-700">
            No compatible GRN printers (100×50 mm). Configure a printer in Label Settings.
          </p>
        ) : null}

        <div className="mb-3">
          <LabelPrintDestinationBanner
            printerLabel={destination.printerLabel}
            agentLabel={destination.agentLabel}
            sizeLabel={destination.sizeLabel}
            language={destination.language}
            countLabel={`${totalLabels} physical label(s)`}
            warning={!printerCode ? POSTED_GRN_PRINTER_REQUIRED : ""}
          />
        </div>

        <label className="mb-3 inline-flex items-center gap-2 text-xs text-slate-700">
          Copy sets
          <input
            type="number"
            min="1"
            className="w-16 rounded border px-1 py-1 text-right tabular-nums"
            disabled={busy}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
          />
          <span className="text-slate-500">Does not change item quantity.</span>
        </label>

        <div className="mb-3 overflow-auto rounded border">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-2 py-1 text-left">Print</th>
                <th className="px-2 py-1 text-left">Article</th>
                <th className="px-2 py-1 text-right">Item qty</th>
                <th className="px-2 py-1 text-right">No. labels</th>
                <th className="px-2 py-1 text-left">Distribution</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => (
                <tr key={ln.lineKey} className="border-t">
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      disabled={busy || !(ln.receivedQty > 0)}
                      checked={ln.print !== false}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((row) =>
                            row.lineKey === ln.lineKey
                              ? patchPostedGrnLabelLine(row, { print: e.target.checked })
                              : row
                          )
                        )
                      }
                    />
                  </td>
                  <td className="px-2 py-1 font-mono">{ln.article}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {ln.receivedQty} {ln.uom}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number"
                      min="1"
                      className="w-16 rounded border px-1 py-0.5 text-right tabular-nums"
                      disabled={busy || ln.print === false}
                      value={ln.labelCount}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((row) =>
                            row.lineKey === ln.lineKey
                              ? patchPostedGrnLabelLine(row, { labelCount: e.target.value })
                              : row
                          )
                        )
                      }
                    />
                  </td>
                  <td className="px-2 py-1 text-slate-600">
                    {formatLabelDistributionCompact(ln.labelDistribution)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mb-3 space-y-1 text-xs text-slate-700">
          {previewRows.map((row) => (
            <div key={row.poLineId || row.article}>
              {row.article}: item qty {row.grnQty} → {row.labelCount} label(s){" "}
              ({row.distributionText})
            </div>
          ))}
        </div>

        {error ? (
          <div className="mb-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error}
          </div>
        ) : null}
        {previewNote ? (
          <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            {previewNote}
          </div>
        ) : null}

        <p className="mb-3 text-[11px] text-slate-500">
          Preview checks the printer only. Print queues GRN Article labels. This does not change stock.
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50"
            disabled={busy}
            onClick={() => onClose?.()}
          >
            Cancel
          </button>
          <LoadingButton
            type="button"
            variant="secondary"
            loading={previewing}
            loadingText="Checking printer…"
            disabled={busy || !posted}
            onClick={runPreview}
          >
            Preview
          </LoadingButton>
          <LoadingButton
            type="button"
            variant="primary"
            loading={printing}
            loadingText="Queueing…"
            disabled={busy || !posted || !printerCode || totalLabels <= 0}
            onClick={async () => {
              const count = await runPrint();
              if (count != null) {
                /* dialog closes via onClose */
              }
            }}
          >
            Print {totalLabels} label{totalLabels === 1 ? "" : "s"}
          </LoadingButton>
        </div>
      </div>
    </div>
  );
}
