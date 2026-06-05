import { useQuery } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { apiGetWithQuery } from "../../lib/api.js";

/** Temporary customs stock viewer — GET /api/customs/stock */
export default function GrnCustomsStockModal({ open, onClose }) {
  const stockQ = useQuery({
    queryKey: ["customs-stock"],
    queryFn: () => apiGetWithQuery("/customs/stock", { limit: 200 }),
    enabled: open,
  });

  const rows = stockQ.data?.items || [];
  const enabled = stockQ.data?.enabled !== false;

  return (
    <Modal open={open} onClose={onClose} title="Customs Stock" wide>
      {stockQ.isLoading ? <p className="text-sm text-slate-500">Loading customs stock…</p> : null}
      {stockQ.isError ? (
        <p className="text-sm text-rose-700">{stockQ.error?.message || "Failed to load customs stock"}</p>
      ) : null}
      {!stockQ.isLoading && !enabled ? (
        <p className="text-sm text-amber-800">Customs module is disabled on this server.</p>
      ) : null}
      {enabled && !stockQ.isLoading && !stockQ.isError ? (
        <>
          <p className="mb-2 text-xs text-slate-500">
            {rows.length} row(s) · company-scoped customs lot items with available qty
          </p>
          <div className="max-h-[60vh] overflow-auto rounded border">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="sticky top-0 bg-slate-100 text-left text-[11px] uppercase text-slate-600">
                <tr>
                  <th className="px-2 py-2">Lot Ref</th>
                  <th className="px-2 py-2">GRN</th>
                  <th className="px-2 py-2">Article</th>
                  <th className="px-2 py-2">Part No</th>
                  <th className="px-2 py-2">HS Code</th>
                  <th className="px-2 py-2 text-right">Qty Avail</th>
                  <th className="px-2 py-2 text-right">Unit Price</th>
                  <th className="px-2 py-2">BOE</th>
                  <th className="px-2 py-2">BL</th>
                  <th className="px-2 py-2">Supplier Inv</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((row) => (
                    <tr key={row._id} className="border-t border-slate-100">
                      <td className="px-2 py-1.5 font-mono">{row.customsLotRef || "—"}</td>
                      <td className="px-2 py-1.5 font-mono">{row.grnNo || "—"}</td>
                      <td className="px-2 py-1.5 font-mono font-semibold">{row.articleNumber || "—"}</td>
                      <td className="px-2 py-1.5">{row.partNumber || "—"}</td>
                      <td className="px-2 py-1.5">{row.hsCode || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.qtyAvailable ?? row.customStockBalance ?? 0}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{row.unitPrice ?? "—"}</td>
                      <td className="px-2 py-1.5">{row.boeNumber || "—"}</td>
                      <td className="px-2 py-1.5">{row.blNumber || "—"}</td>
                      <td className="px-2 py-1.5">{row.supplierInvoiceNumber || "—"}</td>
                      <td className="px-2 py-1.5">{row.status || "—"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-slate-500">
                      No customs stock yet. Post a GRN with customs information to create inbound lots.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
