import {
  buildMarivoltTermsHtml,
  buildReportDocNoteHtml,
  buildReportHeaderHtml,
  buildReportInfoCardsHtml,
  buildReportTableHtml,
  buildReportTotalsHtml,
  fmtReportDate,
  openCommercialReportPrintWindow,
  PACKING_LIST_EXTRA_CSS,
} from "./commercialReportLayout.js";
import {
  buildStorePackingListPrintRows,
  PACKING_LIST_PRINT_COLUMNS,
} from "./packingListTable.js";
import { buildCustomerAddressInfoRows } from "./customerTransactionFields.js";

function packageTypeLabel(v) {
  return String(v || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function fmtWeight(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return "";
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeStorePackingPackages(packing) {
  const raw = packing?.packages;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((pkg) => ({
      ...pkg,
      items: (pkg.items || []).filter((it) => Number(it.qty ?? it.packQty) > 0),
    }));
  }
  const legacyLines = packing?.lines || [];
  if (!legacyLines.length) return [];
  return [
    {
      packageNo: "Package 1",
      packageType: "CARTON",
      dimensions: "",
      grossWeightKg: packing?.totalGrossWeightKg || 0,
      netWeightKg: packing?.totalNetWeightKg || 0,
      packageRemarks: packing?.marksAndNumbers || "",
      items: legacyLines.map((ln) => ({
        spn: ln.spn || ln.partNumber || "",
        description: ln.description || "",
        uom: ln.uom || "PCS",
        qty: ln.qty ?? ln.packQty ?? 0,
      })),
    },
  ];
}

/**
 * Store packing list — quotation/proforma layout for Okeanos & Marivolt.
 * @param {object} packing StorePacking document (with packages or legacy lines)
 * @param {object} company Active company from auth (optional)
 * @param {boolean} autoPrint
 */
export function renderStorePackingListPrintWindow(packing, company = {}, autoPrint = false) {
  if (!packing) return;
  const brandingName = company.name || company.companyName || "";
  const packages = normalizeStorePackingPackages(packing);
  let totalQty = 0;
  for (const pkg of packages) {
    for (const item of pkg.items || []) {
      totalQty += Number(item.qty ?? item.packQty) || 0;
    }
  }

  const header = buildReportHeaderHtml({
    documentTitle: "Packing List",
    metaLines: [
      { label: "No", value: packing.packingNo || "-" },
      { label: "Date", value: fmtReportDate(packing.packingDate) },
      { label: "Allocation", value: packing.allocationNo || "-" },
      { label: "OA Ref", value: packing.linkedOANo || "-" },
      { label: "PI Ref", value: packing.linkedProformaNo || "-" },
    ],
    company,
    brandingName,
  });

  const cards = buildReportInfoCardsHtml({
    left: {
      title: "Customer & Address Info",
      rows: buildCustomerAddressInfoRows(packing),
    },
    right: {
      title: "Machine Details",
      rows: [
        { label: "Vertical", value: packing.vertical || "-" },
        { label: "Brand", value: packing.engine || "-" },
        { label: "Model", value: packing.model || "-" },
        { label: "Config", value: packing.config || "-" },
        { label: "ESN", value: packing.esn || "-" },
        { label: "Currency", value: packing.currency || "USD" },
      ],
    },
  });

  const table = buildReportTableHtml({
    columns: PACKING_LIST_PRINT_COLUMNS,
    rows: buildStorePackingListPrintRows(packages, { packageTypeLabel, fmtWeight }),
  });

  const totals = buildReportTotalsHtml([
    { label: "Total Packages", value: String(packing.totalPackages || packages.length) },
    { label: "Total Gross Weight (Kg)", value: fmtWeight(packing.totalGrossWeightKg) || "0.00" },
    { label: "Total Net Weight (Kg)", value: fmtWeight(packing.totalNetWeightKg) || "0.00" },
    { label: "Total Qty", value: String(totalQty), bold: true },
  ]);

  const body =
    header +
    cards +
    table +
    totals +
    buildMarivoltTermsHtml(brandingName) +
    buildReportDocNoteHtml();

  openCommercialReportPrintWindow({
    title: `Packing List ${packing.packingNo || ""}`,
    bodyInnerHtml: body,
    brandingName,
    autoPrint,
    extraCss: PACKING_LIST_EXTRA_CSS,
  });
}
