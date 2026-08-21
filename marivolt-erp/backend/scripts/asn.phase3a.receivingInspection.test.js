/**
 * ASN Phase 3A — receiving session, scan, drafts, photos, completion.
 * Run: node scripts/asn.phase3a.receivingInspection.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReceivingInspectionError,
  applyReceivingDraftSave,
  applyReceivingSessionComplete,
  applyReceivingUnitComplete,
  assertAsnCancelBlockedByReceiving,
  assertOptimisticVersion,
  assertReceivingActualQty,
  assertReceivingPhotoUpload,
  assertReplanBlockedByReceiving,
  assertUnitCompletable,
  evaluateReceivingScanEligibility,
  groupReceivingProgressByArticle,
  hasReceivingActivity,
  raceStartOrResumeReceivingSessions,
  receivingPhotoSettingsFromEnv,
  resizeToMaxLongEdge,
  sniffReceivingImageMime,
  simulatePhotoDeleteVsCompleteRace,
  swapDimensionsForExifOrientation,
  summarizeReceivingProgress,
  tryStartOrResumeReceivingSession,
  uniqueSessionUnitKey,
  upsertReceivingSessionUnit,
  varianceQty,
} from "../src/utils/receivingInspectionRules.js";
import {
  RECEIVING_INSPECTION_INDEX_SPECS,
  RECEIVING_PHOTO_RETRY_INDEX,
  RECEIVING_SESSION_ACTIVE_INDEX,
  RECEIVING_SESSION_NO_INDEX,
  RECEIVING_SESSION_UNIT_UNIQUE_INDEX,
  RECEIVING_UNIT_BARCODE_INDEX_SPEC,
  evaluateIndexInventory,
  receivingPhotoRetryPartialFilter,
  receivingSessionActivePartialFilter,
} from "../src/utils/receivingInspectionIndexes.js";
import { formatReceivingSessionNumber, receivingSessionCounterKey } from "../src/services/receivingSessionNumberService.js";
import {
  chooseReceivingImageDecodeStrategy,
  readJpegExifOrientation,
  resizeToMaxLongEdge as feResize,
  resolveReceivingPhotoConfig,
  swapDimensionsForExifOrientation as feSwap,
} from "../../src/lib/receivingPhotoGeometry.js";
import { getDefaultPermissionsForRole } from "../src/services/roleService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");
const srcRoot = path.join(backendRoot, "src");
const feRoot = path.join(backendRoot, "..", "src");

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

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function printedRu(overrides = {}) {
  return {
    _id: "ru1",
    ruNo: "MAR-RU-000125",
    barcodeValue: "MAR-RU-000125",
    status: "PRINTED",
    planBatchId: "batch1",
    plannedQty: 25,
    article: "20834",
    uom: "PCS",
    replacementRuNos: [],
    ...overrides,
  };
}

/** Minimal JPEG SOI + APP1 EXIF with Orientation tag. */
function jpegWithOrientation(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt16LE(0, 20);
  tiff.writeUInt32LE(0, 22);
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const app1 = Buffer.alloc(4 + exif.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

console.log("\nASN Phase 3A Receiving Inspection\n");

run("session numbering is company-scoped RCV, not GRN", () => {
  assert.equal(formatReceivingSessionNumber("MAR", 1), "MAR-RCV-000001");
  assert.equal(formatReceivingSessionNumber("OKE", 1), "OKE-RCV-000001");
  assert.equal(receivingSessionCounterKey("MAR"), "rcv:MAR");
  assert.doesNotMatch(formatReceivingSessionNumber("MAR", 1), /GRN/);
});

run("start receiving creates DRAFT session", () => {
  const sessions = [];
  const r = tryStartOrResumeReceivingSession(sessions, {
    companyId: "c1",
    asnId: "a1",
    sessionNo: "MAR-RCV-000001",
    asnNo: "MAR-ASN-0045",
  });
  assert.equal(r.created, true);
  assert.equal(r.session.status, "DRAFT");
});

run("opening the same ASN resumes the active session", () => {
  const sessions = [];
  tryStartOrResumeReceivingSession(sessions, { companyId: "c1", asnId: "a1", sessionNo: "MAR-RCV-000001" });
  const r = tryStartOrResumeReceivingSession(sessions, { companyId: "c1", asnId: "a1", sessionNo: "MAR-RCV-000002" });
  assert.equal(r.resumed, true);
  assert.equal(r.created, false);
  assert.equal(sessions.length, 1);
  assert.equal(r.session.sessionNo, "MAR-RCV-000001");
});

await runAsync("simultaneous session creation yields one session", async () => {
  const { sessions, results } = await raceStartOrResumeReceivingSessions({
    attempts: 8,
    factory: (i) => ({ companyId: "c1", asnId: "a1", sessionNo: `MAR-RCV-${String(i).padStart(6, "0")}` }),
  });
  assert.equal(sessions.length, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results.filter((r) => r.resumed).length, 7);
});

run("cross-company ASN does not resume another company's session", () => {
  const sessions = [];
  tryStartOrResumeReceivingSession(sessions, { companyId: "MAR", asnId: "a1", sessionNo: "MAR-RCV-000001" });
  const r = tryStartOrResumeReceivingSession(sessions, { companyId: "OKE", asnId: "a1", sessionNo: "OKE-RCV-000001" });
  assert.equal(r.created, true);
  assert.equal(sessions.length, 2);
});

run("scan: valid current PRINTED RU may be received", () => {
  const e = evaluateReceivingScanEligibility(printedRu(), { current: true });
  assert.equal(e.canReceive, true);
  assert.equal(e.code, "OK");
});

run("scan: unknown barcode", () => {
  const e = evaluateReceivingScanEligibility(null, { current: false });
  assert.equal(e.canReceive, false);
  assert.equal(e.code, "BARCODE_NOT_FOUND");
  assert.match(e.userMessage, /Barcode not found/i);
});

run("scan: CANCELLED RU blocked", () => {
  const e = evaluateReceivingScanEligibility(printedRu({ status: "CANCELLED" }), { current: false });
  assert.equal(e.canReceive, false);
  assert.equal(e.code, "RU_CANCELLED");
});

run("scan: SUPERSEDED RU returns replacements", () => {
  const e = evaluateReceivingScanEligibility(
    printedRu({ status: "SUPERSEDED", replacementRuNos: ["MAR-RU-000200"] }),
    { current: false }
  );
  assert.equal(e.canReceive, false);
  assert.equal(e.code, "RU_SUPERSEDED");
  assert.match(e.userMessage, /superseded/i);
  assert.deepEqual(e.replacementRuNos, ["MAR-RU-000200"]);
});

run("scan: PLANNED/unprinted RU blocked", () => {
  const e = evaluateReceivingScanEligibility(printedRu({ status: "PLANNED" }), { current: true });
  assert.equal(e.canReceive, false);
  assert.equal(e.code, "RU_NOT_PRINTED");
});

run("scan: same RU eligibility is deterministic", () => {
  const ru = printedRu();
  const a = evaluateReceivingScanEligibility(ru, { current: true });
  const b = evaluateReceivingScanEligibility(ru, { current: true });
  assert.deepEqual(a, b);
});

run("draft create/update qty condition remarks", () => {
  const units = [];
  const { unit } = upsertReceivingSessionUnit(units, {
    companyId: "c1",
    receivingSessionId: "s1",
    receivingUnitId: "ru1",
    ruNo: "MAR-RU-000125",
    plannedQty: 25,
    actor: "store",
  });
  unit.version = 0;
  unit.status = "NOT_STARTED";
  applyReceivingDraftSave(unit, { actualQty: 23, condition: "GOOD", remarks: "2 short", expectedVersion: 0, actor: "store" });
  assert.equal(unit.actualQty, 23);
  assert.equal(unit.condition, "GOOD");
  assert.equal(unit.remarks, "2 short");
  assert.equal(unit.status, "IN_PROGRESS");
  assert.equal(unit.version, 1);
});

run("resume result returns the same unique key", () => {
  const units = [];
  const a = upsertReceivingSessionUnit(units, { companyId: "c1", receivingSessionId: "s1", receivingUnitId: "ru1", ruNo: "X", plannedQty: 1 });
  const b = upsertReceivingSessionUnit(units, { companyId: "c1", receivingSessionId: "s1", receivingUnitId: "ru1", ruNo: "X", plannedQty: 1 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(units.length, 1);
  assert.equal(uniqueSessionUnitKey(a.unit), uniqueSessionUnitKey(b.unit));
});

run("version conflict returns RECEIVING_CONFLICT", () => {
  assert.throws(
    () => assertOptimisticVersion(2, 1),
    (err) => err instanceof ReceivingInspectionError && err.code === "RECEIVING_CONFLICT" && err.status === 409
  );
});

run("actual qty may differ from planned and cannot be negative", () => {
  assert.equal(assertReceivingActualQty(23), 23);
  assert.equal(varianceQty(25, 23), -2);
  assert.throws(() => assertReceivingActualQty(-1), (err) => err.code === "RECEIVING_QTY_NEGATIVE");
  assert.throws(() => assertReceivingActualQty("nope"), (err) => err.code === "RECEIVING_QTY_INVALID");
});

run("photo MIME and size validation", () => {
  assertReceivingPhotoUpload({ mimeType: "image/jpeg", sizeBytes: 120_000, maxBytes: 5_000_000 });
  assert.throws(
    () => assertReceivingPhotoUpload({ mimeType: "application/pdf", sizeBytes: 100, maxBytes: 5_000_000 }),
    (err) => err.code === "RECEIVING_PHOTO_MIME"
  );
  assert.throws(
    () => assertReceivingPhotoUpload({ mimeType: "image/jpeg", sizeBytes: 9_000_000, maxBytes: 5_000_000 }),
    (err) => err.code === "RECEIVING_PHOTO_TOO_LARGE"
  );
});

run("cannot complete without qty, condition, confirmed qty, or photo", () => {
  assert.throws(() => assertUnitCompletable({ actualQty: null, condition: "GOOD", photoCount: 1, qtyConfirmed: true }), (e) => e.code === "RECEIVING_QTY_REQUIRED");
  assert.throws(() => assertUnitCompletable({ actualQty: 25, condition: "", photoCount: 1, qtyConfirmed: true }), (e) => e.code === "RECEIVING_CONDITION_REQUIRED");
  assert.throws(() => assertUnitCompletable({ actualQty: 25, condition: "GOOD", photoCount: 1, qtyConfirmed: false }), (e) => e.code === "RECEIVING_QTY_NOT_CONFIRMED");
  assert.throws(() => assertUnitCompletable({ actualQty: 25, condition: "GOOD", photoCount: 0, qtyConfirmed: true, minPhotosPerRU: 1 }), (e) => e.code === "RECEIVING_PHOTO_REQUIRED");
});

run("completion is idempotent", () => {
  const unit = {
    actualQty: 25,
    actualUnitWeightKg: 1,
    condition: "GOOD",
    qtyConfirmed: true,
    status: "IN_PROGRESS",
    version: 3,
  };
  const first = applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "a" });
  assert.equal(first.alreadyCompleted, false);
  const second = applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "a" });
  assert.equal(second.alreadyCompleted, true);
  assert.equal(unit.status, "COMPLETED");
});

