import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Modal from "../erp/Modal.jsx";
import { apiGet, apiGetWithQuery, apiPost, apiPostFormData } from "../../lib/api.js";

const DOC_OPTIONS = [
  { internal: "SUPPLIER_PROFORMA", uploadLabel: "Supplier Proforma Invoice" },
  { internal: "SUPPLIER_TAX_INVOICE", uploadLabel: "Supplier Tax Invoice" },
  { internal: "COMMERCIAL_INVOICE", uploadLabel: "Commercial Invoice" },
  { internal: "DELIVERY_NOTE", uploadLabel: "Delivery Note" },
  { internal: "PACKING_LIST", uploadLabel: "Packing List" },
  { internal: "SUPPLIER_BANK_DETAILS", uploadLabel: "Supplier Bank Details" },
  { internal: "PAYMENT_INSTRUCTION", uploadLabel: "Payment Instruction" },
  { internal: "OTHER", uploadLabel: "Other" },
];

const DOC_STATUS_LABEL = {
  NONE: "Not uploaded",
  PI_RECEIVED: "PI uploaded",
  INVOICE_RECEIVED: "Invoice uploaded",
  INVOICE_BOOKED: "Booked",
};

const PAY_STATUS_LABEL = {
  NOT_PAID: "Not paid",
  NONE: "Not paid",
  PAYMENT_PENDING: "Payment pending",
  PARTIALLY_PAID: "Partially paid",
  FULLY_PAID: "Fully paid",
  PAID: "Fully paid",
  ADVANCE_PAID: "Advance paid",
  ADVANCE_REVIEW: "Advance (review)",
};

const GRN_RECEIPT_LABEL = {
  NOT_RECEIVED: "Not received",
  PARTIALLY_RECEIVED: "Partially received",
  FULLY_RECEIVED: "Fully received",
};

const GRN_PROGRESS_FALLBACK = {
  NONE: "—",
  PARTIAL: "Partial (workflow)",
  COMPLETE: "Complete",
  IN_PROGRESS: "In progress",
};

