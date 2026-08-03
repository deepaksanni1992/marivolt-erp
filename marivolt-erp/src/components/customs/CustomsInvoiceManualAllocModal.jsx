import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGetWithQuery } from "../../lib/api.js";
import { notify } from "../../lib/notifications.js";

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const EMPTY_OVERRIDE = {
  boeNumber: "",
  blNumber: "",
  awbNumber: "",
  supplierInvoiceNumber: "",
  overrideReason: "",
};

export default function CustomsInvoiceManualAllocModal({
  open,
  onClose,
  line,
  initialAllocations = [],
  allowOverride = false,
  onSave,
}) {
  const [selected, setSelected] = useState([]);
  const [overrideMode, setOverrideMode] = useState(false);
  const [overrideFields, setOverrideFields] = useState(EMPTY_OVERRIDE);

  const articleNumber = line?.articleNumber || line?.article || "";
  const partNumber = line?.partNumber || "";
  const qtyRequired = Number(line?.qtyExported ?? line?.qty) || 0;

  const lotsQ = useQuery({
    queryKey: ["customs-available-lots", articleNumber, partNumber],
    queryFn: async () => {
      const withPart = await apiGetWithQuery("/customs/available-lots", {
        articleNumber,
        partNumber: partNumber || undefined,
      });
      const items = withPart?.items || [];
      if (items.length || !partNumber) return items;
      const fallback = await apiGetWithQuery("/customs/available-lots", { articleNumber });
      return fallback?.items || [];
    },
    enabled: open && !!articleNumber,
  });

  useEffect(() => {
    if (!open) return;
    const manual = (initialAllocations || []).filter(
      (a) => a.allocationMode !== "OVERRIDE_DUMMY" && a.customsLotItemId,
    );
    if (manual.length) {
      setSelected(
        manual.map((a) => ({
          customsLotItemId: String(a.customsLotItemId),
          qty: Number(a.qty) || 0,
        })),
      );
      setOverrideMode(false);
      setOverrideFields(EMPTY_OVERRIDE);
      return;
    }
    const dummy = (initialAllocations || []).find((a) => a.allocationMode === "OVERRIDE_DUMMY");
    if (dummy) {
      setOverrideMode(true);
      setOverrideFields({
        boeNumber: dummy.boeNumber || "",
        blNumber: dummy.blNumber || "",
        awbNumber: dummy.awbNumber || "",
        supplierInvoiceNumber: dummy.supplierInvoiceNumber || "",
        overrideReason: dummy.overrideReason || "",
      });
      setSelected([]);
    } else {
      setSelected([]);
      setOverrideMode(false);
      setOverrideFields(EMPTY_OVERRIDE);
    }
  }, [open, initialAllocations, line]);

  const lots = lotsQ.data || [];
  const lotMap = useMemo(() => new Map(lots.map((l) => [String(l.customsLotItemId), l])), [lots]);

  const selectedTotal = selected.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const remaining = qtyRequired - selectedTotal;

  function setQtyForLot(lotItemId, rawQty) {
    const qty = Math.max(0, Number(rawQty) || 0);
    setSelected((prev) => {
      const id = String(lotItemId);
      const lot = lotMap.get(id);
      const max = Number(lot?.qtyAvailable) || 0;
      const capped = Math.min(qty, max);
      const without = prev.filter((r) => r.customsLotItemId !== id);
      if (capped <= 0) return without;
      return [...without, { customsLotItemId: id, qty: capped }];
    });
  }

  function getSelectedQty(lotItemId) {
    return selected.find((r) => r.customsLotItemId === String(lotItemId))?.qty || 0;
  }

  function handleSave() {
    if (overrideMode) {
      if (!allowOverride) {
        notify.warning("Override requires CUSTOMS.override (Customs BOE Override) permission.");
        return;
      }
      if (!String(overrideFields.overrideReason || "").trim()) {
        notify.warning("Override reason is mandatory.");
        return;
      }
      onSave([
        {
          allocationMode: "OVERRIDE_DUMMY",
          qty: qtyRequired,
          ...overrideFields,
        },
      ]);
      return;
    }

    if (Math.abs(selectedTotal - qtyRequired) > 1e-6) {
      notify.warning(`Allocations must total ${qtyRequired} (currently ${selectedTotal}).`);
      return;
    }

    const allocations = selected.map((row) => {
      const lot = lotMap.get(row.customsLotItemId) || {};
      return {
        customsLotItemId: row.customsLotItemId,
        qty: row.qty,
        allocationMode: "MANUAL",
        boeNumber: lot.boeNumber,
        blNumber: lot.blNumber,
        awbNumber: lot.awbNumber,
        supplierInvoiceNumber: lot.supplierInvoiceNumber,
        supplierName: lot.supplierName,
        countryOfOrigin: lot.countryOfOrigin,
      };
    });
    onSave(allocations);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-base font-semibold">Available Customs Lots</h3>
            <p className="mt-1 text-xs text-gray-600">
              Article <span className="font-mono">{articleNumber}</span>
              {partNumber ? (
                <>
                  {" "}
                  · Part <span className="font-mono">{partNumber}</span>
                </>
              ) : null}
              {" "}
              · Export qty <b>{fmtNum(qtyRequired)}</b>
              {!overrideMode ? (
                <>
                  {" "}
                  · Selected <b>{fmtNum(selectedTotal)}</b> · Remaining{" "}
                  <b className={remaining < 0 ? "text-rose-600" : ""}>{fmtNum(remaining)}</b>
                </>
              ) : null}
            </p>
          </div>
          <button type="button" className="rounded-lg border px-2 py-1 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {allowOverride ? (
          <div className="border-b bg-amber-50 px-4 py-2 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={overrideMode}
                onChange={(e) => setOverrideMode(e.target.checked)}
              />
              Override customs source (dummy BOE — requires BOE Override permission)
            </label>
          </div>
        ) : null}

        <div className="flex-1 overflow-auto p-4">
          {overrideMode ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["BOE", "boeNumber"],
                ["BL", "blNumber"],
                ["AWB", "awbNumber"],
                ["Supplier Invoice", "supplierInvoiceNumber"],
              ].map(([label, key]) => (
                <label key={key} className="block text-sm">
                  <span className="text-xs text-gray-500">{label}</span>
                  <input
                    className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
                    value={overrideFields[key]}
                    onChange={(e) => setOverrideFields((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </label>
              ))}
              <label className="block text-sm sm:col-span-2">
                <span className="text-xs text-gray-500">Reason (mandatory)</span>
                <textarea
                  className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
                  rows={3}
                  value={overrideFields.overrideReason}
                  onChange={(e) => setOverrideFields((f) => ({ ...f, overrideReason: e.target.value }))}
                />
              </label>
            </div>
          ) : lotsQ.isLoading ? (
            <p className="text-sm text-gray-500">Loading available lots…</p>
          ) : lots.length === 0 ? (
            <p className="text-sm text-amber-700">No customs stock available for this article.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 text-xs uppercase tracking-wide text-gray-600">
                  <tr>
                    <th className="px-2 py-2 text-left">BOE</th>
                    <th className="px-2 py-2 text-left">BL</th>
                    <th className="px-2 py-2 text-left">AWB</th>
                    <th className="px-2 py-2 text-left">Supplier Invoice</th>
                    <th className="px-2 py-2 text-left">Supplier</th>
                    <th className="px-2 py-2 text-left">BOE Date</th>
                    <th className="px-2 py-2 text-left">SI Date</th>
                    <th className="px-2 py-2 text-right">Qty Imported</th>
                    <th className="px-2 py-2 text-right">Qty Available</th>
                    <th className="px-2 py-2 text-left">COO</th>
                    <th className="px-2 py-2 text-right">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot) => (
                    <tr key={lot.customsLotItemId} className="border-t">
                      <td className="px-2 py-2 font-mono text-xs">{lot.boeNumber || "—"}</td>
                      <td className="px-2 py-2 font-mono text-xs">{lot.blNumber || "—"}</td>
                      <td className="px-2 py-2 font-mono text-xs">{lot.awbNumber || "—"}</td>
                      <td className="px-2 py-2 text-xs">{lot.supplierInvoiceNumber || "—"}</td>
                      <td className="px-2 py-2 text-xs">{lot.supplierName || "—"}</td>
                      <td className="px-2 py-2 text-xs">{fmtDate(lot.boeDate)}</td>
                      <td className="px-2 py-2 text-xs">{fmtDate(lot.supplierInvoiceDate)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtNum(lot.qtyImported)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{fmtNum(lot.qtyAvailable)}</td>
                      <td className="px-2 py-2 text-xs">{lot.countryOfOrigin || "—"}</td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          min={0}
                          max={lot.qtyAvailable}
                          step="any"
                          className="w-24 rounded border px-2 py-1 text-right text-xs"
                          value={getSelectedQty(lot.customsLotItemId) || ""}
                          onChange={(e) => setQtyForLot(lot.customsLotItemId, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button type="button" className="rounded-xl border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-3 py-1.5 text-sm text-white"
            onClick={handleSave}
          >
            Apply allocation
          </button>
        </div>
      </div>
    </div>
  );
}