run("session complete blocked while an RU is incomplete", () => {
  const progress = summarizeReceivingProgress([
    { article: "20834", uom: "PCS", plannedQty: 25, actualQty: 25, status: "COMPLETED", photoCount: 1 },
    { article: "20834", uom: "PCS", plannedQty: 25, actualQty: 23, status: "IN_PROGRESS", photoCount: 2 },
  ]);
  assert.equal(progress.ruCompleted, 1);
  assert.equal(progress.ruInProgress, 1);
  assert.equal(progress.ruPending, 0);
});

run("article-level progress does not mix UOMs", () => {
  const rows = [
    { article: "20834", description: "O-Ring", uom: "PCS", plannedQty: 50, actualQty: 48, status: "COMPLETED", photoCount: 2 },
    { article: "50025", description: "Piston", uom: "PCS", plannedQty: 1, actualQty: 1, status: "COMPLETED", photoCount: 4 },
    { article: "OIL", description: "Oil", uom: "LTR", plannedQty: 10, actualQty: 10, status: "IN_PROGRESS", photoCount: 1 },
  ];
  const grouped = groupReceivingProgressByArticle(rows);
  const summary = summarizeReceivingProgress(rows);
  assert.equal(grouped.length, 3);
  assert.equal(summary.mixedUom, true);
  assert.equal(summary.plannedQty, null);
  const oring = grouped.find((g) => g.article === "20834");
  assert.equal(oring.ruCompleted, 1);
  assert.equal(oring.countedQty, 48);
});

