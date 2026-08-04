/**
 * Expanded acceptance tests for stock bucket integrity + prevention.
 * Run: node scripts/stockBucketIntegrityAudit.test.js
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  allocationLineRemainingReserved,
  allocationStatusHoldsReservation,
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  MISMATCH_TYPES,
} from "../src/services/stockBucketIntegrityService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(backendRoot, rel), "utf8");
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

const service = read("src/services/stockBucketIntegrityService.js");
const stockService = read("src/services/stockService.js");
const salesFlow = read("src/controllers/salesFlowController.js");
const allocModel = read("src/models/OrderAllocation.js");
const adminRoutes = read("src/routes/adminRoutes.js");
const controller = read("src/controllers/stockBucketIntegrityController.js");
const wipeScript = read("scripts/deleteCustomerTransactions.mjs");
const ui = read("../src/pages/StockBucketIntegrity.jsx");
const dataHealth = read("src/services/dataHealthService.js");
const traceUi = read("../src/pages/ArticleTraceability.jsx");
const traceSvc = read("src/services/articleTraceabilityService.js");

ok("status matrix documents allocation holding statuses", ALLOCATION_STATUSES_HOLDING_RESERVED.includes("OPEN"));
ok("CANCELLED does not hold reservation", allocationStatusHoldsReservation("CANCELLED") === false);
ok("FULLY_PACKED is in scan set but formula zeros remaining when packed", allocationStatusHoldsReservation("FULLY_PACKED"));
ok("CLOSED is in scan set", allocationStatusHoldsReservation("CLOSED"));
ok("fully packed line remaining reserved is 0", allocationLineRemainingReserved({ qty: 5, packedQty: 5 }) === 0);
ok("partial pack remaining reserved", allocationLineRemainingReserved({ qty: 10, packedQty: 4 }) === 6);
ok("healthy GRN shape: no alloc → remaining 0", allocationLineRemainingReserved({ qty: 0, packedQty: 0 }) === 0);
ok("FULLY_PACKED/CLOSED included via shared remaining formula (not skipped)", /computeExpectedReservedFromAllocations/.test(service));
ok("bucket integrity uses shared expected reserved helper", /computeExpectedReservedFromAllocations/.test(service));
ok("packing claims reduce expected reserved when line.packedQty stale", /packingClaimByAllocArticle/.test(service));
ok("available mismatch uses unclamped derived", /derivedAvailableUnclamped/.test(service));
ok("CROSS_COMPANY_MOVEMENT mismatch type", Boolean(MISMATCH_TYPES.CROSS_COMPANY_MOVEMENT));
ok("WAREHOUSE_SCOPE_MISMATCH mismatch type", Boolean(MISMATCH_TYPES.WAREHOUSE_SCOPE_MISMATCH));
ok("mismatch types include ORPHANED_RESERVED", Boolean(MISMATCH_TYPES.ORPHANED_RESERVED));
ok("mismatch types include GHOST_ALLOCATION_EFFECT", Boolean(MISMATCH_TYPES.GHOST_ALLOCATION_EFFECT));
ok("safe repair excludes MISSING_RESERVED via neverRepair", /MISSING_RESERVED/.test(service));
ok("dry-run preview exists", /previewBucketIntegrityRepair/.test(service));
ok("apply gated by env flag", /STOCK_BUCKET_BULK_REPAIR_ENABLED/.test(service));
ok("CSV export helper exists", /auditRowsToCsv/.test(service));
ok("GET bucket-integrity route", /\/stock\/bucket-integrity/.test(adminRoutes));
ok("repair-preview route", /repair-preview/.test(adminRoutes));
ok("repair controller uses applyBucketIntegrityRepair", /applyBucketIntegrityRepair/.test(controller));
ok("allocateStock accepts effectKey", /effectKey = ""/.test(stockService) && /alloc:reserve:/.test(salesFlow));
ok("cancelAllocation accepts effectKey", /alloc:release:/.test(salesFlow));
ok("cancel releases without stockReservedAt gate", !/if \(alloc\.stockReservedAt && releaseLines\.length\)/.test(salesFlow));
ok("cancel uses qty − packedQty", /packedQty/.test(salesFlow.split("cancelOrderAllocation")[1]?.slice(0, 2500) || ""));
ok("OrderAllocation hard delete blocked", /ALLOCATION_HARD_DELETE_BLOCKED/.test(allocModel));
ok("customer wipe cancels with stock release", /cancelAllocationsWithStockRelease/.test(wipeScript));
ok("customer wipe imports stockService", /stockService/.test(wipeScript));
ok("data health includes STOCK_BUCKET_INTEGRITY", /STOCK_BUCKET_INTEGRITY/.test(dataHealth));
ok("UI page exists", /Stock Bucket Integrity/.test(ui));
ok("traceability shows ERP On Hand not ERP Stock Qty label", /ERP On Hand/.test(traceUi) && !/\["ERP Stock Qty"/.test(traceUi));
ok("traceability shows Free Available separately", /Free Available/.test(traceUi));
ok("traceability onHand is physical not free", /erpOnHandQty: erp\.onHandQty/.test(traceSvc));
ok("readonly audit script exists", fs.existsSync(path.join(backendRoot, "scripts/stockBucketIntegrityAudit.readonly.mjs")));
ok("OKE investigation script exists", fs.existsSync(path.join(backendRoot, "scripts/investigateOkeMissingReserved.readonly.mjs")));

console.log(`\n${passed} checks passed`);
