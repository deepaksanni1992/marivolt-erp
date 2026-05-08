import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import CustomerLedgerTab from "../components/accounts/CustomerLedgerTab.jsx";
import CustomerStatementTab from "../components/accounts/CustomerStatementTab.jsx";
import OutstandingReportTab from "../components/accounts/OutstandingReportTab.jsx";
import AgingReportTab from "../components/accounts/AgingReportTab.jsx";
import CashBankLedgerTab from "../components/accounts/CashBankLedgerTab.jsx";
import JournalEntriesTab from "../components/accounts/JournalEntriesTab.jsx";
import PaymentReceiptsTab from "../components/accounts/PaymentReceiptsTab.jsx";
import PaymentReceiptView from "../components/accounts/PaymentReceiptView.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiDelete, apiGet, apiGetWithQuery, apiPatch, apiPost, apiPut } from "../lib/api.js";

function canManageBankDetails(role) {
  const r = String(role || "").toLowerCase().trim();
  return ["super_admin", "company_admin", "admin"].includes(r);
}

function emptyBankForm() {
  return {
    bankName: "",
    accountName: "",
    accountNumber: "",
    currency: "USD",
    branchName: "",
    swiftCode: "",
    iban: "",
    bankAddress: "",
    correspondentBankName: "",
    correspondentSwiftCode: "",
    beneficiaryName: "",
    beneficiaryAddress: "",
    purposeOfPayment: "",
    isDefault: false,
    remarks: "",
  };
}

function bankRowToForm(r) {
  return {
    bankName: r.bankName ?? "",
    accountName: r.accountName ?? "",
    accountNumber: r.accountNumber ?? "",
    currency: r.currency ?? "USD",
    branchName: r.branchName ?? "",
    swiftCode: r.swiftCode ?? "",
    iban: r.iban ?? "",
    bankAddress: r.bankAddress ?? "",
    correspondentBankName: r.correspondentBankName ?? "",
    correspondentSwiftCode: r.correspondentSwiftCode ?? "",
    beneficiaryName: r.beneficiaryName ?? "",
    beneficiaryAddress: r.beneficiaryAddress ?? "",
    purposeOfPayment: r.purposeOfPayment ?? "",
    isDefault: !!r.isDefault,
    remarks: r.remarks ?? "",
  };
}

