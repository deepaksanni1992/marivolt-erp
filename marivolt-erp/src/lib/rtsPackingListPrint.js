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
import { buildCustomerAddressInfoRows } from "./customerTransactionFields.js";

function money(n) {
  return Number(n || 0).toFixed(2);
}

const RTS_LINE_COLUMNS = [
  { key: "sno", header: "S No.", className: "col-sno" },
  { key: "part", header: "Part #" },
  { key: "desc", header: "Description" },
  { key: "uom", header: "UOM", className: "col-center" },
  { key: "qty", header: "Qty", className: "col-center" },
  { key: "unitWt", header: "Unit Wt (Kg)", className: "col-right" },
  { key: "totalWt", header: "Total Wt (Kg)", className: "col-right" },
  { key: "coo", header: "COO", className: "col-center" },
];

/** RTS / sales packing list — same commercial layout; no Article column. */
export function renderRtsPackingListPrintWindow({ rts, company, autoPrint = false }) {
  const lines = rts?.lines || [];
  const boxes = Array.isArray(rts?.packingDetails?.boxes) ? rts.packingDetails.boxes : [];
  const totalBoxes = boxes.reduce((acc, b) => acc + (Number(b.count || 0) || 0), 0);
  const brandingName = company?.name || company?.companyName || "";

  const header = buildReportHeaderHtml({
    documentTitle: "Packing List",
    metaLines: [
      { label: "RTS No", value: rts?.rtsNo || "-" },
      { label: "Date", value: fmtReportDate(rts?.rtsDate) },
      { label: "Allocation", value: rts?.linkedOrderAllocationNo || "-" },
      { label: "Customer", value: rts?.customerName || "-" },
    ],
    company,
    brandingName,
  });

  const cards = buildReportInfoCardsHtml({
    left: {
      title: "Customer & Address Info",
      rows: buildCustomerAddressInfoRows(rts || {}),
    },
    right: {
      title: "Machine Details",
      rows: [
        { label: "Vertical", value: rts?.vertical || "-" },
        { label: "Brand", value: rts?.engine || "-" },
        { label: "Model", value: rts?.model || "-" },
        { label: "Config", value: rts?.config || "-" },
        { label: "ESN", value: rts?.esn || "-" },
        { label: "Currency", value: rts?.currency || "-" },
      ],
    },
  });

  let serial = 0;
  const lineTable = buildReportTableHtml({
    columns: RTS_LINE_COLUMNS,
    rows: lines.map((line) => {
      serial += 1;
      return {
        className: "package-item-row",
        cells: [
          String(serial),
          line.partNumber || "",
          line.description || "",
          line.uom || "",
          String(line.qty || 0),
          line.unitWeightKg == null ? "" : money(line.unitWeightKg),
          line.totalWeightKg == null ? "" : money(line.totalWeightKg),
          line.coo || "",
        ],
      };
    }),
  });

  const boxTable = boxes.length
    ? buildReportTableHtml({
        columns: [
          { key: "sn", header: "S/N", className: "col-sno" },
          { key: "material", header: "Material" },
          { key: "count", header: "Count", className: "col-center" },
          { key: "dims", header: "Dimensions (mm)" },
        ],
        rows: boxes.map((b, i) => ({
          cells: [String(i + 1), b.material || "-", String(Number(b.count || 0)), b.dimensionsMm || "-"],
        })),
      })
    : "";

  const totals = buildReportTotalsHtml([
    { label: "Total Weight (Kg)", value: money(rts?.packingDetails?.totalWeightKg || 0) },
    { label: "Total Boxes", value: String(Number(totalBoxes || rts?.packingDetails?.boxCount || 0)), bold: true },
  ]);

  openCommercialReportPrintWindow({
    title: rts?.rtsNo || "Packing List",
    bodyInnerHtml:
      header + cards + lineTable + boxTable + totals + buildMarivoltTermsHtml(brandingName) + buildReportDocNoteHtml(),
    brandingName,
    autoPrint,
    extraCss: PACKING_LIST_EXTRA_CSS,
  });
}
