import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Modal from "../erp/Modal.jsx";
import { apiGet } from "../../lib/api.js";
import { poConversionStatusClass, userCanCreatePoFromAllocation } from "../../lib/allocationPoSession.js";

function statusBadgeClass(status) {
  const s = String(status || "").toUpperCase();
  if (s === "CANCELLED") return "bg-red-50 text-red-800 ring-red-200";
  if (s === "CLOSED") return "bg-zinc-100 text-zinc-800 ring-zinc-200";
  return "bg-emerald-50 text-emerald-900 ring-emerald-200";
}

export default function OrderAllocationDetailModal({
  open,
  allocationId,
  onClose,
  authUser,
  onConvertToPo,
}) {
  const canConvert = userCanCreatePoFromAllocation(authUser);

  const { data: eligibility, isLoading: eligLoading, refetch } = useQuery({
    queryKey: ["order-allocation-po-eligibility", allocationId],
    queryFn: () => apiGet(`/sales/order-allocations/${allocationId}/po-eligibility`),
    enabled: open && !!allocationId,
  });

  const { data: linkedPo, isLoading: linkedLoading } = useQuery({
    queryKey: ["order-allocation-linked-pos", allocationId],
    queryFn: () => apiGet(`/sales/order-allocations/${allocationId}/linked-purchase-orders`),
    enabled: open && !!allocationId,
  });

  const allocation = eligibility?.allocation;
  const lines = eligibility?.lines || [];
  const activePos = linkedPo?.active || [];
  const cancelledPos = linkedPo?.cancelled || [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Order Allocation"
      subtitle={allocation?.allocationNo ? `Allocation ${allocation.allocationNo}` : undefined}
      xlarge
    >
      {eligLoading ? (
        <p className="text-sm text-gray-500">Loading allocation…</p>
      ) : !allocation ? (
        <p className="text-sm text-gray-500">Allocation not found.</p>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs text-gray-500">Allocation No</div>
              <div className="font-mono">{allocation.allocationNo}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Customer</div>
              <div>{allocation.customerName}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Status</div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(allocation.status)}`}>
                {allocation.status}
              </span>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-gray-50 p-3 text-xs">
              <div className="mb-1 font-semibold uppercase text-gray-500">Linked documents</div>
              <div>Quotation: {allocation.linkedQuotationNo || "—"}</div>
              <div>OA: {allocation.linkedOANo || "—"}</div>
              <div>Proforma: {allocation.linkedProformaNo || "—"}</div>
            </div>
            <div className="rounded-xl border bg-gray-50 p-3 text-xs">
              <div className="mb-1 font-semibold uppercase text-gray-500">Machine</div>
              <div>Vertical: {allocation.vertical || "—"}</div>
              <div>Brand: {allocation.engine || "—"}</div>
              <div>Model: {allocation.model || "—"}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {canConvert ? (
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                disabled={!eligibility?.canConvertToPo || allocation.cancelled}
                title={
                  allocation.cancelled
                    ? "Cancelled allocation"
                    : !eligibility?.canConvertToPo
                      ? "No eligible articles for PO conversion"
                      : "Convert selected articles to Purchase Order"
                }
                onClick={() => onConvertToPo?.(allocationId, eligibility)}
              >
                Convert to PO
              </button>
            ) : null}
            <button type="button" className="rounded-xl border px-3 py-1.5 text-xs" onClick={() => refetch()}>
              Refresh
            </button>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase text-gray-500">Allocation lines &amp; PO status</div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left">S/N</th>
                    <th className="px-2 py-2 text-left">Article</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-left">Part No</th>
                    <th className="px-2 py-2 text-right">Ordered</th>
                    <th className="px-2 py-2 text-right">Suggested Purchase</th>
                    <th className="px-2 py-2 text-right">PO Created</th>
                    <th className="px-2 py-2 text-right">Remaining</th>
                    <th className="px-2 py-2 text-left">PO Status</th>
                    <th className="px-2 py-2 text-left">Linked POs</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={String(line.allocationLineId)} className="border-t">
                      <td className="px-2 py-2">{line.serialNo || idx + 1}</td>
                      <td className="px-2 py-2 font-mono">{line.article}</td>
                      <td className="px-2 py-2">{line.description || "—"}</td>
                      <td className="px-2 py-2">{line.partNumber || "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{line.orderedQty}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{line.suggestedPurchaseQty}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{line.alreadyConvertedToPoQty}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{line.remainingConvertibleQty}</td>
                      <td className="px-2 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${poConversionStatusClass(line.conversionStatus)}`}>
                          {line.conversionStatus}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        {(line.linkedPoNumbers || []).length
                          ? line.linkedPoNumbers.join(", ")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase text-gray-500">Linked Purchase Orders</div>
            {linkedLoading ? (
              <p className="text-xs text-gray-500">Loading linked POs…</p>
            ) : activePos.length === 0 && cancelledPos.length === 0 ? (
              <p className="text-xs text-gray-500">No purchase orders linked yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">PO Number</th>
                      <th className="px-2 py-2 text-left">Supplier</th>
                      <th className="px-2 py-2 text-left">Date</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-right">Linked lines</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                      <th className="px-2 py-2 text-left">Created by</th>
                      <th className="px-2 py-2 text-left">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...activePos, ...cancelledPos].map((po) => (
                      <tr key={String(po._id)} className="border-t">
                        <td className="px-2 py-2 font-mono">{po.poNumber}</td>
                        <td className="px-2 py-2">{po.supplierName || "—"}</td>
                        <td className="px-2 py-2">
                          {po.orderDate ? new Date(po.orderDate).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-2 py-2">{po.status}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{po.linkedLineCount}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {Number(po.grandTotal || 0).toFixed(2)}
                        </td>
                        <td className="px-2 py-2">{po.createdBy || "—"}</td>
                        <td className="px-2 py-2">
                          <Link
                            to={`/purchase?tab=orders&id=${po._id}`}
                            className="text-blue-700 underline"
                            onClick={onClose}
                          >
                            Open PO
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
