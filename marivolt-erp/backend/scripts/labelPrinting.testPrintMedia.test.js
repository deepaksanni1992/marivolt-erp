/**
 * Label Settings Test Print: diagnostic media follows the selected printer profile.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  LABEL_PURPOSE_GRN,
  LABEL_PURPOSE_PACKING,
  LABEL_PURPOSE_TEST,
  administrativeTestPrintAssertOpts,
  assertPrinterCompatible,
  printerAllowsPurpose,
} from "../src/services/label/labelPrinterProfile.js";
import { planAdministrativeTestPrint } from "../src/services/label/labelJobPayload.js";
import { buildTestLabelTspl } from "../src/services/label/tsplGenerator.js";
import { buildTestLabelZpl } from "../src/services/label/zplGenerator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

function onlineAgent(id = "AGTB3A953D7") {
  return {
    agentId: id,
    name: "Deepak Laptop",
    isActive: true,
    status: "ONLINE",
    lastHeartbeatAt: new Date(),
    appVersion: "1.9.0",
    capabilities: { languages: ["TSPL", "ZPL"], rawZpl: true },
  };
}

function rongta150() {
  return {
    _id: "p-rongta",
    code: "RONGTA-LAPTOP",
    displayName: "Deepak Laptop Rongta",
    companyId: "co1",
    agentId: "AGTB3A953D7",
    windowsPrinterName: "RP4xx Series 200DPI TSPL",
    isActive: true,
    language: "TSPL",
    dpi: 203,
    widthMm: 100,
    heightMm: 150,
    supportedPurposes: ["PACKING", "CUSTOM_PACKING"],
  };
}

function zebra50() {
  return {
    _id: "p-zebra",
    code: "ZEBRA-DEEPAK-GRN",
    displayName: "Deepak Laptop Zebra GRN 100x50",
    companyId: "co1",
    agentId: "AGTB3A953D7",
    windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
    isActive: true,
    language: "ZPL",
    dpi: 203,
    widthMm: 100,
    heightMm: 50,
    supportedPurposes: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "TEST", "ASN"],
  };
}

function storeUnlocked() {
  return {
    _id: "p-store",
    code: "RONGTA1",
    displayName: "Store Rongta Printer",
    companyId: "co1",
    agentId: "AGT6E67EEBA",
    windowsPrinterName: "RP4xx Series 200DPI TSPL",
    isActive: true,
    language: "TSPL",
    dpi: 203,
    widthMm: 0,
    heightMm: 0,
  };
}

function countCmd(payload, re) {
  return (String(payload || "").match(re) || []).length;
}

console.log("Test Print diagnostic media\n");

run("Rongta 100×150 diagnostic is one TSPL face with SIZE 100 mm,150 mm", () => {
  const printer = rongta150();
  const agent = onlineAgent();
  const planned = planAdministrativeTestPrint({
    printer,
    agent,
    companyName: "Marivolt",
    info: {
      agentId: printer.agentId,
      agentName: agent.name,
      printerName: printer.displayName,
      windowsPrinterName: printer.windowsPrinterName,
      connectionStatus: "ONLINE",
      title: "Marivolt",
    },
  });
  const payload = planned.rendered.tsplPayload;
  assert.equal(planned.dest.printerCode, "RONGTA-LAPTOP");
  assert.equal(planned.dest.agentId, "AGTB3A953D7");
  assert.equal(planned.dest.windowsPrinterName, "RP4xx Series 200DPI TSPL");
  assert.equal(planned.dest.language, "TSPL");
  assert.equal(planned.dest.widthMm, 100);
  assert.equal(planned.dest.heightMm, 150);
  assert.equal(planned.copies, 1);
  assert.equal(planned.requestedLabels, 1);
  assert.ok(payload.includes("SIZE 100 mm,150 mm"));
  assert.ok(!payload.includes("SIZE 100 mm,50 mm"));
  assert.equal(countCmd(payload, /(?:^|\r?\n)\s*PRINT 1,1\b/gm), 1);
  assert.equal(countCmd(payload, /(?:^|\r?\n)\s*HOME\b/gm), 1);
  assert.ok(!/\bGAPDETECT\b/i.test(payload));
  assert.ok(!/(?:^|\r?\n)\s*GAP\b/im.test(payload));
  assert.ok(!/\bFEED\b/i.test(payload));
  assert.ok(!/\bFORMFEED\b/i.test(payload));
  assert.ok(payload.includes("Language: TSPL"));
  assert.ok(payload.includes("Media: 100x150 mm"));
  assert.ok(payload.includes("Printer: Deepak Laptop Rongta"));
  assert.ok(payload.includes("Agent: Deepak Laptop"));
});

run("Zebra 100×50 diagnostic preserves ZPL 800×400 and one copy", () => {
  const printer = zebra50();
  const agent = onlineAgent();
  const planned = planAdministrativeTestPrint({
    printer,
    agent,
    companyName: "Marivolt",
    info: {
      agentId: printer.agentId,
      agentName: agent.name,
      printerName: printer.displayName,
      windowsPrinterName: printer.windowsPrinterName,
      connectionStatus: "ONLINE",
      title: "Marivolt",
    },
  });
  const payload = planned.rendered.tsplPayload;
  assert.equal(planned.dest.printerCode, "ZEBRA-DEEPAK-GRN");
  assert.equal(planned.dest.agentId, "AGTB3A953D7");
  assert.equal(planned.dest.windowsPrinterName, "ZDesigner ZD220-203dpi ZPL");
  assert.equal(planned.dest.language, "ZPL");
  assert.equal(planned.dest.widthMm, 100);
  assert.equal(planned.dest.heightMm, 50);
  assert.equal(planned.copies, 1);
  assert.ok(payload.includes("^PW800"));
  assert.ok(payload.includes("^LL400"));
  assert.equal(countCmd(payload, /\^PQ1,0,1,Y/g), 1);
  assert.equal(countCmd(payload, /\^XZ/g), 1);
  assert.ok(!/\^BC/i.test(payload));
  assert.ok(payload.includes("Language: ZPL"));
  assert.ok(payload.includes("Media: 100x50 mm"));
});

run("Legacy unrestricted STORE diagnostic stays 100×50 TSPL with SIZE+GAP", () => {
  const printer = storeUnlocked();
  const agent = {
    agentId: "AGT6E67EEBA",
    name: "STORE",
    isActive: true,
    status: "ONLINE",
    lastHeartbeatAt: new Date(),
    appVersion: "1.8.2",
  };
  const planned = planAdministrativeTestPrint({
    printer,
    agent,
    companyName: "Marivolt",
    info: { title: "Marivolt", printerName: printer.displayName },
  });
  const payload = planned.rendered.tsplPayload;
  assert.equal(planned.dest.widthMm, 100);
  assert.equal(planned.dest.heightMm, 50);
  assert.ok(payload.includes("SIZE 100 mm,50 mm"));
  assert.ok(payload.includes("GAP 3 mm,0"));
  assert.ok(!/(?:^|\r?\n)\s*HOME\b/m.test(payload));
  const defaultTspl = buildTestLabelTspl({ title: "Marivolt" });
  assert.ok(defaultTspl.includes("SIZE 100 mm,50 mm"));
});

run("Job metadata agrees with payload media and does not fall back to STORE", () => {
  const planned = planAdministrativeTestPrint({
    printer: rongta150(),
    agent: onlineAgent(),
    companyName: "Marivolt",
    info: { title: "Marivolt" },
  });
  assert.equal(planned.dest.printerCode, "RONGTA-LAPTOP");
  assert.ok(planned.dest.printerCode !== "RONGTA1");
  assert.equal(planned.routed.widthMm, planned.dest.widthMm);
  assert.equal(planned.routed.heightMm, planned.dest.heightMm);
  assert.equal(planned.routed.language, planned.dest.language);
  assert.ok(planned.rendered.tsplPayload.includes(`SIZE ${planned.dest.widthMm} mm,${planned.dest.heightMm} mm`));
});

run("Packing printer is not eligible for GRN/ASN; TEST purpose stays off the profile", () => {
  const r = rongta150();
  const agent = onlineAgent();
  assert.equal(printerAllowsPurpose(r, LABEL_PURPOSE_TEST), false);
  assert.equal(administrativeTestPrintAssertOpts(r).purpose, undefined);
  assert.equal(administrativeTestPrintAssertOpts(r).widthMm, 100);
  assert.equal(administrativeTestPrintAssertOpts(r).heightMm, 150);
  assert.throws(
    () =>
      assertPrinterCompatible(r, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_GRN,
        templateCode: "MARIVOLT_STANDARD",
        agent,
      }),
    /not configured for GRN/
  );
  assert.throws(
    () =>
      assertPrinterCompatible(r, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_TEST,
        widthMm: 100,
        heightMm: 150,
        agent,
      }),
    /not configured for TEST/
  );
  assert.throws(
    () =>
      assertPrinterCompatible(r, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_PACKING,
        templateCode: "PACKING_STANDARD_100X50",
        widthMm: 100,
        heightMm: 50,
        agent,
      }),
    /media is 100×150 mm; label is 100×50 mm/
  );
  assertPrinterCompatible(r, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_PACKING,
    templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
    agent,
  });
});

run("Zebra still rejects packing business labels", () => {
  const z = zebra50();
  const agent = onlineAgent();
  assert.throws(
    () =>
      assertPrinterCompatible(z, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_PACKING,
        templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
        agent,
      }),
    /not configured for PACKING/
  );
  const zWithPacking = zebra50();
  zWithPacking.supportedPurposes = [...zWithPacking.supportedPurposes, "PACKING"];
  assert.throws(
    () =>
      assertPrinterCompatible(zWithPacking, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_PACKING,
        templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
        agent,
      }),
    /Packing\/dispatch/
  );
  const zpl = buildTestLabelZpl(
    { title: "Marivolt", language: "ZPL", mediaLabel: "100x50 mm" },
    { widthMm: 100, heightMm: 50, language: "ZPL" }
  );
  assert.ok(zpl.includes("^PW800"));
  assert.ok(zpl.includes("^LL400"));
});

run("createTestPrintJob uses selected printer media and does not auto-route to STORE", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  const start = svc.indexOf("export async function createTestPrintJob");
  const end = svc.indexOf("export { touchPrinterLastPrint }");
  const fn = svc.slice(start, end);
  assert.ok(fn.includes("planAdministrativeTestPrint"));
  assert.ok(fn.includes("administrativeTestPrintAssertOpts"));
  assert.ok(fn.includes("requirePrinterCode(\"\", LABEL_PURPOSE_TEST)"));
  assert.ok(!fn.includes("resolvePrinterForJob(req.companyId, null"));
  assert.ok(!fn.includes(".catch(async () => loadAndAssertPrinter"));
  assert.ok(fn.includes("copies: planned.copies"));
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
