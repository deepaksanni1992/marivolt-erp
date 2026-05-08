import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import Modal from "../components/erp/Modal.jsx";

const TABS = [
  "GRN",
  "Stock View",
  "Stock Ledger",
  "Stock Adjustment",
  "Stock Transfer",
  "Locations",
  "Negative Allocation Report",
];

function NegativeBadge({ value }) {
  if (!Number.isFinite(value) || value >= 0) return null;
  return (
    <span className="ml-2 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-800 ring-1 ring-rose-200">
      Backorder ({value})
    </span>
  );
}

function StatusPill({ status, tone = "slate" }) {
  const palette = {
    slate: "bg-slate-100 text-slate-800 ring-slate-200",
    rose: "bg-rose-100 text-rose-800 ring-rose-200",
    amber: "bg-amber-100 text-amber-800 ring-amber-200",
    emerald: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    indigo: "bg-indigo-100 text-indigo-800 ring-indigo-200",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${palette[tone] || palette.slate}`}>{status}</span>
  );
}

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

function fmtDateOnly(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return String(d);
  }
}

export default function StoreModule() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("GRN");
  const [article, setArticle] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [location, setLocation] = useState("");
  const [refNo, setRefNo] = useState("");
  const [search, setSearch] = useState("");
  const [stockCustomer, setStockCustomer] = useState("");
  const [stockReferenceNo, setStockReferenceNo] = useState("");
  const [negativeOnly, setNegativeOnly] = useState(false);
  const [allocatedOnly, setAllocatedOnly] = useState(false);
  const [allocationDrillDown, setAllocationDrillDown] = useState({ open: false, article: "", warehouse: "" });

  // Unified-ledger filters (used only inside the Stock Ledger tab).
  const [ledgerMovementType, setLedgerMovementType] = useState("");
  const [ledgerCustomer, setLedgerCustomer] = useState("");
  const [ledgerSourceModel, setLedgerSourceModel] = useState("");
  const [ledgerDateFrom, setLedgerDateFrom] = useState("");
  const [ledgerDateTo, setLedgerDateTo] = useState("");
  const [adj, setAdj] = useState({
    adjustmentNo: "",
    date: new Date().toISOString().slice(0, 10),
    article: "",
    location: "",
    adjustmentType: "Increase",
    quantity: 0,
    reason: "",
    remarks: "",
  });
  const [trf, setTrf] = useState({
    transferNo: "",
    date: new Date().toISOString().slice(0, 10),
    article: "",
    fromLocation: "",
    toLocation: "",
    quantity: 0,
    remarks: "",
  });
  const [loc, setLoc] = useState({
    locationCode: "",
    locationName: "",
    warehouse: "",
    rack: "",
    bin: "",
    status: "Active",
  });
  const [editLoc, setEditLoc] = useState("");

  const { data: grns } = useQuery({
    queryKey: ["grn"],
    queryFn: () => apiGetWithQuery("/grn", { limit: 200 }),
    enabled: tab === "GRN",
  });

  const { data: balance } = useQuery({
    queryKey: [
      "stock-summary",
      article,
      warehouse,
      location,
      search,
      stockCustomer,
      stockReferenceNo,
      negativeOnly,
      allocatedOnly,
    ],
    queryFn: () =>
      apiGetWithQuery("/store/stock-summary", {
        article: article || undefined,
        warehouse: warehouse || undefined,
        location: location || undefined,
        search: search || undefined,
        customer: stockCustomer || undefined,
        referenceNo: stockReferenceNo || undefined,
        negativeOnly: negativeOnly ? "true" : undefined,
        allocatedOnly: allocatedOnly ? "true" : undefined,
        limit: 500,
      }),
    enabled: tab === "Stock View",
    refetchInterval: tab === "Stock View" ? 30000 : false,
  });

  // Unified Stock Ledger (Phase 3) — multi-source projection that merges
  // StockLedger entries (GRN / Adjustment / Transfer / sales-side stock
  // movements) with InventoryLedger entries (sales reservation, RTS,
  // invoicing, cancellations). The Store > Stock Ledger tab now uses
  // only this endpoint; the legacy /stock/ledger endpoint stays in place
  // for backward compatibility but is no longer consumed by the UI.
  const { data: ledger } = useQuery({
    queryKey: [
      "stock-ledger-unified",
      article,
      warehouse,
      location,
      refNo,
      ledgerMovementType,
      ledgerCustomer,
      ledgerSourceModel,
      ledgerDateFrom,
      ledgerDateTo,
    ],
    queryFn: () =>
      apiGetWithQuery("/store/stock-ledger/unified", {
        article: article || undefined,
        warehouse: warehouse || location || undefined,
        referenceNo: refNo || undefined,
        movementType: ledgerMovementType || undefined,
        customerName: ledgerCustomer || undefined,
        sourceModel: ledgerSourceModel || undefined,
        dateFrom: ledgerDateFrom || undefined,
        dateTo: ledgerDateTo || undefined,
        limit: 500,
      }),
    enabled: tab === "Stock Ledger",
  });

  const { data: stockMeta } = useQuery({
    queryKey: ["stock-meta"],
    queryFn: () => apiGet("/stock/meta"),
    enabled: tab === "Stock Ledger",
    staleTime: 5 * 60 * 1000,
  });

  const { data: locations } = useQuery({
    queryKey: ["stock-locations"],
    queryFn: () => apiGet("/stock/locations"),
    enabled: tab === "Locations",
  });

  const { data: negativeReport } = useQuery({
    queryKey: ["stock-negative-allocations", article, warehouse, location, search],
    queryFn: () =>
      apiGetWithQuery("/store/negative-allocations", {
        article: article || undefined,
        warehouse: warehouse || undefined,
        location: location || undefined,
        customer: search || undefined,
      }),
    enabled: tab === "Negative Allocation Report",
  });

  const { data: customerAllocations } = useQuery({
    queryKey: [
      "stock-customer-allocations",
      allocationDrillDown.article,
      allocationDrillDown.warehouse,
    ],
    queryFn: () =>
      apiGetWithQuery("/store/customer-allocations", {
        article: allocationDrillDown.article,
        warehouse: allocationDrillDown.warehouse || undefined,
      }),
    enabled: allocationDrillDown.open && Boolean(allocationDrillDown.article),
  });

  const createAdj = useMutation({
    mutationFn: () => apiPost("/stock/adjustment", adj),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] }),
  });
  const postAdj = useMutation({
    mutationFn: () => apiPost(`/stock/adjustment/${adj.adjustmentNo}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["stock-negative-allocations"] });
      qc.invalidateQueries({ queryKey: ["stock-customer-allocations"] });
    },
  });
  const createTrf = useMutation({
    mutationFn: () => apiPost("/stock/transfer", trf),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] }),
  });
  const postTrf = useMutation({
    mutationFn: () => apiPost(`/stock/transfer/${trf.transferNo}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["stock-negative-allocations"] });
      qc.invalidateQueries({ queryKey: ["stock-customer-allocations"] });
    },
  });
  const saveLoc = useMutation({
    mutationFn: () => (editLoc ? apiPut(`/stock/locations/${editLoc}`, loc) : apiPost("/stock/locations", loc)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stock-locations"] });
      setEditLoc("");
    },
  });
  const deleteLoc = useMutation({
    mutationFn: (code) => apiDelete(`/stock/locations/${code}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-locations"] }),
  });

  const stockRows = balance?.items || [];
  const ledgerRows = ledger?.items || [];
  const locationRows = locations || [];
  const negativeRows = negativeReport?.items || [];

  const stockViewColumns = useMemo(
    () => [
      { key: "article", header: "Article" },
      { key: "itemName", header: "Item Name" },
      { key: "warehouse", header: "Warehouse" },
      { key: "location", header: "Location" },
      { key: "onHandQty", header: "On Hand" },
      { key: "allocatedQty", header: "Allocated" },
      { key: "rtsQty", header: "RTS" },
      { key: "availableQty", header: "Available" },
      { key: "uom", header: "UOM" },
      { key: "negativeStatus", header: "Negative Status" },
      { key: "lastMovementDate", header: "Last Movement Date" },
    ],
    []
  );

  const stockViewExportRows = useMemo(
    () =>
      stockRows.map((r) => ({
        ...r,
        itemName: r.itemName || r.item?.itemName || "",
        uom: r.uom || r.item?.uom || "",
        negativeStatus: r.negativeStatus || (Number(r.availableQty) < 0 ? "NEGATIVE / BACKORDER" : Number(r.availableQty) === 0 ? "ZERO STOCK" : "OK"),
        lastMovementDate: r.lastMovementDate ? new Date(r.lastMovementDate).toISOString() : "",
      })),
    [stockRows]
  );

  const ledgerColumns = useMemo(
    () => [
      { key: "date", header: "Date" },
      { key: "article", header: "Article" },
      { key: "itemName", header: "Item Name" },
      { key: "movementType", header: "Movement Type" },
      { key: "rawMovementType", header: "Raw Type" },
      { key: "referenceType", header: "Reference Type" },
      { key: "referenceNo", header: "Reference No" },
      { key: "customerName", header: "Customer" },
      { key: "supplierName", header: "Supplier" },
      { key: "warehouse", header: "Warehouse" },
      { key: "locationFrom", header: "Location From" },
      { key: "locationTo", header: "Location To" },
      { key: "qtyIn", header: "Qty In" },
      { key: "qtyOut", header: "Qty Out" },
      { key: "onHandAfter", header: "On Hand After" },
      { key: "allocatedAfter", header: "Allocated After" },
      { key: "rtsAfter", header: "RTS After" },
      { key: "availableAfter", header: "Available After" },
      { key: "sourceModel", header: "Source" },
      { key: "createdBy", header: "Created By" },
      { key: "remarks", header: "Remarks" },
    ],
    []
  );

  const ledgerExportRows = useMemo(
    () =>
      ledgerRows.map((r) => ({
        ...r,
        date: r.date ? new Date(r.date).toISOString() : "",
        onHandAfter: r.onHandAfter ?? "",
        allocatedAfter: r.allocatedAfter ?? "",
        rtsAfter: r.rtsAfter ?? "",
        availableAfter: r.availableAfter ?? "",
      })),
    [ledgerRows]
  );

  const negativeReportColumns = useMemo(
    () => [
      { key: "article", header: "Article" },
      { key: "itemName", header: "Item Name" },
      { key: "customerName", header: "Customer" },
      { key: "referenceNo", header: "Reference No" },
      { key: "referenceType", header: "Reference Type" },
      { key: "warehouse", header: "Warehouse" },
      { key: "location", header: "Location" },
      { key: "onHandQty", header: "On Hand" },
      { key: "allocatedQty", header: "Allocated" },
      { key: "rtsQty", header: "RTS" },
      { key: "availableQty", header: "Available" },
      { key: "negativeQty", header: "Negative Qty" },
      { key: "lastMovementDate", header: "Last Movement Date" },
    ],
    []
  );

  const negativeReportFlatRows = useMemo(() => {
    const rows = [];
    for (const r of negativeRows) {
      if (!r.allocations?.length) {
        rows.push({
          article: r.article,
          itemName: r.itemName,
          customerName: "",
          referenceNo: "",
          referenceType: "",
          warehouse: r.warehouse || r.location,
          location: r.location,
          allocatedQty: "",
          onHandQty: r.onHandQty,
          rtsQty: r.rtsQty,
          availableQty: r.availableQty,
          negativeQty: r.negativeQty ?? r.shortageQty,
          lastMovementDate: r.lastMovementDate ? new Date(r.lastMovementDate).toISOString() : "",
        });
      } else {
        for (const a of r.allocations) {
          rows.push({
            article: r.article,
            itemName: r.itemName,
            customerName: a.customerName,
            referenceNo: a.referenceNo,
            referenceType: a.referenceType,
            warehouse: r.warehouse || a.warehouse || r.location,
            location: r.location,
            allocatedQty: a.allocatedQty,
            onHandQty: r.onHandQty,
            rtsQty: r.rtsQty,
            availableQty: r.availableQty,
            negativeQty: r.negativeQty ?? r.shortageQty,
            lastMovementDate: r.lastMovementDate ? new Date(r.lastMovementDate).toISOString() : "",
          });
        }
      }
    }
    return rows;
  }, [negativeRows]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h1 className="text-2xl font-semibold">Store</h1>
        <p className="text-sm text-slate-600">
          GRN, Stock View, Stock Ledger, Adjustment, Transfer, Locations, Negative Allocation Report
        </p>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            className={
              tab === x
                ? "rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
                : "rounded-lg px-3 py-2 text-sm hover:bg-slate-100"
            }
          >
            {x}
          </button>
        ))}
      </div>

      {tab === "GRN" ? (
        <div className="rounded-2xl border bg-white p-4">
          <p className="mb-2 text-sm text-slate-600">
            Use API endpoints: create draft (<code>POST /api/grn</code>), post (<code>POST /api/grn/:grnNo/post</code>), cancel (<code>POST /api/grn/:grnNo/cancel</code>).
          </p>
          <div className="flex flex-wrap gap-2">
            {(grns?.items || []).map((g) => (
              <span key={g._id} className="rounded border px-2 py-1 text-xs">
                {g.grnNo} ({g.status})
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "Stock View" ? (
        <div className="space-y-3">
          <div className="rounded-2xl border bg-white p-4">
            <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-6">
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Article"
                value={article}
                onChange={(e) => setArticle(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Warehouse"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Location"
                value={location}
                onChange={(e) => setLocation(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Search article/item/location"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Customer"
                value={stockCustomer}
                onChange={(e) => setStockCustomer(e.target.value)}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Reference No"
                value={stockReferenceNo}
                onChange={(e) => setStockReferenceNo(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={negativeOnly}
                    onChange={(e) => setNegativeOnly(e.target.checked)}
                  />
                  Negative only
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allocatedOnly}
                    onChange={(e) => setAllocatedOnly(e.target.checked)}
                  />
                  Allocated only
                </label>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => downloadCsv("stock-view.csv", stockViewColumns, stockViewExportRows)}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => downloadPdfTable("Stock View", "", stockViewColumns, stockViewExportRows, "stock-view")}
              >
                Export PDF
              </button>
            </div>
          </div>
          <div className="overflow-auto rounded-2xl border bg-white shadow-sm">
            <table className="min-w-[1100px] w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 shadow-sm">
                <tr>
                  {[
                    "Article",
                    "Item Name",
                    "Warehouse",
                    "Location",
                    "On Hand",
                    "Allocated",
                    "RTS",
                    "Available",
                    "UOM",
                    "Negative Status",
                    "Last Movement",
                    "Actions",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockRows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-2 py-6 text-center text-sm text-slate-500">
                      No stock balance rows match the current filters.
                    </td>
                  </tr>
                ) : (
                  stockRows.map((r) => {
                    const available = Number(r.availableQty) || 0;
                    const negative = available < 0;
                    const zero = available === 0;
                    return (
                      <tr key={r._id} className={`border-t ${negative ? "bg-rose-50/60" : zero ? "bg-amber-50/50" : "hover:bg-slate-50"}`}>
                        <td className="px-2 py-1 font-mono">{r.article}</td>
                        <td className="px-2 py-1">{r.itemName || r.item?.itemName || ""}</td>
                        <td className="px-2 py-1">{r.warehouse || r.location}</td>
                        <td className="px-2 py-1">{r.location}</td>
                        <td className="px-2 py-1">{r.onHandQty}</td>
                        <td className="px-2 py-1">{r.allocatedQty}</td>
                        <td className="px-2 py-1">{r.rtsQty}</td>
                        <td className={`px-2 py-1 font-semibold ${negative ? "text-rose-700" : zero ? "text-amber-700" : ""}`}>
                          {r.availableQty}
                        </td>
                        <td className="px-2 py-1">{r.uom || r.item?.uom || ""}</td>
                        <td className="px-2 py-1">
                          {negative ? (
                            <StatusPill status="NEGATIVE / BACKORDER" tone="rose" />
                          ) : zero ? (
                            <StatusPill status="ZERO STOCK" tone="amber" />
                          ) : (
                            <StatusPill status="OK" tone="emerald" />
                          )}
                        </td>
                        <td className="px-2 py-1 text-xs text-slate-600">{fmtDate(r.lastMovementDate)}</td>
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            className="rounded border px-2 py-1 text-xs hover:bg-slate-50"
                            onClick={() =>
                              setAllocationDrillDown({
                                open: true,
                                article: r.article,
                                warehouse: r.location || "",
                              })
                            }
                          >
                            View Allocation
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "Stock Ledger" ? (
        <div className="space-y-3">
          <div className="rounded-2xl border bg-white p-4">
            <div className="mb-2 text-xs text-slate-500">
              Unified projection — merges
              <span className="font-medium"> StockLedger </span>
              (GRN / Adjustment / Transfer) with
              <span className="font-medium"> InventoryLedger </span>
              (Sales reserve / RTS / Invoice / Cancellation).
            </div>
            <div className="grid gap-3 md:grid-cols-5">
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Article"
                value={article}
                onChange={(e) => setArticle(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Warehouse"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Reference No"
                value={refNo}
                onChange={(e) => setRefNo(e.target.value)}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Customer / Supplier"
                value={ledgerCustomer}
                onChange={(e) => setLedgerCustomer(e.target.value)}
              />
              <select
                className="rounded border px-3 py-2 text-sm"
                value={ledgerMovementType}
                onChange={(e) => setLedgerMovementType(e.target.value)}
              >
                <option value="">All movement types</option>
                {(stockMeta?.unifiedMovementTypes || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                className="rounded border px-3 py-2 text-sm"
                value={ledgerSourceModel}
                onChange={(e) => setLedgerSourceModel(e.target.value)}
              >
                <option value="">All sources</option>
                {(stockMeta?.sourceModels || ["StockLedger", "InventoryLedger"]).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                className="rounded border px-3 py-2 text-sm"
                type="date"
                placeholder="Date from"
                value={ledgerDateFrom}
                onChange={(e) => setLedgerDateFrom(e.target.value)}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                type="date"
                placeholder="Date to"
                value={ledgerDateTo}
                onChange={(e) => setLedgerDateTo(e.target.value)}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => {
                  setLedgerMovementType("");
                  setLedgerCustomer("");
                  setLedgerSourceModel("");
                  setLedgerDateFrom("");
                  setLedgerDateTo("");
                }}
              >
                Clear filters
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => downloadCsv("stock-ledger.csv", ledgerColumns, ledgerExportRows)}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                onClick={() => downloadPdfTable("Stock Ledger", "Unified projection", ledgerColumns, ledgerExportRows, "stock-ledger")}
              >
                Export PDF
              </button>
              {ledger?.sources?.capped ? (
                <span className="text-xs text-amber-700">
                  Showing the most recent {(ledger.sources.stockLedger || 0) + (ledger.sources.inventoryLedger || 0)} rows — refine filters to drill in further.
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Source counts — StockLedger: {ledger?.sources?.stockLedger ?? 0} · InventoryLedger: {ledger?.sources?.inventoryLedger ?? 0}
                </span>
              )}
            </div>
          </div>
          <div className="overflow-auto rounded-2xl border bg-white">
            <table className="min-w-[1600px] w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  {[
                    "Date",
                    "Article",
                    "Item Name",
                    "Movement Type",
                    "Reference",
                    "Customer / Supplier",
                    "Warehouse",
                    "From → To",
                    "Qty In",
                    "Qty Out",
                    "On Hand After",
                    "Allocated After",
                    "RTS After",
                    "Available After",
                    "Source",
                    "Created By",
                    "Remarks",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ledgerRows.length === 0 ? (
                  <tr>
                    <td colSpan={17} className="px-2 py-6 text-center text-sm text-slate-500">
                      No ledger entries yet for this filter.
                    </td>
                  </tr>
                ) : (
                  ledgerRows.map((r) => {
                    const movementTone =
                      r.movementType === "ALLOCATION"
                        ? "indigo"
                        : r.movementType === "ALLOCATION_CANCEL"
                          ? "amber"
                          : r.movementType === "RTS_TRANSFER"
                            ? "emerald"
                            : r.movementType === "RTS_CANCEL"
                              ? "amber"
                              : r.movementType === "SALES_INVOICE_OUT"
                                ? "rose"
                                : r.movementType === "SALES_INVOICE_CANCEL"
                                  ? "amber"
                                  : r.movementType === "GRN_IN"
                                    ? "emerald"
                                    : "slate";
                    const fromTo =
                      r.locationFrom || r.locationTo
                        ? `${r.locationFrom || "—"} → ${r.locationTo || "—"}`
                        : "";
                    const partyName = r.customerName || r.supplierName || "";
                    const partyKind = r.customerName ? "Customer" : r.supplierName ? "Supplier" : "";
                    return (
                      <tr key={`${r.sourceModel}-${r._rowId}`} className="border-t align-top">
                        <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.date)}</td>
                        <td className="px-2 py-1 font-mono">{r.article}</td>
                        <td className="px-2 py-1">{r.itemName || ""}</td>
                        <td className="px-2 py-1">
                          <StatusPill status={r.movementType} tone={movementTone} />
                          {r.rawMovementType && r.rawMovementType !== r.movementType ? (
                            <div className="mt-1 text-[10px] text-slate-500">{r.rawMovementType}</div>
                          ) : null}
                        </td>
                        <td className="px-2 py-1">
                          {r.referenceType ? (
                            <span className="text-[10px] uppercase tracking-wide text-slate-500">
                              {r.referenceType}
                            </span>
                          ) : null}
                          <div>{r.referenceNo || ""}</div>
                        </td>
                        <td className="px-2 py-1">
                          {partyName ? (
                            <>
                              <div className="text-xs">{partyName}</div>
                              {partyKind ? (
                                <div className="text-[10px] uppercase tracking-wide text-slate-500">{partyKind}</div>
                              ) : null}
                            </>
                          ) : null}
                        </td>
                        <td className="px-2 py-1">{r.warehouse || ""}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{fromTo}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.qtyIn || 0}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.qtyOut || 0}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.onHandAfter == null ? <span className="text-slate-400">—</span> : r.onHandAfter}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.allocatedAfter == null ? <span className="text-slate-400">—</span> : r.allocatedAfter}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.rtsAfter == null ? <span className="text-slate-400">—</span> : r.rtsAfter}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.availableAfter == null ? <span className="text-slate-400">—</span> : r.availableAfter}
                        </td>
                        <td className="px-2 py-1">
                          <StatusPill
                            status={r.sourceModel}
                            tone={r.sourceModel === "InventoryLedger" ? "indigo" : "slate"}
                          />
                        </td>
                        <td className="px-2 py-1 text-xs text-slate-500">{r.createdBy || ""}</td>
                        <td className="px-2 py-1 text-xs text-slate-600">{r.remarks || ""}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "Stock Adjustment" ? (
        <div className="rounded-2xl border bg-white p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Adjustment No"
              value={adj.adjustmentNo}
              onChange={(e) => setAdj((s) => ({ ...s, adjustmentNo: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              type="date"
              value={adj.date}
              onChange={(e) => setAdj((s) => ({ ...s, date: e.target.value }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Article"
              value={adj.article}
              onChange={(e) => setAdj((s) => ({ ...s, article: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Location"
              value={adj.location}
              onChange={(e) => setAdj((s) => ({ ...s, location: e.target.value.toUpperCase() }))}
            />
            <select
              className="rounded border px-3 py-2 text-sm"
              value={adj.adjustmentType}
              onChange={(e) => setAdj((s) => ({ ...s, adjustmentType: e.target.value }))}
            >
              <option>Increase</option>
              <option>Decrease</option>
            </select>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="number"
              placeholder="Quantity"
              value={adj.quantity}
              onChange={(e) => setAdj((s) => ({ ...s, quantity: Number(e.target.value) }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Reason"
              value={adj.reason}
              onChange={(e) => setAdj((s) => ({ ...s, reason: e.target.value }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Remarks"
              value={adj.remarks}
              onChange={(e) => setAdj((s) => ({ ...s, remarks: e.target.value }))}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => createAdj.mutate()}
              className="rounded bg-slate-900 px-3 py-2 text-sm text-white"
            >
              Create Draft
            </button>
            <button
              type="button"
              onClick={() => postAdj.mutate()}
              className="rounded border px-3 py-2 text-sm"
            >
              Post
            </button>
          </div>
        </div>
      ) : null}

      {tab === "Stock Transfer" ? (
        <div className="rounded-2xl border bg-white p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Transfer No"
              value={trf.transferNo}
              onChange={(e) => setTrf((s) => ({ ...s, transferNo: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              type="date"
              value={trf.date}
              onChange={(e) => setTrf((s) => ({ ...s, date: e.target.value }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Article"
              value={trf.article}
              onChange={(e) => setTrf((s) => ({ ...s, article: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="From Location"
              value={trf.fromLocation}
              onChange={(e) => setTrf((s) => ({ ...s, fromLocation: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="To Location"
              value={trf.toLocation}
              onChange={(e) => setTrf((s) => ({ ...s, toLocation: e.target.value.toUpperCase() }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              type="number"
              placeholder="Quantity"
              value={trf.quantity}
              onChange={(e) => setTrf((s) => ({ ...s, quantity: Number(e.target.value) }))}
            />
            <input
              className="rounded border px-3 py-2 text-sm"
              placeholder="Remarks"
              value={trf.remarks}
              onChange={(e) => setTrf((s) => ({ ...s, remarks: e.target.value }))}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => createTrf.mutate()}
              className="rounded bg-slate-900 px-3 py-2 text-sm text-white"
            >
              Create Draft
            </button>
            <button
              type="button"
              onClick={() => postTrf.mutate()}
              className="rounded border px-3 py-2 text-sm"
            >
              Post
            </button>
          </div>
        </div>
      ) : null}

      {tab === "Locations" ? (
        <div className="space-y-3">
          <div className="rounded-2xl border bg-white p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <input
                className="rounded border px-3 py-2 text-sm"
                disabled={Boolean(editLoc)}
                placeholder="Location Code"
                value={loc.locationCode}
                onChange={(e) => setLoc((s) => ({ ...s, locationCode: e.target.value.toUpperCase() }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Location Name"
                value={loc.locationName}
                onChange={(e) => setLoc((s) => ({ ...s, locationName: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Warehouse"
                value={loc.warehouse}
                onChange={(e) => setLoc((s) => ({ ...s, warehouse: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Rack"
                value={loc.rack}
                onChange={(e) => setLoc((s) => ({ ...s, rack: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Bin"
                value={loc.bin}
                onChange={(e) => setLoc((s) => ({ ...s, bin: e.target.value }))}
              />
              <select
                className="rounded border px-3 py-2 text-sm"
                value={loc.status}
                onChange={(e) => setLoc((s) => ({ ...s, status: e.target.value }))}
              >
                <option>Active</option>
                <option>Inactive</option>
              </select>
              <button
                type="button"
                onClick={() => saveLoc.mutate()}
                className="rounded bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {editLoc ? "Update" : "Create"}
              </button>
            </div>
          </div>
          <div className="overflow-auto rounded-2xl border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  {["Code", "Name", "Warehouse", "Rack", "Bin", "Status", "Actions"].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {locationRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-2 py-6 text-center text-sm text-slate-500">
                      No locations defined yet.
                    </td>
                  </tr>
                ) : (
                  locationRows.map((r) => (
                    <tr key={r._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{r.locationCode}</td>
                      <td className="px-2 py-1">{r.locationName}</td>
                      <td className="px-2 py-1">{r.warehouse}</td>
                      <td className="px-2 py-1">{r.rack}</td>
                      <td className="px-2 py-1">{r.bin}</td>
                      <td className="px-2 py-1">{r.status}</td>
                      <td className="px-2 py-1">
                        <button
                          type="button"
                          className="rounded border px-2 py-1 text-xs"
                          onClick={() => {
                            setEditLoc(r.locationCode);
                            setLoc({
                              locationCode: r.locationCode,
                              locationName: r.locationName,
                              warehouse: r.warehouse,
                              rack: r.rack,
                              bin: r.bin,
                              status: r.status,
                            });
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ml-2 rounded border px-2 py-1 text-xs text-rose-700"
                          onClick={() => deleteLoc.mutate(r.locationCode)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "Negative Allocation Report" ? (
        <div className="space-y-3">
          <div className="rounded-2xl border bg-white p-4">
            <div className="grid gap-3 md:grid-cols-4">
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Article"
                value={article}
                onChange={(e) => setArticle(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Warehouse"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Location"
                value={location}
                onChange={(e) => setLocation(e.target.value.toUpperCase())}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Customer search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                  onClick={() =>
                    downloadCsv("negative-allocation-report.csv", negativeReportColumns, negativeReportFlatRows)
                  }
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="rounded border px-3 py-2 text-sm hover:bg-slate-50"
                  onClick={() =>
                    downloadPdfTable(
                      "Negative Allocation Report",
                      "",
                      negativeReportColumns,
                      negativeReportFlatRows,
                      "negative-allocation-report"
                    )
                  }
                >
                  Export PDF
                </button>
              </div>
            </div>
          </div>
          <div className="overflow-auto rounded-2xl border bg-white">
            <table className="min-w-[1400px] w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 shadow-sm">
                <tr>
                  {[
                    "Article",
                    "Item Name",
                    "Customer",
                    "Reference No",
                    "Reference Type",
                    "Warehouse",
                    "Location",
                    "On Hand",
                    "Allocated",
                    "RTS",
                    "Available",
                    "Negative Qty",
                    "Last Movement",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {negativeReportFlatRows.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="px-2 py-6 text-center text-sm text-slate-500">
                      No negative allocations found.
                    </td>
                  </tr>
                ) : (
                  negativeReportFlatRows.map((r, i) => (
                    <tr key={`${r.article}-${r.referenceNo}-${i}`} className="border-t bg-rose-50/40">
                      <td className="px-2 py-1 font-mono">{r.article}</td>
                      <td className="px-2 py-1">{r.itemName}</td>
                      <td className="px-2 py-1">{r.customerName}</td>
                      <td className="px-2 py-1 font-mono text-xs">{r.referenceNo}</td>
                      <td className="px-2 py-1">{r.referenceType}</td>
                      <td className="px-2 py-1">{r.warehouse}</td>
                      <td className="px-2 py-1">{r.location}</td>
                      <td className="px-2 py-1">{r.onHandQty}</td>
                      <td className="px-2 py-1">{r.allocatedQty}</td>
                      <td className="px-2 py-1">{r.rtsQty}</td>
                      <td className="px-2 py-1 font-semibold text-rose-700">{r.availableQty}</td>
                      <td className="px-2 py-1">{r.negativeQty}</td>
                      <td className="px-2 py-1 text-xs text-slate-600">{fmtDate(r.lastMovementDate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <Modal
        open={allocationDrillDown.open}
        onClose={() => setAllocationDrillDown({ open: false, article: "", warehouse: "" })}
        title={`Customer Allocations — ${allocationDrillDown.article}`}
        subtitle={
          allocationDrillDown.warehouse
            ? `Warehouse ${allocationDrillDown.warehouse}`
            : "All warehouses"
        }
        wide
      >
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border px-3 py-2 text-xs hover:bg-slate-50"
              onClick={() =>
                downloadCsv(
                  `customer-allocations-${allocationDrillDown.article || "all"}.csv`,
                  [
                    { key: "customerName", header: "Customer" },
                    { key: "referenceNo", header: "Reference No" },
                    { key: "referenceType", header: "Reference Type" },
                    { key: "allocatedQty", header: "Allocated Qty" },
                    { key: "rtsQty", header: "RTS Qty" },
                    { key: "invoiceQty", header: "Invoice Qty" },
                    { key: "warehouse", header: "Warehouse" },
                    { key: "location", header: "Location" },
                    { key: "allocationDate", header: "Allocation Date" },
                    { key: "status", header: "Status" },
                    { key: "createdBy", header: "Created By" },
                  ],
                  (customerAllocations?.items || []).map((it) => ({
                    ...it,
                    allocationDate: it.allocationDate ? new Date(it.allocationDate).toISOString().slice(0, 10) : "",
                  }))
                )
              }
            >
              Export CSV
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 text-xs hover:bg-slate-50"
              onClick={() =>
                downloadPdfTable(
                  `Customer Allocations — ${allocationDrillDown.article || ""}`,
                  allocationDrillDown.warehouse ? `Warehouse ${allocationDrillDown.warehouse}` : "",
                  [
                    { key: "customerName", header: "Customer" },
                    { key: "referenceNo", header: "Reference No" },
                    { key: "referenceType", header: "Reference Type" },
                    { key: "allocatedQty", header: "Allocated Qty" },
                    { key: "rtsQty", header: "RTS Qty" },
                    { key: "invoiceQty", header: "Invoice Qty" },
                    { key: "warehouse", header: "Warehouse" },
                    { key: "location", header: "Location" },
                    { key: "allocationDate", header: "Allocation Date" },
                    { key: "status", header: "Status" },
                    { key: "createdBy", header: "Created By" },
                  ],
                  (customerAllocations?.items || []).map((it) => ({
                    ...it,
                    allocationDate: it.allocationDate ? new Date(it.allocationDate).toISOString().slice(0, 10) : "",
                  })),
                  "customer-allocations"
                )
              }
            >
              Export PDF
            </button>
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-xl border">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  {[
                    "Customer",
                    "Reference",
                    "Type",
                    "Allocated Qty",
                    "RTS Qty",
                    "Invoice Qty",
                    "Warehouse",
                    "Location",
                    "Date",
                    "Status",
                    "Backorder",
                    "Created By",
                  ].map((h) => (
                    <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(customerAllocations?.items || []).length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-2 py-6 text-center text-sm text-slate-500">
                      No active allocations against this article.
                    </td>
                  </tr>
                ) : (
                  customerAllocations.items.map((it) => (
                    <tr key={`${it.allocationId}-${it.article}`} className="border-t">
                      <td className="px-2 py-1">{it.customerName}</td>
                      <td className="px-2 py-1 font-mono text-xs">{it.referenceNo}</td>
                      <td className="px-2 py-1">{it.referenceType}</td>
                      <td className="px-2 py-1">{it.allocatedQty}</td>
                      <td className="px-2 py-1">{it.rtsQty || 0}</td>
                      <td className="px-2 py-1">{it.invoiceQty || 0}</td>
                      <td className="px-2 py-1">{it.warehouse}</td>
                      <td className="px-2 py-1">{it.location || it.warehouse}</td>
                      <td className="px-2 py-1">{fmtDateOnly(it.allocationDate)}</td>
                      <td className="px-2 py-1">{it.status}</td>
                      <td className="px-2 py-1">
                        {it.isNegativeAllocation ? <StatusPill status="Yes" tone="rose" /> : <StatusPill status="No" tone="slate" />}
                      </td>
                      <td className="px-2 py-1 text-xs text-slate-500">{it.createdBy}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </div>
  );
}
