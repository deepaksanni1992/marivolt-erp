import assert from "node:assert/strict";
import {
  mergePackingHeaderFromInvoice,
  packingHeaderSetFromInvoice,
} from "../src/utils/packingInvoiceHeaderSync.js";

const packing = {
  packingNo: "MAR-PK-0001",
  customerName: "Pernix (Fiji) Pte Limited",
  consignee: "",
  loadingPort: "",
  engine: "MAK",
};

const invoice = {
  consignee: "Pernix (Fiji) Pte Limited\nSuva, Fiji",
  loadingPort: "Sharjah",
  dischargePort: "Suva",
  customerName: "Pernix (Fiji) Pte Limited",
  engine: "MAK",
};

const merged = mergePackingHeaderFromInvoice(packing, invoice);
assert.equal(merged.packingNo, "MAR-PK-0001");
assert.match(merged.consignee, /Suva, Fiji/);
assert.equal(merged.loadingPort, "Sharjah");
assert.equal(merged.dischargePort, "Suva");

const $set = packingHeaderSetFromInvoice(invoice);
assert.equal($set.consignee, invoice.consignee);
assert.equal($set.loadingPort, "Sharjah");
assert.ok(!("packingNo" in $set));

console.log("packingInvoiceHeaderSync.test.js: ok");
