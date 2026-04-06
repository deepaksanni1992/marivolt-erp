import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput } from "../components/erp/FormField.jsx";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import {
  BUYER_DEFAULTS,
  COMMERCIAL_DEFAULTS,
  DEFAULT_CLOSING_NOTE,
  DEFAULT_PURCHASE_TERMS,
  DEFAULT_SPECIAL_REMARKS,
} from "../constants/purchaseOrderDefaults.js";
import {
  apiDelete,
  apiGet,
  apiGetWithQuery,
  apiPatch,
  apiPost,
  apiPut,
} from "../lib/api.js";

const TABS = [
  { id: "orders", label: "Purchase order" },
  { id: "suppliers", label: "Supplier master" },
  { id: "summary", label: "PO summary" },
  { id: "returns", label: "Purchase return" },
  { id: "pending", label: "Pending PO report" },
];

const defaultLine = () => ({
  articleNo: "",
  itemCode: "",
  partNo: "",
  description: "",
  qty: 1,
  uom: "PCS",
  unitPrice: 0,
  remarks: "",
});

function todayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function initialPoForm() {
  return {
    ...BUYER_DEFAULTS,
    ...COMMERCIAL_DEFAULTS,
    supplierName: "",
    supplierAddress: "",
    supplierPhone: "",
    supplierEmail: "",
    ref: "",
    intRef: "",
    contactPerson: "",
    supplierReference: "",
    offerDate: "",
    currency: "USD",
    orderDate: todayDateInput(),
    remarks: "",
    specialRemarks: DEFAULT_SPECIAL_REMARKS,
    termsAndConditions: DEFAULT_PURCHASE_TERMS,
    closingNote: DEFAULT_CLOSING_NOTE,
    lines: [defaultLine()],
  };
}

function buildPoPayload(form) {
  const cur = form.currency || "USD";
  const lines = form.lines
    .map((l) => {
      const articleNo = String(l.articleNo || "").trim();
      const partNo = String(l.partNo || "").trim();
      const itemCode = String(l.itemCode || articleNo || partNo).trim().toUpperCase();
      return {
        articleNo: articleNo || itemCode,
        itemCode,
        partNo,
        description: String(l.description || "").trim(),
        qty: Number(l.qty) || 0,
        uom: String(l.uom || "PCS").trim(),
        unitPrice: Number(l.unitPrice) || 0,
        remarks: String(l.remarks || "").trim(),
        currency: cur,
      };
    })
    .filter((l) => l.itemCode && l.qty > 0);

  const orderDate =
    form.orderDate && String(form.orderDate).trim()
      ? new Date(`${form.orderDate}T12:00:00`).toISOString()
      : undefined;

  return {
    buyerLegalName: form.buyerLegalName,
    buyerAddressLine: form.buyerAddressLine,
    buyerPhone: form.buyerPhone,
    buyerEmail: form.buyerEmail,
    buyerWeb: form.buyerWeb,
    supplierName: String(form.supplierName || "").trim(),
    supplierAddress: form.supplierAddress ?? "",
    supplierPhone: form.supplierPhone ?? "",
    supplierEmail: form.supplierEmail ?? "",
    ref: form.ref ?? "",
    intRef: form.intRef ?? "",
    contactPerson: form.contactPerson ?? "",
    supplierReference: form.supplierReference ?? "",
    offerDate: form.offerDate ?? "",
    currency: cur,
    orderDate,
    remarks: form.remarks ?? "",
    delivery: form.delivery,
    insurance: form.insurance,
    packing: form.packing,
    freight: form.freight,
    taxes: form.taxes,
    payment: form.payment,
    specialRemarks: form.specialRemarks ?? "",
    termsAndConditions: form.termsAndConditions ?? "",
    closingNote: form.closingNote ?? "",
    lines,
  };
}

function formatPoDate(val) {
  if (!val) return "—";
  const d = typeof val === "string" || typeof val === "number" ? new Date(val) : val;
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const defaultPrLine = () => ({
  itemCode: "",
  description: "",
  qty: 1,
  unitPrice: 0,
  reason: "",
});

function StatusBadge({ status }) {
  const map = {
    DRAFT: "bg-slate-100 text-slate-800 ring-slate-200",
    SAVED: "bg-zinc-100 text-zinc-800 ring-zinc-200",
    SENT: "bg-sky-50 text-sky-900 ring-sky-200",
    PARTIAL_RECEIVED: "bg-amber-50 text-amber-900 ring-amber-200",
    RECEIVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    CANCELLED: "bg-red-50 text-red-800 ring-red-200",
    APPROVED: "bg-indigo-50 text-indigo-900 ring-indigo-200",
    POSTED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  };
  const cls = map[status] || "bg-gray-100 text-gray-800 ring-gray-200";
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}
    >
      {status}
    </span>
  );
}

function KpiCard({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</div>
      {hint ? <div className="mt-1 text-xs text-gray-500">{hint}</div> : null}
    </div>
  );
}

