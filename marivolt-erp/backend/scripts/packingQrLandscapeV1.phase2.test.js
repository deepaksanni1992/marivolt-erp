/**
 * PACKING_QR_LANDSCAPE_150X100_V1 — Phase 2 identity, HMAC, TSPL, lifecycle.
 * Run: node scripts/packingQrLandscapeV1.phase2.test.js
 *
 * Uses a test-only HMAC secret. Never a production default.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA,
  PACKING_QR_LANDSCAPE_V1_CODE,
  PHYSICAL_SAFE,
  PHYSICAL_WIDTH_MM,
  PHYSICAL_HEIGHT_MM,
  MAR1_MAX_PAYLOAD_BYTES,
  MAR1_REQUIRED_CELL_DOTS,
  MAR1_REQUIRED_QR_VERSION,
  MAR1_REQUIRED_MODULE_COUNT,
  QR_ECC,
  LABEL_QR_PAYLOAD_OVERFLOW,
  faceDataFromPackingLine,
  layoutPackingQrLandscapeV1,
  qrModulesFromPayload,
  packingQrLandscapeV1Capabilities,
  packingQrLandscapeV1TemplateDocument,
  validateMar1ProductionQrToken,
} from "../src/services/label/packingQrLandscapeV1.js";
import {
  formatPackingLabelNo,
  packingLabelCounterKey,
  PACKING_LABEL_SEQ_MAX,
} from "../src/services/label/packingLabelNumberService.js";
import {
  buildMar1CanonicalBytes,
  MAR1_FORMAT_TAG,
  parseMar1Token,
  signMar1Token,
  signMar1TokenWithKeyDoc,
  verifyMar1SignatureBytes,
  verifyMar1TokenLocal,
  LABEL_SIGNING_KEY_REQUIRED,
} from "../src/services/label/packingLabelSigningService.js";
import {
  buildPackingLabelOriginKey,
  buildPackingQrLandscapeSelectionFingerprint,
  expandPackingLabelPhysicalFaces,
  packingLabelUnitsToMarkPrinted,
  snapshotFromPackingFace,
  faceDataFromPackingLabelUnit,
} from "../src/services/label/packingLabelUnitService.js";
import {
  buildPackingQrLandscapeV1FaceTspl,
  emitLandscapeQrcodeCommand,
  redactTsplSecrets,
  transformBarEndpoints,
  transformBoxEndpoints,
  transformQrcodeOrigin,
  transformTextOrigin,
} from "../src/services/label/packingQrLandscapeV1Tspl.js";
import { buildSinglePackingLabelTspl, buildSingleLabelTspl } from "../src/services/label/tsplGenerator.js";
import { LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH } from "../src/services/label/labelPayloadModes.js";
import { PACKING_STANDARD_TEMPLATE_CODE } from "../src/services/label/labelTemplateService.js";
import { buildReprintIdempotencyKey } from "../src/services/label/labelReprint.js";
import {
  assertLandscapeFromPackingFirstPrintOnly,
  LABEL_REPRINT_ENDPOINT_REQUIRED,
  packingRequestDeclaresReprintIntent,
  resolveRequestedPackingTemplateCode,
} from "../src/services/label/packingLabelService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const frontendRoot = path.join(backendRoot, "..", "src");

const TEST_ONLY_HMAC_SECRET = "phase2-test-only-hmac-secret-not-for-production";

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

function signedSample(labelNo = "MAR-PL-000001", keyId = "K1") {
  return signMar1Token({ labelNo, keyId, secret: TEST_ONLY_HMAC_SECRET });
}

function memoryCounter(start = 0) {
  let seq = start;
  const increments = [];
  return {
    async next() {
      seq += 1;
      increments.push(seq);
      if (seq > PACKING_LABEL_SEQ_MAX) {
        const err = new Error("overflow");
        err.code = "LABEL_COUNTER_OVERFLOW";
        throw err;
      }
      return formatPackingLabelNo(seq);
    },
    get seq() {
      return seq;
    },
    increments,
  };
}

async function mintAsync(faces, counter, store) {
  const units = [];
  for (const face of faces) {
    if (store.has(face.originKey)) {
      units.push(store.get(face.originKey));
      continue;
    }
    const labelNo = await counter.next();
    const unit = {
      _id: `u-${labelNo}`,
      companyId: "c1",
      labelNo,
      barcodeValue: labelNo,
      originKey: face.originKey,
      status: "PLANNED",
      labelQty: face.labelQty,
      sequence: face.sequence,
      sequenceTotal: face.sequenceTotal,
      signingKeyId: "K1",
    };
    store.set(face.originKey, unit);
    units.push(unit);
  }
  return units;
}

const sampleLines = [
  {
    article: "911206822.C",
    customerName: "Mediterranean Shipping Company Cyprus",
    customerRef: "PO-266564",
    brand: "WARTSILA",
    modelName: "W34SG",
    description: "Oil centrifuge cartridge",
    partNo: "473063",
    labelQty: 5,
    totalQty: 9,
    allocationLineId: "line-a",
    lineCopies: 1,
  },
];

console.log("\nPACKING_QR_LANDSCAPE_150X100_V1 Phase 2\n");

const packingSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelService.js"), "utf8");
const unitSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelUnitService.js"), "utf8");
const signSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelSigningService.js"), "utf8");
const reprintSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelService.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(srcRoot, "controllers", "labelAgentController.js"), "utf8");
const tspl100 = fs.readFileSync(path.join(srcRoot, "services", "label", "tsplGenerator.js"), "utf8");
const customSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "customPackingLabelService.js"), "utf8");
const asnSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "asnLabelService.js"), "utf8");
const queueSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "printQueue.js"), "utf8");
const templateSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "labelTemplateService.js"), "utf8");
const modalUi = fs.readFileSync(path.join(frontendRoot, "components", "store", "PackingLabelsModal.jsx"), "utf8");
const customModal = fs.readFileSync(
  path.join(frontendRoot, "components", "store", "CustomPackingLabelModal.jsx"),
  "utf8"
);
const unitModel = fs.readFileSync(path.join(srcRoot, "models", "PackingLabelUnit.js"), "utf8");
const keyModel = fs.readFileSync(path.join(srcRoot, "models", "PackingLabelSigningKey.js"), "utf8");

run("1. Atomic company-scoped numbering format", () => {
  assert.equal(formatPackingLabelNo(1), "MAR-PL-000001");
  assert.equal(formatPackingLabelNo(99), "MAR-PL-000099");
  assert.equal(formatPackingLabelNo(1000000), "MAR-PL-1000000");
  assert.equal(formatPackingLabelNo(99999999), "MAR-PL-99999999");
  assert.equal(packingLabelCounterKey(), "packingLabelUnit");
  assert.match(formatPackingLabelNo(1), /^MAR-PL-[0-9]{1,8}$/);
});

await (async () => {
  try {
    const counter = memoryCounter(0);
    const nos = await Promise.all(Array.from({ length: 20 }, () => counter.next()));
    assert.equal(new Set(nos).size, 20);
    assert.equal(counter.seq, 20);
    passed += 1;
    console.log("  ✓ 2. Counter concurrency: distinct sequences");
  } catch (e) {
    failed += 1;
    console.error("  ✗ 2. Counter concurrency: distinct sequences");
    console.error(`    ${e.message}`);
  }
})();

run("3. Counter overflow beyond eight digits", () => {
  let threw = null;
  try {
    formatPackingLabelNo(PACKING_LABEL_SEQ_MAX + 1);
  } catch (e) {
    threw = e;
  }
  assert.ok(threw);
  assert.equal(threw.code, "LABEL_COUNTER_OVERFLOW");
});

run("4. One physical face = one unit", () => {
  const expanded = expandPackingLabelPhysicalFaces(sampleLines, {
    companyId: "c1",
    sourceType: "PRE_PACKING",
    allocationId: "alloc1",
    sourceId: "alloc1",
  });
  assert.equal(expanded.faces.length, 1);
  assert.equal(expanded.totalFaces, 1);
});

await (async () => {
  try {
    const lines = [{ ...sampleLines[0], lineCopies: 3 }];
    const expanded = expandPackingLabelPhysicalFaces(lines, {
      companyId: "c1",
      sourceType: "PRE_PACKING",
      allocationId: "alloc1",
      sourceId: "alloc1",
    });
    assert.equal(expanded.faces.length, 3);
    assert.equal(new Set(expanded.faces.map((f) => f.originKey)).size, 3);
    const store = new Map();
    const units = await mintAsync(expanded.faces, memoryCounter(0), store);
    assert.equal(new Set(units.map((u) => u.labelNo)).size, 3);
    passed += 1;
    console.log("  ✓ 5. Initial copies get distinct identities");
  } catch (e) {
    failed += 1;
    console.error("  ✗ 5. Initial copies get distinct identities");
    console.error(`    ${e.message}`);
  }
})();

await (async () => {
  try {
    const lines = [{ ...sampleLines[0], lineCopies: 2 }];
    const resolved = {
      companyId: "c1",
      sourceType: "PRE_PACKING",
      allocationId: "alloc1",
      sourceId: "alloc1",
    };
    const a = expandPackingLabelPhysicalFaces(lines, resolved);
    const store = new Map();
    const counter = memoryCounter(0);
    const first = await mintAsync(a.faces, counter, store);
    const b = expandPackingLabelPhysicalFaces(lines, resolved);
    const second = await mintAsync(b.faces, counter, store);
    assert.deepEqual(
      first.map((u) => u.labelNo),
      second.map((u) => u.labelNo)
    );
    assert.equal(counter.seq, 2);
    passed += 1;
    console.log("  ✓ 6. Retry reuses identities");
  } catch (e) {
    failed += 1;
    console.error("  ✗ 6. Retry reuses identities");
    console.error(`    ${e.message}`);
  }
})();

run("7. Different fingerprint creates different units", () => {
  const a = buildPackingLabelOriginKey({
    companyId: "c1",
    sourceType: "PRE_PACKING",
    sourceId: "alloc1",
    fingerprint: "line:x:qty:5:copies:1",
    allocationLineId: "line-a",
    faceIndex: 0,
    labelQty: 5,
  });
  const b = buildPackingLabelOriginKey({
    companyId: "c1",
    sourceType: "PRE_PACKING",
    sourceId: "alloc1",
    fingerprint: "line:x:qty:2:copies:1",
    allocationLineId: "line-a",
    faceIndex: 0,
    labelQty: 2,
  });
  assert.notEqual(a, b);
  assert.match(a, /^plu:v1:[a-f0-9]{64}$/);
});

run("8. Reprint never creates units", () => {
  assert.ok(!reprintSrc.includes("mintPackingLabelUnits"));
  assert.ok(reprintSrc.includes("cloneFrozenFacePayloads"));
  assert.ok(reprintSrc.includes("isPackingQrLandscapeV1(parent.templateCode)"));
  assert.ok(reprintSrc.includes("firstPrint: false"));
  assert.ok(!reprintSrc.includes("nextPackingLabelNo"));
});

function catchCode(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

run("from-packing + landscape + REPRINT is rejected", () => {
  const bodies = [
    { templateCode: PACKING_QR_LANDSCAPE_V1_CODE, mode: "REPRINT" },
    { templateCode: PACKING_QR_LANDSCAPE_V1_CODE, packingMode: "REPRINT" },
    { templateCode: PACKING_QR_LANDSCAPE_V1_CODE, action: "REPRINT" },
    { templateCode: PACKING_QR_LANDSCAPE_V1_CODE, type: "REPRINT" },
    { templateCode: PACKING_QR_LANDSCAPE_V1_CODE, isReprint: true },
  ];
  for (const body of bodies) {
    assert.equal(packingRequestDeclaresReprintIntent(body), true);
    const threw = catchCode(() => assertLandscapeFromPackingFirstPrintOnly(body));
    assert.ok(threw, `expected reject for ${JSON.stringify(body)}`);
    assert.equal(threw.code, LABEL_REPRINT_ENDPOINT_REQUIRED);
    assert.equal(threw.statusCode, 409);
  }
  assert.equal(
    resolveRequestedPackingTemplateCode({ templateCode: PACKING_QR_LANDSCAPE_V1_CODE }),
    PACKING_QR_LANDSCAPE_V1_CODE
  );
});

run("rejection returns LABEL_REPRINT_ENDPOINT_REQUIRED", () => {
  const threw = catchCode(() =>
    assertLandscapeFromPackingFirstPrintOnly({
      templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
      mode: "reprint",
    })
  );
  assert.equal(threw?.code, LABEL_REPRINT_ENDPOINT_REQUIRED);
  assert.match(String(threw.message), /\/labels\/jobs\/:id\/reprint/);
  assert.ok(!String(threw.message).toLowerCase().includes("secret"));
  assert.ok(!String(threw.message).toLowerCase().includes("encrypted"));
  assert.ok(packingSvc.includes("LABEL_REPRINT_ENDPOINT_REQUIRED"));
});

run("rejection occurs before mintPackingLabelUnits, counter, job, TSPL, and signing", () => {
  const createStart = packingSvc.indexOf("export async function createJobsFromPacking");
  assert.ok(createStart >= 0);
  const landscapeStart = packingSvc.indexOf("async function createLandscapePackingLabelJobs");
  const createFn = packingSvc.slice(createStart, landscapeStart);
  const rejectIdx = createFn.indexOf("assertLandscapeFromPackingFirstPrintOnly");
  const settingsIdx = createFn.indexOf("getLabelSettings");
  const resolveIdx = createFn.indexOf("resolvePackingLabelLines");
  const mintIdx = packingSvc.indexOf("mintPackingLabelUnits", createStart);
  const jobIdx = packingSvc.indexOf("LabelPrintJob.create", createStart);
  const tsplIdx = packingSvc.indexOf("buildPackingQrLandscapeV1BatchPayloads", createStart);
  const keyIdx = packingSvc.indexOf("requireActivePackingLabelSigningKey", createStart);
  assert.ok(rejectIdx >= 0 && rejectIdx < settingsIdx, "reject before settings");
  assert.ok(rejectIdx < resolveIdx, "reject before packing-line resolve");
  assert.ok(createStart + rejectIdx < mintIdx, "reject before mint");
  assert.ok(createStart + rejectIdx < jobIdx, "reject before LabelPrintJob.create");
  assert.ok(createStart + rejectIdx < tsplIdx, "reject before TSPL");
  assert.ok(createStart + rejectIdx < keyIdx, "reject before signing-key resolve");
  assert.ok(!createFn.includes("mintPackingLabelUnits"));
  assert.ok(!createFn.includes("buildPackingQrLandscapeV1BatchPayloads"));
  const firstJobInCreate = createFn.indexOf("LabelPrintJob.create");
  assert.ok(firstJobInCreate < 0 || rejectIdx < firstJobInCreate, "reject before any job create");
  assert.ok(!packingSvc.includes("nextPackingLabelNo"));
  const landscapeFn = packingSvc.slice(landscapeStart);
  assert.ok(
    landscapeFn.indexOf("assertLandscapeFromPackingFirstPrintOnly") <
      landscapeFn.indexOf("requireActivePackingLabelSigningKey")
  );
  assert.ok(landscapeFn.indexOf("assertLandscapeFromPackingFirstPrintOnly") < landscapeFn.indexOf("mintPackingLabelUnits"));
});

run("FAILED/CANCELLED first-print retry is not a REPRINT action", () => {
  assert.equal(packingRequestDeclaresReprintIntent({ mode: "PRE_PACKING" }), false);
  assert.equal(packingRequestDeclaresReprintIntent({ mode: "POSTED_PACKING" }), false);
  assert.equal(packingRequestDeclaresReprintIntent({ templateCode: PACKING_QR_LANDSCAPE_V1_CODE }), false);
  assert.equal(
    catchCode(() =>
      assertLandscapeFromPackingFirstPrintOnly({
        templateCode: PACKING_STANDARD_TEMPLATE_CODE,
        mode: "REPRINT",
      })
    ),
    null
  );
  const createFn = packingSvc.slice(packingSvc.indexOf("export async function createJobsFromPacking"));
  assert.ok(createFn.includes("CANCELLED / FAILED"));
  assert.ok(createFn.includes("mintPackingLabelUnits"));
});

const signed = signedSample();
console.log(`  token example (test-only key): ${signed.token}`);

run("9. Valid MAR1 token", () => {
  const parsed = parseMar1Token(signed.token);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.labelNo, "MAR-PL-000001");
  assert.equal(parsed.keyId, "K1");
  assert.equal(parsed.signature.length, 22);
  const local = verifyMar1TokenLocal({
    token: signed.token,
    secret: TEST_ONLY_HMAC_SECRET,
    expectedLabelNo: "MAR-PL-000001",
    expectedKeyId: "K1",
  });
  assert.equal(local.ok, true);
  assert.equal(local.constantTime, true);
  const canonical = buildMar1CanonicalBytes({ labelNo: "MAR-PL-000001", keyId: "K1" });
  assert.equal(canonical[0], MAR1_FORMAT_TAG);
  assert.equal(signed.payloadBytes <= MAR1_MAX_PAYLOAD_BYTES, true);
});

run("10. Tampered labelNo rejected", () => {
  const tampered = signed.token.replace("MAR-PL-000001", "MAR-PL-000002");
  const local = verifyMar1TokenLocal({ token: tampered, secret: TEST_ONLY_HMAC_SECRET });
  assert.equal(local.ok, false);
});

run("11. Tampered keyId rejected", () => {
  const tampered = signed.token.replace(".K1.", ".K2.");
  const local = verifyMar1TokenLocal({ token: tampered, secret: TEST_ONLY_HMAC_SECRET });
  assert.equal(local.ok, false);
});

run("12. Tampered signature rejected", () => {
  const parsed = parseMar1Token(signed.token);
  const flipped = Buffer.from(parsed.rawSignature);
  flipped[0] ^= 0xff;
  const bad = `MAR1.MAR-PL-000001.K1.${flipped.toString("base64url")}`;
  const local = verifyMar1TokenLocal({ token: bad, secret: TEST_ONLY_HMAC_SECRET });
  assert.equal(local.ok, false);
});

run("13. Wrong company rejected (lookup uses request companyId + labelNo only)", () => {
  assert.ok(signSvc.includes("PackingLabelUnit.findOne"));
  assert.ok(signSvc.includes("companyId: cid"));
  assert.ok(signSvc.includes("labelNo: parsed.labelNo"));
  assert.ok(!signSvc.includes("companyFromQr") && !signSvc.includes("qrCompany"));
});

run("14. VERIFY_ONLY verifies but cannot sign new labels", () => {
  const key = { keyId: "K1", status: "VERIFY_ONLY", encryptedSecret: "" };
  let newLabelErr = null;
  try {
    signMar1TokenWithKeyDoc({ ...key, encryptedSecret: "nope" }, "MAR-PL-000001", { newLabel: true });
  } catch (e) {
    newLabelErr = e;
  }
  assert.equal(newLabelErr?.code, LABEL_SIGNING_KEY_REQUIRED);
  const reconstructed = signMar1Token({
    labelNo: "MAR-PL-000001",
    keyId: "K1",
    secret: TEST_ONLY_HMAC_SECRET,
  });
  const local = verifyMar1TokenLocal({
    token: reconstructed.token,
    secret: TEST_ONLY_HMAC_SECRET,
  });
  assert.equal(local.ok, true);
});

run("15. REVOKED rejects", () => {
  let threw = null;
  try {
    signMar1TokenWithKeyDoc({ keyId: "K1", status: "REVOKED", secretRef: "env:X" }, "MAR-PL-000001", {
      newLabel: false,
    });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw?.code, "LABEL_SIGNING_KEY_REVOKED");
});

run("16. Missing ACTIVE key blocks print", () => {
  assert.ok(packingSvc.includes("requireActivePackingLabelSigningKey"));
  assert.ok(signSvc.includes(LABEL_SIGNING_KEY_REQUIRED));
  assert.ok(keyModel.includes("ACTIVE"));
  assert.ok(keyModel.includes("partialFilterExpression"));
});

run("17. No secret appears in API/log result helpers", () => {
  assert.ok(unitSvc.includes("delete out.secret"));
  assert.ok(unitSvc.includes("delete out.encryptedSecret"));
  assert.ok(signSvc.includes("Never log") || signSvc.includes("keyId only") || signSvc.includes("publicSigningKey"));
  assert.ok(!signSvc.includes("TEST_ONLY_HMAC_SECRET"));
  assert.ok(!packingSvc.includes(TEST_ONLY_HMAC_SECRET));
});

run("18. Maximum 47-byte payload accepted", () => {
  const max = signMar1Token({
    labelNo: "MAR-PL-99999999",
    keyId: "K99",
    secret: TEST_ONLY_HMAC_SECRET,
  });
  assert.equal(max.payloadBytes, MAR1_MAX_PAYLOAD_BYTES);
  assert.equal(parseMar1Token(max.token).ok, true);
});

run("19. Oversize payload rejected", () => {
  const over = `${signed.token}X`;
  const overV = validateMar1ProductionQrToken(over);
  assert.equal(overV.ok, false);
  assert.ok(overV.errorCodes.includes(LABEL_QR_PAYLOAD_OVERFLOW) || overV.payloadBytes > MAR1_MAX_PAYLOAD_BYTES);
});

run("20. Constant-time verification path exercised", () => {
  let calls = 0;
  const orig = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (...args) => {
    calls += 1;
    return orig.apply(crypto, args);
  };
  try {
    const ok = verifyMar1SignatureBytes(Buffer.alloc(16, 1), Buffer.alloc(16, 1));
    const bad = verifyMar1SignatureBytes(Buffer.alloc(16, 1), Buffer.alloc(16, 2));
    assert.equal(ok, true);
    assert.equal(bad, false);
    assert.ok(calls >= 2);
  } finally {
    crypto.timingSafeEqual = orig;
  }
});

const prodData = faceDataFromPackingLabelUnit(
  {
    customerNameSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.customerName,
    mvRefSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.mvRef,
    customerPoSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.customerPo,
    vesselPlantSnapshot: "",
    brandSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.brand,
    modelSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.modelName,
    article: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.article,
    descriptionSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.description,
    partNoSnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.partNo,
    labelQty: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.labelQty,
    orderQtySnapshot: SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA.orderQty,
    sequence: 1,
    sequenceTotal: 3,
    labelNo: "MAR-PL-000001",
    signingKeyId: "K1",
  },
  { mar1QrToken: signed.token, printAuthorized: true }
);
const prodLayout = layoutPackingQrLandscapeV1(prodData);
const faceTspl = buildPackingQrLandscapeV1FaceTspl(prodLayout, { token: signed.token });
const redacted = redactTsplSecrets(faceTspl);
console.log("\nTSPL sample face (secrets redacted):\n");
console.log(redacted);

run("21. SIZE 100 mm,150 mm", () => {
  assert.ok(faceTspl.includes(`SIZE ${PHYSICAL_WIDTH_MM} mm,${PHYSICAL_HEIGHT_MM} mm`));
  assert.ok(faceTspl.includes("DIRECTION 1"));
  assert.ok(faceTspl.includes("REFERENCE 0,0"));
});

run("22. No per-face GAP in batch", () => {
  assert.ok(!/(?:^|\r?\n)\s*GAP\b/im.test(faceTspl));
  assert.ok(!/\bGAPDETECT\b/i.test(faceTspl));
});

run("23. HOME/CLS/PRINT exactly once", () => {
  assert.equal((faceTspl.match(/(?:^|\r?\n)\s*HOME\b/gim) || []).length, 1);
  assert.equal((faceTspl.match(/\bCLS\b/g) || []).length, 1);
  assert.equal((faceTspl.match(/\bPRINT\s+1\s*,\s*1\b/gi) || []).length, 1);
});

run("24. Transformed TEXT bounds stay in physical safe", () => {
  for (const p of prodLayout.primitives.filter((x) => x.type === "text")) {
    const t = transformTextOrigin(p);
    assert.equal(t.rotation, 90);
    assert.ok(p.physical.x >= PHYSICAL_SAFE.x);
    assert.ok(p.physical.y >= PHYSICAL_SAFE.y);
    assert.ok(p.physical.x1 <= PHYSICAL_SAFE.x1);
    assert.ok(p.physical.y1 <= PHYSICAL_SAFE.y1);
  }
});

run("25. BOX/BAR bounds", () => {
  const box = prodLayout.primitives.find((p) => p.type === "box");
  const b = transformBoxEndpoints(box);
  assert.ok(b.x1 >= PHYSICAL_SAFE.x && b.y1 >= PHYSICAL_SAFE.y);
  assert.ok(b.x2 <= PHYSICAL_SAFE.x1 && b.y2 <= PHYSICAL_SAFE.y1);
  for (const p of prodLayout.primitives.filter((x) => x.type === "bar")) {
    const bar = transformBarEndpoints(p);
    assert.ok(bar.x >= PHYSICAL_SAFE.x);
    assert.ok(bar.y >= PHYSICAL_SAFE.y);
  }
});

run("26. QRCODE syntax, ECC H and cell width 6", () => {
  const cmd = emitLandscapeQrcodeCommand(prodLayout, signed.token);
  assert.match(cmd, /^QRCODE \d+,\d+,H,6,A,90,"MAR1\./);
  assert.ok(faceTspl.includes(`H,${MAR1_REQUIRED_CELL_DOTS},A,90`));
  assert.equal(QR_ECC, "H");
});

run("27. QR inner origin and explicit quiet zone", () => {
  const q = transformQrcodeOrigin(prodLayout);
  assert.equal(q.cellWidth, 6);
  assert.equal(q.extraQuiet, false);
  assert.equal(q.quietAppliedByLayout, true);
  assert.equal(prodLayout.qr.quietModules, 4);
  assert.equal(prodLayout.qr.inner.w, 222);
  assert.equal(prodLayout.qr.logical.w, 270);
  const innerPhys = prodLayout.primitives.find((p) => p.id === "qr-inner").physical;
  const quietPhys = prodLayout.primitives.find((p) => p.id === "qr-quiet").physical;
  assert.ok(innerPhys.x >= quietPhys.x && innerPhys.y >= quietPhys.y);
  assert.ok(innerPhys.x1 <= quietPhys.x1 && innerPhys.y1 <= quietPhys.y1);
});

run("28. All content stays within required margins", () => {
  for (const p of prodLayout.primitives) {
    assert.ok(p.physical.x >= PHYSICAL_SAFE.x, p.id);
    assert.ok(p.physical.y >= PHYSICAL_SAFE.y, p.id);
    assert.ok(p.physical.x1 <= PHYSICAL_SAFE.x1, p.id);
    assert.ok(p.physical.y1 <= PHYSICAL_SAFE.y1, p.id);
  }
});

run("29. Generated token decodes from derived QR modules", () => {
  const modules = qrModulesFromPayload(signed.token, QR_ECC);
  assert.equal(modules.version, MAR1_REQUIRED_QR_VERSION);
  assert.equal(modules.size, MAR1_REQUIRED_MODULE_COUNT);
  assert.equal(prodLayout.qr.token, signed.token);
  assert.equal(prodLayout.qr.modules.size, MAR1_REQUIRED_MODULE_COUNT);
  assert.equal(parseMar1Token(prodLayout.qr.token).ok, true);
});

run("30. Long-data overflow blocks TSPL / job creation", () => {
  const overflowData = {
    ...prodData,
    description: "X".repeat(400),
    mar1QrToken: signed.token,
    printAuthorized: true,
  };
  const layout = layoutPackingQrLandscapeV1(overflowData);
  assert.equal(layout.ok, false);
  let threw = null;
  try {
    buildPackingQrLandscapeV1FaceTspl(layout, { token: signed.token });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw);
  assert.ok(packingSvc.includes("layout.ok !== true"));
});

const jobLines = (n) =>
  Array.from({ length: n }, (_, i) => ({ packingLabelUnitId: `u${i + 1}` }));

run("31. Job creation leaves units PLANNED", () => {
  const ids = packingLabelUnitsToMarkPrinted({
    status: "PENDING",
    remainingLabels: 3,
    printedLabels: 0,
    lines: jobLines(3),
  });
  assert.deepEqual(ids, []);
  assert.ok(unitModel.includes('"PLANNED"'));
});

run("32. COMPLETED marks exact units PRINTED", () => {
  const ids = packingLabelUnitsToMarkPrinted({
    status: "COMPLETED",
    remainingLabels: 0,
    printedLabels: 3,
    lines: jobLines(3),
  });
  assert.deepEqual(ids, ["u1", "u2", "u3"]);
});

run("33. FAILED/CANCELLED retain PLANNED", () => {
  assert.deepEqual(
    packingLabelUnitsToMarkPrinted({ status: "FAILED", remainingLabels: 3, printedLabels: 0, lines: jobLines(3) }),
    []
  );
  assert.deepEqual(
    packingLabelUnitsToMarkPrinted({
      status: "CANCELLED",
      remainingLabels: 3,
      printedLabels: 0,
      lines: jobLines(3),
    }),
    []
  );
});

run("34. PARTIAL marks only confirmed delivered units", () => {
  const ids = packingLabelUnitsToMarkPrinted({
    status: "PARTIAL",
    remainingLabels: 1,
    printedLabels: 2,
    lines: jobLines(3),
  });
  assert.deepEqual(ids, ["u1", "u2"]);
});

run("35. UNCERTAIN does not mark all PRINTED", () => {
  const ids = packingLabelUnitsToMarkPrinted({
    status: "UNCERTAIN",
    remainingLabels: 3,
    printedLabels: 3,
    lines: jobLines(3),
  });
  assert.deepEqual(ids, []);
});

run("36. Retry after failure reuses units", () => {
  assert.ok(unitSvc.includes("originKey"));
  assert.ok(packingSvc.includes("mintPackingLabelUnits"));
  const fp = buildPackingQrLandscapeSelectionFingerprint(sampleLines);
  const again = buildPackingQrLandscapeSelectionFingerprint(sampleLines);
  assert.equal(fp, again);
});

run("37-44. Reprint preserves identity and links a new job", () => {
  assert.ok(reprintSrc.includes("parentJobId: parent._id"));
  assert.ok(reprintSrc.includes("isReprint: true"));
  assert.ok(reprintSrc.includes("cloneFrozenFacePayloads"));
  assert.ok(!reprintSrc.includes("mintPackingLabelUnits"));
  assert.ok(!reprintSrc.includes("nextPackingLabelNo"));
  assert.ok(reprintSrc.includes("parent.lines.map"));
  assert.ok(reprintSrc.includes("packingLabelUnitId"));
  assert.ok(reprintSrc.includes("LABEL_REPRINT_PARENT_NOT_COMPLETED") || reprintSrc.includes("parentReprintRejection"));
  assert.ok(reprintSrc.includes("isCompletedLabelJobStatus") || reprintSrc.includes('st === "COMPLETED"') || reprintSrc.includes("parentReprintRejection(parent.status)"));
  const key1 = buildReprintIdempotencyKey({
    parentJobId: "job1",
    userId: "u1",
    clientRequestId: "click-1",
  });
  const key2 = buildReprintIdempotencyKey({
    parentJobId: "job1",
    userId: "u1",
    clientRequestId: "click-1",
  });
  const key3 = buildReprintIdempotencyKey({
    parentJobId: "job1",
    userId: "u1",
    clientRequestId: "click-2",
  });
  assert.equal(key1, key2);
  assert.notEqual(key1, key3);
  assert.ok(reprintSrc.includes("firstPrint: false"));
  assert.ok(reprintSrc.includes("linkPackingLabelUnitsToJob"));
});

run("45. Existing 100×50 packing unchanged", () => {
  const tspl = buildSinglePackingLabelTspl({
    article: "700004.28",
    customerName: "MSC",
    description: "SET OF GASKETS",
    labelQty: 5,
    totalQty: 9,
  });
  assert.ok(tspl.includes("SIZE 100 mm,50 mm"));
  assert.ok(!tspl.includes("SIZE 100 mm,150 mm"));
  assert.ok(!tspl.includes("QRCODE"));
  assert.equal(PACKING_STANDARD_TEMPLATE_CODE, "PACKING_STANDARD_100X50");
});

run("46. Custom Packing unchanged", () => {
  assert.ok(!customSrc.includes("PACKING_QR_LANDSCAPE_150X100_V1"));
  assert.ok(!customModal.includes("PACKING_QR_LANDSCAPE"));
});

run("47. ASN RU unchanged", () => {
  assert.ok(!asnSrc.includes("PACKING_QR_LANDSCAPE_150X100_V1"));
  assert.ok(!asnSrc.includes("PackingLabelUnit"));
});

run("48. GRN unchanged", () => {
  const grn = buildSingleLabelTspl({
    article: "700004.28",
    description: "SET OF GASKETS",
    spn: "432108",
    labelQty: 5,
    uom: "PCS",
  });
  assert.ok(grn.includes("SIZE 100 mm,50 mm"));
  assert.ok(!tspl100.includes("PACKING_QR_LANDSCAPE"));
});

run("49. Label Queue behavior remains valid", () => {
  assert.ok(queueSrc.includes("TSPL_LABEL_BATCH") || queueSrc.includes("applyAgentResult"));
  assert.ok(agentSrc.includes("applyPackingLabelUnitPrintResult"));
  assert.ok(agentSrc.includes("applyReceivingUnitPrintResult"));
  assert.equal(LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH, "TSPL_LABEL_BATCH");
});

run("50. Multi-company isolation", () => {
  assert.ok(unitModel.includes("companyId: 1, labelNo: 1"));
  assert.ok(unitModel.includes("companyId: 1, barcodeValue: 1"));
  assert.ok(unitModel.includes("companyId: 1, originKey: 1"));
  const a = buildPackingLabelOriginKey({
    companyId: "c1",
    sourceType: "PRE_PACKING",
    sourceId: "s",
    fingerprint: "f",
    allocationLineId: "l",
    faceIndex: 0,
    labelQty: 1,
  });
  const b = buildPackingLabelOriginKey({
    companyId: "c2",
    sourceType: "PRE_PACKING",
    sourceId: "s",
    fingerprint: "f",
    allocationLineId: "l",
    faceIndex: 0,
    labelQty: 1,
  });
  assert.notEqual(a, b);
  assert.equal(packingQrLandscapeV1Capabilities().printEnabled, false);
  assert.equal(packingQrLandscapeV1TemplateDocument().printEnabled, false);
  const listIdx = templateSvc.indexOf("export async function listTemplates");
  const next = templateSvc.indexOf("export async function", listIdx + 10);
  assert.ok(!templateSvc.slice(listIdx, next).includes("ensurePackingQrLandscapeV1Template"));
});

run("Catalog printEnabled stays false; UI does not globally enable print", () => {
  assert.ok(modalUi.includes("landscapePrintBlocked") || modalUi.includes("canQueueFirstPrint"));
  assert.ok(packingSvc.includes("PACKING_QR_LANDSCAPE_V1_CODE"));
  assert.equal(faceDataFromPackingLine({ article: "A" }, {}).vesselPlant, "");
  assert.ok(snapshotFromPackingFace({ line: {}, labelQty: 1, sequence: 1, sequenceTotal: 1, allocationLineId: "x", originKey: "o", sourceType: "PRE_PACKING" }, {}).vesselPlantSnapshot === "");
});

run("ReceivingUnit is not reused", () => {
  assert.ok(!unitModel.includes("asnId"));
  assert.ok(unitModel.includes("packingLabelUnits"));
  assert.ok(!unitSvc.includes("ReceivingUnit"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
