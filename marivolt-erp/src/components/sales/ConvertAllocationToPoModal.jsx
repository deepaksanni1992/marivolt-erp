import { useEffect, useMemo, useState } from "react";
import Modal from "../erp/Modal.jsx";
import { TextInput } from "../erp/FormField.jsx";
import { poConversionStatusClass } from "../../lib/allocationPoSession.js";
import { notify } from "../../lib/notifications.js";

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

  useEffect(() => {
    if (!open) return;
    const nextSelected = {};
    const nextQty = {};
    for (const line of lines) {
      if (!line.eligible) continue;
      const id = String(line.allocationLineId);
      nextSelected[id] = true;
      const suggested = Number(line.suggestedPurchaseQty) || 0;
      const remaining = Number(line.remainingConvertibleQty) || 0;
      nextQty[id] = suggested > 0 ? suggested : remaining > 0 ? remaining : 0;
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
        const suggested = Number(line.suggestedPurchaseQty) || 0;
        const remaining = Number(line.remainingConvertibleQty) || 0;
        next[id] = suggested > 0 ? Math.min(suggested, remaining) : remaining;
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
        const suggested = Number(line.suggestedPurchaseQty) || 0;
        const remaining = Number(line.remainingConvertibleQty) || 0;
        if (useSuggestedQty) {
          nextQty[id] = suggested > 0 ? Math.min(suggested, remaining) : remaining;
        } else if (!(Number(nextQty[id]) > 0)) {
          nextQty[id] = remaining;
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
      const remaining = Number(src.remainingConvertibleQty) || 0;
      if (row.requestedQty > remaining + 1e-6) {
        notify.error(
          `Requested quantity for ${row.article} exceeds remaining convertible quantity (${remaining}).`
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
            Every allocation line can be converted to a Purchase Order. Suggested purchase quantity is
            informational only. Quantities are not reserved until the PO is saved.
          </p>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={useSuggestedQty}
              onChange={(e) => setUseSuggestedQty(e.target.checked)}
            />
            Use Suggested Purchase Quantity (default)
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              placeholder="Search article, description, SPN or part number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="min-w-[280px] flex-1"
            />
            <button type="button" className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => toggleAll(true)}>
              Select All
            </button>
            <button type="button" className="rounded-lg border px-3 py-1.5 text-xs" onClick={() => toggleAll(false)}>
              Clear All
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border">
            <table className="min-w-[1400px] w-full text-xs">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-2 py-2">Select</th>
                  <th className="px-2 py-2">Article</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">SPN / Part</th>
                  <th className="px-2 py-2 text-right">Ordered Qty</th>
                  <th className="px-2 py-2 text-right">Available Stock</th>
                  <th className="px-2 py-2 text-right">Allocated Stock</th>
                  <th className="px-2 py-2 text-right">Suggested Purchase Qty</th>
                  <th className="px-2 py-2 text-right">Already Converted</th>
                  <th className="px-2 py-2 text-right">Remaining Convertible</th>
                  <th className="px-2 py-2 text-right">Requested PO Qty</th>
                  <th className="px-2 py-2">Status</th>
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
                    const remaining = Number(line.remainingConvertibleQty) || 0;
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
                        <td className="px-2 py-2 text-right tabular-nums">{line.orderedQty}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{line.availableStockQty}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{line.allocatedStockQty}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-gray-600">
                          {line.suggestedPurchaseQty}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{line.alreadyConvertedToPoQty}</td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">{remaining}</td>
                        <td className="px-2 py-2 text-right">
                          <input
                            type="number"
                            min={checked && !disabled ? 1 : 0}
                            max={remaining}
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
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${poConversionStatusClass(line.conversionStatus)}`}
                          >
                            {line.conversionStatus}
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
