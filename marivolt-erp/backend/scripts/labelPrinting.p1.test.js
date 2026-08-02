/**
 * Warehouse Label Printing Phase 1 — unit / source tests (no Mongo required for core).
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encodeBarcodeValue } from "../src/services/label/barcodeGenerator.js";
import {
  buildJobTspl,
  buildSingleLabelTspl,
  getFixedLabelSize,
  wrapDescription,
} from "../src/services/label/tsplGenerator.js";
import { LABEL_SETTING_DEFAULTS, LABEL_SETTING_KEYS } from "../src/services/label/labelSettingsService.js";
import { newLeaseToken, LEASE_TTL_MS } from "../src/services/label/printQueue.js";
import {
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
} from "../src/models/LabelTemplate.js";
import { LABEL_JOB_STATUSES } from "../src/models/LabelPrintJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const backendRoot = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("Label Printing P1");

run("Fixed label size is 100×50 mm", () => {
  assert.strictEqual(LABEL_WIDTH_MM, 100);
  assert.strictEqual(LABEL_HEIGHT_MM, 50);
  assert.deepStrictEqual(getFixedLabelSize(), { widthMm: 100, heightMm: 50 });
});

run("Barcode Phase 1 encodes article", () => {
  const enc = encodeBarcodeValue({ mode: "ARTICLE", article: "abc-1" });
  assert.strictEqual(enc.value, "ABC-1");
  assert.strictEqual(enc.humanReadable, "ABC-1");
  assert.strictEqual(enc.mode, "ARTICLE");
});

run("Barcode LABEL_ID mode reserved", () => {
  const enc = encodeBarcodeValue({ mode: "LABEL_ID", labelId: "LBL999" });
  assert.strictEqual(enc.value, "LBL999");
  assert.strictEqual(enc.mode, "LABEL_ID");
});

run("Description wraps to max 2 lines", () => {
  const lines = wrapDescription(
    "This is a very long description that should wrap across multiple words without breaking the label layout completely forever and ever",
    40,
    2
  );
  assert.ok(lines.length <= 2);
  assert.ok(lines.length >= 1);
});

run("TSPL contains SIZE 100 mm,50 mm and Code128 BARCODE", () => {
  const tspl = buildSingleLabelTspl({
    article: "ART1",
    description: "Widget housing assembly",
    spn: "SPN",
    materialCode: "MC",
    qty: 5,
    uom: "PCS",
    poNo: "PO1",
    grnNo: "GRN1",
    receivedDate: "2026-01-01",
    location: "BIN-A",
  });
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(tspl.includes('BARCODE'));
  assert.ok(tspl.includes('"128"'));
  assert.ok(tspl.includes("ART1"));
  assert.ok(tspl.includes("PRINT 1,1"));
});

run("Job TSPL multiplies by labelQty × copies", () => {
  const job = buildJobTspl(
    [{ article: "A", labelQty: 2, description: "d", qty: 2, uom: "PCS" }],
    { copies: 3 }
  );
  const prints = (job.match(/PRINT 1,1/g) || []).length;
  assert.strictEqual(prints, 6);
});

run("Lease token and TTL helpers", () => {
  const a = newLeaseToken();
  const b = newLeaseToken();
  assert.ok(a && b && a !== b);
  assert.strictEqual(LEASE_TTL_MS, 60_000);
});

run("Job statuses include leasing set", () => {
  for (const s of ["PENDING", "LEASED", "PRINTING", "COMPLETED", "PARTIAL", "FAILED", "UNCERTAIN", "CANCELLED"]) {
    assert.ok(LABEL_JOB_STATUSES.includes(s), s);
  }
});

run("Settings defaults: labels disabled by default", () => {
  assert.strictEqual(LABEL_SETTING_DEFAULTS[LABEL_SETTING_KEYS.ENABLED], false);
  assert.strictEqual(LABEL_SETTING_DEFAULTS[LABEL_SETTING_KEYS.MAX_PER_JOB], 200);
});

run("Standard template code constant", () => {
  assert.strictEqual(MARIVOLT_STANDARD_TEMPLATE_CODE, "MARIVOLT_STANDARD");
});

run("postGrnFromPo does not import label services (stock isolation)", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/controllers/grnController.js"), "utf8");
  assert.ok(!src.includes("services/label"));
  assert.ok(!src.includes("createJobsFromGrn"));
  assert.ok(!src.includes("LabelPrintJob"));
});

run("Label routes mounted and agent auth separate from JWT", () => {
  const server = fs.readFileSync(path.join(backendRoot, "src/server.js"), "utf8");
  assert.ok(server.includes('"/api/labels"'));
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.ok(routes.includes("requirePrintAgent"));
  assert.ok(routes.includes("/agent/lease"));
  assert.ok(routes.includes("/jobs/from-grn"));
  const agentAuth = fs.readFileSync(path.join(backendRoot, "src/middleware/printAgentAuth.js"), "utf8");
  assert.ok(agentAuth.includes("X-Print-Agent-Id") || agentAuth.includes("x-print-agent-id"));
  assert.ok(!agentAuth.includes("JWT_SECRET"));
});

run("LABELS permission module present; STORE gets print/reprint", () => {
  const role = fs.readFileSync(path.join(backendRoot, "src/models/Role.js"), "utf8");
  assert.ok(role.includes('"LABELS"'));
  assert.ok(role.includes('"print"'));
  assert.ok(role.includes('"reprint"'));
  const rs = fs.readFileSync(path.join(backendRoot, "src/services/roleService.js"), "utf8");
  assert.ok(rs.includes('LABELS: ["view", "print", "reprint"]'));
});

run("GRN model has additive labelStatus only", () => {
  const grn = fs.readFileSync(path.join(backendRoot, "src/models/GRN.js"), "utf8");
  assert.ok(grn.includes("labelStatus"));
  assert.ok(grn.includes("labelLastJobId"));
  assert.ok(grn.includes("NOT_REQUESTED"));
});

run("Print agent package exists with Windows spooler adapter", () => {
  const agentPkg = path.join(repoRoot, "print-agent/package.json");
  assert.ok(fs.existsSync(agentPkg));
  const adapter = fs.readFileSync(path.join(repoRoot, "print-agent/src/adapters/windowsRawSpooler.js"), "utf8");
  assert.ok(adapter.includes("WritePrinter") || adapter.includes("WindowsRawSpoolerAdapter"));
  assert.ok(adapter.includes("Tcp9100Adapter"));
  const index = fs.readFileSync(path.join(repoRoot, "print-agent/src/index.js"), "utf8");
  assert.ok(index.includes("/api/labels/agent/lease"));
  assert.ok(index.includes("X-Print-Agent-Id") || index.includes("x-print-agent-id") || index.includes("Print-Agent"));
});

run("UNCERTAIN never auto-reprinted in retryJob source", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("LABEL_UNCERTAIN_CONFIRM_REQUIRED"));
  assert.ok(svc.includes("resolveUncertain"));
});

run("RTS remains absent", () => {
  assert.ok(!fs.existsSync(path.join(backendRoot, "src/models/Rts.js")));
});

run("Frontend Post GRN & Print uses separate from-grn call", () => {
  const ui = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  assert.ok(ui.includes("Post GRN & Print Labels"));
  assert.ok(ui.includes("/labels/jobs/from-grn"));
  assert.ok(ui.includes("Label Queue"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
