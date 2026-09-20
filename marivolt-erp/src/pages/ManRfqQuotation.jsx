import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiGetWithQuery, apiPost, apiPostFormData } from "../lib/api.js";
import { notify } from "../lib/notifications.js";
import { useAuth } from "../context/AuthContext.jsx";
import LoadingButton from "../components/erp/LoadingButton.jsx";

const TIERS = [
  { id: "SELL", label: "Sell price" },
  { id: "SELL_II", label: "Sell II" },
  { id: "MINM", label: "Minm" },
  { id: "ROCK", label: "Rock" },
];

const STATUS_BADGE = {
  MATCHED: { label: "Matched", className: "bg-emerald-50 text-emerald-800" },
  READY: { label: "Ready", className: "bg-emerald-100 text-emerald-900" },
  MULTIPLE: { label: "Multiple matches", className: "bg-amber-50 text-amber-800" },
  MODEL_MISMATCH: { label: "Model mismatch", className: "bg-orange-50 text-orange-800" },
  MODEL_CONFLICT: { label: "Model mismatch", className: "bg-orange-50 text-orange-800" },
  MODEL_REQUIRED: { label: "Model mismatch", className: "bg-orange-50 text-orange-800" },
  UOM_MISMATCH: { label: "UOM mismatch", className: "bg-rose-50 text-rose-800" },
  PRICING_REQUIRED: { label: "Pricing required", className: "bg-amber-50 text-amber-900" },
  NOT_FOUND: { label: "Not found", className: "bg-slate-100 text-slate-700" },
  NON_MAN: { label: "Not found", className: "bg-slate-100 text-slate-700" },
  INVALID: { label: "Not found", className: "bg-slate-100 text-slate-700" },
  EXCLUDED: { label: "Excluded", className: "bg-slate-200 text-slate-700" },
  REVIEW: { label: "Multiple matches", className: "bg-amber-50 text-amber-800" },
};

function newKey() {
  return `man-rfq-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function roundQuotationMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function quotationLineTotal(unitPrice, qty) {
  return roundQuotationMoney(roundQuotationMoney(unitPrice) * (Number(qty) || 0));
}

function formatQuotationMoney(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const rounded = roundQuotationMoney(n);
  const negative = rounded < 0;
  const [whole, frac] = Math.abs(rounded).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function tierUnit(prices = {}, tier = "SELL") {
  if (tier === "SELL_II") return prices.sellIi;
  if (tier === "MINM") return prices.minm;
  if (tier === "ROCK") return prices.rock;
  return prices.sellPrice;
}

function lineCandidate(ln) {
  const article = String(ln.selectedArticle || "").trim();
  if (!article) return null;
  return (ln.candidates || []).find((c) => c.article === article) || null;
}

function lineIsReady(ln) {
  if (ln.exclude) return true;
  if (!ln.selectedArticle) return false;
  if (["NOT_FOUND", "NON_MAN", "INVALID", "PRICING_REQUIRED", "MODEL_MISMATCH", "MODEL_CONFLICT", "MODEL_REQUIRED", "UOM_MISMATCH"].includes(ln.status)) {
    return false;
  }
  const cand = (ln.candidates || []).find((c) => c.article === ln.selectedArticle);
  if (cand && (!cand.uomOk || cand.modelConflict || cand.configConflict || !cand.prices)) return false;
  const prices = cand?.prices || {};
  return tierUnit(prices, ln.priceTier || "SELL") != null;
}

function displayStatus(ln) {
  if (ln.exclude) return "EXCLUDED";
  if (lineIsReady(ln) && !["NOT_FOUND", "NON_MAN", "INVALID"].includes(ln.status)) return "READY";
  return ln.status || "REVIEW";
}

function StatusBadge({ status }) {
  const meta = STATUS_BADGE[status] || { label: status || "—", className: "bg-slate-100 text-slate-700" };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${meta.className}`}>{meta.label}</span>
  );
}

