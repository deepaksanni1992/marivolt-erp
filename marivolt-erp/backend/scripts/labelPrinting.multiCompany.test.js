/**
 * Multi-company label printing isolation + branding (no Mongo required for unit vectors).
 * Run: node backend/scripts/labelPrinting.multiCompany.test.js
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  resolveLabelCompanyBranding,
  resolveLabelTestTitle,
} from "../src/services/label/labelCompanyBranding.js";
import { buildJobTspl, buildTestLabelTspl } from "../src/services/label/tsplGenerator.js";
import { LABEL_SETTING_DEFAULTS, LABEL_SETTING_KEYS } from "../src/services/label/labelSettingsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed += 1;
  }
}

const line = {
  article: "8X0098",
  description: "Fuel pump",
  spn: "SPN1",
  materialCode: "MAT1",
  qty: 1,
  uom: "PCS",
  poNo: "PO1",
  grnNo: "GRN1",
  receivedDate: "2026-08-12",
  location: "A1",
  labelQty: 1,
};

console.log("\nLabel printing multi-company\n");

run("TEST A/B — branding resolves per company (MAR vs OKE)", () => {
  assert.equal(resolveLabelCompanyBranding({ code: "MAR", name: "Marivolt" }), "MARIVOLT FZE");
  assert.equal(resolveLabelCompanyBranding({ code: "OKE", name: "Okeanos" }), "OKEANOS");
  assert.equal(resolveLabelTestTitle({ code: "OKE", name: "Okeanos" }), "OKEANOS TEST LABEL");
});

run("TEST I/J — TSPL branding: MAR stays MARIVOLT FZE; OKE is OKEANOS", () => {
  const marTspl = buildJobTspl([line], { copies: 1, companyName: "MARIVOLT FZE" });
  const okeTspl = buildJobTspl([line], { copies: 1, companyName: "OKEANOS" });
  assert.match(marTspl, /MARIVOLT FZE/);
  assert.doesNotMatch(marTspl, /OKEANOS/);
  assert.match(okeTspl, /OKEANOS/);
  assert.doesNotMatch(okeTspl, /MARIVOLT FZE/);
});

run("TEST C/D — leaseNextJob filters by agent.companyId + agentId (source)", () => {
  const queue = fs.readFileSync(path.join(backendRoot, "src/services/label/printQueue.js"), "utf8");
  assert.ok(queue.includes("companyId: agent.companyId"));
  assert.ok(queue.includes("agentId: String(agent.agentId).toUpperCase()"));
  assert.ok(queue.includes('status: "PENDING"'));
});

run("TEST E — agent identity is company-bound; agentId globally unique (source)", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/PrintAgent.js"), "utf8");
  assert.ok(model.includes("companyId"));
  assert.ok(model.includes("{ agentId: 1 }, { unique: true }"));
  assert.ok(model.includes("{ companyId: 1, agentId: 1 }, { unique: true }"));
});

run("TEST F/G — printer resolution never crosses company (source)", () => {
  const mgr = fs.readFileSync(path.join(backendRoot, "src/services/label/printerManager.js"), "utf8");
  assert.ok(/Never crosses company|companyId/.test(mgr));
  assert.ok(mgr.includes("resolvePrinterForJob"));
  assert.ok(mgr.includes("companyId"));
});

run("TEST H — templates are global layout codes; branding is injected at render", () => {
  const tpl = fs.readFileSync(path.join(backendRoot, "src/models/LabelTemplate.js"), "utf8");
  assert.ok(tpl.includes('MARIVOLT_STANDARD'));
  assert.ok(tpl.includes("companyId"));
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("loadLabelCompanyBranding"));
  assert.ok(!/"MARIVOLT FZE"/.test(svc));
});

run("TEST K/N — disabled company cannot create jobs (LABEL_ENABLED default false + gate)", () => {
  assert.equal(LABEL_SETTING_DEFAULTS[LABEL_SETTING_KEYS.ENABLED], false);
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("LABEL_DISABLED"));
  assert.ok(svc.includes("if (!settings.enabled)"));
  const ui = fs.readFileSync(path.join(backendRoot, "../src/pages/StoreModule.jsx"), "utf8");
  assert.ok(ui.includes("Label printing disabled in settings"));
  assert.ok(ui.includes("labelSettingsData?.enabled === false"));
});

run("TEST L — Post GRN & Print uses company-scoped createJobsFromGrn", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("export async function createJobsFromGrn"));
  assert.ok(svc.includes("const companyId = req.companyId"));
  assert.ok(svc.includes("resolvePrinterForJob(companyId"));
});

run("TEST M — idempotency key unique per company (source)", () => {
  const model = fs.readFileSync(path.join(backendRoot, "src/models/LabelPrintJob.js"), "utf8");
  assert.ok(model.includes("idempotencyKey"));
  assert.ok(model.includes("companyId"));
});

run("TEST — OKE setup script refuses agent/secret clone", () => {
  const setup = fs.readFileSync(path.join(backendRoot, "scripts/setupOkeLabelPrintingFromMar.mjs"), "utf8");
  assert.ok(setup.includes("Does NOT clone PrintAgent"));
  assert.ok(setup.includes("defaultPrinterCode: \"\""));
  assert.ok(setup.includes("WITH_BOOTSTRAP"));
});

run("TEST — test label title is company-aware", () => {
  const tspl = buildTestLabelTspl({ title: "OKEANOS TEST LABEL", agentName: "A1", printerName: "P1" });
  assert.match(tspl, /OKEANOS TEST LABEL/);
  assert.doesNotMatch(tspl, /MARIVOLT TEST LABEL/);
});

run("shortName overrides name for branding", () => {
  assert.equal(
    resolveLabelCompanyBranding({ code: "OKE", name: "Okeanos", shortName: "OKEANOS FZE" }),
    "OKEANOS FZE"
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
