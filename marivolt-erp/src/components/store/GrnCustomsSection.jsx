import { useRef, useState } from "react";
import { apiGet, apiPostFormData } from "../../lib/api.js";

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
 * Customs capture on GRN — header defaults apply to all lines unless overridden.
 * When any field is filled, backend enforces mandatory customs fields + date rules.
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
}) {
  const fileRefs = useRef({});
  const [uploading, setUploading] = useState("");

  const setField = (field, next) => onChange({ ...value, [field]: next });

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

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-800">Customs Information</h4>
          <p className="text-[11px] text-slate-500">
            Header defaults apply to all selected lines unless overridden per line. Leave blank to post
            without customs stock. When any customs field is entered, mandatory fields (*) and date rules
            are enforced. BL and AWB are optional (either, both, or neither).
          </p>
        </div>
      </div>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Shipment information
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
        <Field label="BOE Number" required>
          <input
            className={inputCls}
            disabled={disabled}
            value={value.boeNumber}
            onChange={(e) => setField("boeNumber", e.target.value)}
          />
        </Field>
        <Field label="BOE Date" required>
          <input
            type="date"
            className={inputCls}
            disabled={disabled}
            value={value.boeDate || ""}
            onChange={(e) => setField("boeDate", e.target.value)}
          />
        </Field>
        <Field label="BL Number">
          <input
            className={inputCls}
            disabled={disabled}
            value={value.blNumber}
            onChange={(e) => setField("blNumber", e.target.value)}
          />
        </Field>
        <Field label="AWB Number">
          <input
            className={inputCls}
            disabled={disabled}
            value={value.awbNumber}
            onChange={(e) => setField("awbNumber", e.target.value)}
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
        Customs defaults
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
        <Field label="Customs Unit Price" required>
          <input
            type="number"
            min="0"
            step="any"
            className={inputCls}
            disabled={disabled}
            value={value.customsUnitPrice ?? value.unitPrice ?? ""}
            onChange={(e) => setField("customsUnitPrice", e.target.value)}
          />
        </Field>
        <Field label="Customs Currency" required>
          <input
            className={inputCls}
            disabled={disabled}
            placeholder={defaultCurrency}
            value={value.customsCurrency || value.currency || ""}
            onChange={(e) => setField("customsCurrency", e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Exchange Rate to AED" required>
          <input
            type="number"
            min="0"
            step="any"
            className={inputCls}
            disabled={disabled}
            value={value.exchangeRateToAED || ""}
            onChange={(e) => setField("exchangeRateToAED", e.target.value)}
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
