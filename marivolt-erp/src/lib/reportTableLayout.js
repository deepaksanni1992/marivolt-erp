/**
 * Global printable report table layout (Okeanos & Marivolt).
 * Fixed column widths, header wrapping, and cell alignment for print + Puppeteer PDF.
 */

export const GLOBAL_REPORT_TABLE_CSS = `
  .report-table,
  table.report-lines-table,
  table.po-lines-table,
  table.data-table {
    table-layout: fixed;
    width: 100%;
    border-collapse: collapse;
  }

  .report-table th,
  .report-table td,
  table.report-lines-table th,
  table.report-lines-table td,
  table.po-lines-table th,
  table.po-lines-table td,
  table.data-table th,
  table.data-table td {
    box-sizing: border-box;
    vertical-align: top;
    padding: 6px 5px;
    font-size: 11px;
    line-height: 1.3;
  }

  .report-table th,
  table.report-lines-table th,
  table.po-lines-table th,
  table.data-table th {
    word-break: normal;
    overflow-wrap: normal;
    white-space: normal;
    hyphens: manual;
    font-weight: 700;
    text-align: left;
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

  /* Column widths */
  .col-sno { width: 50px; min-width: 50px; max-width: 55px; text-align: center; }
  .col-part,
  .col-article { width: 155px; min-width: 130px; }
  .col-desc { width: 32%; }
  .col-uom { width: 52px; min-width: 45px; max-width: 55px; }
  .col-qty { width: 52px; min-width: 45px; max-width: 55px; }
  .col-price { width: 76px; min-width: 65px; max-width: 80px; }
  .col-total { width: 86px; min-width: 75px; max-width: 90px; }
  .col-remarks { width: 165px; min-width: 140px; max-width: 180px; }
  .col-avail { width: 92px; min-width: 80px; max-width: 100px; }
  .col-lead { width: 72px; min-width: 65px; }
  .col-weight { width: 68px; min-width: 60px; }
  .col-pack { width: 78px; min-width: 70px; }
  .col-pack-type { width: 58px; min-width: 50px; }
  .col-dim { width: 95px; min-width: 85px; }
  .col-flex { width: auto; }

  /* Short numeric / code headers — centered */
  .report-table th.col-sno,
  .report-table th.col-uom,
  .report-table th.col-qty,
  .report-table th.col-price,
  .report-table th.col-total,
  .report-table th.col-avail,
  .report-table th.col-weight,
  .report-table th.col-pack,
  .report-table th.col-pack-type,
  .report-table th.col-dim,
  .report-table th.col-lead,
  table.report-lines-table th.col-center,
  table.report-lines-table th.col-right,
  table.report-lines-table th.col-sno {
    text-align: center;
  }

  /* Numeric body cells — right aligned, avoid wrap */
  .report-table td.col-qty,
  .report-table td.col-price,
  .report-table td.col-total,
  .report-table td.col-weight,
  .report-table td.right,
  td.col-right,
  table.report-lines-table td.col-right,
  table.report-lines-table td.col-center {
    text-align: right;
    white-space: nowrap;
  }

  table.report-lines-table th.col-right {
    text-align: center;
  }

  table.report-lines-table td.col-center,
  .report-table td.col-sno,
  .report-table td.col-uom {
    text-align: center;
    white-space: nowrap;
  }

  /* Description — widest, normal wrap */
  .report-table td.col-desc,
  td.col-desc {
    word-break: normal;
    overflow-wrap: break-word;
    hyphens: auto;
  }

  /* Part / article / supplier P/N — wrap at spaces, slashes, hyphens */
  .report-table td.col-part,
  .report-table td.col-article,
  td.col-part,
  td.col-article {
    word-break: normal;
    overflow-wrap: break-word;
    hyphens: none;
    font-family: ui-monospace, "Consolas", monospace;
    font-size: 10.5px;
  }

  .report-table td.col-remarks,
  td.remarks-col,
  td.col-remarks {
    word-break: normal;
    overflow-wrap: break-word;
  }

  .report-table td.col-avail,
  td.col-avail {
    word-break: normal;
    overflow-wrap: break-word;
    font-size: 10.5px;
  }

  /* Legacy .right on th — center header, right-align values via td.right */
  .report-table th.right {
    text-align: center;
  }

  /* Tax invoice — extra weight columns */
  .report-table.cols-invoice .col-desc { width: 24%; }
  .report-table.cols-invoice .col-part { width: 128px; min-width: 110px; }
  .report-table.cols-invoice .col-weight { width: 62px; min-width: 56px; }
`;

/** Quotation / OA / Proforma / standard sales line table header */
export const SALES_COMMERCIAL_LINE_TABLE_HEAD = `
  <th class="col-sno">Serial number</th>
  <th class="col-part">Part number</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty right">QTY</th>
  <th class="col-price right">Price</th>
  <th class="col-total right">Total price</th>
  <th class="col-remarks">Remarks</th>
  <th class="col-avail">Availability</th>`;

/** Tax / sales invoice line table (extra weight columns) */
export const SALES_INVOICE_LINE_TABLE_HEAD = `
  <th class="col-sno">Pos.</th>
  <th class="col-part">Part Number</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty right">QTY</th>
  <th class="col-price right">Unit price</th>
  <th class="col-total right">Total price</th>
  <th class="col-weight right">Unit Wt</th>
  <th class="col-weight right">Total Wt</th>`;

/** Order allocation line table */
export const ORDER_ALLOCATION_LINE_TABLE_HEAD = `
  <th class="col-sno">S/N</th>
  <th class="col-article">Article</th>
  <th class="col-part">Part no</th>
  <th class="col-desc">Description</th>
  <th class="col-uom">UOM</th>
  <th class="col-qty right">Qty</th>
  <th class="col-qty right">Shipped</th>
  <th class="col-qty right">Pending</th>
  <th class="col-remarks">Remarks</th>
  <th class="col-avail">Availability</th>`;

/** PO line table header (column order unchanged) */
export const PO_LINE_TABLE_HEAD = (thBorder, thBg, thColor) => `
  <th class="col-sno" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">S/N</th>
  <th class="col-desc" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Description</th>
  <th class="col-part" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Supplier Part Number</th>
  <th class="col-uom" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">UOM</th>
  <th class="col-qty right" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">QTY</th>
  <th class="col-price right" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Unit rate</th>
  <th class="col-total right" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Total</th>
  <th class="col-lead" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Lead time</th>
  <th class="col-remarks" style="border:1px solid ${thBorder};padding:8px;font-size:11px;text-transform:uppercase;background:${thBg};color:${thColor}">Remarks</th>`;

/** Map export column keys to layout classes for stock / GRN / ledger PDFs */
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
  if (/avail|location|warehouse|wh/.test(k)) return k.includes("avail") ? "col-avail" : "col-flex";
  if (/date|status|currency|customer|supplier|document|movement|mode|reference/.test(k)) return "col-flex";
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
    .map((c) => {
      const cls = exportColumnClass(c.key, c.header);
      const align = ["col-qty", "col-price", "col-total"].includes(cls) ? " right" : "";
      return `<th class="${cls}${align}">${escExportHtml(c.header || c.key)}</th>`;
    })
    .join("");
}

export function buildExportTableRowHtml(columns, row) {
  return columns
    .map((c) => {
      const cls = exportColumnClass(c.key, c.header);
      const align = ["col-qty", "col-price", "col-total"].includes(cls) ? " right" : "";
      return `<td class="${cls}${align}">${escExportHtml(row[c.key])}</td>`;
    })
    .join("");
}