run("split bulk example: 25 + 23 counted against 50 planned", () => {
  const summary = summarizeReceivingProgress([
    { article: "W", uom: "PCS", plannedQty: 25, actualQty: 25, status: "COMPLETED", photoCount: 1 },
    { article: "W", uom: "PCS", plannedQty: 25, actualQty: 23, status: "COMPLETED", photoCount: 2 },
  ]);
  assert.equal(summary.plannedQty, 50);
  assert.equal(summary.countedQty, 48);
  assert.equal(summary.ruCompleted, 2);
});

run("replan blocked after receiving activity", () => {
  assert.throws(
    () => assertReplanBlockedByReceiving(true),
    (err) => err.code === "RU_RECEIVING_STARTED"
  );
  assert.equal(hasReceivingActivity([{ status: "IN_PROGRESS" }]), true);
  assert.equal(hasReceivingActivity([], [{ status: "ACTIVE" }]), true);
  assert.doesNotThrow(() => assertReplanBlockedByReceiving(false));
});

run("ASN cancel blocked after receiving started", () => {
  assert.throws(
    () => assertAsnCancelBlockedByReceiving({ hasSession: true, hasResults: false }),
    (err) => err instanceof ReceivingInspectionError && err.code === "ASN_RECEIVING_STARTED"
  );
});

