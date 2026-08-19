import { useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostFormData } from "../../lib/api.js";
import { processReceivingPhoto } from "../../lib/receivingPhotoProcess.js";

const CONDITIONS = [
  { id: "GOOD", label: "GOOD" },
  { id: "DAMAGED", label: "DAMAGED" },
  { id: "REJECTED", label: "REJECTED" },
  { id: "MIXED", label: "MIXED" },
];

const PHOTO_CATEGORIES = [
  "OVERALL",
  "FRONT",
  "BACK",
  "MARKING",
  "PART_NUMBER",
  "DAMAGE",
  "PACKING",
  "OTHER",
];

function qtyStep(uom) {
  const u = String(uom || "").toUpperCase();
  if (["KG", "LB", "M", "MTR", "LTR", "L"].includes(u)) return 0.01;
  return 1;
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function ReceivingUnitInspectScreen({
  open,
  scan,
  session,
  settings,
  onClose,
  onScanNext,
  onChanged,
}) {
  const ru = scan?.ru || {};
  const ruId = ru._id;
  const sessionId = session?._id;
  const [actualQty, setActualQty] = useState("");
  const [qtyConfirmed, setQtyConfirmed] = useState(false);
  const [condition, setCondition] = useState("");
  const [remarks, setRemarks] = useState("");
  const [version, setVersion] = useState(0);
  const [photos, setPhotos] = useState([]);
  const [status, setStatus] = useState("NOT_STARTED");
  const [saveState, setSaveState] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState("");
  const [photoBusy, setPhotoBusy] = useState("");
  const [category, setCategory] = useState("");
  const [viewer, setViewer] = useState(null);
  const [completed, setCompleted] = useState(false);
  const fileRef = useRef(null);
  const debounceRef = useRef(null);
  const skipAutosave = useRef(true);

  const planned = Number(ru.plannedQty) || 0;
  const step = qtyStep(ru.uom);
  const locked = completed || status === "COMPLETED";

  useEffect(() => {
    const result = scan?.result;
    const nextQty = result?.actualQty != null ? String(result.actualQty) : String(planned);
    setActualQty(nextQty);
    setQtyConfirmed(result?.qtyConfirmed === true);
    setCondition(result?.condition || "");
    setRemarks(result?.remarks || "");
    setVersion(Number(result?.version) || 0);
    setPhotos(result?.photos || scan?.photos || []);
    setStatus(result?.status || "NOT_STARTED");
    setLastSavedAt(result?.lastSavedAt || null);
    setCompleted(result?.status === "COMPLETED");
    setSaveState(result?.lastSavedAt ? "Saved" : "");
    setError("");
    skipAutosave.current = true;
  }, [scan, planned, ruId]);

  function applyServer(result) {
    if (!result) return;
    setActualQty(result.actualQty == null ? String(planned) : String(result.actualQty));
    setQtyConfirmed(result.qtyConfirmed === true);
    setCondition(result.condition || "");
    setRemarks(result.remarks || "");
    setVersion(Number(result.version) || 0);
    setPhotos(result.photos || []);
    setStatus(result.status || "NOT_STARTED");
    setLastSavedAt(result.lastSavedAt || null);
    setCompleted(result.status === "COMPLETED");
    skipAutosave.current = true;
  }

  async function saveDraft({ explicit = false, qtyTouched = qtyConfirmed } = {}) {
    if (!sessionId || !ruId || locked) return null;
    setError("");
    setSaveState(explicit ? "Saving…" : "Saving…");
    try {
      const result = await apiPatch(`/receiving/sessions/${sessionId}/units/${ruId}`, {
        actualQty: actualQty === "" ? 0 : Number(actualQty),
        condition,
        remarks,
        version,
        qtyConfirmed: qtyTouched === true,
        explicit,
      });
      applyServer(result);
      setSaveState("Saved");
      onChanged?.();
      return result;
    } catch (err) {
      if (err?.code === "RECEIVING_CONFLICT" || err?.status === 409) {
        setError("This item was updated on another device. Reloading…");
        try {
          const fresh = await apiGet(`/receiving/scan/${encodeURIComponent(ru.barcodeValue || ru.ruNo)}`);
          applyServer(fresh.result);
          setSaveState("");
        } catch {
          /* keep conflict message */
        }
        return null;
      }
      setSaveState("Save failed");
      setError(err.message || "Save failed");
      return null;
    }
  }

  useEffect(() => {
    if (!open || locked) return undefined;
    if (skipAutosave.current) {
      skipAutosave.current = false;
      return undefined;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      saveDraft({ explicit: false });
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualQty, condition, remarks, qtyConfirmed, open, locked]);

  function bumpQty(delta) {
    const cur = actualQty === "" ? planned : Number(actualQty);
    const next = Math.max(0, Math.round((cur + delta) * 1e6) / 1e6);
    setActualQty(String(next));
    setQtyConfirmed(true);
  }

  async function onPickPhoto(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || locked) return;
    setPhotoBusy("Uploading…");
    setError("");
    const clientUploadId =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `up-${Date.now()}`;
    let processed;
    try {
      processed = await processReceivingPhoto(file, settings);
    } catch (err) {
      setPhotoBusy("");
      setError(err.message || "Could not process photo");
      return;
    }
    const fd = new FormData();
    fd.append("file", processed.blob, `${ru.ruNo || "ru"}.jpg`);
    fd.append("clientUploadId", clientUploadId);
    fd.append("width", String(processed.width));
    fd.append("height", String(processed.height));
    if (category) fd.append("category", category);
    try {
      const data = await apiPostFormData(
        `/receiving/sessions/${sessionId}/units/${ruId}/photos`,
        fd
      );
      applyServer(data.result);
      setPhotoBusy("Saved");
      setTimeout(() => setPhotoBusy(""), 1200);
      onChanged?.();
    } catch (err) {
      setPhotoBusy("");
      setError(err.message || "Upload failed — Retry");
    } finally {
      if (processed?.previewUrl) URL.revokeObjectURL(processed.previewUrl);
    }
  }

  async function removePhoto(photoId) {
    if (locked) return;
    try {
      const data = await apiDelete(`/receiving/sessions/${sessionId}/photos/${photoId}`);
      applyServer(data.result);
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not delete photo");
    }
  }

  async function viewPhoto(photo) {
    try {
      const data = await apiGet(`/receiving/photos/${photo._id}/url`);
      setViewer({ ...photo, url: data.url });
    } catch (err) {
      setError(err.message || "Could not open photo");
    }
  }

  async function completeItem() {
    setError("");
    const saved = await saveDraft({ explicit: true, qtyTouched: true });
    if (!saved && saveState === "Save failed") return;
    try {
      const data = await apiPost(`/receiving/sessions/${sessionId}/units/${ruId}/complete`, {
        actualQty: actualQty === "" ? 0 : Number(actualQty),
        condition,
        remarks,
        version: saved?.version ?? version,
        qtyConfirmed: true,
      });
      applyServer(data.result);
      setSaveState("Saved");
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not complete item");
    }
  }

  const photoCount = photos.length;
  const header = useMemo(
    () => ({
      ruNo: ru.ruNo,
      article: ru.article,
      partNo: ru.partNo,
      description: ru.description,
      planned,
      uom: ru.uom,
    }),
    [ru, planned]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-slate-100">
      <div className="mx-auto min-h-full max-w-xl px-4 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <button type="button" className="min-h-12 rounded-xl border bg-white px-4 font-semibold" onClick={onClose}>
            Close
          </button>
          <div className="text-right text-sm text-slate-600">
            {saveState ? <div className="font-semibold text-emerald-700">{saveState}</div> : null}
            {lastSavedAt ? <div>Last save {formatTime(lastSavedAt)}</div> : null}
          </div>
        </div>

        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <div className="font-mono text-2xl font-bold tracking-wide text-sky-900">{header.ruNo}</div>
          <div className="mt-4 grid gap-3 text-base">
            <div>
              <div className="text-xs uppercase text-slate-500">Article</div>
              <div className="font-mono text-xl font-semibold">{header.article || "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Part No.</div>
              <div className="text-lg">{header.partNo || "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Description</div>
              <div className="text-lg">{header.description || "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Expected / Planned</div>
              <div className="text-xl font-semibold">
                {header.planned} {header.uom}
              </div>
            </div>
          </div>
        </div>

        {error ? <p className="mt-3 rounded-2xl bg-red-50 p-3 text-base text-red-800">{error}</p> : null}

        <div className="mt-4 rounded-3xl border bg-white p-5">
          <div className="text-sm font-semibold uppercase text-slate-500">Actual Qty</div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="min-h-16 min-w-16 rounded-2xl bg-slate-900 text-3xl text-white disabled:opacity-40"
              disabled={locked}
              onClick={() => bumpQty(-step)}
            >
              −
            </button>
            <input
              className="min-h-16 flex-1 rounded-2xl border text-center text-3xl font-semibold"
              inputMode="decimal"
              disabled={locked}
              value={actualQty}
              onChange={(e) => {
                setActualQty(e.target.value);
                setQtyConfirmed(true);
              }}
            />
            <button
              type="button"
              className="min-h-16 min-w-16 rounded-2xl bg-slate-900 text-3xl text-white disabled:opacity-40"
              disabled={locked}
              onClick={() => bumpQty(step)}
            >
              +
            </button>
          </div>
          {!qtyConfirmed && !locked ? (
            <button
              type="button"
              className="mt-3 min-h-12 w-full rounded-xl border border-slate-300 text-base font-semibold"
              onClick={() => setQtyConfirmed(true)}
            >
              Confirm quantity
            </button>
          ) : (
            <p className="mt-2 text-sm text-emerald-700">Quantity confirmed</p>
          )}
        </div>

        <div className="mt-4 rounded-3xl border bg-white p-5">
          <div className="text-sm font-semibold uppercase text-slate-500">Condition</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {CONDITIONS.map((row) => (
              <button
                key={row.id}
                type="button"
                disabled={locked}
                className={`min-h-14 rounded-2xl border text-base font-semibold ${
                  condition === row.id ? "bg-slate-900 text-white" : "bg-white"
                }`}
                onClick={() => setCondition(row.id)}
              >
                {row.label}
              </button>
            ))}
          </div>
          <textarea
            className="mt-3 min-h-20 w-full rounded-2xl border p-3 text-base"
            placeholder="Remarks (optional)"
            disabled={locked}
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>

        <div className="mt-4 rounded-3xl border bg-white p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold uppercase text-slate-500">Photos ({photoCount})</div>
            {photoBusy ? <div className="text-sm font-semibold text-sky-800">{photoBusy}</div> : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {PHOTO_CATEGORIES.map((id) => (
              <button
                key={id}
                type="button"
                disabled={locked}
                className={`min-h-11 rounded-full border px-3 text-sm ${
                  category === id ? "bg-slate-900 text-white" : "bg-white"
                }`}
                onClick={() => setCategory(category === id ? "" : id)}
              >
                {id.replace("_", " ")}
              </button>
            ))}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPickPhoto}
          />
          <button
            type="button"
            disabled={locked}
            className="mt-3 min-h-16 w-full rounded-2xl bg-sky-700 text-lg font-semibold text-white disabled:opacity-40"
            onClick={() => fileRef.current?.click()}
          >
            {photoCount ? "Take Another" : "Take Photo"}
          </button>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {photos.map((photo) => (
              <div key={photo._id} className="overflow-hidden rounded-2xl border bg-slate-50">
                <button type="button" className="block min-h-20 w-full p-2 text-left text-xs" onClick={() => viewPhoto(photo)}>
                  <div className="font-semibold">{photo.category || "PHOTO"}</div>
                  <div className="text-slate-500">View</div>
                </button>
                {!locked ? (
                  <button
                    type="button"
                    className="min-h-11 w-full border-t text-sm text-red-700"
                    onClick={() => removePhoto(photo._id)}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-3 pb-8">
          <button
            type="button"
            disabled={locked}
            className="min-h-14 rounded-2xl border bg-white text-lg font-semibold disabled:opacity-40"
            onClick={() => saveDraft({ explicit: true })}
          >
            Save Draft
          </button>
          {locked ? (
            <button
              type="button"
              className="min-h-16 rounded-2xl bg-emerald-700 text-xl font-semibold text-white"
              onClick={onScanNext}
            >
              Scan Next
            </button>
          ) : (
            <button
              type="button"
              className="min-h-16 rounded-2xl bg-emerald-700 text-xl font-semibold text-white"
              onClick={completeItem}
            >
              Complete Item
            </button>
          )}
        </div>
      </div>

      {viewer ? (
        <div className="fixed inset-0 z-[90] flex flex-col bg-black">
          <div className="flex justify-end p-3">
            <button
              type="button"
              className="min-h-12 rounded-xl bg-white px-4 font-semibold"
              onClick={() => setViewer(null)}
            >
              Close
            </button>
          </div>
          <img src={viewer.url} alt={viewer.category || "Receiving photo"} className="max-h-[85vh] w-full object-contain" />
        </div>
      ) : null}
    </div>
  );
}
