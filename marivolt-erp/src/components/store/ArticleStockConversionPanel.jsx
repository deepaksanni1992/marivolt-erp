import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiGetWithQuery, apiPost } from "../../lib/api.js";
import { notify, confirmDialog } from "../../lib/notifications.js";
import LoadingButton from "../erp/LoadingButton.jsx";

const REASON_LABELS = {
  EQUIVALENT_ARTICLE_NUMBER: "Equivalent Article Number",
  SUPPLIER_PART_TO_OEM: "Supplier Part Number to OEM Article",
  SUPERSEDED_ARTICLE: "Superseded Article",
  CUSTOMER_ARTICLE_MAPPING: "Customer Article Mapping",
  ITEM_MASTER_CORRECTION: "Item Master Correction",
  REPACKING_REBRANDING: "Repacking/Rebranding",
  OTHER: "Other",
};

function StatusPill({ status }) {
  const s = String(status || "").toUpperCase();
  const tone =
    s === "POSTED"
      ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
      : s === "DRAFT"
        ? "bg-amber-100 text-amber-800 ring-amber-200"
        : s === "REVERSED"
          ? "bg-orange-100 text-orange-800 ring-orange-200"
          : "bg-slate-100 text-slate-700 ring-slate-200";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${tone}`}>{s || "—"}</span>;
}

export default function ArticleStockConversionPanel({ locations = [], deepLinkConversionNo = "" }) {
  const qc = useQueryClient();
  const [subTab, setSubTab] = useState("new");
  const [warehouse, setWarehouse] = useState("MAIN");
  const [sourceArticle, setSourceArticle] = useState("");
  const [targetArticle, setTargetArticle] = useState("");
  const [sourceQty, setSourceQty] = useState("");
  const [ratio, setRatio] = useState("1");
  const [reasonCode, setReasonCode] = useState("EQUIVALENT_ARTICLE_NUMBER");
  const [remarks, setRemarks] = useState("");
  const [selectedLotId, setSelectedLotId] = useState("");
  const [regSearch, setRegSearch] = useState("");
  const [reverseReason, setReverseReason] = useState("");
  const [reverseTarget, setReverseTarget] = useState(null);

  const { data: meta } = useQuery({
    queryKey: ["article-conversion-meta"],
    queryFn: () => apiGet("/article-conversions/meta"),
  });

  const { data: sourceCtx, refetch: refetchSource } = useQuery({
    queryKey: ["article-conversion-ctx", sourceArticle, warehouse],
    queryFn: () =>
      apiGetWithQuery("/article-conversions/article-context", {
        article: sourceArticle.trim().toUpperCase(),
        warehouse,
      }),
    enabled: Boolean(sourceArticle.trim()),
    retry: false,
  });

  const { data: targetCtx } = useQuery({
    queryKey: ["article-conversion-ctx", targetArticle, warehouse],
    queryFn: () =>
      apiGetWithQuery("/article-conversions/article-context", {
        article: targetArticle.trim().toUpperCase(),
        warehouse,
      }),
    enabled: Boolean(targetArticle.trim()),
    retry: false,
  });

  const { data: register, refetch: refetchRegister } = useQuery({
    queryKey: ["article-conversions", regSearch],
    queryFn: () => apiGetWithQuery("/article-conversions", { q: regSearch || undefined, limit: 100 }),
    enabled: subTab === "register" || Boolean(deepLinkConversionNo),
  });

  const { data: mappings, refetch: refetchMaps } = useQuery({
    queryKey: ["article-equivalence-mappings"],
    queryFn: () => apiGet("/article-conversions/mappings"),
    enabled: subTab === "mapping",
  });

  useEffect(() => {
    if (deepLinkConversionNo) setSubTab("register");
  }, [deepLinkConversionNo]);

  const targetQty = useMemo(() => {
    const sq = Number(sourceQty) || 0;
    const r = Number(ratio) || 1;
    return Math.round(sq * r * 1e6) / 1e6;
  }, [sourceQty, ratio]);

  const createMut = useMutation({
    mutationFn: (body) => apiPost("/article-conversions", body),
    onSuccess: (doc) => {
      notify.success(`Article conversion ${doc.conversionNo} draft created.`);
      qc.invalidateQueries({ queryKey: ["article-conversions"] });
      setSubTab("register");
    },
    onError: (e) => notify.error(e.message || "Could not create conversion draft."),
  });

  const postMut = useMutation({
    mutationFn: (id) => apiPost(`/article-conversions/${id}/post`, {}),
    onSuccess: (res) => {
      const no = res?.conversion?.conversionNo || "";
      notify.success(`Article conversion ${no} posted successfully.`);
      refetchRegister();
      refetchSource();
    },
    onError: (e) => {
      if (e?.code === "ARTICLE_CONVERSION_STOCK_SHORTAGE") {
        notify.error(
          `Conversion cannot be posted because Source Article ${e.article || ""} has only ${e.availableQty ?? "?"} PCS available.`
        );
        return;
      }
      if (e?.code === "ARTICLE_CONVERSION_MAPPING_REQUIRED") {
        notify.error(e.message || "Admin approval required — no approved equivalence mapping.");
        return;
      }
      notify.error(e.message || "Could not post conversion.");
    },
  });

  const reverseMut = useMutation({
    mutationFn: ({ id, reason }) => apiPost(`/article-conversions/${id}/reverse`, { reason }),
    onSuccess: () => {
      notify.success("Conversion reversed successfully.");
      refetchRegister();
    },
    onError: (e) => notify.error(e.message || "Could not reverse conversion."),
  });

  const approveMut = useMutation({
    mutationFn: (id) => apiPost(`/article-conversions/${id}/approve`, {}),
    onSuccess: () => {
      notify.success("Conversion approved for posting.");
      refetchRegister();
    },
    onError: (e) => notify.error(e.message || "Could not approve."),
  });

  const createMapMut = useMutation({
    mutationFn: (body) => apiPost("/article-conversions/mappings", body),
    onSuccess: () => {
      notify.success("Equivalence mapping submitted for approval.");
      refetchMaps();
      setMapForm({ sourceArticle: "", targetArticle: "", relationshipType: "EQUIVALENT", conversionRatio: "1", remarks: "" });
    },
    onError: (e) => notify.error(e.message || "Could not create mapping."),
  });

  const approveMapMut = useMutation({
    mutationFn: (id) => apiPost(`/article-conversions/mappings/${id}/approve`, {}),
    onSuccess: () => {
      notify.success("Equivalence mapping approved.");
      refetchMaps();
    },
    onError: (e) => notify.error(e.message || "Could not approve mapping."),
  });

  const onCreateDraft = async () => {
    if (!sourceArticle.trim() || !targetArticle.trim()) {
      notify.error("Source and Target articles are required.");
      return;
    }
    if (sourceArticle.trim().toUpperCase() === targetArticle.trim().toUpperCase()) {
      notify.error("Source Article and Target Article must be different.");
      return;
    }
    if (!(Number(sourceQty) > 0)) {
      notify.error("Conversion quantity must be greater than zero.");
      return;
    }
    if (!remarks.trim()) {
      notify.error("Detailed remarks are mandatory.");
      return;
    }
    createMut.mutate({
      warehouse,
      sourceArticle: sourceArticle.trim().toUpperCase(),
      targetArticle: targetArticle.trim().toUpperCase(),
      sourceQty: Number(sourceQty),
      targetQty,
      conversionRatio: Number(ratio) || 1,
      reasonCode,
      remarks: remarks.trim(),
      selectedCustomsLotItemId: selectedLotId || null,
      sourceDescription: sourceCtx?.description || "",
      targetDescription: targetCtx?.description || "",
      sourceUom: sourceCtx?.uom || "PCS",
      targetUom: targetCtx?.uom || "PCS",
      sourceUnitCost: sourceCtx?.unitCost || 0,
    });
  };

  const onPost = async (row) => {
    const ok = await confirmDialog({
      title: "Post Article Stock Conversion?",
      message: `${row.sourceQty} PCS will be removed from Article ${row.sourceArticle} and added to Article ${row.targetArticle}. The original GRN, cost and customs traceability will be preserved.`,
      confirmLabel: "Post Conversion",
      cancelLabel: "Go Back",
      danger: false,
    });
    if (!ok) return;
    postMut.mutate(row._id);
  };

  const onReverse = async (row) => {
    setReverseTarget(row);
    setReverseReason("");
  };

  const confirmReverse = async () => {
    if (!reverseTarget) return;
    if (!reverseReason.trim()) {
      notify.error("Reversal reason is mandatory.");
      return;
    }
    const ok = await confirmDialog({
      title: "Reverse conversion?",
      message: `This will move ${reverseTarget.targetQty} PCS from ${reverseTarget.targetArticle} back to ${reverseTarget.sourceArticle}.`,
      confirmLabel: "Reverse",
      cancelLabel: "Go Back",
      danger: true,
    });
    if (!ok) return;
    reverseMut.mutate({ id: reverseTarget._id, reason: reverseReason.trim() });
    setReverseTarget(null);
    setReverseReason("");
  };

  const locationOptions = (locations || []).length
    ? locations.map((l) => l.locationCode || l)
    : ["MAIN"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 border-b pb-2">
        {[
          ["new", "New Article Conversion"],
          ["register", "Conversion Register"],
          ["mapping", "Article Equivalence Mapping"],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded px-3 py-1.5 text-xs font-medium ${subTab === id ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setSubTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === "new" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border bg-white p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-800">Conversion details</h3>
            <label className="block text-xs text-slate-600">
              Warehouse
              <select className="mt-1 w-full rounded border px-2 py-1.5 text-sm" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                {locationOptions.map((code) => (
                  <option key={code} value={code}>{code}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-600">
              Source Article
              <input className="mt-1 w-full rounded border px-2 py-1.5 text-sm uppercase" value={sourceArticle} onChange={(e) => setSourceArticle(e.target.value)} placeholder="e.g. 8X0098" />
            </label>
            <label className="block text-xs text-slate-600">
              Target Article
              <input className="mt-1 w-full rounded border px-2 py-1.5 text-sm uppercase" value={targetArticle} onChange={(e) => setTargetArticle(e.target.value)} placeholder="e.g. 700004.28" />
            </label>
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-semibold text-slate-800">
              {(sourceArticle || "—").toUpperCase()} <span className="text-slate-400">→</span> {(targetArticle || "—").toUpperCase()}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-slate-600">
                Conversion qty
                <input type="number" min="0" step="any" className="mt-1 w-full rounded border px-2 py-1.5 text-sm" value={sourceQty} onChange={(e) => setSourceQty(e.target.value)} />
              </label>
              <label className="block text-xs text-slate-600">
                Ratio (src→tgt)
                <input type="number" min="0" step="any" className="mt-1 w-full rounded border px-2 py-1.5 text-sm" value={ratio} onChange={(e) => setRatio(e.target.value)} />
              </label>
            </div>
            <p className="text-xs text-slate-500">Target qty: <strong>{targetQty || 0}</strong> {targetCtx?.uom || sourceCtx?.uom || "PCS"}</p>
            <label className="block text-xs text-slate-600">
              Reason code
              <select className="mt-1 w-full rounded border px-2 py-1.5 text-sm" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {(meta?.reasonCodes || Object.keys(REASON_LABELS)).map((code) => (
                  <option key={code} value={code}>{REASON_LABELS[code] || code}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-600">
              Detailed remarks (mandatory)
              <textarea className="mt-1 w-full rounded border px-2 py-1.5 text-sm" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </label>
            {(sourceCtx?.customsLots || []).length ? (
              <label className="block text-xs text-slate-600">
                Source customs lot (optional — FIFO if blank)
                <select className="mt-1 w-full rounded border px-2 py-1.5 text-sm" value={selectedLotId} onChange={(e) => setSelectedLotId(e.target.value)}>
                  <option value="">Auto FIFO</option>
                  {sourceCtx.customsLots.map((lot) => (
                    <option key={lot._id} value={lot._id}>
                      {lot.customsLotRef || lot.grnNo} — avail {lot.qtyAvailable}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <LoadingButton
              type="button"
              className="rounded bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              loading={createMut.isPending}
              onClick={onCreateDraft}
            >
              Save draft conversion
            </LoadingButton>
          </div>
          <div className="rounded-xl border bg-slate-50 p-4 space-y-3 text-sm">
            <h3 className="text-sm font-semibold text-slate-800">Live stock preview</h3>
            <div>
              <div className="text-xs uppercase text-slate-500">Source</div>
              <div className="font-medium">{sourceCtx?.article || sourceArticle || "—"}</div>
              <div className="text-xs text-slate-600">{sourceCtx?.description || "—"}</div>
              <div className="mt-1 grid grid-cols-2 gap-1 text-xs">
                <span>On hand: {sourceCtx?.onHandQty ?? "—"}</span>
                <span className={(Number(sourceCtx?.availableQty) || 0) <= 0 && (Number(sourceCtx?.onHandQty) || 0) > 0 ? "font-semibold text-rose-700" : ""}>
                  Available: {sourceCtx?.availableQty ?? "—"}
                </span>
                <span>Reserved: {sourceCtx?.reservedQty ?? "—"}</span>
                <span>Packed: {sourceCtx?.packedQty ?? "—"}</span>
                <span>UOM: {sourceCtx?.uom || "—"}</span>
                <span>Unit cost: {sourceCtx?.unitCost ?? "—"}</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">available = onHand − reserved − packed</p>
              {sourceCtx?.blockReason ? (
                <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs text-rose-900">
                  {sourceCtx.blockReason}
                  {(sourceCtx.openAllocations || []).length ? (
                    <ul className="mt-1 list-disc pl-4">
                      {sourceCtx.openAllocations.map((a) => (
                        <li key={a.allocationNo}>
                          {a.allocationNo} ({a.status}) — hold {a.holdQty} — {a.customerName || "—"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {(sourceCtx.openPackings || []).length ? (
                    <ul className="mt-1 list-disc pl-4">
                      {sourceCtx.openPackings.map((p) => (
                        <li key={p.packingNo}>
                          Packing {p.packingNo} ({p.status}) — qty {p.packQty}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {sourceCtx?.orphanedReservation ? (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
                  No open Order Allocation found for this article, but the stock balance still has Reserved/Packed qty.
                  Check Store → Stock View (Allocated / Packed columns) and Stock Ledger for {sourceCtx.article}.
                </div>
              ) : null}
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">Target</div>
              <div className="font-medium">{targetCtx?.article || targetArticle || "—"}</div>
              <div className="text-xs text-slate-600">{targetCtx?.description || "—"}</div>
              <div className="mt-1 text-xs">UOM: {targetCtx?.uom || "—"}</div>
            </div>
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              If no approved equivalence mapping exists, posting requires Admin approval. Mapping is never created silently.
            </p>
            <p className="text-xs text-slate-600">
              Customs lot availability is separate from ERP free stock. Conversion requires ERP Available qty.
            </p>
          </div>
        </div>
      ) : null}

      {subTab === "register" ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border px-2 py-1.5 text-sm"
              placeholder="Search conversion no, article, GRN, BOE…"
              value={regSearch}
              onChange={(e) => setRegSearch(e.target.value)}
            />
            <button type="button" className="rounded border px-3 py-1.5 text-xs" onClick={() => refetchRegister()}>Refresh</button>
          </div>
          <div className="overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-left">Conversion No</th>
                  <th className="px-2 py-2 text-left">Date</th>
                  <th className="px-2 py-2 text-left">Source → Target</th>
                  <th className="px-2 py-2 text-right">Src Qty</th>
                  <th className="px-2 py-2 text-right">Tgt Qty</th>
                  <th className="px-2 py-2 text-left">Warehouse</th>
                  <th className="px-2 py-2 text-left">Reason</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-left">Created / Posted</th>
                  <th className="px-2 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(register?.items || []).map((row) => (
                  <tr key={row._id} className={`border-t ${deepLinkConversionNo === row.conversionNo ? "bg-sky-50" : ""}`}>
                    <td className="px-2 py-2 font-medium">{row.conversionNo}</td>
                    <td className="px-2 py-2">{row.conversionDate ? new Date(row.conversionDate).toLocaleDateString() : "—"}</td>
                    <td className="px-2 py-2">{row.sourceArticle} <span className="text-slate-400">→</span> {row.targetArticle}</td>
                    <td className="px-2 py-2 text-right">{row.sourceQty}</td>
                    <td className="px-2 py-2 text-right">{row.targetQty}</td>
                    <td className="px-2 py-2">{row.warehouse}</td>
                    <td className="px-2 py-2">{REASON_LABELS[row.reasonCode] || row.reasonCode}</td>
                    <td className="px-2 py-2"><StatusPill status={row.status} /></td>
                    <td className="px-2 py-2">{row.createdBy || "—"} / {row.postedBy || "—"}</td>
                    <td className="px-2 py-2 space-x-1">
                      {row.status === "DRAFT" && row.requiresAdminApproval && row.approvalStatus !== "APPROVED" ? (
                        <button type="button" className="rounded border px-2 py-0.5 text-[11px]" onClick={() => approveMut.mutate(row._id)}>Approve</button>
                      ) : null}
                      {row.status === "DRAFT" ? (
                        <button type="button" className="rounded border border-emerald-600 px-2 py-0.5 text-[11px] text-emerald-800" onClick={() => onPost(row)}>Post</button>
                      ) : null}
                      {row.status === "POSTED" ? (
                        <button type="button" className="rounded border border-rose-600 px-2 py-0.5 text-[11px] text-rose-800" onClick={() => onReverse(row)}>Reverse</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!(register?.items || []).length ? (
                  <tr><td colSpan={10} className="px-2 py-6 text-center text-slate-500">No conversions found.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {subTab === "mapping" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border p-4 space-y-2">
            <h3 className="text-sm font-semibold">New equivalence mapping</h3>
            <input className="w-full rounded border px-2 py-1.5 text-sm uppercase" placeholder="Source article" value={mapForm.sourceArticle} onChange={(e) => setMapForm((f) => ({ ...f, sourceArticle: e.target.value }))} />
            <input className="w-full rounded border px-2 py-1.5 text-sm uppercase" placeholder="Target article" value={mapForm.targetArticle} onChange={(e) => setMapForm((f) => ({ ...f, targetArticle: e.target.value }))} />
            <select className="w-full rounded border px-2 py-1.5 text-sm" value={mapForm.relationshipType} onChange={(e) => setMapForm((f) => ({ ...f, relationshipType: e.target.value }))}>
              {(meta?.relationshipTypes || ["EQUIVALENT"]).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="w-full rounded border px-2 py-1.5 text-sm" type="number" min="0" step="any" placeholder="Ratio" value={mapForm.conversionRatio} onChange={(e) => setMapForm((f) => ({ ...f, conversionRatio: e.target.value }))} />
            <textarea className="w-full rounded border px-2 py-1.5 text-sm" rows={2} placeholder="Remarks" value={mapForm.remarks} onChange={(e) => setMapForm((f) => ({ ...f, remarks: e.target.value }))} />
            <LoadingButton
              type="button"
              className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white"
              loading={createMapMut.isPending}
              onClick={() =>
                createMapMut.mutate({
                  sourceArticle: mapForm.sourceArticle.trim().toUpperCase(),
                  targetArticle: mapForm.targetArticle.trim().toUpperCase(),
                  relationshipType: mapForm.relationshipType,
                  conversionRatio: Number(mapForm.conversionRatio) || 1,
                  remarks: mapForm.remarks,
                })
              }
            >
              Submit mapping
            </LoadingButton>
          </div>
          <div className="overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-slate-100"><tr>
                <th className="px-2 py-2 text-left">Source → Target</th>
                <th className="px-2 py-2 text-left">Type</th>
                <th className="px-2 py-2 text-right">Ratio</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2" />
              </tr></thead>
              <tbody>
                {(mappings?.items || []).map((m) => (
                  <tr key={m._id} className="border-t">
                    <td className="px-2 py-2">{m.sourceArticle} → {m.targetArticle}</td>
                    <td className="px-2 py-2">{m.relationshipType}</td>
                    <td className="px-2 py-2 text-right">{m.conversionRatio}</td>
                    <td className="px-2 py-2"><StatusPill status={m.approvalStatus} /></td>
                    <td className="px-2 py-2">
                      {m.approvalStatus === "PENDING" ? (
                        <button type="button" className="rounded border px-2 py-0.5" onClick={() => approveMapMut.mutate(m._id)}>Approve</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {reverseTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-4 shadow-lg space-y-3">
            <h3 className="text-sm font-semibold">Reverse {reverseTarget.conversionNo}</h3>
            <p className="text-xs text-slate-600">Enter a mandatory reversal reason.</p>
            <textarea className="w-full rounded border px-2 py-1.5 text-sm" rows={3} value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} autoFocus />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded border px-3 py-1.5 text-xs" onClick={() => setReverseTarget(null)}>Go Back</button>
              <button type="button" className="rounded bg-rose-700 px-3 py-1.5 text-xs text-white" onClick={confirmReverse}>Continue</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