run("photo settings are env-configurable", () => {
  const s = receivingPhotoSettingsFromEnv({
    RECEIVING_PHOTO_MAX_LONG_EDGE: "1600",
    RECEIVING_PHOTO_JPEG_QUALITY: "0.75",
    RECEIVING_PHOTO_MAX_BYTES: "3000000",
    RECEIVING_MIN_PHOTOS_PER_RU: "1",
  });
  assert.equal(s.maxLongEdge, 1600);
  assert.equal(s.jpegQuality, 0.75);
  assert.equal(s.maxBytes, 3000000);
  assert.equal(s.minPhotosPerRU, 1);
});

run("image helper resizes 4000×3000 and does not enlarge small images", () => {
  const big = resizeToMaxLongEdge(4000, 3000, 1800);
  assert.equal(big.resized, true);
  assert.equal(big.width, 1800);
  assert.equal(big.height, 1350);
  const small = resizeToMaxLongEdge(800, 600, 1800);
  assert.equal(small.resized, false);
  assert.equal(small.width, 800);
  assert.equal(small.height, 600);
});

run("frontend geometry matches backend resize/orientation helpers", () => {
  assert.deepEqual(feResize(4000, 3000, 1800), resizeToMaxLongEdge(4000, 3000, 1800));
  assert.deepEqual(feSwap(4000, 3000, 6), swapDimensionsForExifOrientation(4000, 3000, 6));
  const cfg = resolveReceivingPhotoConfig({ maxLongEdge: 1800, jpegQuality: 0.8 });
  assert.equal(cfg.outputMime, "image/jpeg");
  assert.equal(cfg.jpegQuality, 0.8);
});

run("JPEG EXIF orientation 6 is detected and swaps dimensions", () => {
  const buf = jpegWithOrientation(6);
  assert.equal(readJpegExifOrientation(buf), 6);
  const swapped = swapDimensionsForExifOrientation(4000, 3000, 6);
  assert.equal(swapped.width, 3000);
  assert.equal(swapped.height, 4000);
});

run("models exist with uniqueness and statuses", () => {
  const session = fs.readFileSync(path.join(srcRoot, "models", "ReceivingSession.js"), "utf8");
  const unit = fs.readFileSync(path.join(srcRoot, "models", "ReceivingSessionUnit.js"), "utf8");
  const photo = fs.readFileSync(path.join(srcRoot, "models", "ReceivingUnitPhoto.js"), "utf8");
  assert.match(session, /receivingSessions_one_active_per_asn/);
  assert.match(session, /DRAFT/);
  assert.match(session, /IN_PROGRESS/);
  assert.match(session, /COMPLETED/);
  assert.match(session, /CANCELLED/);
  assert.match(unit, /companyId: 1, receivingSessionId: 1, receivingUnitId: 1/);
  assert.match(unit, /version/);
  assert.match(photo, /storageKey/);
  assert.match(photo, /receivingUnitPhotos_retry_idempotency/);
  assert.doesNotMatch(photo, /Buffer/);
});

run("scan/session APIs and tablet UI exist", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "receivingInspectionRoutes.js"), "utf8");
  const server = fs.readFileSync(path.join(srcRoot, "server.js"), "utf8");
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  const scanner = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingBarcodeScanner.jsx"), "utf8");
  const inspect = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingUnitInspectScreen.jsx"), "utf8");
  const pkg = fs.readFileSync(path.join(feRoot, "..", "package.json"), "utf8");
  assert.match(server, /\/api\/receiving/);
  assert.match(routes, /\/scan\/:barcode/);
  assert.match(routes, /STORE", "create"/);
  assert.match(incoming, /Scan Item/);
  assert.match(incoming, /Resume Receiving/);
  assert.match(incoming, /Enter RU Number/);
  const scanConfig = fs.readFileSync(path.join(feRoot, "lib", "receivingBarcodeScannerConfig.js"), "utf8");
  assert.match(scanner, /html5-qrcode/);
  assert.match(scanner, /buildHtml5QrcodeConstructorConfig/);
  assert.match(scanConfig, /CODE_128/);
  assert.match(scanConfig, /facingMode: "environment"/);
  assert.match(inspect, /Take Photo/);
  assert.match(inspect, /Take Another/);
  assert.match(inspect, /Complete Item/);
  assert.match(inspect, /Scan Next/);
  assert.match(inspect, /processReceivingPhoto/);
  assert.match(pkg, /html5-qrcode/);
});

run("Phase 3A services have 0 stock / GRN / customs / accounting / asnActiveQty side effects", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "receivingInspectionRules.js"), "utf8");
  for (const src of [svc, guard, rules]) {
    assert.doesNotMatch(src, /StockLedger/);
    assert.doesNotMatch(src, /from ["'].*grn/i);
    assert.doesNotMatch(src, /GoodsReceipt/);
    assert.doesNotMatch(src, /CustomsLot/);
    assert.doesNotMatch(src, /CustomsMovement/);
    assert.doesNotMatch(src, /asnActiveQty/);
    assert.doesNotMatch(src, /postGrn/i);
    assert.doesNotMatch(src, /createJournal/i);
  }
});