function truncateBankAddressCell(s, max = 56) {
  const t = String(s ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .trim();
  if (!t) return "—";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const tabs = [
  { id: "ar", label: "AR Dashboard" },
  { id: "ap", label: "AP Dashboard" },
  { id: "cust", label: "Customer Ledger" },
  { id: "statement", label: "Customer Statement" },
  { id: "supp", label: "Supplier Ledger" },
  { id: "payrcpt", label: "Payment Receipts" },
  { id: "payv", label: "Payment Vouchers" },
  { id: "si", label: "Sales Invoices" },
  { id: "pi", label: "Purchase Invoices" },
  { id: "cash", label: "Cash / Bank Ledger" },
  { id: "journal", label: "Journal Entries" },
  { id: "outstanding", label: "Outstanding Report" },
  { id: "aging", label: "Aging Report" },
  { id: "alloc", label: "Allocation / Reconciliation" },
  { id: "reports", label: "Reports" },
  { id: "sd", label: "Sales Dispatches" },
  { id: "bank", label: "Bank Details" },
];

const invLine = () => ({
  itemCode: "",
  description: "",
  qty: 1,
  rate: 0,
});

export default function Accounts() {
  const { auth } = useAuth();
  const bankDetailsAdmin = canManageBankDetails(auth?.user?.role);
  const qc = useQueryClient();
  const [tab, setTab] = useState("si");
  const [page, setPage] = useState(1);
  const limit = 25;
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null);
  const [receiptView, setReceiptView] = useState({ open: false, item: null });

  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [payRcptFilters, setPayRcptFilters] = useState({
    customerName: "",
    referenceNo: "",
    proformaNo: "",
    invoiceNo: "",
    status: "",
    paymentMode: "",
    bankCashAccountName: "",
    fromDate: "",
    toDate: "",
  });
  const [statementFilters, setStatementFilters] = useState({
    customerName: "",
    fromDate: "",
    toDate: "",
    currency: "",
  });

  const [siForm, setSiForm] = useState({
    customerName: "",
    linkedQuotationNumber: "",
    currency: "USD",
    taxAmount: 0,
    paymentStatus: "UNPAID",
    remarks: "",
    lines: [invLine()],
  });
  const [piForm, setPiForm] = useState({
    supplierName: "",
    linkedPoNumber: "",
    currency: "USD",
    taxAmount: 0,
    paymentStatus: "UNPAID",
    remarks: "",
    lines: [invLine()],
  });
  const [custForm, setCustForm] = useState({
    customerName: "",
    referenceType: "",
    referenceNumber: "",
    debit: 0,
    credit: 0,
    narrative: "",
  });
  const [suppForm, setSuppForm] = useState({
    supplierName: "",
    referenceType: "",
    referenceNumber: "",
    debit: 0,
    credit: 0,
    narrative: "",
  });
  const [cashForm, setCashForm] = useState({
    accountName: "Cash",
    transactionType: "RECEIPT",
    referenceNumber: "",
    partyName: "",
    amount: 0,
    mode: "",
    remarks: "",
  });
  const [bankForm, setBankForm] = useState(() => emptyBankForm());
  const [bankEditId, setBankEditId] = useState(null);

  const siQ = useQuery({
    queryKey: ["salesInvoices", page],
    queryFn: () => apiGetWithQuery("/accounts/sales-invoices", { page, limit }),
    enabled: tab === "si",
  });
  const sdQ = useQuery({
    queryKey: ["accountsSalesDispatches", page],
    queryFn: () => apiGetWithQuery("/accounts/sales-dispatches", { page, limit }),
    enabled: tab === "sd",
  });
  const piQ = useQuery({
    queryKey: ["purchaseInvoices", page],
    queryFn: () => apiGetWithQuery("/accounts/purchase-invoices", { page, limit }),
    enabled: tab === "pi",
  });
  const custQ = useQuery({
    queryKey: ["customerLedger", filterCustomer, page],
    queryFn: () =>
      apiGetWithQuery("/accounts/customer-ledger", {
        customerName: filterCustomer.trim(),
        page,
        limit,
      }),
    enabled: tab === "cust" && filterCustomer.trim().length > 0,
  });
  const statementQ = useQuery({
    queryKey: ["customerStatement", statementFilters],
    queryFn: () =>
      apiGetWithQuery("/accounts/customer-statement", {
        customerName: statementFilters.customerName.trim(),
        fromDate: statementFilters.fromDate || undefined,
        toDate: statementFilters.toDate || undefined,
        currency: statementFilters.currency || undefined,
      }),
    enabled: tab === "statement" && statementFilters.customerName.trim().length > 0,
  });
  const suppQ = useQuery({
    queryKey: ["supplierLedger", filterSupplier, page],
    queryFn: () =>
      apiGetWithQuery("/accounts/supplier-ledger", {
        supplierName: filterSupplier.trim(),
        page,
        limit,
      }),
    enabled: tab === "supp" && filterSupplier.trim().length > 0,
  });
  const cashQ = useQuery({
    queryKey: ["cashBank", page],
    queryFn: () => apiGetWithQuery("/accounts/cash-bank", { page, limit }),
    enabled: tab === "cash",
  });
  const bankQ = useQuery({
    queryKey: ["bankDetails", page],
    queryFn: () => apiGetWithQuery("/accounts/bank-details", { page, limit }),
    enabled: tab === "bank",
  });
  const payRcptQ = useQuery({
    queryKey: ["paymentReceipts", page, payRcptFilters],
    queryFn: () => apiGetWithQuery("/payment-receipts", { page, limit, ...payRcptFilters }),
    enabled: tab === "payrcpt",
  });
  const outstandingQ = useQuery({
    queryKey: ["accountsOutstanding", payRcptFilters.customerName, payRcptFilters.fromDate, payRcptFilters.toDate],
    queryFn: () =>
      apiGetWithQuery("/accounts/outstanding", {
        customerName: payRcptFilters.customerName,
        fromDate: payRcptFilters.fromDate,
        toDate: payRcptFilters.toDate,
      }),
    enabled: tab === "outstanding",
  });
  const agingQ = useQuery({
    queryKey: ["accountsAging"],
    queryFn: () => apiGet("/accounts/aging"),
    enabled: tab === "aging",
  });
  const journalQ = useQuery({
    queryKey: ["accountsJournals", page],
    queryFn: () => apiGetWithQuery("/accounts/journal-entries", { page, limit }),
    enabled: tab === "journal",
  });

  const postMut = useMutation({
    mutationFn: ({ path, body }) => apiPost(path, body),
    onSuccess: (_, v) => {
      if (v.path.includes("sales-invoices")) qc.invalidateQueries({ queryKey: ["salesInvoices"] });
      if (v.path.includes("purchase-invoices"))
        qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      if (v.path.includes("customer-ledger"))
        qc.invalidateQueries({ queryKey: ["customerLedger"] });
      if (v.path.includes("supplier-ledger"))
        qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      if (v.path.includes("cash-bank")) qc.invalidateQueries({ queryKey: ["cashBank"] });
      if (v.path.includes("bank-details")) {
        qc.invalidateQueries({ queryKey: ["bankDetails"] });
        setBankEditId(null);
        setBankForm(emptyBankForm());
      }
      setModal(null);
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const patchMut = useMutation({
    mutationFn: ({ path, body }) => apiPatch(path, body),
    onSuccess: (_, v) => {
      if (String(v.path || "").includes("sales-dispatches")) {
        qc.invalidateQueries({ queryKey: ["accountsSalesDispatches"] });
        qc.invalidateQueries({ queryKey: ["sales-sales-dispatch"] });
        qc.invalidateQueries({ queryKey: ["sales-dispatch-detail"] });
        qc.invalidateQueries({ queryKey: ["customerLedger"] });
      }
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const putMut = useMutation({
    mutationFn: ({ path, body }) => apiPut(path, body),
    onSuccess: (_, v) => {
      if (v.path.includes("bank-details")) {
        qc.invalidateQueries({ queryKey: ["bankDetails"] });
        setBankEditId(null);
        setBankForm(emptyBankForm());
      }
      setModal(null);
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const delMut = useMutation({
    mutationFn: ({ path }) => apiDelete(path),
    onSuccess: (_, v) => {
      if (v.path.includes("sales-invoices")) qc.invalidateQueries({ queryKey: ["salesInvoices"] });
      if (v.path.includes("purchase-invoices"))
        qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      if (v.path.includes("customer-ledger"))
        qc.invalidateQueries({ queryKey: ["customerLedger"] });
      if (v.path.includes("supplier-ledger"))
        qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      if (v.path.includes("cash-bank")) qc.invalidateQueries({ queryKey: ["cashBank"] });
      if (v.path.includes("bank-details")) qc.invalidateQueries({ queryKey: ["bankDetails"] });
    },
  });

  function activeRows() {
    if (tab === "si") return siQ.data?.items ?? [];
    if (tab === "sd") return sdQ.data?.items ?? [];
    if (tab === "pi") return piQ.data?.items ?? [];
    if (tab === "cust") return custQ.data?.items ?? [];
    if (tab === "statement") return statementQ.data?.items ?? [];
    if (tab === "supp") return suppQ.data?.items ?? [];
    if (tab === "cash") return cashQ.data?.items ?? [];
    if (tab === "bank") return bankQ.data?.items ?? [];
    if (tab === "payrcpt") return payRcptQ.data?.items ?? [];
    if (tab === "outstanding") return outstandingQ.data?.items ?? [];
    if (tab === "aging") return agingQ.data?.items ?? [];
    if (tab === "journal") return journalQ.data?.items ?? [];
    return [];
  }

  function activeTotal() {
    if (tab === "si") return siQ.data?.total ?? 0;
    if (tab === "sd") return sdQ.data?.total ?? 0;
    if (tab === "pi") return piQ.data?.total ?? 0;
    if (tab === "cust") return custQ.data?.total ?? 0;
    if (tab === "statement") return statementQ.data?.items?.length ?? 0;
    if (tab === "supp") return suppQ.data?.total ?? 0;
    if (tab === "cash") return cashQ.data?.total ?? 0;
    if (tab === "bank") return bankQ.data?.total ?? 0;
    if (tab === "payrcpt") return payRcptQ.data?.total ?? 0;
    if (tab === "outstanding") return outstandingQ.data?.items?.length ?? 0;
    if (tab === "aging") return agingQ.data?.items?.length ?? 0;
    if (tab === "journal") return journalQ.data?.total ?? 0;
    return 0;
  }

  function loading() {
    if (tab === "si") return siQ.isLoading;
    if (tab === "sd") return sdQ.isLoading;
    if (tab === "pi") return piQ.isLoading;
    if (tab === "cust") return custQ.isLoading;
    if (tab === "statement") return statementQ.isLoading;
    if (tab === "supp") return suppQ.isLoading;
    if (tab === "cash") return cashQ.isLoading;
    if (tab === "bank") return bankQ.isLoading;
    if (tab === "payrcpt") return payRcptQ.isLoading;
    if (tab === "outstanding") return outstandingQ.isLoading;
    if (tab === "aging") return agingQ.isLoading;
    if (tab === "journal") return journalQ.isLoading;
    return false;
  }

  async function openPaymentReceiptSlip(receiptId, inline = true) {
    try {
      const path = inline
        ? `/payment-receipts/${receiptId}/attachment-url?inline=1`
        : `/payment-receipts/${receiptId}/attachment-url`;
      const data = await apiGet(path);
      if (!data?.url) throw new Error("No signed URL returned");
      const a = document.createElement("a");
      a.href = data.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      setErr(e.message || "Could not open payment slip");
    }
  }

  async function openPaymentReceiptPrint(receiptId) {
    try {
      const data = await apiGet(`/payment-receipts/${receiptId}/print`);
      const r = data?.receipt || {};
      const html = `
        <html><head><title>${r.receiptNo || "Payment Receipt"}</title></head>
        <body style="font-family:Arial;padding:24px">
          <h2 style="margin:0 0 16px 0">PAYMENT RECEIPT</h2>
          <div><b>Receipt No:</b> ${r.receiptNo || "-"}</div>
          <div><b>Receipt Date:</b> ${r.receiptDate ? new Date(r.receiptDate).toLocaleDateString() : "-"}</div>
          <div><b>Customer:</b> ${r.customerName || "-"}</div>
          <div><b>Currency:</b> ${r.currency || "-"}</div>
          <div><b>Amount:</b> ${Number(r.amountReceived || 0).toFixed(2)}</div>
          <div><b>Allocated:</b> ${Number(r.allocatedAmount || 0).toFixed(2)}</div>
          <div><b>Unallocated:</b> ${Number(r.unallocatedAmount || 0).toFixed(2)}</div>
          <div><b>Mode:</b> ${(r.paymentMode || "").replaceAll("_", " ")}</div>
          <div><b>Bank/Cash Account:</b> ${r.bankCashAccountName || r.accountName || "-"}</div>
          <div><b>Reference:</b> ${r.paymentReference || "-"}</div>
          <div><b>Status:</b> ${r.status || "-"}</div>
          <div style="margin-top:12px"><b>Remarks:</b> ${r.remarks || "-"}</div>
        </body></html>`;
      const w = window.open("", "_blank");
      if (!w) return;
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
    } catch (e) {
      setErr(e.message || "Could not open print");
    }
  }

  function openJournalEntry(journalEntryId) {
    if (!journalEntryId) return;
    setTab("journal");
    setPage(1);
  }

  function exportPaymentReceiptsCsv(rows = []) {
    if (!rows || !rows.length) {
      setErr("No rows to export.");
      return;
    }
    const csvSafe = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "Receipt No", "Date", "Customer",
      "Proforma No", "Sales Invoice No",
      "Currency", "Amount Received", "Allocated", "Unallocated",
      "Mode", "Bank/Cash Account", "Reference", "Status", "Has Attachment",
    ];
    const lines = [header.map(csvSafe).join(",")];
    for (const r of rows) {
      lines.push([
        r.receiptNo || "",
        r.receiptDate ? new Date(r.receiptDate).toISOString().slice(0, 10) : "",
        r.customerName || "",
        r.proformaInvoiceNo || "",
        r.salesInvoiceNo || "",
        r.currency || "",
        Number(r.amountReceived || 0).toFixed(2),
        Number(r.allocatedAmount || 0).toFixed(2),
        Number(r.unallocatedAmount || 0).toFixed(2),
        String(r.paymentMode || "").replaceAll("_", " "),
        r.bankCashAccountName || r.accountName || "",
        r.paymentReference || "",
        r.status || "",
        r.attachmentKey ? "yes" : "no",
      ].map(csvSafe).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payment-receipts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCustomerStatementCsv(rows = activeRows()) {
    if (!rows || !rows.length) {
      setErr("No statement rows to export.");
      return;
    }
    const csvSafe = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Date", "Document No", "Movement Type", "Debit", "Credit", "Running Balance", "Currency", "Remarks"];
    const lines = [header.map(csvSafe).join(",")];
    for (const r of rows) {
      lines.push([
        r.transactionDate ? new Date(r.transactionDate).toISOString().slice(0, 10) : "",
        r.documentNo || "",
        r.movementType || "",
        Number(r.debitAmount || 0).toFixed(2),
        Number(r.creditAmount || 0).toFixed(2),
        Number(r.runningBalance || 0).toFixed(2),
        r.currency || "",
        r.remarks || "",
      ].map(csvSafe).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-statement-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function printCustomerStatement(rows = activeRows()) {
    const customer = statementFilters.customerName || "Customer";
    const htmlRows = rows
      .map(
        (r) => `<tr>
          <td>${r.transactionDate ? new Date(r.transactionDate).toLocaleDateString() : ""}</td>
          <td>${r.documentNo || ""}</td>
          <td>${String(r.movementType || "").replaceAll("_", " ")}</td>
          <td style="text-align:right">${Number(r.debitAmount || 0).toFixed(2)}</td>
          <td style="text-align:right">${Number(r.creditAmount || 0).toFixed(2)}</td>
          <td style="text-align:right">${Number(r.runningBalance || 0).toFixed(2)}</td>
          <td>${r.remarks || ""}</td>
        </tr>`
      )
      .join("");
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`
      <html><head><title>Customer Statement</title></head>
      <body style="font-family:Arial;padding:24px">
        <h2 style="margin:0 0 8px 0">Customer Statement</h2>
        <div><b>Customer:</b> ${customer}</div>
        <div><b>Currency:</b> ${statementFilters.currency || statementQ.data?.currency || "All"}</div>
        <div><b>Period:</b> ${statementFilters.fromDate || "Start"} to ${statementFilters.toDate || "Today"}</div>
        <table width="100%" cellspacing="0" cellpadding="6" border="1" style="margin-top:16px;border-collapse:collapse;font-size:12px">
          <thead><tr><th>Date</th><th>Document No</th><th>Movement</th><th>Debit</th><th>Credit</th><th>Balance</th><th>Remarks</th></tr></thead>
          <tbody>${htmlRows}</tbody>
        </table>
      </body></html>
    `);
    w.document.close();
    w.focus();
    w.print();
  }

  const cancelPaymentReceiptMut = useMutation({
    mutationFn: ({ id, reason }) => apiPatch(`/payment-receipts/${id}/cancel`, { cancellationReason: reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paymentReceipts"] });
      qc.invalidateQueries({ queryKey: ["accountsJournals"] });
      qc.invalidateQueries({ queryKey: ["cashBank"] });
      qc.invalidateQueries({ queryKey: ["customerLedger"] });
    },
    onError: (e) => setErr(e.message),
  });

  const total = activeTotal();
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Invoices, sales dispatches (ship / close vs payment), AR/AP ledgers, and cash or bank movements."
      />

      {err ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setPage(1);
            }}
            className={[
              "rounded-xl px-3 py-2 text-sm font-medium",
              tab === t.id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "bank" && !bankDetailsAdmin ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Bank details are read-only for your role. Only company admins can add or remove bank accounts.
        </div>
      ) : null}

      {(tab === "cust" || tab === "supp") && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4">
          {tab === "cust" ? (
            <FormField label="Customer name (exact)" className="min-w-[220px] flex-1">
              <TextInput
                value={filterCustomer}
                onChange={(e) => setFilterCustomer(e.target.value)}
                placeholder="Required to load ledger"
              />
            </FormField>
          ) : (
            <FormField label="Supplier name (exact)" className="min-w-[220px] flex-1">
              <TextInput
                value={filterSupplier}
                onChange={(e) => setFilterSupplier(e.target.value)}
                placeholder="Required to load ledger"
              />
            </FormField>
          )}
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
            onClick={() => {
              setPage(1);
              if (tab === "cust") qc.invalidateQueries({ queryKey: ["customerLedger"] });
              else qc.invalidateQueries({ queryKey: ["supplierLedger"] });
            }}
          >
            Load
          </button>
        </div>
      )}

      {(tab !== "bank" || bankDetailsAdmin) && tab !== "sd" && tab !== "payrcpt" && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
            onClick={() => {
              setErr("");
              if (tab === "bank") {
                setBankEditId(null);
                setBankForm(emptyBankForm());
              }
              setModal(tab);
            }}
          >
            {tab === "si" && "New sales invoice"}
            {tab === "pi" && "New purchase invoice"}
            {tab === "cust" && "New customer entry"}
            {tab === "supp" && "New supplier entry"}
            {tab === "cash" && "New cash / bank entry"}
            {tab === "bank" && "New bank detail"}
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          {tab === "si" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo || r.invoiceNumber || "—"}</td>
                      <td className="px-3 py-2">{r.customerName}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{r.paymentStatus || r.status || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.currency || "USD"}{" "}
                        {Number(r.grandTotal ?? r.totalAmount ?? 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete invoice?"))
                              delMut.mutate({ path: `/accounts/sales-invoices/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "sd" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Dispatch</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Inv. status</th>
                  <th className="px-3 py-2">Disp. status</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => {
                    const invSt = r.linkedInvoice?.status || "—";
                    const canShip = String(r.status || "").toUpperCase() === "DRAFT";
                    const canClose =
                      String(r.status || "").toUpperCase() === "DISPATCHED" &&
                      String(invSt || "").toUpperCase() === "PAID";
                    return (
                      <tr key={r._id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs">{r.dispatchNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.linkedSalesInvoiceNo || "—"}</td>
                        <td className="px-3 py-2 text-xs">{invSt}</td>
                        <td className="px-3 py-2 text-xs">{r.status}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.currency || "USD"} {Number(r.grandTotal || 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {canShip ? (
                              <button
                                type="button"
                                className="rounded-lg border px-2 py-1 text-xs"
                                disabled={patchMut.isPending}
                                onClick={() =>
                                  patchMut.mutate({
                                    path: `/sales/sales-dispatches/${r._id}`,
                                    body: { status: "DISPATCHED" },
                                  })
                                }
                              >
                                Mark shipped
                              </button>
                            ) : null}
                            {canClose ? (
                              <button
                                type="button"
                                className="rounded-lg border px-2 py-1 text-xs"
                                disabled={patchMut.isPending}
                                onClick={() => {
                                  if (!window.confirm("Close this dispatch? The linked invoice must already be PAID.")) return;
                                  const postCredit = window.confirm(
                                    "Also post a customer ledger CREDIT for this dispatch total? (OK = yes, Cancel = no)"
                                  );
                                  patchMut.mutate({
                                    path: `/sales/sales-dispatches/${r._id}`,
                                    body: { status: "CLOSED", postCustomerLedgerCredit: postCredit },
                                  });
                                }}
                              >
                                Close (paid)
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
          {tab === "pi" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Supplier</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.invoiceNumber}</td>
                      <td className="px-3 py-2">{r.supplierName}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{r.paymentStatus}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.currency} {Number(r.totalAmount || 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete invoice?"))
                              delMut.mutate({ path: `/accounts/purchase-invoices/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "cust" && (
            <CustomerLedgerTab
              filterCustomer={filterCustomer}
              loading={loading()}
              rows={activeRows()}
              onDelete={(r) => {
                if (confirm("Delete entry?")) delMut.mutate({ path: `/accounts/customer-ledger/${r._id}` });
              }}
            />
          )}
          {tab === "statement" && (
            <CustomerStatementTab
              rows={activeRows()}
              loading={loading()}
              filters={statementFilters}
              setFilters={setStatementFilters}
              closingBalance={statementQ.data?.closingBalance || 0}
              onExportCsv={() => exportCustomerStatementCsv(activeRows())}
              onPrint={() => printCustomerStatement(activeRows())}
              onOpenInvoice={(id) => {
                if (!id) return;
                setTab("si");
                setPage(1);
              }}
              onOpenPayment={(id) => {
                if (!id) return;
                setTab("payrcpt");
                setPage(1);
              }}
              onPreviewAttachment={(id) => openPaymentReceiptSlip(id, true)}
            />
          )}
          {tab === "supp" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {!filterSupplier.trim() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Enter a supplier name and click Load.
                    </td>
                  </tr>
                ) : loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No entries.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-xs">
                        {r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.referenceNumber || r.narrative}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.debit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.credit}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {Number(r.runningBalance).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete entry?"))
                              delMut.mutate({ path: `/accounts/supplier-ledger/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "cash" && (
            <CashBankLedgerTab
              loading={loading()}
              rows={activeRows()}
              onDelete={(r) => {
                if (confirm("Delete entry?")) delMut.mutate({ path: `/accounts/cash-bank/${r._id}` });
              }}
            />
          )}
          {tab === "payrcpt" && (
            <PaymentReceiptsTab
              rows={activeRows()}
              loading={loading()}
              summary={payRcptQ.data?.summary || {}}
              filters={payRcptFilters}
              setFilters={setPayRcptFilters}
              onView={(r) => setReceiptView({ open: true, item: r })}
              onPrint={openPaymentReceiptPrint}
              onViewSlip={(id) => openPaymentReceiptSlip(id, true)}
              onDownloadSlip={(id) => openPaymentReceiptSlip(id, false)}
              onViewJournal={openJournalEntry}
              onExportCsv={() => exportPaymentReceiptsCsv(activeRows())}
              onCancel={(r) => {
                const reason = window.prompt("Cancel reason");
                if (!reason) return;
                cancelPaymentReceiptMut.mutate({ id: r._id, reason });
              }}
              isCancelPending={cancelPaymentReceiptMut.isPending}
            />
          )}
          {tab === "journal" && <JournalEntriesTab rows={activeRows() || []} />}
          {tab === "outstanding" && <OutstandingReportTab rows={activeRows() || []} />}
          {tab === "aging" && <AgingReportTab rows={activeRows() || []} />}
          {["ar", "ap", "payv", "alloc", "reports"].includes(tab) && (
            <div className="px-4 py-10 text-center text-sm text-gray-500">
              This tab structure is now ready. Detailed ERP widgets will be added in the next phase.
            </div>
          )}
          {tab === "bank" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Bank</th>
                  <th className="px-3 py-2 min-w-[140px] max-w-[220px]">Bank address</th>
                  <th className="px-3 py-2">Account name</th>
                  <th className="px-3 py-2">Account number</th>
                  <th className="px-3 py-2">Currency</th>
                  <th className="px-3 py-2">SWIFT</th>
                  <th className="px-3 py-2">Default</th>
                  {bankDetailsAdmin ? <th className="px-3 py-2 w-28">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={bankDetailsAdmin ? 8 : 7} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={bankDetailsAdmin ? 8 : 7} className="px-3 py-8 text-center text-gray-500">
                      No bank details.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2">{r.bankName}</td>
                      <td
                        className="px-3 py-2 max-w-[220px] align-top text-xs text-gray-700"
                        title={String(r.bankAddress || "").trim() || undefined}
                      >
                        {truncateBankAddressCell(r.bankAddress)}
                      </td>
                      <td className="px-3 py-2">{r.accountName}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.accountNumber}</td>
                      <td className="px-3 py-2">{r.currency}</td>
                      <td className="px-3 py-2">{r.swiftCode || "-"}</td>
                      <td className="px-3 py-2">{r.isDefault ? "Yes" : "No"}</td>
                      {bankDetailsAdmin ? (
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="text-xs font-medium text-gray-900 underline decoration-gray-400 underline-offset-2 hover:text-gray-700"
                              onClick={() => {
                                setErr("");
                                setBankEditId(r._id);
                                setBankForm(bankRowToForm(r));
                                setModal("bank");
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="text-xs text-red-600"
                              onClick={() => {
                                if (confirm("Delete bank detail?"))
                                  delMut.mutate({ path: `/accounts/bank-details/${r._id}` });
                              }}
                            >
                              Del
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        {tab !== "cust" && tab !== "supp" && tab !== "outstanding" && tab !== "aging" && !["ar", "ap", "payv", "alloc", "reports"].includes(tab) ? (
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
            <span>
              Page {page}/{totalPages} · {total} rows
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded-lg border px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : filterCustomer.trim() || filterSupplier.trim() ? (
          <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
            <span>
              Page {page}/{totalPages} · {total} rows
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded-lg border px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Modals */}
      <Modal open={modal === "si"} onClose={() => setModal(null)} title="Sales invoice" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer *">
            <TextInput
              value={siForm.customerName}
              onChange={(e) => setSiForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked quotation #">
            <TextInput
              value={siForm.linkedQuotationNumber}
              onChange={(e) =>
                setSiForm((f) => ({ ...f, linkedQuotationNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={siForm.currency}
              onChange={(e) => setSiForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Tax amount">
            <TextInput
              type="number"
              step="0.01"
              value={siForm.taxAmount}
              onChange={(e) =>
                setSiForm((f) => ({ ...f, taxAmount: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Payment status">
            <SelectInput
              value={siForm.paymentStatus}
              onChange={(e) => setSiForm((f) => ({ ...f, paymentStatus: e.target.value }))}
            >
              <option value="UNPAID">UNPAID</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="PAID">PAID</option>
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={siForm.remarks}
              onChange={(e) => setSiForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Lines</span>
            <button
              type="button"
              className="underline"
              onClick={() =>
                setSiForm((f) => ({ ...f, lines: [...f.lines, invLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {siForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-4">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.rate}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], rate: Number(e.target.value) };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Desc"
                value={line.description}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], description: e.target.value };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/sales-invoices", body: siForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "pi"} onClose={() => setModal(null)} title="Purchase invoice" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              value={piForm.supplierName}
              onChange={(e) => setPiForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked PO #">
            <TextInput
              value={piForm.linkedPoNumber}
              onChange={(e) => setPiForm((f) => ({ ...f, linkedPoNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={piForm.currency}
              onChange={(e) => setPiForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Tax amount">
            <TextInput
              type="number"
              step="0.01"
              value={piForm.taxAmount}
              onChange={(e) =>
                setPiForm((f) => ({ ...f, taxAmount: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Payment status">
            <SelectInput
              value={piForm.paymentStatus}
              onChange={(e) => setPiForm((f) => ({ ...f, paymentStatus: e.target.value }))}
            >
              <option value="UNPAID">UNPAID</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="PAID">PAID</option>
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={piForm.remarks}
              onChange={(e) => setPiForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Lines</span>
            <button
              type="button"
              className="underline"
              onClick={() =>
                setPiForm((f) => ({ ...f, lines: [...f.lines, invLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {piForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-4">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.rate}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], rate: Number(e.target.value) };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Desc"
                value={line.description}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], description: e.target.value };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/purchase-invoices", body: piForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "cust"} onClose={() => setModal(null)} title="Customer ledger entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer *">
            <TextInput
              value={custForm.customerName}
              onChange={(e) => setCustForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference type">
            <TextInput
              value={custForm.referenceType}
              onChange={(e) => setCustForm((f) => ({ ...f, referenceType: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={custForm.referenceNumber}
              onChange={(e) => setCustForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Debit">
            <TextInput
              type="number"
              step="0.01"
              value={custForm.debit}
              onChange={(e) => setCustForm((f) => ({ ...f, debit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Credit">
            <TextInput
              type="number"
              step="0.01"
              value={custForm.credit}
              onChange={(e) => setCustForm((f) => ({ ...f, credit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Narrative" className="sm:col-span-2">
            <TextInput
              value={custForm.narrative}
              onChange={(e) => setCustForm((f) => ({ ...f, narrative: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/customer-ledger", body: custForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "supp"} onClose={() => setModal(null)} title="Supplier ledger entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              value={suppForm.supplierName}
              onChange={(e) => setSuppForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference type">
            <TextInput
              value={suppForm.referenceType}
              onChange={(e) => setSuppForm((f) => ({ ...f, referenceType: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={suppForm.referenceNumber}
              onChange={(e) => setSuppForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Debit">
            <TextInput
              type="number"
              step="0.01"
              value={suppForm.debit}
              onChange={(e) => setSuppForm((f) => ({ ...f, debit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Credit">
            <TextInput
              type="number"
              step="0.01"
              value={suppForm.credit}
              onChange={(e) => setSuppForm((f) => ({ ...f, credit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Narrative" className="sm:col-span-2">
            <TextInput
              value={suppForm.narrative}
              onChange={(e) => setSuppForm((f) => ({ ...f, narrative: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/supplier-ledger", body: suppForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "cash"} onClose={() => setModal(null)} title="Cash / bank entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Account *">
            <TextInput
              value={cashForm.accountName}
              onChange={(e) => setCashForm((f) => ({ ...f, accountName: e.target.value }))}
            />
          </FormField>
          <FormField label="Type *">
            <SelectInput
              value={cashForm.transactionType}
              onChange={(e) => setCashForm((f) => ({ ...f, transactionType: e.target.value }))}
            >
              <option value="RECEIPT">RECEIPT</option>
              <option value="PAYMENT">PAYMENT</option>
            </SelectInput>
          </FormField>
          <FormField label="Amount *">
            <TextInput
              type="number"
              step="0.01"
              value={cashForm.amount}
              onChange={(e) => setCashForm((f) => ({ ...f, amount: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={cashForm.referenceNumber}
              onChange={(e) => setCashForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Party">
            <TextInput
              value={cashForm.partyName}
              onChange={(e) => setCashForm((f) => ({ ...f, partyName: e.target.value }))}
            />
          </FormField>
          <FormField label="Mode">
            <TextInput
              value={cashForm.mode}
              onChange={(e) => setCashForm((f) => ({ ...f, mode: e.target.value }))}
              placeholder="NEFT, cash…"
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={cashForm.remarks}
              onChange={(e) => setCashForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() => postMut.mutate({ path: "/accounts/cash-bank", body: cashForm })}
          >
            Save
          </button>
        </div>
      </Modal>
      <Modal
        open={modal === "bank" && bankDetailsAdmin}
        onClose={() => {
          setModal(null);
          setBankEditId(null);
          setBankForm(emptyBankForm());
        }}
        title={bankEditId ? "Edit bank detail" : "New bank detail"}
        wide
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Bank name *">
            <TextInput
              value={bankForm.bankName}
              onChange={(e) => setBankForm((f) => ({ ...f, bankName: e.target.value }))}
            />
          </FormField>
          <FormField label="Account name *">
            <TextInput
              value={bankForm.accountName}
              onChange={(e) => setBankForm((f) => ({ ...f, accountName: e.target.value }))}
            />
          </FormField>
          <FormField label="Account number *">
            <TextInput
              value={bankForm.accountNumber}
              onChange={(e) => setBankForm((f) => ({ ...f, accountNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency *">
            <TextInput
              value={bankForm.currency}
              onChange={(e) => setBankForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
              placeholder="EUR, AED, or USD (EURO matches EUR)"
            />
          </FormField>
          <FormField label="Bank address" className="sm:col-span-2">
            <textarea
              value={bankForm.bankAddress}
              onChange={(e) => setBankForm((f) => ({ ...f, bankAddress: e.target.value }))}
              rows={3}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              placeholder="Branch, street, P.O. Box, city (shown in Accounts list and on Tax invoice)"
            />
          </FormField>
          <FormField label="Branch name">
            <TextInput
              value={bankForm.branchName}
              onChange={(e) => setBankForm((f) => ({ ...f, branchName: e.target.value }))}
            />
          </FormField>
          <FormField label="SWIFT code">
            <TextInput
              value={bankForm.swiftCode}
              onChange={(e) => setBankForm((f) => ({ ...f, swiftCode: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="IBAN">
            <TextInput
              value={bankForm.iban}
              onChange={(e) => setBankForm((f) => ({ ...f, iban: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Correspondent bank name">
            <TextInput
              value={bankForm.correspondentBankName}
              onChange={(e) => setBankForm((f) => ({ ...f, correspondentBankName: e.target.value }))}
            />
          </FormField>
          <FormField label="Correspondent SWIFT">
            <TextInput
              value={bankForm.correspondentSwiftCode}
              onChange={(e) => setBankForm((f) => ({ ...f, correspondentSwiftCode: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Beneficiary name (print)">
            <TextInput
              value={bankForm.beneficiaryName}
              onChange={(e) => setBankForm((f) => ({ ...f, beneficiaryName: e.target.value }))}
              placeholder="Defaults to company name if empty"
            />
          </FormField>
          <FormField label="Beneficiary address (print)" className="sm:col-span-2">
            <textarea
              value={bankForm.beneficiaryAddress}
              onChange={(e) => setBankForm((f) => ({ ...f, beneficiaryAddress: e.target.value }))}
              rows={2}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              placeholder="Defaults to company address if empty"
            />
          </FormField>
          <FormField label="Purpose of payment (print)" className="sm:col-span-2">
            <TextInput
              value={bankForm.purposeOfPayment}
              onChange={(e) => setBankForm((f) => ({ ...f, purposeOfPayment: e.target.value }))}
              placeholder="e.g. Purchase of Spare Parts"
            />
          </FormField>
          <FormField label="Default account">
            <SelectInput
              value={bankForm.isDefault ? "YES" : "NO"}
              onChange={(e) => setBankForm((f) => ({ ...f, isDefault: e.target.value === "YES" }))}
            >
              <option value="NO">NO</option>
              <option value="YES">YES</option>
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={bankForm.remarks}
              onChange={(e) => setBankForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => {
              setModal(null);
              setBankEditId(null);
              setBankForm(emptyBankForm());
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending || putMut.isPending}
            onClick={() => {
              if (bankEditId) {
                putMut.mutate({ path: `/accounts/bank-details/${bankEditId}`, body: bankForm });
              } else {
                postMut.mutate({ path: "/accounts/bank-details", body: bankForm });
              }
            }}
          >
            Save
          </button>
        </div>
      </Modal>
      <PaymentReceiptView
        open={receiptView.open}
        onClose={() => setReceiptView({ open: false, item: null })}
        receipt={receiptView.item}
        onPrint={openPaymentReceiptPrint}
        onViewSlip={(id) => openPaymentReceiptSlip(id, true)}
      />
    </div>
  );
}
