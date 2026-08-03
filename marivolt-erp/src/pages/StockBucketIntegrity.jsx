import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { apiGetWithQuery, apiPost } from "../lib/api.js";
import { notify, confirmDialog } from "../lib/notifications.js";

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fmt(v) {
  return n(v).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function severityTone(s) {
  if (s === "Critical") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (s === "Major") return "bg-amber-50 text-amber-900 ring-amber-200";
  if (s === "Healthy") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function Kpi({ title, value, tone = "slate" }) {
  const tones = {
    slate: "text-slate-900",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    rose: "text-rose-700",
  };
  return (
    <div className="rounded-xl border bg-white p-3 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tones[tone] || tones.slate}`}>{value}</div>
    </div>
  );
}

export default function StockBucketIntegrity() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState(searchParams.get("company") || "");
  const [warehouse, setWarehouse] = useState(searchParams.get("warehouse") || "");
  const [article, setArticle] = useState(searchParams.get("article") || "");
  const [mismatchType, setMismatchType] = useState(searchParams.get("mismatchType") || "");
  const [includeHealthy, setIncludeHealthy] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [preview, setPreview] = useState(null);

  const queryParams = useMemo(
    () => ({
      company: company || undefined,
      warehouse: warehouse || undefined,
      article: article || undefined,
      mismatchType: mismatchType || undefined,
      includeHealthy: includeHealthy ? "true" : "false",
      limit: 200,
      page: 1,
    }),
    [company, warehouse, article, mismatchType, includeHealthy]
  );

  const auditQ = useQuery({
    queryKey: ["stock-bucket-integrity", queryParams],
    queryFn: () => apiGetWithQuery("/admin/stock/bucket-integrity", queryParams),
  });

  const previewMut = useMutation({
    mutationFn: (body) => apiPost("/admin/stock/bucket-integrity/repair-preview", body),
    onSuccess: (data) => {
      setPreview(data);
      notify.success(`Dry-run preview ready: ${data.candidateCount} safe candidate(s)`);
    },
    onError: (e) => notify.error(e.message || "Preview failed"),
  });

  const repairMut = useMutation({
    mutationFn: (body) => apiPost("/admin/stock/bucket-integrity/repair", body),
    onSuccess: (data) => {
      if (data?.code === "REPAIR_GATED") {
        notify.warning(data.message || "Repair is gated until audit review");
        return;
      }
      notify.success("Repair applied");
      queryClient.invalidateQueries({ queryKey: ["stock-bucket-integrity"] });
    },
    onError: (e) => notify.error(e.message || "Repair failed"),
  });

  const summary = auditQ.data?.summary || {};
  const rows = auditQ.data?.rows || [];

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runPreview = async () => {
    const articles = [...selected]
      .map((k) => k.split("|")[2])
      .filter(Boolean);
    previewMut.mutate({
      companyCode: company || undefined,
      warehouseCode: warehouse || undefined,
      articles,
      mismatchTypes: mismatchType ? [mismatchType] : ["ORPHANED_RESERVED", "ORPHANED_PACKED", "STORED_AVAILABLE_MISMATCH"],
      maxRows: 500,
      reason: "Global stock bucket integrity reconciliation (dry-run)",
    });
  };

  const applyRepair = async () => {
    if (!preview?.previewToken) {
      notify.warning("Run dry-run preview first");
      return;
    }
    const ok = await confirmDialog(
      "Apply controlled projection repair for previewed safe rows?\n\nThis will NOT mutate GRN, customs, ledger on-hand, or documents. Live apply may still be gated until Phase-1 review."
    );
    if (!ok) return;
    repairMut.mutate({
      previewToken: preview.previewToken,
      reason: preview.reason || "Global stock bucket integrity reconciliation",
    });
  };

  const exportCsv = () => {
    window.open(
      `/api/admin/stock/bucket-integrity?${new URLSearchParams({
        ...Object.fromEntries(
          Object.entries(queryParams).filter(([, v]) => v != null && v !== "")
        ),
        format: "csv",
      }).toString()}`,
      "_blank"
    );
  };

  const applyFilters = () => {
    const next = new URLSearchParams();
    if (company) next.set("company", company);
    if (warehouse) next.set("warehouse", warehouse);
    if (article) next.set("article", article);
    if (mismatchType) next.set("mismatchType", mismatchType);
    setSearchParams(next);
  };

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Stock Bucket Integrity"
        subtitle="Read-only reconciliation of StockBalance reserved/packed/on-hand vs live allocation, packing, and ledger. Customs availability is not ERP free stock."
      >
        <div className="flex flex-wrap gap-2">
          <Link
            to="/dashboard/data-health"
            className="rounded-lg border px-3 py-2 text-sm font-semibold hover:bg-slate-50"
          >
            Data Health
          </Link>
          <button
            type="button"
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800"
            onClick={() => auditQ.refetch()}
            disabled={auditQ.isFetching}
          >
            {auditQ.isFetching ? "Scanning…" : "Refresh scan"}
          </button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi title="Scanned" value={fmt(summary.totalStockBalanceRowsScanned)} />
        <Kpi title="Healthy" value={fmt(summary.healthyRows)} tone="emerald" />
        <Kpi title="Mismatches" value={fmt(summary.mismatchRows)} tone="rose" />
        <Kpi title="Orphan reserved" value={fmt(summary.totalOrphanedReservedQty)} tone="amber" />
        <Kpi title="Orphan packed" value={fmt(summary.totalOrphanedPackedQty)} tone="amber" />
      </div>

      <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Company</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="MAR / OKE" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Warehouse</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="MAIN" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Article</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={article} onChange={(e) => setArticle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-slate-600">Mismatch type</span>
            <input className="rounded-lg border px-2 py-2 text-sm" value={mismatchType} onChange={(e) => setMismatchType(e.target.value)} placeholder="ORPHANED_RESERVED" />
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input type="checkbox" checked={includeHealthy} onChange={(e) => setIncludeHealthy(e.target.checked)} />
            Include healthy
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white" onClick={applyFilters}>
            Apply filters
          </button>
          <button
            type="button"
            className="rounded-lg border px-3 py-2 text-sm font-semibold"
            disabled={previewMut.isPending}
            onClick={runPreview}
          >
            Dry-run repair preview
          </button>
          <button
            type="button"
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900"
            disabled={repairMut.isPending || !preview?.previewToken}
            onClick={applyRepair}
          >
            Apply repair (gated)
          </button>
        </div>
        {preview ? (
          <p className="mt-2 text-xs text-slate-600">
            Preview token ready · candidates {preview.candidateCount} · applyEnabled={String(preview.applyEnabled)} ·{" "}
            {preview.applyBlockedReason || ""}
          </p>
        ) : null}
      </div>

      {auditQ.error ? (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {auditQ.error.message}
        </div>
      ) : null}

      <div className="overflow-auto rounded-2xl border bg-white shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Sel</th>
              <th className="px-3 py-2">Article</th>
              <th className="px-3 py-2">Wh / Co</th>
              <th className="px-3 py-2">On Hand</th>
              <th className="px-3 py-2">Res stored / exp</th>
              <th className="px-3 py-2">Pkd stored / exp</th>
              <th className="px-3 py-2">Free stored / exp</th>
              <th className="px-3 py-2">Types</th>
              <th className="px-3 py-2">Sev</th>
              <th className="px-3 py-2">Docs</th>
              <th className="px-3 py-2">Safe</th>
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-slate-500">
                  {auditQ.isLoading ? "Scanning…" : "No mismatch rows (or filters empty)."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const key = `${r.companyId}|${r.warehouseCode}|${r.article}`;
                return (
                  <tr key={key} className="border-t align-top">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        disabled={!r.safeRepairCandidate}
                        checked={selected.has(key)}
                        onChange={() => toggle(key)}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{r.article}</td>
                    <td className="px-3 py-2">
                      {r.warehouseCode}
                      <div className="text-xs text-slate-500">{r.companyCode}</div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{fmt(r.onHandQty)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {fmt(r.storedReservedQty)} / {fmt(r.expectedReservedQty)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {fmt(r.storedPackedQty)} / {fmt(r.expectedPackedQty)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {fmt(r.storedAvailableQty)} / {fmt(r.expectedFreeAvailableQty)}
                    </td>
                    <td className="px-3 py-2 text-xs">{(r.mismatchTypes || []).join(", ")}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${severityTone(r.severity)}`}>
                        {r.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {(r.supportingAllocationNos || []).join(", ") || "—"}
                      <div className="text-slate-500">
                        ghosts: {(r.ghostAllocationLedgerRefs || []).map((g) => g.referenceNo).join(", ") || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2">{r.safeRepairCandidate ? "Yes" : "No"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Status matrix: allocation hold = non-CANCELLED (qty − packedQty). Packed hold = posted packing (packQty −
        dispatchedQty). Last scan: {auditQ.data?.scannedAt || "—"} · mutated={String(auditQ.data?.mutated ?? false)}
      </p>
    </div>
  );
}
