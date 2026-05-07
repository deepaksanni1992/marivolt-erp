import Modal from "../erp/Modal.jsx";

export default function PaymentReceiptView({ open, onClose, receipt, onPrint, onViewSlip }) {
  const r = receipt || {};
  return (
    <Modal open={open} onClose={onClose} title="Payment Receipt View" wide>
      <div className="grid gap-2 rounded-xl border bg-white p-4 text-sm sm:grid-cols-2">
        <div><b>Receipt No:</b> {r.receiptNo || "-"}</div>
        <div><b>Receipt Date:</b> {r.receiptDate ? new Date(r.receiptDate).toLocaleDateString() : "-"}</div>
        <div><b>Customer:</b> {r.customerName || "-"}</div>
        <div><b>Currency:</b> {r.currency || "-"}</div>
        <div><b>Amount Received:</b> {Number(r.amountReceived || 0).toFixed(2)}</div>
        <div><b>Allocated:</b> {Number(r.allocatedAmount || 0).toFixed(2)}</div>
        <div><b>Unallocated:</b> {Number(r.unallocatedAmount || 0).toFixed(2)}</div>
        <div><b>Mode:</b> {String(r.paymentMode || "").replaceAll("_", " ") || "-"}</div>
        <div><b>Bank/Cash Account:</b> {r.bankCashAccountName || r.accountName || "-"}</div>
        <div><b>Reference:</b> {r.paymentReference || "-"}</div>
        <div><b>Proforma:</b> {r.proformaInvoiceNo || "-"}</div>
        <div><b>Sales Invoice:</b> {r.salesInvoiceNo || "-"}</div>
        <div className="sm:col-span-2"><b>Remarks:</b> {r.remarks || "-"}</div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={() => onPrint?.(r._id)}>Print</button>
        <button
          type="button"
          className={`rounded-xl border px-3 py-2 text-sm ${r.attachmentKey ? "" : "opacity-40"}`}
          disabled={!r.attachmentKey}
          onClick={() => onViewSlip?.(r._id)}
        >
          View Slip
        </button>
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onClose}>Back</button>
      </div>
    </Modal>
  );
}
