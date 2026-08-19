import { discrepancyFlags, hasDiscrepancy } from "../../lib/receivingDisposition.js";

export default function ReceivingDispositionReview({ open, rows = [], onClose, onConfirm }) {
  if (!open) return null;
  const items = rows || [];
  return (
    <div className="fixed inset-0 z-[75] overflow-y-auto bg-slate-100">
      <div className="mx-auto min-h-full max-w-xl px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-bold">Discrepancy Review</h2>
          <button type="button" className="min-h-12 rounded-xl border bg-white px-4 font-semibold" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mb-3 text-sm text-slate-600">
          Confirm physical disposition before completing receiving. This does not create a GRN or post stock.
        </p>
        <div className="space-y-3 pb-8">
          {items.map((row) => {
            const flag = hasDiscrepancy(row) || row.dispositionRequired;
            const tags = discrepancyFlags(row);
            const notReceived = tags.includes("NOT RECEIVED");
            return (
              <div
                key={String(row.receivingUnitId || row.ruNo)}
                className={`rounded-3xl border p-4 ${flag ? "border-amber-400 bg-amber-50" : "bg-white"}`}
              >
                <div className="font-mono text-lg font-bold">{row.ruNo}</div>
                <div className="font-mono text-base">{row.article}</div>
                {tags.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className={`rounded-full px-2 py-1 text-xs font-bold ${
                          tag === "NOT RECEIVED" || tag === "REJECTED"
                            ? "bg-red-100 text-red-800"
                            : tag === "DAMAGED" || tag === "SHORT" || tag === "EXCESS" || tag === "MIXED"
                              ? "bg-amber-200 text-amber-950"
                              : "bg-slate-200 text-slate-800"
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 grid grid-cols-2 gap-1 text-sm">
                  <div>Planned {row.plannedQty}</div>
                  <div>Actual {row.actualQty ?? "—"}</div>
                  {notReceived ? (
                    <>
                      <div>Short {row.shortQty ?? row.plannedQty}</div>
                      <div>Excess {row.excessQty ?? 0}</div>
                    </>
                  ) : (
                    <>
                      <div>Accepted {row.acceptedQty ?? "—"}</div>
                      <div>Damaged {row.damagedQty ?? "—"}</div>
                      <div>Rejected {row.rejectedQty ?? "—"}</div>
                      <div>Short {row.shortQty ?? "—"}</div>
                      <div>Excess {row.excessQty ?? "—"}</div>
                    </>
                  )}
                  <div>Status {row.status}</div>
                </div>
                {row.remarks ? <p className="mt-2 text-sm text-slate-800">&ldquo;{row.remarks}&rdquo;</p> : null}
                {row.dispositionRequired ? (
                  <p className="mt-2 text-sm font-semibold text-red-800">DISPOSITION_REQUIRED — complete disposition before session complete.</p>
                ) : null}
              </div>
            );
          })}
          {!items.length ? <p className="text-slate-500">No receiving units on this session.</p> : null}
          <button
            type="button"
            className="min-h-16 w-full rounded-2xl bg-emerald-700 text-xl font-semibold text-white"
            onClick={onConfirm}
          >
            Confirm Complete Receiving
          </button>
        </div>
      </div>
    </div>
  );
}