run("RU identity fields stay immutable in receiving save payload handling", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /snapshotFromRu/);
  assert.match(svc, /loadAuthorizedRuForSession/);
  assert.doesNotMatch(svc, /body\.article/);
  assert.doesNotMatch(svc, /body\.ruNo/);
  assert.doesNotMatch(svc, /body\.plannedQty/);
  assert.doesNotMatch(svc, /body\.companyId/);
});

run("replan and ASN cancel call receiving-started guards", () => {
  const ruSvc = fs.readFileSync(path.join(srcRoot, "services", "receivingUnitService.js"), "utf8");
  assert.match(ruSvc, /assertReplanNotBlockedByReceiving/);
  assert.match(ruSvc, /assertAsnCancelNotBlockedByReceiving/);
  const asnSvc = fs.readFileSync(path.join(srcRoot, "services", "asnService.js"), "utf8");
  assert.doesNotMatch(asnSvc, /ReceivingUnit/);
  assert.doesNotMatch(asnSvc, /barcode/);
});

run("label print history is not rewritten by Phase 3A", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.doesNotMatch(svc, /LabelPrintJob/);
  assert.doesNotMatch(svc, /labelPrintedAt/);
  assert.doesNotMatch(svc, /barcodeValue\s*=/);
});

run("S3 reuse: backend multipart + tenant key, not public-write", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const s3 = fs.readFileSync(path.join(srcRoot, "services", "s3UploadService.js"), "utf8");
  assert.match(svc, /uploadFileToS3/);
  assert.match(svc, /buildReceivingPhotoObjectKey/);
  assert.match(s3, /tenants/);
  assert.match(s3, /receiving/);
  assert.doesNotMatch(svc, /putObjectAcl/);
  assert.doesNotMatch(svc, /ACL:\s*["']public/);
});

run("STORE_OPERATOR can receive without ASN.edit", () => {
  const m = getDefaultPermissionsForRole("store_operator");
  assert.ok(m.ASN.includes("view"));
  assert.ok(!m.ASN.includes("edit"));
  assert.ok(m.STORE.includes("create"));
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "receivingInspectionRoutes.js"), "utf8");
  assert.ok(!routes.includes('requirePermission("ASN", "edit")'));
});

run("audit actions cover meaningful receiving events", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  for (const action of [
    "RECEIVING_SESSION_STARTED",
    "RECEIVING_UNIT_STARTED",
    "RECEIVING_DRAFT_SAVED",
    "RECEIVING_PHOTO_ADDED",
    "RECEIVING_PHOTO_REMOVED",
    "RECEIVING_UNIT_COMPLETED",
    "RECEIVING_SESSION_COMPLETED",
  ]) {
    assert.match(svc, new RegExp(action));
  }
  assert.match(svc, /explicit === true/);
});

run("summary payload is Phase 4-ready without GRN create", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /export async function getReceivingSummary/);
  assert.match(svc, /variance/);
  assert.match(svc, /countedQty/);
  assert.doesNotMatch(svc, /Draft GRN/);
  assert.doesNotMatch(svc, /createGrn/);
});

run("Phase 3A unique index specs: names, uniqueness, $in partial, barcode key", () => {
  const byName = Object.fromEntries(RECEIVING_INSPECTION_INDEX_SPECS.map((s) => [s.name, s]));
  assert.equal(byName[RECEIVING_SESSION_NO_INDEX].unique, true);
  assert.deepEqual(byName[RECEIVING_SESSION_NO_INDEX].key, { companyId: 1, sessionNo: 1 });
  assert.equal(byName[RECEIVING_SESSION_ACTIVE_INDEX].unique, true);
  assert.deepEqual(byName[RECEIVING_SESSION_ACTIVE_INDEX].key, { companyId: 1, asnId: 1 });
  assert.deepEqual(byName[RECEIVING_SESSION_ACTIVE_INDEX].partialFilterExpression, {
    status: { $in: ["DRAFT", "IN_PROGRESS"] },
  });
  assert.deepEqual(receivingSessionActivePartialFilter(), { status: { $in: ["DRAFT", "IN_PROGRESS"] } });
  assert.deepEqual(byName[RECEIVING_SESSION_UNIT_UNIQUE_INDEX].key, {
    companyId: 1,
    receivingSessionId: 1,
    receivingUnitId: 1,
  });
  assert.equal(byName[RECEIVING_PHOTO_RETRY_INDEX].unique, true);
  assert.deepEqual(receivingPhotoRetryPartialFilter(), { clientUploadId: { $type: "string", $gt: "" } });
  assert.deepEqual(RECEIVING_UNIT_BARCODE_INDEX_SPEC.key, { companyId: 1, barcodeValue: 1 });
  assert.equal(RECEIVING_UNIT_BARCODE_INDEX_SPEC.unique, true);
  assert.equal(RECEIVING_UNIT_BARCODE_INDEX_SPEC.matchByKey, true);
});

