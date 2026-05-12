import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import Modal from "../components/erp/Modal.jsx";

const TABS = [
  "GRN",
  "Landed Cost Allocation",
  "Stock View",
  "Stock Ledger",
  "Stock Adjustment",
  "Stock Transfer",
  "Locations",
  "Packing",
  "Dispatch",
  "Store Reports",
  "Negative Allocation Report",
];

const GRN_PO_PAY_LABEL = {
  NOT_PAID: "Not paid",
  NONE: "Not paid",
  PAYMENT_PENDING: "Pending",
  PARTIALLY_PAID: "Partially paid",
  FULLY_PAID: "Fully paid",
  PAID: "Fully paid",
  ADVANCE_PAID: "Advance paid",
};

const GRN_PO_DOC_LABEL = {
  NONE: "Not uploaded",
  PI_RECEIVED: "PI uploaded",
  INVOICE_RECEIVED: "Invoice uploaded",
  INVOICE_BOOKED: "Booked",
};

const GRN_PO_RECEIPT_LABEL = {
  NOT_RECEIVED: "Not received",
  PARTIALLY_RECEIVED: "Partially received",
  FULLY_RECEIVED: "Fully received",
};

function fmtPoDateShort(d) {
  if (!d) return "—";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "—" : x.toLocaleDateString();
}

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

