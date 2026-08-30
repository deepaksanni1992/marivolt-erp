import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import LoadingButton from "../erp/LoadingButton.jsx";
import { apiGet, apiPost } from "../../lib/api.js";
import {
  PACKING_REPRINT_REASONS,
  formatPackingReprintReason,
  newPackingReprintClientRequestId,
} from "../../lib/labelPrinting.js";

function formatWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function PackingLabelReprintForm({ job, onClose, onQueued, onError }) {
  const [reason, setReason] = useState(PACKING_REPRINT_REASONS[0]);
  const [remarks, setRemarks] = useState("");
  const clientRequestIdRef = useRef("");

  const labelCount = Math.max(0, Math.floor(Number(job?.requestedLabels) || 0));

  const targetQ = useQuery({
    queryKey: ["packing-reprint-target", job._id],
    queryFn: () => apiGet(`/labels/jobs/${job._id}/reprint-target`),
    enabled: Boolean(job?._id),
  });

  const target = targetQ.data;
  const reprintMut = useMutation({
    mutationFn: async () => {
      if (!job?._id) throw new Error("Missing original print job");
      if (reason === "Other" && !String(remarks || "").trim()) {
        throw new Error("Enter remarks for Other");
      }
      if (!target?.printerConfigId) {
        throw new Error("Reprint printer is not available. Close and try again.");
      }
      if (!clientRequestIdRef.current) {
        clientRequestIdRef.current = newPackingReprintClientRequestId();
      }
      return apiPost(`/labels/jobs/${job._id}/reprint`, {
        reason: formatPackingReprintReason(reason, remarks),
        clientRequestId: clientRequestIdRef.current,
        expectedPrinterConfigId: target.printerConfigId,
      });
    },
    onSuccess: (data) => {
      onQueued?.(data?.job || data);
      onClose?.();
    },
    onError: (e) => {
      if (e?.code === "LABEL_REPRINT_PRINTER_CHANGED") {
        targetQ.refetch();
      }
      onError?.(e.message || "Reprint failed");
    },
  });

  const printerReady = Boolean(target?.printerConfigId) && !targetQ.isFetching;
  const submitDisabled = reprintMut.isPending || !printerReady || targetQ.isError;

  return (
    <>
      <div className="space-y-2 text-sm text-slate-700">
        <p>
          <span className="font-semibold text-slate-500">Original job</span>
          <br />
          <span className="font-mono">{job.jobNo || "—"}</span>
        </p>
        <p>
          <span className="font-semibold text-slate-500">Physical labels</span>
          <br />
          {labelCount}
        </p>
        <p>
          <span className="font-semibold text-slate-500">Original print</span>
          <br />
          {formatWhen(job.updatedAt || job.createdAt)}
        </p>
        <p>
          <span className="font-semibold text-slate-500">Original user</span>
          <br />
          {job.createdByName || "—"}
        </p>
        <p>
          <span className="font-semibold text-slate-500">Printer</span>
          <br />
          {targetQ.isPending || (targetQ.isFetching && !target)
            ? "Resolving printer…"
            : targetQ.isError
              ? "—"
              : target?.windowsPrinterName || target?.printerCode || "—"}
        </p>
        {target?.warning ? (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
            {target.warning}
          </p>
        ) : null}
        {targetQ.isError ? (
          <p className="text-xs font-medium text-rose-700">
            {targetQ.error?.message || "Could not resolve the reprint printer."}
          </p>
        ) : null}
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
          This will print another complete set of {labelCount} labels.
        </p>
      </div>

      <label className="mt-4 block text-xs text-slate-600">
        Reason
        <select
          className="mt-1 block w-full rounded border px-2 py-1.5 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {PACKING_REPRINT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {reason === "Other" ? (
        <label className="mt-2 block text-xs text-slate-600">
          Remarks
          <textarea
            className="mt-1 block w-full rounded border px-2 py-1.5 text-sm"
            rows={2}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="Required for Other"
          />
        </label>
      ) : null}

      {reprintMut.error ? (
        <p className="mt-3 text-xs font-medium text-rose-700">
          {reprintMut.error.message || "Reprint failed"}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-sm"
          disabled={reprintMut.isPending}
          onClick={onClose}
        >
          Cancel
        </button>
        <LoadingButton
          type="button"
          variant="primary"
          loading={reprintMut.isPending}
          loadingText="Queueing…"
          disabled={submitDisabled}
          onClick={() => reprintMut.mutate()}
        >
          Reprint {labelCount} Labels
        </LoadingButton>
      </div>
    </>
  );
}

/**
 * Confirm reprint of a completed packing label job (frozen parent snapshot).
 * Form state is reset by unmounting on close (no set-state-in-effect).
 */
export default function PackingLabelReprintModal({
  open,
  job = null,
  onClose,
  onQueued,
  onError,
}) {
  if (!open || !job) return null;

  return (
    <Modal open={open} onClose={onClose} title="Reprint Packing Labels">
      <PackingLabelReprintForm
        key={String(job._id)}
        job={job}
        onClose={onClose}
        onQueued={onQueued}
        onError={onError}
      />
    </Modal>
  );
}

export function PackingLabelsToolbarButton({
  ui,
  canPrint = false,
  canReprint = false,
  disabledExtra = false,
  className = "rounded border border-sky-700 px-2 py-1.5 text-xs font-medium text-sky-900 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50",
  onPrint,
  onReprint,
  onResolve,
}) {
  const action = ui?.action || "print";
  const enabled =
    !disabledExtra &&
    !ui?.disabled &&
    (action === "print"
      ? canPrint
      : action === "reprint"
        ? canReprint
        : action === "resolve");
  const click =
    action === "reprint" ? onReprint : action === "resolve" ? onResolve : onPrint;
  return (
    <button type="button" className={className} disabled={!enabled} onClick={click}>
      {ui?.label || "Print Packing Labels"}
    </button>
  );
}
