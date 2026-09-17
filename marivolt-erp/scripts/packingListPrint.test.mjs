import assert from "node:assert/strict";
import {
  PACKING_LIST_PRINT_COLUMNS,
  buildStorePackingListPrintRows,
  formatPackingBoxDetails,
} from "../src/lib/packingListTable.js";
import { SALES_INVOICE_LINE_TABLE_HEAD } from "../src/lib/reportTableLayout.js";
import { buildTaxInvoiceHeaderHtml } from "../src/lib/salesInvoicePrint.js";

function packageTypeLabel(v) {
  return String(v || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function fmtWeight(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return "";
  return x.toFixed(2);
}

const packages = [
  {
    packageNo: "2",
    packageType: "CARTON",
    dimensions: "80x60x77 CMS",
    grossWeightKg: 146,
    netWeightKg: 146,
    items: [
      { spn: "9.2107-005", description: "Inlet Valve Guide", uom: "PCS", qty: 32 },
      { spn: "1.2240-014", description: "Compression Ring", uom: "PCS", qty: 48 },
    ],
  },
  {
    packageNo: "1",
    packageType: "CARTON",
    dimensions: "82x64x66 CMS",
    grossWeightKg: 74,
    netWeightKg: 74,
    items: [{ spn: "9.2107-010", description: "Spring Plate Valve", uom: "PCS", qty: 8 }],
  },
];

const headers = PACKING_LIST_PRINT_COLUMNS.map((c) => c.header);
assert.deepEqual(headers, ["S No.", "Part #", "Description", "UOM", "Qty", "Box Details"]);

const rows = buildStorePackingListPrintRows(packages, { packageTypeLabel, fmtWeight });
assert.equal(rows.length, 3);
assert.equal(rows[0].cells[0], "1");
assert.equal(rows[0].cells[1], "9.2107-005");
assert.equal(rows[0].cells[2], "Inlet Valve Guide");
assert.equal(rows[0].cells[3], "PCS");
assert.equal(rows[0].cells[4], "32");
assert.equal(rows[0].cellAttrs[5].rowspan, 2);
assert.equal(rows[1].skipCells[5], true);
assert.match(rows[0].cells[5], /2 · CARTON/);
assert.match(rows[0].cells[5], /Gross 146.00 Kg/);
assert.equal(rows[2].cells[1], "9.2107-010");
assert.equal(rows[2].cellAttrs[5].rowspan, 1);

const box = formatPackingBoxDetails(packages[0], { packageTypeLabel, fmtWeight });
assert.match(box, /80x60x77 CMS/);
assert.match(box, /Net 146.00 Kg/);

assert.doesNotMatch(SALES_INVOICE_LINE_TABLE_HEAD, /Unit Wt/);
assert.doesNotMatch(SALES_INVOICE_LINE_TABLE_HEAD, /Total Wt/);
assert.match(SALES_INVOICE_LINE_TABLE_HEAD, /Unit price/);
assert.match(SALES_INVOICE_LINE_TABLE_HEAD, /Total price/);

const packingHeader = buildTaxInvoiceHeaderHtml({
  doc: {
    customerName: "Pernix (Fiji) Pte Limited",
    customerReference: "PO- 26-01-20304",
    contactPerson: "Wallace Smith",
    attention: "Mr. Rao",
    paymentTerms: "Net 60 days",
    billingAddress: "Suva",
    shippingAddress: "Suva",
    currency: "EUR",
    engine: "MAK",
    model: "M32C",
    esn: "34057",
    allocationNo: "ALLOC/260908.02",
    linkedOANo: "MAR-OA-0008",
  },
  company: { name: "Marivolt FZE" },
  invoiceNo: "MAR-PK-0001",
  invoiceDateStr: "9/17/2026",
  isMarivolt: true,
  detailsTitle: "Packing details",
  numberLabel: "Packing Nr",
  extraDetailRows: [{ label: "Allocation", value: "ALLOC/260908.02" }],
});
assert.match(packingHeader, /Shipper/);
assert.match(packingHeader, /Consignee/);
assert.match(packingHeader, /Packing details/);
assert.match(packingHeader, /Packing Nr/);
assert.match(packingHeader, /MAR-PK-0001/);
assert.match(packingHeader, /Customer/);
assert.match(packingHeader, /Machine Details/);
assert.doesNotMatch(packingHeader, /Customer & Address Info/);

console.log("packingListPrint.test.mjs: ok");
