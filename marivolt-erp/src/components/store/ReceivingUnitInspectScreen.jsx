import { useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostFormData } from "../../lib/api.js";
import { allGoodDisposition, dispositionTotal, notReceivedDisposition, suggestConditionFromDisposition } from "../../lib/receivingDisposition.js";
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
  const [actualUnitWeightKg, setActualUnitWeightKg] = useState("");
  const [qtyConfirmed, setQtyConfirmed] = useState(false);
  const [condition, setCondition] = useState("");
  const [acceptedQty, setAcceptedQty] = useState("");
  const [damagedQty, setDamagedQty] = useState("");
  const [rejectedQty, setRejectedQty] = useState("");
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
    setActualUnitWeightKg(
      result?.actualUnitWeightKg == null || result?.actualUnitWeightKg === ""
        ? ""
        : String(result.actualUnitWeightKg),
    );
    setQtyConfirmed(result?.qtyConfirmed === true);
    setCondition(result?.condition || "");
    setAcceptedQty(result?.acceptedQty == null ? "" : String(result.acceptedQty));
    setDamagedQty(result?.damagedQty == null ? "" : String(result.damagedQty));
    setRejectedQty(result?.rejectedQty == null ? "" : String(result.rejectedQty));
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
    setActualUnitWeightKg(
      result.actualUnitWeightKg == null || result.actualUnitWeightKg === ""
        ? ""
        : String(result.actualUnitWeightKg),
    );
    setQtyConfirmed(result.qtyConfirmed === true);
    setCondition(result.condition || "");
    setAcceptedQty(result.acceptedQty == null ? "" : String(result.acceptedQty));
    setDamagedQty(result.damagedQty == null ? "" : String(result.damagedQty));
    setRejectedQty(result.rejectedQty == null ? "" : String(result.rejectedQty));
    setRemarks(result.remarks || "");
    setVersion(Number(result.version) || 0);
    setPhotos(result.photos || []);
    setStatus(result.status || "NOT_STARTED");
    setLastSavedAt(result.lastSavedAt || null);
    setCompleted(result.status === "COMPLETED");
    skipAutosave.current = true;
  }

  function dispositionFields() {
    if (Number(actualQty) === 0) {
      return { acceptedQty: 0, damagedQty: 0, rejectedQty: 0 };
    }
    if (acceptedQty === "" && damagedQty === "" && rejectedQty === "") return {};
    return {
      acceptedQty: Number(acceptedQty || 0),
      damagedQty: Number(damagedQty || 0),
      rejectedQty: Number(rejectedQty || 0),
    };
  }

  async function saveDraft({ explicit = false, qtyTouched } = {}) {
    if (!sessionId || !ruId || locked) return null;
    setError("");
    setSaveState(explicit ? "Saving…" : "Saving…");
    try {
      const result = await apiPatch(`/receiving/sessions/${sessionId}/units/${ruId}`, {
        actualQty: actualQty === "" ? 0 : Number(actualQty),
        actualUnitWeightKg:
          actualUnitWeightKg === "" ? null : Number(actualUnitWeightKg),
        ...dispositionFields(),
        condition: actualQty !== "" && Number(actualQty) === 0 ? "NOT_RECEIVED" : condition,
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
  }, [actualQty, actualUnitWeightKg, acceptedQty, damagedQty, rejectedQty, condition, remarks, qtyConfirmed, open, locked]);

  function bumpQty(delta) {
    const cur = actualQty === "" ? planned : Number(actualQty);
    const next = Math.max(0, Math.round((cur + delta) * 1e6) / 1e6);
    setActualQty(String(next));
    setQtyConfirmed(true);
    if (next === 0) {
      applyNotReceived();
      return;
    }
    if (condition === "NOT_RECEIVED" || condition === "GOOD" || acceptedQty === "" || Number(acceptedQty) === Number(actualQty || planned)) {
      applyAllGood(next);
    }
  }

  function applyNotReceived() {
    const next = notReceivedDisposition();
    setQtyConfirmed(true);
    setAcceptedQty("0");
    setDamagedQty("0");
    setRejectedQty("0");
    setCondition(next.condition);
  }

  function applyAllGood(qty = actualQty === "" ? planned : Number(actualQty)) {
    if (Number(qty) === 0) {
      applyNotReceived();
      return;
    }
    const next = allGoodDisposition(qty);
    setQtyConfirmed(true);
    setAcceptedQty(String(next.acceptedQty));
    setDamagedQty("0");
    setRejectedQty("0");
    if (next.condition) setCondition(next.condition);
  }

  function applyCondition(id) {
    const actual = actualQty === "" ? planned : Number(actualQty);
    if (actual === 0) {
      applyNotReceived();
      return;
    }
    setCondition(id);
    if (id === "GOOD") applyAllGood(actual);
    else if (id === "DAMAGED") {
      setAcceptedQty("0");
      setDamagedQty(String(actual));
      setRejectedQty("0");
    } else if (id === "REJECTED") {
      setAcceptedQty("0");
      setDamagedQty("0");
      setRejectedQty(String(actual));
    }
  }

  function applyBuckets(nextAccepted, nextDamaged, nextRejected) {
    setAcceptedQty(String(nextAccepted));
    setDamagedQty(String(nextDamaged));
    setRejectedQty(String(nextRejected));
    const suggested = suggestConditionFromDisposition(actualQty === "" ? planned : actualQty, nextAccepted, nextDamaged, nextRejected);
    if (suggested) setCondition(suggested);
  }

  function bumpBucket(field, delta) {
    const a = Number(acceptedQty || 0);
    const d = Number(damagedQty || 0);
    const r = Number(rejectedQty || 0);
    const cur = field === "accepted" ? a : field === "damaged" ? d : r;
    const next = Math.max(0, Math.round((cur + delta) * 1e6) / 1e6);
    applyBuckets(field === "accepted" ? next : a, field === "damaged" ? next : d, field === "rejected" ? next : r);
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
        actualUnitWeightKg:
          actualUnitWeightKg === "" ? null : Number(actualUnitWeightKg),
        ...dispositionFields(),
        condition: actualQty !== "" && Number(actualQty) === 0 ? "NOT_RECEIVED" : condition,
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
  const actualN = actualQty === "" ? planned : Number(actualQty) || 0;
  const dispTotal = dispositionTotal(acceptedQty, damagedQty, rejectedQty);
  const dispOk = Math.abs(dispTotal - actualN) < 1e-6;
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
                if (e.target.value !== "" && Number(e.target.value) === 0) applyNotReceived();
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
              onClick={() => {
                setQtyConfirmed(true);
                if (Number(actualQty === "" ? planned : actualQty) === 0) applyNotReceived();
              }}
            >
              Confirm quantity
            </button>
          ) : (
            <p className="mt-2 text-sm text-emerald-700">Quantity confirmed</p>
          )}
          {actualN > 0 ? (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <div className="text-sm font-semibold uppercase text-slate-500">Actual Unit Weight (KG)</div>
              <p className="mt-1 text-xs text-slate-500">
                Warehouse physical weight per unit. Not BOE customs declared weight.
              </p>
              <input
                className="mt-2 min-h-14 w-full rounded-2xl border text-center text-2xl font-semibold"
                inputMode="decimal"
                disabled={locked}
                value={actualUnitWeightKg}
                placeholder="e.g. 2.350"
                onChange={(e) => setActualUnitWeightKg(e.target.value)}
              />
              {Number(actualUnitWeightKg) > 0 && actualN > 0 ? (
                <p className="mt-2 text-sm text-slate-600">
                  Calculated total actual weight:{" "}
                  <span className="font-semibold tabular-nums">
                    {(Math.round(Number(actualUnitWeightKg) * actualN * 1000) / 1000).toFixed(3)} KG
                  </span>{" "}
                  (informational only)
                </p>
              ) : null}
            </div>
          ) : null}
          {!locked && actualN > 0 ? (
            <button
              type="button"
              className="mt-3 min-h-16 w-full rounded-2xl bg-emerald-800 text-xl font-bold text-white"
              onClick={() => applyAllGood()}
            >
              All Good
            </button>
          ) : null}
          {actualN === 0 ? (
            <div className="mt-3 rounded-2xl bg-amber-50 p-4">
              <div className="text-lg font-bold text-amber-950">Nothing Received / Not Found</div>
              <p className="mt-1 text-sm text-amber-900">
                Condition: NOT_RECEIVED. Missing goods are a shortage, not a rejection.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1 text-sm">
                <div>Accepted 0</div>
                <div>Damaged 0</div>
                <div>Rejected 0</div>
                <div>Short {header.planned}</div>
              </div>
            </div>
          ) : null}
        </div>

        {actualN > 0 ? (
        <div className="mt-4 rounded-3xl border bg-white p-5">
          <div className="text-sm font-semibold uppercase text-slate-500">Disposition</div>
          <p className="mt-1 text-sm text-slate-600">
            Disposition total: {dispTotal} / {actualN} {header.uom}
            {!dispOk ? <span className="ml-2 font-semibold text-amber-800">must equal actual qty</span> : null}
          </p>
          {[
            ["Accepted", acceptedQty, setAcceptedQty, "accepted"],
            ["Damaged", damagedQty, setDamagedQty, "damaged"],
            ["Rejected", rejectedQty, setRejectedQty, "rejected"],
          ].map(([label, value, setter, field]) => (
            <div key={field} className="mt-3">
              <div className="text-sm font-semibold text-slate-600">{label}</div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="min-h-14 min-w-14 rounded-2xl bg-slate-900 text-2xl text-white disabled:opacity-40"
                  disabled={locked}
                  onClick={() => bumpBucket(field, -step)}
                >
                  −
                </button>
                <input
                  className="min-h-14 flex-1 rounded-2xl border text-center text-2xl font-semibold"
                  inputMode="decimal"
                  disabled={locked}
                  value={value}
                  onChange={(e) => {
                    const next = e.target.value;
                    const a = field === "accepted" ? next : acceptedQty;
                    const d = field === "damaged" ? next : damagedQty;
                    const r = field === "rejected" ? next : rejectedQty;
                    setter(next);
                    const suggested = suggestConditionFromDisposition(actualQty === "" ? planned : actualQty, a, d, r);
                    if (suggested) setCondition(suggested);
                  }}
                />
                <button
                  type="button"
                  className="min-h-14 min-w-14 rounded-2xl bg-slate-900 text-2xl text-white disabled:opacity-40"
                  disabled={locked}
                  onClick={() => bumpBucket(field, step)}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        ) : null}

        <div className="mt-4 rounded-3xl border bg-white p-5">
          {actualN > 0 ? (
            <>
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
                onClick={() => applyCondition(row.id)}
              >
                {row.label}
              </button>
            ))}
          </div>
            </>
          ) : (
            <div className="text-sm font-semibold uppercase text-slate-500">Remarks required</div>
          )}
          <textarea
            className="mt-3 min-h-20 w-full rounded-2xl border p-3 text-base"
            placeholder={
              actualN === 0
                ? "Remarks required — e.g. Packet missing from shipment"
                : dispOk && Number(damagedQty || 0) === 0 && Number(rejectedQty || 0) === 0 && actualN === planned
                  ? "Remarks (optional)"
                  : "Remarks required for shortage, excess, damage, rejection, or zero qty"
            }
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
          {Number(damagedQty || 0) > 0 ? (
            <p className="mt-2 text-sm font-semibold text-amber-800">Damaged qty requires a DAMAGE photo before Complete Item.</p>
          ) : null}
          {actualN === 0 ? (
            <p className="mt-2 text-sm text-slate-600">A packing/package photo is useful evidence even when quantity is 0.</p>
          ) : null}
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
              disabled={!dispOk}
              className="min-h-16 rounded-2xl bg-emerald-700 text-xl font-semibold text-white disabled:opacity-40"
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