function fmtMoney(n) {
  const x = Number(n) || 0;
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function StoreModule() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
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
  const [grnPoId, setGrnPoId] = useState("");
  const [grnPoSnapshot, setGrnPoSnapshot] = useState(null);
  const [grnLineEdits, setGrnLineEdits] = useState({});
  const [lastDraftGrnNo, setLastDraftGrnNo] = useState("");
  const [grnUiErr, setGrnUiErr] = useState("");
  const grnUrlPoLoadedRef = useRef("");
  const [packAllocInputId, setPackAllocInputId] = useState("");
  const [packAllocQueryId, setPackAllocQueryId] = useState("");
  const [packLineQty, setPackLineQty] = useState({});
  const [dispatchPackInputId, setDispatchPackInputId] = useState("");
  const [dispatchPackQueryId, setDispatchPackQueryId] = useState("");
  const [dispatchLineQty, setDispatchLineQty] = useState({});

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
  const [selectedLandedCostId, setSelectedLandedCostId] = useState("");
  const [landedCostForm, setLandedCostForm] = useState({
    grnNo: "",
    allocationMethod: "LINE_VALUE",
    purchaseInvoiceNo: "",
    shipmentRef: "",
    containerNo: "",
    remarks: "",
    components: [
      { componentType: "FREIGHT", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "CUSTOMS_DUTY", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "TRUCKING", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "INSURANCE", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "HANDLING", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "CLEARANCE", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
      { componentType: "MISC_CHARGES", amount: 0, currency: "USD", exchangeRate: 1, remarks: "" },
    ],
    lines: [],
  });

  const { data: grns } = useQuery({
    queryKey: ["grn"],
    queryFn: () => apiGetWithQuery("/grn", { limit: 200 }),
    enabled: tab === "GRN",
  });

  const { data: poPickList } = useQuery({
    queryKey: ["store-purchase-orders"],
    queryFn: () => apiGetWithQuery("/purchase-orders", { limit: 150 }),
    enabled: tab === "GRN",
  });

  const loadGrnPoMut = useMutation({
    mutationFn: (poId) => apiGet(`/grn/from-po/${poId}`),
    onSuccess: (data) => {
      setGrnUiErr("");
      setGrnPoSnapshot(data);
      const init = {};
      for (const ln of data.lines || []) {
        init[String(ln.poLineId)] = {
          selected: false,
          grnQty: String(Math.max(0, Number(ln.pendingQty) || 0)),
          warehouse: "MAIN",
          location: "MAIN",
          remarks: "",
        };
      }
      setGrnLineEdits(init);
    },
    onError: (e) => {
      setGrnPoSnapshot(null);
      setGrnLineEdits({});
      setGrnUiErr(e.message || String(e));
    },
  });

  const createGrnDraft = useMutation({
    mutationFn: (body) => apiPost("/grn/draft", body),
    onSuccess: (doc, vars) => {
      qc.invalidateQueries({ queryKey: ["grn"] });
      qc.invalidateQueries({ queryKey: ["store-purchase-orders"] });
      if (doc?.grnNo) setLastDraftGrnNo(doc.grnNo);
      const pid = vars?.poId ? String(vars.poId) : grnPoSnapshot?.header?._id ? String(grnPoSnapshot.header._id) : "";
      if (pid) loadGrnPoMut.mutate(pid);
      setGrnUiErr("");
    },
    onError: (e) => setGrnUiErr(e.message || String(e)),
  });

  const postGrnMut = useMutation({
    mutationFn: (grnNo) => apiPost(`/grn/${encodeURIComponent(grnNo)}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grn"] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["store-purchase-orders"] });
      const pid = grnPoSnapshot?.header?._id;
      if (pid) loadGrnPoMut.mutate(String(pid));
      setLastDraftGrnNo("");
      setGrnUiErr("");
    },
    onError: (e) => setGrnUiErr(e.message || String(e)),
  });

  useEffect(() => {
    const tabq = searchParams.get("tab");
    const po = searchParams.get("grnPoId");
    if (tabq && TABS.includes(tabq)) setTab(tabq);
    if (po) {
      setGrnPoId(po);
      if (!tabq || tabq === "GRN") setTab("GRN");
      if (grnUrlPoLoadedRef.current !== po) {
        grnUrlPoLoadedRef.current = po;
        loadGrnPoMut.mutate(po);
      }
    }
  }, [searchParams]);

  const { data: packingFromAlloc } = useQuery({
    queryKey: ["packing-from-allocation", packAllocQueryId],
    queryFn: () => apiGet(`/packing/from-allocation/${packAllocQueryId}`),
    enabled: tab === "Packing" && Boolean(packAllocQueryId),
  });

  useEffect(() => {
    const lines = packingFromAlloc?.lines;
    if (!lines?.length) {
      if (!packAllocQueryId) setPackLineQty({});
      return;
    }
    const next = {};
    for (const ln of lines) {
      next[String(ln.allocationLineId)] = Math.max(0, Number(ln.pendingPack) || 0);
    }
    setPackLineQty(next);
  }, [packAllocQueryId, packingFromAlloc]);

  const createPackingDraft = useMutation({
    mutationFn: (body) => apiPost("/packing/draft", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-packing"] });
      qc.invalidateQueries({ queryKey: ["packing-from-allocation", packAllocQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const postPackingMut = useMutation({
    mutationFn: (id) => apiPost(`/packing/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-packing"] });
      qc.invalidateQueries({ queryKey: ["packing-from-allocation", packAllocQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const cancelPackingMut = useMutation({
    mutationFn: ({ id, reason }) => apiPost(`/packing/${id}/cancel`, { reason: reason || "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-packing"] });
      qc.invalidateQueries({ queryKey: ["packing-from-allocation", packAllocQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const { data: dispatchFromPack } = useQuery({
    queryKey: ["dispatch-from-packing", dispatchPackQueryId],
    queryFn: () => apiGet(`/dispatch/from-packing/${dispatchPackQueryId}`),
    enabled: tab === "Dispatch" && Boolean(dispatchPackQueryId),
  });

  useEffect(() => {
    const lines = dispatchFromPack?.lines;
    if (!lines?.length) {
      if (!dispatchPackQueryId) setDispatchLineQty({});
      return;
    }
    const next = {};
    for (const ln of lines) {
      next[String(ln.packingLineId)] = Math.max(0, Number(ln.pendingDispatch) || 0);
    }
    setDispatchLineQty(next);
  }, [dispatchPackQueryId, dispatchFromPack]);

  const createDispatchDraft = useMutation({
    mutationFn: (body) => apiPost("/dispatch/draft", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-dispatch"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-packing", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const postDispatchMut = useMutation({
    mutationFn: (id) => apiPost(`/dispatch/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-dispatch"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-packing", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const cancelDispatchMut = useMutation({
    mutationFn: ({ id, reason }) => apiPost(`/dispatch/${id}/cancel`, { reason: reason || "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-dispatch"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-packing", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const { data: packingList } = useQuery({
    queryKey: ["store-packing"],
    queryFn: () => apiGetWithQuery("/packing", { limit: 200 }),
    enabled: tab === "Packing",
  });

  const { data: dispatchList } = useQuery({
    queryKey: ["store-dispatch"],
    queryFn: () => apiGetWithQuery("/dispatch", { limit: 200 }),
    enabled: tab === "Dispatch",
  });

  const { data: reportPackingPending } = useQuery({
    queryKey: ["store-report-packing-pending"],
    queryFn: () => apiGet("/store/reports/packing-pending-dispatch"),
    enabled: tab === "Store Reports",
  });

  const { data: reportDispatchSummary } = useQuery({
    queryKey: ["store-report-dispatch-summary"],
    queryFn: () => apiGet("/store/reports/dispatch-summary"),
    enabled: tab === "Store Reports",
  });

  const { data: reportPendingPo } = useQuery({
    queryKey: ["store-report-pending-po"],
    queryFn: () => apiGet("/grn/reports/pending-po"),
    enabled: tab === "Store Reports",
  });

  const { data: landedCostRows } = useQuery({
    queryKey: ["landed-cost-list"],
    queryFn: () => apiGetWithQuery("/store/landed-cost", { limit: 200 }),
    enabled: tab === "Landed Cost Allocation",
  });

  const { data: landedCostSummary } = useQuery({
    queryKey: ["landed-cost-summary"],
    queryFn: () => apiGet("/store/reports/landed-cost-summary"),
    enabled: tab === "Landed Cost Allocation",
  });

  const { data: valuationAdjustments } = useQuery({
    queryKey: ["stock-valuation-adjustments"],
    queryFn: () => apiGet("/store/reports/stock-valuation-adjustments"),
    enabled: tab === "Landed Cost Allocation",
  });

  const { data: grnCostAnalysis } = useQuery({
    queryKey: ["grn-cost-analysis"],
    queryFn: () => apiGet("/store/reports/grn-cost-analysis"),
    enabled: tab === "Landed Cost Allocation",
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
    enabled: tab === "GRN" || tab === "Locations",
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
  const createLandedCost = useMutation({
    mutationFn: () => apiPost("/store/landed-cost", landedCostForm),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["landed-cost-list"] });
      qc.invalidateQueries({ queryKey: ["landed-cost-summary"] });
      if (row?._id) setSelectedLandedCostId(row._id);
    },
  });
  const updateLandedCost = useMutation({
    mutationFn: () => apiPut(`/store/landed-cost/${selectedLandedCostId}`, landedCostForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["landed-cost-list"] });
      qc.invalidateQueries({ queryKey: ["landed-cost-summary"] });
    },
  });
  const applyLandedCost = useMutation({
    mutationFn: (id) => apiPost(`/store/landed-cost/${id}/apply`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["landed-cost-list"] });
      qc.invalidateQueries({ queryKey: ["landed-cost-summary"] });
      qc.invalidateQueries({ queryKey: ["stock-valuation-adjustments"] });
      qc.invalidateQueries({ queryKey: ["grn-cost-analysis"] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
    },
  });
  const cancelLandedCost = useMutation({
    mutationFn: (id) => apiPost(`/store/landed-cost/${id}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["landed-cost-list"] });
      qc.invalidateQueries({ queryKey: ["landed-cost-summary"] });
    },
  });

  const stockRows = useMemo(() => balance?.items || [], [balance]);
  const ledgerRows = useMemo(() => ledger?.items || [], [ledger]);
  const locationRows = locations || [];
  const grnLinesForUi = grnPoSnapshot?.lines || [];
  const grnTotalPending = useMemo(
    () => grnLinesForUi.reduce((s, ln) => s + Math.max(0, Number(ln.pendingQty) || 0), 0),
    [grnLinesForUi]
  );
  const grnLocationSelectCodes = useMemo(() => {
    const arr = locationRows.map((l) => l.locationCode).filter(Boolean);
    return Array.from(new Set([...arr, "MAIN"])).sort();
  }, [locationRows]);
  const negativeRows = useMemo(() => negativeReport?.items || [], [negativeReport]);
  const landedCostDetail = useMemo(
    () => (landedCostRows?.items || []).find((x) => String(x._id) === String(selectedLandedCostId)) || null,
    [landedCostRows, selectedLandedCostId]
  );

  const stockViewColumns = useMemo(
    () => [
      { key: "article", header: "Article" },
      { key: "itemName", header: "Item Name" },
      { key: "warehouse", header: "Warehouse" },
      { key: "location", header: "Location" },
      { key: "onHandQty", header: "On Hand" },
      { key: "allocatedQty", header: "Allocated" },
      { key: "packedQty", header: "Packed" },
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
          GRN, Landed Cost Allocation, Stock View, Stock Ledger, Adjustment, Transfer, Locations, Negative Allocation Report
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
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-800">GRN from purchase order</h3>
            <div className="flex flex-wrap items-end gap-2">
              <select
                className="min-w-[260px] rounded border px-3 py-2 text-sm"
                value={grnPoId}
                onChange={(e) => {
                  setGrnPoId(e.target.value);
                  setGrnPoSnapshot(null);
                  setGrnLineEdits({});
                  setGrnUiErr("");
                  setLastDraftGrnNo("");
                }}
              >
                <option value="">Select PO…</option>
                {(poPickList?.items || []).map((p) => (
                  <option key={p._id} value={p._id}>
                    {(p.poNo || p.poNumber || "").trim()} — {p.supplierName || ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40"
                disabled={!grnPoId || loadGrnPoMut.isPending}
                onClick={() => loadGrnPoMut.mutate(grnPoId)}
              >
                Load PO lines
              </button>
            </div>
            {grnUiErr ? <p className="mt-2 text-xs text-rose-600">{grnUiErr}</p> : null}
            {loadGrnPoMut.isPending ? <p className="mt-2 text-xs text-slate-500">Loading PO…</p> : null}

            {grnPoSnapshot?.header ? (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/90 p-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <span className="text-slate-500">PO No</span>{" "}
                    <span className="font-mono font-semibold">{grnPoSnapshot.header.poNo || "—"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Supplier</span>{" "}
                    <span className="font-medium">{grnPoSnapshot.header.supplierName || "—"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">PO date</span> {fmtPoDateShort(grnPoSnapshot.header.orderDate)}
                  </div>
                  <div>
                    <span className="text-slate-500">Currency</span>{" "}
                    <span className="font-mono">{grnPoSnapshot.header.currency || "—"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Payment status</span>{" "}
                    <span className="font-medium">
                      {GRN_PO_PAY_LABEL[grnPoSnapshot.header.paymentStatus] ||
                        grnPoSnapshot.header.paymentStatus ||
                        "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Supplier invoice</span>{" "}
                    <span className="font-medium">
                      {GRN_PO_DOC_LABEL[grnPoSnapshot.header.supplierInvoiceStatus] ||
                        grnPoSnapshot.header.supplierInvoiceStatus ||
                        "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">GRN status (PO)</span>{" "}
                    <span className="font-medium">
                      {GRN_PO_RECEIPT_LABEL[grnPoSnapshot.header.grnReceiptStatus] ||
                        grnPoSnapshot.header.grnReceiptStatus ||
                        "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">PO status</span>{" "}
                    <span className="font-medium">{grnPoSnapshot.header.poStatus || "—"}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {grnLinesForUi.length ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    onClick={() => {
                      setGrnLineEdits((prev) => {
                        const next = { ...prev };
                        for (const ln of grnLinesForUi) {
                          const id = String(ln.poLineId);
                          if ((Number(ln.pendingQty) || 0) <= 0) continue;
                          const pend = Math.max(0, Number(ln.pendingQty) || 0);
                          const cur = next[id] || {
                            selected: false,
                            grnQty: String(pend),
                            warehouse: "MAIN",
                            location: "MAIN",
                            remarks: "",
                          };
                          next[id] = { ...cur, selected: true };
                        }
                        return next;
                      });
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    onClick={() => {
                      setGrnLineEdits((prev) => {
                        const next = { ...prev };
                        for (const id of Object.keys(next)) {
                          next[id] = { ...next[id], selected: false };
                        }
                        return next;
                      });
                    }}
                  >
                    Clear selection
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    onClick={() => {
                      setGrnLineEdits((prev) => {
                        const next = { ...prev };
                        const anySel = Object.entries(next).some(([, v]) => v?.selected);
                        for (const ln of grnLinesForUi) {
                          const id = String(ln.poLineId);
                          const pend = Math.max(0, Number(ln.pendingQty) || 0);
                          if (pend <= 0) continue;
                          const cur = next[id] || {
                            selected: false,
                            grnQty: "0",
                            warehouse: "MAIN",
                            location: "MAIN",
                            remarks: "",
                          };
                          if (anySel && !cur.selected) continue;
                          next[id] = { ...cur, grnQty: String(pend) };
                        }
                        return next;
                      });
                    }}
                  >
                    Fill full pending qty
                  </button>
                </div>
                <div className="mt-3 overflow-auto rounded border border-slate-200">
                  <table className="w-full min-w-[1000px] text-xs">
                    <thead className="bg-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-2 py-2">Sel</th>
                        <th className="px-2 py-2">Article</th>
                        <th className="px-2 py-2">Description</th>
                        <th className="px-2 py-2">SPN</th>
                        <th className="px-2 py-2">Material code</th>
                        <th className="px-2 py-2">UOM</th>
                        <th className="px-2 py-2 text-right">Ordered</th>
                        <th className="px-2 py-2 text-right">Received</th>
                        <th className="px-2 py-2 text-right">Pending</th>
                        <th className="px-2 py-2 text-right">GRN qty</th>
                        <th className="px-2 py-2">Warehouse</th>
                        <th className="px-2 py-2">Location</th>
                        <th className="px-2 py-2">Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grnLinesForUi.map((ln) => {
                        const id = String(ln.poLineId);
                        const ed = grnLineEdits[id] || {
                          selected: false,
                          grnQty: String(Math.max(0, Number(ln.pendingQty) || 0)),
                          warehouse: "MAIN",
                          location: "MAIN",
                          remarks: "",
                        };
                        const pend = Math.max(0, Number(ln.pendingQty) || 0);
                        const qtyNum = Number(ed.grnQty);
                        const qtyInvalid = Number.isFinite(qtyNum) && pend > 0 && qtyNum > pend + 1e-6;
                        return (
                          <tr key={id} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="checkbox"
                                checked={!!ed.selected}
                                disabled={pend <= 0}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, selected: e.target.checked },
                                  }))
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5 font-mono font-semibold">{ln.article}</td>
                            <td className="max-w-[200px] truncate px-2 py-1.5" title={ln.description}>
                              {ln.description || "—"}
                            </td>
                            <td className="px-2 py-1.5">{ln.spn || "—"}</td>
                            <td className="px-2 py-1.5 font-mono text-[11px]">{ln.materialCode || "—"}</td>
                            <td className="px-2 py-1.5">{ln.uom || "PCS"}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{ln.orderedQty}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{ln.receivedQty}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{pend}</td>
                            <td className="px-2 py-1.5 text-right">
                              <input
                                className={`w-20 rounded border px-1 py-0.5 text-right tabular-nums ${qtyInvalid ? "border-rose-500" : ""}`}
                                disabled={pend <= 0}
                                value={ed.grnQty}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, grnQty: e.target.value },
                                  }))
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                className="max-w-[120px] rounded border px-1 py-0.5"
                                value={ed.warehouse}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, warehouse: e.target.value, location: e.target.value },
                                  }))
                                }
                              >
                                {grnLocationSelectCodes.map((code) => (
                                  <option key={`w-${id}-${code}`} value={code}>
                                    {code}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                className="max-w-[120px] rounded border px-1 py-0.5"
                                value={ed.location}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, location: e.target.value },
                                  }))
                                }
                              >
                                {grnLocationSelectCodes.map((code) => (
                                  <option key={`l-${id}-${code}`} value={code}>
                                    {code}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="w-full min-w-[100px] rounded border px-1 py-0.5"
                                value={ed.remarks}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, remarks: e.target.value },
                                  }))
                                }
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40"
                    disabled={
                      createGrnDraft.isPending ||
                      grnTotalPending <= 0 ||
                      !grnPoSnapshot?.header?._id
                    }
                    onClick={() => {
                      setGrnUiErr("");
                      const h = grnPoSnapshot?.header;
                      if (!h?._id) {
                        setGrnUiErr("Load PO lines first.");
                        return;
                      }
                      const linesOut = [];
                      for (const ln of grnLinesForUi) {
                        const id = String(ln.poLineId);
                        const ed = grnLineEdits[id];
                        if (!ed?.selected) continue;
                        const q = Number(ed.grnQty);
                        const pend = Math.max(0, Number(ln.pendingQty) || 0);
                        if (!(q > 0)) {
                          setGrnUiErr("Each selected line needs GRN qty greater than zero.");
                          return;
                        }
                        if (q > pend + 1e-6) {
                          setGrnUiErr(`GRN qty cannot exceed pending (${pend}) for ${ln.article}.`);
                          return;
                        }
                        linesOut.push({
                          poLineId: ln.poLineId,
                          grnQty: q,
                          warehouse: (ed.warehouse || "MAIN").trim().toUpperCase(),
                          location: (ed.location || ed.warehouse || "MAIN").trim().toUpperCase(),
                          remarks: ed.remarks || "",
                        });
                      }
                      if (!linesOut.length) {
                        setGrnUiErr("Select at least one line with pending quantity and enter GRN qty.");
                        return;
                      }
                      createGrnDraft.mutate({
                        poId: h._id,
                        poNo: h.poNo || h.poNumber,
                        supplierId: h.supplierId,
                        supplierName: h.supplierName,
                        currency: h.currency || "USD",
                        branchId: h.branchId || undefined,
                        grnDate: new Date().toISOString().slice(0, 10),
                        lines: linesOut,
                      });
                    }}
                  >
                    Create draft GRN
                  </button>
                  {lastDraftGrnNo ? (
                    <button
                      type="button"
                      className="rounded border border-emerald-700 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:opacity-40"
                      disabled={postGrnMut.isPending}
                      onClick={() => {
                        setGrnUiErr("");
                        postGrnMut.mutate(lastDraftGrnNo);
                      }}
                    >
                      Post GRN {lastDraftGrnNo}
                    </button>
                  ) : null}
                  {grnTotalPending <= 0 ? (
                    <span className="text-xs text-amber-700">No pending quantity on this PO — cannot create GRN.</span>
                  ) : null}
                </div>
              </>
            ) : grnPoSnapshot && !grnLinesForUi.length ? (
              <p className="mt-3 text-xs text-amber-700">This PO has no lines.</p>
            ) : null}
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-800">GRN register</h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">GRN No</th>
                    <th className="px-2 py-2 text-left">PO</th>
                    <th className="px-2 py-2 text-left">Supplier</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(grns?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-2 py-4 text-center text-slate-500">
                        No GRNs
                      </td>
                    </tr>
                  ) : (
                    (grns?.items || []).map((g) => (
                      <tr key={g._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{g.grnNo}</td>
                        <td className="px-2 py-2">{g.poNo || "—"}</td>
                        <td className="px-2 py-2">{g.supplierName || "—"}</td>
                        <td className="px-2 py-2">
                          <StatusPill status={g.status} tone={g.status === "DRAFT" ? "amber" : "emerald"} />
                        </td>
                        <td className="px-2 py-2">
                          {g.status === "DRAFT" ? (
                            <button
                              type="button"
                              className="rounded border px-2 py-1 text-xs font-semibold text-emerald-800"
                              disabled={postGrnMut.isPending}
                              onClick={() => {
                                setGrnUiErr("");
                                postGrnMut.mutate(g.grnNo);
                              }}
                            >
                              Post GRN
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Landed Cost Allocation" ? (
        <div className="space-y-3">
          <div className="rounded-2xl border bg-white p-4">
            <div className="grid gap-3 md:grid-cols-4">
              <select
                className="rounded border px-3 py-2 text-sm"
                value={landedCostForm.grnNo}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, grnNo: e.target.value }))}
              >
                <option value="">Select GRN</option>
                {(grns?.items || [])
                  .filter((g) => ["RECEIVED", "PARTIAL_RECEIVED", "CLOSED"].includes(g.status))
                  .map((g) => (
                    <option key={g._id} value={g.grnNo}>
                      {g.grnNo} - {g.supplierName || "Supplier"}
                    </option>
                  ))}
              </select>
              <select
                className="rounded border px-3 py-2 text-sm"
                value={landedCostForm.allocationMethod}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, allocationMethod: e.target.value }))}
              >
                <option value="QUANTITY">Allocate by Quantity</option>
                <option value="LINE_VALUE">Allocate by Line Value</option>
                <option value="WEIGHT">Allocate by Weight</option>
                <option value="VOLUME">Allocate by Volume</option>
              </select>
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Purchase Invoice No"
                value={landedCostForm.purchaseInvoiceNo}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, purchaseInvoiceNo: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Shipment Ref"
                value={landedCostForm.shipmentRef}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, shipmentRef: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm"
                placeholder="Container No"
                value={landedCostForm.containerNo}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, containerNo: e.target.value }))}
              />
              <input
                className="rounded border px-3 py-2 text-sm md:col-span-3"
                placeholder="Allocation remarks"
                value={landedCostForm.remarks}
                onChange={(e) => setLandedCostForm((s) => ({ ...s, remarks: e.target.value }))}
              />
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {landedCostForm.components.map((c, i) => (
                <div key={c.componentType} className="rounded border p-2">
                  <div className="mb-1 text-xs font-semibold text-slate-700">{c.componentType.replaceAll("_", " ")}</div>
                  <div className="grid gap-2 md:grid-cols-4">
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      type="number"
                      placeholder="Amount"
                      value={c.amount}
                      onChange={(e) =>
                        setLandedCostForm((s) => ({
                          ...s,
                          components: s.components.map((row, idx) =>
                            idx === i ? { ...row, amount: Number(e.target.value) } : row
                          ),
                        }))
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Currency"
                      value={c.currency}
                      onChange={(e) =>
                        setLandedCostForm((s) => ({
                          ...s,
                          components: s.components.map((row, idx) =>
                            idx === i ? { ...row, currency: e.target.value.toUpperCase() } : row
                          ),
                        }))
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      type="number"
                      placeholder="Exch Rate"
                      value={c.exchangeRate}
                      onChange={(e) =>
                        setLandedCostForm((s) => ({
                          ...s,
                          components: s.components.map((row, idx) =>
                            idx === i ? { ...row, exchangeRate: Number(e.target.value) || 1 } : row
                          ),
                        }))
                      }
                    />
                    <input
                      className="rounded border px-2 py-1 text-sm"
                      placeholder="Remarks"
                      value={c.remarks}
                      onChange={(e) =>
                        setLandedCostForm((s) => ({
                          ...s,
                          components: s.components.map((row, idx) =>
                            idx === i ? { ...row, remarks: e.target.value } : row
                          ),
                        }))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="rounded bg-slate-900 px-3 py-2 text-sm text-white" onClick={() => createLandedCost.mutate()}>
                Create Draft From GRN
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={!selectedLandedCostId}
                onClick={() => updateLandedCost.mutate()}
              >
                Save Draft
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={!selectedLandedCostId}
                onClick={() => applyLandedCost.mutate(selectedLandedCostId)}
              >
                Apply (Approval)
              </button>
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm text-rose-700"
                disabled={!selectedLandedCostId}
                onClick={() => cancelLandedCost.mutate(selectedLandedCostId)}
              >
                Cancel
              </button>
              <span className="text-sm text-slate-600">
                Total landed additions:{" "}
                <strong>
                  {fmtMoney(
                    landedCostForm.components.reduce(
                      (n, c) => n + (Number(c.amount) || 0) * (Number(c.exchangeRate) || 1),
                      0
                    )
                  )}
                </strong>
              </span>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="overflow-auto rounded-2xl border bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-100">
                  <tr>
                    {["Allocation", "GRN", "Supplier", "Method", "Total", "Status", "Action"].map((h) => (
                      <th key={h} className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(landedCostRows?.items || []).length === 0 ? (
                    <tr><td colSpan={7} className="px-2 py-6 text-center text-sm text-slate-500">No landed cost allocations yet.</td></tr>
                  ) : (
                    (landedCostRows?.items || []).map((r) => (
                      <tr key={r._id} className="border-t">
                        <td className="px-2 py-1 font-mono">{r.allocationNo}</td>
                        <td className="px-2 py-1">{r.grnNo}</td>
                        <td className="px-2 py-1">{r.supplierName || "—"}</td>
                        <td className="px-2 py-1">{r.allocationMethod}</td>
                        <td className="px-2 py-1">{fmtMoney(r.totalLandedCost)}</td>
                        <td className="px-2 py-1"><StatusPill status={r.status} tone={r.status === "APPLIED" ? "emerald" : r.status === "CANCELLED" ? "rose" : "amber"} /></td>
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            className="rounded border px-2 py-1 text-xs"
                            onClick={() => {
                              setSelectedLandedCostId(r._id);
                              setLandedCostForm({
                                grnNo: r.grnNo || "",
                                allocationMethod: r.allocationMethod || "LINE_VALUE",
                                purchaseInvoiceNo: r.purchaseInvoiceNo || "",
                                shipmentRef: r.shipmentRef || "",
                                containerNo: r.containerNo || "",
                                remarks: r.remarks || "",
                                components: Array.isArray(r.components) && r.components.length
                                  ? r.components.map((c) => ({
                                      componentType: c.componentType || "FREIGHT",
                                      amount: Number(c.amount) || 0,
                                      currency: c.currency || "USD",
                                      exchangeRate: Number(c.exchangeRate) || 1,
                                      remarks: c.remarks || "",
                                    }))
                                  : landedCostForm.components,
                                lines: (r.lines || []).map((ln) => ({
                                  article: ln.article,
                                  location: ln.location,
                                  batchNo: ln.batchNo || "",
                                  serialNo: ln.serialNo || "",
                                  weight: Number(ln.weight) || 0,
                                  volume: Number(ln.volume) || 0,
                                  remarks: ln.remarks || "",
                                })),
                              });
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

            <div className="rounded-2xl border bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold">Allocation Preview</h3>
              {(landedCostDetail?.lines || []).length === 0 ? (
                <p className="text-sm text-slate-500">Select an allocation to preview line-level cost impact.</p>
              ) : (
                <div className="space-y-2">
                  {(landedCostDetail?.lines || []).map((ln, i) => (
                    <details key={`${ln.article}-${i}`} className="rounded border p-2">
                      <summary className="cursor-pointer text-sm">
                        {ln.article} @ {ln.location} — before {fmtMoney(ln.oldCost ?? ln.baseUnitCost)} + landed{" "}
                        {fmtMoney(ln.allocatedCost)} = final {fmtMoney(ln.newCost ?? ln.finalUnitCost)}
                      </summary>
                      <div className="mt-2 grid gap-2 md:grid-cols-4 text-xs">
                        <div>Before Cost: <strong>{fmtMoney(ln.oldCost ?? ln.baseUnitCost)}</strong></div>
                        <div>Landed Additions: <strong>{fmtMoney(ln.allocatedCost)}</strong></div>
                        <div>Final Cost: <strong>{fmtMoney(ln.newCost ?? ln.finalUnitCost)}</strong></div>
                        <div>Valuation Impact: <strong>{fmtMoney(ln.valuationDelta)}</strong></div>
                        <input
                          className="rounded border px-2 py-1 text-sm"
                          type="number"
                          placeholder="Weight"
                          value={Number(
                            (landedCostForm.lines || []).find((x) => x.article === ln.article && x.location === ln.location)?.weight ??
                              ln.weight ??
                              0
                          )}
                          onChange={(e) =>
                            setLandedCostForm((s) => {
                              const lines = [...(s.lines || [])];
                              const idx = lines.findIndex((x) => x.article === ln.article && x.location === ln.location);
                              const next = {
                                article: ln.article,
                                location: ln.location,
                                batchNo: ln.batchNo || "",
                                serialNo: ln.serialNo || "",
                                volume: Number(ln.volume) || 0,
                                weight: Number(e.target.value) || 0,
                                remarks: ln.remarks || "",
                              };
                              if (idx >= 0) lines[idx] = { ...lines[idx], weight: next.weight };
                              else lines.push(next);
                              return { ...s, lines };
                            })
                          }
                        />
                        <input
                          className="rounded border px-2 py-1 text-sm"
                          type="number"
                          placeholder="Volume"
                          value={Number(
                            (landedCostForm.lines || []).find((x) => x.article === ln.article && x.location === ln.location)?.volume ??
                              ln.volume ??
                              0
                          )}
                          onChange={(e) =>
                            setLandedCostForm((s) => {
                              const lines = [...(s.lines || [])];
                              const idx = lines.findIndex((x) => x.article === ln.article && x.location === ln.location);
                              const next = {
                                article: ln.article,
                                location: ln.location,
                                batchNo: ln.batchNo || "",
                                serialNo: ln.serialNo || "",
                                weight: Number(ln.weight) || 0,
                                volume: Number(e.target.value) || 0,
                                remarks: ln.remarks || "",
                              };
                              if (idx >= 0) lines[idx] = { ...lines[idx], volume: next.volume };
                              else lines.push(next);
                              return { ...s, lines };
                            })
                          }
                        />
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border bg-white p-3">
              <div className="mb-2 text-sm font-semibold">Landed Cost Summary</div>
              <div className="max-h-60 overflow-auto text-xs">
                {(landedCostSummary?.items || []).map((r) => (
                  <div key={r.allocationNo} className="border-b py-1">
                    {r.allocationNo} / {r.grnNo} / {r.status} / {fmtMoney(r.totalLandedCost)}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border bg-white p-3">
              <div className="mb-2 text-sm font-semibold">Stock Valuation Adjustment Report</div>
              <div className="max-h-60 overflow-auto text-xs">
                {(valuationAdjustments?.items || []).map((r) => (
                  <div key={r._id} className="border-b py-1">
                    {r.referenceNo} / {r.article} / old {fmtMoney(r.oldCost)} / new {fmtMoney(r.newCost)} / delta {fmtMoney(r.valuationDelta)}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border bg-white p-3">
              <div className="mb-2 text-sm font-semibold">GRN Cost Analysis</div>
              <div className="max-h-60 overflow-auto text-xs">
                {(grnCostAnalysis?.items || []).map((r) => (
                  <div key={r.allocationNo} className="border-b py-1">
                    {r.grnNo} / base {fmtMoney(r.baseValue)} / landed {fmtMoney(r.landedCost)} / final {fmtMoney(r.finalValue)}
                  </div>
                ))}
              </div>
            </div>
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
                    "Packed",
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
                    <td colSpan={13} className="px-2 py-6 text-center text-sm text-slate-500">
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
                        <td className="px-2 py-1">{r.packedQty ?? 0}</td>
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
                                    : r.movementType === "LANDED_COST_ADJUSTMENT"
                                      ? "indigo"
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

      {tab === "Packing" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">New packing from order allocation</h3>
            <p className="mb-3 text-xs text-slate-600">
              Paste the Order Allocation document id (from Sales). Load lines, set pack quantities (partial allowed), then create draft and post.
            </p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Allocation id</label>
                <input
                  className="w-72 rounded border px-2 py-1.5 font-mono text-xs"
                  value={packAllocInputId}
                  onChange={(e) => setPackAllocInputId(e.target.value.trim())}
                  placeholder="MongoDB ObjectId"
                />
              </div>
              <button
                type="button"
                className="rounded border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                onClick={() => setPackAllocQueryId(packAllocInputId)}
              >
                Load allocation
              </button>
            </div>
            {packingFromAlloc?.allocation ? (
              <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                <div>
                  <span className="font-semibold">{packingFromAlloc.allocation.allocationNo}</span> ·{" "}
                  {packingFromAlloc.allocation.customerName}
                </div>
                <div className="mt-1 text-slate-600">
                  OA {packingFromAlloc.allocation.linkedOANo || "—"} · PI {packingFromAlloc.allocation.linkedProformaNo || "—"} · WH{" "}
                  {packingFromAlloc.allocation.warehouse || "MAIN"}
                </div>
              </div>
            ) : null}
            {packingFromAlloc?.lines?.length ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Pending pack</th>
                      <th className="px-2 py-2 text-left">Pack qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packingFromAlloc.lines.map((ln) => (
                      <tr key={String(ln.allocationLineId)} className="border-t">
                        <td className="px-2 py-2 font-mono">{ln.article}</td>
                        <td className="px-2 py-2">{ln.pendingPack}</td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min={0}
                            max={ln.pendingPack}
                            className="w-24 rounded border px-2 py-1 text-xs"
                            value={packLineQty[String(ln.allocationLineId)] ?? 0}
                            onChange={(e) =>
                              setPackLineQty((prev) => ({
                                ...prev,
                                [String(ln.allocationLineId)]: Math.max(
                                  0,
                                  Math.min(Number(e.target.value) || 0, ln.pendingPack)
                                ),
                              }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="mt-3 rounded border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                  disabled={createPackingDraft.isPending || !packingFromAlloc?.allocation}
                  onClick={() => {
                    const lines = (packingFromAlloc.lines || [])
                      .map((ln) => ({
                        allocationLineId: ln.allocationLineId,
                        article: ln.article,
                        description: ln.description || "",
                        spn: ln.partNumber || "",
                        materialCode: ln.materialCode || "",
                        packQty: Math.min(
                          Number(packLineQty[String(ln.allocationLineId)]) || 0,
                          Number(ln.pendingPack) || 0
                        ),
                        uom: ln.uom || "PCS",
                      }))
                      .filter((x) => x.packQty > 0);
                    createPackingDraft.mutate({
                      allocationId: packingFromAlloc.allocation._id,
                      lines,
                    });
                  }}
                >
                  Create draft packing
                </button>
              </div>
            ) : packAllocQueryId ? (
              <p className="text-xs text-slate-500">No lines to pack (or allocation not found).</p>
            ) : null}
          </div>

          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Packing documents</h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">Packing No</th>
                    <th className="px-2 py-2 text-left">Customer</th>
                    <th className="px-2 py-2 text-left">Allocation</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(packingList?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-2 py-4 text-center text-xs text-slate-500">
                        No packing records.
                      </td>
                    </tr>
                  ) : (
                    (packingList?.items || []).map((p) => (
                      <tr key={p._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{p.packingNo}</td>
                        <td className="px-2 py-2">{p.customerName}</td>
                        <td className="px-2 py-2 font-mono text-xs">{p.allocationNo}</td>
                        <td className="px-2 py-2">
                          <StatusPill status={p.status} tone={p.status === "POSTED" ? "emerald" : "amber"} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          {p.status === "DRAFT" ? (
                            <span className="flex flex-wrap justify-end gap-1">
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-50"
                                disabled={postPackingMut.isPending}
                                onClick={() => postPackingMut.mutate(p._id)}
                              >
                                Post
                              </button>
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50"
                                disabled={cancelPackingMut.isPending}
                                onClick={() => {
                                  const reason = window.prompt("Cancel reason?", "") ?? "";
                                  cancelPackingMut.mutate({ id: p._id, reason });
                                }}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Dispatch" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">New dispatch from posted packing</h3>
            <p className="mb-3 text-xs text-slate-600">
              Enter a posted Store Packing id. Load pending quantities, then create draft dispatch and post (reduces on-hand stock).
            </p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Packing id</label>
                <input
                  className="w-72 rounded border px-2 py-1.5 font-mono text-xs"
                  value={dispatchPackInputId}
                  onChange={(e) => setDispatchPackInputId(e.target.value.trim())}
                  placeholder="StorePacking MongoDB id"
                />
              </div>
              <button
                type="button"
                className="rounded border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                onClick={() => setDispatchPackQueryId(dispatchPackInputId)}
              >
                Load packing
              </button>
            </div>
            {dispatchFromPack?.packing ? (
              <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                <div>
                  <span className="font-semibold">{dispatchFromPack.packing.packingNo}</span> ·{" "}
                  {dispatchFromPack.packing.customerName}
                </div>
                <div className="mt-1 text-slate-600">Allocation {dispatchFromPack.packing.allocationNo || "—"}</div>
              </div>
            ) : null}
            {dispatchFromPack?.lines?.length ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Packed</th>
                      <th className="px-2 py-2 text-left">Pending dispatch</th>
                      <th className="px-2 py-2 text-left">Dispatch qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dispatchFromPack.lines.map((ln) => (
                      <tr key={String(ln.packingLineId)} className="border-t">
                        <td className="px-2 py-2 font-mono">{ln.article}</td>
                        <td className="px-2 py-2">{ln.packedQty}</td>
                        <td className="px-2 py-2">{ln.pendingDispatch}</td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min={0}
                            max={ln.pendingDispatch}
                            className="w-24 rounded border px-2 py-1 text-xs"
                            value={dispatchLineQty[String(ln.packingLineId)] ?? 0}
                            onChange={(e) =>
                              setDispatchLineQty((prev) => ({
                                ...prev,
                                [String(ln.packingLineId)]: Math.max(
                                  0,
                                  Math.min(Number(e.target.value) || 0, ln.pendingDispatch)
                                ),
                              }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="mt-3 rounded border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                  disabled={createDispatchDraft.isPending || !dispatchFromPack?.packing}
                  onClick={() => {
                    const lines = (dispatchFromPack.lines || [])
                      .map((ln) => ({
                        packingLineId: ln.packingLineId,
                        article: ln.article,
                        description: ln.description || "",
                        spn: ln.spn || "",
                        materialCode: ln.materialCode || "",
                        dispatchQty: Math.min(
                          Number(dispatchLineQty[String(ln.packingLineId)]) || 0,
                          Number(ln.pendingDispatch) || 0
                        ),
                        uom: ln.uom || "PCS",
                      }))
                      .filter((x) => x.dispatchQty > 0);
                    createDispatchDraft.mutate({
                      packingId: dispatchFromPack.packing._id,
                      courier: "",
                      awbNo: "",
                      lines,
                    });
                  }}
                >
                  Create draft dispatch
                </button>
              </div>
            ) : dispatchPackQueryId ? (
              <p className="text-xs text-slate-500">Nothing pending or packing not posted.</p>
            ) : null}
          </div>

          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Dispatch documents</h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">Dispatch No</th>
                    <th className="px-2 py-2 text-left">Customer</th>
                    <th className="px-2 py-2 text-left">Packing</th>
                    <th className="px-2 py-2 text-left">AWB</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(dispatchList?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-2 py-4 text-center text-xs text-slate-500">
                        No dispatch records.
                      </td>
                    </tr>
                  ) : (
                    (dispatchList?.items || []).map((d) => (
                      <tr key={d._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{d.dispatchNo}</td>
                        <td className="px-2 py-2">{d.customerName}</td>
                        <td className="px-2 py-2 font-mono text-xs">{d.packingNo}</td>
                        <td className="px-2 py-2 text-xs">{d.awbNo || "—"}</td>
                        <td className="px-2 py-2">
                          <StatusPill status={d.status} tone={d.status === "POSTED" ? "emerald" : "amber"} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          {d.status === "DRAFT" ? (
                            <span className="flex flex-wrap justify-end gap-1">
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-50"
                                disabled={postDispatchMut.isPending}
                                onClick={() => postDispatchMut.mutate(d._id)}
                              >
                                Post
                              </button>
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50"
                                disabled={cancelDispatchMut.isPending}
                                onClick={() => {
                                  const reason = window.prompt("Cancel reason?", "") ?? "";
                                  cancelDispatchMut.mutate({ id: d._id, reason });
                                }}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "Store Reports" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Pending PO (GRN)</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportPendingPo?.items || []).map((r) => (
                <div key={r.poNo} className="border-b py-1">
                  {r.poNo} · {r.supplierName} · lines {r.pendingLines}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 rounded border px-2 py-1 text-xs"
              onClick={() =>
                downloadCsv(
                  "pending-po-grn.csv",
                  [
                    { key: "poNo", header: "PO No" },
                    { key: "supplierName", header: "Supplier" },
                    { key: "status", header: "Status" },
                    { key: "pendingLines", header: "Pending lines" },
                  ],
                  reportPendingPo?.items || []
                )
              }
            >
              Export CSV
            </button>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Packing pending dispatch</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportPackingPending?.items || []).map((r) => (
                <div key={r.packingNo} className="border-b py-1">
                  {r.packingNo} · {r.customerName} · pending {r.pendingQty}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Dispatch summary</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportDispatchSummary?.items || []).map((r) => (
                <div key={r.dispatchNo} className="border-b py-1">
                  {r.dispatchNo} · {r.customerName} · {r.courier || "—"}
                </div>
              ))}
            </div>
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
