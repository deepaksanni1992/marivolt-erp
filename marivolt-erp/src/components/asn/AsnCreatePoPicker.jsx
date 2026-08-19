import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import SearchableDocumentSelect from "../erp/SearchableDocumentSelect.jsx";
import { apiGetWithQuery } from "../../lib/api.js";

const BLOCKED = new Set(["CANCELLED", "REJECTED"]);

export default function AsnCreatePoPicker({ onSelected } = {}) {
  const nav = useNavigate();
  const [selected, setSelected] = useState(null);

  const searchFn = useCallback(async ({ q, page, limit }) => {
    const data = await apiGetWithQuery("/purchase-orders", {
      q: q || undefined,
      page,
      limit,
    });
    const items = (data?.items || [])
      .filter((po) => !BLOCKED.has(String(po.status || "").toUpperCase()))
      .map((po) => ({
        id: String(po._id),
        _id: po._id,
        primaryLabel: po.poNo || po.poNumber || String(po._id),
        secondaryLabel: [po.supplierName, po.status].filter(Boolean).join(" · "),
        poNo: po.poNo || po.poNumber,
        supplierName: po.supplierName,
      }));
    return {
      items,
      total: Number(data?.total) || items.length,
      hasMore: Number(data?.page || 1) * Number(data?.limit || items.length) < Number(data?.total || 0),
    };
  }, []);

  function go(poId) {
    if (!poId) return;
    if (onSelected) onSelected(poId);
    else nav(`/asn/new?poId=${encodeURIComponent(poId)}`);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">Select Purchase Order</h2>
      <p className="mt-1 text-xs text-gray-500">
        Search by PO number, supplier, or article. Available ASN qty is calculated on the server after you select the
        PO.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <SearchableDocumentSelect
          value={selected?.id || ""}
          selectedLabel={selected?.primaryLabel || ""}
          selectedSecondary={selected?.secondaryLabel || ""}
          placeholder="Search PO number, supplier or article…"
          emptyMessage="No matching purchase orders"
          aria-label="Search purchase orders for ASN"
          searchFn={searchFn}
          onChange={(id, item) => setSelected(id ? item : null)}
        />
        <button
          type="button"
          className="min-h-11 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          disabled={!selected?.id}
          onClick={() => go(selected.id)}
        >
          Load PO lines
        </button>
      </div>
    </div>
  );
}
