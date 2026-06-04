/**
 * Global printable report table layout (Okeanos & Marivolt).
 * Safe fixed layout with colgroup — no letter-by-letter wrapping.
 */

/** Browser Print preview window width (unchanged) */
export const PRINT_PREVIEW_VIEWPORT_WIDTH = 1200;

/**
 * Export PDF only — wide custom page for item-heavy reports (quotation, OA, PI, SI, PO, packing, GRN).
 * Does not affect browser Print preview.
 */
export const PDF_OPTS_ITEM_LINES = {
  wideExport: true,
  width: "420mm",
  height: "297mm",
  printBackground: true,
  preferCSSPageSize: true,
  margin: {
    top: "8mm",
    right: "8mm",
    bottom: "10mm",
    left: "8mm",
  },
  viewport: {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
  },
};

/** Prevent print/PDF wrappers from clipping table right edge */
export const REPORT_PRINT_CONTAINER_CSS = `
  .report-page,
  .report-content,
  .print-page,
  .print-body {
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    overflow: visible;
  }

  body.report-print,
  body.po-print-document {
    overflow: visible;
    max-width: 100%;
  }
`;

export const GLOBAL_REPORT_TABLE_CSS = `
${REPORT_PRINT_CONTAINER_CSS}

  .report-table,
  table.report-lines-table,
  table.po-lines-table,
  table.data-table {
    width: 100%;
    max-width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    border: 1px solid #cfcfcf;
    box-sizing: border-box;
  }

  .report-table th,
  .report-table td,
  table.report-lines-table th,
  table.report-lines-table td,
  table.po-lines-table th,
  table.po-lines-table td,
  table.data-table th,
  table.data-table td {
    padding: 6px 8px;
    border: 1px solid #ddd;
    font-size: 11px;
    line-height: 1.3;
    vertical-align: top;
    word-break: normal;
    overflow-wrap: break-word;
    white-space: normal;
    box-sizing: border-box;
    max-width: 100%;
  }

  .report-table th,
  table.report-lines-table th,
  table.po-lines-table th,
  table.data-table th {
    font-weight: 700;
    text-align: left;
    background: #f5f5f5;
    word-break: normal;
    overflow-wrap: normal;
    white-space: normal;
  }

  .report-table thead,
  table.report-lines-table thead,
  table.po-lines-table thead,
  table.data-table thead {
    display: table-header-group;
  }

  .report-table tr,
  table.report-lines-table tr,
  table.po-lines-table tr,
  table.data-table tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  /* Alignment only — widths come from colgroup % */
  .report-table .col-sno,
  table.report-lines-table .col-sno,
  table.po-lines-table .col-sno {
    text-align: center;
  }

  .report-table .col-uom,
  table.report-lines-table .col-uom,
  table.po-lines-table .col-uom,
  table.report-lines-table td.col-center {
    text-align: center;
  }

  .report-table .col-qty,
  .report-table .col-price,
  .report-table .col-total,
  .report-table .col-weight,
  .report-table td.right,
  table.report-lines-table td.col-right,
  table.po-lines-table .col-qty,
  table.po-lines-table .col-price,
  table.po-lines-table .col-total {
    text-align: right;
  }

  .report-table th.col-qty,
  .report-table th.col-price,
  .report-table th.col-total,
  .report-table th.col-sno,
  .report-table th.col-weight,
  .report-table th.right,
  table.report-lines-table th.col-right {
    text-align: center;
  }

  tr.package-group-header td {
    background: #eef2f7 !important;
    font-weight: 700;
    color: #1f3a5f;
    border-top: 2px solid #cbd5e1;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .report-table th:first-child,
  .report-table td:first-child,
  table.report-lines-table th:first-child,
  table.report-lines-table td:first-child,
  table.po-lines-table th:first-child,
  table.po-lines-table td:first-child,
  table.data-table th:first-child,
  table.data-table td:first-child {
    border-left: 1px solid #cfcfcf !important;
  }

  .report-table th:last-child,
  .report-table td:last-child,
  table.report-lines-table th:last-child,
  table.report-lines-table td:last-child,
  table.po-lines-table th:last-child,
  table.po-lines-table td:last-child,
  table.data-table th:last-child,
  table.data-table td:last-child {
    border-right: 1px solid #cfcfcf !important;
  }

  .report-table thead tr:first-child th,
  table.report-lines-table thead tr:first-child th,
  table.po-lines-table thead tr:first-child th,
  table.data-table thead tr:first-child th {
    border-top: 1px solid #cfcfcf !important;
  }

  .report-table tbody tr:last-child td,
  table.report-lines-table tbody tr:last-child td,
  table.po-lines-table tbody tr:last-child td,
  table.data-table tbody tr:last-child td {
    border-bottom: 1px solid #cfcfcf !important;
  }
`;