run("index inventory reports missing vs present unique indexes", () => {
  const missing = evaluateIndexInventory({});
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.length >= 5);
  const present = evaluateIndexInventory({
    receivingSessions: [
      { name: RECEIVING_SESSION_NO_INDEX, key: { companyId: 1, sessionNo: 1 }, unique: true },
      {
        name: RECEIVING_SESSION_ACTIVE_INDEX,
        key: { companyId: 1, asnId: 1 },
        unique: true,
        partialFilterExpression: receivingSessionActivePartialFilter(),
      },
    ],
    receivingSessionUnits: [
      {
        name: RECEIVING_SESSION_UNIT_UNIQUE_INDEX,
        key: { companyId: 1, receivingSessionId: 1, receivingUnitId: 1 },
        unique: true,
      },
    ],
    receivingUnitPhotos: [
      {
        name: RECEIVING_PHOTO_RETRY_INDEX,
        key: { companyId: 1, receivingSessionUnitId: 1, clientUploadId: 1 },
        unique: true,
        partialFilterExpression: receivingPhotoRetryPartialFilter(),
      },
    ],
    receivingUnits: [
      { name: "companyId_1_barcodeValue_1", key: { companyId: 1, barcodeValue: 1 }, unique: true },
    ],
  });
  assert.equal(present.ok, true);
  assert.equal(present.missing.length, 0);
});

run("production index path does not rely on autoIndex", () => {
  const idx = fs.readFileSync(path.join(srcRoot, "utils", "receivingInspectionIndexes.js"), "utf8");
  const server = fs.readFileSync(path.join(srcRoot, "server.js"), "utf8");
  const migrate = fs.readFileSync(path.join(backendRoot, "scripts", "migrate-receiving-inspection-indexes.mjs"), "utf8");
  const pkg = fs.readFileSync(path.join(backendRoot, "package.json"), "utf8");
  assert.match(idx, /autoIndex/);
  assert.match(idx, /ensureReceivingInspectionIndexes/);
  assert.match(server, /ensureReceivingInspectionIndexes/);
  assert.match(migrate, /--execute/);
  assert.match(migrate, /DRY RUN/);
  assert.doesNotMatch(migrate, /dropIndex/);
  assert.match(pkg, /migrate:receiving-inspection-indexes/);
});

run("session start uses DB duplicate-key uniqueness then resumes winner", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const sessionModel = fs.readFileSync(path.join(srcRoot, "models", "ReceivingSession.js"), "utf8");
  assert.match(sessionModel, /receivingSessions_one_active_per_asn/);
  assert.match(sessionModel, /\$in: \["DRAFT", "IN_PROGRESS"\]/);
  assert.match(svc, /ReceivingSession\.create/);
  assert.match(svc, /isDupKey\(err\)/);
  assert.match(svc, /findActiveSession/);
  assert.match(svc, /resumed: true/);
});

run("photo delete vs complete race never leaves COMPLETED below min photos", () => {
  const deleteFirst = simulatePhotoDeleteVsCompleteRace({ deleteFirst: true, photosBefore: 1, minPhotos: 1 });
  const completeFirst = simulatePhotoDeleteVsCompleteRace({ deleteFirst: false, photosBefore: 1, minPhotos: 1 });
  assert.equal(deleteFirst.invariantHolds, true);
  assert.equal(completeFirst.invariantHolds, true);
  assert.notEqual(deleteFirst.status === "COMPLETED" && deleteFirst.photos < 1, true);
  assert.notEqual(completeFirst.status === "COMPLETED" && completeFirst.photos < 1, true);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /evaluateCompletePhotoInvariant/);
  assert.match(svc, /RECEIVING_PHOTO_LOCKED/);
  assert.match(svc, /status: "IN_PROGRESS"/);
});

run("delayed autosave after completion is 409 RECEIVING_UNIT_ALREADY_COMPLETED", () => {
  const unit = {
    actualQty: 25,
    actualUnitWeightKg: 1,
    condition: "GOOD",
    qtyConfirmed: true,
    status: "IN_PROGRESS",
    version: 2,
  };
  applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "a" });
  assert.equal(unit.status, "COMPLETED");
  const completedAt = unit.completedAt;
  assert.throws(
    () => applyReceivingDraftSave(unit, { actualQty: 23, expectedVersion: 2, actor: "late" }),
    (err) => err.code === "RECEIVING_UNIT_ALREADY_COMPLETED" && err.status === 409
  );
  assert.equal(unit.actualQty, 25);
  assert.equal(unit.completedAt, completedAt);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /status: \{ \$ne: "COMPLETED" \}/);
  assert.match(svc, /RECEIVING_UNIT_ALREADY_COMPLETED/);
});

