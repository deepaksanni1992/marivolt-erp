import { useEffect, useRef, useState } from "react";
import {
  CAMERA_ERROR,
  SCAN_STATUS,
  buildCameraIdOrConfig,
  buildCameraScanConfig,
  buildHtml5QrcodeConstructorConfig,
  classifyCameraStartError,
  classifyFrameDecodeError,
  normalizeRuBarcode,
  optionalFocusConstraints,
  preferRearCameraId,
  shouldLockDuplicateScan,
  torchCapabilitySupported,
  zoomCapabilitySupported,
} from "../../lib/receivingBarcodeScannerConfig.js";

function scanFeedback() {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(80);
  } catch {
    /* ignore */
  }
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    setTimeout(() => ctx.close().catch(() => {}), 200);
  } catch {
    /* ignore */
  }
}

async function stopScanner(scanner) {
  if (!scanner) return;
  try {
    await scanner.stop();
  } catch {
    /* already stopped */
  }
  try {
    scanner.clear();
  } catch {
    /* ignore */
  }
}

async function applyOptionalTrackEnhancements(scanner) {
  try {
    const caps = scanner.getRunningTrackCapabilities?.() || {};
    const focus = optionalFocusConstraints(caps);
    if (focus) {
      await scanner.applyVideoConstraints(focus);
    }
  } catch {
    /* focusMode not supported on this track */
  }
}

function readDiagnostics(scanner, cameras, deviceId) {
  let resolution = "";
  let cameraLabel = "";
  try {
    const settings = scanner.getRunningTrackSettings?.() || {};
    if (settings.width && settings.height) {
      resolution = `${settings.width}×${settings.height}`;
    }
    const match = (cameras || []).find((cam) => cam.id === deviceId);
    cameraLabel = String(match?.label || "").trim();
  } catch {
    /* labels may be empty until permission is granted */
  }
  return { resolution, cameraLabel };
}

