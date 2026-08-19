import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import LoadingButton from "../erp/LoadingButton.jsx";
import AsnRuLabelPreviewFace from "./AsnRuLabelPreviewFace.jsx";
import { apiGet, apiPost } from "../../lib/api.js";
import { confirmDialog, notify } from "../../lib/notifications.js";
import {
  defaultLinePlan,
  distributionDifference,
  formatLabelDistribution,
  parseDistributionInput,
  suggestedDistribution,
  validateAsnLabelDistribution,
} from "../../lib/receivingUnitLabels.js";
import { REPRINT_REASONS } from "../../lib/labelPrinting.js";

function qtyInputClass() {
  return "min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-lg font-semibold tabular-nums";
}

export default function AsnReceivingLabelPlanner({ asn, open, onClose, canPrint, canReprint }) {
  const queryClient = useQueryClient();
  const [plans, setPlans] = useState({});
  const [previewIndex, setPreviewIndex] = useState(0);
  const [printerCode, setPrinterCode] = useState("");
  const [reprintReason, setReprintReason] = useState(REPRINT_REASONS[0]);

  const ruQ = useQuery({
    queryKey: ["asn-receiving-units", asn?._id],
    queryFn: () => apiGet(`/asn/${asn._id}/receiving-units`),
    enabled: Boolean(open && asn?._id),
  });

  const printersQ = useQuery({
    queryKey: ["label-printers"],
    queryFn: () => apiGet("/labels/printers"),
    enabled: Boolean(open && canPrint),
  });

  const data = ruQ.data;
  const lines = data?.lines || [];

  useEffect(() => {
    if (!open || !lines.length) return;
    setPlans((prev) => {
      const next = { ...prev };
      for (const line of lines) {
        const key = String(line.asnLineId);
        if (!next[key]) next[key] = defaultLinePlan(line);
      }
      return next;
    });
    setPreviewIndex(0);
  }, [open, lines]);

  const planMutation = useMutation({
    mutationFn: (body) => apiPost(`/asn/${asn._id}/receiving-units/plan`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asn-receiving-units", asn._id] });
      notify.success("Receiving Units saved");
    },
  });

  const printMutation = useMutation({
    mutationFn: (body) => apiPost(`/asn/${asn._id}/receiving-units/print`, body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["asn-receiving-units", asn._id] });
      notify.success(`Queued ${res.count || res.jobs?.length || 0} label job(s)`);
    },
    onError: (err) => notify.fromError(err, { fallback: "Could not queue labels" }),
  });

  const reprintMutation = useMutation({
    mutationFn: ({ ruId, reason }) =>
      apiPost(`/asn/${asn._id}/receiving-units/${ruId}/reprint`, { reason, printerCode: printerCode || undefined }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["asn-receiving-units", asn._id] });
      notify.success(`Reprint queued for ${res.receivingUnit?.ruNo || "RU"}`);
    },
    onError: (err) => notify.fromError(err, { fallback: "Could not reprint" }),
  });

  const previewFaces = useMemo(
    () => (lines || []).flatMap((line) => line.receivingUnits || []),
    [lines]
  );

  const canSave = useMemo(() => {
    if (!data?.eligible || !canPrint) return false;
    return lines.every((line) => {
      const plan = plans[String(line.asnLineId)] || defaultLinePlan(line);
      const diff = distributionDifference(line.asnQty, plan.labelDistribution || []);
      return Math.abs(diff.difference) < 1e-6 && (plan.labelDistribution || []).length > 0;
    });
  }, [data?.eligible, canPrint, lines, plans]);

  const currentFace = previewFaces[previewIndex] || null;

  if (!open) return null;

  const updatePlan = (line, patch) => {
    const key = String(line.asnLineId);
    setPlans((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const setLabelCount = (line, raw) => {
    const asnQty = Number(line.asnQty) || 0;
    const n = Math.max(1, Math.floor(Number(raw) || 1));
    const dist = suggestedDistribution(asnQty, n);
    updatePlan(line, {
      labelCount: String(dist.length),
      labelDistribution: dist,
      customText: formatLabelDistribution(dist),
      mode: "count",
    });
  };

  const applyCustom = (line) => {
    const plan = plans[String(line.asnLineId)] || defaultLinePlan(line);
    const parsed = parseDistributionInput(plan.customText);
    const validated = validateAsnLabelDistribution(line.asnQty, {
      article: line.article,
      labelCount: parsed.length,
      labelDistribution: parsed,
    });
    if (!validated.ok) {
      notify.error(validated.message || "Invalid quantities");
      return;
    }
    updatePlan(line, {
      labelCount: String(validated.distribution.length),
      labelDistribution: validated.distribution,
      customText: formatLabelDistribution(validated.distribution),
      mode: "custom",
    });
  };

  const buildPlanPayload = async () => {
    const payloadLines = [];
    for (const line of lines) {
      const plan = plans[String(line.asnLineId)] || defaultLinePlan(line);
      const validated = validateAsnLabelDistribution(line.asnQty, {
        article: line.article,
        labelCount: Number(plan.labelCount),
        labelDistribution: plan.labelDistribution,
      });
      if (!validated.ok) {
        notify.error(validated.message || `Invalid plan for ${line.article}`);
        return null;
      }
      const diff = distributionDifference(line.asnQty, validated.distribution);
      if (Math.abs(diff.difference) > 1e-6) {
        notify.error(`${line.article}: planned qty must equal ASN qty`);
        return null;
      }
      payloadLines.push({
        asnLineId: line.asnLineId,
        labelCount: validated.distribution.length,
        labelDistribution: validated.distribution,
      });
    }
    return { lines: payloadLines };
  };

  const savePlan = async ({ replacePrinted = false } = {}) => {
    const payload = await buildPlanPayload();
    if (!payload) return;
    try {
      await planMutation.mutateAsync({ ...payload, replacePrinted });
    } catch (err) {
      if (err?.code === "RU_PLAN_CONFLICT") {
        notify.fromError(err, { fallback: "Another user updated this label plan. Refresh and try again." });
        return;
      }
      if (err?.code === "RU_PRINT_IN_PROGRESS" || err?.code === "RU_PRINT_UNCERTAIN") {
        notify.fromError(err, { fallback: "Finish or resolve the current print job before replacing this plan." });
        return;
      }
      if (err?.code === "RU_PRINTED_PLAN_LOCKED") {
        const ok = await confirmDialog({
          title: "Replace printed labels?",
          message:
            "Some Receiving Units were already printed. Replacing will supersede those barcodes and create new RU numbers. Continue?",
        });
        if (ok) {
          try {
            await planMutation.mutateAsync({ ...payload, replacePrinted: true });
          } catch (err2) {
            notify.fromError(err2, { fallback: "Could not replace printed plan" });
          }
        }
        return;
      }
      notify.fromError(err, { fallback: "Could not save label plan" });
    }
  };

  const printers = printersQ.data?.items || [];

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-slate-100">
      <header className="flex items-center justify-between gap-3 border-b bg-white px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900">Prepare Receiving Units</h2>
          <p className="truncate font-mono text-sm text-slate-600">{asn?.asnNo}</p>
        </div>
        <button type="button" className="min-h-12 min-w-12 rounded-xl border px-4 text-base" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {!data?.eligible ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            Labels can be prepared only when the ASN is Shipped or Arrived.
          </p>
        ) : null}

        <div className="space-y-4">
          {lines.map((line) => {
            const plan = plans[String(line.asnLineId)] || defaultLinePlan(line);
            const diff = distributionDifference(line.asnQty, plan.labelDistribution || []);
            const invalid = Math.abs(diff.difference) > 1e-6;
            return (
              <section key={String(line.asnLineId)} className="rounded-2xl border bg-white p-4 shadow-sm">
                <div className="text-2xl font-black tracking-tight">{line.article}</div>
                <div className="mt-1 text-lg font-semibold text-slate-800">{line.partNo || "—"}</div>
                <p className="mt-1 text-sm text-slate-600">{line.description || "—"}</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <div className="text-xs uppercase text-slate-500">ASN qty</div>
                    <div className="text-xl font-bold">
                      {line.asnQty} {line.uom}
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <div className="text-xs uppercase text-slate-500">Active labels</div>
                    <div className="text-xl font-bold">
                      {line.activeRuCount} · {line.activePlannedQty} {line.uom}
                    </div>
                  </div>
                </div>

                <label className="mt-4 block text-sm font-semibold text-slate-700">No. of labels</label>
                <input
                  className={qtyInputClass()}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={plan.labelCount}
                  onChange={(e) => setLabelCount(line, e.target.value)}
                />
                <div className="mt-3 text-sm">
                  <div className="font-semibold text-slate-700">Suggested</div>
                  <div className="mt-1 font-mono text-base">{formatLabelDistribution(plan.labelDistribution)}</div>
                </div>
                <label className="mt-3 block text-sm font-semibold text-slate-700">Custom quantities</label>
                <input
                  className={qtyInputClass()}
                  inputMode="decimal"
                  placeholder="20 + 20 + 10"
                  value={plan.customText}
                  onChange={(e) => updatePlan(line, { customText: e.target.value, mode: "custom" })}
                  onBlur={() => applyCustom(line)}
                />
                <div className={`mt-3 rounded-xl p-3 text-sm ${invalid ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-800"}`}>
                  <div>Total planned: {diff.plannedQty}</div>
                  <div>ASN qty: {diff.asnQty}</div>
                  <div>Difference: {diff.difference}</div>
                </div>
                {(line.receivingUnits || []).length ? (
                  <ul className="mt-3 space-y-2">
                    {line.receivingUnits.map((ru) => (
                      <li key={String(ru._id)} className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2">
                        <div>
                          <div className="font-mono font-semibold">{ru.ruNo}</div>
                          <div className="text-sm text-slate-600">
                            Qty {ru.plannedQty} · {ru.status}
                          </div>
                        </div>
                        {canReprint && ru.status !== "CANCELLED" ? (
                          <LoadingButton
                            variant="secondary"
                            className="min-h-12"
                            loading={reprintMutation.isPending}
                            onClick={() =>
                              reprintMutation.mutate({ ruId: ru._id, reason: reprintReason || "Replacement" })
                            }
                          >
                            Reprint RU Label
                          </LoadingButton>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>

        {previewFaces.length ? (
          <section className="mt-6 rounded-2xl border bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Label preview</h3>
              <div className="text-sm font-semibold text-slate-600">
                {previewIndex + 1} / {previewFaces.length}
              </div>
            </div>
            {currentFace ? (
              <AsnRuLabelPreviewFace
                article={currentFace.article}
                partNo={currentFace.partNo}
                description={currentFace.description}
                plannedQty={currentFace.plannedQty}
                uom={currentFace.uom}
                asnNo={currentFace.asnNo || asn?.asnNo}
                ruNo={currentFace.ruNo}
                barcodeValue={currentFace.barcodeValue}
              />
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="min-h-12 rounded-xl border text-base font-semibold"
                disabled={previewIndex <= 0}
                onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="min-h-12 rounded-xl border text-base font-semibold"
                disabled={previewIndex >= previewFaces.length - 1}
                onClick={() => setPreviewIndex((i) => Math.min(previewFaces.length - 1, i + 1))}
              >
                Next
              </button>
            </div>
          </section>
        ) : (
          <p className="mt-6 text-sm text-slate-500">Save the plan to assign RU numbers, then preview and print.</p>
        )}
      </div>

      <footer className="space-y-3 border-t bg-white p-4">
        {canPrint ? (
          <select
            className="min-h-12 w-full rounded-xl border px-3 text-base"
            value={printerCode}
            onChange={(e) => setPrinterCode(e.target.value)}
          >
            <option value="">Default warehouse printer</option>
            {printers.map((p) => (
              <option key={p.code || p._id} value={p.code}>
                {p.displayName || p.name || p.code} {p.windowsPrinterName ? `· ${p.windowsPrinterName}` : ""}
              </option>
            ))}
          </select>
        ) : null}
        {canReprint ? (
          <select
            className="min-h-12 w-full rounded-xl border px-3 text-base"
            value={reprintReason}
            onChange={(e) => setReprintReason(e.target.value)}
          >
            {REPRINT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LoadingButton
            className="min-h-14 text-base"
            loading={planMutation.isPending}
            disabled={!canSave}
            onClick={() => savePlan()}
          >
            Save Receiving Units
          </LoadingButton>
          <LoadingButton
            variant="success"
            className="min-h-14 text-base"
            loading={printMutation.isPending}
            disabled={!canPrint || !previewFaces.some((ru) => ru.status === "PLANNED")}
            onClick={() => printMutation.mutate({ printerCode: printerCode || undefined })}
          >
            Print RU Labels
          </LoadingButton>
        </div>
      </footer>
    </div>
  );
}
