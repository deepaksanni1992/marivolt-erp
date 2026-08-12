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
  buildTestLabelTspl,
  getFixedLabelSize,
  wrapDescription,
  labelDotDimensions,
  escapeTspl,
} from "../src/services/label/tsplGenerator.js";
import { LABEL_SETTING_DEFAULTS, LABEL_SETTING_KEYS } from "../src/services/label/labelSettingsService.js";
import { newLeaseToken, LEASE_TTL_MS, timingSafeEqualString } from "../src/services/label/printQueue.js";
import {
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  MARIVOLT_STANDARD_TEMPLATE_CODE,
} from "../src/models/LabelTemplate.js";
import { LABEL_JOB_STATUSES } from "../src/models/LabelPrintJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const backendRoot = path.resolve(__dirname, "..");
const sampleDir = path.join(backendRoot, "scripts/fixtures/label-tspl-samples");

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
  assert.ok(ui.includes("idempotencyKey"));
  assert.ok(
    ui.includes(
      "GRN was posted successfully, but labels could not be queued. You can print them later from the GRN or Label Queue."
    )
  );
  assert.ok(ui.includes("PostGrnLabelDecisionDialog"));
  assert.ok(ui.includes("resolvePostGrnLabelMode"));
  const dlg = fs.readFileSync(
    path.join(repoRoot, "src/components/store/PostGrnLabelDecisionDialog.jsx"),
    "utf8"
  );
  assert.ok(dlg.includes("Print Labels"));
  assert.ok(dlg.includes("Skip"));
  assert.ok(dlg.includes("Would you like to print labels now?"));
});

run("Each physical label displays Qty: 1 UOM (unit-label semantics)", () => {
  const tspl = buildSingleLabelTspl(
    { article: "A1", qty: 50, uom: "PCS", labelQty: 50, description: "x" },
    { qtyPerLabel: 1 }
  );
  assert.ok(tspl.includes("Qty: 1 PCS"));
  assert.ok(!tspl.includes("Qty: 50 PCS"));
  const job = buildJobTspl([{ article: "A1", labelQty: 3, uom: "PCS", qty: 3 }], { copies: 1 });
  assert.strictEqual((job.match(/PRINT 1,1/g) || []).length, 3);
  assert.ok(job.includes("Qty: 1 PCS"));
});

run("Distributed GRN labels show face qty remainder (10+10+5)", () => {
  const job = buildJobTspl(
    [{ article: "W1", uom: "PCS", qty: 25, labelQty: 3, labelDistribution: [10, 10, 5] }],
    { copies: 1 }
  );
  assert.strictEqual((job.match(/PRINT 1,1/g) || []).length, 3);
  assert.strictEqual((job.match(/Qty: 10 PCS/g) || []).length, 2);
  assert.strictEqual((job.match(/Qty: 5 PCS/g) || []).length, 1);
});

run("203 and 300 DPI dot dimensions for 100×50 mm", () => {
  const d203 = labelDotDimensions(203);
  assert.ok(Math.abs(d203.widthDots - 800) <= 2, `203 width ${d203.widthDots}`);
  assert.ok(Math.abs(d203.heightDots - 400) <= 2, `203 height ${d203.heightDots}`);
  const d300 = labelDotDimensions(300);
  assert.ok(Math.abs(d300.widthDots - 1181) <= 2, `300 width ${d300.widthDots}`);
  assert.ok(Math.abs(d300.heightDots - 591) <= 2, `300 height ${d300.heightDots}`);
  const t203 = buildSingleLabelTspl({ article: "X" }, { dpi: 203 });
  const t300 = buildSingleLabelTspl({ article: "X" }, { dpi: 300 });
  assert.ok(t203.includes("SIZE 100 mm,50 mm"));
  assert.ok(t300.includes("SIZE 100 mm,50 mm"));
});

run("escapeTspl strips nullish/object junk and quotes", () => {
  assert.strictEqual(escapeTspl(null), "");
  assert.strictEqual(escapeTspl(undefined), "");
  assert.strictEqual(escapeTspl({ a: 1 }), "");
  assert.ok(!escapeTspl('AB"C').includes('"'));
});

run("timingSafeEqualString works", () => {
  assert.ok(timingSafeEqualString("abc", "abc"));
  assert.ok(!timingSafeEqualString("abc", "abd"));
  assert.ok(!timingSafeEqualString("abc", "ab"));
});

run("Idempotency + qty guard present in labelService", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("idempotencyKey"));
  assert.ok(svc.includes("LABEL_QTY_EXCEEDS_RECEIVED"));
  assert.ok(svc.includes("LABEL_CONFIRM_EXCEEDS_REMAINING"));
});

run("Agent routes rate-limited and HTTPS gated", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.ok(routes.includes("agentRateLimit") || routes.includes("createRateLimiter"));
  const auth = fs.readFileSync(path.join(backendRoot, "src/middleware/printAgentAuth.js"), "utf8");
  assert.ok(auth.includes("AGENT_HTTPS_REQUIRED") || auth.includes("HTTPS required"));
});

run("LabelPrintJob has idempotency unique index", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/LabelPrintJob.js"), "utf8");
  assert.ok(model.includes("idempotencyKey"));
  assert.ok(model.includes("partialFilterExpression"));
});

