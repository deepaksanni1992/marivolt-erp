/**
 * Posted GRN Print / Reprint dialog: explicit printer, Article barcodes, no auto-queue.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildPostedGrnLabelLines,
  buildPostedGrnLabelPrintBody,
  buildPostedGrnPreviewRequest,
  patchPostedGrnLabelLine,
  POSTED_GRN_PRINTER_REQUIRED,
  sumPhysicalLabelQty,
} from "../../src/lib/labelPrinting.js";
import {
  filterPrintersForGrnLabels,
  filterPrintersForPurpose,
  LABEL_PURPOSE_GRN,
  LABEL_PURPOSE_PACKING,
} from "../../src/lib/labelPrinterRouting.js";

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

const zebraFromConfig = {
  _id: "6aa59b0b82287724a827a85b",
  code: "ZEBRA-DEEPAK-GRN",
  displayName: "Deepak Laptop Zebra GRN 100x50",
  agentId: "AGTB3A953D7",
  agentName: "Deepak Laptop",
  windowsPrinterName: "ZDesigner ZD220-203dpi ZPL",
  language: "ZPL",
  widthMm: 100,
  heightMm: 50,
  dpi: 203,
  isActive: true,
  supportedPurposes: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "TEST", "ASN"],
};

const packingRongta = {
  _id: "rongta-pack",
  code: "RONGTA-LAPTOP",
  displayName: "Deepak Rongta",
  agentId: "AGTB3A953D7",
  windowsPrinterName: "RP4xx Series 200DPI TSPL",
  language: "TSPL",
  widthMm: 100,
  heightMm: 150,
  isActive: true,
  supportedPurposes: ["PACKING", "CUSTOM_PACKING"],
};

const storeUnlocked = {
  _id: "store",
  code: "RONGTA1",
  agentId: "AGTSTORE",
  windowsPrinterName: "RP4xx Series 200DPI TSPL",
  language: "TSPL",
  widthMm: 0,
  heightMm: 0,
  isActive: true,
};

const postedAsnGrn = {
  grnNo: "MAR-GRN-0017",
  status: "POSTED",
  sourceType: "ASN_RECEIVING",
  warehouseCode: "MAIN",
  items: [
    {
      poLineId: "pl-1",
      article: "MV-ZEBRA-TEST-001",
      acceptedQty: 10,
      uom: "PCS",
      warehouse: "MAIN",
    },
    {
      poLineId: "pl-2",
      article: "00-ART.01",
      acceptedQty: 5,
      uom: "PCS",
      warehouse: "MAIN",
    },
  ],
};

console.log("Posted GRN labels dialog\n");

run("Compatible GRN dropdown includes configured Zebra and excludes packing 100×150", () => {
  const list = filterPrintersForGrnLabels([zebraFromConfig, packingRongta, storeUnlocked]);
  const codes = list.map((p) => p.code);
  assert.ok(codes.includes("ZEBRA-DEEPAK-GRN"));
  assert.ok(!codes.includes("RONGTA-LAPTOP"));
  assert.ok(codes.includes("RONGTA1"));
  assert.ok(filterPrintersForPurpose([packingRongta], LABEL_PURPOSE_PACKING).length === 1);
  assert.ok(filterPrintersForPurpose([packingRongta], LABEL_PURPOSE_GRN).length === 0);
});

run("Posted GRN lines default to one physical label of full item qty", () => {
  const lines = buildPostedGrnLabelLines(postedAsnGrn);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].receivedQty, 10);
  assert.equal(lines[0].labelCount, 1);
  assert.deepEqual(lines[0].labelDistribution, [10]);
  assert.equal(sumPhysicalLabelQty(lines), 2);
});

run("One selected line and one label is a valid from-grn Article payload", () => {
  const all = buildPostedGrnLabelLines(postedAsnGrn);
  const one = all.map((ln, i) => patchPostedGrnLabelLine(ln, { print: i === 0 }));
  const built = buildPostedGrnLabelPrintBody({
    grn: postedAsnGrn,
    printerCode: "ZEBRA-DEEPAK-GRN",
    copies: 1,
    lines: one,
  });
  assert.equal(built.ok, true);
  assert.equal(built.body.printerCode, "ZEBRA-DEEPAK-GRN");
  assert.equal(built.body.grnNo, "MAR-GRN-0017");
  assert.equal(built.body.lines.length, 1);
  assert.equal(built.body.lines[0].article, "MV-ZEBRA-TEST-001");
  assert.equal(built.body.lines[0].labelCount, 1);
  assert.deepEqual(built.body.lines[0].labelDistribution, [10]);
  assert.equal(built.body.barcodeMode, undefined);
  assert.equal(built.body.faceVariant, undefined);
  assert.ok(!JSON.stringify(built.body).includes("LABEL_ID"));
  assert.ok(!JSON.stringify(built.body).includes("ruNo"));
  assert.equal(built.body.idempotencyKey, undefined);
});

run("Missing printerCode blocks print and preview payloads", () => {
  const lines = buildPostedGrnLabelLines(postedAsnGrn);
  const print = buildPostedGrnLabelPrintBody({ grn: postedAsnGrn, printerCode: "", lines });
  assert.equal(print.ok, false);
  assert.equal(print.error, POSTED_GRN_PRINTER_REQUIRED);
  assert.equal(print.body, null);
  const preview = buildPostedGrnPreviewRequest({ printerCode: "" });
  assert.equal(preview.ok, false);
  assert.equal(preview.body, null);
  const previewOk = buildPostedGrnPreviewRequest({ printerCode: "ZEBRA-DEEPAK-GRN" });
  assert.equal(previewOk.ok, true);
  assert.equal(previewOk.body.printerCode, "ZEBRA-DEEPAK-GRN");
  assert.equal(previewOk.body.purpose, "GRN");
});

run("Store posted-GRN Print/Reprint opens dialog and does not POST immediately", () => {
  const store = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  const dlg = fs.readFileSync(
    path.join(repoRoot, "src/components/store/PostedGrnLabelsDialog.jsx"),
    "utf8"
  );
  assert.ok(store.includes("PostedGrnLabelsDialog"));
  assert.ok(store.includes("setPostedGrnLabelsOpen(true)"));
  assert.ok(!/Print \/ Reprint labels[\s\S]{0,400}apiPost\("\/labels\/jobs\/from-grn"/.test(store));
  assert.match(store, /await apiPost\(`\/labels\/jobs\/\$\{grnRegisterDetail\.labelLastJobId\}\/retry`/);
  assert.ok(dlg.includes('apiPost("/labels/printers/resolve"'));
  assert.ok(dlg.includes('apiPost("/labels/jobs/from-grn"'));
  assert.ok(dlg.includes("filterPrintersForGrnLabels"));
  assert.ok(dlg.includes("LabelPrintDestinationBanner"));
  assert.ok(dlg.includes("Article barcodes"));
  assert.ok(dlg.includes("not RU"));
  assert.ok(!dlg.includes("from-grn-prepost"));
  assert.ok(!dlg.includes("/labels/jobs/from-asn"));
  assert.ok(dlg.includes("{error}"));
  assert.ok(dlg.includes("No. labels"));
  assert.ok(dlg.includes("Item qty"));
});

run("Retry labels path is unchanged and UNCERTAIN is not auto-retried from the popup", () => {
  const store = fs.readFileSync(path.join(repoRoot, "src/pages/StoreModule.jsx"), "utf8");
  assert.ok(store.includes("Retry labels"));
  assert.ok(store.includes('["FAILED", "PARTIAL", "CANCELLED"].includes(grnRegisterDetail.labelStatus)'));
  assert.ok(!store.includes('["FAILED", "PARTIAL", "CANCELLED", "UNCERTAIN"]'));
});

run("Backend from-grn still requires printerCode and ARTICLE mode", () => {
  const svc = fs.readFileSync(path.join(backendRoot, "src/services/label/labelService.js"), "utf8");
  assert.ok(svc.includes("requirePrinterCode(body.printerCode, LABEL_PURPOSE_GRN)"));
  assert.ok(svc.includes('barcodeMode: template?.barcodeMode || "ARTICLE"'));
  assert.ok(svc.includes("createJobsFromGrn"));
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
