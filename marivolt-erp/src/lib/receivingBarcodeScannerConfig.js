/**
 * Camera config for Store RU receiving (html5-qrcode 2.3.8).
 *
 * formatsToSupport MUST be passed to the Html5Qrcode constructor.
 * Html5QrcodeCameraScanConfig (start()) does not read formatsToSupport.
 * Without constructor formats, 2.3.8 enables every symbology and prefers
 * Chrome BarcodeDetector, which is unreliable for Code128 on Samsung Chrome.
 */

export const RECEIVING_SCANNER_FPS = 12;
export const RECEIVING_SCAN_DUPLICATE_MS = 1600;
export const RECEIVING_CODE128_FORMAT = 5; // Html5QrcodeSupportedFormats.CODE_128

export const CAMERA_ERROR = {
  PERMISSION_DENIED: "CAMERA_PERMISSION_DENIED",
  UNAVAILABLE: "CAMERA_UNAVAILABLE",
};

export const SCAN_STATUS = {
  READY: "Camera ready",
  SCANNING: "Scanning Code128...",
  NOT_DETECTED_YET: "BARCODE_NOT_DETECTED_YET",
};

export function normalizeRuBarcode(decoded) {
  return String(decoded || "").trim().toUpperCase();
}

export function classifyCameraStartError(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(msg)) {
    return CAMERA_ERROR.PERMISSION_DENIED;
  }
  return CAMERA_ERROR.UNAVAILABLE;
}

export function buildQrbox(viewfinderWidth, viewfinderHeight) {
  const vw = Math.max(1, Number(viewfinderWidth) || 1);
  const vh = Math.max(1, Number(viewfinderHeight) || 1);
  const width = Math.max(50, Math.min(vw, Math.round(vw * 0.88)));
  let height = Math.max(50, Math.min(vh, Math.round(vh * 0.26)));
  height = Math.min(height, 280, Math.max(80, Math.round(width * 0.32)));
  if (height > vh) height = Math.max(50, vh);
  if (width > vw) {
    return { width: vw, height: Math.min(height, vh) };
  }
  return { width, height };
}

export function isWideRectangularQrbox(box) {
  if (!box || box.width < 50 || box.height < 50) return false;
  return box.width > box.height * 1.4;
}

export function buildHtml5QrcodeConstructorConfig(Html5QrcodeSupportedFormats) {
  const code128 = Html5QrcodeSupportedFormats?.CODE_128 ?? RECEIVING_CODE128_FORMAT;
  return {
    verbose: false,
    formatsToSupport: [code128],
    useBarCodeDetectorIfSupported: false,
  };
}

export function buildIdealVideoConstraints(deviceId) {
  const constraints = {
    facingMode: { ideal: "environment" },
    width: { min: 640, ideal: 1280, max: 1920 },
    height: { min: 360, ideal: 720, max: 1080 },
  };
  if (deviceId) {
    return {
      deviceId: { exact: String(deviceId) },
      width: constraints.width,
      height: constraints.height,
    };
  }
  return constraints;
}

export function buildCameraIdOrConfig(deviceId) {
  if (deviceId) return String(deviceId);
  return { facingMode: "environment" };
}

export function buildCameraScanConfig({ deviceId, includeVideoConstraints = true } = {}) {
  return {
    fps: RECEIVING_SCANNER_FPS,
    disableFlip: true,
    qrbox: buildQrbox,
    ...(includeVideoConstraints
      ? { videoConstraints: buildIdealVideoConstraints(deviceId) }
      : {}),
  };
}

export function preferRearCameraId(cameras) {
  const list = Array.isArray(cameras) ? cameras : [];
  if (!list.length) return "";
  const labeledBack = list.filter((cam) =>
    /back|rear|environment|world/i.test(String(cam?.label || ""))
  );
  const notSpecialty = labeledBack.filter(
    (cam) => !/macro|ultra.?wide|tele|telephoto/i.test(String(cam?.label || ""))
  );
  const preferred =
    notSpecialty.find((cam) => /main|wide(?!.*ultra)|camera 0|back camera/i.test(String(cam?.label || ""))) ||
    notSpecialty[0] ||
    labeledBack[0];
  return preferred?.id ? String(preferred.id) : "";
}

export function shouldLockDuplicateScan(previous, value, now, windowMs = RECEIVING_SCAN_DUPLICATE_MS) {
  if (!previous?.value || previous.value !== value) return false;
  return now - Number(previous.at || 0) < windowMs;
}

export function classifyFrameDecodeError(errorMessage) {
  const msg = String(errorMessage || "");
  if (!msg || /no barcode|no code|not found|qr code parse/i.test(msg)) {
    return SCAN_STATUS.NOT_DETECTED_YET;
  }
  return "DECODE_ERROR";
}

export function optionalFocusConstraints(capabilities) {
  const caps = capabilities || {};
  const focusModes = caps.focusMode;
  if (Array.isArray(focusModes) && focusModes.includes("continuous")) {
    return { focusMode: "continuous" };
  }
  return null;
}

export function torchCapabilitySupported(cameraCapabilities) {
  try {
    return cameraCapabilities?.torchFeature?.()?.isSupported?.() === true;
  } catch {
    return false;
  }
}

export function zoomCapabilitySupported(cameraCapabilities) {
  try {
    return cameraCapabilities?.zoomFeature?.()?.isSupported?.() === true;
  } catch {
    return false;
  }
}
