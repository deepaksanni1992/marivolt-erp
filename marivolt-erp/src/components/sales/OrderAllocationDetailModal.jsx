import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import Modal from "../erp/Modal.jsx";
import { apiGet, apiPatch } from "../../lib/api.js";
import {
  allocationStockStatusClass,
  allocationProcurementStatusClass,
  formatStatusLabel,
  userCanCreatePoFromAllocation,
} from "../../lib/allocationPoSession.js";

function statusBadgeClass(status) {
  const s = String(status || "").toUpperCase();
  if (s === "CANCELLED") return "bg-red-50 text-red-800 ring-red-200";
  if (s === "CLOSED") return "bg-zinc-100 text-zinc-800 ring-zinc-200";
  return "bg-emerald-50 text-emerald-900 ring-emerald-200";
}

function qty(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ReservationBreakdownModal({ open, onClose, line, allocationNo }) {
  const rows = line?.reservationBreakdown || [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reservation breakdown"
      subtitle={
        line
          ? `${line.article || "Article"} · ${allocationNo || "Allocation"}`
          : undefined
      }
      xlarge
    >
      {!line ? (
        <p className="text-sm text-gray-500">No line selected.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No active reservations for this article/warehouse.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-2 text-left">Allocation No</th>
                <th className="px-2 py-2 text-left">Customer</th>
                <th className="px-2 py-2 text-left">OA</th>
                <th className="px-2 py-2 text-left">PI</th>
                <th className="px-2 py-2 text-left">Warehouse</th>
                <th className="px-2 py-2 text-right">Reserved Qty</th>
                <th className="px-2 py-2 text-right">Packed Qty</th>
                <th className="px-2 py-2 text-left">Allocation Status</th>
                <th className="px-2 py-2 text-left">Ownership</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr
                  key={`${r.allocationId}-${idx}`}
                  className={`border-t ${r.isCurrent ? "bg-emerald-50/60" : ""}`}
                >
                  <td className="px-2 py-2 font-mono">{r.allocationNo || "—"}</td>
                  <td className="px-2 py-2">{r.customerName || "—"}</td>
                  <td className="px-2 py-2">{r.linkedOANo || "—"}</td>
                  <td className="px-2 py-2">{r.linkedProformaNo || "—"}</td>
                  <td className="px-2 py-2">{r.warehouse || "—"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{qty(r.reservedQty)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{qty(r.packedQty)}</td>
                  <td className="px-2 py-2">{r.status || "—"}</td>
                  <td className="px-2 py-2">
                    {r.isCurrent ? (
                      <span className="font-semibold text-emerald-800">This allocation</span>
                    ) : (
                      <span className="text-amber-800">Reserved for another allocation</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export default function OrderAllocationDetailModal({
  open,
  allocationId,
  onClose,
  authUser,
  onConvertToPo,
}) {
  const canConvert = userCanCreatePoFromAllocation(authUser);
  const queryClient = useQueryClient();
  const [breakdownLine, setBreakdownLine] = useState(null);
  const [editingNo, setEditingNo] = useState(false);
  const [draftNo, setDraftNo] = useState("");
  const [numberError, setNumberError] = useState("");

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
  const canEditAllocationNo = allocation?.canEditAllocationNo === true;
  const editBlockedReason =
    allocation?.allocationNoEditBlockedReason ||
    "Allocation number cannot be changed in the current lifecycle state.";

  useEffect(() => {
    if (!open) {
      setEditingNo(false);
      setDraftNo("");
      setNumberError("");
    }
  }, [open, allocationId]);

  const saveNumber = useMutation({
    mutationFn: (allocationNo) =>
      apiPatch(`/sales/order-allocations/${allocationId}/allocation-no`, { allocationNo }),
    onSuccess: async () => {
      setEditingNo(false);
      setNumberError("");
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["order-allocations"] });
    },
    onError: (e) => {
      setNumberError(e?.response?.data?.message || e.message || "Failed to update allocation number");
    },
  });

  return (
    <>
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
                {editingNo ? (
                  <div className="mt-1 space-y-2">
                    <input
                      type="text"
                      className="w-full rounded-lg border px-2 py-1 font-mono text-sm"
                      value={draftNo}
                      onChange={(e) => setDraftNo(e.target.value)}
                      autoFocus
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-lg border bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-40"
                        disabled={saveNumber.isPending}
                        onClick={() => saveNumber.mutate(draftNo)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border px-2 py-1 text-xs"
                        disabled={saveNumber.isPending}
                        onClick={() => {
                          setEditingNo(false);
                          setDraftNo(allocation.allocationNo || "");
                          setNumberError("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {numberError ? <p className="text-xs text-red-700">{numberError}</p> : null}
                  </div>
                ) : (
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span className="font-mono">{allocation.allocationNo}</span>
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!canEditAllocationNo}
                      title={canEditAllocationNo ? "Edit allocation number" : editBlockedReason}
                      onClick={() => {
                        setDraftNo(allocation.allocationNo || "");
                        setNumberError("");
                        setEditingNo(true);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}
                {!canEditAllocationNo && !editingNo ? (
                  <p className="mt-1 text-xs text-amber-800">{editBlockedReason}</p>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-gray-500">Customer</div>
                <div>{allocation.customerName}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Status</div>
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(allocation.status)}`}
                >
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
                        ? "No purchase shortfall — Convert to PO not required"
                        : "Convert selected articles to Purchase Order"
                  }
                  onClick={() => onConvertToPo?.(allocationId, eligibility)}
                >
                  Convert to PO
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() => refetch()}
              >
                Refresh
              </button>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase text-gray-500">
                Allocation lines &amp; stock position
              </div>
              <div className="overflow-x-auto rounded-xl border">
                <table className="min-w-[1200px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">S/N</th>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Description</th>
                      <th className="px-2 py-2 text-left">Part No</th>
                      <th className="px-2 py-2 text-right">Ordered</th>
                      <th className="px-2 py-2 text-right">Physical</th>
                      <th className="px-2 py-2 text-right">Reserved Here</th>
                      <th className="px-2 py-2 text-right">Reserved Others</th>
                      <th className="px-2 py-2 text-right">Free Stock</th>
                      <th className="px-2 py-2 text-right">Purchase Shortfall</th>
                      <th className="px-2 py-2 text-right">PO Created</th>
                      <th className="px-2 py-2 text-left">Stock Status</th>
                      <th className="px-2 py-2 text-left">Procurement Status</th>
                      <th className="px-2 py-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={String(line.allocationLineId)} className="border-t">
                        <td className="px-2 py-2">{line.serialNo || idx + 1}</td>
                        <td className="px-2 py-2 font-mono">{line.article}</td>
                        <td className="px-2 py-2">{line.description || "—"}</td>
                        <td className="px-2 py-2">{line.partNumber || "—"}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{qty(line.orderedQty)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{qty(line.physicalQty)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          <button
                            type="button"
                            className="tabular-nums text-blue-700 underline"
                            onClick={() => setBreakdownLine(line)}
                          >
                            {qty(line.reservedForThisAllocation)}
                          </button>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          <button
                            type="button"
                            className="tabular-nums text-blue-700 underline"
                            onClick={() => setBreakdownLine(line)}
                          >
                            {qty(line.reservedForOtherAllocations)}
                          </button>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {qty(line.freeAvailableQty)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">
                          {qty(line.purchaseShortfallQty ?? line.suggestedPurchaseQty)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {qty(line.alreadyConvertedToPoQty ?? line.poCreatedQty)}
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${allocationStockStatusClass(line.stockStatus)}`}
                          >
                            {formatStatusLabel(line.stockStatus)}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${allocationProcurementStatusClass(line.procurementStatus)}`}
                          >
                            {formatStatusLabel(line.procurementStatus)}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="text-blue-700 underline"
                            onClick={() => setBreakdownLine(line)}
                          >
                            View Reservations
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-gray-500">
                PO Qty Not Converted is tracked separately for conversion history and is not shown as
                fulfilment shortage. Primary operational metric: Purchase Shortfall.
              </p>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase text-gray-500">
                Linked Purchase Orders
              </div>
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

      <ReservationBreakdownModal
        open={!!breakdownLine}
        onClose={() => setBreakdownLine(null)}
        line={breakdownLine}
        allocationNo={allocation?.allocationNo}
      />
    </>
  );
}
