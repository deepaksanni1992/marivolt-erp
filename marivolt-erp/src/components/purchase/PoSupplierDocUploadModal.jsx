import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { apiDelete, apiGet, apiPost, apiPostFormData } from "../../lib/api.js";

/** Matches Document model upload labels and PurchaseDocument internal types. */
const INVOICE_DOC_TYPES = [
  { internal: "SUPPLIER_PROFORMA", uploadLabel: "Supplier Proforma Invoice" },
  { internal: "SUPPLIER_TAX_INVOICE", uploadLabel: "Supplier Tax Invoice" },
  { internal: "COMMERCIAL_INVOICE", uploadLabel: "Commercial Invoice" },
];

/**
 * Upload supplier PI / invoice, list attached files (view / delete), optional draft purchase invoice.
 */
export default function PoSupplierDocUploadModal({ open, onClose, poId, poNumber, supplierName, currency, qc, setErr }) {
  const innerQc = useQueryClient();
  const queryClient = qc || innerQc;
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
  const [autoCreateDraftPi, setAutoCreateDraftPi] = useState(true);

  const docsQ = useQuery({
    queryKey: ["po-documents", poId],
    queryFn: () => apiGet(`/purchase-orders/${poId}/documents`),
    enabled: Boolean(open && poId),
  });

  useEffect(() => {
    if (!open) return;
    setDocPick(INVOICE_DOC_TYPES[0]);
    setMeta({ documentNo: "", amount: "", currency: "", remarks: "", file: null });
    setInvDraft({ supplierInvoiceNo: "", taxAmount: "0", otherCharges: "0", remarks: "" });
    setAutoCreateDraftPi(true);
    setErr("");
  }, [open, setErr]);

  const deleteDocMut = useMutation({
    mutationFn: (purchaseDocumentId) => apiDelete(`/purchase-orders/${poId}/documents/${purchaseDocumentId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["po-documents", poId] });
      queryClient.invalidateQueries({ queryKey: ["po-ap-summary", poId] });
      queryClient.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
      queryClient.invalidateQueries({ queryKey: ["purchaseOrders"] });
      queryClient.invalidateQueries({ queryKey: ["ap-po-supplier-documents"] });
    },
    onError: (e) => setErr(e.message || String(e)),
  });

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
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["po-documents", poId] });
      queryClient.invalidateQueries({ queryKey: ["po-ap-summary", poId] });
      queryClient.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
      queryClient.invalidateQueries({ queryKey: ["purchaseOrders"] });
      queryClient.invalidateQueries({ queryKey: ["purchaseSummary"] });
      queryClient.invalidateQueries({ queryKey: ["apDashboard"] });
      queryClient.invalidateQueries({ queryKey: ["ap-po-supplier-documents"] });
      setErr("");
      const sinv = (meta.documentNo || "").trim() || (invDraft.supplierInvoiceNo || "").trim();
      if (autoCreateDraftPi && sinv) {
        try {
          await apiPost(`/purchase-invoices/from-po/${poId}`, {
            supplierInvoiceNo: sinv,
            taxAmount: Number(invDraft.taxAmount) || 0,
            otherCharges: Number(invDraft.otherCharges) || 0,
            remarks: invDraft.remarks || `PO ${poNumber || ""} supplier document`,
          });
          queryClient.invalidateQueries({ queryKey: ["purchaseInvoices"] });
        } catch (e) {
          setErr(
            (e.message || String(e)) +
              " — File was saved on the PO. Open Accounts → Purchase Invoices and use Create draft, or fix the error above."
          );
        }
      }
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
      queryClient.invalidateQueries({ queryKey: ["po-ap-summary", poId] });
      queryClient.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      queryClient.invalidateQueries({ queryKey: ["apDashboard"] });
      queryClient.invalidateQueries({ queryKey: ["purchaseOrder", poId] });
      queryClient.invalidateQueries({ queryKey: ["ap-po-supplier-documents"] });
      setErr("");
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  async function viewFile(row) {
    setErr("");
    try {
      if (row.documentId) {
        const { url } = await apiGet(`/documents/${row.documentId}/download`);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      if (row.fileUrl) {
        window.open(row.fileUrl, "_blank", "noopener,noreferrer");
        return;
      }
      setErr("No file link available for this row.");
    } catch (e) {
      setErr(e.message || String(e));
    }
  }

  if (!poId) return null;

  const items = docsQ.data?.items || [];

  return (
    <Modal open={open} onClose={onClose} title="PO supplier documents (PI / invoice)" wide>
      <p className="mb-3 text-xs text-gray-600">
        Files are stored on <b>AWS S3</b> and linked to PO{" "}
        <span className="font-mono font-semibold">{poNumber || "—"}</span> ({supplierName || "—"}). Use{" "}
        <b>View</b> for a secure download link. <b>Delete</b> voids the link on this PO (does not delete the S3 object
        automatically). When <b>Create purchase invoice draft after upload</b> is on and you enter a supplier document
        number, a draft is created in Accounts so it appears under Purchase Invoices.
      </p>

      <div className="mb-4 rounded border border-slate-200 bg-slate-50/80 p-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-700">Attached on this PO</div>
        {docsQ.isLoading ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : !items.length ? (
          <p className="text-xs text-gray-500">No supplier documents yet.</p>
        ) : (
          <ul className="max-h-40 space-y-2 overflow-y-auto text-xs">
            {items.map((d) => (
              <li
                key={d._id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-white bg-white px-2 py-1.5"
              >
                <div>
                  <span className="font-semibold text-gray-900">{d.documentType}</span>
                  {d.documentNo ? <span className="ml-2 font-mono text-gray-700">{d.documentNo}</span> : null}
                  <div className="text-[10px] text-gray-500">
                    {d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : ""}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-900 hover:bg-blue-100"
                    onClick={() => viewFile(d)}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-40"
                    disabled={deleteDocMut.isPending}
                    onClick={() => {
                      if (!window.confirm("Remove this document from the PO?")) return;
                      deleteDocMut.mutate(d._id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t pt-3 text-sm">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-700">Upload new file</div>
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
          placeholder="Supplier document / invoice no. (used for Accounts draft if enabled below)"
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
        <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-800">
          <input
            type="checkbox"
            checked={autoCreateDraftPi}
            onChange={(e) => setAutoCreateDraftPi(e.target.checked)}
          />
          After upload, create purchase invoice draft in Accounts (needs supplier document / invoice no. above)
        </label>
        <button
          type="button"
          className="rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={uploadMut.isPending}
          onClick={() => uploadMut.mutate()}
        >
          {uploadMut.isPending ? "Uploading…" : "Upload & link to PO"}
        </button>

        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-semibold text-gray-700">Create / refresh purchase invoice draft (Accounts)</p>
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