export default function ReceivingBarcodeScanner({ open, onClose, onScan }) {
  const regionId = "receiving-barcode-region";
  const scannerRef = useRef(null);
  const onScanRef = useRef(onScan);
  const lastRef = useRef({ value: "", at: 0 });
  const releasedRef = useRef(false);
  const lastFrameLogRef = useRef(0);
  const [denied, setDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [starting, setStarting] = useState(false);
  const [diag, setDiag] = useState({
    status: "",
    scanning: "",
    resolution: "",
    cameraLabel: "",
    lastCategory: "",
  });
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [zoomAvailable, setZoomAvailable] = useState(false);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let cameraStarted = false;
    releasedRef.current = false;
    lastFrameLogRef.current = 0;
    setDenied(false);
    setUnavailable(false);
    setError("");
    setStarting(true);
    setTorchOn(false);
    setTorchAvailable(false);
    setZoomAvailable(false);
    setDiag({
      status: "",
      scanning: "",
      resolution: "",
      cameraLabel: "",
      lastCategory: "",
    });

    (async () => {
      let scanner = null;
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;

        let cameras = [];
        try {
          cameras = await Html5Qrcode.getCameras();
        } catch {
          cameras = [];
        }
        const deviceId = preferRearCameraId(cameras);
        const cameraIdOrConfig = buildCameraIdOrConfig(deviceId);

        const startOnce = async (includeVideoConstraints) => {
          const instance = new Html5Qrcode(
            regionId,
            buildHtml5QrcodeConstructorConfig(Html5QrcodeSupportedFormats)
          );
          scannerRef.current = instance;
          await instance.start(
            cameraIdOrConfig,
            buildCameraScanConfig({ deviceId, includeVideoConstraints }),
            (decoded) => {
              if (cancelled || releasedRef.current) return;
              const value = normalizeRuBarcode(decoded);
              if (!value) return;
              const now = Date.now();
              if (shouldLockDuplicateScan(lastRef.current, value, now)) return;
              lastRef.current = { value, at: now };
              releasedRef.current = true;
              scanFeedback();
              stopScanner(scannerRef.current || instance).finally(() => {
                if (!cancelled) onScanRef.current?.(value);
              });
            },
            (errorMessage) => {
              const category = classifyFrameDecodeError(errorMessage);
              const now = Date.now();
              if (now - lastFrameLogRef.current < 5000) return;
              lastFrameLogRef.current = now;
              if (import.meta.env.DEV) {
                console.info("[receiving-scanner]", category);
              }
              if (!cancelled) {
                setDiag((prev) => ({ ...prev, lastCategory: category }));
              }
            }
          );
          return instance;
        };

        try {
          scanner = await startOnce(true);
        } catch (firstErr) {
          await stopScanner(scannerRef.current);
          if (cancelled) return;
          if (classifyCameraStartError(firstErr) === CAMERA_ERROR.PERMISSION_DENIED) {
            throw firstErr;
          }
          scanner = await startOnce(false);
        }

        cameraStarted = true;
        if (cancelled) {
          await stopScanner(scanner);
          return;
        }

        await applyOptionalTrackEnhancements(scanner);
        let camCaps = null;
        try {
          camCaps = scanner.getRunningTrackCameraCapabilities?.() || null;
        } catch {
          camCaps = null;
        }
        setTorchAvailable(torchCapabilitySupported(camCaps));
        setZoomAvailable(zoomCapabilitySupported(camCaps));

        const info = readDiagnostics(scanner, cameras, deviceId);
        setDiag({
          status: SCAN_STATUS.READY,
          scanning: SCAN_STATUS.SCANNING,
          resolution: info.resolution,
          cameraLabel: info.cameraLabel,
          lastCategory: "",
        });
        setStarting(false);
      } catch (err) {
        if (cancelled) {
          await stopScanner(scanner);
          return;
        }
        setStarting(false);
        const code = classifyCameraStartError(err);
        if (code === CAMERA_ERROR.PERMISSION_DENIED) {
          setDenied(true);
        } else {
          setUnavailable(true);
          setError(String(err?.message || "Camera is not available on this device."));
        }
      }
    })();

    return () => {
      cancelled = true;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (cameraStarted || scanner) {
        stopScanner(scanner);
      }
    };
  }, [open]);

  if (!open) return null;

  function submitManual(e) {
    e?.preventDefault?.();
    const value = normalizeRuBarcode(manual);
    if (!value) return;
    scanFeedback();
    onScan?.(value);
  }

  async function toggleTorch() {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      const caps = scanner.getRunningTrackCameraCapabilities?.();
      const torch = caps?.torchFeature?.();
      if (!torch?.isSupported?.()) return;
      const next = !torchOn;
      await torch.apply(next);
      setTorchOn(next);
    } catch {
      /* torch unsupported after start */
    }
  }

  async function nudgeZoom(direction) {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      const zoom = scanner.getRunningTrackCameraCapabilities?.()?.zoomFeature?.();
      if (!zoom?.isSupported?.()) return;
      const min = Number(zoom.min?.() ?? 1);
      const max = Number(zoom.max?.() ?? min);
      const step = Number(zoom.step?.() || (max - min) / 8) || 0.1;
      const current = Number(zoom.value?.() ?? min);
      const next = Math.min(max, Math.max(min, current + direction * step));
      await zoom.apply(next);
    } catch {
      /* zoom unsupported */
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-slate-950 text-white">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-xl font-semibold">Scan Item</h2>
        <button
          type="button"
          className="min-h-12 rounded-xl bg-white px-5 text-base font-semibold text-slate-900"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div id={regionId} className="h-full min-h-[52vh] w-full overflow-hidden bg-black" />
        {!denied && !unavailable ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[26vh] min-h-[7rem] max-h-64 w-[88%] max-w-4xl rounded-2xl border-4 border-sky-300/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        ) : null}
        {starting ? (
          <p className="absolute inset-x-0 top-4 text-center text-sm text-slate-200">Starting camera…</p>
        ) : null}
      </div>
      <div className="space-y-3 bg-slate-900 px-4 py-4">
        {denied ? (
          <p className="rounded-xl bg-amber-500/20 p-3 text-sm text-amber-100">
            Camera permission is blocked ({CAMERA_ERROR.PERMISSION_DENIED}). In Chrome, tap the lock
            icon → Permissions → Camera → Allow, then try again. You can also enter the RU number below.
          </p>
        ) : null}
        {unavailable ? (
          <p className="rounded-xl bg-slate-800 p-3 text-sm text-slate-200">
            {CAMERA_ERROR.UNAVAILABLE}: {error || "Camera is not available. Enter the RU number instead."}
          </p>
        ) : (
          <div className="space-y-1 text-center text-sm text-slate-300">
            <p className="font-medium text-white">Align the barcode inside the box</p>
            <p>Keep the full barcode and white space visible.</p>
            {diag.status ? (
              <p className="text-xs text-slate-400">
                {diag.status}
                {diag.scanning ? ` · ${diag.scanning}` : ""}
                {diag.resolution ? ` · ${diag.resolution}` : ""}
                {diag.cameraLabel ? ` · ${diag.cameraLabel}` : ""}
                {diag.lastCategory === SCAN_STATUS.NOT_DETECTED_YET
                  ? " · No code in view yet"
                  : ""}
              </p>
            ) : null}
          </div>
        )}
        {!denied && !unavailable && (torchAvailable || zoomAvailable) ? (
          <div className="flex flex-wrap justify-center gap-2">
            {torchAvailable ? (
              <button
                type="button"
                className="min-h-11 rounded-xl bg-slate-700 px-4 text-sm font-semibold"
                onClick={toggleTorch}
              >
                {torchOn ? "Torch off" : "Torch"}
              </button>
            ) : null}
            {zoomAvailable ? (
              <>
                <button
                  type="button"
                  className="min-h-11 rounded-xl bg-slate-700 px-4 text-sm font-semibold"
                  onClick={() => nudgeZoom(-1)}
                >
                  Zoom −
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-xl bg-slate-700 px-4 text-sm font-semibold"
                  onClick={() => nudgeZoom(1)}
                >
                  Zoom +
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <form className="flex gap-2" onSubmit={submitManual}>
          <input
            className="min-h-14 flex-1 rounded-xl border border-slate-600 bg-slate-800 px-3 text-lg uppercase tracking-wide"
            placeholder="Enter RU Number"
            value={manual}
            onChange={(e) => setManual(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect="off"
          />
          <button type="submit" className="min-h-14 rounded-xl bg-sky-500 px-4 text-base font-semibold">
            Go
          </button>
        </form>
      </div>
    </div>
  );
}