run("duplicate Complete Item is idempotent and keeps first completedAt", () => {
  const unit = {
    actualQty: 25,
    actualUnitWeightKg: 1,
    condition: "GOOD",
    qtyConfirmed: true,
    status: "IN_PROGRESS",
    version: 3,
    completedAt: null,
    completedBy: "",
  };
  const first = applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "first", now: new Date("2026-08-19T06:00:00.000Z") });
  const stamp = unit.completedAt;
  const second = applyReceivingUnitComplete(unit, { photoCount: 1, minPhotosPerRU: 1, actor: "second", now: new Date("2026-08-19T06:05:00.000Z") });
  assert.equal(first.alreadyCompleted, false);
  assert.equal(second.alreadyCompleted, true);
  assert.equal(unit.completedBy, "first");
  assert.equal(unit.completedAt, stamp);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /alreadyCompleted: true/);
  assert.match(svc, /status: \{ \$ne: "COMPLETED" \}/);
});

run("duplicate session complete is idempotent after server-side RU recompute", () => {
  const session = { status: "IN_PROGRESS", completedAt: null, completedBy: "" };
  const first = applyReceivingSessionComplete(session, { allRusComplete: true, actor: "a", now: new Date("2026-08-19T06:00:00.000Z") });
  const stamp = session.completedAt;
  const second = applyReceivingSessionComplete(session, { allRusComplete: true, actor: "b", now: new Date("2026-08-19T06:05:00.000Z") });
  assert.equal(first.alreadyCompleted, false);
  assert.equal(second.alreadyCompleted, true);
  assert.equal(session.completedBy, "a");
  assert.equal(session.completedAt, stamp);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /filter\(\(r\) => r\.status !== "COMPLETED"\)/);
  assert.match(svc, /status: \{ \$in: \["DRAFT", "IN_PROGRESS"\] \}/);
});

run("photo retry with same clientUploadId reuses the existing record", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const lookupAt = svc.indexOf("if (clientUploadId)");
  const completedAt = svc.indexOf("Cannot add photos after this item is completed");
  const dupAt = svc.indexOf("isDupKey(err) && clientUploadId");
  assert.ok(lookupAt > 0 && lookupAt < completedAt);
  assert.ok(dupAt > completedAt);
  assert.match(svc, /duplicate: true/);
  assert.match(svc, /RECEIVING_PHOTO_RETRY_STALE/);
  assert.match(svc, /deleteFileFromS3\(uploaded\.key/);
});

run("signed photo GET is company/session scoped", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "receivingInspectionRoutes.js"), "utf8");
  const serialize = svc.slice(svc.indexOf("function serializePhoto"), svc.indexOf("async function loadAsn"));
  assert.match(svc, /companyId: req\.companyId/);
  assert.match(svc, /photo\.receivingSessionId/);
  assert.match(svc, /RECEIVING_PHOTO_NOT_FOUND/);
  assert.doesNotMatch(serialize, /storageKey/);
  assert.match(routes, /photos\/:photoId\/url/);
  assert.match(routes, /ASN", "view"/);
});

run("scanner stops camera on unmount, cancel, and successful decode", () => {
  const scanner = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingBarcodeScanner.jsx"), "utf8");
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(scanner, /scanner\.stop\(\)/);
  assert.match(scanner, /scanner\.clear\(\)/);
  assert.match(scanner, /if \(cancelled\)/);
  assert.match(scanner, /cameraStarted/);
  assert.match(scanner, /releasedRef\.current = true/);
  assert.match(scanner, /stopScanner\(scannerRef\.current/);
  assert.match(scanner, /Enter RU Number/);
  assert.match(incoming, /scanLockRef/);
  assert.match(incoming, /\/receiving\/scan\//);
  assert.match(incoming, /Enter RU Number/);
});

run("image decode falls back when createImageBitmap orientation option is unsupported", () => {
  assert.equal(chooseReceivingImageDecodeStrategy({ hasCreateImageBitmap: true, orientationOptionThrows: false }), "bitmap-oriented");
  assert.equal(
    chooseReceivingImageDecodeStrategy({
      hasCreateImageBitmap: true,
      orientationOptionThrows: true,
      plainBitmapThrows: false,
    }),
    "bitmap-plain"
  );
  assert.equal(
    chooseReceivingImageDecodeStrategy({
      hasCreateImageBitmap: true,
      orientationOptionThrows: true,
      plainBitmapThrows: true,
    }),
    "image-exif"
  );
  assert.equal(chooseReceivingImageDecodeStrategy({ hasCreateImageBitmap: false }), "image-exif");
  const processSrc = fs.readFileSync(path.join(feRoot, "lib", "receivingPhotoProcess.js"), "utf8");
  assert.match(processSrc, /imageOrientation: "from-image"/);
  assert.match(processSrc, /createImageBitmap\(input\)/);
  assert.match(processSrc, /drawOrientedImage/);
});

run("completion requires explicit qtyConfirmed even when actual equals planned", () => {
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 25,
        actualUnitWeightKg: 1,
        condition: "GOOD",
        photoCount: 1,
        qtyConfirmed: false,
        remarks: "",
      }),
    (err) => err.code === "RECEIVING_QTY_NOT_CONFIRMED"
  );
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 25,
      actualUnitWeightKg: 1,
      condition: "GOOD",
      photoCount: 1,
      qtyConfirmed: true,
    })
  );
});

