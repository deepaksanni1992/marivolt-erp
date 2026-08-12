import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPostFormData } from "../../lib/api.js";
import { previewBoeCustomsUnitValue } from "../../lib/grnCustomsPayload.js";

const DOC_SLOTS = [
  {
    key: "blCopy",
    label: "Upload BL Copy",
    documentType: "BL/AWB",
    multiple: false,
  },
  {
    key: "supplierInvoiceCopy",
    label: "Upload Supplier Invoice Copy",
    documentType: "Supplier Invoice",
    multiple: false,
  },
  {
    key: "packingListCopy",
    label: "Upload Packing List",
    documentType: "Packing List",
    multiple: false,
  },
  {
    key: "otherDocuments",
    label: "Upload Other Document",
    documentType: "Customs Docs",
    multiple: true,
  },
];

function DocLink({ doc, onRemove, removing }) {
  if (!doc?._id) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
      <button
        type="button"
        className="text-blue-700 underline"
        onClick={async () => {
          try {
            const { url } = await apiGet(`/documents/${doc._id}/download`);
            if (url) window.open(url, "_blank", "noopener,noreferrer");
          } catch {
            if (doc.fileUrl) window.open(doc.fileUrl, "_blank", "noopener,noreferrer");
          }
        }}
      >
        {doc.originalFileName || "View file"}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="text-rose-700 underline disabled:opacity-40"
          disabled={removing}
          onClick={onRemove}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-slate-600">
        {label}
        {required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * Customs capture on GRN — Create New BOE or Select Existing BOE.
 * Supplier Invoice remains GRN-level. BOE economics freeze on parent CustomsBoe.
 */
export default function GrnCustomsSection({
  value,
  onChange,
  poId,
  poNo,
  supplierName,
  defaultCurrency = "USD",
  disabled = false,
  onError,
  /** Optional hint for THIS GRN customs qty (sum of accepted GRN qty when UOM-compatible). */
  suggestedBoeQty = null,
  thisGrnCustomsQty = null,
  validationText = "",
}) {
  const fileRefs = useRef({});
  const [uploading, setUploading] = useState("");
  const [boeSearch, setBoeSearch] = useState("");
  const [boeResults, setBoeResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [duplicates, setDuplicates] = useState([]);

  const setField = (field, next) => onChange({ ...value, [field]: next });
  const boeMode = String(value.boeMode || "CREATE").toUpperCase() === "SELECT" ? "SELECT" : "CREATE";
  const isSelect = boeMode === "SELECT";
  const previewUnit = previewBoeCustomsUnitValue(value.boeDeclaredValue, value.boeDeclaredQty);
  const trimLocal = (v) => String(v ?? "").trim();
  const thisQty = Number(thisGrnCustomsQty ?? suggestedBoeQty) || 0;
  const alreadyLinked = Number(value.linkedCustomsQty) || 0;
  const declared = Number(value.boeDeclaredQty) || 0;
  const remainingAfter =
    declared > 0 ? Math.max(0, Math.round((declared - alreadyLinked - thisQty) * 1e6) / 1e6) : null;

  const setMode = (mode) => {
    if (mode === "CREATE") {
      onChange({
        ...value,
        boeMode: "CREATE",
        customsBoeId: "",
        customsBoeRef: "",
        linkedCustomsQty: "",
      });
      setBoeResults([]);
      setDuplicates([]);
    } else {
      onChange({
        ...value,
        boeMode: "SELECT",
      });
    }
  };

  const applySelectedBoe = (boe) => {
    if (!boe) return;
    onChange({
      ...value,
      boeMode: "SELECT",
      customsBoeId: String(boe._id || ""),
      customsBoeRef: boe.customsBoeRef || "",
      boeNumber: boe.boeNumber || "",
      boeDate: boe.boeDate ? String(boe.boeDate).slice(0, 10) : value.boeDate || "",
      blNumber: boe.blNumber || "",
      awbNumber: boe.awbNumber || "",
      boeDeclaredQty: boe.boeDeclaredQty ?? "",
      boeDeclaredValue: boe.boeDeclaredValue ?? "",
      customsUom: boe.customsUom || "PCS",
      customsCurrency: boe.customsCurrency || "",
      exchangeRateToAED: boe.exchangeRateToAED ?? "",
      grossWeightKg: boe.grossWeightKg ?? "",
      netWeightKg: boe.netWeightKg ?? "",
      linkedCustomsQty: boe.linkedCustomsQty ?? 0,
    });
    setBoeResults([]);
    setDuplicates([]);
  };

  useEffect(() => {
    if (!isSelect || disabled) return undefined;
    const q = trimLocal(boeSearch);
    if (q.length < 2) {
      setBoeResults([]);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiGet(`/customs/boes?q=${encodeURIComponent(q)}&limit=15`);
        if (!cancelled) setBoeResults(res.items || []);
      } catch (e) {
        if (!cancelled) onError?.(e.message || String(e));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [boeSearch, isSelect, disabled]);

  const checkDuplicates = async () => {
    if (isSelect || disabled) return;
    const boeNumber = trimLocal(value.boeNumber);
    const blNumber = trimLocal(value.blNumber);
    if (!boeNumber && !blNumber) {
      setDuplicates([]);
      return;
    }
    try {
      const res = await apiPost("/customs/boes/check-duplicates", { boeNumber, blNumber });
      setDuplicates(res.items || []);
    } catch {
      setDuplicates([]);
    }
  };

  const uploadFile = async (file, slot) => {
    if (!file) return;
    setUploading(slot.key);
    onError?.("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("documentType", slot.documentType);
      fd.append("moduleName", "STORE");
      fd.append("relatedId", String(poId || ""));
      fd.append("refNo", poNo || "");
      fd.append("partyName", supplierName || "");
      fd.append("referenceType", "GRN_CUSTOMS");
      const uploaded = await apiPostFormData("/documents/upload", fd);
      const entry = {
        _id: uploaded._id,
        fileUrl: uploaded.fileUrl,
        originalFileName: uploaded.originalFileName,
      };
      onChange({
        ...value,
        documents: {
          ...value.documents,
          [slot.key]: slot.multiple ? [...(value.documents?.[slot.key] || []), entry] : entry,
        },
      });
    } catch (e) {
      onError?.(e.message || String(e));
    } finally {
      setUploading("");
    }
  };

  const removeDoc = (slotKey, index = null) => {
    const docs = { ...(value.documents || {}) };
    if (slotKey === "otherDocuments" && Array.isArray(docs.otherDocuments)) {
      docs.otherDocuments = docs.otherDocuments.filter((_, i) => i !== index);
    } else {
      docs[slotKey] = slotKey === "otherDocuments" ? [] : null;
    }
    onChange({ ...value, documents: docs });
  };

  const inputCls = "w-full rounded border px-2 py-1.5 text-sm disabled:bg-slate-50";
  const readOnlyCls = `${inputCls} bg-slate-100`;

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-800">Customs Information</h4>
          <p className="text-[11px] text-slate-500">
            One Customs BOE can span many PO-based GRNs. Create a new BOE or select an existing one. Supplier
            Invoice stays on this GRN. Customs unit value is frozen on the BOE parent.
          </p>
        </div>
      </div>

      {validationText ? (
        <div className="mb-3 whitespace-pre-line rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {validationText}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          className={`rounded border px-3 py-1.5 text-xs font-semibold ${
            !isSelect ? "border-sky-600 bg-sky-50 text-sky-900" : "border-slate-300 bg-white text-slate-700"
          }`}
          onClick={() => setMode("CREATE")}
        >
          Create New BOE
        </button>
        <button
          type="button"
          disabled={disabled}
          className={`rounded border px-3 py-1.5 text-xs font-semibold ${
            isSelect ? "border-sky-600 bg-sky-50 text-sky-900" : "border-slate-300 bg-white text-slate-700"
          }`}
          onClick={() => setMode("SELECT")}
        >
          Select Existing BOE
        </button>
      </div>

      {isSelect ? (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
          <Field label="Search Customs BOE (Ref / BOE No / BL)">
            <input
              className={inputCls}
              disabled={disabled}
              value={boeSearch}
              placeholder="MAR-BOE-0001 or 511685"
              onChange={(e) => setBoeSearch(e.target.value)}
            />
          </Field>
          {searching ? <p className="mt-1 text-[11px] text-slate-500">Searching…</p> : null}
          {boeResults.length ? (
            <ul className="mt-2 max-h-40 overflow-auto rounded border border-slate-100 text-xs">
              {boeResults.map((b) => (
                <li key={String(b._id)}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 border-b border-slate-50 px-2 py-1.5 text-left hover:bg-sky-50"
                    onClick={() => applySelectedBoe(b)}
                  >
                    <span className="font-semibold text-slate-800">
                      {b.customsBoeRef} · BOE {b.boeNumber || "—"}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      BL {b.blNumber || "—"} · Declared {b.boeDeclaredQty} {b.customsUom || "PCS"} · Unit{" "}
                      {b.customsUnitValue} {b.customsCurrency} · Linked {b.linkedCustomsQty ?? 0} · Remaining{" "}
                      {b.remainingToLink ?? "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {value.customsBoeRef ? (
            <div className="mt-3 grid gap-2 rounded border border-emerald-100 bg-emerald-50/60 p-2 text-xs text-emerald-950 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-[10px] uppercase text-emerald-700">BOE Ref</div>
                <div className="font-semibold">{value.customsBoeRef}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-emerald-700">Declared</div>
                <div className="font-semibold">
                  {value.boeDeclaredQty} {value.customsUom || "PCS"} / {value.boeDeclaredValue}{" "}
                  {value.customsCurrency}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-emerald-700">Unit Value</div>
                <div className="font-semibold">
                  {previewUnit != null ? `${previewUnit} ${value.customsCurrency || ""}` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-emerald-700">Linking</div>
                <div className="font-semibold">
                  Already {alreadyLinked} · This GRN {thisQty || "—"} · Remaining{" "}
                  {remainingAfter != null ? remainingAfter : "—"}
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-amber-700">Select an existing Customs BOE to continue.</p>
          )}
        </div>
      ) : null}

      {!isSelect && duplicates.length ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className="font-semibold">Possible existing BOE found</div>
          <ul className="mt-1 space-y-1">
            {duplicates.map((d) => (
              <li key={String(d._id)} className="flex flex-wrap items-center gap-2">
                <span>
                  {d.customsBoeRef} · BOE {d.boeNumber} · BL {d.blNumber || "—"}
                </span>
                <button
                  type="button"
                  className="rounded border border-amber-400 px-2 py-0.5 text-[11px] font-semibold"
                  onClick={() => applySelectedBoe(d)}
                >
                  Use Existing BOE
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        GRN receipt (Supplier Invoice)
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Received Date" required>
          <input
            type="date"
            className={inputCls}
            disabled={disabled}
            value={value.receivedDate || ""}
            onChange={(e) => setField("receivedDate", e.target.value)}
          />
        </Field>
        <Field label="Supplier Invoice Number" required>
          <input
            className={inputCls}
            disabled={disabled}
            value={value.supplierInvoiceNumber}
            onChange={(e) => setField("supplierInvoiceNumber", e.target.value)}
          />
        </Field>
        <Field label="Supplier Invoice Date" required>
          <input
            type="date"
            className={inputCls}
            disabled={disabled}
            value={value.supplierInvoiceDate || ""}
            onChange={(e) => setField("supplierInvoiceDate", e.target.value)}
          />
        </Field>
      </div>

      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {isSelect ? "BOE identity (read-only from parent)" : "BOE identity"}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="BOE Number" required={!isSelect}>
          <input
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.boeNumber}
            onChange={(e) => setField("boeNumber", e.target.value)}
            onBlur={checkDuplicates}
          />
        </Field>
        <Field label="BOE Date" required={!isSelect}>
          <input
            type="date"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.boeDate || ""}
            onChange={(e) => setField("boeDate", e.target.value)}
          />
        </Field>
        <Field label="BL Number">
          <input
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.blNumber}
            onChange={(e) => setField("blNumber", e.target.value)}
            onBlur={checkDuplicates}
          />
        </Field>
        <Field label="AWB Number">
          <input
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.awbNumber}
            onChange={(e) => setField("awbNumber", e.target.value)}
          />
        </Field>
      </div>

      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        BOE valuation {isSelect ? "(frozen)" : ""}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="BOE Declared Customs Qty" required={!isSelect}>
          <input
            type="number"
            min="0"
            step="any"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            placeholder={!isSelect && suggestedBoeQty > 0 ? String(suggestedBoeQty) : ""}
            value={value.boeDeclaredQty ?? ""}
            onChange={(e) => setField("boeDeclaredQty", e.target.value)}
            onBlur={() => {
              if (!isSelect && !trimLocal(value.boeDeclaredQty) && suggestedBoeQty > 0) {
                setField("boeDeclaredQty", String(suggestedBoeQty));
              }
            }}
          />
        </Field>
        <Field label="Customs UOM" required={!isSelect}>
          <input
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.customsUom || "PCS"}
            onChange={(e) => setField("customsUom", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="BOE Declared Value" required={!isSelect}>
          <input
            type="number"
            min="0"
            step="any"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.boeDeclaredValue ?? ""}
            onChange={(e) => setField("boeDeclaredValue", e.target.value)}
          />
        </Field>
        <Field label="BOE Customs Unit Value">
          <input
            type="text"
            className={readOnlyCls}
            disabled
            readOnly
            value={
              previewUnit != null
                ? `${previewUnit}${value.customsCurrency || defaultCurrency ? ` ${String(value.customsCurrency || defaultCurrency).toUpperCase()}` : ""}`
                : "—"
            }
          />
          <span className="mt-0.5 block text-[10px] text-slate-500">
            Calculated once on the Customs BOE parent (server authoritative)
          </span>
        </Field>
        <Field label="Gross Weight (KG)">
          <input
            type="number"
            min="0"
            step="any"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.grossWeightKg ?? ""}
            onChange={(e) => setField("grossWeightKg", e.target.value)}
          />
        </Field>
        <Field label="Net Weight (KG)">
          <input
            type="number"
            min="0"
            step="any"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.netWeightKg ?? ""}
            onChange={(e) => setField("netWeightKg", e.target.value)}
          />
        </Field>
        <Field label="Customs Currency" required={!isSelect}>
          <input
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            placeholder={defaultCurrency}
            value={value.customsCurrency || value.currency || ""}
            onChange={(e) => setField("customsCurrency", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Exchange Rate to AED" required={!isSelect}>
          <input
            type="number"
            min="0"
            step="any"
            className={isSelect ? readOnlyCls : inputCls}
            disabled={disabled || isSelect}
            readOnly={isSelect}
            value={value.exchangeRateToAED || ""}
            onChange={(e) => setField("exchangeRateToAED", e.target.value)}
          />
        </Field>
      </div>

      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Article defaults
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Country of Origin" required>
          <input
            className={inputCls}
            disabled={disabled}
            value={value.countryOfOrigin}
            onChange={(e) => setField("countryOfOrigin", e.target.value)}
          />
        </Field>
        <Field label="HS Code" required>
          <input
            className={inputCls}
            disabled={disabled}
            value={value.hsCode}
            onChange={(e) => setField("hsCode", e.target.value)}
          />
        </Field>
        <Field label="Unit Weight (KG)">
          <input
            type="number"
            min="0"
            step="any"
            className={inputCls}
            disabled={disabled}
            value={value.unitWeightKg ?? value.weightKg ?? ""}
            onChange={(e) => setField("unitWeightKg", e.target.value)}
          />
        </Field>
        <Field label="Customs Remarks">
          <input
            className={inputCls}
            disabled={disabled}
            value={value.customsRemarks ?? value.remarks ?? ""}
            onChange={(e) => setField("customsRemarks", e.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-600">
        <p className="w-full text-[10px] text-slate-500">
          Date overrides require STORE approve permission on the server. Checking a box alone does not grant
          authorisation.
        </p>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(value.allowBoeBeforePoDate)}
            onChange={(e) => setField("allowBoeBeforePoDate", e.target.checked)}
          />
          Request: authorise BOE Date before PO date
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(value.allowInvoiceAfterReceivedDate)}
            onChange={(e) => setField("allowInvoiceAfterReceivedDate", e.target.checked)}
          />
          Request: authorise Supplier Invoice Date after Received Date
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(value.allowFutureReceivedDate)}
            onChange={(e) => setField("allowFutureReceivedDate", e.target.checked)}
          />
          Request: authorise future Received Date
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {DOC_SLOTS.map((slot) => (
          <div key={slot.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs font-medium text-slate-700">{slot.label}</div>
            <input
              ref={(el) => {
                fileRefs.current[slot.key] = el;
              }}
              type="file"
              className="mt-2 block w-full text-[11px]"
              disabled={disabled || uploading === slot.key}
              onChange={(e) => {
                const file = e.target.files?.[0];
                uploadFile(file, slot);
                e.target.value = "";
              }}
            />
            {uploading === slot.key ? <p className="mt-1 text-[11px] text-slate-500">Uploading…</p> : null}
            {slot.multiple ? (
              (value.documents?.otherDocuments || []).map((doc, idx) => (
                <DocLink
                  key={`${doc._id}-${idx}`}
                  doc={doc}
                  removing={Boolean(uploading)}
                  onRemove={() => removeDoc("otherDocuments", idx)}
                />
              ))
            ) : (
              <DocLink
                doc={value.documents?.[slot.key]}
                removing={Boolean(uploading)}
                onRemove={() => removeDoc(slot.key)}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
