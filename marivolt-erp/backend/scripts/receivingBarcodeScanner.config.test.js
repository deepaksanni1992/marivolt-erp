/**
 * Store RU camera scanner config (html5-qrcode 2.3.8).
 * Run: node scripts/receivingBarcodeScanner.config.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  CAMERA_ERROR,
  RECEIVING_CODE128_FORMAT,
  RECEIVING_SCANNER_FPS,
  SCAN_STATUS,
  buildCameraIdOrConfig,
  buildCameraScanConfig,
  buildHtml5QrcodeConstructorConfig,
  buildIdealVideoConstraints,
  buildQrbox,
  classifyCameraStartError,
  classifyFrameDecodeError,
  isWideRectangularQrbox,
  normalizeRuBarcode,
  optionalFocusConstraints,
  preferRearCameraId,
  shouldLockDuplicateScan,
} from "../../src/lib/receivingBarcodeScannerConfig.js";

const require = createRequire(import.meta.url);
const { Html5QrcodeSupportedFormats } = require("html5-qrcode");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feRoot = path.join(__dirname, "..", "..", "src");
const fePkg = path.join(__dirname, "..", "..", "package.json");

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

console.log("\nReceiving barcode scanner config\n");

run("installed html5-qrcode exposes CODE_128 = 5", () => {
  assert.equal(Html5QrcodeSupportedFormats.CODE_128, 5);
  assert.equal(Html5QrcodeSupportedFormats.CODE_128, RECEIVING_CODE128_FORMAT);
  assert.notEqual(Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.CODE_128);
  const pkg = JSON.parse(fs.readFileSync(fePkg, "utf8"));
  assert.match(String(pkg.dependencies["html5-qrcode"]), /2\.3\.8/);
});

run("constructor config enables only Code128 and disables BarcodeDetector", () => {
  const cfg = buildHtml5QrcodeConstructorConfig(Html5QrcodeSupportedFormats);
  assert.deepEqual(cfg.formatsToSupport, [Html5QrcodeSupportedFormats.CODE_128]);
  assert.equal(cfg.useBarCodeDetectorIfSupported, false);
  assert.equal(cfg.verbose, false);
});

run("start() camera config requests environment camera, ~12 fps, and 1280x720 ideals", () => {
  const camera = buildCameraIdOrConfig("");
  assert.deepEqual(camera, { facingMode: "environment" });
  const scan = buildCameraScanConfig();
  assert.equal(scan.fps, 12);
  assert.equal(scan.fps, RECEIVING_SCANNER_FPS);
  assert.equal(scan.disableFlip, true);
  assert.equal(typeof scan.qrbox, "function");
  assert.equal(scan.videoConstraints.facingMode.ideal, "environment");
  assert.equal(scan.videoConstraints.width.ideal, 1280);
  assert.equal(scan.videoConstraints.height.ideal, 720);
  assert.ok(scan.videoConstraints.width.max <= 1920);
});

run("qrbox is a wide rectangle suitable for Code128", () => {
  const portrait = buildQrbox(800, 1280);
  const landscape = buildQrbox(1280, 720);
  assert.ok(isWideRectangularQrbox(portrait));
  assert.ok(isWideRectangularQrbox(landscape));
  assert.ok(portrait.width >= 640);
  assert.ok(portrait.width <= 800);
  assert.ok(portrait.height < portrait.width);
  assert.ok(portrait.height >= 80);
});

run("normalizeRuBarcode trims without changing hyphens or leading zeros", () => {
  assert.equal(normalizeRuBarcode(" MAR-RU-000007 "), "MAR-RU-000007");
  assert.equal(normalizeRuBarcode("mar-ru-000007"), "MAR-RU-000007");
  assert.equal(normalizeRuBarcode("MAR-RU-000007"), "MAR-RU-000007");
});

run("duplicate scan lock uses 1.6s window", () => {
  const prev = { value: "MAR-RU-000007", at: 1000 };
  assert.equal(shouldLockDuplicateScan(prev, "MAR-RU-000007", 2500), true);
  assert.equal(shouldLockDuplicateScan(prev, "MAR-RU-000007", 2700), false);
  assert.equal(shouldLockDuplicateScan(prev, "MAR-RU-000008", 1100), false);
});

run("camera errors and frame no-decode are classified separately", () => {
  assert.equal(
    classifyCameraStartError({ name: "NotAllowedError", message: "Permission denied" }),
    CAMERA_ERROR.PERMISSION_DENIED
  );
  assert.equal(
    classifyCameraStartError({ name: "NotFoundError", message: "Requested device not found" }),
    CAMERA_ERROR.UNAVAILABLE
  );
  assert.equal(classifyFrameDecodeError("No barcode or QR code detected."), SCAN_STATUS.NOT_DETECTED_YET);
});

run("rear camera preference skips hardcoded ids and avoids macro labels when present", () => {
  assert.equal(preferRearCameraId([]), "");
  assert.equal(
    preferRearCameraId([
      { id: "front", label: "Front Camera" },
      { id: "macro", label: "Back Macro" },
      { id: "main", label: "Back Camera" },
    ]),
    "main"
  );
  const constraints = buildIdealVideoConstraints("main");
  assert.equal(constraints.deviceId.exact, "main");
  assert.equal("facingMode" in constraints, false);
});

run("continuous autofocus is optional and skipped when unsupported", () => {
  assert.equal(optionalFocusConstraints({}), null);
  assert.deepEqual(optionalFocusConstraints({ focusMode: ["continuous"] }), { focusMode: "continuous" });
});

run("scanner component uses constructor formats, stops on success, and keeps manual entry", () => {
  const scanner = fs.readFileSync(path.join(feRoot, "components", "store", "ReceivingBarcodeScanner.jsx"), "utf8");
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  assert.match(scanner, /buildHtml5QrcodeConstructorConfig\(Html5QrcodeSupportedFormats\)/);
  assert.match(scanner, /new Html5Qrcode\(\s*regionId/);
  assert.match(scanner, /releasedRef\.current = true/);
  assert.match(scanner, /stopScanner\(scannerRef\.current/);
  assert.match(scanner, /normalizeRuBarcode/);
  assert.match(scanner, /onScanRef\.current\?\.\(value\)/);
  assert.match(scanner, /Enter RU Number/);
  assert.match(scanner, /Align the barcode inside the box/);
  assert.match(scanner, /if \(cancelled\)/);
  assert.match(incoming, /Enter RU Number/);
  assert.match(incoming, /onScan=\{openScannedBarcode\}/);
  assert.doesNotMatch(scanner, /fetch\(|FormData|upload/);
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