run("zero actual qty is valid with NOT_RECEIVED + remarks and rejected as GOOD", () => {
  assert.equal(assertReceivingActualQty(0), 0);
  assert.doesNotThrow(() =>
    assertUnitCompletable({
      actualQty: 0,
      condition: "NOT_RECEIVED",
      remarks: "empty crate",
      photoCount: 1,
      qtyConfirmed: true,
    })
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 0,
        condition: "GOOD",
        remarks: "empty crate",
        photoCount: 1,
        qtyConfirmed: true,
      }),
    (err) => err.code === "RECEIVING_ZERO_QTY_CONDITION"
  );
  assert.throws(
    () =>
      assertUnitCompletable({
        actualQty: 0,
        condition: "NOT_RECEIVED",
        remarks: "",
        photoCount: 1,
        qtyConfirmed: true,
      }),
    (err) => err.code === "RECEIVING_ZERO_QTY_REMARKS"
  );
});

run("summary variance is actual minus planned, including short count -2", () => {
  assert.equal(varianceQty(25, 23), -2);
  assert.equal(varianceQty(25, 27), 2);
  assert.equal(varianceQty(50, 48), -2);
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(svc, /varianceQty\(ru\.plannedQty, unit\?\.actualQty\)/);
  assert.match(svc, /varianceQty\(line\.asnQty, counted\)/);
  assert.match(svc, /String\(r\.asnLineId\) === String\(line\._id\)/);
});

run("server sniffs image bytes instead of trusting client MIME", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(sniffReceivingImageMime(jpeg), "image/jpeg");
  const checked = assertReceivingPhotoUpload({
    mimeType: "application/pdf",
    sizeBytes: jpeg.length,
    maxBytes: 5_000_000,
    buffer: jpeg,
  });
  assert.equal(checked.mimeType, "image/jpeg");
});

run("replan is blocked by session-unit activity, not by an empty DRAFT session", () => {
  assert.equal(hasReceivingActivity([{ status: "NOT_STARTED", startedAt: new Date() }]), true);
  assert.equal(hasReceivingActivity([{ status: "IN_PROGRESS", actualQty: 23 }]), true);
  assert.equal(hasReceivingActivity([], [{ status: "DELETED" }]), true);
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  assert.match(guard, /classifyReplanReceivingFreeze/);
  assert.match(guard, /isEmptyDraftReceivingSession/);
  assert.match(guard, /invalidateEmptyDraftReceivingSession/);
  assert.match(guard, /ReceivingSessionUnit\.countDocuments/);
  assert.match(guard, /ReceivingUnitPhoto\.countDocuments/);
  assert.doesNotMatch(
    guard.slice(guard.indexOf("export async function inspectReplanReceivingBlockers")),
    /if \(session\) \{\s*const completed/
  );
});

run("ASN cancel remains blocked after a COMPLETED inspection session", () => {
  assert.throws(
    () => assertAsnCancelBlockedByReceiving({ hasSession: true, hasResults: false }),
    (err) => err.code === "ASN_RECEIVING_STARTED"
  );
  const guard = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionGuard.js"), "utf8");
  assert.match(guard, /status: \{ \$in: \["DRAFT", "IN_PROGRESS", "COMPLETED"\] \}/);
});

run("photo metadata identity is server-derived, not client-supplied", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  const upload = svc.slice(svc.indexOf("export async function uploadReceivingPhoto"), svc.indexOf("export async function deleteReceivingPhoto"));
  assert.match(upload, /companyId: req\.companyId/);
  assert.match(upload, /asnId: session\.asnId/);
  assert.match(upload, /asnLineId: ru\.asnLineId/);
  assert.match(upload, /receivingUnitId: ru\._id/);
  assert.doesNotMatch(upload, /body\.companyId/);
  assert.doesNotMatch(upload, /body\.asnId/);
  assert.doesNotMatch(upload, /body\.receivingUnitId/);
  assert.doesNotMatch(upload, /body\.ruNo/);
  assert.doesNotMatch(upload, /body\.article/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
