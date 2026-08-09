import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Modal from "../erp/Modal.jsx";
import { FormField, TextInput } from "../erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPost } from "../../lib/api.js";
import {
  buildOaWorkingCsvPreview,
  exportOaWorkingLinesCsv,
  parseOaWorkingCsvFile,
} from "../../lib/oaWorkingCopyCsv.js";
import CustomerTransactionDetailsFields from "./CustomerTransactionDetailsFields.jsx";

export function emptyOaWorkingLine() {
  return {
    serialNo: 1,
    sourceQuotationLineId: "",
    article: "",
    partNumber: "",
    description: "",
    uom: "PCS",
    quotedQty: null,
    orderedQty: 1,
    quotedPrice: null,
    orderedPrice: 0,
    includeInOA: true,
    isNewLine: true,
    discount: 0,
    tax: 0,
    remarks: "",
    materialCode: "",
    availability: "",
    supplierInfo: "",
  };
}

export function defaultOaForm() {
  return {
    oaSourceType: "BLANK",
    sourceQuotationId: "",
    sourceQuotationNo: "",
    oaNo: "",
    oaDate: new Date().toISOString().slice(0, 10),
    customerName: "",
    customerReference: "",
    customerPORef: "",
    contactPerson: "",
    attention: "",
    billingAddress: "",
    shippingAddress: "",
    paymentTerms: "",
    deliverySchedule: "",
    acknowledgementNotes: "",
    termsAndConditions: "",
    incoterm: "",
    currency: "USD",
    vertical: "",
    engine: "",
    model: "",
    config: "",
    esn: "",
    discountType: "NONE",
    discountValue: 0,
    packingCost: 0,
    clearanceCost: 0,
    taxTotal: 0,
    lines: [emptyOaWorkingLine()],
  };
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeWorkingSubtotal(lines) {
  return (lines || [])
    .filter((l) => l.includeInOA !== false)
    .reduce((sum, l) => sum + (Number(l.orderedQty) || 0) * (Number(l.orderedPrice) || 0), 0);
}

function computeWorkingGrandTotal(form) {
  const sub = computeWorkingSubtotal(form.lines);
  const discountType = String(form.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(form.discountValue) || 0);
  let discountTotal = 0;
  if (discountType === "PERCENT") discountTotal = Math.min(sub, (sub * discountValue) / 100);
  else if (discountType === "FLAT") discountTotal = Math.min(sub, discountValue);
  const taxTotal = Math.max(0, Number(form.taxTotal) || 0);
  const packingCost = Math.max(0, Number(form.packingCost) || 0);
  const clearanceCost = Math.max(0, Number(form.clearanceCost) || 0);
  return sub - discountTotal + taxTotal + packingCost + clearanceCost;
}

function buildOaCreatePayload(form, { allowOverOrder = false, allowStaleConsumption = false } = {}) {
  return {
    oaSourceType: form.oaSourceType || "BLANK",
    linkedQuotationId: form.sourceQuotationId || undefined,
    linkedQuotationNo: form.sourceQuotationNo || undefined,
    _sourceMetadata: form._sourceMetadata,
    sourceMetadata: form._sourceMetadata,
    consumptionBaseline: form.consumptionBaseline,
    allowOverOrder: allowOverOrder === true,
    allowStaleConsumption: allowStaleConsumption === true,
    oaNo: String(form.oaNo || "").trim() || undefined,
    oaDate: form.oaDate,
    customerName: form.customerName,
    customerPORef: form.customerReference || form.customerPORef || "",
    contactPerson: form.contactPerson || "",
    attention: form.attention || "",
    billingAddress: form.billingAddress || "",
    shippingAddress: form.shippingAddress || "",
    paymentTerms: form.paymentTerms || "",
    deliverySchedule: form.deliverySchedule || "",
    acknowledgementNotes: form.acknowledgementNotes || "",
    termsAndConditions: form.termsAndConditions || "",
    incoterm: form.incoterm || "",
    currency: form.currency,
    vertical: form.vertical || "",
    engine: form.engine || "",
    model: form.model || "",
    config: form.config || "",
    esn: form.esn || "",
    discountType: form.discountType || "NONE",
    discountValue: Number(form.discountValue) || 0,
    packingCost: Number(form.packingCost) || 0,
    clearanceCost: Number(form.clearanceCost) || 0,
    taxTotal: Number(form.taxTotal) || 0,
    lines: form.lines,
  };
}

const defaultSearch = () => ({
  quotationNo: "",
  customerName: "",
  customerRef: "",
  vertical: "",
  brand: "",
  model: "",
  esn: "",
  status: "",
  dateFrom: "",
  dateTo: "",
  currency: "",
});

function findClientOverOrderViolations(lines) {
  const violations = [];
  for (const line of lines || []) {
    if (line.includeInOA === false) continue;
    const orderedQty = Number(line.orderedQty) || 0;
    if (orderedQty <= 0) continue;
    const remainingQty = line.remainingQty != null ? Number(line.remainingQty) : null;
    if (remainingQty == null) continue;
    if (orderedQty > remainingQty + 1e-9) {
      violations.push({
        article: line.article,
        partNumber: line.partNumber || "",
        quotedQty: line.quotedQty,
        alreadyOrderedQty: line.alreadyOrderedQty,
        remainingQty,
        orderedQty,
        excessQty: orderedQty - remainingQty,
      });
    }
  }
  return violations;
}

export default function OaCreateModal({ open, onClose, initialForm, onSuccess, onError }) {
  const [form, setForm] = useState(defaultOaForm);
  const [search, setSearch] = useState(defaultSearch);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [csvPreview, setCsvPreview] = useState(null);
  const [overOrderConfirm, setOverOrderConfirm] = useState(null);
  const [staleConsumptionConfirm, setStaleConsumptionConfirm] = useState(null);
  const [selectingQuotation, setSelectingQuotation] = useState(false);
  const [refreshingConsumption, setRefreshingConsumption] = useState(false);
  const csvInputRef = useRef(null);
  const linesRef = useRef(form.lines);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    linesRef.current = form.lines;
  }, [form.lines]);

  useEffect(() => {
    if (!open) return;
    if (initialForm) {
      setForm({
        ...defaultOaForm(),
        ...initialForm,
        lines: initialForm.lines?.length ? initialForm.lines : [emptyOaWorkingLine()],
      });
    } else {
      setForm(defaultOaForm());
    }
    setSearch(defaultSearch());
    setSearchResults([]);
    setSearchAttempted(false);
    setCsvPreview(null);
    setOverOrderConfirm(null);
    setStaleConsumptionConfirm(null);
  }, [open, initialForm]);

  const fromQuotation = form.oaSourceType === "FROM_QUOTATION";
  const overOrderViolations = useMemo(
    () => (fromQuotation ? findClientOverOrderViolations(form.lines) : []),
    [fromQuotation, form.lines]
  );
  const workingSubtotal = useMemo(() => computeWorkingSubtotal(form.lines), [form.lines]);
  const workingGrandTotal = useMemo(() => computeWorkingGrandTotal(form), [form]);

  const createMutation = useMutation({
    mutationFn: (payload) => apiPost("/sales/order-acknowledgements", payload),
    onSuccess: (doc) => {
      onSuccess?.(doc);
      onClose?.();
    },
    onError: (e) => {
      if (e.code === "OVER_ORDER" && Array.isArray(e.body?.violations)) {
        setOverOrderConfirm({ violations: e.body.violations, fromServer: true });
        return;
      }
      if (e.code === "STALE_CONSUMPTION" && Array.isArray(e.body?.reasons)) {
        setStaleConsumptionConfirm({ reasons: e.body.reasons, fromServer: true });
        return;
      }
      if (e.code === "STALE_CONSUMPTION" && Array.isArray(e.reasons)) {
        setStaleConsumptionConfirm({ reasons: e.reasons, fromServer: true });
        return;
      }
      onError?.(e.message || "Failed to create OA");
    },
  });

  const submitOa = (allowOverOrder = false, allowStaleConsumption = false) => {
    if (createMutation.isPending) return;
    const violations = fromQuotation ? findClientOverOrderViolations(form.lines) : [];
    if (violations.length && !allowOverOrder) {
      setOverOrderConfirm({ violations, fromServer: false });
      return;
    }
    createMutation.mutate(buildOaCreatePayload(form, { allowOverOrder, allowStaleConsumption }));
  };

  const refreshConsumption = async () => {
    if (!form.sourceQuotationId) return;
    setRefreshingConsumption(true);
    try {
      const working = await apiGet(`/quotations/${form.sourceQuotationId}/oa-source`);
      if (!mountedRef.current) return;
      setForm((f) => ({
        ...f,
        consumptionSummary: working.consumptionSummary,
        consumptionBaseline: working.consumptionBaseline,
        lines: (f.lines || []).map((line, idx) => {
          const src = (working.lines || []).find(
            (wl) =>
              String(wl.sourceQuotationLineId || "") === String(line.sourceQuotationLineId || "") ||
              (wl.article === line.article && wl.partNumber === line.partNumber)
          );
          if (!src) return line;
          return {
            ...line,
            quotedQty: src.quotedQty,
            alreadyOrderedQty: src.alreadyOrderedQty,
            remainingQty: src.remainingQty,
            serialNo: idx + 1,
          };
        }),
      }));
    } catch (e) {
      onError?.(e.message || "Failed to refresh remaining quantities");
    } finally {
      if (mountedRef.current) setRefreshingConsumption(false);
    }
  };

  const runSearch = async () => {
    setSearchLoading(true);
    setSearchResults([]);
    setSearchAttempted(true);
    try {
      const data = await apiGetWithQuery("/quotations/search-for-oa", {
        ...search,
        page: 1,
        limit: 50,
      });
      if (!mountedRef.current) return;
      setSearchResults(data?.items || []);
    } catch (e) {
      if (mountedRef.current) onError?.(e.message);
    } finally {
      if (mountedRef.current) setSearchLoading(false);
    }
  };

  const selectQuotation = async (id) => {
    setSelectingQuotation(true);
    try {
      const working = await apiGet(`/quotations/${id}/oa-source`);
      if (!mountedRef.current) return;
      setForm({
        ...defaultOaForm(),
        ...working,
        oaSourceType: "FROM_QUOTATION",
        billingAddress: working.billingAddress || working.customer?.billingAddress || "",
        shippingAddress: working.shippingAddress || working.customer?.shippingAddress || "",
        contactPerson: working.contactPerson || working.customer?.contactPerson || working.customer?.contactName || "",
        attention: working.attention || working.customer?.attention || "",
        paymentTerms: working.paymentTerms || "",
        lines: working.lines?.length ? working.lines : [emptyOaWorkingLine()],
      });
    } catch (e) {
      if (mountedRef.current) onError?.(e.message);
    } finally {
      if (mountedRef.current) setSelectingQuotation(false);
    }
  };

  const updateLine = (idx, patch) => {
    setForm((f) => {
      const lines = [...f.lines];
      lines[idx] = { ...lines[idx], ...patch };
      return { ...f, lines };
    });
  };

  const handleCsvImport = async (file) => {
    if (!file) return;
    try {
      const imported = await parseOaWorkingCsvFile(file);
      if (!imported.length) {
        onError?.("No valid lines found in CSV");
        return;
      }
      const preview = buildOaWorkingCsvPreview(linesRef.current, imported);
      setCsvPreview(preview);
    } catch (e) {
      onError?.(e.message || "Failed to parse CSV");
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  const confirmCsvImport = () => {
    if (!csvPreview?.mergedLines) return;
    setForm((f) => ({ ...f, lines: csvPreview.mergedLines }));
    setCsvPreview(null);
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title="New Order Acknowledgement" wide>
        <div className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 ring-1 ring-sky-200">
          This OA is created as a new transaction snapshot. The original quotation will not be changed.
        </div>

        <FormField label="Source Type">
          <select
            className="w-full rounded-xl border px-3 py-2 text-sm"
            value={form.oaSourceType}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "BLANK") {
                setForm(defaultOaForm());
              } else {
                setForm((f) => ({ ...f, oaSourceType: "FROM_QUOTATION" }));
              }
            }}
          >
            <option value="BLANK">Blank OA</option>
            <option value="FROM_QUOTATION">From Quotation</option>
          </select>
        </FormField>

        {fromQuotation && !form.sourceQuotationId ? (
          <div className="mt-4 space-y-3 rounded-xl border bg-gray-50 p-3">
            <div className="text-sm font-medium">Search Quotation</div>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <FormField label="Quotation No">
                <TextInput value={search.quotationNo} onChange={(e) => setSearch((s) => ({ ...s, quotationNo: e.target.value }))} />
              </FormField>
              <FormField label="Customer">
                <TextInput value={search.customerName} onChange={(e) => setSearch((s) => ({ ...s, customerName: e.target.value }))} />
              </FormField>
              <FormField label="Customer Ref">
                <TextInput value={search.customerRef} onChange={(e) => setSearch((s) => ({ ...s, customerRef: e.target.value }))} />
              </FormField>
              <FormField label="Vertical">
                <TextInput value={search.vertical} onChange={(e) => setSearch((s) => ({ ...s, vertical: e.target.value }))} />
              </FormField>
              <FormField label="Brand">
                <TextInput value={search.brand} onChange={(e) => setSearch((s) => ({ ...s, brand: e.target.value }))} />
              </FormField>
              <FormField label="Model">
                <TextInput value={search.model} onChange={(e) => setSearch((s) => ({ ...s, model: e.target.value }))} />
              </FormField>
              <FormField label="ESN">
                <TextInput value={search.esn} onChange={(e) => setSearch((s) => ({ ...s, esn: e.target.value }))} />
              </FormField>
              <FormField label="Status">
                <select
                  className="w-full rounded-xl border px-3 py-2 text-sm"
                  value={search.status}
                  onChange={(e) => setSearch((s) => ({ ...s, status: e.target.value }))}
                >
                  <option value="">Any valid</option>
                  <option value="APPROVED">APPROVED</option>
                  <option value="SENT">SENT</option>
                  <option value="CONVERTED">CONVERTED</option>
                  <option value="DRAFT">DRAFT</option>
                </select>
              </FormField>
              <FormField label="Date From">
                <TextInput type="date" value={search.dateFrom} onChange={(e) => setSearch((s) => ({ ...s, dateFrom: e.target.value }))} />
              </FormField>
              <FormField label="Date To">
                <TextInput type="date" value={search.dateTo} onChange={(e) => setSearch((s) => ({ ...s, dateTo: e.target.value }))} />
              </FormField>
              <FormField label="Currency">
                <TextInput value={search.currency} onChange={(e) => setSearch((s) => ({ ...s, currency: e.target.value.toUpperCase() }))} />
              </FormField>
            </div>
            <button
              type="button"
              className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              disabled={searchLoading}
              onClick={runSearch}
            >
              {searchLoading ? "Searching…" : "Search"}
            </button>
            {searchResults.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border bg-white">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-2 py-2 text-left">Quotation No</th>
                      <th className="px-2 py-2 text-left">Date</th>
                      <th className="px-2 py-2 text-left">Customer</th>
                      <th className="px-2 py-2 text-left">Cust Ref</th>
                      <th className="px-2 py-2 text-left">Brand</th>
                      <th className="px-2 py-2 text-left">Vertical</th>
                      <th className="px-2 py-2 text-left">Model</th>
                      <th className="px-2 py-2 text-left">ESN</th>
                      <th className="px-2 py-2 text-left">Currency</th>
                      <th className="px-2 py-2 text-right">Grand Total</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((row) => (
                      <tr key={row._id} className="border-t">
                        <td className="px-2 py-2 font-mono">{row.quotationNo}</td>
                        <td className="px-2 py-2">{row.quotationDate}</td>
                        <td className="px-2 py-2">{row.customerName}</td>
                        <td className="px-2 py-2">{row.customerReference}</td>
                        <td className="px-2 py-2">{row.brand}</td>
                        <td className="px-2 py-2">{row.vertical}</td>
                        <td className="px-2 py-2">{row.model}</td>
                        <td className="px-2 py-2">{row.esn}</td>
                        <td className="px-2 py-2">{row.currency}</td>
                        <td className="px-2 py-2 text-right">{money(row.grandTotal)}</td>
                        <td className="px-2 py-2">{row.status}</td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="rounded border px-2 py-1 text-xs underline disabled:opacity-50"
                            disabled={selectingQuotation}
                            onClick={() => selectQuotation(row._id)}
                          >
                            {selectingQuotation ? "…" : "Select"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : searchAttempted && !searchLoading ? (
              <p className="text-xs text-gray-500">No quotations matched your filters.</p>
            ) : null}
          </div>
        ) : null}

        {form.sourceQuotationNo ? (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Source Quotation: <span className="font-mono font-semibold">{form.sourceQuotationNo}</span>
            {form._sourceMetadata?.sourceCreatedBy ? (
              <span className="ml-2 text-xs text-emerald-800">
                (created by {form._sourceMetadata.sourceCreatedBy})
              </span>
            ) : null}
            {form.consumptionSummary?.linkedOaCount > 0 ? (
              <div className="mt-1 text-xs">
                {form.consumptionSummary.linkedOaCount} existing OA(s) linked — remaining quantities applied.
              </div>
            ) : null}
            {fromQuotation ? (
              <>
                <button
                  type="button"
                  className="ml-3 text-xs underline disabled:opacity-50"
                  disabled={refreshingConsumption || selectingQuotation}
                  onClick={refreshConsumption}
                >
                  {refreshingConsumption ? "Refreshing…" : "Refresh remaining qty"}
                </button>
                <button
                  type="button"
                  className="ml-3 text-xs underline"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      sourceQuotationId: "",
                      sourceQuotationNo: "",
                      consumptionBaseline: null,
                      lines: [emptyOaWorkingLine()],
                    }))
                  }
                >
                  Change quotation
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <FormField label="Document No.">
            <TextInput
              value={form.oaNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, oaNo: e.target.value }))}
              placeholder="Leave blank for automatic number"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Automatically generated. You may edit this number before finalization.
            </p>
          </FormField>
          <FormField label="Linked Quotation No">
            <TextInput
              value={form.sourceQuotationNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, sourceQuotationNo: e.target.value }))}
            />
          </FormField>
          <FormField label="OA Date">
            <TextInput type="date" value={form.oaDate} onChange={(e) => setForm((f) => ({ ...f, oaDate: e.target.value }))} />
          </FormField>
          <FormField label="Customer *">
            <TextInput value={form.customerName} onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))} />
          </FormField>
          <FormField label="Customer Ref">
            <TextInput
              value={form.customerReference || form.customerPORef || ""}
              onChange={(e) => setForm((f) => ({ ...f, customerReference: e.target.value, customerPORef: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </FormField>
          <FormField label="Packing Cost">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.packingCost ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, packingCost: Number(e.target.value) || 0 }))}
            />
          </FormField>
          <FormField label="Clearance Cost">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.clearanceCost ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, clearanceCost: Number(e.target.value) || 0 }))}
            />
          </FormField>
        </div>

        <div className="mt-3">
          <CustomerTransactionDetailsFields
            compact
            values={{
              contactPerson: form.contactPerson || "",
              attention: form.attention || "",
              paymentTerms: form.paymentTerms || "",
              billingAddress: form.billingAddress || "",
              shippingAddress: form.shippingAddress || "",
            }}
            onChange={(key, value) => setForm((f) => ({ ...f, [key]: value }))}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3 md:grid-cols-5">
          <FormField label="Vertical">
            <TextInput value={form.vertical || ""} onChange={(e) => setForm((f) => ({ ...f, vertical: e.target.value }))} />
          </FormField>
          <FormField label="Brand">
            <TextInput value={form.engine || ""} onChange={(e) => setForm((f) => ({ ...f, engine: e.target.value }))} />
          </FormField>
          <FormField label="Model">
            <TextInput value={form.model || ""} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
          </FormField>
          <FormField label="Config">
            <TextInput value={form.config || ""} onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))} />
          </FormField>
          <FormField label="ESN">
            <TextInput value={form.esn || ""} onChange={(e) => setForm((f) => ({ ...f, esn: e.target.value }))} />
          </FormField>
          <FormField label="Discount Type">
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm"
              value={form.discountType || "NONE"}
              onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value }))}
            >
              <option value="NONE">NONE</option>
              <option value="PERCENT">PERCENT</option>
              <option value="FLAT">FLAT</option>
            </select>
          </FormField>
          <FormField label="Discount Value">
            <TextInput
              type="number"
              min="0"
              step="0.01"
              value={form.discountValue ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, discountValue: Number(e.target.value) || 0 }))}
            />
          </FormField>
        </div>

        <FormField label="Acknowledgement notes" className="mt-3">
          <textarea
            className="w-full rounded-xl border px-3 py-2 text-sm"
            rows={2}
            value={form.acknowledgementNotes || ""}
            onChange={(e) => setForm((f) => ({ ...f, acknowledgementNotes: e.target.value }))}
          />
        </FormField>

        <FormField label="Terms &amp; Conditions (printed on OA PDF)" className="mt-3">
          <textarea
            className="min-h-[200px] w-full rounded-xl border px-3 py-2 text-sm leading-relaxed"
            rows={12}
            placeholder="Pre-filled from quotation when creating from quote."
            value={form.termsAndConditions || ""}
            onChange={(e) => setForm((f) => ({ ...f, termsAndConditions: e.target.value }))}
          />
        </FormField>

        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">OA Lines</span>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-xl border px-3 py-1 text-xs" onClick={() => exportOaWorkingLinesCsv(form.lines)}>
                Export Lines CSV
              </button>
              <button type="button" className="rounded-xl border px-3 py-1 text-xs" onClick={() => csvInputRef.current?.click()}>
                Import Lines CSV
              </button>
              <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleCsvImport(e.target.files?.[0])} />
              <button
                type="button"
                className="text-sm underline"
                onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, emptyOaWorkingLine()] }))}
              >
                + Add line
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-2">Incl</th>
                  <th className="px-2 py-2 text-left">Article</th>
                  <th className="px-2 py-2 text-left">Part No</th>
                  <th className="px-2 py-2 text-left">Description</th>
                  <th className="px-2 py-2">UOM</th>
                  {fromQuotation ? (
                    <>
                      <th className="px-2 py-2 text-right">Quoted Qty</th>
                      <th className="px-2 py-2 text-right">Already Ord.</th>
                      <th className="px-2 py-2 text-right">Remaining</th>
                      <th className="px-2 py-2 text-right">Ordered Qty</th>
                      <th className="px-2 py-2 text-right">Qty Diff</th>
                      <th className="px-2 py-2 text-right">Quoted Price</th>
                      <th className="px-2 py-2 text-right">Ordered Price</th>
                      <th className="px-2 py-2 text-right">Price Diff</th>
                    </>
                  ) : (
                    <>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Price</th>
                    </>
                  )}
                  <th className="px-2 py-2 text-right">Total</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, idx) => {
                  const oq = Number(line.orderedQty) || 0;
                  const op = Number(line.orderedPrice) || 0;
                  const qq = line.quotedQty != null ? Number(line.quotedQty) : null;
                  const qp = line.quotedPrice != null ? Number(line.quotedPrice) : null;
                  const alreadyOrd = line.alreadyOrderedQty != null ? Number(line.alreadyOrderedQty) : null;
                  const remaining = line.remainingQty != null ? Number(line.remainingQty) : null;
                  const qtyDiff = qq != null ? oq - qq : null;
                  const priceDiff = qp != null ? op - qp : null;
                  const overRemaining = remaining != null && oq > remaining + 1e-9;
                  const included = line.includeInOA !== false;
                  const rowTotal = included ? oq * op : 0;
                  const dim = !included ? "opacity-50" : "";
                  return (
                    <tr key={idx} className={`border-t ${dim}`}>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(e) => updateLine(idx, { includeInOA: e.target.checked })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput
                          className="min-w-[80px] text-xs"
                          value={line.article}
                          onChange={(e) => updateLine(idx, { article: e.target.value.toUpperCase() })}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput className="min-w-[70px] text-xs" value={line.partNumber} onChange={(e) => updateLine(idx, { partNumber: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput className="min-w-[120px] text-xs" value={line.description} onChange={(e) => updateLine(idx, { description: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <TextInput className="w-14 text-xs" value={line.uom} onChange={(e) => updateLine(idx, { uom: e.target.value })} />
                      </td>
                      {fromQuotation ? (
                        <>
                          <td className="px-2 py-1 text-right text-gray-500">{qq != null ? qq : "—"}</td>
                          <td className="px-2 py-1 text-right text-gray-500">{alreadyOrd != null ? alreadyOrd : "—"}</td>
                          <td className="px-2 py-1 text-right font-medium text-sky-800">{remaining != null ? remaining : "—"}</td>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              min="0"
                              step="any"
                              className={`w-16 text-right text-xs ${overRemaining ? "border-rose-400 bg-rose-50" : ""}`}
                              value={oq}
                              onChange={(e) => updateLine(idx, { orderedQty: Math.max(0, Number(e.target.value) || 0) })}
                            />
                          </td>
                          <td className={`px-2 py-1 text-right ${qtyDiff > 0 ? "text-emerald-700" : qtyDiff < 0 ? "text-rose-700" : ""}`}>
                            {qtyDiff != null ? qtyDiff : "—"}
                            {overRemaining ? (
                              <div className="text-[10px] font-medium text-rose-600">Exceeds remaining</div>
                            ) : null}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-500">{qp != null ? money(qp) : "—"}</td>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              min="0"
                              step="0.01"
                              className="w-20 text-right text-xs"
                              value={op}
                              onChange={(e) => updateLine(idx, { orderedPrice: Math.max(0, Number(e.target.value) || 0) })}
                            />
                          </td>
                          <td className={`px-2 py-1 text-right ${priceDiff > 0 ? "text-emerald-700" : priceDiff < 0 ? "text-rose-700" : ""}`}>
                            {priceDiff != null ? money(priceDiff) : "—"}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              min="0"
                              step="any"
                              className="w-16 text-right text-xs"
                              value={oq}
                              onChange={(e) =>
                                updateLine(idx, {
                                  orderedQty: Math.max(0, Number(e.target.value) || 0),
                                  quotedQty: null,
                                })
                              }
                            />
                          </td>
                          <td className="px-2 py-1">
                            <TextInput
                              type="number"
                              min="0"
                              step="0.01"
                              className="w-20 text-right text-xs"
                              value={op}
                              onChange={(e) =>
                                updateLine(idx, {
                                  orderedPrice: Math.max(0, Number(e.target.value) || 0),
                                  quotedPrice: null,
                                })
                              }
                            />
                          </td>
                        </>
                      )}
                      <td className="px-2 py-1 text-right">{money(rowTotal)}</td>
                      <td className="px-2 py-1">
                        {line.isNewLine || !line.sourceQuotationLineId ? (
                          <button
                            type="button"
                            className="rounded border px-1 py-0.5 text-[10px]"
                            onClick={() =>
                              setForm((f) => {
                                const lines = f.lines.filter((_, i) => i !== idx);
                                return { ...f, lines: lines.length ? lines : [emptyOaWorkingLine()] };
                              })
                            }
                          >
                            Remove
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-400">Exclude</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 text-right text-sm text-gray-700">
            Subtotal (included lines): {money(workingSubtotal)} {form.currency} | Est. Grand Total: {money(workingGrandTotal)}{" "}
            {form.currency}
            <span className="ml-2 text-xs text-gray-500">(final totals recalculated on save)</span>
          </div>
          {overOrderViolations.length > 0 ? (
            <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900 ring-1 ring-rose-200">
              {overOrderViolations.length} line(s) exceed remaining quotation quantity. Reduce ordered qty or confirm override on save.
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={createMutation.isPending || selectingQuotation || !form.customerName?.trim()}
            onClick={() => submitOa(false)}
          >
            {createMutation.isPending ? "Saving…" : "Create OA"}
          </button>
        </div>
      </Modal>

      <Modal open={!!overOrderConfirm} onClose={() => setOverOrderConfirm(null)} title="Over-order warning">
        {overOrderConfirm ? (
          <div className="space-y-3 text-sm">
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900 ring-1 ring-rose-200">
              Ordered quantity exceeds remaining quotation quantity for the following lines. The original quotation will
              not be changed. Continue only if business rules allow this override.
            </p>
            <ul className="max-h-48 overflow-y-auto text-xs text-gray-700">
              {overOrderConfirm.violations.map((v, i) => (
                <li key={i} className="border-b py-1">
                  {v.article} {v.partNumber ? `(${v.partNumber})` : ""}: ordered {v.orderedQty}, remaining{" "}
                  {v.remainingQty}, excess {v.excessQty ?? v.orderedQty - v.remainingQty}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setOverOrderConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={createMutation.isPending}
                onClick={() => {
                  setOverOrderConfirm(null);
                  submitOa(true);
                }}
              >
                Override and Create OA
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={!!staleConsumptionConfirm} onClose={() => setStaleConsumptionConfirm(null)} title="Remaining quantities changed">
        {staleConsumptionConfirm ? (
          <div className="space-y-3 text-sm">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              Quotation consumption changed while this form was open (another user may have created an OA). Refresh
              remaining quantities or continue if you have verified the order.
            </p>
            <ul className="max-h-48 overflow-y-auto text-xs text-gray-700">
              {staleConsumptionConfirm.reasons.map((r, i) => (
                <li key={i} className="border-b py-1">
                  {r}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border px-4 py-2 text-sm"
                onClick={() => {
                  setStaleConsumptionConfirm(null);
                  refreshConsumption();
                }}
              >
                Refresh quantities
              </button>
              <button
                type="button"
                className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                disabled={createMutation.isPending}
                onClick={() => {
                  setStaleConsumptionConfirm(null);
                  submitOa(false, true);
                }}
              >
                Continue anyway
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={!!csvPreview} onClose={() => setCsvPreview(null)} title="CSV Import Preview">
        {csvPreview ? (
          <div className="space-y-3 text-sm">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              Import will override current OA working line data only. Original quotation and old documents will not be changed.
              Continue?
            </p>
            <ul className="list-inside list-disc text-xs text-gray-700">
              <li>Total lines detected: {csvPreview.totalLines}</li>
              <li>Updated lines: {csvPreview.updated}</li>
              <li>Added lines: {csvPreview.added}</li>
              <li>Excluded/removed lines: {csvPreview.removed}</li>
              <li>Qty changes: {csvPreview.qtyChanges}</li>
              <li>Price changes: {csvPreview.priceChanges}</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setCsvPreview(null)}>
                Cancel
              </button>
              <button type="button" className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white" onClick={confirmCsvImport}>
                Continue Import
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