run("Generate and save sample TSPL fixtures", () => {
  fs.mkdirSync(sampleDir, { recursive: true });
  const brand = { companyName: "MARIVOLT FZE" };
  const samples = {
    "01-normal-short.txt": buildSingleLabelTspl({
      article: "MV-1001",
      description: "Short widget",
      spn: "SP1",
      materialCode: "M1",
      qty: 1,
      uom: "PCS",
      poNo: "PO-9",
      grnNo: "GRN-1",
      receivedDate: "2026-08-01",
      location: "A1",
    }, brand),
    "02-long-description.txt": buildSingleLabelTspl({
      article: "MV-LONG",
      description:
        "This is an extremely long product description that must wrap to at most two lines and truncate gracefully without overlapping the barcode or other fields on the label",
      uom: "PCS",
      grnNo: "GRN-2",
    }, brand),
    "03-numeric-article.txt": buildSingleLabelTspl({ article: "1234567890", description: "Numeric", uom: "PCS", grnNo: "G3" }, brand),
    "04-alphanumeric-article.txt": buildSingleLabelTspl({ article: "AB-99/X", description: "Alpha", uom: "PCS", grnNo: "G4" }, brand),
    "05-missing-po.txt": buildSingleLabelTspl({ article: "NO-PO", description: "No PO", uom: "PCS", grnNo: "G5", poNo: "" }, brand),
    "06-qty-gt-999.txt": buildJobTspl(
      [{ article: "BULK", description: "Bulk", uom: "PCS", qty: 1500, labelQty: 2, grnNo: "G6", poNo: "PO-B" }],
      { copies: 1, ...brand }
    ),
  };
  for (const [name, body] of Object.entries(samples)) {
    const p = path.join(sampleDir, name);
    fs.writeFileSync(p, body);
    assert.ok(fs.existsSync(p));
    assert.ok(body.includes("SIZE 100 mm,50 mm"));
    assert.ok(!body.includes("undefined"));
    assert.ok(!body.includes("null"));
    assert.ok(!body.includes("[object Object]"));
  }
});

run("No label-size selectors in UI settings/GRN", () => {
  const settings = fs.readFileSync(path.join(repoRoot, "src/components/store/LabelSettingsPanel.jsx"), "utf8");
  assert.ok(!/widthMm|heightMm|label size select/i.test(settings) || settings.includes("100"));
  assert.ok(!settings.includes("setWidth") && !settings.includes("labelWidth"));
  const store = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  assert.ok(store.includes("100×50") || store.includes("100x50") || store.includes("100×50 mm"));
});

run("RAW spooler documented and used", () => {
  const adapter = fs.readFileSync(path.join(repoRoot, "print-agent/src/adapters/windowsRawSpooler.js"), "utf8");
  assert.ok(adapter.includes('pDataType = "RAW"') || adapter.includes("RAW"));
  const readme = fs.readFileSync(path.join(repoRoot, "print-agent/README.md"), "utf8");
  assert.ok(readme.includes("RAW"));
});

run("Enterprise agent/printer models have additive profile fields", () => {
  const agent = fs.readFileSync(path.join(backendRoot, "src/models/PrintAgent.js"), "utf8");
  assert.ok(agent.includes("branchName"));
  assert.ok(agent.includes("availablePrinters"));
  assert.ok(agent.includes("windowsVersion"));
  assert.ok(agent.includes("department"));
  const printer = fs.readFileSync(path.join(backendRoot, "src/models/PrinterConfig.js"), "utf8");
  assert.ok(printer.includes("isWarehouseDefault"));
  assert.ok(printer.includes("connectionKind"));
  assert.ok(printer.includes("printerModel"));
});

run("Print routing prefers warehouse then company default", () => {
  const pm = fs.readFileSync(path.join(backendRoot, "src/services/label/printerManager.js"), "utf8");
  assert.ok(pm.includes("isWarehouseDefault"));
  assert.ok(pm.includes("warehouseCode"));
  assert.ok(pm.includes("isDefault: true"));
});

run("Agent bootstrap + dashboard APIs mounted", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.ok(routes.includes("/agent/bootstrap"));
  assert.ok(routes.includes("rotate-secret"));
  assert.ok(routes.includes("test-print"));
  assert.ok(routes.includes("test-connection"));
  assert.ok(routes.includes("/agents/:id/disable"));
});

run("Test label TSPL generator", () => {
  const tspl = buildTestLabelTspl({
    agentId: "AGT1",
    agentName: "Warehouse Agent 01",
    printerName: "Receiving Printer",
    windowsPrinterName: "Rongta RP420",
    connectionStatus: "ONLINE",
    title: "MARIVOLT TEST LABEL",
  });
  assert.ok(tspl.includes("MARIVOLT TEST LABEL"));
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(tspl.includes("Agent:"));
  assert.ok(tspl.includes("Printer:"));
});

run("Print agent auto-detect + first-launch present", () => {
  const detect = fs.readFileSync(path.join(repoRoot, "print-agent/src/detect.js"), "utf8");
  assert.ok(detect.includes("detectWindowsPrinters"));
  assert.ok(detect.includes("collectHostProfile"));
  const cfg = fs.readFileSync(path.join(repoRoot, "print-agent/src/config.js"), "utf8");
  assert.ok(cfg.includes("ensureConfigured"));
  assert.ok(cfg.includes("bootstrap"));
  const ui = fs.readFileSync(path.join(repoRoot, "src/components/store/LabelSettingsPanel.jsx"), "utf8");
  assert.ok(ui.includes("Print Agent Dashboard"));
  assert.ok(ui.includes("Printer Dashboard"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
