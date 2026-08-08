import {
  buildCommercialReportDocumentHtml,
  buildReportHeaderHtml,
  escHtml,
  fmtReportDate,
} from "./commercialReportLayout.js";
import { deliverReportHtml } from "./reportPdfClient.js";
import { PDF_OPTS_ITEM_LINES } from "./reportTableLayout.js";

const PUTAWAY_DISCLAIMER =
  "Last Known Putaway is a historical warehouse reference. Current rack/bin quantities are not tracked in the present inventory model.";

const EXTRA_CSS = `
  @page { size: A4 landscape; margin: 10mm; }
  .picking-disclaimer {
    margin: 8px 0 12px;
    padding: 8px 10px;
    border: 1px solid #cbd5e1;
    background: #f8fafc;
    font-size: 11px;
    color: #334155;
  }
  .picking-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    table-layout: fixed;
  }
  .picking-table thead { display: table-header-group; }
  .picking-table th,
  .picking-table td {
    border: 1px solid #cbd5e1;
    padding: 5px 6px;
    vertical-align: top;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  .picking-table th {
    background: #f1f5f9;
    text-align: left;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .picking-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .picking-table .check { text-align: center; width: 42px; }
  .picking-meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 20px;
    margin: 10px 0 8px;
    font-size: 11px;
  }
  .picking-meta div b {
    display: inline-block;
    min-width: 168px;
    color: #475569;
    font-weight: 600;
  }
`;

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function dash(v) {
  const s = String(v ?? "").trim();
  return s || "—";
}

function putawayText(ln) {
  const v = ln?.lastKnownPutaway?.value;
  if (!v) return "—";
  const lk = ln.lastKnownPutaway;
  if (lk?.sourceType === "ARTICLE_CONVERSION") {
    const via = [lk.sourceDocument, lk.sourceArticle].filter(Boolean).join(" / ");
    return via ? `${v} (via ${via})` : v;
  }
  return String(v);
}

function remarkText(ln) {
  return String(ln?.pdfRemarks || ln?.storeRemarks || ln?.storeStatus || "—");
}

/**
 * Resolve display refs: prefer API documentReferences, fall back to allocation fields.
 */
function resolveRefs(payload) {
  const allocation = payload?.allocation || {};
  const refs = payload?.documentReferences || {};
  return {
    allocationNo: dash(refs.allocationNo || allocation.allocationNo),
    customerName: dash(refs.customerName || allocation.customerName),
    customerReference: dash(refs.customerReference),
    quotationNo: dash(refs.quotationNo || allocation.linkedQuotationNo),
    orderAcknowledgementNo: dash(refs.orderAcknowledgementNo || allocation.linkedOANo),
    proformaNo: dash(refs.proformaNo || allocation.linkedProformaNo),
    warehouse: dash(refs.warehouse || allocation.warehouse || "MAIN"),
    allocationDate: refs.allocationDate || allocation.allocationDate,
  };
}

/**
 * Warehouse Allocation Picking Sheet — no commercial pricing.
 * @param {object} payload { allocation, documentReferences?, lines, putawayDisclaimer? }
 * @param {object} company
 * @param {{ exportPdf?: boolean, printedBy?: string }} opts
 */
export function renderAllocationPickingSheetPrintWindow(
  payload,
  company = {},
  { exportPdf = false, printedBy = "" } = {}
) {
  const allocation = payload?.allocation;
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (!allocation) return;

  const refs = resolveRefs(payload);
  const brandingName = company.name || company.companyName || "MARIVOLT FZE";
  const printedAt = new Date();
  const header = buildReportHeaderHtml({
    documentTitle: "ALLOCATION PICKING SHEET",
    metaLines: [
      { label: "Allocation No.", value: refs.allocationNo },
      { label: "Warehouse", value: refs.warehouse },
      { label: "Printed", value: printedAt.toLocaleString() },
    ],
    company,
    brandingName,
  });

  const meta = `
    <div class="picking-meta">
      <div><b>Allocation No.</b> ${escHtml(refs.allocationNo)}</div>
      <div><b>Customer</b> ${escHtml(refs.customerName)}</div>
      <div><b>Customer Ref. / PO No.</b> ${escHtml(refs.customerReference)}</div>
      <div><b>Quotation No.</b> ${escHtml(refs.quotationNo)}</div>
      <div><b>Order Acknowledgement No.</b> ${escHtml(refs.orderAcknowledgementNo)}</div>
      <div><b>Proforma Invoice No.</b> ${escHtml(refs.proformaNo)}</div>
      <div><b>Warehouse</b> ${escHtml(refs.warehouse)}</div>
      <div><b>Allocation Date</b> ${escHtml(fmtReportDate(refs.allocationDate))}</div>
      <div><b>Printed Date / Time</b> ${escHtml(printedAt.toLocaleString())}</div>
      <div><b>Printed By</b> ${escHtml(printedBy || "—")}</div>
    </div>
  `;

  const disclaimer = `
    <div class="picking-disclaimer">${escHtml(payload?.putawayDisclaimer || PUTAWAY_DISCLAIMER)}</div>
  `;

  const rowsHtml = lines.length
    ? lines
        .map((ln, idx) => {
          return `<tr>
            <td class="num">${idx + 1}</td>
            <td>${escHtml(ln.article || "")}</td>
            <td>${escHtml(ln.description || "—")}</td>
            <td>${escHtml(ln.partNumber || "—")}</td>
            <td class="num">${n(ln.allocatedQty ?? ln.qty)}</td>
            <td class="num">${n(ln.previouslyPackedQty ?? ln.alreadyPacked)}</td>
            <td class="num">${n(ln.pickQty ?? ln.physicalPackableQty)}</td>
            <td class="num">${n(ln.onHandQty)}</td>
            <td class="num">${n(ln.reservedForThisAllocationQty)}</td>
            <td class="num">${n(ln.shortageQty)}</td>
            <td>${escHtml(putawayText(ln))}</td>
            <td>${escHtml(remarkText(ln))}</td>
            <td class="check">☐</td>
            <td class="check">☐</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="14" style="text-align:center;padding:16px;">No allocation lines</td></tr>`;

  const table = `
    <table class="picking-table report-table">
      <thead>
        <tr>
          <th style="width:28px">S/N</th>
          <th style="width:90px">Article</th>
          <th>Description</th>
          <th style="width:80px">Part No</th>
          <th style="width:52px">Allocated</th>
          <th style="width:52px">Prev Packed</th>
          <th style="width:48px">Pick Qty</th>
          <th style="width:52px">Physical</th>
          <th style="width:52px">Reserved Here</th>
          <th style="width:48px">Shortage</th>
          <th style="width:110px">Last Known Putaway</th>
          <th>Remarks</th>
          <th class="check">Picked</th>
          <th class="check">Checked</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  const title = `Allocation Picking Sheet ${refs.allocationNo !== "—" ? refs.allocationNo : ""}`.trim();
  const html = buildCommercialReportDocumentHtml({
    title,
    bodyInnerHtml: header + meta + disclaimer + table,
    brandingName,
    extraCss: EXTRA_CSS,
  });

  return deliverReportHtml(html, {
    exportPdf,
    filename: `allocation-picking-sheet-${refs.allocationNo !== "—" ? refs.allocationNo : "export"}`,
    pdfOptions: {
      ...PDF_OPTS_ITEM_LINES,
      landscape: true,
    },
  });
}

export { PUTAWAY_DISCLAIMER };
