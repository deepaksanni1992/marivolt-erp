import { useEffect, useRef, useState } from "react";

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

export default function ReceivingBarcodeScanner({ open, onClose, onScan }) {
  const regionId = "receiving-barcode-region";
  const scannerRef = useRef(null);
  const onScanRef = useRef(onScan);
  const lastRef = useRef({ value: "", at: 0 });
  const releasedRef = useRef(false);
  const [denied, setDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let cameraStarted = false;
    releasedRef.current = false;
    setDenied(false);
    setUnavailable(false);
    setError("");
    setStarting(true);

    async function stopScanner(scanner) {
      if (!scanner) return;
      try {
        await scanner.stop();
      } catch {
        /* already stopped */
      }
      try {
        await scanner.clear();
      } catch {
        /* ignore */
      }
    }

    (async () => {
      let scanner = null;
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5Qrcode(regionId, { verbose: false });
        scannerRef.current = scanner;
        if (cancelled) {
          await stopScanner(scanner);
          return;
        }
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 8,
            qrbox: { width: 320, height: 140 },
            aspectRatio: 1.777,
            formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128],
          },
          (decoded) => {
            if (cancelled || releasedRef.current) return;
            const value = String(decoded || "").trim().toUpperCase();
            if (!value) return;
            const now = Date.now();
            if (value === lastRef.current.value && now - lastRef.current.at < 1600) return;
            lastRef.current = { value, at: now };
            releasedRef.current = true;
            scanFeedback();
            stopScanner(scannerRef.current || scanner).finally(() => {
              if (!cancelled) onScanRef.current?.(value);
            });
          }
        );
        cameraStarted = true;
        if (cancelled) {
          await stopScanner(scanner);
          return;
        }
        setStarting(false);
      } catch (err) {
        if (cancelled) {
          await stopScanner(scanner);
          return;
        }
        setStarting(false);
        const name = String(err?.name || "");
        const msg = String(err?.message || "");
        if (name === "NotAllowedError" || /permission|denied/i.test(msg)) {
          setDenied(true);
        } else if (name === "NotFoundError" || /camera|media/i.test(msg)) {
          setUnavailable(true);
        } else {
          setUnavailable(true);
          setError(msg || "Camera scanner is not available on this device.");
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
    const value = String(manual || "").trim().toUpperCase();
    if (!value) return;
    scanFeedback();
    onScan?.(value);
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
            <div className="h-28 w-[78%] max-w-md rounded-2xl border-4 border-sky-300/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        ) : null}
        {starting ? (
          <p className="absolute inset-x-0 top-4 text-center text-sm text-slate-200">Starting camera…</p>
        ) : null}
      </div>
      <div className="space-y-3 bg-slate-900 px-4 py-4">
        {denied ? (
          <p className="rounded-xl bg-amber-500/20 p-3 text-sm text-amber-100">
            Camera permission is blocked. In Chrome, tap the lock icon → Permissions → Camera → Allow, then try again.
            You can also enter the RU number below.
          </p>
        ) : null}
        {unavailable ? (
          <p className="rounded-xl bg-slate-800 p-3 text-sm text-slate-200">
            {error || "Camera is not available. Enter the RU number instead."}
          </p>
        ) : (
          <p className="text-center text-sm text-slate-300">Align the Code128 barcode inside the frame.</p>
        )}
        <form className="flex gap-2" onSubmit={submitManual}>
          <input
            className="min-h-14 flex-1 rounded-xl border border-slate-600 bg-slate-800 px-3 text-lg uppercase tracking-wide"
            placeholder="Enter RU number"
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
