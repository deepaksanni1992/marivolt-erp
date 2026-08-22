import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "../../lib/api.js";
import { notify } from "../../lib/notifications.js";
import { useAuth } from "../../context/AuthContext.jsx";
import Modal from "../erp/Modal.jsx";
import GrnCustomsSection from "./GrnCustomsSection.jsx";
import { emptyGrnCustomsState } from "../../lib/grnCustomsPayload.js";

function captureFromGrn(grn) {
  const first = (grn?.items || []).find((ln) => ln.customsCapture)?.customsCapture || {};
  return {
    ...emptyGrnCustomsState(),
    boeMode: first.boeMode || (first.customsBoeId || first.customsBoeRef ? "SELECT" : "CREATE"),
    customsBoeId: first.customsBoeId || "",
    customsBoeRef: first.customsBoeRef || "",
    receivedDate: first.receivedDate
      ? String(first.receivedDate).slice(0, 10)
      : grn?.grnDate
        ? String(grn.grnDate).slice(0, 10)
        : new Date().toISOString().slice(0, 10),
    boeNumber: first.boeNumber || grn?.customsDocRef || "",
    boeDate: first.boeDate ? String(first.boeDate).slice(0, 10) : "",
    blNumber: first.blNumber || grn?.blAwbNo || "",
    awbNumber: first.awbNumber || "",
    customsCurrency: first.customsCurrency || grn?.currency || "",
    exchangeRateToAED: first.exchangeRateToAED || "",
    boeDeclaredQty: first.boeDeclaredQty || "",
    boeDeclaredValue: first.boeDeclaredValue || "",
    customsUom: first.customsUom || "PCS",
    customsRemarks: first.customsRemarks || "",
    grossWeightKg: first.grossWeightKg || "",
    netWeightKg: first.netWeightKg || "",
    linkedCustomsQty: "",
  };
}

function hydrateInvoices(asn = {}) {
  const rows = Array.isArray(asn.supplierInvoices) ? asn.supplierInvoices : [];
  if (rows.length) {
    return rows.map((r) => ({
      invoiceNumber: r.invoiceNumber || "",
      invoiceDate: r.invoiceDate || null,
    }));
  }
  if (asn.supplierInvoiceNumber || asn.supplierInvoiceDate) {
    return [
      {
        invoiceNumber: asn.supplierInvoiceNumber || "",
        invoiceDate: asn.supplierInvoiceDate || null,
      },
    ];
  }
  return [];
}

function isPhysicalPutaway(loc, warehouse = "MAIN") {
  if (!loc || String(loc.status || "Active") === "Inactive") return false;
  const code = String(loc.locationCode || "").trim().toUpperCase();
  if (!code) return false;
  const wh = String(warehouse || "MAIN").trim().toUpperCase();
  const locWh = String(loc.warehouse || "").trim().toUpperCase();
  if (locWh && locWh !== wh) return false;
  const rack = String(loc.rack || "").trim();
  const bin = String(loc.bin || "").trim();
  return Boolean(rack && bin);
}

function formatLocOption(loc) {
  const code = String(loc.locationCode || "").toUpperCase();
  const rack = String(loc.rack || "").trim();
  const bin = String(loc.bin || "").trim();
  if (rack && bin) return `${code} — Rack ${rack} · Bin ${bin}`;
  return code;
}

function buildPutawayLocationCode(warehouse, rack, bin) {
  const wh = String(warehouse || "MAIN").trim().toUpperCase();
  const r = String(rack || "").trim().toUpperCase();
  const b = String(bin || "").trim().toUpperCase();
  if (!r || !b) return "";
  return `${wh}-${r}-${b}`;
}

function lineKey(ln) {
  return String(ln.poLineId || ln.asnLineId || ln.article);
}

/**
 * ASN_RECEIVING Draft GRN customs review: BOE header + read-only unit weight + putaway.
 * HS / COO / SI are ASN-owned (display only). Actual Unit Weight is receiving-owned.
 */
