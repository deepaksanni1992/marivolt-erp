import assert from "node:assert/strict";
import {
  PACKING_LIST_PRINT_COLUMNS,
  buildStorePackingListPrintRows,
  formatPackingBoxDetails,
} from "../src/lib/packingListTable.js";

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

console.log("packingListPrint.test.mjs: ok");
