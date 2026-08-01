/**
 * Confirms the RTS (Ready-To-Ship) module has been fully removed from the
 * backend: no model/util files, no routes, no stockService movers, and no
 * controller exports referencing RTS documents. These are pure/static
 * checks (file system + module exports) that do not require a database.
 * Run: node backend/scripts/rtsRemoval.salesFlow.test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as stockService from "../src/services/stockService.js";
import * as salesFlow from "../src/controllers/salesFlowController.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${message}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${message}`);
  }
}

function readFile(relPath) {
  return fs.readFileSync(path.join(backendRoot, relPath), "utf8");
}

console.log("\nRTS Removal\n");

assert(!fs.existsSync(path.join(backendRoot, "src/models/Rts.js")), "Rts model file has been deleted");
assert(!fs.existsSync(path.join(backendRoot, "src/utils/rtsProtection.js")), "rtsProtection util file has been deleted");
assert(!fs.existsSync(path.join(backendRoot, "scripts/rtsP01Protection.test.js")), "rtsP01Protection test file has been deleted");

const salesRoutesSrc = readFile("src/routes/salesRoutes.js");
assert(!/\/rts\b/i.test(salesRoutesSrc), "salesRoutes has no /rts route paths");
assert(!salesRoutesSrc.includes("convert-to-rts"), "salesRoutes has no convert-to-rts alias route");
assert(!salesRoutesSrc.includes("createRtsFromOrderAllocation"), "salesRoutes does not reference createRtsFromOrderAllocation");
assert(!salesRoutesSrc.includes("Rts.js") && !/from ["']\.\.\/models\/Rts\.js["']/.test(salesRoutesSrc), "salesRoutes does not import the Rts model");

const stockServiceSrc = readFile("src/services/stockService.js");
assert(!stockServiceSrc.includes("RTS_TRANSFER"), "stockService source has no RTS_TRANSFER references");
assert(!stockServiceSrc.includes("RTS_CANCEL"), "stockService source has no RTS_CANCEL references");
assert(!stockServiceSrc.includes("rtsQty"), "stockService source has no rtsQty bucket references");

assert(typeof stockService.moveAllocationToRTS === "undefined", "stockService does not export moveAllocationToRTS");
assert(typeof stockService.cancelRTS === "undefined", "stockService does not export cancelRTS");
assert(typeof stockService.invoiceFromRTS === "undefined", "stockService does not export invoiceFromRTS");
assert(!("RTS_TRANSFER" in (stockService.MOVEMENT_TYPES || {})), "stockService.MOVEMENT_TYPES has no RTS_TRANSFER");
assert(!("RTS_CANCEL" in (stockService.MOVEMENT_TYPES || {})), "stockService.MOVEMENT_TYPES has no RTS_CANCEL");

const rtsExportNames = [
  "reportRts",
  "listRts",
  "getRts",
  "updateRts",
  "approveRts",
  "createRtsFromOrderAllocation",
  "convertRtsToSalesInvoice",
  "cancelRtsDocument",
];
for (const name of rtsExportNames) {
  assert(typeof salesFlow[name] === "undefined", `salesFlowController does not export ${name}`);
}

const salesFlowSrc = readFile("src/controllers/salesFlowController.js");
assert(!/from ["']\.\.\/models\/Rts\.js["']/.test(salesFlowSrc), "salesFlowController does not import the Rts model");
assert(!salesFlowSrc.includes("rtsProtection.js"), "salesFlowController does not import rtsProtection helpers");
assert(!salesFlowSrc.includes("PARTIALLY_RTS"), "salesFlowController no longer writes PARTIALLY_RTS status");
assert(!salesFlowSrc.includes("RTS_COMPLETE"), "salesFlowController no longer writes RTS_COMPLETE status");

const orderAllocationModelSrc = readFile("src/models/OrderAllocation.js");
assert(!orderAllocationModelSrc.includes("PARTIALLY_RTS"), "OrderAllocation status enum has no PARTIALLY_RTS");
assert(!orderAllocationModelSrc.includes("RTS_COMPLETE"), "OrderAllocation status enum has no RTS_COMPLETE");

const stockBalanceModelSrc = readFile("src/models/StockBalance.js");
assert(!stockBalanceModelSrc.includes("rtsQty"), "StockBalance schema has no rtsQty field");

const packageJson = JSON.parse(readFile("package.json"));
assert(!packageJson.scripts.test.includes("rtsP01Protection"), "package.json test script no longer runs rtsP01Protection.test.js");
assert(!packageJson.scripts.verify.includes("rtsProtection"), "package.json verify script no longer checks rtsProtection.js");

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