/** Quotation / OA / PI / Proforma — 100% column split */
export const SALES_COMMERCIAL_COLGROUP = `
<colgroup>
  <col style="width:5%" />
  <col style="width:18%" />
  <col style="width:25%" />
  <col style="width:6%" />
  <col style="width:5%" />
  <col style="width:8%" />
  <col style="width:9%" />
  <col style="width:15%" />
  <col style="width:9%" />
</colgroup>`;

export const SALES_INVOICE_COLGROUP = `
<colgroup>
  <col style="width:5%" />
  <col style="width:15%" />
  <col style="width:27%" />
  <col style="width:6%" />
  <col style="width:5%" />
  <col style="width:9%" />
  <col style="width:9%" />
  <col style="width:9%" />
  <col style="width:15%" />
</colgroup>`;

export const ORDER_ALLOCATION_COLGROUP = `
<colgroup>
  <col style="width:4%" />
  <col style="width:9%" />
  <col style="width:13%" />
  <col style="width:24%" />
  <col style="width:5%" />
  <col style="width:5%" />
  <col style="width:5%" />
  <col style="width:5%" />
  <col style="width:15%" />
  <col style="width:10%" />
</colgroup>`;

export const PO_LINE_COLGROUP = `
<colgroup>
  <col style="width:4%" />
  <col style="width:24%" />
  <col style="width:18%" />
  <col style="width:5%" />
  <col style="width:5%" />
  <col style="width:9%" />
  <col style="width:10%" />
  <col style="width:9%" />
  <col style="width:16%" />
</colgroup>`;

export const PACKING_LIST_COLGROUP = `
<colgroup>
  <col style="width:5%" />
  <col style="width:10%" />
  <col style="width:8%" />
  <col style="width:11%" />
  <col style="width:9%" />
  <col style="width:9%" />
  <col style="width:15%" />
  <col style="width:24%" />
  <col style="width:5%" />
  <col style="width:4%" />
</colgroup>`;

export const LOGISTICS_PACKING_COLGROUP = `
<colgroup>
  <col style="width:14%" />
  <col style="width:26%" />
  <col style="width:6%" />
  <col style="width:6%" />
  <col style="width:8%" />
  <col style="width:10%" />
  <col style="width:6%" />
  <col style="width:14%" />
  <col style="width:10%" />
</colgroup>`;

/** Default % width per column class (dynamic export tables). */
const COL_CLASS_WIDTH_PCT = {
  "col-sno": 5,
  "col-part": 18,
  "col-article": 12,
  "col-desc": 25,
  "col-uom": 6,
  "col-qty": 5,
  "col-price": 8,
  "col-total": 9,
  "col-remarks": 15,
  "col-availability": 9,
  "col-avail": 9,
  "col-weight": 8,
  "col-lead": 8,
  "col-pack": 8,
  "col-pack-type": 7,
  "col-dim": 10,
};

/** Build colgroup with percentage widths that fit the printable page. */
export function buildColgroupHtml(colClasses) {
  const classes = (colClasses || []).map((cls) => {
    return (
      String(cls || "")
        .split(/\s+/)
        .find((c) => c.startsWith("col-")) || "col-flex"
    );
  });
  if (!classes.length) return "<colgroup></colgroup>";

  const flexIdx = [];
  let fixedSum = 0;
  const widths = classes.map((primary, i) => {
    const pct = COL_CLASS_WIDTH_PCT[primary];
    if (pct == null) {
      flexIdx.push(i);
      return null;
    }
    fixedSum += pct;
    return pct;
  });

  const flexCount = flexIdx.length;
  const remain = Math.max(0, 100 - fixedSum);
  const flexEach = flexCount ? remain / flexCount : 0;

  const cols = widths
    .map((pct, i) => {
      const w = pct != null ? pct : flexEach;
      const label = Number.isFinite(w) ? `${Math.max(1, w).toFixed(2)}%` : "10%";
      return `<col style="width:${label}" />`;
    })
    .join("");
  return `<colgroup>${cols}</colgroup>`;
}

const REPORT_TABLE_OVERFLOW_SELECTOR =
  ".report-table, table.report-lines-table, table.po-lines-table, table.data-table";

