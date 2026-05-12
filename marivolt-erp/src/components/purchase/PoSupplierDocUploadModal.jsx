import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { apiPost, apiPostFormData } from "../../lib/api.js";

/** Matches Document model upload labels and PurchaseDocument internal types. */
const INVOICE_DOC_TYPES = [
  { internal: "SUPPLIER_PROFORMA", uploadLabel: "Supplier Proforma Invoice" },
  { internal: "SUPPLIER_TAX_INVOICE", uploadLabel: "Supplier Tax Invoice" },
  { internal: "COMMERCIAL_INVOICE", uploadLabel: "Commercial Invoice" },
];

/**
 * Upload supplier PI / invoice file and attach to a PO (PurchaseDocument).
 * Optional: create Accounts purchase invoice draft linked to the same PO.
 */
export default function PoSupplierDocUploadModal({ open, onClose, poId, poNumber, supplierName, currency, qc, setErr }) {
  const [docPick, setDocPick] = useState(INVOICE_DOC_TYPES[0]);
  const [meta, setMeta] = useState({
    documentNo: "",
    amount: "",
    currency: "",
    remarks: "",
    file: null,
  });
  const [invDraft, setInvDraft] = useState({
    supplierInvoiceNo: "",
    taxAmount: "0",
    otherCharges: "0",
    remarks: "",
  });

  useEffect(() => {
    if (!open) return;
    setDocPick(INVOICE_DOC_TYPES[0]);
    setMeta({ documentNo: "", amount: "", currency: "", remarks: "", file: null });
    setInvDraft({ supplierInvoiceNo: "", taxAmount: "0", otherCharges: "0", remarks: "" });
    setErr("");
  }, [open]);

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!meta.file) throw new Error("Choose a file");
      const fd = new FormData();
      fd.append("file", meta.file);
      fd.append("documentType", docPick.uploadLabel);
      fd.append("moduleName", "PURCHASE");
      fd.append("relatedId", String(poId));
      fd.append("refNo", poNumber || "");
      fd.append("partyName", supplierName || "");
      const uploaded = await apiPostFormData("/documents/upload", fd);
      return apiPost(`/purchase-orders/${poId}/documents`, {
        documentType: docPick.internal,
        documentNo: meta.documentNo,
        amount: Number(meta.amount) || 0,
        currency: (meta.currency || currency || "USD").toUpperCase(),
        remarks: meta.remarks,
        documentId: uploaded._id,
        fileUrl: uploaded.fileUrl,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-documents", poId] });
      qc.invalidateQueries({ queryKey: ["po-ap-summary", poId] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      setErr("");
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const createInvMut = useMutation({
    mutationFn: () =>
      apiPost(`/purchase-invoices/from-po/${poId}`, {
        supplierInvoiceNo: invDraft.supplierInvoiceNo.trim(),
        taxAmount: Number(invDraft.taxAmount) || 0,
        otherCharges: Number(invDraft.otherCharges) || 0,
        remarks: invDraft.remarks,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-ap-summary", poId] });
      qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
      setErr("");
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  if (!poId) return null;

  return (
    <Modal open={open} onClose={onClose} title="Upload supplier PI / invoice" wide>
      <p className="mb-3 text-xs text-gray-600">
        File is stored securely and linked to PO <span className="font-mono font-semibold">{poNumber || "—"}</span> (
        {supplierName || "—"}). After upload you can create a purchase invoice draft for Accounts; book it there, then
        record supplier payments against that invoice or with PO reference.
      </p>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-semibold text-gray-600">Document type</span>
          <select
            className="mt-1 w-full rounded border px-2 py-1"
            value={docPick.internal}
            onChange={(e) =>
              setDocPick(INVOICE_DOC_TYPES.find((x) => x.internal === e.target.value) || INVOICE_DOC_TYPES[0])
            }
          >
            {INVOICE_DOC_TYPES.map((o) => (
              <option key={o.internal} value={o.internal}>
                {o.uploadLabel}
              </option>
            ))}
          </select>
        </label>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx"
          onChange={(e) => setMeta((m) => ({ ...m, file: e.target.files?.[0] || null }))}
        />
        <input
          className="w-full rounded border px-2 py-1 text-sm"
          placeholder="Supplier document / invoice no."
          value={meta.documentNo}
          onChange={(e) => setMeta((m) => ({ ...m, documentNo: e.target.value }))}
        />
        <div className="flex gap-2">
          <input
            className="w-1/2 rounded border px-2 py-1 text-sm"
            placeholder="Amount (optional)"
            value={meta.amount}
            onChange={(e) => setMeta((m) => ({ ...m, amount: e.target.value }))}
          />
          <input
            className="w-1/2 rounded border px-2 py-1 text-sm"
            placeholder="Currency"
            value={meta.currency || currency || ""}
            onChange={(e) => setMeta((m) => ({ ...m, currency: e.target.value }))}
          />
        </div>
        <textarea
          className="w-full rounded border px-2 py-1 text-sm"
          rows={2}
          placeholder="Remarks"
          value={meta.remarks}
          onChange={(e) => setMeta((m) => ({ ...m, remarks: e.target.value }))}
        />
        <button
          type="button"
          className="rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={uploadMut.isPending}
          onClick={() => uploadMut.mutate()}
        >
          {uploadMut.isPending ? "Uploading…" : "Upload & link to PO"}
        </button>

        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-semibold text-gray-700">Optional: create purchase invoice draft (Accounts)</p>
          <input
            className="mb-2 w-full rounded border px-2 py-1 text-sm"
            placeholder="Supplier invoice no. *"
            value={invDraft.supplierInvoiceNo}
            onChange={(e) => setInvDraft((x) => ({ ...x, supplierInvoiceNo: e.target.value }))}
          />
          <div className="flex gap-2">
            <input
              className="w-1/2 rounded border px-2 py-1 text-sm"
              placeholder="Tax"
              value={invDraft.taxAmount}
              onChange={(e) => setInvDraft((x) => ({ ...x, taxAmount: e.target.value }))}
            />
            <input
              className="w-1/2 rounded border px-2 py-1 text-sm"
              placeholder="Other charges"
              value={invDraft.otherCharges}
              onChange={(e) => setInvDraft((x) => ({ ...x, otherCharges: e.target.value }))}
            />
          </div>
          <textarea
            className="mt-2 w-full rounded border px-2 py-1 text-sm"
            rows={2}
            placeholder="Invoice remarks"
            value={invDraft.remarks}
            onChange={(e) => setInvDraft((x) => ({ ...x, remarks: e.target.value }))}
          />
          <button
            type="button"
            className="mt-2 rounded border border-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-900 disabled:opacity-50"
            disabled={createInvMut.isPending}
            onClick={() => createInvMut.mutate()}
          >
            {createInvMut.isPending ? "Creating…" : "Create draft purchase invoice"}
          </button>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
