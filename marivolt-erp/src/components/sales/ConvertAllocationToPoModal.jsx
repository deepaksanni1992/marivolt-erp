import { useEffect, useMemo, useState } from "react";
import Modal from "../erp/Modal.jsx";
import { TextInput } from "../erp/FormField.jsx";
import {
  allocationProcurementStatusClass,
  formatStatusLabel,
  poConversionStatusClass,
} from "../../lib/allocationPoSession.js";
import { notify } from "../../lib/notifications.js";

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function ConvertAllocationToPoModal({
  open,
  onClose,
  eligibility,
  loading,
  onContinue,
}) {
  const lines = eligibility?.lines || [];
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({});
  const [qtyByLine, setQtyByLine] = useState({});
  const [useSuggestedQty, setUseSuggestedQty] = useState(true);

  function suggestedFor(line) {
    const shortfall = qty(line.purchaseShortfallQty ?? line.suggestedPurchaseQty);
    const remaining = qty(line.remainingConvertibleQty);
    const defaultReq = qty(line.defaultRequestedQty);
    if (defaultReq > 0) return Math.min(defaultReq, remaining || defaultReq);
    if (shortfall > 0) return Math.min(shortfall, remaining || shortfall);
    return 0;
  }

  useEffect(() => {
    if (!open) return;
    const nextSelected = {};
    const nextQty = {};
    for (const line of lines) {
      if (!line.eligible) continue;
      const id = String(line.allocationLineId);
      nextSelected[id] = true;
      nextQty[id] = suggestedFor(line);
    }
    setSelected(nextSelected);
    setQtyByLine(nextQty);
    setSearch("");
    setUseSuggestedQty(true);
  }, [open, eligibility]);

  useEffect(() => {
    if (!open || !useSuggestedQty) return;
    setQtyByLine((prev) => {
      const next = { ...prev };
      for (const line of lines) {
        if (!line.eligible) continue;
        const id = String(line.allocationLineId);
        if (!selected[id]) continue;
        next[id] = suggestedFor(line);
      }
      return next;
    });
  }, [useSuggestedQty, open, lines, selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) =>
      [l.article, l.description, l.partNumber, l.materialCode]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [lines, search]);

  function toggleAll(on) {
    const next = {};
    const nextQty = { ...qtyByLine };
    for (const line of filtered) {
      if (!line.eligible) continue;
      const id = String(line.allocationLineId);
      next[id] = on;
      if (on) {
        if (useSuggestedQty) {
          nextQty[id] = suggestedFor(line);
        } else if (!(Number(nextQty[id]) > 0)) {
          nextQty[id] = suggestedFor(line) || qty(line.remainingConvertibleQty);
        }
      }
    }
    setSelected((prev) => ({ ...prev, ...next }));
    setQtyByLine(nextQty);
  }

  function handleContinue() {
    const picked = lines
      .filter((l) => selected[String(l.allocationLineId)])
      .map((l) => {
        const id = String(l.allocationLineId);
        const requestedQty = Number(qtyByLine[id]) || 0;
        const intel = l.purchaseIntelligence || {};
        return {
          allocationLineId: l.allocationLineId,
          article: l.article,
          description: l.description,
          partNumber: l.partNumber,
          materialCode: l.materialCode,
          uom: l.uom,
          remarks: l.remarks,
          requestedQty,
          remainingConvertibleQty: l.remainingConvertibleQty,
          purchaseShortfallQty: l.purchaseShortfallQty,
          purchaseIntelligence: intel,
          unitPrice: intel.lastPurchasePrice ?? intel.preferredPrice ?? 0,
          leadTime: intel.lastLeadTime || intel.preferredLeadTime || "",
          supplierPartNumber: intel.supplierPartNumber || "",
          suggestedSupplier: intel.lastSupplier || intel.preferredSupplier || "",
        };
      })
      .filter((l) => l.requestedQty > 0);

    if (!picked.length) {
      notify.warning("Select at least one article with a requested quantity greater than zero.");
      return;
    }

    for (const row of picked) {
      const src = lines.find((l) => String(l.allocationLineId) === String(row.allocationLineId));
      if (!src) continue;
      const remaining = qty(src.remainingConvertibleQty);
      const shortfall = qty(src.purchaseShortfallQty ?? src.suggestedPurchaseQty);
      const maxAllowed = Math.min(remaining, shortfall > 0 ? shortfall : remaining);
      if (row.requestedQty > maxAllowed + 1e-6) {
        notify.error(
          `Requested quantity for ${row.article} exceeds purchase shortfall / convertible quantity (${maxAllowed}).`
        );
        return;
      }
      if (row.requestedQty < 1 - 1e-6) {
        notify.warning(`Requested quantity for ${row.article} must be at least 1.`);
        return;
      }
    }

    onContinue(picked);
  }

  return (
    <Modal open={open} onClose={onClose} title="Convert to Purchase Order" xlarge>
      {loading ? (
        <p className="text-sm text-gray-500">Loading eligibility…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-gray-600">
            Suggested purchase quantity is the <strong>Purchase Shortfall</strong> (uncovered customer
            demand after reserved/packed stock and valid incoming PO coverage). Fully reserved lines
            suggest 0 and are not eligible. Quantities are not reserved until the PO is saved.
          </p>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={useSuggestedQty}
              onChange={(e) => setUseSuggestedQty(e.target.checked)}
            />
            Use Purchase Shortfall as suggested qty (default)
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              placeholder="Search article, description, SPN or part number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-[280px] flex-1"
            />
            <button type="button" className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => toggleAll(true)}>
              Select All Eligible
            </button>
            <button type="button" className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => toggleAll(false)}>
              Clear All
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border">
            <table className="min-w-[1500px] w-full text-xs">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-2 py-2">Select</th>
                  <th className="px-2 py-2">Article</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">SPN / Part</th>
                  <th className="px-2 py-2 text-right">Ordered Qty</th>
                  <th className="px-2 py-2 text-right">Reserved Here</th>
                  <th className="px-2 py-2 text-right">Free Stock</th>
                  <th className="px-2 py-2 text-right">Purchase Shortfall</th>
                  <th className="px-2 py-2 text-right">Already Converted</th>
                  <th className="px-2 py-2 text-right">PO Qty Not Converted</th>
                  <th className="px-2 py-2 text-right">Requested PO Qty</th>
                  <th className="px-2 py-2">Procurement</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-6 text-center text-gray-500">
                      No lines match your search.
                    </td>
                  </tr>
                ) : (
                  filtered.map((line) => {
                    const id = String(line.allocationLineId);
                    const checked = !!selected[id];
                    const disabled = !line.eligible;
                    const remaining = qty(line.remainingConvertibleQty);
                    const shortfall = qty(line.purchaseShortfallQty ?? line.suggestedPurchaseQty);
                    const maxReq = Math.min(remaining, shortfall > 0 ? shortfall : remaining);
                    return (
                      <tr key={id} className="border-t">
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(e) =>
                              setSelected((prev) => ({ ...prev, [id]: e.target.checked }))
                            }
                          />
                        </td>
                        <td className="px-2 py-2 font-mono">{line.article}</td>
                        <td className="px-2 py-2">{line.description || "—"}</td>
                        <td className="px-2 py-2">{line.partNumber || "—"}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{qty(line.orderedQty)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {qty(line.reservedForThisAllocation)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {qty(line.freeAvailableQty ?? line.availableStockQty)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">{shortfall}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {qty(line.alreadyConvertedToPoQty)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{remaining}</td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={checked && !disabled ? 1 : 0}
                            max={maxReq}
                            step="0.0001"
                            disabled={!checked || disabled || useSuggestedQty}
                            className="w-24 rounded border px-2 py-1 text-right disabled:bg-gray-100"
                            value={qtyByLine[id] ?? ""}
                            onChange={(e) =>
                              setQtyByLine((prev) => ({
                                ...prev,
                                [id]: Number(e.target.value) || 0,
                              }))
                            }
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                              line.procurementStatus
                                ? allocationProcurementStatusClass(line.procurementStatus)
                                : poConversionStatusClass(line.conversionStatus)
                            }`}
                          >
                            {formatStatusLabel(line.procurementStatus || line.conversionStatus)}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
              onClick={handleContinue}
            >
              Continue to Purchase Order
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
