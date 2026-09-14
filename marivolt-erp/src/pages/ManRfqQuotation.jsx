import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGetWithQuery, apiPost, apiPostFormData } from "../lib/api.js";
import { notify } from "../lib/notifications.js";
import { useAuth } from "../context/AuthContext.jsx";
import LoadingButton from "../components/erp/LoadingButton.jsx";

const TIERS = [
  { id: "SELL", label: "Sell price" },
  { id: "SELL_II", label: "Sell II" },
  { id: "MINM", label: "Minm" },
  { id: "ROCK", label: "Rock" },
];

function newKey() {
  return `man-rfq-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function ManRfqQuotation() {
  const { can } = useAuth();
  const allowed = can("SALES", "create");
  const fileRef = useRef(null);
  const [header, setHeader] = useState({ customerId: "", customerName: "", currency: "USD" });
  const [customerSearch, setCustomerSearch] = useState("");

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
  const [lines, setLines] = useState([]);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [created, setCreated] = useState(null);
  const [bulkTier, setBulkTier] = useState("SELL");

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

  const matchMut = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("defaultTier", "SELL");
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
          priceTier: ln.priceTier || "SELL",
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
      notify.info("Availability refreshed.");
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

  const ready = useMemo(() => {
    const open = lines.filter((l) => !l.exclude);
    if (!open.length || !header.customerId) return false;
    return open.every((l) => {
      if (!l.selectedArticle) return false;
      if (["NOT_FOUND", "NON_MAN", "INVALID", "PRICING_REQUIRED"].includes(l.status)) return false;
      const cand = (l.candidates || []).find((c) => c.article === l.selectedArticle);
      if (cand && (!cand.uomOk || cand.modelConflict)) return false;
      return true;
    });
  }, [lines, header.customerId]);

  function applyBulkTier() {
    setLines((rows) =>
      rows.map((r) => {
        if (r.exclude) return r;
        const cand = (r.candidates || []).find((c) => c.article === r.selectedArticle) || r.candidates?.[0];
        const prices = cand?.prices || {};
        const unit =
          bulkTier === "SELL_II"
            ? prices.sellIi
            : bulkTier === "MINM"
              ? prices.minm
              : bulkTier === "ROCK"
                ? prices.rock
                : prices.sellPrice;
        if (unit == null || !canTier(bulkTier)) return r;
        return { ...r, priceTier: bulkTier };
      })
    );
  }

  if (!allowed) {
    return <div className="rounded-2xl border bg-white p-6 text-sm">Sales create permission is required.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <h1 className="text-2xl font-semibold">MAN RFQ / Quotation</h1>
        <p className="text-sm text-slate-600">
          Match customer Part no to MAN Item Master SPN, pick a permitted selling tier, then generate a standard draft
          quotation. Creating a quotation does not reserve stock. Manual quotations remain available on Sales.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Customer
            <input
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder="Search customer name"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            <select
              className="mt-1 w-full rounded border px-2 py-1"
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
              className="mt-1 w-full rounded border px-2 py-1"
              value={header.currency}
              onChange={(e) => setHeader((h) => ({ ...h, currency: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => e.target.files?.[0] && matchMut.mutate(e.target.files[0])}
          />
          <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={() => fileRef.current?.click()}>
            Upload RFQ CSV
          </button>
          <LoadingButton loading={refreshMut.isPending} disabled={!lines.length} onClick={() => refreshMut.mutate()}>
            Recheck availability
          </LoadingButton>
          <label className="flex items-center gap-2 text-sm">
            Bulk tier
            <select className="rounded border px-2 py-1" value={bulkTier} onChange={(e) => setBulkTier(e.target.value)}>
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
          <LoadingButton loading={createMut.isPending} disabled={!ready || createMut.isPending} onClick={() => createMut.mutate()}>
            Create draft quotation
          </LoadingButton>
        </div>
        {createMut.error?.code === "STALE_PRICE" ? (
          <p className="mt-2 text-sm text-amber-800">
            Prices changed
            {createMut.error?.body?.article || createMut.error?.article
              ? ` for Article ${createMut.error.body?.article || createMut.error.article}`
              : ""}
            . Recheck availability or re-upload the RFQ, then review the affected row.
          </p>
        ) : null}
        {created ? (
          <p className="mt-2 text-sm text-emerald-700">
            Draft quotation {created.quotationNo} — continue QTN → OA from Sales.
          </p>
        ) : null}
      </div>

      <div className="overflow-auto rounded-2xl border bg-white">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-left">
            <tr>
              {[
                "Cust line",
                "Part no",
                "Article",
                "Description",
                "UOM",
                "Qty",
                "Tier",
                "Price",
                "Total",
                "Availability",
                "Status",
                "Exclude",
              ].map((h) => (
                <th key={h} className="px-2 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((ln, idx) => {
              const cand = (ln.candidates || []).find((c) => c.article === ln.selectedArticle) || ln.candidates?.[0];
              const prices = cand?.prices || {};
              const unit =
                ln.priceTier === "SELL_II"
                  ? prices.sellIi
                  : ln.priceTier === "MINM"
                    ? prices.minm
                    : ln.priceTier === "ROCK"
                      ? prices.rock
                      : prices.sellPrice;
              return (
                <tr key={`${ln.requestedPartNo}-${idx}`} className="border-t align-top">
                  <td className="px-2 py-1">{ln.customerLine}</td>
                  <td className="px-2 py-1 font-mono">{ln.requestedPartNo}</td>
                  <td className="px-2 py-1">
                    {(ln.candidates || []).length > 1 ? (
                      <select
                        className="rounded border px-1 py-0.5"
                        value={ln.selectedArticle || ""}
                        onChange={(e) =>
                          setLines((rows) =>
                            rows.map((r, i) => (i === idx ? { ...r, selectedArticle: e.target.value, status: "MATCHED" } : r))
                          )
                        }
                      >
                        <option value="">Select Article</option>
                        {(ln.candidates || []).map((c) => (
                          <option key={c.article} value={c.article}>
                            {c.article} · {c.spn} · {c.uom} · {c.description}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ln.selectedArticle || "—"
                    )}
                    {(ln.candidates || []).length ? (
                      <div className="mt-1 space-y-1 text-[11px] text-slate-600">
                        {(ln.candidates || []).map((c) => (
                          <div key={c.article}>
                            {c.article} · SPN {c.spn} · {c.description} · {c.model}/{c.config} · {c.uom} · stock{" "}
                            {c.availableQty} · {c.leadTime || "Lead time to be confirmed"}
                            {c.prices
                              ? ` · Sell ${c.prices.sellPrice ?? "—"} / II ${c.prices.sellIi ?? "—"} / Minm ${c.prices.minm ?? "—"}`
                              : " · no price"}
                            {!c.uomOk ? " · UOM mismatch" : ""}
                            {c.modelConflict ? " · model conflict" : ""}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1">{ln.description || cand?.description}</td>
                  <td className="px-2 py-1">{ln.uom}</td>
                  <td className="px-2 py-1">{ln.qty}</td>
                  <td className="px-2 py-1">
                    <select
                      className="rounded border px-1 py-0.5"
                      value={ln.priceTier || "SELL"}
                      onChange={(e) =>
                        setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, priceTier: e.target.value } : r)))
                      }
                    >
                      {permittedTiers.map((t) => {
                        const p =
                          t.id === "SELL_II"
                            ? prices.sellIi
                            : t.id === "MINM"
                              ? prices.minm
                              : t.id === "ROCK"
                                ? prices.rock
                                : prices.sellPrice;
                        return (
                          <option key={t.id} value={t.id} disabled={p == null}>
                            {t.label}
                            {p == null ? " (no price)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td className="px-2 py-1">{unit ?? "—"}</td>
                  <td className="px-2 py-1">{unit != null ? Number(unit) * Number(ln.qty || 0) : "—"}</td>
                  <td className="px-2 py-1">{ln.availability}</td>
                  <td className="px-2 py-1">{ln.status}</td>
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      checked={Boolean(ln.exclude)}
                      onChange={(e) =>
                        setLines((rows) =>
                          rows.map((r, i) =>
                            i === idx ? { ...r, exclude: e.target.checked, excludeReason: r.exclusionReason || "excluded" } : r
                          )
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