export default function PoAccountsPanel({ detail, detailId, qc, setErr }) {
  const navigate = useNavigate();
  const [subModal, setSubModal] = useState(null);
  const [docPick, setDocPick] = useState(DOC_OPTIONS[0]);
  const [docMeta, setDocMeta] = useState({
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
  const [payForm, setPayForm] = useState({
    amountPaid: "",
    currency: "",
    paymentMode: "BANK_TRANSFER",
    bankCashAccountName: "",
    paymentReference: "",
    remarks: "",
    purchaseInvoiceId: "",
    allocatedAmount: "",
    exchangeRate: "1",
  });

  const apQ = useQuery({
    queryKey: ["po-ap-summary", detailId],
    queryFn: () => apiGet(`/purchase-orders/${detailId}/ap-summary`),
    enabled: Boolean(detailId && detail),
  });

  const docsQ = useQuery({
    queryKey: ["po-documents", detailId],
    queryFn: () => apiGet(`/purchase-orders/${detailId}/documents`),
    enabled: Boolean(detailId) && (subModal === "docs" || subModal === "uploadPi" || subModal === "uploadInv"),
  });

  const ledgerQ = useQuery({
    queryKey: ["supplier-ledger-modal", detail?.supplierId],
    queryFn: () => apiGet(`/supplier-ledger/${detail.supplierId}`),
    enabled: Boolean(subModal === "ledger" && detail?.supplierId),
  });

  const ledgerByNameQ = useQuery({
    queryKey: ["supplier-ledger-name", detail?.supplierName],
    queryFn: () =>
      apiGetWithQuery("/accounts/supplier-ledger", {
        supplierName: detail.supplierName,
        page: 1,
        limit: 100,
      }),
    enabled: Boolean(subModal === "ledger" && !detail?.supplierId && detail?.supplierName),
  });

  const addDoc = useMutation({
    mutationFn: async () => {
      if (!docMeta.file) throw new Error("Choose a file");
      const fd = new FormData();
      fd.append("file", docMeta.file);
      fd.append("documentType", docPick.uploadLabel);
      fd.append("moduleName", "PURCHASE");
      fd.append("relatedId", String(detailId));
      fd.append("refNo", detail?.poNumber || "");
      fd.append("partyName", detail?.supplierName || "");
      const uploaded = await apiPostFormData("/documents/upload", fd);
      return apiPost(`/purchase-orders/${detailId}/documents`, {
        documentType: docPick.internal,
        documentNo: docMeta.documentNo,
        amount: Number(docMeta.amount) || 0,
        currency: (docMeta.currency || detail?.currency || "USD").toUpperCase(),
        remarks: docMeta.remarks,
        documentId: uploaded._id,
        fileUrl: uploaded.fileUrl,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-ap-summary", detailId] });
      qc.invalidateQueries({ queryKey: ["po-documents", detailId] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      setSubModal(null);
      setDocMeta({ documentNo: "", amount: "", currency: "", remarks: "", file: null });
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const createInvDraft = useMutation({
    mutationFn: () =>
      apiPost(`/purchase-invoices/from-po/${detailId}`, {
        supplierInvoiceNo: invDraft.supplierInvoiceNo.trim(),
        taxAmount: Number(invDraft.taxAmount) || 0,
        otherCharges: Number(invDraft.otherCharges) || 0,
        remarks: invDraft.remarks,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-ap-summary", detailId] });
      qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      setSubModal(null);
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const bookInv = useMutation({
    mutationFn: (id) => apiPost(`/purchase-invoices/${id}/book`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-ap-summary", detailId] });
      qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      qc.invalidateQueries({ queryKey: ["supplierOutstanding"] });
      qc.invalidateQueries({ queryKey: ["apAging"] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const createPay = useMutation({
    mutationFn: () => {
      const amountPaid = Number(payForm.amountPaid);
      if (!(amountPaid > 0)) throw new Error("amountPaid required");
      const body = {
        supplierName: detail.supplierName,
        amountPaid,
        currency: (payForm.currency || detail.currency || "USD").toUpperCase(),
        paymentMode: payForm.paymentMode,
        bankCashAccountName: payForm.bankCashAccountName,
        paymentReference: payForm.paymentReference,
        remarks: payForm.remarks,
        linkedPoNo: String(detail.poNumber || detail.poNo || "").trim(),
        exchangeRate: Number(payForm.exchangeRate) || 1,
        allocations: [],
      };
      if (payForm.purchaseInvoiceId && Number(payForm.allocatedAmount) > 0) {
        body.allocations = [
          {
            purchaseInvoiceId: payForm.purchaseInvoiceId,
            allocatedAmount: Number(payForm.allocatedAmount),
          },
        ];
      }
      return apiPost("/supplier-payments", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["po-ap-summary", detailId] });
      qc.invalidateQueries({ queryKey: ["supplierPayments"] });
      qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      qc.invalidateQueries({ queryKey: ["supplierOutstanding"] });
      qc.invalidateQueries({ queryKey: ["apAging"] });
      qc.invalidateQueries({ queryKey: ["cashBank"] });
      qc.invalidateQueries({ queryKey: ["apDashboard"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      setSubModal(null);
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const openGrn = () => {
    const warn = apQ.data?.grnPaymentWarning;
    if (warn && !window.confirm(warn)) return;
    navigate(`/store?tab=GRN&grnPoId=${encodeURIComponent(detailId)}`);
  };

  if (!detail || !detailId) return null;

  const ext = apQ.data?.po || {};
  const flags = apQ.data?.flags || {};

  return (
    <>
      <details className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 text-xs text-gray-800">
        <summary className="cursor-pointer select-none font-semibold text-indigo-950">
          Accounts & supplier documents (AP)
        </summary>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] sm:text-xs">
          <span className="rounded bg-white px-2 py-1 ring-1 ring-indigo-100">
            Invoice: <b>{DOC_STATUS_LABEL[ext.supplierDocumentStatus] || ext.supplierDocumentStatus || "—"}</b>
          </span>
          <span className="rounded bg-white px-2 py-1 ring-1 ring-indigo-100">
            Pay: <b>{PAY_STATUS_LABEL[ext.apPaymentStatus] || ext.apPaymentStatus || "—"}</b>
          </span>
          <span className="rounded bg-white px-2 py-1 ring-1 ring-indigo-100">
            GRN:{" "}
            <b>
              {GRN_RECEIPT_LABEL[ext.grnReceiptStatus] ||
                GRN_PROGRESS_FALLBACK[ext.grnProgressStatus] ||
                ext.grnProgressStatus ||
                "—"}
            </b>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => setSubModal("docs")}
          >
            View supplier documents
          </button>
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => {
              setDocPick(DOC_OPTIONS[0]);
              setSubModal("uploadPi");
            }}
          >
            Upload supplier PI
          </button>
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => {
              setDocPick(DOC_OPTIONS[1]);
              setSubModal("uploadInv");
            }}
          >
            Upload supplier invoice
          </button>
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => setSubModal("payStatus")}
          >
            Payment status
          </button>
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => setSubModal("ledger")}
          >
            Supplier ledger
          </button>
          <button
            type="button"
            className="rounded border border-indigo-200 bg-white px-3 py-1.5 font-medium text-indigo-900 hover:bg-indigo-50"
            onClick={() => {
              setPayForm((f) => ({
                ...f,
                currency: detail.currency || "USD",
                purchaseInvoiceId: (apQ.data?.purchaseInvoices || []).find((x) => x.status === "POSTED")?._id || "",
                allocatedAmount: "",
              }));
              setSubModal("payment");
            }}
          >
            Create supplier payment
          </button>
          <button
            type="button"
            className="rounded border border-emerald-700 bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
            onClick={openGrn}
          >
            Create GRN (Store)
          </button>
        </div>
      </details>

      <Modal open={subModal === "docs"} onClose={() => setSubModal(null)} title="Supplier documents on PO" wide>
        <div className="max-h-80 space-y-2 overflow-y-auto text-sm">
          {(docsQ.data?.items || []).length === 0 ? (
            <p className="text-gray-500">No documents uploaded yet.</p>
          ) : (
            (docsQ.data?.items || []).map((d) => (
              <div key={d._id} className="flex flex-wrap justify-between gap-2 rounded border border-gray-100 p-2">
                <div>
                  <div className="font-mono text-xs font-semibold">{d.documentType}</div>
                  <div className="text-xs text-gray-600">{d.documentNo || "—"}</div>
                </div>
                <div className="text-right text-xs">
                  {d.fileUrl ? (
                    <a className="text-blue-700 underline" href={d.fileUrl} target="_blank" rel="noreferrer">
                      File
                    </a>
                  ) : (
                    "—"
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        open={subModal === "uploadPi" || subModal === "uploadInv"}
        onClose={() => setSubModal(null)}
        title={subModal === "uploadPi" ? "Upload supplier PI" : "Upload supplier invoice file"}
        wide
      >
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs font-semibold text-gray-600">Document type</span>
            <select
              className="mt-1 w-full rounded border px-2 py-1"
              value={docPick.internal}
              onChange={(e) => setDocPick(DOC_OPTIONS.find((x) => x.internal === e.target.value) || DOC_OPTIONS[0])}
            >
              {DOC_OPTIONS.map((o) => (
                <option key={o.internal} value={o.internal}>
                  {o.uploadLabel}
                </option>
              ))}
            </select>
          </label>
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx"
            onChange={(e) => setDocMeta((m) => ({ ...m, file: e.target.files?.[0] || null }))}
          />
          <input
            className="w-full rounded border px-2 py-1 text-sm"
            placeholder="Document no"
            value={docMeta.documentNo}
            onChange={(e) => setDocMeta((m) => ({ ...m, documentNo: e.target.value }))}
          />
          <div className="flex gap-2">
            <input
              className="w-1/2 rounded border px-2 py-1 text-sm"
              placeholder="Amount"
              value={docMeta.amount}
              onChange={(e) => setDocMeta((m) => ({ ...m, amount: e.target.value }))}
            />
            <input
              className="w-1/2 rounded border px-2 py-1 text-sm"
              placeholder="Currency"
              value={docMeta.currency || detail.currency}
              onChange={(e) => setDocMeta((m) => ({ ...m, currency: e.target.value }))}
            />
          </div>
          <textarea
            className="w-full rounded border px-2 py-1 text-sm"
            rows={2}
            placeholder="Remarks"
            value={docMeta.remarks}
            onChange={(e) => setDocMeta((m) => ({ ...m, remarks: e.target.value }))}
          />
          <button
            type="button"
            className="rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={addDoc.isPending}
            onClick={() => addDoc.mutate()}
          >
            Upload & attach to PO
          </button>
          {subModal === "uploadInv" ? (
            <div className="border-t pt-3">
              <p className="mb-2 text-xs font-semibold text-gray-700">Create purchase invoice draft (Accounts)</p>
              <input
                className="mb-2 w-full rounded border px-2 py-1 text-sm"
                placeholder="Supplier invoice no *"
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
              <button
                type="button"
                className="mt-2 rounded border border-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-900"
                disabled={createInvDraft.isPending}
                onClick={() => createInvDraft.mutate()}
              >
                Create draft purchase invoice
              </button>
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal open={subModal === "payStatus"} onClose={() => setSubModal(null)} title="Payment status" wide>
        <div className="space-y-2 text-sm">
          <div className="text-xs text-gray-600">Supplier PI uploaded: {flags.hasSupplierPi ? "Yes" : "No"}</div>
          <div className="text-xs text-gray-600">Supplier invoice document: {flags.hasSupplierInvoiceDocument ? "Yes" : "No"}</div>
          <div className="text-xs text-gray-600">
            Booked invoice has balance (optional GRN reminder): {flags.paymentPending ? "Yes" : "No"}
          </div>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-2 py-1">Internal no</th>
                <th className="px-2 py-1">Supplier inv</th>
                <th className="px-2 py-1">Status</th>
                <th className="px-2 py-1 text-right">Balance</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {(apQ.data?.purchaseInvoices || []).map((inv) => (
                <tr key={inv._id} className="border-t">
                  <td className="px-2 py-1 font-mono">{inv.invoiceNumber}</td>
                  <td className="px-2 py-1">{inv.supplierInvoiceNo || "—"}</td>
                  <td className="px-2 py-1">{inv.status}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{Number(inv.balanceAmount || 0).toFixed(2)}</td>
                  <td className="px-2 py-1">
                    {inv.status === "DRAFT" ? (
                      <button
                        type="button"
                        className="text-blue-700 underline"
                        onClick={() => bookInv.mutate(inv._id)}
                      >
                        Book
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      <Modal open={subModal === "ledger"} onClose={() => setSubModal(null)} title="Supplier ledger" wide>
        {!detail.supplierId ? (
          <p className="text-xs text-gray-600">This PO has no linked supplier id; showing ledger by supplier name.</p>
        ) : null}
        <div className="max-h-80 overflow-y-auto text-xs">
          {(ledgerQ.data?.items || ledgerByNameQ.data?.items || []).map((r) => (
            <div key={r._id} className="border-b py-1">
              <span className="font-mono">{r.referenceType}</span> {r.referenceNumber} · Dr {Number(r.debit || 0).toFixed(2)}{" "}
              Cr {Number(r.credit || 0).toFixed(2)} · Bal {Number(r.runningBalance ?? 0).toFixed(2)}
            </div>
          ))}
        </div>
      </Modal>

      <Modal open={subModal === "payment"} onClose={() => setSubModal(null)} title="Create supplier payment" wide>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="text-xs text-gray-600">Amount paid *</span>
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.amountPaid}
              onChange={(e) => setPayForm((f) => ({ ...f, amountPaid: e.target.value }))}
            />
          </label>
          <label>
            <span className="text-xs text-gray-600">Currency</span>
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.currency}
              onChange={(e) => setPayForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </label>
          <label>
            <span className="text-xs text-gray-600">Exchange rate (if currency differs from invoice)</span>
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.exchangeRate}
              onChange={(e) => setPayForm((f) => ({ ...f, exchangeRate: e.target.value }))}
            />
          </label>
          <label className="sm:col-span-2">
            <span className="text-xs text-gray-600">Allocate to purchase invoice (optional)</span>
            <select
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.purchaseInvoiceId}
              onChange={(e) => setPayForm((f) => ({ ...f, purchaseInvoiceId: e.target.value }))}
            >
              <option value="">— Advance / unallocated —</option>
              {(apQ.data?.purchaseInvoices || [])
                .filter((x) => x.status === "POSTED" && Number(x.balanceAmount) > 0)
                .map((inv) => (
                  <option key={inv._id} value={inv._id}>
                    {inv.invoiceNumber} (bal {Number(inv.balanceAmount).toFixed(2)})
                  </option>
                ))}
            </select>
          </label>
          {payForm.purchaseInvoiceId ? (
            <label className="sm:col-span-2">
              <span className="text-xs text-gray-600">Allocated amount</span>
              <input
                className="mt-1 w-full rounded border px-2 py-1"
                value={payForm.allocatedAmount}
                onChange={(e) => setPayForm((f) => ({ ...f, allocatedAmount: e.target.value }))}
              />
            </label>
          ) : null}
          <label className="sm:col-span-2">
            <span className="text-xs text-gray-600">Bank / cash account name</span>
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.bankCashAccountName}
              onChange={(e) => setPayForm((f) => ({ ...f, bankCashAccountName: e.target.value }))}
            />
          </label>
          <label className="sm:col-span-2">
            <span className="text-xs text-gray-600">Payment reference / UTR / SWIFT</span>
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              value={payForm.paymentReference}
              onChange={(e) => setPayForm((f) => ({ ...f, paymentReference: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="mt-4 rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={createPay.isPending}
          onClick={() => createPay.mutate()}
        >
          Post payment
        </button>
      </Modal>
    </>
  );
}
