/**
 * Dual-printer routing + ZPL GRN renderer (no Mongo).
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  LABEL_LANGUAGE_ZPL,
  LABEL_LANGUAGE_TSPL,
  MIN_AGENT_VERSION_ZPL,
  agentSupportsZpl,
  agentVersionAtLeast,
} from "../src/services/label/labelLanguages.js";
import {
  LABEL_PURPOSE_GRN,
  LABEL_PURPOSE_PACKING,
  LABEL_PURPOSE_ASN,
  assertPrinterCompatible,
  bindIdempotencyKeyToPrinter,
  destinationsMatch,
  printerAllowsPurpose,
  purposeFromSourceType,
  requirePrinterCode,
  ZPL_ASN_RU_LAYOUT_VERSION,
} from "../src/services/label/labelPrinterProfile.js";
import {
  assertZplEncodable,
  assertZplPayloadSafe,
  buildJobZpl,
  buildSingleLabelZpl,
  countZplFormats,
  escapeZplField,
  hexEscapeZplBarcodeData,
  layoutAsnRuLabelSvg,
} from "../src/services/label/zplGenerator.js";
import { buildSingleLabelTspl } from "../src/services/label/tsplGenerator.js";
import { encodeBarcodeValue } from "../src/services/label/barcodeGenerator.js";
import { asnLabelTsplOpts, buildAsnRuJobLine } from "../src/services/label/asnLabelService.js";
import { renderStandardLabelPayload } from "../src/services/label/labelJobPayload.js";

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

function zebraPrinter(overrides = {}) {
  return {
    _id: "p-zebra",
    code: "ZEBRA-DEEPAK-GRN",
    displayName: "Deepak Laptop Zebra GRN 100x50",
    companyId: "co1",
    agentId: "AGTDEEPAK",
    windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
    isActive: true,
    language: "ZPL",
    dpi: 203,
    widthMm: 100,
    heightMm: 50,
    supportedPurposes: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "TEST", "ASN"],
    ...overrides,
  };
}

function rongtaPrinter(overrides = {}) {
  return {
    _id: "p-rongta",
    code: "RONGTA-LAPTOP",
    displayName: "Deepak Rongta",
    companyId: "co1",
    agentId: "AGTDEEPAK",
    windowsPrinterName: "RP4xx Series 200DPI TSPL (Copy 1)",
    isActive: true,
    language: "TSPL",
    dpi: 203,
    widthMm: 100,
    heightMm: 150,
    supportedPurposes: ["PACKING", "CUSTOM_PACKING"],
    ...overrides,
  };
}

function storePrinter() {
  return {
    _id: "p-store",
    code: "RONGTA-STORE",
    companyId: "co1",
    agentId: "AGTSTORE",
    windowsPrinterName: "RP4xx Series 200DPI TSPL",
    isActive: true,
  };
}

function onlineAgent(id, extra = {}) {
  return {
    agentId: id,
    isActive: true,
    status: "ONLINE",
    lastHeartbeatAt: new Date(),
    appVersion: "1.9.0",
    capabilities: { languages: ["TSPL", "ZPL"], rawZpl: true },
    ...extra,
  };
}

console.log("Dual printer / ZPL GRN");

run("Zebra GRN and ASN 100x50 ZPL are compatible; packing is not", () => {
  const z = zebraPrinter({
    supportedPurposes: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "TEST", "PACKING", "ASN"],
  });
  const agent = onlineAgent("AGTDEEPAK");
  assertPrinterCompatible(z, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_GRN,
    templateCode: "MARIVOLT_STANDARD",
    agent,
  });
  const asnRouted = assertPrinterCompatible(z, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_ASN,
    templateCode: "MARIVOLT_STANDARD",
    agent,
  });
  assert.equal(asnRouted.layoutVersion, ZPL_ASN_RU_LAYOUT_VERSION);
  assert.throws(
    () =>
      assertPrinterCompatible(z, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_PACKING,
        templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
        agent,
      }),
    /Packing\/dispatch/
  );
});

run("Deepak Rongta packing 100x150 accepts packing and rejects GRN", () => {
  const r = rongtaPrinter();
  const agent = onlineAgent("AGTDEEPAK");
  assertPrinterCompatible(r, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_PACKING,
    templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
    agent,
  });
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
});

run("STORE unrestricted Rongta still accepts GRN and packing", () => {
  const s = storePrinter();
  const agent = onlineAgent("AGTSTORE", { capabilities: undefined, appVersion: "1.8.2" });
  assertPrinterCompatible(s, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_GRN,
    templateCode: "MARIVOLT_STANDARD",
    agent,
  });
  assertPrinterCompatible(s, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_PACKING,
    templateCode: "PACKING_QR_LANDSCAPE_150X100_V1",
    agent,
  });
  assert.equal(printerAllowsPurpose(s, LABEL_PURPOSE_GRN), true);
});

run("Wrong-agent override is rejected", () => {
  const z = zebraPrinter();
  const agent = onlineAgent("AGTDEEPAK");
  assert.throws(
    () =>
      assertPrinterCompatible(z, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_GRN,
        agent,
        requireAgentId: "AGTSTORE",
      }),
    /not AGTSTORE/
  );
});

run("Cross-company printer is rejected", () => {
  const z = zebraPrinter({ companyId: "other" });
  assert.throws(
    () =>
      assertPrinterCompatible(z, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_GRN,
        agent: onlineAgent("AGTDEEPAK"),
      }),
    /company/
  );
});

run("Old agent cannot take ZPL while online", () => {
  const z = zebraPrinter();
  const old = onlineAgent("AGTDEEPAK", {
    appVersion: "1.8.2",
    capabilities: { languages: ["TSPL"] },
  });
  assert.equal(agentSupportsZpl(old), false);
  assert.throws(
    () =>
      assertPrinterCompatible(z, {
        companyId: "co1",
        purpose: LABEL_PURPOSE_GRN,
        agent: old,
      }),
    /cannot print ZPL/
  );
});

run("Offline old agent may enqueue ZPL (lease gate handles accept)", () => {
  const z = zebraPrinter();
  const old = {
    agentId: "AGTDEEPAK",
    isActive: true,
    status: "OFFLINE",
    appVersion: "1.8.2",
    lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
  };
  assertPrinterCompatible(z, {
    companyId: "co1",
    purpose: LABEL_PURPOSE_GRN,
    agent: old,
  });
});

run("Idempotency key binds destination so printer switches do not reuse", () => {
  const a = bindIdempotencyKeyToPrinter("grn:G1:initial", zebraPrinter());
  const b = bindIdempotencyKeyToPrinter("grn:G1:initial", rongtaPrinter());
  assert.ok(a.includes("ZEBRA-DEEPAK-GRN"));
  assert.ok(b.includes("RONGTA-LAPTOP"));
  assert.notEqual(a, b);
  const again = bindIdempotencyKeyToPrinter(a, zebraPrinter());
  assert.equal(again, a);
});

run("Destinations match uses frozen printer code", () => {
  assert.equal(
    destinationsMatch({ printerCode: "ZEBRA-DEEPAK-GRN", agentId: "AGTDEEPAK" }, zebraPrinter()),
    true
  );
  assert.equal(
    destinationsMatch({ printerCode: "ZEBRA-DEEPAK-GRN" }, rongtaPrinter()),
    false
  );
});

run("ZPL GRN preserves exact Article barcode including punctuation and leading zeros", () => {
  const article = "00-ART.01";
  const zpl = buildSingleLabelZpl({
    article,
    description: "Housing",
    spn: "SPN-1",
    materialCode: "MC-1",
    uom: "PCS",
    poNo: "PO-1",
    grnNo: "GRN-1",
    receivedDate: "2026-09-12",
    location: "BIN-A",
  });
  const enc = encodeBarcodeValue({ mode: "ARTICLE", article });
  assert.equal(enc.value, "00-ART.01");
  assert.ok(zpl.includes("^XA"));
  assert.ok(zpl.includes("^XZ"));
  assert.ok(zpl.includes("^PW800"));
  assert.ok(zpl.includes("^LL400"));
  assert.ok(zpl.includes(`>;${article}`));
  assert.ok(!zpl.includes("GAPDETECT"));
  assert.ok(!zpl.includes("\nCLS"));
  assert.ok(!/\nPRINT\s+1/.test(zpl));
  assertZplPayloadSafe(zpl);
});

run("ZPL escapes command characters in field data", () => {
  assert.ok(escapeZplField("A^B").includes("_5E"));
  const zpl = buildSingleLabelZpl({
    article: "ART1",
    description: "Valve ~ special",
    spn: "A_B",
    materialCode: "M",
    uom: "PCS",
  });
  assert.ok(zpl.includes("^FH_"));
  assert.ok(hexEscapeZplBarcodeData("A>B").includes("_3E"));
});

run("Five distinct ZPL labels emit five complete formats", () => {
  const payload = buildJobZpl(
    [
      { article: "A1", description: "One", labelDistribution: [1] },
      { article: "A2", description: "Two", labelDistribution: [1] },
      { article: "A3", description: "Three", labelDistribution: [1] },
      { article: "A4", description: "Four", labelDistribution: [1] },
      { article: "A5", description: "Five", labelDistribution: [1] },
    ],
    { copies: 1, companyName: "MARIVOLT FZE" }
  );
  assert.equal(countZplFormats(payload), 5);
  assert.equal((payload.match(/\^XZ/g) || []).length, 5);
});

run("Copy counts repeat complete ZPL formats", () => {
  const payload = buildJobZpl([{ article: "A1", labelDistribution: [10, 5] }], { copies: 2 });
  assert.equal(countZplFormats(payload), 4);
});

run("Long identifier overflow is rejected", () => {
  const long = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789EXTRA";
  assert.throws(() => buildSingleLabelZpl({ article: long, description: "x" }), /does not fit|too wide/);
});

run("Non-ASCII encoding is rejected explicitly", () => {
  assert.throws(() => assertZplEncodable("café", "Description"), /Unsupported character/);
});

run("TSPL GRN renderer is unchanged for Rongta", () => {
  const tspl = buildSingleLabelTspl({
    article: "00-ART.01",
    description: "Housing",
    spn: "SPN-1",
    materialCode: "MC-1",
    uom: "PCS",
  });
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(tspl.includes("BARCODE"));
  assert.ok(tspl.includes("00-ART.01"));
});

run("RU ZPL preserves exact RU barcode identity, not Article", () => {
  const ruNo = "MAR-RU-000125";
  const line = buildAsnRuJobLine(
    {
      _id: "ru1",
      ruNo,
      article: "20834",
      description: "O-Ring",
      partNo: "TE201 / TE402",
      plannedQty: 25,
      uom: "PCS",
      asnNo: "MAR-ASN-0045",
    },
    { asnNo: "MAR-ASN-0045" }
  );
  assert.equal(line.barcodeValue, ruNo);
  const zpl = buildSingleLabelZpl(line, {
    ...asnLabelTsplOpts({ companyName: "MARIVOLT FZE" }),
    qtyPerLabel: 25,
    language: LABEL_LANGUAGE_ZPL,
  });
  assert.ok(zpl.includes("^XA"));
  assert.ok(zpl.includes("^PW800"));
  assert.ok(zpl.includes("^LL400"));
  assert.ok(zpl.includes(`>:${ruNo}`));
  assert.ok(!zpl.includes(`>;${ruNo}`));
  assert.ok(!zpl.includes(">;20834"));
  assert.ok(zpl.includes("RU: MAR-RU-000125"));
  assert.ok(zpl.includes("ASN: MAR-ASN-0045"));
  assert.ok(zpl.includes("Qty: 25 PCS"));
  assert.ok(zpl.includes("20834"));
  assert.ok(zpl.includes("TE201 / TE402"));
  assert.ok(!zpl.includes("GAPDETECT"));
  assert.ok(!/\nPRINT\s+1/.test(zpl));
  assertZplPayloadSafe(zpl);
  const svg = layoutAsnRuLabelSvg(line, { ...asnLabelTsplOpts({ companyName: "MARIVOLT FZE" }), qtyPerLabel: 25 });
  assert.equal(svg.barcodeValue, ruNo);
  assert.equal(svg.ruNo, ruNo);
  const rendered = renderStandardLabelPayload([line], {
    ...asnLabelTsplOpts({ copies: 1, companyName: "MARIVOLT FZE" }),
    language: LABEL_LANGUAGE_ZPL,
  });
  assert.equal(rendered.language, LABEL_LANGUAGE_ZPL);
  assert.ok(rendered.tsplPayload.includes(`>:${ruNo}`));
});

run("Multiple distinct RU ZPL labels keep one format and barcode each", () => {
  const lines = ["MAR-RU-000001", "MAR-RU-000002", "MAR-RU-000003"].map((ruNo) =>
    buildAsnRuJobLine(
      { _id: ruNo, ruNo, article: "ART1", plannedQty: 10, uom: "PCS", asnNo: "MAR-ASN-0001" },
      { asnNo: "MAR-ASN-0001" }
    )
  );
  const payload = buildJobZpl(lines, {
    ...asnLabelTsplOpts({ copies: 1, companyName: "MARIVOLT FZE" }),
    language: LABEL_LANGUAGE_ZPL,
  });
  assert.equal(countZplFormats(payload), 3);
  assert.ok(payload.includes(">:MAR-RU-000001"));
  assert.ok(payload.includes(">:MAR-RU-000002"));
  assert.ok(payload.includes(">:MAR-RU-000003"));
});

run("Blank printer code is rejected so STORE cannot be auto-selected", () => {
  assert.throws(() => requirePrinterCode("", LABEL_PURPOSE_ASN), /LABEL_PRINTER_REQUIRED|Select a printer/);
  try {
    requirePrinterCode("  ", LABEL_PURPOSE_GRN);
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "LABEL_PRINTER_REQUIRED");
  }
  assert.equal(requirePrinterCode("ZEBRA-DEEPAK-GRN", LABEL_PURPOSE_ASN), "ZEBRA-DEEPAK-GRN");
});

run("purposeFromSourceType maps GRN/packing/ASN", () => {
  assert.equal(purposeFromSourceType("GRN"), LABEL_PURPOSE_GRN);
  assert.equal(purposeFromSourceType("PACKING"), LABEL_PURPOSE_PACKING);
  assert.equal(purposeFromSourceType("ASN"), LABEL_PURPOSE_ASN);
});

run("Agent 1.9.0 is the ZPL floor", () => {
  assert.equal(MIN_AGENT_VERSION_ZPL, "1.9.0");
  assert.equal(agentVersionAtLeast("1.9.0", "1.9.0"), true);
  assert.equal(agentVersionAtLeast("1.8.2", "1.9.0"), false);
  assert.equal(LABEL_LANGUAGE_ZPL, "ZPL");
  assert.equal(LABEL_LANGUAGE_TSPL, "TSPL");
});

run("Windows queue name is the confirmed Zebra string in setup script", () => {
  const setup = fs.readFileSync(
    path.join(backendRoot, "scripts/registerDeepakZebraPrinter.mjs"),
    "utf8"
  );
  assert.ok(setup.includes("ZDesigner ZD220-203dpi ZPL"));
  assert.ok(setup.includes("ZEBRA-DEEPAK-GRN"));
  assert.ok(!setup.includes("--apply") || setup.includes("DRY"));
});

run("Print agent 1.9.0 advertises ZPL and does not skip all leases on default printer", () => {
  const index = fs.readFileSync(path.join(repoRoot, "print-agent/src/index.js"), "utf8");
  const proc = fs.readFileSync(path.join(repoRoot, "print-agent/src/jobProcessor.js"), "utf8");
  assert.ok(index.includes('APP_VERSION = "1.9.0"'));
  assert.ok(index.includes("capabilities: agentCapabilities()"));
  assert.ok(proc.includes("validateJobLanguagePayload"));
  assert.ok(!proc.includes("lease_skipped_unhealthy"));
  assert.ok(proc.includes("resolveJobWindowsQueue"));
  assert.ok(proc.includes("refusing config.json fallback") || index.includes("refusing config.json fallback"));
});

run("STORE default routing code still does not rewrite company default in resolve hop", () => {
  const mgr = fs.readFileSync(path.join(backendRoot, "src/services/label/printerManager.js"), "utf8");
  assert.ok(mgr.includes("hopSameAgent"));
  assert.ok(mgr.includes("Explicit printerCode"));
});

run("ASN enqueue keeps one job per RU, LABEL_ID, and requires an explicit printer", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/asnLabelService.js"), "utf8");
  assert.ok(svc.includes("renderStandardLabelPayload"));
  assert.ok(svc.includes('barcodeMode: "LABEL_ID"'));
  assert.ok(svc.includes('faceVariant: "ASN_RU"'));
  assert.ok(svc.includes("requirePrinterCode"));
  assert.ok(svc.includes("if (inflight && !isReprint) return inflight"));
  assert.ok(svc.includes("isReprint: true"));
  assert.ok(!svc.includes('language: "TSPL"'));
  const grn = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(grn.includes("requirePrinterCode(body.printerCode, LABEL_PURPOSE_GRN)"));
  const packing = fs.readFileSync(path.join(backendRoot, "src/services/label/packingLabelService.js"), "utf8");
  assert.ok(packing.includes("requirePrinterCode(body.printerCode, LABEL_PURPOSE_PACKING)"));
});

run("Old agents cannot lease ZPL jobs", () => {
  const queue = fs.readFileSync(path.join(backendRoot, "src/services/label/printQueue.js"), "utf8");
  assert.ok(queue.includes("agentSupportsZpl"));
  assert.ok(queue.includes('language: "TSPL"'));
  assert.ok(queue.includes("blockedWindowsPrinterNames") || queue.includes("$nin"));
});

run("Frontend requires explicit printer and purpose-filters printers", () => {
  const store = fs.readFileSync(path.join(backendRoot, "../src/pages/StoreModule.jsx"), "utf8");
  const packing = fs.readFileSync(
    path.join(backendRoot, "../src/components/store/PackingLabelsModal.jsx"),
    "utf8"
  );
  const asn = fs.readFileSync(
    path.join(backendRoot, "../src/components/store/AsnReceivingLabelPlanner.jsx"),
    "utf8"
  );
  const banner = fs.readFileSync(
    path.join(backendRoot, "../src/components/store/LabelPrintDestinationBanner.jsx"),
    "utf8"
  );
  const routing = fs.readFileSync(path.join(backendRoot, "../src/lib/labelPrinterRouting.js"), "utf8");
  assert.ok(store.includes("LabelPrintDestinationBanner"));
  assert.ok(store.includes("Zebra"));
  assert.ok(store.includes("Select printer"));
  assert.ok(!store.includes("Auto-route (do not use if this would send STORE jobs)"));
  assert.ok(packing.includes("100×150"));
  assert.ok(packing.includes("Select printer"));
  assert.ok(!packing.includes("<option value=\"\">Auto-route</option>"));
  assert.ok(asn.includes("Select printer"));
  assert.ok(!asn.includes("Default warehouse printer (TSPL / RU identity)"));
  assert.ok(banner.includes("Laptop / agent"));
  assert.ok(banner.includes("Label size"));
  assert.ok(routing.includes("Select a printer"));
  assert.ok(!routing.includes("Auto-route (warehouse/company default)"));
});

run("Setup script includes ASN purpose and deactivate rollback, not empty purposes", () => {
  const setup = fs.readFileSync(
    path.join(backendRoot, "scripts/registerDeepakZebraPrinter.mjs"),
    "utf8"
  );
  assert.ok(setup.includes('"ASN"'));
  assert.ok(setup.includes("Deactivate ZEBRA-DEEPAK-GRN"));
  assert.ok(setup.includes("empty means unrestricted"));
  assert.ok(setup.includes("physical"));
  assert.ok(!setup.includes("clear Zebra supportedPurposes to disable"));
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