export default function AsnReceivingDraftCustomsReview({ grn, disabled = false, onSaved }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canQuickCreatePutaway =
    can("ASN", "view") &&
    can("STORE", "create") &&
    String(grn?.status || "").toUpperCase() === "DRAFT" &&
    String(grn?.sourceType || "").toUpperCase() === "ASN_RECEIVING" &&
    Boolean(grn?.receivingSessionId);
  const [customs, setCustoms] = useState(() => captureFromGrn(grn));
  const [lineEdits, setLineEdits] = useState({});
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickCreateLineKey, setQuickCreateLineKey] = useState("");
  const [quickRack, setQuickRack] = useState("");
  const [quickBin, setQuickBin] = useState("");
  const [quickApplyAll, setQuickApplyAll] = useState(false);

  const asnQ = useQuery({
    queryKey: ["asn", grn?.asnId],
    queryFn: () => apiGet(`/asn/${grn.asnId}`),
    enabled: Boolean(grn?.asnId),
  });

  const locationsQ = useQuery({
    queryKey: ["stock-locations"],
    queryFn: () => apiGet("/stock/locations"),
  });

  const putawayOptions = useMemo(() => {
    const rows = Array.isArray(locationsQ.data) ? locationsQ.data : locationsQ.data?.items || [];
    return rows.filter((l) => isPhysicalPutaway(l, "MAIN"));
  }, [locationsQ.data]);

  useEffect(() => {
    setCustoms(captureFromGrn(grn));
    const next = {};
    for (const ln of grn?.items || []) {
      const key = lineKey(ln);
      next[key] = {
        location: ln.location || "",
        warehouse: ln.warehouse || "MAIN",
        unitWeightKg: ln.customsCapture?.unitWeightKg || "",
        remarks: ln.remarks || "",
      };
    }
    setLineEdits(next);
  }, [grn]);

  const asnLinesByKey = useMemo(() => {
    const map = new Map();
    for (const line of asnQ.data?.lines || []) {
      map.set(String(line._id || ""), line);
      map.set(String(line.poLineId || ""), line);
      map.set(String(line.article || "").toUpperCase(), line);
    }
    return map;
  }, [asnQ.data]);

  function resolveAsnLine(ln) {
    return (
      asnLinesByKey.get(String(ln.asnLineId || "")) ||
      asnLinesByKey.get(String(ln.poLineId || "")) ||
      asnLinesByKey.get(String(ln.article || "").toUpperCase()) ||
      null
    );
  }

  function applyLocationToLines(locationCode, { allLines = false, targetKey = "" } = {}) {
    const code = String(locationCode || "").trim().toUpperCase();
    if (!code) return;
    setLineEdits((prev) => {
      const next = { ...prev };
      const keys = allLines
        ? (grn.items || []).map(lineKey)
        : [targetKey].filter(Boolean);
      for (const key of keys) {
        next[key] = { ...(next[key] || {}), location: code, warehouse: "MAIN" };
      }
      return next;
    });
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const items = (grn.items || []).map((ln) => {
        const key = lineKey(ln);
        const ed = lineEdits[key] || {};
        const qty = Number(ln.acceptedQty ?? ln.receivedQty) || 0;
        const unitWeightKg = Number(ln.customsCapture?.unitWeightKg) || 0;
        return {
          ...ln,
          warehouse: ed.warehouse || ln.warehouse || "MAIN",
          location: String(ed.location || ln.location || "").trim().toUpperCase(),
          remarks: ed.remarks != null ? ed.remarks : ln.remarks,
          customsCapture: {
            ...customs,
            unitWeightKg,
            totalWeightKg: qty > 0 && unitWeightKg > 0 ? qty * unitWeightKg : Number(ln.customsCapture?.totalWeightKg) || 0,
            grossWeightKg: Number(customs.grossWeightKg) || 0,
            netWeightKg: Number(customs.netWeightKg) || 0,
            supplierInvoiceNumber: "",
            supplierInvoiceDate: null,
            hsCode: "",
            countryOfOrigin: "",
            customsQty: 0,
          },
        };
      });
      return apiPut(`/grn/${encodeURIComponent(grn.grnNo)}`, {
        items,
        customsDocRef: customs.boeNumber || "",
        blAwbNo: customs.blNumber || customs.awbNumber || grn.blAwbNo || "",
        remarks: grn.remarks || "",
      });
    },
    onSuccess: (row) => {
      notify.success("Draft GRN customs saved");
      qc.invalidateQueries({ queryKey: ["grns"] });
      qc.invalidateQueries({ queryKey: ["receiving-progress"] });
      onSaved?.(row);
    },
    onError: (e) => notify.fromError(e),
  });

  const createLocMut = useMutation({
    mutationFn: async ({ rack, bin }) => {
      const sessionId = String(grn?.receivingSessionId || "").trim();
      if (!sessionId) {
        throw new Error("Receiving session is required for putaway quick-create");
      }
      const data = await apiPost(`/receiving/sessions/${sessionId}/putaway-locations`, {
        rack: String(rack || "").trim(),
        bin: String(bin || "").trim(),
      });
      return data?.location || data;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["stock-locations"] });
      const code = String(row.locationCode || "").toUpperCase();
      applyLocationToLines(code, {
        allLines: quickApplyAll,
        targetKey: quickCreateLineKey,
      });
      setQuickCreateOpen(false);
      setQuickRack("");
      setQuickBin("");
      setQuickApplyAll(false);
      notify.success(`Putaway location ${code} ready — save Draft GRN to update readiness`);
    },
    onError: (e) => notify.fromError(e),
  });

  const invoices = hydrateInvoices(asnQ.data || {});
  const thisQty = (grn.items || []).reduce(
    (s, ln) => s + (Number(ln.acceptedQty ?? ln.receivedQty) || 0),
    0,
  );
  const previewLocationCode = buildPutawayLocationCode("MAIN", quickRack, quickBin);
  const postReady = grn.postReadiness?.postReady === true;
  const postBlockers = grn.postReadiness?.blockers || [];
  const readinessKnown = grn.postReadiness != null;

  function openQuickCreate(lineKeyValue) {
    setQuickCreateLineKey(lineKeyValue);
    setQuickRack("");
    setQuickBin("");
    setQuickApplyAll((grn.items || []).length > 1);
    setQuickCreateOpen(true);
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
      {!readinessKnown ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Evaluating posting readiness…
        </div>
      ) : postBlockers.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <div className="font-semibold">GRN NOT READY TO POST</div>
          <div className="mt-1 text-xs font-medium uppercase tracking-wide text-amber-800">Outstanding</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {postBlockers.map((b) => (
              <li key={`${b.code}-${b.article || ""}-${b.message}`}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : postReady ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">
          ✓ READY TO POST
        </div>
      ) : null}

      <GrnCustomsSection
        value={customs}
        onChange={setCustoms}
        poId={grn.poId}
        poNo={grn.poNo}
        supplierName={grn.supplierName}
        defaultCurrency={grn.currency || "USD"}
        suggestedBoeQty={thisQty || null}
        thisGrnCustomsQty={thisQty || null}
        variant="ASN_RECEIVING"
        asnSupplierInvoices={invoices}
        disabled={disabled || saveMut.isPending}
      />

      {putawayOptions.length === 0 ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950">
          No physical putaway StockLocations found yet.
          {canQuickCreatePutaway
            ? " Use + Create Putaway Location below, or create Active Rack/Bin locations under Store → Locations."
            : " Ask a Store user with location-master access to create Active Rack/Bin locations."}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full text-xs">
          <thead className="bg-slate-50 text-left uppercase text-slate-500">
            <tr>
              <th className="px-2 py-1.5">Article</th>
              <th className="px-2 py-1.5 text-right">Accepted Qty</th>
              <th className="px-2 py-1.5">HS Code</th>
              <th className="px-2 py-1.5">COO</th>
              <th className="px-2 py-1.5">Actual Unit Weight (kg)</th>
              <th className="px-2 py-1.5">Line kg</th>
              <th className="px-2 py-1.5">Warehouse</th>
              <th className="px-2 py-1.5">Putaway Location *</th>
            </tr>
          </thead>
          <tbody>
            {(grn.items || []).map((ln) => {
              const key = lineKey(ln);
              const ed = lineEdits[key] || {};
              const asnLine = resolveAsnLine(ln);
              const qty = Number(ln.acceptedQty ?? ln.receivedQty) || 0;
              const uw = Number(ln.customsCapture?.unitWeightKg) || 0;
              const lineKg = qty > 0 && uw > 0 ? Math.round(qty * uw * 1000) / 1000 : null;
              const hs = asnLine?.hsCode || "—";
              const coo = asnLine?.countryOfOrigin || asnQ.data?.countryOfOrigin || "—";
              const warehouse = ed.warehouse || ln.warehouse || "MAIN";
              return (
                <tr key={key} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-mono font-semibold">{ln.article}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{qty}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-600">
                    {hs} <span className="text-slate-400">🔒</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-600">
                    {coo} <span className="text-slate-400">🔒</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1 tabular-nums text-slate-800">
                      {uw > 0 ? uw : "—"}
                      <span className="text-slate-400">🔒</span>
                    </div>
                    <div className="text-[10px] text-slate-400">Source: Receiving</div>
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-500">{lineKg ?? "—"}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-600">
                    {warehouse} <span className="text-slate-400">🔒</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-col gap-1">
                      <select
                        className="min-w-[180px] rounded border px-1 py-0.5"
                        disabled={disabled || saveMut.isPending}
                        value={ed.location || ""}
                        onChange={(e) =>
                          setLineEdits((prev) => ({
                            ...prev,
                            [key]: { ...ed, location: e.target.value },
                          }))
                        }
                      >
                        <option value="">Select putaway…</option>
                        {putawayOptions.map((loc) => (
                          <option key={loc.locationCode} value={String(loc.locationCode).toUpperCase()}>
                            {formatLocOption(loc)}
                          </option>
                        ))}
                      </select>
                      {canQuickCreatePutaway ? (
                        <button
                          type="button"
                          className="text-left text-[11px] font-semibold text-sky-800 hover:underline"
                          disabled={disabled || saveMut.isPending || createLocMut.isPending}
                          onClick={() => openQuickCreate(key)}
                        >
                          + Create Putaway Location
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="min-h-11 w-full rounded-lg border border-slate-300 bg-white font-semibold text-slate-800 disabled:opacity-40"
        disabled={disabled || saveMut.isPending}
        onClick={() => saveMut.mutate()}
      >
        {saveMut.isPending ? "Saving…" : "Save Customs / Putaway"}
      </button>

      <Modal open={quickCreateOpen} onClose={() => !createLocMut.isPending && setQuickCreateOpen(false)} title="Create Putaway Location">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Creates an Active StockLocation master record. Warehouse stock accounting remains at MAIN; this selects
            physical Rack/Bin provenance for the GRN line.
          </p>
          <label className="block text-sm font-semibold text-slate-700">
            Warehouse
            <input className="mt-1 w-full rounded-lg border bg-slate-50 px-3 py-2 font-mono" value="MAIN" readOnly disabled />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Rack *
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono uppercase"
              value={quickRack}
              disabled={createLocMut.isPending}
              onChange={(e) => setQuickRack(e.target.value)}
              placeholder="R01"
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Bin *
            <input
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono uppercase"
              value={quickBin}
              disabled={createLocMut.isPending}
              onChange={(e) => setQuickBin(e.target.value)}
              placeholder="B03"
            />
          </label>
          <label className="block text-sm font-semibold text-slate-700">
            Location Code
            <input
              className="mt-1 w-full rounded-lg border bg-slate-50 px-3 py-2 font-mono"
              value={previewLocationCode || "—"}
              readOnly
              disabled
            />
          </label>
          {(grn.items || []).length > 1 ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={quickApplyAll}
                disabled={createLocMut.isPending}
                onChange={(e) => setQuickApplyAll(e.target.checked)}
              />
              Apply to all lines
            </label>
          ) : null}
          <button
            type="button"
            className="min-h-11 w-full rounded-lg bg-sky-700 font-semibold text-white disabled:opacity-40"
            disabled={
              createLocMut.isPending ||
              !String(quickRack || "").trim() ||
              !String(quickBin || "").trim()
            }
            onClick={() =>
              createLocMut.mutate({
                rack: quickRack,
                bin: quickBin,
              })
            }
          >
            {createLocMut.isPending ? "Creating…" : "Create Putaway Location"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