/** Group CSV rows by poNumber, or merge lines for the same supplier when poNumber is blank. */
function csvRowsToPurchaseOrders(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const supplierName = String(r.supplierName || r.Supplier || "").trim();
    const articleNo = String(r.articleNo || r.ArticleNr || r.ArticleNo || "").trim();
    const partNo = String(r.partNo || r.PartNr || r.PartNo || "").trim();
    const itemCode = String(r.itemCode || r.ItemCode || articleNo || partNo || "").trim();
    if (!supplierName || !itemCode) continue;

    const poNumber = String(r.poNumber || r.PONumber || "").trim();
    const key = poNumber || `__SUP__${supplierName.toUpperCase()}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        poNumber: poNumber || undefined,
        supplierName,
        currency: String(r.currency || r.Currency || "USD").trim() || "USD",
        remarks: String(r.remarks || r.Remarks || "").trim(),
        lines: [],
      });
    }
    const po = byKey.get(key);
    po.lines.push({
      itemCode,
      articleNo: articleNo || itemCode,
      partNo,
      uom: String(r.uom || r.UOM || "PCS").trim() || "PCS",
      description: String(r.description || r.Description || "").trim(),
      qty: Number(r.qty || r.Qty) || 0,
      unitPrice: Number(r.unitPrice || r.UnitPrice || r.Rate) || 0,
    });
  }
  return [...byKey.values()].filter((p) => p.lines.length > 0);
}

export default function Purchase() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("orders");
  const [page, setPage] = useState(1);
  const [supPage, setSupPage] = useState(1);
  const [retPage, setRetPage] = useState(1);
  const [pendPage, setPendPage] = useState(1);
  const limit = 20;

  const [poFilterSupplier, setPoFilterSupplier] = useState("");
  const [poFilterStatus, setPoFilterStatus] = useState("");
  const [supSearch, setSupSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [form, setForm] = useState(() => initialPoForm());
  const [receiveWarehouse, setReceiveWarehouse] = useState("MAIN");
  const [receiveLines, setReceiveLines] = useState([]);
  const [err, setErr] = useState("");

  const poImportRef = useRef(null);
  const supImportRef = useRef(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["purchaseOrders", page, poFilterSupplier, poFilterStatus],
    queryFn: () =>
      apiGetWithQuery("/purchase-orders", {
        page,
        limit,
        supplierName: poFilterSupplier.trim() || undefined,
        status: poFilterStatus || undefined,
      }),
  });

  const { data: summary } = useQuery({
    queryKey: ["purchaseSummary"],
    queryFn: () => apiGet("/purchase-orders/reports/summary"),
    staleTime: 20_000,
  });

  const { data: suppliersAll } = useQuery({
    queryKey: ["suppliersAll"],
    queryFn: () => apiGet("/suppliers/all"),
    staleTime: 60_000,
  });

  const { data: supList, isLoading: supLoading } = useQuery({
    queryKey: ["suppliers", supPage, supSearch],
    queryFn: () =>
      apiGetWithQuery("/suppliers", {
        page: supPage,
        limit: 25,
        search: supSearch.trim() || undefined,
      }),
    enabled: tab === "suppliers",
  });

  const { data: pendingData, isLoading: pendLoading } = useQuery({
    queryKey: ["pendingPoReport", pendPage],
    queryFn: () =>
      apiGetWithQuery("/purchase-orders/reports/pending", { page: pendPage, limit: 25 }),
    enabled: tab === "pending",
  });

  const { data: returnsData, isLoading: retLoading } = useQuery({
    queryKey: ["purchaseReturns", retPage],
    queryFn: () => apiGetWithQuery("/purchase-returns", { page: retPage, limit: 25 }),
    enabled: tab === "returns",
  });

  const { data: detail } = useQuery({
    queryKey: ["purchaseOrder", detailId],
    queryFn: () => apiGet(`/purchase-orders/${detailId}`),
    enabled: !!detailId,
  });

  const [retDetailId, setRetDetailId] = useState(null);
  const { data: retDetail } = useQuery({
    queryKey: ["purchaseReturn", retDetailId],
    queryFn: () => apiGet(`/purchase-returns/${retDetailId}`),
    enabled: !!retDetailId,
  });

  const createMutation = useMutation({
    mutationFn: (body) => apiPost("/purchase-orders", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      setErr("");
      setCreateOpen(false);
      setForm(initialPoForm());
    },
    onError: (e) => setErr(e.message || "Could not create purchase order"),
  });

  const poPreviewTotals = useMemo(() => {
    const sub = form.lines.reduce(
      (s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0),
      0
    );
    return { subTotal: sub, grandTotal: sub };
  }, [form.lines]);

  function applySupplierMasterDefaults(name) {
    const n = name.trim().toLowerCase();
    if (!n) return;
    const s = (suppliersAll?.items ?? []).find((x) => String(x.name || "").trim().toLowerCase() === n);
    if (!s) return;
    setForm((f) => ({
      ...f,
      supplierAddress: f.supplierAddress || s.address || "",
      supplierPhone: f.supplierPhone || s.phone || "",
      supplierEmail: f.supplierEmail || s.email || "",
      contactPerson: f.contactPerson || s.contactName || "",
    }));
  }

  const poImportMutation = useMutation({
    mutationFn: (orders) => apiPost("/purchase-orders/import", { orders }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
    },
    onError: (e) => setErr(e.message),
  });

  const receiveMutation = useMutation({
    mutationFn: (body) => apiPost(`/purchase-orders/${detailId}/receive`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
      qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
      qc.invalidateQueries({ queryKey: ["pendingPoReport"] });
      setReceiveOpen(false);
    },
    onError: (e) => setErr(e.message),
  });

  const [supModal, setSupModal] = useState(false);
  const [supEditing, setSupEditing] = useState(null);
  const [supForm, setSupForm] = useState({
    supplierCode: "",
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    gstNo: "",
    panNo: "",
    notes: "",
  });

  const saveSupMutation = useMutation({
    mutationFn: () =>
      supEditing
        ? apiPut(`/suppliers/${supEditing}`, supForm)
        : apiPost("/suppliers", supForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
      setSupModal(false);
      setSupEditing(null);
    },
    onError: (e) => setErr(e.message),
  });

  const delSupMutation = useMutation({
    mutationFn: (id) => apiDelete(`/suppliers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
    },
  });

  const supImportMutation = useMutation({
    mutationFn: (suppliers) => apiPost("/suppliers/import", { suppliers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      qc.invalidateQueries({ queryKey: ["suppliersAll"] });
    },
    onError: (e) => setErr(e.message),
  });

  const [retOpen, setRetOpen] = useState(false);
  const [retForm, setRetForm] = useState({
    supplierName: "",
    linkedPoNumber: "",
    warehouse: "MAIN",
    currency: "USD",
    remarks: "",
    lines: [defaultPrLine()],
  });

  const createRetMutation = useMutation({
    mutationFn: () => apiPost("/purchase-returns", retForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseReturns"] });
      setRetOpen(false);
      setRetForm({
        supplierName: "",
        linkedPoNumber: "",
        warehouse: "MAIN",
        currency: "USD",
        remarks: "",
        lines: [defaultPrLine()],
      });
    },
    onError: (e) => setErr(e.message),
  });

  const postRetMutation = useMutation({
    mutationFn: (id) => apiPost(`/purchase-returns/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchaseReturns"] });
      qc.invalidateQueries({ queryKey: ["purchaseReturn", retDetailId] });
      qc.invalidateQueries({ queryKey: ["stockBalances"] });
      qc.invalidateQueries({ queryKey: ["inventoryLedger"] });
    },
    onError: (e) => setErr(e.message),
  });

  function openReceive() {
    if (!detail?.lines?.length) return;
    setErr("");
    setReceiveWarehouse("MAIN");
    setReceiveLines(
      detail.lines.map((l) => ({
        lineId: l._id,
        itemCode: l.itemCode,
        max: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
        qty: Math.max(0, (l.qty || 0) - (l.receivedQty || 0)),
      }))
    );
    setReceiveOpen(true);
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const supplierCount = suppliersAll?.items?.length ?? "—";

  function exportPoCsv() {
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "orderDate", header: "Date" },
      { key: "status", header: "Status" },
      { key: "currency", header: "CCY" },
      { key: "grandTotal", header: "Total" },
    ];
    const out = rows.map((r) => ({
      ...r,
      orderDate: r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "",
      grandTotal: Number(r.grandTotal || 0).toFixed(2),
    }));
    downloadCsv(`purchase-orders-${Date.now()}.csv`, cols, out);
  }

  function exportPoPdf() {
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "orderDate", header: "Date" },
      { key: "status", header: "Status" },
      { key: "grandTotal", header: "Total" },
    ];
    const out = rows.map((r) => ({
      ...r,
      orderDate: r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "",
      grandTotal: `${r.currency || ""} ${Number(r.grandTotal || 0).toFixed(2)}`,
    }));
    downloadPdfTable(
      "Purchase orders",
      "Marivoltz ERP — procurement register",
      cols,
      out,
      "purchase-orders"
    );
  }

  function onPoCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        try {
          const orders = csvRowsToPurchaseOrders(res.data);
          if (!orders.length) {
            setErr("No valid rows: need supplierName and itemCode at minimum.");
            return;
          }
          setErr("");
          poImportMutation.mutate(orders);
        } catch (ex) {
          setErr(ex.message || "CSV parse failed");
        }
      },
      error: (ex) => setErr(ex.message),
    });
  }

  function exportSuppliersCsv() {
    const items = supList?.items ?? [];
    const cols = [
      { key: "supplierCode", header: "Code" },
      { key: "name", header: "Name" },
      { key: "contactName", header: "Contact" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
      { key: "gstNo", header: "GST" },
    ];
    downloadCsv(`suppliers-${Date.now()}.csv`, cols, items);
  }

  function exportSuppliersPdf() {
    const items = supList?.items ?? [];
    const cols = [
      { key: "supplierCode", header: "Code" },
      { key: "name", header: "Name" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
    ];
    downloadPdfTable(
      "Supplier master",
      "Registered vendors",
      cols,
      items,
      "suppliers"
    );
  }

  function onSupCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const suppliers = res.data
          .map((r) => ({
            name: String(r.name || r.Name || "").trim(),
            supplierCode: String(r.supplierCode || r.Code || "").trim(),
            contactName: r.contactName || "",
            phone: r.phone || "",
            email: r.email || "",
            address: r.address || "",
            gstNo: r.gstNo || "",
            panNo: r.panNo || "",
            notes: r.notes || "",
          }))
          .filter((r) => r.name);
        if (!suppliers.length) {
          setErr("No rows with a name column.");
          return;
        }
        setErr("");
        supImportMutation.mutate(suppliers);
      },
    });
  }

  function exportPendingPdf() {
    const items = pendingData?.items ?? [];
    const cols = [
      { key: "poNumber", header: "PO #" },
      { key: "supplierName", header: "Supplier" },
      { key: "status", header: "Status" },
      { key: "pct", header: "Receipt %" },
      { key: "pendingQty", header: "Pending qty" },
    ];
    const out = items.map((r) => ({
      poNumber: r.poNumber,
      supplierName: r.supplierName,
      status: r.status,
      pct: `${r._report?.receiptPercent ?? 0}%`,
      pendingQty: r._report?.pendingQty ?? "",
    }));
    downloadPdfTable(
      "Pending purchase orders",
      "Open and partially received POs",
      cols,
      out,
      "pending-po"
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-slate-50 to-white px-6 py-5 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-gray-200/80 pb-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Procurement
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Purchase</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              Supplier master, purchase orders, goods receipt, returns, and operational reports.
              Data below refreshes from your authorised API.
            </p>
          </div>
          <div className="text-right text-xs text-gray-500">
            <div className="font-medium text-gray-700">Marivoltz ERP</div>
            <div>Module version · live register</div>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Total POs"
            value={summary?.totalPurchaseOrders ?? "—"}
            hint="All recorded orders"
          />
          <KpiCard
            label="Pending orders"
            value={summary?.pendingOrderCount ?? "—"}
            hint="Not received / cancelled"
          />
          <KpiCard
            label="Order value (sum)"
            value={
              summary?.totalOrderValue != null
                ? `USD ${Number(summary.totalOrderValue).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : "—"
            }
            hint="Grand total, all POs"
          />
          <KpiCard
            label="Suppliers on file"
            value={supplierCount}
            hint="Master records"
          />
        </div>
      </div>

      {(error || err) && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      <div className="flex flex-wrap gap-2 rounded-xl border border-gray-200 bg-white p-2 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setErr("");
            }}
            className={[
              "rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors",
              tab === t.id
                ? "bg-gray-900 text-white shadow"
                : "text-gray-700 hover:bg-gray-100",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "orders" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Purchase order register</h2>
              <p className="text-xs text-gray-500">Filter, export, and open lines for receipt.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={poImportRef} type="file" accept=".csv" className="hidden" onChange={onPoCsvFile} />
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={() => poImportRef.current?.click()}
                disabled={poImportMutation.isPending}
              >
                {poImportMutation.isPending ? "Importing…" : "Import CSV"}
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={exportPoCsv}
                disabled={!rows.length}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                onClick={exportPoPdf}
                disabled={!rows.length}
              >
                Export PDF
              </button>
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                onClick={() => {
                  setErr("");
                  createMutation.reset();
                  setForm(initialPoForm());
                  setCreateOpen(true);
                }}
              >
                New PO
              </button>
            </div>
          </div>

          <div className="grid gap-3 border-b border-gray-100 px-4 py-3 sm:grid-cols-3">
            <FormField label="Filter supplier">
              <TextInput
                value={poFilterSupplier}
                onChange={(e) => setPoFilterSupplier(e.target.value)}
                placeholder="Name contains…"
              />
            </FormField>
            <FormField label="Status">
              <select
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                value={poFilterStatus}
                onChange={(e) => setPoFilterStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="DRAFT">DRAFT</option>
                <option value="SAVED">SAVED</option>
                <option value="SENT">SENT</option>
                <option value="PARTIAL_RECEIVED">PARTIAL_RECEIVED</option>
                <option value="RECEIVED">RECEIVED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
            </FormField>
            <div className="flex items-end">
              <button
                type="button"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium"
                onClick={() => {
                  setPage(1);
                  qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                }}
              >
                Apply filters
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50/90 text-xs font-bold uppercase tracking-wide text-gray-600">
                <tr>
                  <th className="px-4 py-3">PO #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 w-28" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No purchase orders.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2.5 font-mono text-xs font-semibold text-gray-900">
                        {r.poNumber}
                      </td>
                      <td className="px-4 py-2.5 text-gray-800">{r.supplierName}</td>
                      <td className="px-4 py-2.5 text-gray-600">
                        {r.orderDate ? new Date(r.orderDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums text-gray-900">
                        {r.currency} {Number(r.grandTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-800 hover:bg-gray-50"
                          onClick={() => {
                            setDetailId(r._id);
                            setErr("");
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-2 text-xs text-gray-600">
            <span>
              Page {page}/{totalPages} · {total} POs
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded-md border px-2 py-1 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "suppliers" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Supplier master</h2>
              <p className="text-xs text-gray-500">Legal and contact details for approved vendors.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input ref={supImportRef} type="file" accept=".csv" className="hidden" onChange={onSupCsvFile} />
              <button
                type="button"
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold"
                onClick={() => supImportRef.current?.click()}
                disabled={supImportMutation.isPending}
              >
                {supImportMutation.isPending ? "Importing…" : "Import CSV"}
              </button>
              <button type="button" className="rounded-lg border px-3 py-1.5 text-xs font-semibold" onClick={exportSuppliersCsv}>
                Export CSV
              </button>
              <button type="button" className="rounded-lg border px-3 py-1.5 text-xs font-semibold" onClick={exportSuppliersPdf}>
                Export PDF
              </button>
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white"
                onClick={() => {
                  setSupEditing(null);
                  setSupForm({
                    supplierCode: "",
                    name: "",
                    contactName: "",
                    phone: "",
                    email: "",
                    address: "",
                    gstNo: "",
                    panNo: "",
                    notes: "",
                  });
                  setErr("");
                  setSupModal(true);
                }}
              >
                New supplier
              </button>
            </div>
          </div>
          <div className="border-b border-gray-100 px-4 py-3 sm:max-w-md">
            <FormField label="Search">
              <TextInput
                value={supSearch}
                onChange={(e) => setSupSearch(e.target.value)}
                placeholder="Name, code, email…"
              />
            </FormField>
            <button
              type="button"
              className="mt-2 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold"
              onClick={() => setSupPage(1)}
            >
              Search
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50/90 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3 w-32" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {supLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : (supList?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No suppliers.
                    </td>
                  </tr>
                ) : (
                  (supList?.items ?? []).map((s) => (
                    <tr key={s._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{s.supplierCode}</td>
                      <td className="px-4 py-2 font-medium">{s.name}</td>
                      <td className="px-4 py-2 text-gray-600">{s.contactName}</td>
                      <td className="px-4 py-2">{s.phone}</td>
                      <td className="px-4 py-2 text-xs text-gray-600">{s.email}</td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="mr-1 rounded border px-2 py-0.5 text-xs"
                          onClick={() => {
                            setSupEditing(s._id);
                            setSupForm({
                              supplierCode: s.supplierCode || "",
                              name: s.name || "",
                              contactName: s.contactName || "",
                              phone: s.phone || "",
                              email: s.email || "",
                              address: s.address || "",
                              gstNo: s.gstNo || "",
                              panNo: s.panNo || "",
                              notes: s.notes || "",
                            });
                            setSupModal(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-700"
                          onClick={() => {
                            if (confirm("Delete this supplier?")) delSupMutation.mutate(s._id);
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
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {supPage} / {Math.max(1, Math.ceil((supList?.total || 0) / 25))} · {supList?.total ?? 0}{" "}
              suppliers
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={supPage <= 1}
                onClick={() => setSupPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={supPage >= Math.max(1, Math.ceil((supList?.total || 0) / 25))}
                onClick={() => setSupPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "summary" && summary && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Orders by status</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {Object.entries(summary.byStatus || {}).map(([k, v]) => (
                    <tr key={k}>
                      <td className="px-3 py-2">
                        <StatusBadge status={k} />
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">Top suppliers by order value</h3>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Supplier</th>
                    <th className="px-3 py-2 text-right">Value (sum)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(summary.topSuppliersByValue || []).map((r) => (
                    <tr key={r.supplierName}>
                      <td className="px-3 py-2">{r.supplierName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(r.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={() => {
                  const cols = [
                    { key: "supplierName", header: "Supplier" },
                    { key: "value", header: "Value" },
                  ];
                  downloadCsv(`po-summary-suppliers-${Date.now()}.csv`, cols, summary.topSuppliersByValue || []);
                }}
              >
                Export summary CSV
              </button>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={() =>
                  downloadPdfTable(
                    "PO summary — suppliers",
                    "By total order value",
                    [
                      { key: "supplierName", header: "Supplier" },
                      { key: "value", header: "Value" },
                    ],
                    (summary.topSuppliersByValue || []).map((r) => ({
                      ...r,
                      value: Number(r.value).toFixed(2),
                    })),
                    "po-summary"
                  )
                }
              >
                Export PDF
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "returns" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Purchase returns</h2>
              <p className="text-xs text-gray-500">
                Draft a return, then post to remove stock (supplier return).
              </p>
            </div>
            <button
              type="button"
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white"
              onClick={() => {
                setErr("");
                setRetOpen(true);
              }}
            >
              New return
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">Return #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {retLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center">
                      Loading…
                    </td>
                  </tr>
                ) : (returnsData?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No returns.
                    </td>
                  </tr>
                ) : (
                  (returnsData?.items ?? []).map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs">{r.returnNumber}</td>
                      <td className="px-4 py-2">{r.supplierName}</td>
                      <td className="px-4 py-2 text-gray-600">
                        {r.returnDate ? new Date(r.returnDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r.currency} {Number(r.grandTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => {
                            setRetDetailId(r._id);
                            setErr("");
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {retPage} / {Math.max(1, Math.ceil((returnsData?.total || 0) / 25))}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={retPage <= 1}
                onClick={() => setRetPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={retPage >= Math.max(1, Math.ceil((returnsData?.total || 0) / 25))}
                onClick={() => setRetPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === "pending" && (
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Pending purchase orders</h2>
              <p className="text-xs text-gray-500">
                Open and partially received — receipt progress per order.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={() => {
                  const items = pendingData?.items ?? [];
                  const cols = [
                    { key: "poNumber", header: "PO #" },
                    { key: "supplierName", header: "Supplier" },
                    { key: "status", header: "Status" },
                    { key: "receiptPercent", header: "Receipt %" },
                    { key: "pendingQty", header: "Pending qty" },
                  ];
                  const out = items.map((r) => ({
                    poNumber: r.poNumber,
                    supplierName: r.supplierName,
                    status: r.status,
                    receiptPercent: r._report?.receiptPercent,
                    pendingQty: r._report?.pendingQty,
                  }));
                  downloadCsv(`pending-po-${Date.now()}.csv`, cols, out);
                }}
                disabled={!(pendingData?.items?.length > 0)}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                onClick={exportPendingPdf}
                disabled={!(pendingData?.items?.length > 0)}
              >
                Export PDF
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs font-bold uppercase text-gray-600">
                <tr>
                  <th className="px-4 py-3">PO #</th>
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Receipt %</th>
                  <th className="px-4 py-3 text-right">Pending qty</th>
                  <th className="px-4 py-3 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pendLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center">
                      Loading…
                    </td>
                  </tr>
                ) : (pendingData?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                      No pending purchase orders.
                    </td>
                  </tr>
                ) : (
                  (pendingData?.items ?? []).map((r) => (
                    <tr key={r._id} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2 font-mono text-xs font-semibold">{r.poNumber}</td>
                      <td className="px-4 py-2">{r.supplierName}</td>
                      <td className="px-4 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {r._report?.receiptPercent ?? 0}%
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-amber-800">
                        {r._report?.pendingQty ?? 0}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => {
                            setDetailId(r._id);
                            setTab("orders");
                          }}
                        >
                          Open PO
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t px-4 py-2 text-xs text-gray-600">
            <span>
              Page {pendPage} / {Math.max(1, Math.ceil((pendingData?.total || 0) / 25))} ·{" "}
              {pendingData?.total ?? 0} rows
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={pendPage <= 1}
                onClick={() => setPendPage((p) => p - 1)}
              >
                Prev
              </button>
              <button
                type="button"
                className="rounded border px-2 py-0.5 disabled:opacity-40"
                disabled={pendPage >= Math.max(1, Math.ceil((pendingData?.total || 0) / 25))}
                onClick={() => setPendPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}

      <Modal
        open={!!detailId}
        onClose={() => setDetailId(null)}
        title={detail?.poNumber ? `Purchase order ${detail.poNumber}` : "Purchase order"}
        document
      >
        {!detail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-5 text-sm text-gray-800">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    Purchase order
                  </div>
                  <div className="mt-1 font-mono text-xl font-bold text-gray-900">{detail.poNumber}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <StatusBadge status={detail.status} />
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">{formatPoDate(detail.orderDate)}</span>
                    <span className="text-gray-400">·</span>
                    <span className="font-semibold tabular-nums text-gray-900">
                      {detail.currency} {Number(detail.grandTotal || 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-6 md:grid-cols-2">
                <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-gray-500">Buyer</div>
                  <div className="mt-1 font-semibold text-gray-900">
                    {detail.buyerLegalName || BUYER_DEFAULTS.buyerLegalName}
                  </div>
                  <div className="mt-1 whitespace-pre-line text-xs leading-relaxed text-gray-600">
                    {detail.buyerAddressLine || BUYER_DEFAULTS.buyerAddressLine}
                  </div>
                  <div className="mt-2 space-y-0.5 text-xs text-gray-600">
                    <div>Tel: {detail.buyerPhone || BUYER_DEFAULTS.buyerPhone}</div>
                    <div>{detail.buyerEmail || BUYER_DEFAULTS.buyerEmail}</div>
                    <div>{detail.buyerWeb || BUYER_DEFAULTS.buyerWeb}</div>
                  </div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-3">
                  <div className="text-[10px] font-bold uppercase text-gray-500">Supplier</div>
                  <div className="mt-1 font-semibold text-gray-900">{detail.supplierName}</div>
                  {detail.supplierAddress ? (
                    <div className="mt-1 whitespace-pre-line text-xs leading-relaxed text-gray-600">
                      {detail.supplierAddress}
                    </div>
                  ) : null}
                  <div className="mt-2 space-y-0.5 text-xs text-gray-600">
                    {detail.supplierPhone ? <div>Tel: {detail.supplierPhone}</div> : null}
                    {detail.supplierEmail ? <div>{detail.supplierEmail}</div> : null}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["Ref", detail.ref],
                  ["Int. ref", detail.intRef],
                  ["Contact person", detail.contactPerson],
                  ["Supplier reference", detail.supplierReference],
                  ["Offer date", detail.offerDate],
                  ["Currency", detail.currency],
                ].map(([lab, val]) => (
                  <div key={lab} className="text-xs">
                    <div className="font-semibold uppercase tracking-wide text-gray-500">{lab}</div>
                    <div className="mt-0.5 text-gray-900">{val ? String(val) : "—"}</div>
                  </div>
                ))}
              </div>

              {detail.remarks ? (
                <div className="mt-4 rounded-lg border border-dashed border-gray-200 bg-white p-3 text-xs">
                  <span className="font-semibold text-gray-500">Remarks: </span>
                  {detail.remarks}
                </div>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-[920px] w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-100 text-left">
                    <th className="px-2 py-2 font-bold text-gray-700">Pos</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Article Nr.</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Description</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Part Nr.</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Qty</th>
                    <th className="px-2 py-2 font-bold text-gray-700">UOM</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Unit rate</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Total</th>
                    <th className="px-2 py-2 text-right font-bold text-gray-700">Rcvd</th>
                    <th className="px-2 py-2 font-bold text-gray-700">Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines?.map((l, i) => (
                    <tr key={l._id} className="border-b border-gray-100">
                      <td className="px-2 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.articleNo || l.itemCode}</td>
                      <td className="px-2 py-2">{l.description || "—"}</td>
                      <td className="px-2 py-2 font-mono text-[11px]">{l.partNo || "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{l.qty}</td>
                      <td className="px-2 py-2">{l.uom || "PCS"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {Number(l.unitPrice || 0).toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">
                        {Number(l.lineTotal || 0).toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-600">
                        {l.receivedQty ?? 0}
                      </td>
                      <td className="px-2 py-2 text-gray-600">{l.remarks || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Delivery", detail.delivery],
                ["Insurance", detail.insurance],
                ["Packing", detail.packing],
                ["Freight", detail.freight],
                ["Taxes", detail.taxes],
                ["Payment", detail.payment],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-gray-100 p-3 text-xs">
                  <div className="font-bold uppercase text-gray-500">{k}</div>
                  <div className="mt-1 text-gray-800">{v || "—"}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-col items-end gap-1 border-t border-gray-100 pt-4 text-sm">
              <div className="flex w-full max-w-xs justify-between tabular-nums">
                <span className="text-gray-500">Sub total</span>
                <span className="font-medium">
                  {detail.currency} {Number(detail.subTotal ?? detail.grandTotal ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="flex w-full max-w-xs justify-between border-t border-gray-200 pt-1 text-base font-bold tabular-nums">
                <span>Grand total</span>
                <span>
                  {detail.currency} {Number(detail.grandTotal || 0).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-gray-100 bg-amber-50/30 p-3 text-xs">
              <div className="font-bold uppercase text-gray-600">Special remarks</div>
              <div className="mt-1 whitespace-pre-wrap text-gray-800">
                {detail.specialRemarks != null && detail.specialRemarks !== ""
                  ? detail.specialRemarks
                  : "—"}
              </div>
            </div>

            <div>
              <div className="text-[10px] font-bold uppercase text-gray-500">Terms &amp; conditions</div>
              <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs leading-relaxed text-gray-700 whitespace-pre-wrap">
                {detail.termsAndConditions?.trim()
                  ? detail.termsAndConditions
                  : "No terms text stored on this PO (older records may predate this field)."}
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs italic text-gray-600">
              {detail.closingNote || DEFAULT_CLOSING_NOTE}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                onClick={openReceive}
              >
                Receive stock
              </button>
              {detail.status === "DRAFT" && (
                <>
                  <button
                    type="button"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"
                    onClick={() => {
                      setErr("");
                      apiPatch(`/purchase-orders/${detail._id}/status`, { status: "SAVED" })
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
                          qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                          qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
                        })
                        .catch((e) => setErr(e.message));
                    }}
                  >
                    Mark saved
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold"
                    onClick={() => {
                      setErr("");
                      apiPatch(`/purchase-orders/${detail._id}/status`, { status: "SENT" })
                        .then(() => {
                          qc.invalidateQueries({ queryKey: ["purchaseOrder", detailId] });
                          qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
                          qc.invalidateQueries({ queryKey: ["purchaseSummary"] });
                        })
                        .catch((e) => setErr(e.message));
                    }}
                  >
                    Mark sent
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="Goods receipt" wide>
        <FormField label="Warehouse">
          <TextInput
            value={receiveWarehouse}
            onChange={(e) => setReceiveWarehouse(e.target.value)}
          />
        </FormField>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {receiveLines.map((rl, i) => (
            <div key={rl.lineId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-28 font-mono text-xs">{rl.itemCode}</span>
              <span className="text-gray-500">max {rl.max}</span>
              <TextInput
                className="w-24"
                type="number"
                value={rl.qty}
                onChange={(e) => {
                  const next = [...receiveLines];
                  next[i] = { ...next[i], qty: Number(e.target.value) };
                  setReceiveLines(next);
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setReceiveOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={receiveMutation.isPending}
            onClick={() => {
              setErr("");
              receiveMutation.mutate({
                warehouse: receiveWarehouse,
                lines: receiveLines
                  .filter((l) => l.qty > 0)
                  .map((l) => ({ lineId: l.lineId, qty: l.qty })),
              });
            }}
          >
            {receiveMutation.isPending ? "Posting…" : "Post receipt"}
          </button>
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setErr("");
          createMutation.reset();
        }}
        title="New purchase order"
        document
      >
        {err ? <div className="mb-3 text-sm text-red-600">{err}</div> : null}
        <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Document preview — saved as draft PO
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-gray-100 bg-gray-50/90 p-3">
              <div className="text-[10px] font-bold uppercase text-gray-500">Buyer</div>
              <FormField label="Legal name">
                <TextInput
                  value={form.buyerLegalName}
                  onChange={(e) => setForm((f) => ({ ...f, buyerLegalName: e.target.value }))}
                />
              </FormField>
              <FormField label="Address" className="mt-2">
                <textarea
                  rows={2}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  value={form.buyerAddressLine}
                  onChange={(e) => setForm((f) => ({ ...f, buyerAddressLine: e.target.value }))}
                />
              </FormField>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <FormField label="Phone">
                  <TextInput
                    value={form.buyerPhone}
                    onChange={(e) => setForm((f) => ({ ...f, buyerPhone: e.target.value }))}
                  />
                </FormField>
                <FormField label="Email">
                  <TextInput
                    value={form.buyerEmail}
                    onChange={(e) => setForm((f) => ({ ...f, buyerEmail: e.target.value }))}
                  />
                </FormField>
                <FormField label="Web" className="sm:col-span-2">
                  <TextInput
                    value={form.buyerWeb}
                    onChange={(e) => setForm((f) => ({ ...f, buyerWeb: e.target.value }))}
                  />
                </FormField>
              </div>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50/90 p-3">
              <div className="text-[10px] font-bold uppercase text-gray-500">Supplier</div>
              <FormField label="Supplier name *">
                <TextInput
                  list="supplier-pick"
                  value={form.supplierName}
                  onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
                  onBlur={(e) => applySupplierMasterDefaults(e.target.value)}
                />
                <datalist id="supplier-pick">
                  {(suppliersAll?.items ?? []).map((s) => (
                    <option key={s._id} value={s.name} />
                  ))}
                </datalist>
              </FormField>
              <FormField label="Address" className="mt-2">
                <textarea
                  rows={2}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  value={form.supplierAddress}
                  onChange={(e) => setForm((f) => ({ ...f, supplierAddress: e.target.value }))}
                />
              </FormField>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <FormField label="Phone">
                  <TextInput
                    value={form.supplierPhone}
                    onChange={(e) => setForm((f) => ({ ...f, supplierPhone: e.target.value }))}
                  />
                </FormField>
                <FormField label="Email">
                  <TextInput
                    value={form.supplierEmail}
                    onChange={(e) => setForm((f) => ({ ...f, supplierEmail: e.target.value }))}
                  />
                </FormField>
              </div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Ref">
              <TextInput value={form.ref} onChange={(e) => setForm((f) => ({ ...f, ref: e.target.value }))} />
            </FormField>
            <FormField label="Int. ref">
              <TextInput
                value={form.intRef}
                onChange={(e) => setForm((f) => ({ ...f, intRef: e.target.value }))}
              />
            </FormField>
            <FormField label="Contact person">
              <TextInput
                value={form.contactPerson}
                onChange={(e) => setForm((f) => ({ ...f, contactPerson: e.target.value }))}
              />
            </FormField>
            <FormField label="Supplier reference">
              <TextInput
                value={form.supplierReference}
                onChange={(e) => setForm((f) => ({ ...f, supplierReference: e.target.value }))}
              />
            </FormField>
            <FormField label="Offer date">
              <TextInput
                value={form.offerDate}
                onChange={(e) => setForm((f) => ({ ...f, offerDate: e.target.value }))}
                placeholder="e.g. 12-Feb-26"
              />
            </FormField>
            <FormField label="PO date">
              <TextInput
                type="date"
                value={form.orderDate}
                onChange={(e) => setForm((f) => ({ ...f, orderDate: e.target.value }))}
              />
            </FormField>
            <FormField label="Currency">
              <TextInput
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              />
            </FormField>
            <FormField label="Header remarks">
              <TextInput
                value={form.remarks}
                onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                placeholder="Optional notes on the PO"
              />
            </FormField>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-gray-600">Line items</span>
              <button
                type="button"
                className="text-xs font-semibold text-gray-800 underline"
                onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, defaultLine()] }))}
              >
                + Add line
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-[920px] w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-100 text-left">
                    <th className="px-1.5 py-2 font-bold text-gray-700">Pos</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Article Nr.</th>
                    <th className="min-w-[120px] px-1.5 py-2 font-bold text-gray-700">Description</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Part Nr.</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Qty</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">UOM</th>
                    <th className="px-1.5 py-2 font-bold text-gray-700">Unit rate</th>
                    <th className="px-1.5 py-2 text-right font-bold text-gray-700">Total</th>
                    <th className="min-w-[72px] px-1.5 py-2 font-bold text-gray-700">Remark</th>
                    <th className="w-8 px-1 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {form.lines.map((line, idx) => {
                    const lineTot = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
                    const setLine = (patch) => {
                      const lines = [...form.lines];
                      lines[idx] = { ...lines[idx], ...patch };
                      setForm((f) => ({ ...f, lines }));
                    };
                    return (
                      <tr key={idx} className="border-b border-gray-100 align-top">
                        <td className="px-1.5 py-1.5 text-gray-500">{idx + 1}</td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Article"
                            value={line.articleNo}
                            onChange={(e) => setLine({ articleNo: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Description"
                            value={line.description}
                            onChange={(e) => setLine({ description: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            placeholder="Part"
                            value={line.partNo}
                            onChange={(e) => setLine({ partNo: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            type="number"
                            min={0}
                            value={line.qty}
                            onChange={(e) => setLine({ qty: Number(e.target.value) })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            value={line.uom}
                            onChange={(e) => setLine({ uom: e.target.value })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            type="number"
                            step="0.01"
                            min={0}
                            value={line.unitPrice}
                            onChange={(e) => setLine({ unitPrice: Number(e.target.value) })}
                          />
                        </td>
                        <td className="px-1.5 py-1.5 text-right tabular-nums font-medium text-gray-800">
                          {lineTot.toFixed(2)}
                        </td>
                        <td className="px-1.5 py-1.5">
                          <TextInput
                            className="py-1.5 text-[11px]"
                            value={line.remarks}
                            onChange={(e) => setLine({ remarks: e.target.value })}
                          />
                        </td>
                        <td className="px-0.5 py-1.5">
                          <button
                            type="button"
                            className="rounded border border-gray-200 px-1.5 py-0.5 text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            disabled={form.lines.length <= 1}
                            title="Remove line"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                lines: f.lines.filter((_, i) => i !== idx),
                              }))
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[10px] text-gray-500">
              Inventory uses Article Nr., internal code, or Part Nr. (at least one required per line).
            </p>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Delivery">
              <TextInput
                value={form.delivery}
                onChange={(e) => setForm((f) => ({ ...f, delivery: e.target.value }))}
              />
            </FormField>
            <FormField label="Insurance">
              <TextInput
                value={form.insurance}
                onChange={(e) => setForm((f) => ({ ...f, insurance: e.target.value }))}
              />
            </FormField>
            <FormField label="Packing">
              <TextInput
                value={form.packing}
                onChange={(e) => setForm((f) => ({ ...f, packing: e.target.value }))}
              />
            </FormField>
            <FormField label="Freight">
              <TextInput
                value={form.freight}
                onChange={(e) => setForm((f) => ({ ...f, freight: e.target.value }))}
              />
            </FormField>
            <FormField label="Taxes">
              <TextInput
                value={form.taxes}
                onChange={(e) => setForm((f) => ({ ...f, taxes: e.target.value }))}
              />
            </FormField>
            <FormField label="Payment">
              <TextInput
                value={form.payment}
                onChange={(e) => setForm((f) => ({ ...f, payment: e.target.value }))}
              />
            </FormField>
          </div>

          <div className="mt-4 flex flex-col items-end gap-1 border-t border-gray-100 pt-4 text-sm">
            <div className="flex w-full max-w-xs justify-between tabular-nums">
              <span className="text-gray-500">Sub total</span>
              <span className="font-medium">
                {form.currency} {poPreviewTotals.subTotal.toFixed(2)}
              </span>
            </div>
            <div className="flex w-full max-w-xs justify-between border-t border-gray-200 pt-1 text-base font-bold tabular-nums">
              <span>Grand total</span>
              <span>
                {form.currency} {poPreviewTotals.grandTotal.toFixed(2)}
              </span>
            </div>
          </div>

          <FormField label="Special remarks" className="mt-4">
            <TextInput
              value={form.specialRemarks}
              onChange={(e) => setForm((f) => ({ ...f, specialRemarks: e.target.value }))}
            />
          </FormField>

          <FormField label="Terms & conditions" className="mt-3">
            <textarea
              rows={8}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-xs leading-relaxed focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              value={form.termsAndConditions}
              onChange={(e) => setForm((f) => ({ ...f, termsAndConditions: e.target.value }))}
            />
          </FormField>

          <FormField label="Closing note" className="mt-3">
            <textarea
              rows={2}
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm italic focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              value={form.closingNote}
              onChange={(e) => setForm((f) => ({ ...f, closingNote: e.target.value }))}
            />
          </FormField>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setCreateOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => {
              setErr("");
              const body = buildPoPayload(form);
              if (!body.supplierName) {
                setErr("Supplier name is required.");
                return;
              }
              if (!body.lines.length) {
                setErr("Add at least one line with Article Nr., code, or Part Nr. and quantity.");
                return;
              }
              createMutation.mutate(body);
            }}
          >
            {createMutation.isPending ? "Saving…" : "Create"}
          </button>
        </div>
      </Modal>

      <Modal open={supModal} onClose={() => setSupModal(false)} title={supEditing ? "Edit supplier" : "New supplier"} wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier code (optional)">
            <TextInput
              value={supForm.supplierCode}
              onChange={(e) => setSupForm((f) => ({ ...f, supplierCode: e.target.value }))}
              disabled={!supEditing}
            />
          </FormField>
          <FormField label="Name *">
            <TextInput
              value={supForm.name}
              onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))}
            />
          </FormField>
          <FormField label="Contact">
            <TextInput
              value={supForm.contactName}
              onChange={(e) => setSupForm((f) => ({ ...f, contactName: e.target.value }))}
            />
          </FormField>
          <FormField label="Phone">
            <TextInput
              value={supForm.phone}
              onChange={(e) => setSupForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </FormField>
          <FormField label="Email" className="sm:col-span-2">
            <TextInput
              value={supForm.email}
              onChange={(e) => setSupForm((f) => ({ ...f, email: e.target.value }))}
            />
          </FormField>
          <FormField label="Address" className="sm:col-span-2">
            <TextInput
              value={supForm.address}
              onChange={(e) => setSupForm((f) => ({ ...f, address: e.target.value }))}
            />
          </FormField>
          <FormField label="GST #">
            <TextInput
              value={supForm.gstNo}
              onChange={(e) => setSupForm((f) => ({ ...f, gstNo: e.target.value }))}
            />
          </FormField>
          <FormField label="PAN #">
            <TextInput
              value={supForm.panNo}
              onChange={(e) => setSupForm((f) => ({ ...f, panNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Notes" className="sm:col-span-2">
            <TextInput
              value={supForm.notes}
              onChange={(e) => setSupForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setSupModal(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={saveSupMutation.isPending}
            onClick={() => saveSupMutation.mutate()}
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={retOpen} onClose={() => setRetOpen(false)} title="New purchase return" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              list="supplier-pick-ret"
              value={retForm.supplierName}
              onChange={(e) => setRetForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
            <datalist id="supplier-pick-ret">
              {(suppliersAll?.items ?? []).map((s) => (
                <option key={s._id} value={s.name} />
              ))}
            </datalist>
          </FormField>
          <FormField label="Linked PO #">
            <TextInput
              value={retForm.linkedPoNumber}
              onChange={(e) => setRetForm((f) => ({ ...f, linkedPoNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Warehouse">
            <TextInput
              value={retForm.warehouse}
              onChange={(e) => setRetForm((f) => ({ ...f, warehouse: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={retForm.currency}
              onChange={(e) => setRetForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={retForm.remarks}
              onChange={(e) => setRetForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between">
            <span className="text-sm font-semibold">Lines</span>
            <button
              type="button"
              className="text-sm underline"
              onClick={() =>
                setRetForm((f) => ({ ...f, lines: [...f.lines, defaultPrLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {retForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-5">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.unitPrice}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], unitPrice: Number(e.target.value) };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Reason"
                className="sm:col-span-2"
                value={line.reason}
                onChange={(e) => {
                  const lines = [...retForm.lines];
                  lines[idx] = { ...lines[idx], reason: e.target.value };
                  setRetForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setRetOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={createRetMutation.isPending}
            onClick={() => {
              setErr("");
              createRetMutation.mutate();
            }}
          >
            Create draft
          </button>
        </div>
      </Modal>

      <Modal open={!!retDetailId} onClose={() => setRetDetailId(null)} title="Purchase return" wide>
        {!retDetail ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4 rounded-lg border bg-slate-50 p-3">
              <div>
                <span className="text-xs font-semibold text-gray-500">Return</span>
                <div className="font-mono font-bold">{retDetail.returnNumber}</div>
              </div>
              <div>
                <span className="text-xs font-semibold text-gray-500">Supplier</span>
                <div>{retDetail.supplierName}</div>
              </div>
              <div>
                <StatusBadge status={retDetail.status} />
              </div>
            </div>
            <div className="overflow-x-auto rounded border">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="px-2 py-1 text-left">Item</th>
                    <th className="px-2 py-1 text-right">Qty</th>
                    <th className="px-2 py-1 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {retDetail.lines?.map((l) => (
                    <tr key={l._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{l.itemCode}</td>
                      <td className="px-2 py-1 text-right">{l.qty}</td>
                      <td className="px-2 py-1 text-right">{l.unitPrice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {retDetail.status === "DRAFT" && (
              <button
                type="button"
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={postRetMutation.isPending}
                onClick={() => {
                  if (confirm("Post return and deduct stock?")) postRetMutation.mutate(retDetail._id);
                }}
              >
                Post to inventory
              </button>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
