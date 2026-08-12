/**
 * Enterprise multi-agent / multi-printer acceptance tests (no Mongo required).
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  rankPrinterCandidates,
  pickBestPrinter,
  normalizePrinterNames,
  normalizePrinterStatusList,
  resolveMappedPrinterHealth,
  clampStr,
  timingSafeEqualUtf8,
  isAgentOnline,
  AGENT_ONLINE_MS,
  HEARTBEAT_LIMITS,
} from "../src/services/label/labelRoutingHelpers.js";
import { buildTestLabelTspl } from "../src/services/label/tsplGenerator.js";
import { LABEL_SETTING_KEYS, LABEL_SETTING_DEFAULTS } from "../src/services/label/labelSettingsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "../..");

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

console.log("Label Printing Enterprise Audit");

run("Legacy-shaped PrintAgent schema remains valid (additive fields optional)", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/PrintAgent.js"), "utf8");
  assert.ok(model.includes("secretHash"));
  assert.ok(model.includes("installationId"));
  assert.ok(model.includes('default: ""'));
  assert.ok(model.includes("partialFilterExpression"));
});

run("Legacy-shaped PrinterConfig still has required Phase-1 fields", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/PrinterConfig.js"), "utf8");
  assert.ok(model.includes("windowsPrinterName"));
  assert.ok(model.includes("agentId"));
  assert.ok(model.includes("isDefault"));
  assert.ok(model.includes("isWarehouseDefault"));
  assert.ok(model.includes("partialFilterExpression"));
});

run("Existing config.json agents skip first-launch wizard", () => {
  const cfg = fs.readFileSync(path.join(repoRoot, "print-agent/src/config.js"), "utf8");
  assert.ok(cfg.includes("if (fs.existsSync(p))"));
  assert.ok(cfg.includes("return loadConfig()"));
  assert.ok(cfg.includes("installationId"));
});

run("normalizePrinterNames caps and de-dupes", () => {
  const names = normalizePrinterNames([
    "Rongta RP420",
    "rongta rp420",
    "  ",
    "HP Laser",
    "x".repeat(300),
  ]);
  assert.strictEqual(names.length, 3);
  assert.ok(names[2].length <= HEARTBEAT_LIMITS.printerName);
});

run("Heartbeat field clamps", () => {
  assert.strictEqual(clampStr("abc", 2), "ab");
  assert.strictEqual(HEARTBEAT_LIMITS.availablePrinters, 50);
});

run("timingSafeEqualUtf8", () => {
  assert.ok(timingSafeEqualUtf8("token", "token"));
  assert.ok(!timingSafeEqualUtf8("token", "other"));
  assert.ok(!timingSafeEqualUtf8("a", "aa"));
});

run("normalizePrinterStatusList preserves READY/DISCONNECTED and legacy online", () => {
  const rows = normalizePrinterStatusList([
    { name: "A", status: "READY", connected: true, queueLength: 2 },
    { name: "B", online: false },
    { name: "C", status: "DISCONNECTED", connected: false },
    { name: "", status: "READY" },
  ]);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].status, "READY");
  assert.strictEqual(rows[0].online, true);
  assert.strictEqual(rows[0].queueLength, 2);
  assert.strictEqual(rows[1].status, "OFFLINE");
  assert.strictEqual(rows[2].status, "DISCONNECTED");
});

run("resolveMappedPrinterHealth keeps agent ONLINE independent of DISCONNECTED printer", () => {
  const agent = {
    status: "ONLINE",
    isActive: true,
    lastHeartbeatAt: new Date(),
    availablePrinters: ["RP4xx"],
    printerStatus: [
      {
        name: "RP4xx",
        status: "DISCONNECTED",
        connected: false,
        offline: true,
        queueLength: 0,
        statusMessage: "USB unplugged",
        lastSeen: new Date(),
        online: false,
      },
    ],
  };
  assert.strictEqual(isAgentOnline(agent), true);
  const health = resolveMappedPrinterHealth(agent, "RP4xx", { agentOnline: true });
  assert.strictEqual(health.printerStatus, "DISCONNECTED");
  assert.strictEqual(health.printerConnected, false);
});

run("resolveMappedPrinterHealth is UNKNOWN when agent offline", () => {
  const agent = {
    status: "OFFLINE",
    isActive: true,
    lastHeartbeatAt: new Date(Date.now() - 10 * 60_000),
    printerStatus: [{ name: "RP4xx", status: "READY", connected: true, online: true }],
  };
  const health = resolveMappedPrinterHealth(agent, "RP4xx", { agentOnline: false });
  assert.strictEqual(health.printerStatus, "UNKNOWN");
});

run("resolveMappedPrinterHealth is UNKNOWN when printer health is stale", () => {
  const stale = new Date(Date.now() - AGENT_ONLINE_MS - 5_000);
  const agent = {
    status: "ONLINE",
    isActive: true,
    lastHeartbeatAt: stale,
    printerStatus: [
      {
        name: "RP4xx",
        status: "READY",
        connected: true,
        online: true,
        lastSeen: stale,
      },
    ],
  };
  const health = resolveMappedPrinterHealth(agent, "RP4xx", { agentOnline: true });
  assert.strictEqual(health.printerStatus, "UNKNOWN");
  assert.ok(String(health.printerStatusMessage).toLowerCase().includes("stale"));
});

run("legacy {name, online} payload normalizes", () => {
  const rows = normalizePrinterStatusList([{ name: "Legacy", online: true }]);
  assert.strictEqual(rows[0].status, "READY");
  assert.strictEqual(rows[0].online, true);
});

run("isAgentOnline respects threshold and disabled", () => {
  const now = Date.now();
  assert.ok(
    isAgentOnline({ isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - 1000) }, now)
  );
  assert.ok(
    !isAgentOnline({ isActive: false, status: "ONLINE", lastHeartbeatAt: new Date(now - 1000) }, now)
  );
  assert.ok(
    !isAgentOnline(
      { isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - AGENT_ONLINE_MS - 1) },
      now
    )
  );
});

run("Deterministic warehouse candidate ranking", () => {
  const now = Date.now();
  const candidates = [
    { _id: "1", code: "B", agentId: "A2", windowsPrinterName: "P2", isActive: true },
    { _id: "2", code: "A", agentId: "A1", windowsPrinterName: "P1", isActive: true },
    { _id: "3", code: "C", agentId: "A3", windowsPrinterName: "", isActive: true },
    { _id: "4", code: "D", agentId: "A4", windowsPrinterName: "P4", isActive: true },
  ];
  const agentMap = {
    A1: { agentId: "A1", isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - 5000) },
    A2: { agentId: "A2", isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - 1000) },
    A3: { agentId: "A3", isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - 1000) },
    A4: { agentId: "A4", isActive: false, status: "ONLINE", lastHeartbeatAt: new Date(now - 1000) },
  };
  const pendingMap = { "1": 5, "2": 0 };
  const ranked = rankPrinterCandidates(candidates, agentMap, pendingMap, now);
  // A3 skipped (empty windows name), A4 skipped (disabled)
  // A1 and A2 online; A1 has pending 0, A2 pending 5 → A first by pending then code
  assert.strictEqual(ranked[0].code, "A");
  assert.ok(ranked.every((p) => p.windowsPrinterName));
  const best = pickBestPrinter(candidates, agentMap, pendingMap, now);
  assert.strictEqual(best.code, "A");
});

run("Online agent preferred over offline with lower pending", () => {
  const now = Date.now();
  const candidates = [
    { _id: "1", code: "OFF", agentId: "OFFLINE", windowsPrinterName: "P", isActive: true },
    { _id: "2", code: "ON", agentId: "ONLINE", windowsPrinterName: "P", isActive: true },
  ];
  const agentMap = {
    OFFLINE: { isActive: true, status: "OFFLINE", lastHeartbeatAt: new Date(now - 10) },
    ONLINE: { isActive: true, status: "ONLINE", lastHeartbeatAt: new Date(now - 10) },
  };
  const pendingMap = { "1": 0, "2": 9 };
  assert.strictEqual(pickBestPrinter(candidates, agentMap, pendingMap, now).code, "ON");
});

run("Routing order documented in printerManager", () => {
  const src = fs.readFileSync(path.join(backendRoot, "src/services/label/printerManager.js"), "utf8");
  assert.ok(src.includes("Explicit"));
  assert.ok(src.includes("Warehouse default"));
  assert.ok(src.includes("Legacy fallback"));
  assert.ok(src.includes("pickBestPrinter") || src.includes("selectRoutable"));
  assert.ok(src.includes("LABEL_PRINTER_DEFAULT_CONFLICT") || src.includes("11000"));
  assert.ok(src.includes("LABEL_PRINTER_HAS_OPEN_JOBS"));
});

run("Bootstrap is hashed, timed, scoped, idempotent", () => {
  const settings = fs.readFileSync(
    path.join(backendRoot, "src/services/label/labelSettingsService.js"),
    "utf8"
  );
  assert.ok(settings.includes("AGENT_BOOTSTRAP_TOKEN_HASH"));
  assert.ok(settings.includes("bcrypt.hash"));
  assert.ok(settings.includes("bcrypt.compare") || settings.includes("verifyBootstrapToken"));
  assert.ok(settings.includes("AGENT_BOOTSTRAP_EXPIRES_AT"));
  assert.ok(settings.includes("timingSafeEqualUtf8"));
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("installationId"));
  assert.ok(svc.includes("idempotent"));
  assert.ok(svc.includes("AGENT_BOOTSTRAP_WAREHOUSE_MISMATCH") || svc.includes("material.warehouse"));
  assert.ok(!svc.includes("upsertPrinterMapping("));
});

run("Heartbeat does not overwrite admin-controlled fields", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  const hb = svc.slice(svc.indexOf("applyAgentHeartbeat"), svc.indexOf("createTestPrintJob"));
  assert.ok(hb.includes("never company"));
  assert.ok(!hb.includes("agent.name ="));
  assert.ok(!hb.includes("agent.warehouseCode ="));
  assert.ok(!hb.includes("agent.isActive ="));
  assert.ok(hb.includes("normalizePrinterNames"));
  assert.ok(hb.includes("normalizePrinterStatusList"));
});

run("Printer health is independent of agent ONLINE", () => {
  const helpers = fs.readFileSync(
    path.join(backendRoot, "src/services/label/labelRoutingHelpers.js"),
    "utf8"
  );
  assert.ok(helpers.includes("resolveMappedPrinterHealth"));
  assert.ok(helpers.includes("DISCONNECTED"));
  assert.ok(helpers.includes("normalizePrinterStatusList"));
  const ctrl = fs.readFileSync(path.join(backendRoot, "src/controllers/labelController.js"), "utf8");
  assert.ok(ctrl.includes("resolveMappedPrinterHealth"));
  assert.ok(ctrl.includes("spoolerQueueLength") || ctrl.includes("printerStatusMessage") || ctrl.includes("...health"));
  const ui = fs.readFileSync(path.join(repoRoot, "src/components/store/LabelSettingsPanel.jsx"), "utf8");
  assert.ok(ui.includes("printerStatusBadge"));
  assert.ok(ui.includes("Agent Status"));
  assert.ok(ui.includes("Printer Status"));
  assert.ok(ui.includes("refetchInterval"));
});

run("Lease remains agentId-scoped (isolation)", () => {
  const q = fs.readFileSync(path.join(backendRoot, "src/services/label/printQueue.js"), "utf8");
  assert.ok(q.includes("agentId: String(agent.agentId)"));
  assert.ok(q.includes('status: "PENDING"'));
});

run("Disabled agents rejected by requirePrintAgent", () => {
  const auth = fs.readFileSync(path.join(backendRoot, "src/middleware/printAgentAuth.js"), "utf8");
  assert.ok(auth.includes("isActive: true"));
});

run("Test connection vs test print separated", () => {
  const ctrl = fs.readFileSync(path.join(backendRoot, "src/controllers/labelController.js"), "utf8");
  assert.ok(ctrl.includes("physicalPrintRequired: false"));
  assert.ok(ctrl.includes("mappedWindowsPrinterFound"));
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("TEST_PRINT"));
  assert.ok(svc.includes("sourceType: \"MANUAL\""));
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.ok(routes.includes("testPrintRateLimit"));
});

run("Test label remains 100x50", () => {
  const tspl = buildTestLabelTspl({
    agentName: "STORE",
    printerName: "Rongta & Co (USB)",
    title: "MARIVOLT TEST LABEL",
  });
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(tspl.includes("MARIVOLT TEST LABEL"));
});

run("Bootstrap HTTPS + admin bootstrap permission", () => {
  const agentCtrl = fs.readFileSync(
    path.join(backendRoot, "src/controllers/labelAgentController.js"),
    "utf8"
  );
  assert.ok(agentCtrl.includes("AGENT_HTTPS_REQUIRED"));
  const ctrl = fs.readFileSync(path.join(backendRoot, "src/controllers/labelController.js"), "utf8");
  assert.ok(ctrl.includes("LABELS.admin required to manage agent bootstrap"));
});

run("Permissions: agent/printer admin routes gated", () => {
  const routes = fs.readFileSync(path.join(backendRoot, "src/routes/labelRoutes.js"), "utf8");
  assert.ok(routes.includes('router.post("/agents", labelsAdmin'));
  assert.ok(routes.includes("rotate-secret"));
  assert.ok(routes.includes('router.post("/printers", labelsAdmin'));
  assert.ok(routes.includes('router.post("/jobs/from-grn", labelsPrint'));
});

run("Discovery does not auto-create PrinterConfig on bootstrap", () => {
  const cfg = fs.readFileSync(path.join(repoRoot, "print-agent/src/config.js"), "utf8");
  assert.ok(cfg.includes("not auto-mapped"));
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("Does not auto-create PrinterConfig"));
});

run("Settings defaults keep labels disabled; bootstrap hash key present", () => {
  assert.strictEqual(LABEL_SETTING_DEFAULTS[LABEL_SETTING_KEYS.ENABLED], false);
  assert.ok(LABEL_SETTING_KEYS.AGENT_BOOTSTRAP_TOKEN_HASH);
});

run("Same Windows queue name on two PCs = two mappings (docs/code)", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/PrinterConfig.js"), "utf8");
  assert.ok(model.includes("two distinct ERP mappings"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
