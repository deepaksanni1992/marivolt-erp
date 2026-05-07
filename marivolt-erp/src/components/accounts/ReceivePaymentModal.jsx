import Modal from "../erp/Modal.jsx";
import { FormField, TextInput } from "../erp/FormField.jsx";

export default function ReceivePaymentModal({
  open,
  onClose,
  title = "Receive Payment",
  sourceType = "PROFORMA_INVOICE",
  document = null,
  bankDetails = [],
  form,
  setForm,
  onSubmit,
  isSubmitting = false,
}) {
  const alreadyReceived = Number(document?.totalReceivedAmount || 0);
  const balance = Number(document?.balanceAmount ?? document?.grandTotal ?? 0);
  const canSubmit = !!document?._id && Number(form?.amountReceived || 0) > 0 && !!form?.receiptDate;
  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={sourceType === "SALES_INVOICE" ? "Sales Invoice No." : "Proforma Invoice No."}>
            <TextInput value={document?.invoiceNo || document?.proformaNo || ""} disabled />
          </FormField>
          <FormField label="Customer Name">
            <TextInput value={document?.customerName || ""} disabled />
          </FormField>
          <FormField label="Invoice Grand Total">
            <TextInput value={`${document?.currency || "USD"} ${Number(document?.grandTotal || 0).toFixed(2)}`} disabled />
          </FormField>
          <FormField label="Already Received">
            <TextInput value={`${document?.currency || "USD"} ${alreadyReceived.toFixed(2)}`} disabled />
          </FormField>
          <FormField label="Balance Amount">
            <TextInput value={`${document?.currency || "USD"} ${balance.toFixed(2)}`} disabled />
          </FormField>
          <FormField label="Receipt Date *">
            <TextInput type="date" value={form.receiptDate || ""} onChange={(e) => setForm((f) => ({ ...f, receiptDate: e.target.value }))} />
          </FormField>
          <FormField label="Amount Received *">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.amountReceived}
              onChange={(e) => setForm((f) => ({ ...f, amountReceived: Number(e.target.value) || 0 }))}
            />
          </FormField>
          <FormField label="Currency *">
            <TextInput value={form.currency || ""} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
          <FormField label="Payment Mode *">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={form.paymentMode}
              onChange={(e) => setForm((f) => ({ ...f, paymentMode: e.target.value }))}
            >
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="CASH">Cash</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CARD">Card</option>
              <option value="OTHER">Other</option>
            </select>
          </FormField>
          <FormField label="Bank / Cash Account *">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={form.bankCashAccountName}
              onChange={(e) => setForm((f) => ({ ...f, bankCashAccountName: e.target.value }))}
            >
              <option value="">Select account</option>
              {(bankDetails || []).map((b) => (
                <option key={b._id} value={b.accountName || b.bankName || ""}>
                  {b.accountName || b.bankName} ({b.currency || "USD"})
                </option>
              ))}
              <option value="Cash">Cash</option>
            </select>
          </FormField>
          <FormField label="Payment Reference / Txn ID">
            <TextInput value={form.paymentReference || ""} onChange={(e) => setForm((f) => ({ ...f, paymentReference: e.target.value }))} />
          </FormField>
          <FormField label="Remarks">
            <TextInput value={form.remarks || ""} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
          </FormField>
          <FormField label="Payment Slip (PDF/JPG/PNG)">
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => setForm((f) => ({ ...f, attachmentFile: e.target.files?.[0] || null }))}
            />
            {form.attachmentFile ? <div className="mt-1 text-xs text-gray-600">{form.attachmentFile.name}</div> : null}
          </FormField>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={isSubmitting || !canSubmit}
            onClick={() => onSubmit({ sourceType, document, form })}
          >
            {isSubmitting ? "Posting..." : "Post Payment"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