function StagePill({ n, label, state }) {
  const cls =
    state === "done"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : state === "active"
        ? "border-slate-900 bg-slate-900 text-white"
        : "border-slate-200 bg-white text-slate-500";
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${cls}`}>
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current text-xs font-semibold">{n}</span>
      <span className="font-medium">{label}</span>
    </div>
  );
}

function ManModelSelect({ models, mode, model, onChange, disabled }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const filtered = (models || []).filter((m) => m.toLowerCase().includes(q.trim().toLowerCase()));
  const label =
    mode === "MIXED"
      ? "Mixed models / model stated per line"
      : mode === "UNSPECIFIED"
        ? "Model not specified"
        : model || "Select MAN engine model";

  function pick(nextMode, nextModel) {
    onChange({ modelMode: nextMode, model: nextModel });
    setOpen(false);
    setQ("");
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        className="mt-1 w-full rounded-xl border px-3 py-2 text-left text-sm disabled:bg-slate-50"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <div className="absolute z-30 mt-1 w-full rounded-xl border bg-white p-2 shadow-lg">
          <input
            className="mb-2 w-full rounded border px-2 py-1 text-sm"
            placeholder="Search Item Master models"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50" onClick={() => pick("SELECTED", "")}>
            Select MAN engine model
          </button>
          <button type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50" onClick={() => pick("MIXED", "")}>
            Mixed models / model stated per line
          </button>
          <button type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50" onClick={() => pick("UNSPECIFIED", "")}>
            Model not specified
          </button>
          <div className="my-1 border-t" />
          {filtered.length ? (
            filtered.map((m) => (
              <button
                key={m}
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50"
                onClick={() => pick("SELECTED", m)}
              >
                {m}
              </button>
            ))
          ) : (
            <p className="px-2 py-1 text-xs text-slate-500">No matching Item Master model. Correct Item Master first.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function permittedTierLabels(prices = {}, permittedTiers = []) {
  return permittedTiers
    .filter((t) => tierUnit(prices, t.id) != null)
    .map((t) => t.label)
    .join(", ") || "—";
}

export default function ManRfqQuotation() {
  const { can } = useAuth();
  const allowed = can("SALES", "create");
  const fileRef = useRef(null);
  const [header, setHeader] = useState({
    customerId: "",
    customerName: "",
    customerReference: "",
    quotationDate: todayIsoDate(),
    validityDate: "",
    currency: "USD",
    engine: "MAN",
    model: "",
    modelMode: "SELECTED",
    esn: "",
    vesselPlant: "",
    remarks: "",
  });
  const [customerSearch, setCustomerSearch] = useState("");
  const [lines, setLines] = useState([]);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [created, setCreated] = useState(null);
  const [bulkTier, setBulkTier] = useState("SELL");
  const [pickerIdx, setPickerIdx] = useState(null);

  const { data: customerLookup } = useQuery({
    queryKey: ["sales-customers-lookup", customerSearch],
    queryFn: () =>
      apiGetWithQuery("/sales/customers", {
        page: 1,
        limit: 100,
        search: customerSearch || undefined,
      }),
  });
  const customers = customerLookup?.items || [];

  const { data: modelData } = useQuery({
    queryKey: ["man-rfq-models"],
    queryFn: () => apiGet("/man-rfq/models"),
    enabled: allowed,
  });
  const manModels = modelData?.models || [];

  const canTier = (tier) => {
    const map = {
      SELL: "price_tier_sell",
      SELL_II: "price_tier_sell_ii",
      MINM: "price_tier_minm",
      ROCK: "price_tier_rock",
    };
    return can("SALES", map[tier]);
  };
  const permittedTiers = TIERS.filter((t) => canTier(t.id));

  const detailsReady =
    Boolean(header.customerId) &&
    Boolean(header.currency) &&
    (header.modelMode === "MIXED" || header.modelMode === "UNSPECIFIED" || Boolean(header.model));

  const matchMut = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("defaultTier", "SELL");
      fd.append("modelMode", header.modelMode);
      fd.append("model", header.model || "");
      return apiPostFormData("/man-rfq/match", fd);
    },
    onSuccess: (data) => {
      setIdempotencyKey(newKey());
      setCreated(null);
      setLines(
        (data.lines || []).map((ln) => ({
          ...ln,
          exclude: ["NOT_FOUND", "NON_MAN", "INVALID"].includes(ln.status),
          excludeReason: ln.exclusionReason || "",
          priceTier: ln.selectedArticle ? ln.priceTier || "SELL" : "",
          unitPrice: ln.selectedArticle ? ln.unitPrice : undefined,
        }))
      );
      notify.info("RFQ matched. Review lines before creating a quotation.");
    },
    onError: (e) => notify.error(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: () =>
      apiPost("/man-rfq/availability", {
        lines: lines.map((ln) => ({
          article: ln.selectedArticle,
          qty: ln.qty,
          uom: ln.uom,
        })),
      }),
    onSuccess: (data) => {
      const byIdx = data.lines || [];
      setLines((prev) =>
        prev.map((ln, i) => {
          const patch = byIdx[i] || {};
          const next = {
            ...ln,
            availability: patch.availability ?? ln.availability,
            availableQty: patch.availableQty ?? ln.availableQty,
            availabilityCheckedAt: patch.availabilityCheckedAt ?? ln.availabilityCheckedAt,
          };
          if (patch.priceListRevision != null) next.priceListRevision = patch.priceListRevision;
          if (patch.prices && next.selectedArticle) {
            next.candidates = (next.candidates || []).map((c) =>
              c.article === next.selectedArticle
                ? {
                    ...c,
                    prices: patch.prices,
                    availableQty: patch.availableQty ?? c.availableQty,
                    leadTime: patch.prices.leadTime || c.leadTime,
                  }
                : c
            );
          }
          return next;
        })
      );
      notify.info("Stock and lead time refreshed.");
    },
    onError: (e) => notify.error(e.message),
  });

  const createMut = useMutation({
    mutationFn: () =>
      apiPost("/man-rfq/quotations", {
        idempotencyKey,
        customerId: header.customerId,
        customerName: header.customerName,
        currency: header.currency,
        header,
        lines: lines.map((ln) => {
          const cand = (ln.candidates || []).find((c) => c.article === ln.selectedArticle);
          const revision = Number(cand?.prices?.revision ?? ln.priceListRevision);
          return {
            selectedArticle: ln.selectedArticle,
            article: ln.selectedArticle,
            priceTier: ln.priceTier || "SELL",
            priceListRevision: Number.isFinite(revision) ? revision : 0,
            qty: ln.qty,
            uom: ln.uom,
            exclude: ln.exclude,
            requestedPartNo: ln.requestedPartNo,
            requestedModel: ln.requestedModel || "",
            customerEngineModel: ln.requestedModel || "",
            engineModel: ln.engineModel || "",
            configuration: ln.configuration || "",
            specifications: ln.specifications || "",
            customerLine: ln.customerLine,
            exclusionReason: ln.excludeReason || ln.exclusionReason,
          };
        }),
      }),
    onSuccess: (data) => {
      setCreated(data.quotation);
      notify.success(data.reused ? "Existing draft quotation reused" : `Draft ${data.quotation?.quotationNo} created`);
    },
    onError: (e) => {
      if (e.code === "STALE_PRICE") {
        const article = e.body?.article || e.article;
        const where = article ? ` for Article ${article}` : "";
        notify.error(`Prices changed${where}. Refresh or recheck the affected row, then try again.`);
        return;
      }
      notify.error(e.message);
    },
  });

  const included = lines.filter((l) => !l.exclude);
  const unresolved = useMemo(() => {
    const open = lines.filter((l) => !l.exclude);
    const counts = {
      missingArticle: 0,
      multiple: 0,
      model: 0,
      uom: 0,
      pricing: 0,
      notFound: 0,
    };
    for (const l of open) {
      if (["NOT_FOUND", "NON_MAN", "INVALID"].includes(l.status)) counts.notFound += 1;
      else if (["MODEL_MISMATCH", "MODEL_CONFLICT", "MODEL_REQUIRED"].includes(l.status)) counts.model += 1;
      else if (l.status === "UOM_MISMATCH") counts.uom += 1;
      else if (l.status === "PRICING_REQUIRED") counts.pricing += 1;
      else if (!l.selectedArticle || l.status === "MULTIPLE" || l.status === "REVIEW") counts.multiple += 1;
      else if (!lineIsReady(l)) counts.missingArticle += 1;
    }
    return counts;
  }, [lines]);

  const ready = Boolean(header.customerId) && included.length > 0 && included.every(lineIsReady);
  const unresolvedTotal = Object.values(unresolved).reduce((a, b) => a + b, 0);

  function applyBulkTier() {
    setLines((rows) =>
      rows.map((r) => {
        if (r.exclude || !r.selectedArticle) return r;
        const cand = (r.candidates || []).find((c) => c.article === r.selectedArticle);
        if (!cand) return r;
        const prices = cand.prices || {};
        if (tierUnit(prices, bulkTier) == null || !canTier(bulkTier)) return r;
        return { ...r, priceTier: bulkTier };
      })
    );
  }

  function selectArticle(idx, article) {
    setLines((rows) =>
      rows.map((r, i) => {
        if (i !== idx) return r;
        const cand = (r.candidates || []).find((c) => c.article === article);
        if (!cand) return r;
        if (cand.modelConflict) return r;
        if (!cand.uomOk) {
          return { ...r, selectedArticle: article, status: "UOM_MISMATCH" };
        }
        if (!cand.prices || !cand.pricingOk) {
          return { ...r, selectedArticle: article, status: "PRICING_REQUIRED", description: cand.description };
        }
        return {
          ...r,
          selectedArticle: article,
          status: "MATCHED",
          description: cand.description,
          matchedEngineModel: cand.model || r.matchedEngineModel,
          availableQty: cand.availableQty,
          leadTime: cand.leadTime,
          priceTier: r.priceTier || "SELL",
          exclude: false,
        };
      })
    );
    setPickerIdx(null);
  }

  const pickerLine = pickerIdx != null ? lines[pickerIdx] : null;
  const stage1 = detailsReady ? "done" : "active";
  const stage2 = lines.length ? "done" : detailsReady ? "active" : "idle";
  const stage3 = lines.length ? (ready ? "done" : "active") : "idle";
  const stage4 = created ? "done" : ready ? "active" : "idle";

  if (!allowed) {
    return <div className="rounded-2xl border bg-white p-6 text-sm">Sales create permission is required.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h1 className="text-2xl font-semibold">MAN RFQ / Quotation</h1>
        <p className="text-sm text-slate-600">
          Match customer Part no to MAN Item Master SPN for the selected engine model, pick a permitted selling tier, then
          generate a standard draft quotation. Creating a quotation does not reserve stock. Manual quotations remain
          available on Sales.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StagePill n="1" label="Quotation Details" state={stage1} />
          <StagePill n="2" label="Upload Customer RFQ" state={stage2} />
          <StagePill n="3" label="Review Matches and Prices" state={stage3} />
          <StagePill n="4" label="Create Draft Quotation" state={stage4} />
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-4">
        <h2 className="text-lg font-semibold">Quotation Details</h2>
        <p className="text-sm text-slate-500">Customer, currency and engine model are required before RFQ matching.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Customer
            <input
              className="mt-1 w-full rounded-xl border px-3 py-2"
              placeholder="Search customer name"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            <select
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.customerId}
              onChange={(e) => {
                const c = customers.find((x) => String(x._id) === e.target.value);
                setHeader((h) => ({ ...h, customerId: e.target.value, customerName: c?.name || "" }));
              }}
            >
              <option value="">Select from Customer Master</option>
              {customers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Currency
            <input
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.currency}
              onChange={(e) => setHeader((h) => ({ ...h, currency: e.target.value.toUpperCase() }))}
            />
          </label>
          <label className="text-sm">
            Engine Model
            <ManModelSelect
              models={manModels}
              mode={header.modelMode}
              model={header.model}
              onChange={(next) => setHeader((h) => ({ ...h, ...next }))}
            />
          </label>
          <label className="text-sm">
            Customer RFQ Reference
            <input
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.customerReference}
              onChange={(e) => setHeader((h) => ({ ...h, customerReference: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            RFQ Date
            <input
              type="date"
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.quotationDate}
              onChange={(e) => setHeader((h) => ({ ...h, quotationDate: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            Quotation Validity
            <input
              type="date"
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.validityDate}
              onChange={(e) => setHeader((h) => ({ ...h, validityDate: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            Engine Brand
            <input className="mt-1 w-full rounded-xl border bg-slate-50 px-3 py-2" value="MAN" readOnly />
          </label>
          <label className="text-sm">
            Vessel / Plant
            <input
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.vesselPlant}
              onChange={(e) => setHeader((h) => ({ ...h, vesselPlant: e.target.value }))}
              placeholder="Vessel or plant name"
            />
          </label>
          <label className="text-sm">
            Engine Serial Number (ESN)
            <input
              className="mt-1 w-full rounded-xl border px-3 py-2"
              value={header.esn}
              onChange={(e) => setHeader((h) => ({ ...h, esn: e.target.value }))}
              placeholder="Engine serial number"
            />
          </label>
          <label className="text-sm md:col-span-3">
            Customer enquiry remarks
            <textarea
              className="mt-1 w-full rounded-xl border px-3 py-2"
              rows={2}
              value={header.remarks}
              onChange={(e) => setHeader((h) => ({ ...h, remarks: e.target.value }))}
            />
          </label>
        </div>
        {header.modelMode === "UNSPECIFIED" ? (
          <p className="mt-2 text-xs text-amber-800">
            Model not specified searches across MAN models. Article selection is required whenever the same SPN exists on
            more than one model.
          </p>
        ) : null}
        {header.modelMode === "MIXED" ? (
          <p className="mt-2 text-xs text-slate-600">Engine Model is required on every RFQ line for mixed-model RFQs.</p>
        ) : null}
      </div>

      <div className="rounded-2xl border bg-white p-4">
        <h2 className="text-lg font-semibold">Upload Customer RFQ</h2>
        <p className="text-sm text-slate-500">Required columns: Part no, UOM, Qty. Engine Model and configuration are optional.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) matchMut.mutate(file);
            }}
          />
          <button
            type="button"
            className="rounded-xl border px-3 py-2 text-sm disabled:opacity-50"
            disabled={!detailsReady || matchMut.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {matchMut.isPending ? "Matching…" : "Upload RFQ CSV"}
          </button>
        </div>
        {!detailsReady ? (
          <p className="mt-2 text-xs text-slate-500">Select Customer, Currency and Engine Model before uploading.</p>
        ) : null}
      </div>

      {lines.length ? (
        <div className="rounded-2xl border bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Review Matches and Prices</h2>
            <div className="flex flex-wrap items-center gap-2">
              <LoadingButton loading={refreshMut.isPending} disabled={!lines.length} onClick={() => refreshMut.mutate()}>
                Refresh Stock & Lead Time
              </LoadingButton>
              <label className="flex items-center gap-2 text-sm">
                Apply Price Level
                <select className="rounded-xl border px-2 py-1" value={bulkTier} onChange={(e) => setBulkTier(e.target.value)}>
                  {permittedTiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="rounded-xl border px-3 py-1" onClick={applyBulkTier} disabled={!lines.length}>
                  Apply to eligible lines
                </button>
              </label>
            </div>
          </div>

          <div className="overflow-auto rounded-xl border">
            <table className="min-w-[1600px] text-xs">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-50 px-2 py-2">Customer Line</th>
                  <th className="sticky left-[7rem] z-20 bg-slate-50 px-2 py-2">Requested Part No.</th>
                  <th className="px-2 py-2">Requested Model</th>
                  <th className="sticky left-[16rem] z-20 bg-slate-50 px-2 py-2">Selected Article</th>
                  <th className="px-2 py-2">Matched Engine Model</th>
                  <th className="px-2 py-2">Configuration</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">Specs</th>
                  <th className="px-2 py-2">UOM</th>
                  <th className="px-2 py-2">Qty</th>
                  <th className="px-2 py-2">Available Stock</th>
                  <th className="px-2 py-2">Lead Time / Availability</th>
                  <th className="px-2 py-2">Price Tier</th>
                  <th className="px-2 py-2">Unit Price</th>
                  <th className="px-2 py-2">Total</th>
                  <th className="px-2 py-2">Match Status</th>
                  <th className="px-2 py-2">Action / Exclude</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((ln, idx) => {
                  const cand = lineCandidate(ln);
                  const prices = cand?.prices || {};
                  const unit = tierUnit(prices, ln.priceTier || "SELL");
                  return (
                    <tr key={`${ln.requestedPartNo}-${idx}`} className="border-t align-top">
                      <td className="sticky left-0 z-10 bg-white px-2 py-1">{ln.customerLine || "—"}</td>
                      <td className="sticky left-[7rem] z-10 bg-white px-2 py-1 font-mono">{ln.requestedPartNo}</td>
                      <td className="px-2 py-1">{ln.requestedModel || "—"}</td>
                      <td className="sticky left-[16rem] z-10 bg-white px-2 py-1">
                        <div className="font-mono">{ln.selectedArticle || "—"}</div>
                        {(ln.candidates || []).length > 1 || ["MULTIPLE", "REVIEW", "MODEL_REQUIRED"].includes(ln.status) ? (
                          <button
                            type="button"
                            className="mt-1 text-xs font-semibold underline"
                            onClick={() => setPickerIdx(idx)}
                          >
                            Select Article
                          </button>
                        ) : null}
                        {ln.availableModels?.length && ["MODEL_MISMATCH", "MODEL_REQUIRED", "MULTIPLE"].includes(ln.status) ? (
                          <div className="mt-1 text-[11px] text-slate-500">Available models: {ln.availableModels.join(", ")}</div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1">{ln.matchedEngineModel || cand?.model || "—"}</td>
                      <td className="px-2 py-1">{cand?.config || ln.configuration || "—"}</td>
                      <td className="px-2 py-1">{ln.description || cand?.description || "—"}</td>
                      <td className="px-2 py-1">{cand?.specifications || ln.specifications || "—"}</td>
                      <td className="px-2 py-1">{ln.uom}</td>
                      <td className="px-2 py-1">{ln.qty}</td>
                      <td className="px-2 py-1">{cand?.availableQty ?? ln.availableQty ?? "—"}</td>
                      <td className="px-2 py-1">{ln.availability || cand?.leadTime || "—"}</td>
                      <td className="px-2 py-1">
                        <select
                          className="rounded border px-1 py-0.5"
                          disabled={!ln.selectedArticle}
                          value={ln.selectedArticle ? ln.priceTier || "SELL" : ""}
                          onChange={(e) =>
                            setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, priceTier: e.target.value } : r)))
                          }
                        >
                          {!ln.selectedArticle ? <option value="">Select Article first</option> : null}
                          {permittedTiers.map((t) => {
                            const p = tierUnit(prices, t.id);
                            return (
                              <option key={t.id} value={t.id} disabled={p == null}>
                                {t.label}
                                {p == null ? " (no price)" : ""}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{unit != null ? formatQuotationMoney(unit) : "—"}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {unit != null ? formatQuotationMoney(quotationLineTotal(unit, ln.qty)) : "—"}
                      </td>
                      <td className="px-2 py-1">
                        <StatusBadge status={displayStatus(ln)} />
                      </td>
                      <td className="px-2 py-1">
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={Boolean(ln.exclude)}
                            onChange={(e) =>
                              setLines((rows) =>
                                rows.map((r, i) =>
                                  i === idx
                                    ? { ...r, exclude: e.target.checked, excludeReason: r.exclusionReason || "excluded" }
                                    : r
                                )
                              )
                            }
                          />
                          Exclude
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border bg-white p-4">
        <h2 className="text-lg font-semibold">Create Draft Quotation</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <LoadingButton loading={createMut.isPending} disabled={!ready || createMut.isPending} onClick={() => createMut.mutate()}>
            Create Draft Quotation
          </LoadingButton>
          {!ready && lines.length ? (
            <p className="text-sm text-slate-600">
              Resolve included lines before creating:
              {unresolved.notFound ? ` ${unresolved.notFound} not found` : ""}
              {unresolved.multiple ? ` ${unresolved.multiple} need Article selection` : ""}
              {unresolved.model ? ` ${unresolved.model} model issues` : ""}
              {unresolved.uom ? ` ${unresolved.uom} UOM mismatch` : ""}
              {unresolved.pricing ? ` ${unresolved.pricing} pricing required` : ""}
              {unresolved.missingArticle && !unresolvedTotal ? " lines still incomplete" : ""}
              {!header.customerId ? " customer required" : ""}.
            </p>
          ) : null}
        </div>
        {createMut.error?.code === "STALE_PRICE" ? (
          <p className="mt-2 text-sm text-amber-800">
            Prices changed
            {createMut.error?.body?.article || createMut.error?.article
              ? ` for Article ${createMut.error.body?.article || createMut.error.article}`
              : ""}
            . Refresh Stock & Lead Time or re-upload the RFQ, then review the affected row.
          </p>
        ) : null}
        {created ? (
          <p className="mt-2 text-sm text-emerald-700">
            Draft quotation {created.quotationNo} — continue QTN → OA from Sales.
          </p>
        ) : null}
      </div>

      {pickerLine ? (
        <div className="fixed inset-0 z-40 bg-black/30">
          <div className="absolute right-0 top-0 h-full w-full max-w-3xl overflow-auto bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Select Article</h2>
                <p className="text-sm text-slate-600">
                  Part no {pickerLine.requestedPartNo}
                  {pickerLine.requestedModel ? ` · requested model ${pickerLine.requestedModel}` : ""}
                </p>
              </div>
              <button type="button" className="rounded-xl border px-3 py-1 text-sm" onClick={() => setPickerIdx(null)}>
                Close
              </button>
            </div>
            <div className="overflow-auto rounded-xl border">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-left">
                  <tr>
                    {["Select", "Article", "SPN", "Engine Model", "Configuration", "Description", "Specifications", "UOM", "Available qty", "Lead time", "Permitted selling tiers"].map(
                      (h) => (
                        <th key={h} className="px-2 py-2">
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(pickerLine.candidates || []).map((c) => {
                    const highlights = [];
                    if (c.exactModelMatch) highlights.push("Exact model match");
                    if (c.exactConfigMatch) highlights.push("Exact configuration match");
                    if (!c.uomOk) highlights.push("UOM conflict");
                    if (!c.prices) highlights.push("Missing price");
                    const blocked = Boolean(c.modelConflict);
                    return (
                      <tr key={c.article} className="border-t align-top">
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            disabled={blocked}
                            className="rounded-xl border px-2 py-1 text-xs font-semibold disabled:opacity-40"
                            onClick={() => selectArticle(pickerIdx, c.article)}
                          >
                            Select
                          </button>
                        </td>
                        <td className="px-2 py-2 font-mono">{c.article}</td>
                        <td className="px-2 py-2 font-mono">{c.spn}</td>
                        <td className="px-2 py-2">{c.model || "—"}</td>
                        <td className="px-2 py-2">{c.config || "—"}</td>
                        <td className="px-2 py-2">{c.description || "—"}</td>
                        <td className="px-2 py-2">{c.specifications || "—"}</td>
                        <td className="px-2 py-2">{c.uom}</td>
                        <td className="px-2 py-2">{c.availableQty ?? "—"}</td>
                        <td className="px-2 py-2">{c.leadTime || "Lead time to be confirmed"}</td>
                        <td className="px-2 py-2">
                          {permittedTierLabels(c.prices, permittedTiers)}
                          {highlights.length ? (
                            <div className="mt-1 space-y-0.5">
                              {highlights.map((h) => (
                                <div key={h} className="text-[11px] font-semibold text-slate-600">
                                  {h}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
