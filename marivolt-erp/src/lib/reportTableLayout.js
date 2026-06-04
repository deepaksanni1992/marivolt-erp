/**
 * Global printable report table layout (Okeanos & Marivolt).
 * Safe fixed layout with colgroup — no letter-by-letter wrapping.
 */

/** Puppeteer / export PDF options for wide line-item tables */
export const PDF_OPTS_ITEM_LINES = {
  format: "A4",
  landscape: true,
  printBackground: true,
};

export const GLOBAL_REPORT_TABLE_CSS = `
  .report-table,
  table.report-lines-table,
  table.po-lines-table,
  table.data-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    border: 1px solid #cfcfcf;
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

  col.col-sno { width: 55px; }
  col.col-part { width: 185px; }
  col.col-article { width: 120px; }
  col.col-desc { width: auto; }
  col.col-uom { width: 55px; }
  col.col-qty { width: 55px; }
  col.col-price { width: 85px; }
  col.col-total { width: 95px; }
  col.col-remarks { width: 160px; }
  col.col-availability,
  col.col-avail { width: 90px; }
  col.col-lead { width: 75px; }
  col.col-weight { width: 70px; }
  col.col-pack { width: 80px; }
  col.col-pack-type { width: 60px; }
  col.col-dim { width: 95px; }
  col.col-flex { width: 100px; }

  .report-table .col-sno,
  table.report-lines-table .col-sno,
  table.po-lines-table .col-sno {
    width: 55px;
    text-align: center;
  }

  .report-table .col-part,
  .report-table .col-article,
  table.report-lines-table .col-part {
    width: 185px;
  }

  .report-table .col-article {
    width: 120px;
  }

  .report-table .col-desc,
  table.report-lines-table .col-desc,
  table.po-lines-table .col-desc {
    width: auto;
    min-width: 260px;
  }

  .report-table .col-uom,
  table.report-lines-table .col-uom,
  table.po-lines-table .col-uom {
    width: 55px;
    text-align: center;
  }

  .report-table .col-qty,
  table.report-lines-table .col-qty,
  table.po-lines-table .col-qty {
    width: 55px;
    text-align: right;
  }

  .report-table .col-price,
  table.po-lines-table .col-price {
    width: 85px;
    text-align: right;
  }

  .report-table .col-total,
  table.po-lines-table .col-total {
    width: 95px;
    text-align: right;
  }

  .report-table .col-remarks,
  table.report-lines-table .col-remarks,
  table.po-lines-table .col-remarks {
    width: 160px;
  }

  .report-table .col-availability,
  .report-table .col-avail,
  table.report-lines-table .col-availability,
  table.report-lines-table .col-avail {
    width: 90px;
  }

  .report-table th.col-uom,
  .report-table th.col-qty,
  .report-table th.col-price,
  .report-table th.col-total,
  .report-table th.col-sno,
  .report-table th.col-weight,
  .report-table th.right {
    text-align: center;
  }

  .report-table td.col-qty,
  .report-table td.col-price,
  .report-table td.col-total,
  .report-table td.col-weight,
  .report-table td.right,
  table.report-lines-table td.col-right {
    text-align: right;
  }

  .report-table td.col-uom,
  .report-table td.col-sno,
  table.report-lines-table td.col-center {
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

  /* Complete outer table border (print + PDF) */
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

export const SALES_COMMERCIAL_COLGROUP = `
<colgroup>
  <col class="col-sno" />
  <col class="col-part" />
  <col class="col-desc" />
  <col class="col-uom" />
  <col class="col-qty" />
  <col class="col-price" />
  <col class="col-total" />
  <col class="col-remarks" />
  <col class="col-availability" />
</colgroup>`;

export const SALES_INVOICE_COLGROUP = `
<colgroup>
  <col class="col-sno" />
  <col class="col-part" />
  <col class="col-desc" />
  <col class="col-uom" />
  <col class="col-qty" />
  <col class="col-price" />
  <col class="col-total" />
  <col class="col-weight" />
  <col class="col-weight" />
</colgroup>`;

export const ORDER_ALLOCATION_COLGROUP = `
<colgroup>
  <col class="col-sno" />
  <col class="col-article" />
  <col class="col-part" />
  <col class="col-desc" />
  <col class="col-uom" />
  <col class="col-qty" />
  <col class="col-qty" />
  <col class="col-qty" />
  <col class="col-remarks" />
  <col class="col-availability" />
</colgroup>`;

export const PO_LINE_COLGROUP = `
<colgroup>
  <col class="col-sno" />
  <col class="col-desc" />
  <col class="col-part" />
  <col class="col-uom" />
  <col class="col-qty" />
  <col class="col-price" />
  <col class="col-total" />
  <col class="col-lead" />
  <col class="col-remarks" />
</colgroup>`;

export const PACKING_LIST_COLGROUP = `
<colgroup>
  <col class="col-sno" />
  <col class="col-pack" />
  <col class="col-pack-type" />
  <col class="col-dim" />
  <col class="col-weight" />
  <col class="col-weight" />
  <col class="col-part" />
  <col class="col-desc" />
  <col class="col-uom" />
  <col class="col-qty" />
</colgroup>`;

export const LOGISTICS_PACKING_COLGROUP = `
<colgroup>
  <col class="col-part" />
  <col class="col-desc" />
  <col class="col-qty" />
  <col class="col-uom" />
  <col class="col-weight" />
  <col class="col-dim" />
  <col class="col-qty" />
  <col class="col-flex" />
  <col class="col-availability" />
</colgroup>`;

/** Build colgroup from column class names (packing list, dynamic exports). */
export function buildColgroupHtml(colClasses) {
  const cols = (colClasses || [])
    .map((cls) => {
      const primary =
        String(cls || "")
          .split(/\s+/)
          .find((c) => c.startsWith("col-")) || "col-flex";
      return `<col class="${primary}" />`;
    })
    .join("");
  return `<colgroup>${cols}</colgroup>`;
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
