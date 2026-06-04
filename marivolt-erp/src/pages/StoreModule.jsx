import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api, apiDelete, apiGet, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { renderStorePackingListPrintWindow } from "../lib/storePackingListPrint.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import { deliverReportHtml } from "../lib/reportPdfClient.js";
import { GLOBAL_REPORT_PRINT_CSS } from "../lib/reportPrintLayout.js";
import { GLOBAL_REPORT_TABLE_CSS } from "../lib/reportTableLayout.js";
import {
  exportCurrentPackingCsv,
  exportPackingTemplateCsv,
  mapImportPackagesToUi,
} from "../lib/storePackingCsv.js";
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

/** Default GRN warehouse `locationCode` (hidden in UI; must match backend). */
const GRN_DEFAULT_WAREHOUSE_CODE = "MAIN";

function escGrnHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildGrnRegisterReportHtml(g) {
  const rows = (g?.items || [])
    .map(
      (it) =>
        `<tr><td class="col-part">${escGrnHtml(it.article)}</td><td class="col-qty right">${Number(it.acceptedQty ?? it.receivedQty) || 0}</td><td class="col-flex">${escGrnHtml(it.warehouse || "—")}</td><td class="col-flex">${escGrnHtml(it.location || "—")}</td></tr>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>GRN ${escGrnHtml(g?.grnNo)}</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111} th,td{border:1px solid #ddd}${GLOBAL_REPORT_PRINT_CSS}${GLOBAL_REPORT_TABLE_CSS}</style></head>
<body class="report-print">
<h2>GRN ${escGrnHtml(g?.grnNo)}</h2>
<div><b>Date:</b> ${g?.grnDate ? new Date(g.grnDate).toLocaleDateString() : "—"}</div>
<div><b>PO:</b> ${escGrnHtml(g?.poNo)}</div>
<div><b>Supplier:</b> ${escGrnHtml(g?.supplierName)}</div>
<div><b>Status:</b> ${escGrnHtml(g?.status)}</div>
<table class="report-table"><thead><tr><th class="col-part">Article</th><th class="col-qty right">Qty</th><th class="col-flex">Warehouse</th><th class="col-flex">Location</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function openGrnRegisterReport(g, { exportPdf = false } = {}) {
  if (!g) return;
  return deliverReportHtml(buildGrnRegisterReportHtml(g), {
    exportPdf,
    filename: `grn-${g.grnNo || "register"}`,
  });
}

function fmtPoDateShort(d) {
  if (!d) return "—";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "—" : x.toLocaleDateString();
}

function isMongoIdString(s) {
  const t = String(s ?? "").trim();
  return /^[a-fA-F0-9]{24}$/.test(t);
}

/** Normalize GET /grn/from-po payload; map legacy PO line arrays if `lines` is empty. */
function normalizeGrnFromPoResponse(data) {
  const d = data && typeof data === "object" ? data : {};
  const po = d.po && typeof d.po === "object" ? d.po : null;
  let lines = Array.isArray(d.lines) ? d.lines.map((x) => ({ ...x })) : [];
  const PO_KEYS = ["lines", "orderLines", "poItems", "items", "products"];

  const mapRawToLine = (raw) => {
    const ordered = Number(raw?.orderedQty ?? raw?.qty ?? raw?.quantity ?? raw?.orderedQuantity) || 0;
    const received = Number(raw?.receivedQty ?? raw?.received ?? raw?.receivedQuantity) || 0;
    const cancelled = Number(raw?.cancelledQty ?? raw?.cancelled) || 0;
    const pending = Math.max(
      0,
      Number(raw?.pendingQty ?? raw?.openQty ?? Math.max(0, ordered - received - cancelled)) || 0
    );
    const itemCode = String(
      raw?.itemCode || raw?.materialCode || raw?.article || raw?.articleNo || raw?.sku || raw?.productCode || ""
    ).trim();
    const pid = raw?._id ?? raw?.poLineId ?? raw?.id ?? null;
    return {
      ...raw,
      poLineId: pid,
      itemId: raw?.itemId ?? raw?.itemMasterId ?? raw?.productId ?? null,
      article: (itemCode || String(raw?.article || "").trim()).toUpperCase() || "—",
      description: raw?.description || raw?.desc || raw?.productName || "",
      spn: raw?.partNo || raw?.spn || raw?.partNumber || "",
      materialCode: itemCode || String(raw?.materialCode || "").trim(),
      uom: raw?.uom || raw?.unit || raw?.uOM || "PCS",
      orderedQty: ordered,
      receivedQty: received,
      pendingQty: pending,
      unitCost: Number(raw?.unitCost ?? raw?.unitPrice ?? raw?.price ?? raw?.rate) || 0,
    };
  };

  if (!lines.length && po) {
    for (const k of PO_KEYS) {
      const arr = po[k];
      if (Array.isArray(arr) && arr.length) {
        lines = arr.map(mapRawToLine);
        break;
      }
    }
  }

  let header = d.header;
  if (!header && po) {
    header = {
      _id: po._id,
      poNo: po.poNo || po.poNumber,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      currency: po.currency || "USD",
      supplierName: po.supplierName,
      supplierId: po.supplierId,
      branchId: po.branchId || null,
      warehouseId: po.warehouseId || null,
      paymentStatus: po.apPaymentStatus || "NOT_PAID",
      supplierInvoiceStatus: po.supplierDocumentStatus || "NONE",
      grnReceiptStatus: po.grnReceiptStatus || "NOT_RECEIVED",
      grnProgressStatus: po.grnProgressStatus || "NONE",
      poStatus: po.status,
    };
  }

  return { ...d, po, lines, header };
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

const PACKING_PACKAGE_TYPES = ["Carton", "Pallet", "Wooden Box", "Crate", "Bundle"];

function newPackingPackage(index = 1) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    packageNo: `Carton-${index}`,
    packageType: "Carton",
    dimensions: "",
    grossWeightKg: "",
    netWeightKg: "",
    packageRemarks: "",
    marksAndNumbers: "",
    items: [],
  };
}

function packageTypeLabel(v) {
  return String(v || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export default function StoreModule() {
  const { auth } = useAuth();
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
  const [grnUiErr, setGrnUiErr] = useState("");
  const [grnRegisterDetail, setGrnRegisterDetail] = useState(null);
  const grnUrlPoLoadedRef = useRef("");
  const grnCsvInputRef = useRef(null);
  const [packAllocInputId, setPackAllocInputId] = useState("");
  const [packAllocQueryId, setPackAllocQueryId] = useState("");
  const [packPackages, setPackPackages] = useState([]);
  const [packAddArticlePkgId, setPackAddArticlePkgId] = useState("");
  const [packAddArticleSearch, setPackAddArticleSearch] = useState("");
  const [packCsvPreview, setPackCsvPreview] = useState(null);
  const packCsvInputRef = useRef(null);
  const [packingStatusFilter, setPackingStatusFilter] = useState("");
  const [dispatchPackInputId, setDispatchPackInputId] = useState("");
  const [dispatchPackQueryId, setDispatchPackQueryId] = useState("");
  const [dispatchLineQty, setDispatchLineQty] = useState({});
  const [dispatchStatusFilter, setDispatchStatusFilter] = useState("");
  const [dispatchHeader, setDispatchHeader] = useState({
    transporter: "",
    trackingNo: "",
    containerNo: "",
    vehicleNo: "",
    driverName: "",
    driverPhone: "",
    remarks: "",
  });

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
      if (import.meta.env.DEV) console.log("[GRN from-po] API response", data);
      const normalized = normalizeGrnFromPoResponse(data);
      if (import.meta.env.DEV) console.log("[GRN from-po] normalized", normalized);
      setGrnPoSnapshot(normalized);
      const lines = normalized.lines || [];
      if (!lines.length) {
        setGrnUiErr("No pending PO lines found for GRN.");
      } else {
        const allReceived = lines.every(
          (ln) => (Number(ln.pendingQty) || 0) <= 0 || ln.lineDisabled === true
        );
        if (allReceived) {
          setGrnUiErr("This PO is fully received. No pending quantity available for GRN.");
        } else {
          setGrnUiErr("");
        }
      }
      const init = {};
      for (const ln of lines) {
        const id = ln.poLineId != null ? String(ln.poLineId) : "";
        if (!id || !isMongoIdString(id)) continue;
        init[id] = {
          selected: false,
          grnQty: String(Math.max(0, Number(ln.pendingQty) || 0)),
          warehouse: GRN_DEFAULT_WAREHOUSE_CODE,
          location: "",
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

  const postGrnFromPoMut = useMutation({
    mutationFn: (body) => apiPost("/grn/post", body),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["grn"] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["store-purchase-orders"] });
      const pid = grnPoSnapshot?.header?._id;
      setGrnLineEdits({});
      if (pid) loadGrnPoMut.mutate(String(pid));
      setGrnUiErr(data?.grnNo ? `Posted ${data.grnNo}` : "GRN posted.");
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
      setGrnUiErr("");
    },
    onError: (e) => setGrnUiErr(e.message || String(e)),
  });

  const cancelGrnMut = useMutation({
    mutationFn: ({ grnNo, reason }) =>
      apiPost(`/grn/${encodeURIComponent(grnNo)}/cancel`, { cancellationReason: reason, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grn"] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["store-purchase-orders"] });
      const pid = grnPoSnapshot?.header?._id;
      if (pid) loadGrnPoMut.mutate(String(pid));
      setGrnRegisterDetail(null);
      setGrnUiErr("");
    },
    onError: (e) => setGrnUiErr(e.message || String(e)),
  });

  const deleteGrnDraftMut = useMutation({
    mutationFn: (id) => apiDelete(`/grn/id/${id}/draft`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["grn"] });
      setGrnUiErr("");
    },
    onError: (e) => setGrnUiErr(e.message || String(e)),
  });

  const downloadGrnCsvTemplate = async () => {
    try {
      const res = await api.get("/grn/csv-template", { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "grn-import-template.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setGrnUiErr(e.message || String(e));
    }
  };

  const onPickGrnCsvFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const poId = grnPoSnapshot?.header?._id;
    if (!poId) {
      setGrnUiErr("Select and load a PO before importing CSV.");
      return;
    }
    try {
      const csvText = await file.text();
      const data = await apiPost("/grn/import-preview", { poId, csvText });
      const errs = data.errors || [];
      if (errs.length) {
        setGrnUiErr(errs.map((x) => `Row ${x.line}: ${x.message}`).join(" · "));
      } else {
        setGrnUiErr("");
      }
      setGrnLineEdits((prev) => {
        const next = { ...prev };
        for (const u of data.updates || []) {
          const id = String(u.poLineId);
          const cur = next[id] || {};
          next[id] = {
            ...cur,
            selected: true,
            grnQty: String(u.grnQty),
            warehouse: u.warehouse || cur.warehouse || GRN_DEFAULT_WAREHOUSE_CODE,
            location: u.location || "",
            remarks: u.remarks != null ? u.remarks : cur.remarks || "",
          };
        }
        return next;
      });
    } catch (err) {
      setGrnUiErr(err.message || String(err));
    }
  };

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

  const { data: pendingPackingAllocations } = useQuery({
    queryKey: ["packing-allocations-pending"],
    queryFn: () => apiGetWithQuery("/packing/allocations/pending", { limit: 200 }),
    enabled: tab === "Packing",
  });

  useEffect(() => {
    const lines = packingFromAlloc?.lines;
    if (!lines?.length) {
      if (!packAllocQueryId) setPackPackages([]);
      return;
    }
    setPackPackages([newPackingPackage(1)]);
    setPackCsvPreview(null);
    setPackAddArticlePkgId("");
  }, [packAllocQueryId, packingFromAlloc]);

  const packingPackageStats = useMemo(() => {
    const byLine = new Map();
    for (const pkg of packPackages || []) {
      for (const item of pkg.items || []) {
        const lineId = String(item.allocationLineId || "");
        byLine.set(lineId, (byLine.get(lineId) || 0) + (Number(item.qty) || 0));
      }
    }
    const lines = (packingFromAlloc?.lines || []).map((ln) => {
      const lineId = String(ln.allocationLineId);
      const inPackages = byLine.get(lineId) || 0;
      const pending = Number(ln.pendingPack) || 0;
      return {
        ...ln,
        inPackages,
        balancePack: Math.max(0, pending - inPackages),
        overPacked: Math.max(0, inPackages - pending),
      };
    });
    return {
      lines,
      hasOverPacked: lines.some((ln) => ln.overPacked > 0),
      totalPackageQty: lines.reduce((sum, ln) => sum + (Number(ln.inPackages) || 0), 0),
      totalPackages: packPackages.length,
      totalGrossWeightKg: packPackages.reduce((sum, pkg) => sum + (Number(pkg.grossWeightKg) || 0), 0),
      totalNetWeightKg: packPackages.reduce((sum, pkg) => sum + (Number(pkg.netWeightKg) || 0), 0),
    };
  }, [packPackages, packingFromAlloc]);

  const packingDraftValidation = useMemo(() => {
    const msgs = [];
    if (!packPackages.length) msgs.push("Add at least one package.");
    for (const pkg of packPackages) {
      const pno = String(pkg.packageNo || "").trim();
      if (!pno) msgs.push("Each package needs a Package No.");
      if (!String(pkg.dimensions || "").trim()) msgs.push(`Package ${pno || "?"}: Dimensions required.`);
      const gross = Number(pkg.grossWeightKg);
      const net = Number(pkg.netWeightKg);
      if (!Number.isFinite(gross) || gross <= 0) msgs.push(`Package ${pno || "?"}: Gross weight required.`);
      if (!Number.isFinite(net) || net <= 0) msgs.push(`Package ${pno || "?"}: Net weight required.`);
      const items = (pkg.items || []).filter((it) => Number(it.qty) > 0);
      if (!items.length) msgs.push(`Package ${pno || "?"} is empty.`);
    }
    if (packingPackageStats.hasOverPacked) msgs.push("Correct over-packed lines.");
    if (packingPackageStats.totalPackageQty <= 0) msgs.push("Pack at least one quantity.");
    return { msgs, ok: msgs.length === 0 };
  }, [packPackages, packingPackageStats]);

  const pendingLinesForAddArticle = useMemo(() => {
    const q = packAddArticleSearch.trim().toLowerCase();
    return (packingPackageStats.lines || []).filter((ln) => {
      if ((Number(ln.balancePack) || 0) <= 0) return false;
      if (!q) return true;
      const hay = [ln.article, ln.description, ln.partNumber, ln.uom].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [packingPackageStats.lines, packAddArticleSearch]);

  const updatePackPackage = useCallback((pkgId, patch) => {
    setPackPackages((prev) => prev.map((p) => (p.id === pkgId ? { ...p, ...patch } : p)));
  }, []);

  const setPackItemQty = useCallback((pkgId, lineId, rawQty) => {
    const qty = Math.max(0, Number(rawQty) || 0);
    setPackPackages((prev) =>
      prev.map((p) => {
        if (p.id !== pkgId) return p;
        const without = (p.items || []).filter((it) => String(it.allocationLineId) !== String(lineId));
        if (qty <= 0) return { ...p, items: without };
        const ln = (packingFromAlloc?.lines || []).find((x) => String(x.allocationLineId) === String(lineId));
        const existing = (p.items || []).find((it) => String(it.allocationLineId) === String(lineId));
        const nextItem = {
          allocationLineId: lineId,
          article: ln?.article || existing?.article || "",
          description: ln?.description || existing?.description || "",
          spn: ln?.partNumber || existing?.spn || "",
          materialCode: ln?.materialCode || existing?.materialCode || "",
          qty,
          uom: ln?.uom || existing?.uom || "PCS",
        };
        return { ...p, items: [...without, nextItem] };
      })
    );
  }, [packingFromAlloc?.lines]);

  const removePackItem = useCallback((pkgId, lineId) => {
    setPackPackages((prev) =>
      prev.map((p) =>
        p.id === pkgId ? { ...p, items: (p.items || []).filter((it) => String(it.allocationLineId) !== String(lineId)) } : p
      )
    );
  }, []);

  const onPickPackingCsvFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !packingFromAlloc?.allocation?._id) return;
    try {
      const csvText = await file.text();
      const data = await apiPost("/packing/import-preview", {
        allocationId: packingFromAlloc.allocation._id,
        csvText,
      });
      setPackCsvPreview(data);
    } catch (err) {
      setPackCsvPreview({ preview: [], errors: [{ line: 0, message: err.message }], blockingErrors: [], canApply: false });
    }
  };

  const applyPackingCsvImport = () => {
    if (!packCsvPreview?.canApply || !packCsvPreview.packages?.length) return;
    setPackPackages(mapImportPackagesToUi(packCsvPreview.packages));
    setPackCsvPreview(null);
  };

  const createPackingDraft = useMutation({
    mutationFn: (body) => apiPost("/packing/draft", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-packing"] });
      qc.invalidateQueries({ queryKey: ["packing-allocations-pending"] });
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
      qc.invalidateQueries({ queryKey: ["packing-allocations-pending"] });
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
      qc.invalidateQueries({ queryKey: ["packing-allocations-pending"] });
      qc.invalidateQueries({ queryKey: ["packing-from-allocation", packAllocQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const { data: dispatchFromPack } = useQuery({
    queryKey: ["dispatch-from-invoice", dispatchPackQueryId],
    queryFn: () => apiGet(`/dispatch/from-invoice/${dispatchPackQueryId}`),
    enabled: tab === "Dispatch" && Boolean(dispatchPackQueryId),
  });

  const { data: pendingDispatchPackings } = useQuery({
    queryKey: ["dispatch-invoices-pending"],
    queryFn: () => apiGetWithQuery("/dispatch/invoices/pending", { limit: 200 }),
    enabled: tab === "Dispatch",
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
      qc.invalidateQueries({ queryKey: ["dispatch-invoices-pending"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-invoice", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const postDispatchMut = useMutation({
    mutationFn: (id) => apiPost(`/dispatch/${id}/post`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-dispatch"] });
      qc.invalidateQueries({ queryKey: ["dispatch-invoices-pending"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-invoice", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const cancelDispatchMut = useMutation({
    mutationFn: ({ id, reason }) => apiPost(`/dispatch/${id}/cancel`, { reason: reason || "" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-dispatch"] });
      qc.invalidateQueries({ queryKey: ["dispatch-invoices-pending"] });
      qc.invalidateQueries({ queryKey: ["dispatch-from-invoice", dispatchPackQueryId] });
      qc.invalidateQueries({ queryKey: ["stock-ledger-unified"] });
      qc.invalidateQueries({ queryKey: ["stock-summary"] });
      qc.invalidateQueries({ queryKey: ["sales-dispatch-status"] });
    },
  });

  const { data: packingList } = useQuery({
    queryKey: ["store-packing", packingStatusFilter],
    queryFn: () => apiGetWithQuery("/packing", { limit: 200, status: packingStatusFilter || undefined }),
    enabled: tab === "Packing",
  });

  const { data: dispatchList } = useQuery({
    queryKey: ["store-dispatch", dispatchStatusFilter],
    queryFn: () => apiGetWithQuery("/dispatch", { limit: 200, status: dispatchStatusFilter || undefined }),
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

  const { data: reportPendingPacking } = useQuery({
    queryKey: ["store-report-pending-packing"],
    queryFn: () => apiGet("/store/reports/pending-packing"),
    enabled: tab === "Store Reports",
  });

  const { data: reportPackedNotInvoiced } = useQuery({
    queryKey: ["store-report-packed-not-invoiced"],
    queryFn: () => apiGet("/store/reports/packed-not-invoiced"),
    enabled: tab === "Store Reports",
  });

  const { data: reportInvoicedNotDispatched } = useQuery({
    queryKey: ["store-report-invoiced-not-dispatched"],
    queryFn: () => apiGet("/store/reports/invoiced-not-dispatched"),
    enabled: tab === "Store Reports",
  });

  const { data: reportCustomerInvoicePendingDispatch } = useQuery({
    queryKey: ["store-report-customer-invoice-pending-dispatch"],
    queryFn: () => apiGet("/store/reports/customer-invoice-pending-dispatch"),
    enabled: tab === "Store Reports",
  });

  const { data: reportDispatchByCustomer } = useQuery({
    queryKey: ["store-report-dispatch-by-customer"],
    queryFn: () => apiGet("/store/reports/dispatch-by-customer"),
    enabled: tab === "Store Reports",
  });

  const { data: reportDispatchByArticle } = useQuery({
    queryKey: ["store-report-dispatch-by-article"],
    queryFn: () => apiGet("/store/reports/dispatch-by-article"),
    enabled: tab === "Store Reports",
  });

  const { data: reportPackingEfficiency } = useQuery({
    queryKey: ["store-report-packing-efficiency"],
    queryFn: () => apiGet("/store/reports/packing-efficiency"),
    enabled: tab === "Store Reports",
  });

  const { data: reportDailyDispatch } = useQuery({
    queryKey: ["store-report-daily-dispatch"],
    queryFn: () => apiGet("/store/reports/daily-dispatch"),
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
  const grnLineRowSelectable = (ln) => {
    const id = ln.poLineId != null ? String(ln.poLineId) : "";
    const pend = Math.max(0, Number(ln.pendingQty) || 0);
    if (ln.lineDisabled === true || pend <= 0) return false;
    return Boolean(id && isMongoIdString(id));
  };
  const grnTotalPending = useMemo(
    () => grnLinesForUi.reduce((s, ln) => s + Math.max(0, Number(ln.pendingQty) || 0), 0),
    [grnLinesForUi]
  );
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
      { key: "dispatchedQty", header: "Dispatched" },
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
            {grnUiErr ? (
              <p
                className={`mt-2 text-xs ${
                  String(grnUiErr).startsWith("Posted ") ? "text-emerald-700" : "text-rose-600"
                }`}
              >
                {grnUiErr}
              </p>
            ) : null}
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
                          if (!grnLineRowSelectable(ln)) continue;
                          const id = String(ln.poLineId);
                          if ((Number(ln.pendingQty) || 0) <= 0) continue;
                          const pend = Math.max(0, Number(ln.pendingQty) || 0);
                          const cur = next[id] || {
                            selected: false,
                            grnQty: String(pend),
                            warehouse: GRN_DEFAULT_WAREHOUSE_CODE,
                            location: "",
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
                          if (!grnLineRowSelectable(ln)) continue;
                          const id = String(ln.poLineId);
                          const pend = Math.max(0, Number(ln.pendingQty) || 0);
                          if (pend <= 0) continue;
                          const cur = next[id] || {
                            selected: false,
                            grnQty: "0",
                            warehouse: GRN_DEFAULT_WAREHOUSE_CODE,
                            location: "",
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
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    onClick={() => downloadGrnCsvTemplate()}
                  >
                    Download GRN CSV template
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    onClick={() => grnCsvInputRef.current?.click()}
                  >
                    Import GRN CSV
                  </button>
                  <input
                    ref={grnCsvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={onPickGrnCsvFile}
                  />
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
                        <th className="px-2 py-2">Location</th>
                        <th className="px-2 py-2">Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grnLinesForUi.map((ln, rowIdx) => {
                        const id = ln.poLineId != null ? String(ln.poLineId) : "";
                        const selectable = grnLineRowSelectable(ln);
                        const rowKey = selectable ? id : `row-${rowIdx}`;
                        const ed = grnLineEdits[id] || {
                          selected: false,
                          grnQty: String(Math.max(0, Number(ln.pendingQty) || 0)),
                          warehouse: GRN_DEFAULT_WAREHOUSE_CODE,
                          location: "",
                          remarks: "",
                        };
                        const pend = Math.max(0, Number(ln.pendingQty) || 0);
                        const qtyNum = Number(ed.grnQty);
                        const qtyInvalid = Number.isFinite(qtyNum) && pend > 0 && qtyNum > pend + 1e-6;
                        return (
                          <tr key={rowKey} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 align-middle">
                              <input
                                type="checkbox"
                                checked={!!ed.selected}
                                disabled={pend <= 0 || !selectable}
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
                                disabled={pend <= 0 || !selectable}
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
                              <input
                                type="text"
                                className="w-full min-w-[160px] max-w-[260px] rounded border px-1 py-0.5"
                                placeholder="Type putaway location (required)"
                                disabled={pend <= 0 || !selectable}
                                value={ed.location}
                                onChange={(e) =>
                                  setGrnLineEdits((p) => ({
                                    ...p,
                                    [id]: { ...ed, location: e.target.value },
                                  }))
                                }
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="w-full min-w-[100px] rounded border px-1 py-0.5"
                                disabled={pend <= 0 || !selectable}
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
                      postGrnFromPoMut.isPending ||
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
                        const id = ln.poLineId != null ? String(ln.poLineId) : "";
                        const ed = grnLineEdits[id];
                        if (!ed?.selected) continue;
                        if (!grnLineRowSelectable(ln)) {
                          setGrnUiErr("Selected line is missing a valid PO line id or has no pending quantity.");
                          return;
                        }
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
                        const loc = String(ed.location || "").trim();
                        if (!loc) {
                          setGrnUiErr("Location is required for each selected GRN line.");
                          return;
                        }
                        linesOut.push({
                          poLineId: ln.poLineId,
                          grnQty: q,
                          warehouse: GRN_DEFAULT_WAREHOUSE_CODE,
                          location: loc,
                          remarks: ed.remarks || "",
                        });
                      }
                      if (!linesOut.length) {
                        setGrnUiErr("Select at least one line with pending quantity and enter GRN qty.");
                        return;
                      }
                      postGrnFromPoMut.mutate({
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
                    {postGrnFromPoMut.isPending ? "Posting GRN..." : "Post GRN"}
                  </button>
                  <span className="text-[11px] text-slate-500">
                    Default warehouse MAIN is applied automatically. Enter location manually for each line.
                  </span>
                  {grnTotalPending <= 0 ? (
                    <span className="text-xs text-amber-700">
                      This PO is fully received. No pending quantity available for GRN.
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-800">GRN register</h3>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">GRN No</th>
                    <th className="px-2 py-2 text-left">Date</th>
                    <th className="px-2 py-2 text-left">PO No</th>
                    <th className="px-2 py-2 text-left">Supplier</th>
                    <th className="px-2 py-2 text-right">Total Qty</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(grns?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-4 text-center text-slate-500">
                        No GRNs
                      </td>
                    </tr>
                  ) : (
                    (grns?.items || []).map((g) => {
                      const totalQty = (g.items || []).reduce(
                        (s, x) => s + (Number(x.acceptedQty ?? x.receivedQty) || 0),
                        0
                      );
                      const canCancel = ["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"].includes(
                        String(g.status || "")
                      );
                      const isDraft = String(g.status || "").toUpperCase() === "DRAFT";
                      return (
                        <tr key={g._id} className="border-t">
                          <td className="px-2 py-2 font-mono">{g.grnNo}</td>
                          <td className="px-2 py-2">{g.grnDate ? fmtDateOnly(g.grnDate) : "—"}</td>
                          <td className="px-2 py-2">{g.poNo || "—"}</td>
                          <td className="px-2 py-2">{g.supplierName || "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{totalQty.toFixed(2)}</td>
                          <td className="px-2 py-2">
                            <StatusPill
                              status={g.status}
                              tone={g.status === "CANCELLED" ? "rose" : g.status === "DRAFT" ? "amber" : "emerald"}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap gap-1">
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-[11px] font-semibold text-slate-800"
                                onClick={() => setGrnRegisterDetail(g)}
                              >
                                View
                              </button>
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-[11px] font-semibold text-slate-800"
                                onClick={() => openGrnRegisterReport(g, { exportPdf: false })}
                              >
                                Print
                              </button>
                              <button
                                type="button"
                                className="rounded border px-2 py-0.5 text-[11px] font-semibold text-slate-800"
                                onClick={() => openGrnRegisterReport(g, { exportPdf: true })}
                              >
                                Export PDF
                              </button>
                              {canCancel ? (
                                <button
                                  type="button"
                                  className="rounded border border-rose-200 px-2 py-0.5 text-[11px] font-semibold text-rose-800 disabled:opacity-40"
                                  disabled={cancelGrnMut.isPending}
                                  onClick={() => {
                                    const reason = window.prompt("Cancellation reason (required):") || "";
                                    if (!reason.trim()) {
                                      setGrnUiErr("Cancellation reason is required.");
                                      return;
                                    }
                                    setGrnUiErr("");
                                    cancelGrnMut.mutate({ grnNo: g.grnNo, reason: reason.trim() });
                                  }}
                                >
                                  Cancel GRN
                                </button>
                              ) : null}
                              {isDraft ? (
                                <button
                                  type="button"
                                  className="rounded border px-2 py-0.5 text-[11px] font-semibold text-slate-600 disabled:opacity-40"
                                  disabled={deleteGrnDraftMut.isPending}
                                  onClick={() => {
                                    if (!window.confirm(`Delete draft ${g.grnNo}?`)) return;
                                    deleteGrnDraftMut.mutate(String(g._id));
                                  }}
                                >
                                  Delete draft
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
            </div>
          </div>
          <Modal
            open={Boolean(grnRegisterDetail)}
            onClose={() => setGrnRegisterDetail(null)}
            title={grnRegisterDetail ? `GRN ${grnRegisterDetail.grnNo}` : "GRN"}
          >
            {grnRegisterDetail ? (
              <div className="max-h-[70vh] space-y-2 overflow-auto text-sm">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">PO</span>{" "}
                    <span className="font-medium">{grnRegisterDetail.poNo || "—"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Supplier</span>{" "}
                    <span className="font-medium">{grnRegisterDetail.supplierName || "—"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Date</span>{" "}
                    <span className="font-medium">
                      {grnRegisterDetail.grnDate ? fmtDateOnly(grnRegisterDetail.grnDate) : "—"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Status</span>{" "}
                    <span className="font-medium">{grnRegisterDetail.status}</span>
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-2 py-1 text-left">Article</th>
                      <th className="px-2 py-1 text-right">Qty</th>
                      <th className="px-2 py-1 text-left">Wh</th>
                      <th className="px-2 py-1 text-left">Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(grnRegisterDetail.items || []).map((it, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1 font-mono">{it.article}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {Number(it.acceptedQty ?? it.receivedQty) || 0}
                        </td>
                        <td className="px-2 py-1">{it.warehouse || "—"}</td>
                        <td className="px-2 py-1">{it.location || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Modal>
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
                  .filter((g) => ["RECEIVED", "PARTIAL_RECEIVED", "CLOSED", "POSTED"].includes(g.status))
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
                    "Dispatched",
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
                    <td colSpan={14} className="px-2 py-6 text-center text-sm text-slate-500">
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
                        <td className="px-2 py-1">{r.dispatchedQty ?? 0}</td>
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
              Select an allocation with pending quantity, load warehouse lines, enter packing details, then create a draft and post it.
            </p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Allocation</label>
                <select
                  className="w-96 rounded border px-2 py-1.5 text-xs"
                  value={packAllocInputId}
                  onChange={(e) => setPackAllocInputId(e.target.value)}
                >
                  <option value="">Select allocation pending packing...</option>
                  {(pendingPackingAllocations?.items || []).map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.allocationNo} | {a.customerName} | OA {a.linkedOANo || "-"} | pending {a.pendingPackQty}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="rounded border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                disabled={!packAllocInputId}
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
              <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-xl border bg-slate-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Pending allocation lines</h4>
                    <span className="text-xs text-slate-500">Packed in packages: {packingPackageStats.totalPackageQty}</span>
                  </div>
                  <div className="overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-white uppercase text-slate-600">
                        <tr>
                          <th className="px-2 py-2 text-left">Article</th>
                          <th className="px-2 py-2 text-left">Description</th>
                          <th className="px-2 py-2 text-right">Allocated</th>
                          <th className="px-2 py-2 text-right">Prev Packed</th>
                          <th className="px-2 py-2 text-right">In Packages</th>
                          <th className="px-2 py-2 text-right">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {packingPackageStats.lines.map((ln) => (
                          <tr
                            key={String(ln.allocationLineId)}
                            className={`border-t ${ln.overPacked > 0 ? "bg-rose-50" : ln.balancePack === 0 ? "bg-emerald-50" : ""}`}
                          >
                            <td className="px-2 py-2 font-mono">{ln.article}</td>
                            <td className="max-w-[220px] truncate px-2 py-2" title={ln.description}>{ln.description || "—"}</td>
                            <td className="px-2 py-2 text-right">{ln.allocatedQty ?? ln.qty}</td>
                            <td className="px-2 py-2 text-right">{ln.alreadyPacked}</td>
                            <td className="px-2 py-2 text-right font-semibold">{ln.inPackages}</td>
                            <td className={`px-2 py-2 text-right font-semibold ${ln.overPacked > 0 ? "text-rose-700" : ""}`}>
                              {ln.overPacked > 0 ? `Over ${ln.overPacked}` : ln.balancePack}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-xl border bg-white p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Package builder</h4>
                      <p className="text-xs text-slate-500">
                        Packages start empty. Add articles manually or use CSV import/export for long lists.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded border px-2 py-1.5 text-xs hover:bg-slate-50"
                        onClick={() =>
                          exportPackingTemplateCsv(
                            packingFromAlloc?.lines,
                            packingFromAlloc?.allocation?.allocationNo
                          )
                        }
                      >
                        Export Packing CSV Template
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-1.5 text-xs hover:bg-slate-50"
                        onClick={() => packCsvInputRef.current?.click()}
                      >
                        Import Packing CSV
                      </button>
                      <input ref={packCsvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPickPackingCsvFile} />
                      <button
                        type="button"
                        className="rounded border px-2 py-1.5 text-xs hover:bg-slate-50"
                        disabled={!packPackages.length}
                        onClick={() =>
                          exportCurrentPackingCsv(packPackages, packingFromAlloc?.allocation?.allocationNo)
                        }
                      >
                        Export Current Packing CSV
                      </button>
                      <button
                        type="button"
                        className="rounded border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                        onClick={() => setPackPackages((prev) => [...prev, newPackingPackage(prev.length + 1)])}
                      >
                        Add package
                      </button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {packPackages.map((pkg) => (
                      <div key={pkg.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="grid gap-2 md:grid-cols-5">
                          <input
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            placeholder="Package no *"
                            value={pkg.packageNo}
                            onChange={(e) =>
                              setPackPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, packageNo: e.target.value } : p)))
                            }
                          />
                          <select
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            value={pkg.packageType}
                            onChange={(e) =>
                              setPackPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, packageType: e.target.value } : p)))
                            }
                          >
                            {PACKING_PACKAGE_TYPES.map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                          <input
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            placeholder="Dimensions LxWxH *"
                            value={pkg.dimensions}
                            onChange={(e) =>
                              setPackPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, dimensions: e.target.value } : p)))
                            }
                          />
                          <input
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            placeholder="Gross wt (kg) *"
                            value={pkg.grossWeightKg}
                            onChange={(e) =>
                              setPackPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, grossWeightKg: e.target.value } : p)))
                            }
                          />
                          <input
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            placeholder="Net wt (kg) *"
                            value={pkg.netWeightKg}
                            onChange={(e) =>
                              setPackPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, netWeightKg: e.target.value } : p)))
                            }
                          />
                        </div>
                        <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto]">
                          <input
                            className="rounded border bg-white px-2 py-1.5 text-xs"
                            placeholder="Package remarks / marks & numbers"
                            value={pkg.packageRemarks}
                            onChange={(e) => updatePackPackage(pkg.id, { packageRemarks: e.target.value, marksAndNumbers: e.target.value })}
                          />
                          <button
                            type="button"
                            className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium hover:bg-slate-100"
                            onClick={() => {
                              setPackAddArticlePkgId(pkg.id);
                              setPackAddArticleSearch("");
                            }}
                          >
                            + Add Article
                          </button>
                          <button
                            type="button"
                            className="rounded border px-2 py-1.5 text-xs text-rose-700 hover:bg-rose-50"
                            onClick={() => setPackPackages((prev) => prev.filter((p) => p.id !== pkg.id))}
                            disabled={packPackages.length <= 1}
                          >
                            Remove package
                          </button>
                        </div>
                        <div className="mt-3 overflow-auto">
                          {(pkg.items || []).length === 0 ? (
                            <p className="text-xs text-slate-500">No articles in this package yet.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="bg-white text-slate-600">
                                <tr>
                                  <th className="px-2 py-1 text-left">Article</th>
                                  <th className="px-2 py-1 text-left">Description</th>
                                  <th className="px-2 py-1 text-left">Part #</th>
                                  <th className="px-2 py-1 text-left">Qty</th>
                                  <th className="px-2 py-1 text-left">UOM</th>
                                  <th className="px-2 py-1 text-right">Balance</th>
                                  <th className="px-2 py-1" />
                                </tr>
                              </thead>
                              <tbody>
                                {(pkg.items || []).map((item) => {
                                  const ln = packingPackageStats.lines.find(
                                    (x) => String(x.allocationLineId) === String(item.allocationLineId)
                                  );
                                  return (
                                    <tr key={`${pkg.id}-${item.allocationLineId}`} className="border-t">
                                      <td className="px-2 py-1 font-mono">{item.article}</td>
                                      <td className="max-w-[120px] truncate px-2 py-1" title={item.description}>
                                        {item.description || "—"}
                                      </td>
                                      <td className="px-2 py-1">{item.spn || "—"}</td>
                                      <td className="px-2 py-1">
                                        <input
                                          type="number"
                                          min={0}
                                          step="any"
                                          className="w-20 rounded border bg-white px-2 py-1 text-xs"
                                          value={item.qty ?? ""}
                                          onChange={(e) => setPackItemQty(pkg.id, item.allocationLineId, e.target.value)}
                                        />
                                      </td>
                                      <td className="px-2 py-1">{item.uom || "PCS"}</td>
                                      <td
                                        className={`px-2 py-1 text-right ${ln?.overPacked > 0 ? "font-semibold text-rose-700" : ""}`}
                                      >
                                        {ln?.overPacked > 0 ? `Over ${ln.overPacked}` : ln?.balancePack ?? "—"}
                                      </td>
                                      <td className="px-2 py-1">
                                        <button
                                          type="button"
                                          className="text-xs text-rose-700 hover:underline"
                                          onClick={() => removePackItem(pkg.id, item.allocationLineId)}
                                        >
                                          Remove
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded border bg-slate-50 p-2 text-xs text-slate-700">
                    Total packages {packingPackageStats.totalPackages} · Gross {packingPackageStats.totalGrossWeightKg} · Net{" "}
                    {packingPackageStats.totalNetWeightKg}
                    {packingPackageStats.hasOverPacked ? (
                      <span className="ml-2 font-semibold text-rose-700">Over-packed lines must be corrected.</span>
                    ) : null}
                    {!packingDraftValidation.ok && packingDraftValidation.msgs.length ? (
                      <span className="mt-1 block text-rose-700">{packingDraftValidation.msgs[0]}</span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="xl:col-span-2 rounded border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                  disabled={createPackingDraft.isPending || !packingFromAlloc?.allocation || !packingDraftValidation.ok}
                  title={packingDraftValidation.msgs[0] || ""}
                  onClick={() => {
                    const packages = packPackages
                      .map((pkg) => ({
                        packageNo: pkg.packageNo,
                        packageType: pkg.packageType,
                        dimensions: pkg.dimensions,
                        grossWeightKg: Number(pkg.grossWeightKg) || 0,
                        netWeightKg: Number(pkg.netWeightKg) || 0,
                        packageRemarks: pkg.packageRemarks,
                        marksAndNumbers: pkg.marksAndNumbers || pkg.packageRemarks,
                        items: (pkg.items || []).filter((item) => Number(item.qty) > 0),
                      }))
                      .filter((pkg) => pkg.packageNo && pkg.items.length);
                    createPackingDraft.mutate({
                      allocationId: packingFromAlloc.allocation._id,
                      packages,
                      marksAndNumbers: packages.map((pkg) => pkg.marksAndNumbers).filter(Boolean).join(", "),
                    });
                  }}
                >
                  Create draft packing
                </button>
              </div>
            ) : packAllocQueryId ? (
              <p className="text-xs text-slate-500">No lines to pack (or allocation not found).</p>
            ) : null}

            <Modal
              open={Boolean(packAddArticlePkgId)}
              title="Add article to package"
              onClose={() => setPackAddArticlePkgId("")}
            >
              <input
                className="mb-3 w-full rounded border px-2 py-1.5 text-sm"
                placeholder="Search article, description, part number…"
                value={packAddArticleSearch}
                onChange={(e) => setPackAddArticleSearch(e.target.value)}
                autoFocus
              />
              <div className="max-h-72 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Description</th>
                      <th className="px-2 py-2 text-left">Part #</th>
                      <th className="px-2 py-2 text-left">UOM</th>
                      <th className="px-2 py-2 text-right">Balance</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {pendingLinesForAddArticle.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-2 py-4 text-center text-slate-500">
                          No pending lines match your search.
                        </td>
                      </tr>
                    ) : (
                      pendingLinesForAddArticle.map((ln) => (
                        <tr key={String(ln.allocationLineId)} className="border-t hover:bg-slate-50">
                          <td className="px-2 py-2 font-mono">{ln.article}</td>
                          <td className="max-w-[160px] truncate px-2 py-2" title={ln.description}>
                            {ln.description || "—"}
                          </td>
                          <td className="px-2 py-2">{ln.partNumber || "—"}</td>
                          <td className="px-2 py-2">{ln.uom || "PCS"}</td>
                          <td className="px-2 py-2 text-right font-semibold">{ln.balancePack}</td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              className="rounded border px-2 py-0.5 text-xs hover:bg-white"
                              onClick={() => {
                                const max = Number(ln.balancePack) || 0;
                                const raw = window.prompt(`Qty for ${ln.article} (max ${max})`, String(max));
                                if (raw == null) return;
                                const qty = Number(raw);
                                if (!Number.isFinite(qty) || qty <= 0) return;
                                setPackItemQty(packAddArticlePkgId, ln.allocationLineId, qty);
                                setPackAddArticlePkgId("");
                              }}
                            >
                              Add
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Modal>

            <Modal
              open={Boolean(packCsvPreview)}
              title="Import packing CSV — preview"
              onClose={() => setPackCsvPreview(null)}
              wide
            >
              {(packCsvPreview?.blockingErrors || packCsvPreview?.errors || []).length > 0 ? (
                <div className="mb-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                  {(packCsvPreview.blockingErrors || packCsvPreview.errors || []).map((e, i) => (
                    <div key={i}>
                      {e.line ? `Row ${e.line}: ` : ""}
                      {e.message}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="max-h-64 overflow-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100">
                    <tr>
                      <th className="px-2 py-1 text-left">Row</th>
                      <th className="px-2 py-1 text-left">Package</th>
                      <th className="px-2 py-1 text-left">Article</th>
                      <th className="px-2 py-1 text-left">Description</th>
                      <th className="px-2 py-1 text-right">Qty</th>
                      <th className="px-2 py-1 text-left">Status</th>
                      <th className="px-2 py-1 text-left">Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(packCsvPreview?.preview || []).map((row, i) => (
                      <tr key={i} className={`border-t ${row.status === "error" ? "bg-rose-50" : ""}`}>
                        <td className="px-2 py-1">{row.line}</td>
                        <td className="px-2 py-1">{row.packageNo}</td>
                        <td className="px-2 py-1 font-mono">{row.article}</td>
                        <td className="px-2 py-1">{row.description}</td>
                        <td className="px-2 py-1 text-right">{row.qty}</td>
                        <td className="px-2 py-1">{row.status}</td>
                        <td className="px-2 py-1 text-slate-600">{row.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="rounded border px-3 py-1.5 text-xs" onClick={() => setPackCsvPreview(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  disabled={!packCsvPreview?.canApply}
                  onClick={applyPackingCsvImport}
                >
                  Apply import
                </button>
              </div>
            </Modal>
          </div>

          <div className="rounded-2xl border bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Packing documents</h3>
              <div className="flex flex-wrap gap-1">
                {["", "DRAFT", "PARTIALLY_PACKED", "FULLY_PACKED", "CANCELLED"].map((st) => (
                  <button
                    key={st || "ALL"}
                    type="button"
                    className={`rounded border px-2 py-1 text-xs ${packingStatusFilter === st ? "bg-slate-900 text-white" : "hover:bg-slate-50"}`}
                    onClick={() => setPackingStatusFilter(st)}
                  >
                    {st || "All"}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">Packing No</th>
                    <th className="px-2 py-2 text-left">Customer</th>
                    <th className="px-2 py-2 text-left">Allocation</th>
                    <th className="px-2 py-2 text-right">Packages</th>
                    <th className="px-2 py-2 text-right">Gross Wt</th>
                    <th className="px-2 py-2 text-right">Net Wt</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(packingList?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-xs text-slate-500">
                        No packing records.
                      </td>
                    </tr>
                  ) : (
                    (packingList?.items || []).map((p) => (
                      <tr key={p._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{p.packingNo}</td>
                        <td className="px-2 py-2">{p.customerName}</td>
                        <td className="px-2 py-2 font-mono text-xs">{p.allocationNo}</td>
                        <td className="px-2 py-2 text-right">{p.totalPackages || (p.packages || []).length || "—"}</td>
                        <td className="px-2 py-2 text-right">{p.totalGrossWeightKg || "—"}</td>
                        <td className="px-2 py-2 text-right">{p.totalNetWeightKg || "—"}</td>
                        <td className="px-2 py-2">
                          <StatusPill status={p.status} tone={String(p.status).includes("FULLY") ? "emerald" : String(p.status).includes("PARTIALLY") ? "amber" : "slate"} />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span className="flex flex-wrap justify-end gap-1">
                            <button
                              type="button"
                              className="rounded border px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
                              onClick={() => renderStorePackingListPrintWindow(p, auth?.company || {}, false)}
                            >
                              Print
                            </button>
                            <button
                              type="button"
                              className="rounded border px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
                              onClick={() => renderStorePackingListPrintWindow(p, auth?.company || {}, true)}
                            >
                              PDF
                            </button>
                          {p.status === "DRAFT" ? (
                            <>
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
                            </>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                          </span>
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
            <h3 className="mb-2 text-sm font-semibold">New dispatch from posted Sales Invoice</h3>
            <p className="mb-3 text-xs text-slate-600">
              Select a posted Sales Invoice with pending dispatch quantity, enter transporter details, then create draft dispatch and post.
            </p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-600">Sales Invoice</label>
                <select
                  className="w-96 rounded border px-2 py-1.5 text-xs"
                  value={dispatchPackInputId}
                  onChange={(e) => setDispatchPackInputId(e.target.value)}
                >
                  <option value="">Select invoice pending dispatch...</option>
                  {(pendingDispatchPackings?.items || []).map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.invoiceNo} | {p.customerName} | packing {p.packingNo || "-"} | pending {p.pendingDispatchQty}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="rounded border bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                disabled={!dispatchPackInputId}
                onClick={() => setDispatchPackQueryId(dispatchPackInputId)}
              >
                Load invoice
              </button>
            </div>
            <div className="mb-3 grid gap-2 rounded border bg-slate-50 p-3 md:grid-cols-4">
              {[
                ["transporter", "Transporter"],
                ["trackingNo", "AWB/BL/Tracking"],
                ["containerNo", "Container no"],
                ["vehicleNo", "Vehicle no"],
                ["driverName", "Driver"],
                ["driverPhone", "Driver phone"],
                ["remarks", "Dispatch remarks"],
              ].map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1 text-xs text-slate-600">
                  {label}
                  <input
                    className="rounded border bg-white px-2 py-1.5 text-xs"
                    value={dispatchHeader[key] || ""}
                    onChange={(e) => setDispatchHeader((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            {dispatchFromPack?.invoice ? (
              <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                <div>
                  <span className="font-semibold">{dispatchFromPack.invoice.invoiceNo}</span> ·{" "}
                  {dispatchFromPack.invoice.customerName}
                </div>
                <div className="mt-1 text-slate-600">
                  Packing {dispatchFromPack.invoice.linkedStorePackingNo || "—"} · Allocation{" "}
                  {dispatchFromPack.invoice.linkedOrderAllocationNo || "—"}
                </div>
              </div>
            ) : null}
            {dispatchFromPack?.lines?.length ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="px-2 py-2 text-left">Article</th>
                      <th className="px-2 py-2 text-left">Packed</th>
                      <th className="px-2 py-2 text-left">Dispatched</th>
                      <th className="px-2 py-2 text-left">Pending dispatch</th>
                      <th className="px-2 py-2 text-left">Dispatch qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dispatchFromPack.lines.map((ln) => (
                      <tr key={String(ln.packingLineId)} className="border-t">
                        <td className="px-2 py-2 font-mono">{ln.article}</td>
                        <td className="px-2 py-2">{ln.packedQty}</td>
                        <td className="px-2 py-2">{ln.dispatchedQty}</td>
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
                  disabled={createDispatchDraft.isPending || !dispatchFromPack?.invoice}
                  onClick={() => {
                    const lines = (dispatchFromPack.lines || [])
                      .map((ln) => ({
                        invoiceLineId: ln.invoiceLineId,
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
                      salesInvoiceId: dispatchFromPack.invoice._id,
                      transporter: dispatchHeader.transporter,
                      courier: dispatchHeader.transporter,
                      awbNo: dispatchHeader.trackingNo,
                      trackingNo: dispatchHeader.trackingNo,
                      blNo: dispatchHeader.trackingNo,
                      containerNo: dispatchHeader.containerNo,
                      vehicleNo: dispatchHeader.vehicleNo,
                      driverName: dispatchHeader.driverName,
                      driverPhone: dispatchHeader.driverPhone,
                      remarks: dispatchHeader.remarks,
                      lines,
                    });
                  }}
                >
                  Create draft dispatch
                </button>
              </div>
            ) : dispatchPackQueryId ? (
              <p className="text-xs text-slate-500">Nothing pending or invoice not posted.</p>
            ) : null}
          </div>

          <div className="rounded-2xl border bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Dispatch documents</h3>
              <div className="flex flex-wrap gap-1">
                {["", "DRAFT", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED", "CANCELLED"].map((st) => (
                  <button
                    key={st || "ALL"}
                    type="button"
                    className={`rounded border px-2 py-1 text-xs ${dispatchStatusFilter === st ? "bg-slate-900 text-white" : "hover:bg-slate-50"}`}
                    onClick={() => setDispatchStatusFilter(st)}
                  >
                    {st || "All"}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">Dispatch No</th>
                    <th className="px-2 py-2 text-left">Customer</th>
                    <th className="px-2 py-2 text-left">Invoice</th>
                    <th className="px-2 py-2 text-left">Packing</th>
                    <th className="px-2 py-2 text-left">Transporter</th>
                    <th className="px-2 py-2 text-left">Tracking</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(dispatchList?.items || []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-xs text-slate-500">
                        No dispatch records.
                      </td>
                    </tr>
                  ) : (
                    (dispatchList?.items || []).map((d) => (
                      <tr key={d._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{d.dispatchNo}</td>
                        <td className="px-2 py-2">{d.customerName}</td>
                        <td className="px-2 py-2 font-mono text-xs">{d.salesInvoiceNo || "—"}</td>
                        <td className="px-2 py-2 font-mono text-xs">{d.packingNo}</td>
                        <td className="px-2 py-2 text-xs">{d.transporter || d.courier || "—"}</td>
                        <td className="px-2 py-2 text-xs">{d.trackingNo || d.awbNo || d.blNo || "—"}</td>
                        <td className="px-2 py-2">
                          <StatusPill status={d.status} tone={String(d.status).includes("FULLY") ? "emerald" : String(d.status).includes("PARTIALLY") ? "amber" : "slate"} />
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
            <h3 className="mb-2 text-sm font-semibold">Pending Packing</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportPendingPacking?.items || []).map((r) => (
                <div key={r._id} className="border-b py-1">
                  {r.allocationNo} · {r.customerName} · pending {r.pendingPackQty}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 rounded border px-2 py-1 text-xs"
              onClick={() =>
                downloadCsv(
                  "pending-packing.csv",
                  [
                    { key: "allocationNo", header: "Allocation" },
                    { key: "linkedOANo", header: "OA" },
                    { key: "customerName", header: "Customer" },
                    { key: "allocatedQty", header: "Allocated" },
                    { key: "alreadyPackedQty", header: "Packed" },
                    { key: "pendingPackQty", header: "Pending Pack" },
                  ],
                  reportPendingPacking?.items || []
                )
              }
            >
              Export CSV
            </button>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Packed Not Invoiced</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportPackedNotInvoiced?.items || []).map((r) => (
                <div key={r.packingNo} className="border-b py-1">
                  {r.packingNo} · {r.customerName} · pending invoice {r.pendingInvoiceQty}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Invoiced Not Dispatched</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportInvoicedNotDispatched?.items || []).map((r) => (
                <div key={r.invoiceNo} className="border-b py-1">
                  {r.invoiceNo} · {r.customerName} · pending dispatch {r.pendingDispatchQty}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Customer Invoice Pending Dispatch</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportCustomerInvoicePendingDispatch?.items || []).map((r) => (
                <div key={r.customerName} className="border-b py-1">
                  {r.customerName} · invoices {r.invoiceCount} · pending {r.pendingDispatchQty}
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
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Dispatch by Customer</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportDispatchByCustomer?.items || []).map((r) => (
                <div key={r.customerName} className="border-b py-1">
                  {r.customerName} · qty {r.dispatchQty} · docs {r.dispatchCount}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Dispatch by Article</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportDispatchByArticle?.items || []).map((r) => (
                <div key={r.article} className="border-b py-1">
                  <span className="font-mono">{r.article}</span> · qty {r.dispatchQty} · lines {r.dispatchCount}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Packing Efficiency</h3>
            <div className="text-3xl font-semibold text-slate-900">
              {Number(reportPackingEfficiency?.efficiencyPct || 0).toFixed(1)}%
            </div>
            <div className="mt-2 text-xs text-slate-600">
              Allocated {reportPackingEfficiency?.allocatedQty || 0} · Packed {reportPackingEfficiency?.packedQty || 0} · Pending{" "}
              {reportPackingEfficiency?.pendingQty || 0}
            </div>
          </div>
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold">Daily Dispatch Report</h3>
            <div className="max-h-64 overflow-auto text-xs">
              {(reportDailyDispatch?.items || []).map((r) => (
                <div key={r.dispatchDate} className="border-b py-1">
                  {r.dispatchDate} · qty {r.dispatchQty} · docs {r.dispatchCount}
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
