/**
 * PO duplicate line cloning (no DB).
 * Run: node scripts/poDuplicate.test.js
 */
import assert from "assert";
import { clonePoLinesForDuplicate } from "../src/controllers/purchaseController.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

const cloned = clonePoLinesForDuplicate([
  {
    _id: "507f1f77bcf86cd799439011",
    article: "A1",
    itemCode: "A1",
    qty: 10,
    orderedQty: 10,
    receivedQty: 4,
    cancelledQty: 1,
    pendingQty: 5,
    unitPrice: 12,
    sourceOrderAllocationLineId: "507f1f77bcf86cd799439099",
    sourceArticle: "A1",
    sourceRequestedQty: 10,
    sourceConvertedQty: 10,
  },
]);

ok("drops line _id", cloned[0]._id == null);
ok("resets receivedQty", cloned[0].receivedQty === 0);
ok("resets cancelledQty", cloned[0].cancelledQty === 0);
ok("pending equals ordered qty", cloned[0].pendingQty === 10 && cloned[0].orderedQty === 10);
ok("clears allocation line link", cloned[0].sourceOrderAllocationLineId == null);
ok("keeps unit price and article", cloned[0].unitPrice === 12 && cloned[0].article === "A1");
ok("empty source → empty array", clonePoLinesForDuplicate([]).length === 0);

console.log(`\n${passed} checks passed`);
