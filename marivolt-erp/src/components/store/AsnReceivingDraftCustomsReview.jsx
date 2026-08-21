import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "../../lib/api.js";
import { notify } from "../../lib/notifications.js";
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

/**
 * ASN_RECEIVING Draft GRN customs review: BOE header + line unit weight / location.
 * HS / COO / SI are ASN-owned (display only).
 */
export default function AsnReceivingDraftCustomsReview({ grn, disabled = false, onSaved }) {
  const qc = useQueryClient();
  const [customs, setCustoms] = useState(() => captureFromGrn(grn));
  const [lineEdits, setLineEdits] = useState({});

  const asnQ = useQuery({
    queryKey: ["asn", grn?.asnId],
    queryFn: () => apiGet(`/asn/${grn.asnId}`),
    enabled: Boolean(grn?.asnId),
  });

  useEffect(() => {
    setCustoms(captureFromGrn(grn));
    const next = {};
    for (const ln of grn?.items || []) {
      const key = String(ln.poLineId || ln.asnLineId || ln.article);
      next[key] = {
        location: ln.location || ln.warehouse || "",
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

  const saveMut = useMutation({
    mutationFn: async () => {
      const items = (grn.items || []).map((ln) => {
        const key = String(ln.poLineId || ln.asnLineId || ln.article);
        const ed = lineEdits[key] || {};
        const qty = Number(ln.acceptedQty ?? ln.receivedQty) || 0;
        const unitWeightKg = Number(ed.unitWeightKg) || 0;
        return {
          ...ln,
          warehouse: ed.warehouse || ln.warehouse || "MAIN",
          location: ed.location || ln.location || "",
          remarks: ed.remarks != null ? ed.remarks : ln.remarks,
          customsCapture: {
            ...customs,
            unitWeightKg,
            totalWeightKg: qty > 0 && unitWeightKg > 0 ? qty * unitWeightKg : 0,
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
      onSaved?.(row);
    },
    onError: (e) => notify.fromError(e),
  });

  const invoices = hydrateInvoices(asnQ.data || {});
  const thisQty = (grn.items || []).reduce(
    (s, ln) => s + (Number(ln.acceptedQty ?? ln.receivedQty) || 0),
    0,
  );

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
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

      <div className="overflow-x-auto">
        <table className="min-w-[900px] w-full text-xs">
          <thead className="bg-slate-50 text-left uppercase text-slate-500">
            <tr>
              <th className="px-2 py-1.5">Article</th>
              <th className="px-2 py-1.5 text-right">Accepted Qty</th>
              <th className="px-2 py-1.5">HS Code</th>
              <th className="px-2 py-1.5">COO</th>
              <th className="px-2 py-1.5">Unit Weight (kg)</th>
              <th className="px-2 py-1.5">Line kg</th>
              <th className="px-2 py-1.5">Location</th>
            </tr>
          </thead>
          <tbody>
            {(grn.items || []).map((ln) => {
              const key = String(ln.poLineId || ln.asnLineId || ln.article);
              const ed = lineEdits[key] || {};
              const asnLine = resolveAsnLine(ln);
              const qty = Number(ln.acceptedQty ?? ln.receivedQty) || 0;
              const uw = Number(ed.unitWeightKg) || 0;
              const lineKg = qty > 0 && uw > 0 ? Math.round(qty * uw * 1000) / 1000 : null;
              const hs = asnLine?.hsCode || "—";
              const coo = asnLine?.countryOfOrigin || asnQ.data?.countryOfOrigin || "—";
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
                    <input
                      type="number"
                      min="0"
                      step="any"
                      className="w-24 rounded border px-1 py-0.5 text-right"
                      disabled={disabled || saveMut.isPending}
                      value={ed.unitWeightKg ?? ""}
                      onChange={(e) =>
                        setLineEdits((prev) => ({
                          ...prev,
                          [key]: { ...ed, unitWeightKg: e.target.value },
                        }))
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-500">{lineKg ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    <input
                      className="min-w-[120px] rounded border px-1 py-0.5"
                      disabled={disabled || saveMut.isPending}
                      value={ed.location ?? ""}
                      onChange={(e) =>
                        setLineEdits((prev) => ({
                          ...prev,
                          [key]: { ...ed, location: e.target.value },
                        }))
                      }
                    />
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
        {saveMut.isPending ? "Saving…" : "Save Customs / Locations"}
      </button>
    </div>
  );
}