/**
 * Debug: tables wider than their container clip the right border in PDF.
 * @param {Document} [doc]
 * @returns {{ index: number, scrollWidth: number, clientWidth: number, className: string }[]}
 */
export function findOverflowingReportTables(doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return [];
  return [...doc.querySelectorAll(REPORT_TABLE_OVERFLOW_SELECTOR)]
    .map((table, index) => {
      const scrollWidth = table.scrollWidth;
      const clientWidth = table.clientWidth;
      return {
        index,
        scrollWidth,
        clientWidth,
        className: table.className,
        overflow: scrollWidth > clientWidth + 1,
      };
    })
    .filter((row) => row.overflow);
}

/** Log overflow tables to the console (browser preview / dev). */
export function logReportTableOverflowCheck(doc = typeof document !== "undefined" ? document : null) {
  const issues = findOverflowingReportTables(doc);
  if (issues.length) {
    console.warn(
      "[report-table] scrollWidth > clientWidth — table may clip right border:",
      issues.map(({ index, scrollWidth, clientWidth, className }) => ({
        index,
        scrollWidth,
        clientWidth,
        className,
      })),
    );
  }
  return issues;
}

/** Quotation / OA / Proforma / standard sales line table header */
export const SALES_COMMERCIAL_LINE_TABLE_HEAD = `
  <th class="col-sno">Serial number</th>
  <th class="col-part">Part number</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty">QTY</th>
  <th class="col-price">Price</th>
  <th class="col-total">Total price</th>
  <th class="col-remarks">Remarks</th>
  <th class="col-availability">Availability</th>`;

/** Tax / sales invoice line table */
export const SALES_INVOICE_LINE_TABLE_HEAD = `
  <th class="col-sno">Pos.</th>
  <th class="col-part">Part Number</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty">QTY</th>
  <th class="col-price">Unit price</th>
  <th class="col-total">Total price</th>
  <th class="col-weight">Unit Wt</th>
  <th class="col-weight">Total Wt</th>`;

/** Order allocation line table */
export const ORDER_ALLOCATION_LINE_TABLE_HEAD = `
  <th class="col-sno">S/N</th>
  <th class="col-article">Article</th>
  <th class="col-part">Part no</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty">Qty</th>
  <th class="col-qty">Shipped</th>
  <th class="col-qty">Pending</th>
  <th class="col-remarks">Remarks</th>
  <th class="col-availability">Availability</th>`;

/** PO line table header (column order unchanged) */
export const PO_LINE_TABLE_HEAD = (thBorder, thBg, thColor) => `
  <th class="col-sno" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">S/N</th>
  <th class="col-desc" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Description</th>
  <th class="col-part" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Supplier Part Number</th>
  <th class="col-uom" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">UOM</th>
  <th class="col-qty" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">QTY</th>
  <th class="col-price" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Unit rate</th>
  <th class="col-total" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Total</th>
  <th class="col-lead" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Lead time</th>
  <th class="col-remarks" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Remarks</th>`;

export function exportColumnClass(key = "", header = "") {
  const k = String(key || "").toLowerCase();
  const h = String(header || "").toLowerCase();
  if (/^(sno|s\.?no|serial|pos\.?|#)$/.test(k) || /^s\.?\s*no/.test(h)) return "col-sno";
  if (/part|article|spn|supplier/.test(k) || /part|article|supplier/.test(h)) return "col-part";
  if (/desc/.test(k)) return "col-desc";
  if (k === "uom" || h === "uom") return "col-uom";
  if (/qty|quantity|ordered|received|pending|shipped|balance|allocated/.test(k)) return "col-qty";
  if (/price|rate|unitprice|debit|credit|amount/.test(k) && !/total/.test(k)) return "col-price";
  if (/total|grand|balance/.test(k) || /total price/.test(h)) return "col-total";
  if (/remark|note/.test(k)) return "col-remarks";
  if (/avail/.test(k) || /avail/.test(h)) return "col-availability";
  return "col-flex";
}

function escExportHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildExportTableHeadHtml(columns) {
  return columns
    .map((c) => `<th class="${exportColumnClass(c.key, c.header)}">${escExportHtml(c.header || c.key)}</th>`)
    .join("");
}

export function buildExportTableRowHtml(columns, row) {
  return columns
    .map((c) => `<td class="${exportColumnClass(c.key, c.header)}">${escExportHtml(row[c.key])}</td>`)
    .join("");
}

export function buildExportTableColgroup(columns) {
  return buildColgroupHtml(columns.map((c) => exportColumnClass(c.key, c.header)));
}
