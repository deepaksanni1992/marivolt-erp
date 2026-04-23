import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost } from "../lib/api.js";

const salesTabs = [
  "Quotation",
  "Order Acknowledgement",
  "Proforma Invoice",
  "Sales Invoice",
  "CIPL",
];

const statusOptions = ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED", "CANCELLED"];
const oaStatusOptions = ["DRAFT", "CONFIRMED", "CLOSED", "CANCELLED"];
const proformaStatusOptions = ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT", "CONVERTED", "CANCELLED"];
const salesInvoiceStatusOptions = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "CANCELLED"];
const ciplStatusOptions = ["DRAFT", "ISSUED", "SHIPPED", "CANCELLED"];

const emptyLine = () => ({
  itemCode: "",
  description: "",
  partNo: "",
  article: "",
  qty: 1,
  unit: "PCS",
  salePrice: 0,
  discountPct: 0,
  taxPct: 0,
  deliveryTime: "",
  origin: "",
  hsCode: "",
  weight: 0,
  remarks: "",
});

function money(n) {
  return Number(n || 0).toFixed(2);
}

function renderPrintWindow(data) {
  const q = data?.quotation || {};
  const company = q.companySnapshot || {};
  const customer = q.customer || {};
  const rows = q.lines || [];
  const html = `
    <html>
      <head>
        <title>${q.quotationNo || "Quotation"}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
          .header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px; }
          .title { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
          .muted { color: #555; font-size: 12px; line-height: 1.5; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; }
          th { background: #f5f5f5; text-align: left; }
          .right { text-align: right; }
          .totals { margin-top: 12px; width: 320px; margin-left: auto; }
          .totals div { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
          .footer { margin-top: 30px; font-size: 12px; color: #444; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">Quotation</div>
            <div class="muted">
              <div><b>No:</b> ${q.quotationNo || "-"}</div>
              <div><b>Date:</b> ${q.quotationDate ? new Date(q.quotationDate).toLocaleDateString() : "-"}</div>
              <div><b>Validity:</b> ${q.validityDate ? new Date(q.validityDate).toLocaleDateString() : "-"}</div>
            </div>
          </div>
          <div class="muted" style="text-align:right;">
            <div><b>${company.companyName || ""}</b></div>
            <div>${company.address || ""}</div>
            <div>${company.email || ""}</div>
            <div>${company.phone || ""}</div>
          </div>
        </div>
        <div class="muted">
          <div><b>Customer:</b> ${q.customerName || "-"}</div>
          <div><b>Attention:</b> ${q.attention || "-"}</div>
          <div><b>Billing:</b> ${customer.billingAddress || "-"}</div>
          <div><b>Shipping:</b> ${customer.shippingAddress || "-"}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th><th>Description</th><th class="right">Qty</th><th>Unit</th><th class="right">Unit Price</th><th class="right">Disc%</th><th class="right">Tax%</th><th class="right">Line Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `
              <tr>
                <td>${line.itemCode || ""}</td>
                <td>${line.description || ""}</td>
                <td class="right">${line.qty || 0}</td>
                <td>${line.unit || ""}</td>
                <td class="right">${money(line.salePrice)}</td>
                <td class="right">${money(line.discountPct)}</td>
                <td class="right">${money(line.taxPct)}</td>
                <td class="right">${money(line.lineTotal)}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><span>${money(q.subTotal)}</span></div>
          <div><span>Discount</span><span>${money(q.discountTotal)}</span></div>
          <div><span>Tax</span><span>${money(q.taxTotal)}</span></div>
          <div><b>Grand Total</b><b>${money(q.grandTotal)} ${q.currency || ""}</b></div>
        </div>
        <div class="footer">
          <div><b>Remarks:</b> ${q.remarks || "-"}</div>
          <div style="margin-top:18px;">Authorized Signature: _______________________</div>
        </div>
      </body>
    </html>
  `;
  const w = window.open("", "_blank", "width=1200,height=900");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
}

export default function Sales() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("Quotation");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const limit = 20;
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [oaCreateOpen, setOaCreateOpen] = useState(false);
  const [proformaCreateOpen, setProformaCreateOpen] = useState(false);
  const [salesInvoiceCreateOpen, setSalesInvoiceCreateOpen] = useState(false);
  const [ciplCreateOpen, setCiplCreateOpen] = useState(false);
  const [err, setErr] = useState("");

  const [form, setForm] = useState({
    quotationDate: new Date().toISOString().slice(0, 10),
    validityDate: "",
    customerName: "",
    customerReference: "",
    attention: "",
    paymentTerms: "",
    deliveryTerms: "",
    incoterm: "",
    currency: "USD",
    exchangeRate: 1,
    portOfLoading: "",
    portOfDischarge: "",
    finalDestination: "",
    remarks: "",
    internalNotes: "",
    customer: {
      billingAddress: "",
      shippingAddress: "",
      contactPerson: "",
      email: "",
      phone: "",
      country: "",
    },
    lines: [emptyLine()],
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["sales-quotations", page, search, status],
    queryFn: () =>
      apiGetWithQuery("/quotations", {
        page,
        limit,
        search: search || undefined,
        status: status || undefined,
      }),
  });

  const { data: detail } = useQuery({
    queryKey: ["quotation-detail", detailId],
    queryFn: () => apiGet(`/quotations/${detailId}`),
    enabled: !!detailId,
  });

  const { data: oaData, isLoading: oaLoading } = useQuery({
    queryKey: ["sales-oa", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/order-acknowledgements", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Order Acknowledgement",
  });

  const { data: proformaData, isLoading: proformaLoading } = useQuery({
    queryKey: ["sales-proforma", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/proforma-invoices", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Proforma Invoice",
  });

  const { data: salesInvoiceData, isLoading: salesInvoiceLoading } = useQuery({
    queryKey: ["sales-sales-invoices", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/sales-invoices", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "Sales Invoice",
  });

  const { data: ciplData, isLoading: ciplLoading } = useQuery({
    queryKey: ["sales-cipl", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/cipls", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: activeTab === "CIPL",
  });

  const { data: oaDetail } = useQuery({
    queryKey: ["oa-detail", detailId],
    queryFn: () => apiGet(`/sales/order-acknowledgements/${detailId}`),
    enabled: !!detailId && activeTab === "Order Acknowledgement",
  });

  const { data: proformaDetail } = useQuery({
    queryKey: ["proforma-detail", detailId],
    queryFn: () => apiGet(`/sales/proforma-invoices/${detailId}`),
    enabled: !!detailId && activeTab === "Proforma Invoice",
  });

  const { data: salesInvoiceDetail } = useQuery({
    queryKey: ["sales-invoice-detail", detailId],
    queryFn: () => apiGet(`/sales/sales-invoices/${detailId}`),
    enabled: !!detailId && activeTab === "Sales Invoice",
  });

  const { data: ciplDetail } = useQuery({
    queryKey: ["cipl-detail", detailId],
    queryFn: () => apiGet(`/sales/cipls/${detailId}`),
    enabled: !!detailId && activeTab === "CIPL",
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost("/quotations", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      setCreateOpen(false);
      setForm({
        quotationDate: new Date().toISOString().slice(0, 10),
        validityDate: "",
        customerName: "",
        customerReference: "",
        attention: "",
        paymentTerms: "",
        deliveryTerms: "",
        incoterm: "",
        currency: "USD",
        exchangeRate: 1,
        portOfLoading: "",
        portOfDischarge: "",
        finalDestination: "",
        remarks: "",
        internalNotes: "",
        customer: {
          billingAddress: "",
          shippingAddress: "",
          contactPerson: "",
          email: "",
          phone: "",
          country: "",
        },
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, nextStatus }) => apiPatch(`/quotations/${id}/status`, { status: nextStatus }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
      if (detailId) qc.invalidateQueries({ queryKey: ["quotation-detail", detailId] });
    },
    onError: (e) => setErr(e.message),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id) => apiPost(`/quotations/${id}/duplicate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-oa`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToProformaFromQuotationMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-proforma`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromQuotationMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/quotation/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-quotations"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToProformaFromOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/oa/${id}/to-proforma`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromOAMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/oa/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertProformaToSalesInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/proforma/${id}/to-sales-invoice`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
    },
    onError: (e) => setErr(e.message),
  });

  const convertToCiplFromSalesInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/convert/sales-invoice/${id}/to-cipl`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
    },
    onError: (e) => setErr(e.message),
  });

  const [oaForm, setOaForm] = useState({
    oaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    deliverySchedule: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [proformaForm, setProformaForm] = useState({
    proformaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    shipmentTerms: "",
    bankDetails: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [salesInvoiceForm, setSalesInvoiceForm] = useState({
    invoiceDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    paymentTerms: "",
    dispatchDetails: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const [ciplForm, setCiplForm] = useState({
    ciplDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    consigneeName: "",
    shipmentMode: "",
    incoterm: "",
    currency: "USD",
    lines: [emptyLine()],
  });

  const createOAMutation = useMutation({
    mutationFn: () => apiPost("/sales/order-acknowledgements", oaForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-oa"] });
      setOaCreateOpen(false);
      setOaForm({
        oaDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        deliverySchedule: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createProformaMutation = useMutation({
    mutationFn: () => apiPost("/sales/proforma-invoices", proformaForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-proforma"] });
      setProformaCreateOpen(false);
      setProformaForm({
        proformaDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        shipmentTerms: "",
        bankDetails: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createSalesInvoiceMutation = useMutation({
    mutationFn: () => apiPost("/sales/sales-invoices", salesInvoiceForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-sales-invoices"] });
      setSalesInvoiceCreateOpen(false);
      setSalesInvoiceForm({
        invoiceDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        paymentTerms: "",
        dispatchDetails: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const createCiplMutation = useMutation({
    mutationFn: () => apiPost("/sales/cipls", ciplForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-cipl"] });
      setCiplCreateOpen(false);
      setCiplForm({
        ciplDate: new Date().toISOString().slice(0, 10),
        customerName: "",
        consigneeName: "",
        shipmentMode: "",
        incoterm: "",
        currency: "USD",
        lines: [emptyLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const oaRows = oaData?.items ?? [];
  const proformaRows = proformaData?.items ?? [];
  const salesInvoiceRows = salesInvoiceData?.items ?? [];
  const ciplRows = ciplData?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const oaTotalPages = Math.max(1, Math.ceil((oaData?.total ?? 0) / limit));
  const proformaTotalPages = Math.max(1, Math.ceil((proformaData?.total ?? 0) / limit));
  const salesInvoiceTotalPages = Math.max(1, Math.ceil((salesInvoiceData?.total ?? 0) / limit));
  const ciplTotalPages = Math.max(1, Math.ceil((ciplData?.total ?? 0) / limit));

  const tabContent = useMemo(() => {
    if (activeTab === "Quotation") return "quotation";
    if (activeTab === "Order Acknowledgement") return "oa";
    if (activeTab === "Proforma Invoice") return "proforma";
    if (activeTab === "Sales Invoice") return "sales-invoice";
    if (activeTab === "CIPL") return "cipl";
    return "coming";
  }, [activeTab]);

  return (
    <div>
      <PageHeader title="Sales" subtitle="Company-wise sales document workflow.">
        <button
          type="button"
          onClick={() => {
            setErr("");
            if (activeTab === "Quotation") setCreateOpen(true);
            else if (activeTab === "Order Acknowledgement") setOaCreateOpen(true);
            else if (activeTab === "Proforma Invoice") setProformaCreateOpen(true);
            else if (activeTab === "Sales Invoice") setSalesInvoiceCreateOpen(true);
            else if (activeTab === "CIPL") setCiplCreateOpen(true);
          }}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          {activeTab === "Quotation"
            ? "New quotation"
            : activeTab === "Order Acknowledgement"
              ? "New OA"
              : activeTab === "Proforma Invoice"
                ? "New proforma"
                : activeTab === "Sales Invoice"
                  ? "New sales invoice"
                  : activeTab === "CIPL"
                    ? "New CIPL"
                : "New document"}
        </button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap gap-2">
        {salesTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-xl border px-3 py-1.5 text-sm ${
              activeTab === tab ? "border-gray-900 bg-gray-900 text-white" : "bg-white"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {(error || err) && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      {tabContent === "coming" ? (
        <div className="rounded-2xl border bg-white p-8 text-sm text-gray-600">
          {activeTab} in next sales phase.
        </div>
      ) : tabContent === "quotation" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <TextInput
              placeholder="Search quote/customer/ref"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <select
              className="rounded-xl border px-3 py-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-3 py-2">Quotation No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Validity</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        Loading…
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        No quotations found.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.quotationNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.quotationDate ? new Date(r.quotationDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.validityDate ? new Date(r.validityDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => setDetailId(r._id)}
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => duplicateMutation.mutate(r._id)}
                            >
                              Duplicate
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => {
                                apiGet(`/quotations/${r._id}/print-data`)
                                  .then((data) => renderPrintWindow(data))
                                  .catch((e) => setErr(e.message));
                              }}
                            >
                              Print
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{totalPages} · {total} quotations
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
          </div>
        </>
      ) : tabContent === "oa" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <TextInput
              placeholder="Search OA/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-3 py-2">OA No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {oaLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : oaRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No OA found.
                      </td>
                    </tr>
                  ) : (
                    oaRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.oaNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.oaDate ? new Date(r.oaDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertToProformaFromOAMutation.mutate(r._id)}
                            >
                              Convert to PI
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{oaTotalPages} · {oaData?.total ?? 0} OA
              </span>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= oaTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "proforma" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <TextInput
              placeholder="Search PI/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-3 py-2">PI No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proformaLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : proformaRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No Proforma found.
                      </td>
                    </tr>
                  ) : (
                    proformaRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.proformaNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.proformaDate ? new Date(r.proformaDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertProformaToSalesInvoiceMutation.mutate(r._id)}
                            >
                              Convert to SI
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{proformaTotalPages} · {proformaData?.total ?? 0} PI
              </span>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 disabled:opacity-40"
                  disabled={page >= proformaTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : tabContent === "sales-invoice" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <TextInput
              placeholder="Search invoice/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-3 py-2">Invoice No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {salesInvoiceLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : salesInvoiceRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No Sales Invoice found.
                      </td>
                    </tr>
                  ) : (
                    salesInvoiceRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.invoiceNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertToCiplFromSalesInvoiceMutation.mutate(r._id)}
                            >
                              Convert to CIPL
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{salesInvoiceTotalPages} · {salesInvoiceData?.total ?? 0} Sales Invoices
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
                  disabled={page >= salesInvoiceTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <TextInput
              placeholder="Search CIPL/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="px-3 py-2">CIPL No</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Grand Total</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ciplLoading ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        Loading...
                      </td>
                    </tr>
                  ) : ciplRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                        No CIPL found.
                      </td>
                    </tr>
                  ) : (
                    ciplRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-mono text-xs">{r.ciplNo}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2">{r.ciplDate ? new Date(r.ciplDate).toLocaleDateString() : "—"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 text-right">
                          {r.currency} {money(r.grandTotal)}
                        </td>
                        <td className="px-3 py-2">
                          <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setDetailId(r._id)}>
                            Open
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>
                Page {page}/{ciplTotalPages} · {ciplData?.total ?? 0} CIPL
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
                  disabled={page >= ciplTotalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!detailId}
        onClose={() => setDetailId(null)}
        title={
          tabContent === "quotation"
            ? "Quotation View"
            : tabContent === "oa"
              ? "Order Acknowledgement View"
              : tabContent === "proforma"
                ? "Proforma View"
                : tabContent === "sales-invoice"
                  ? "Sales Invoice View"
                  : "CIPL View"
        }
        wide
      >
        {tabContent === "quotation" && !detail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : tabContent === "quotation" ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">No</div>
                <div className="font-mono">{detail.quotationNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div>{detail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>{detail.status}</div>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1 text-right">Qty</th>
                    <th className="px-2 py-1 text-right">Price</th>
                    <th className="px-2 py-1 text-right">Disc%</th>
                    <th className="px-2 py-1 text-right">Tax%</th>
                    <th className="px-2 py-1 text-right">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((line) => (
                    <tr key={line._id} className="border-t">
                      <td className="px-2 py-1">{line.itemCode}</td>
                      <td className="px-2 py-1 text-right">{line.qty}</td>
                      <td className="px-2 py-1 text-right">{money(line.salePrice)}</td>
                      <td className="px-2 py-1 text-right">{money(line.discountPct)}</td>
                      <td className="px-2 py-1 text-right">{money(line.taxPct)}</td>
                      <td className="px-2 py-1 text-right">{money(line.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={s === detail.status || statusMutation.isPending}
                  className="rounded-xl border px-2 py-1 text-xs disabled:opacity-40"
                  onClick={() => statusMutation.mutate({ id: detail._id, nextStatus: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToOAMutation.mutate(detail._id)}
              >
                Convert to OA
              </button>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToProformaFromQuotationMutation.mutate(detail._id)}
              >
                Convert to PI
              </button>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToCiplFromQuotationMutation.mutate(detail._id)}
              >
                Convert to CIPL
              </button>
            </div>
          </div>
        ) : tabContent === "oa" ? (
          !oaDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <div className="text-gray-500">OA No</div>
                  <div className="font-mono">{oaDetail.oaNo}</div>
                </div>
                <div>
                  <div className="text-gray-500">Customer</div>
                  <div>{oaDetail.customerName}</div>
                </div>
                <div>
                  <div className="text-gray-500">Status</div>
                  <div>{oaDetail.status}</div>
                </div>
              </div>
              <div className="text-xs text-gray-600">Linked Quotation: {oaDetail.linkedQuotationNo || "-"}</div>
              <div className="flex flex-wrap gap-2">
                {oaStatusOptions.map((s) => (
                  <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                    {s}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToCiplFromOAMutation.mutate(oaDetail._id)}
              >
                Convert to CIPL
              </button>
            </div>
          )
        ) : tabContent === "proforma" ? (
          !proformaDetail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">PI No</div>
                <div className="font-mono">{proformaDetail.proformaNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div>{proformaDetail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>{proformaDetail.status}</div>
              </div>
            </div>
            <div className="text-xs text-gray-600">
              Linked Quotation: {proformaDetail.linkedQuotationNo || "-"} | Linked OA: {proformaDetail.linkedOANo || "-"}
            </div>
            <div className="flex flex-wrap gap-2">
              {proformaStatusOptions.map((s) => (
                <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rounded-xl border px-2 py-1 text-xs"
              onClick={() => convertProformaToSalesInvoiceMutation.mutate(proformaDetail._id)}
            >
              Convert to SI
            </button>
          </div>
        )
        ) : tabContent === "sales-invoice" ? (
          !salesInvoiceDetail ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <div className="text-gray-500">Invoice No</div>
                  <div className="font-mono">{salesInvoiceDetail.invoiceNo}</div>
                </div>
                <div>
                  <div className="text-gray-500">Customer</div>
                  <div>{salesInvoiceDetail.customerName}</div>
                </div>
                <div>
                  <div className="text-gray-500">Status</div>
                  <div>{salesInvoiceDetail.status}</div>
                </div>
              </div>
              <div className="text-xs text-gray-600">
                Linked PI: {salesInvoiceDetail.linkedProformaNo || "-"} | Linked OA: {salesInvoiceDetail.linkedOANo || "-"}
              </div>
              <div className="flex flex-wrap gap-2">
                {salesInvoiceStatusOptions.map((s) => (
                  <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                    {s}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="rounded-xl border px-2 py-1 text-xs"
                onClick={() => convertToCiplFromSalesInvoiceMutation.mutate(salesInvoiceDetail._id)}
              >
                Convert to CIPL
              </button>
            </div>
          )
        ) : !ciplDetail ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-gray-500">CIPL No</div>
                <div className="font-mono">{ciplDetail.ciplNo}</div>
              </div>
              <div>
                <div className="text-gray-500">Customer</div>
                <div>{ciplDetail.customerName}</div>
              </div>
              <div>
                <div className="text-gray-500">Status</div>
                <div>{ciplDetail.status}</div>
              </div>
            </div>
            <div className="text-xs text-gray-600">
              Linked Quotation: {ciplDetail.linkedQuotationNo || "-"} | Linked OA: {ciplDetail.linkedOANo || "-"} | Linked Invoice:{" "}
              {ciplDetail.linkedSalesInvoiceNo || "-"}
            </div>
            <div className="flex flex-wrap gap-2">
              {ciplStatusOptions.map((s) => (
                <button key={s} type="button" className="rounded-xl border px-2 py-1 text-xs" disabled>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New Quotation" wide>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Quotation Date">
            <TextInput
              type="date"
              value={form.quotationDate}
              onChange={(e) => setForm((f) => ({ ...f, quotationDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Validity Date">
            <TextInput
              type="date"
              value={form.validityDate}
              onChange={(e) => setForm((f) => ({ ...f, validityDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </FormField>
          <FormField label="Customer *">
            <TextInput
              value={form.customerName}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer Ref">
            <TextInput
              value={form.customerReference}
              onChange={(e) => setForm((f) => ({ ...f, customerReference: e.target.value }))}
            />
          </FormField>
          <FormField label="Attention">
            <TextInput
              value={form.attention}
              onChange={(e) => setForm((f) => ({ ...f, attention: e.target.value }))}
            />
          </FormField>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Quotation Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {form.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...form.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = form.lines.filter((_, i) => i !== idx);
                    setForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => {
              setErr("");
              createMutation.mutate();
            }}
          >
            {createMutation.isPending ? "Saving..." : "Create Quotation"}
          </button>
        </div>
      </Modal>

      <Modal open={oaCreateOpen} onClose={() => setOaCreateOpen(false)} title="New Order Acknowledgement" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="OA Date">
            <TextInput type="date" value={oaForm.oaDate} onChange={(e) => setOaForm((f) => ({ ...f, oaDate: e.target.value }))} />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={oaForm.customerName} onChange={(e) => setOaForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput value={oaForm.paymentTerms} onChange={(e) => setOaForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={oaForm.currency} onChange={(e) => setOaForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">OA Lines</span>
            <button type="button" className="text-sm underline" onClick={() => setOaForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {oaForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...oaForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setOaForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = oaForm.lines.filter((_, i) => i !== idx);
                    setOaForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setOaCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createOAMutation.isPending}
            onClick={() => createOAMutation.mutate()}
          >
            {createOAMutation.isPending ? "Saving..." : "Create OA"}
          </button>
        </div>
      </Modal>

      <Modal open={proformaCreateOpen} onClose={() => setProformaCreateOpen(false)} title="New Proforma Invoice" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="PI Date">
            <TextInput
              type="date"
              value={proformaForm.proformaDate}
              onChange={(e) => setProformaForm((f) => ({ ...f, proformaDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={proformaForm.customerName} onChange={(e) => setProformaForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput value={proformaForm.paymentTerms} onChange={(e) => setProformaForm((f) => ({ ...f, paymentTerms: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={proformaForm.currency} onChange={(e) => setProformaForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">PI Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setProformaForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {proformaForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...proformaForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setProformaForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = proformaForm.lines.filter((_, i) => i !== idx);
                    setProformaForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setProformaCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createProformaMutation.isPending}
            onClick={() => createProformaMutation.mutate()}
          >
            {createProformaMutation.isPending ? "Saving..." : "Create PI"}
          </button>
        </div>
      </Modal>

      <Modal open={salesInvoiceCreateOpen} onClose={() => setSalesInvoiceCreateOpen(false)} title="New Sales Invoice" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="Invoice Date">
            <TextInput
              type="date"
              value={salesInvoiceForm.invoiceDate}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, invoiceDate: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer *">
            <TextInput
              value={salesInvoiceForm.customerName}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Payment Terms">
            <TextInput
              value={salesInvoiceForm.paymentTerms}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, paymentTerms: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={salesInvoiceForm.currency}
              onChange={(e) => setSalesInvoiceForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Invoice Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setSalesInvoiceForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}
            >
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {salesInvoiceForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...salesInvoiceForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setSalesInvoiceForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = salesInvoiceForm.lines.filter((_, i) => i !== idx);
                    setSalesInvoiceForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setSalesInvoiceCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createSalesInvoiceMutation.isPending}
            onClick={() => createSalesInvoiceMutation.mutate()}
          >
            {createSalesInvoiceMutation.isPending ? "Saving..." : "Create Sales Invoice"}
          </button>
        </div>
      </Modal>

      <Modal open={ciplCreateOpen} onClose={() => setCiplCreateOpen(false)} title="New CIPL" wide>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="CIPL Date">
            <TextInput type="date" value={ciplForm.ciplDate} onChange={(e) => setCiplForm((f) => ({ ...f, ciplDate: e.target.value }))} />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={ciplForm.customerName} onChange={(e) => setCiplForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Consignee">
            <TextInput value={ciplForm.consigneeName} onChange={(e) => setCiplForm((f) => ({ ...f, consigneeName: e.target.value }))} />
          </FormField>
          <FormField label="Currency">
            <TextInput value={ciplForm.currency} onChange={(e) => setCiplForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">CIPL Lines</span>
            <button type="button" className="text-sm underline" onClick={() => setCiplForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))}>
              + Add line
            </button>
          </div>
          <div className="space-y-2">
            {ciplForm.lines.map((line, idx) => (
              <div key={idx} className="grid gap-2 rounded-xl border p-2 sm:grid-cols-8">
                <TextInput
                  placeholder="Item code"
                  value={line.itemCode}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, itemCode: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, description: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  placeholder="Qty"
                  value={line.qty}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, qty: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, unit: e.target.value };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Price"
                  value={line.salePrice}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, salePrice: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Disc %"
                  value={line.discountPct}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, discountPct: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <TextInput
                  type="number"
                  step="0.01"
                  placeholder="Tax %"
                  value={line.taxPct}
                  onChange={(e) => {
                    const lines = [...ciplForm.lines];
                    lines[idx] = { ...line, taxPct: Number(e.target.value) };
                    setCiplForm((f) => ({ ...f, lines }));
                  }}
                />
                <button
                  type="button"
                  className="rounded-xl border px-2 py-1 text-xs"
                  onClick={() => {
                    const lines = ciplForm.lines.filter((_, i) => i !== idx);
                    setCiplForm((f) => ({ ...f, lines: lines.length ? lines : [emptyLine()] }));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setCiplCreateOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createCiplMutation.isPending}
            onClick={() => createCiplMutation.mutate()}
          >
            {createCiplMutation.isPending ? "Saving..." : "Create CIPL"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
