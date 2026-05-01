import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { TextInput } from "../components/erp/FormField.jsx";
import Modal from "../components/erp/Modal.jsx";
import Inventory from "./Inventory.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost, apiPut } from "../lib/api.js";

function money(n) {
  return Number(n || 0).toFixed(2);
}

const BOX_MATERIALS = ["WOODEN", "CARDBOARD", "PLYWOOD", "PALLET", "OTHER"];

function emptyBoxRow() {
  return { material: "WOODEN", count: 1, dimensionsMm: "", remarks: "" };
}

function escapeCsv(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(filename, headers, rows) {
  const head = headers.map(escapeCsv).join(",");
  const body = rows.map((r) => r.map(escapeCsv).join(",")).join("\n");
  const csv = `\ufeff${[head, body].filter(Boolean).join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function rtsCsvHeaders() {
  return [
    "Record Type",
    "RTS No",
    "RTS Date",
    "Allocation No",
    "Customer",
    "Total Weight Kg",
    "Box Material",
    "Box Count",
    "Box Dimensions mm",
    "Box Remarks",
    "S/N",
    "Article",
    "Part no",
    "Description",
    "UOM",
    "Qty",
    "Unit Weight Kg",
    "Total Line Weight Kg",
  ];
}

function rtsCsvRows(doc) {
  const boxes = Array.isArray(doc?.packingDetails?.boxes) ? doc.packingDetails.boxes : [];
  const lines = Array.isArray(doc?.lines) ? doc.lines : [];
  const base = [
    doc?.rtsNo || "",
    doc?.rtsDate ? new Date(doc.rtsDate).toISOString().slice(0, 10) : "",
    doc?.linkedOrderAllocationNo || "",
    doc?.customerName || "",
    doc?.packingDetails?.totalWeightKg ?? "",
  ];
  const boxRows = boxes.map((b) => [
    "BOX",
    ...base,
    b?.material || "",
    b?.count ?? "",
    b?.dimensionsMm || "",
    b?.remarks || "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  const lineRows = lines.map((line) => [
    "ITEM",
    ...base,
    "",
    "",
    "",
    "",
    line?.serialNo ?? "",
    line?.article || "",
    line?.partNumber || "",
    line?.description || "",
    line?.uom || "",
    line?.qty ?? 0,
    line?.unitWeightKg ?? "",
    line?.totalWeightKg ?? "",
  ]);
  return [...boxRows, ...lineRows];
}

function renderPackingListPrintWindow(rts, autoPrint = false) {
  if (!rts) return;
  const rows = Array.isArray(rts.lines) ? rts.lines : [];
  const boxes = Array.isArray(rts.packingDetails?.boxes) ? rts.packingDetails.boxes : [];
  const totalBoxes = boxes.reduce((acc, b) => acc + (Number(b.count || 0) || 0), 0);
  const html = `
    <html>
      <head>
        <title>Packing List ${rts.rtsNo || ""}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; color: #111; }
          .top { display:flex; justify-content:space-between; margin-bottom: 14px; }
          .title { font-size: 24px; font-weight: 700; letter-spacing: 0.2px; }
          .meta { font-size: 12px; color:#444; margin-bottom: 8px; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #ddd; padding: 6px; font-size: 12px; text-align: left; }
          th { background: #f5f5f5; }
          .right { text-align: right; }
          .pack { margin-top: 12px; border:1px solid #ddd; border-radius:6px; padding:10px; width:360px; margin-left:auto; }
          .pack div { display:flex; justify-content:space-between; margin:2px 0; font-size:12px; }
        </style>
      </head>
      <body>
        <div class="top">
          <div>
            <div class="title">Packing List</div>
            <div class="meta">RTS No: ${rts.rtsNo || "-"}</div>
            <div class="meta">Date: ${rts.rtsDate ? new Date(rts.rtsDate).toLocaleDateString() : "-"}</div>
          </div>
          <div>
            <div class="meta">Customer: ${rts.customerName || "-"}</div>
            <div class="meta">Order Allocation: ${rts.linkedOrderAllocationNo || "-"}</div>
            <div class="meta">Status: ${rts.status || "-"}</div>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>S/N</th><th>Article</th><th>Part no</th><th>Description</th><th>UOM</th><th class="right">Qty</th><th class="right">Unit wt (Kg)</th><th class="right">Total wt (Kg)</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (line) => `<tr>
                    <td>${line.serialNo ?? ""}</td>
                    <td>${line.article || ""}</td>
                    <td>${line.partNumber || ""}</td>
                    <td>${line.description || ""}</td>
                    <td>${line.uom || ""}</td>
                    <td class="right">${line.qty || 0}</td>
                    <td class="right">${line.unitWeightKg == null ? "" : money(line.unitWeightKg)}</td>
                    <td class="right">${line.totalWeightKg == null ? "" : money(line.totalWeightKg)}</td>
                  </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="pack">
          <div><span>Total Weight (Kg)</span><b>${money(rts.packingDetails?.totalWeightKg || 0)}</b></div>
          <div><span>No. of Boxes</span><b>${Number(totalBoxes || rts.packingDetails?.boxCount || 0)}</b></div>
        </div>
        ${
          boxes.length
            ? `<table>
          <thead>
            <tr><th>S/N</th><th>Material</th><th class="right">Count</th><th>Dimensions (mm)</th><th>Remarks</th></tr>
          </thead>
          <tbody>
            ${boxes
              .map(
                (b, i) => `<tr>
              <td>${i + 1}</td>
              <td>${b.material || "-"}</td>
              <td class="right">${Number(b.count || 0)}</td>
              <td>${b.dimensionsMm || "-"}</td>
              <td>${b.remarks || "-"}</td>
            </tr>`
              )
              .join("")}
          </tbody>
        </table>`
            : ""
        }
      </body>
    </html>
  `;
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  if (autoPrint) setTimeout(() => win.print(), 300);
}

export default function Store() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("orders");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [allocationOpenId, setAllocationOpenId] = useState(null);
  const [rtsOpenId, setRtsOpenId] = useState(null);
  const [selected, setSelected] = useState({});
  const [packing, setPacking] = useState({
    totalWeightKg: "",
    boxes: [emptyBoxRow()],
  });
  const limit = 20;

  const { data: allocationData, isLoading: allocationLoading } = useQuery({
    queryKey: ["store-order-allocations", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/order-allocations", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: tab === "orders",
  });

  const { data: allocationDetail } = useQuery({
    queryKey: ["store-order-allocation-detail", allocationOpenId],
    queryFn: () => apiGet(`/sales/order-allocations/${allocationOpenId}`),
    enabled: !!allocationOpenId,
  });

  const { data: rtsData, isLoading: rtsLoading } = useQuery({
    queryKey: ["store-rts", page, search],
    queryFn: () =>
      apiGetWithQuery("/sales/rts", {
        page,
        limit,
        search: search || undefined,
      }),
    enabled: tab === "rts",
  });

  const { data: rtsDetail } = useQuery({
    queryKey: ["store-rts-detail", rtsOpenId],
    queryFn: () => apiGet(`/sales/rts/${rtsOpenId}`),
    enabled: !!rtsOpenId,
  });

  const [rtsEditForm, setRtsEditForm] = useState(null);

  useEffect(() => {
    if (!rtsDetail) {
      setRtsEditForm(null);
      return;
    }
    setRtsEditForm({
      rtsDate: rtsDetail.rtsDate ? new Date(rtsDetail.rtsDate).toISOString().slice(0, 10) : "",
      status: rtsDetail.status || "DRAFT",
      lines: Array.isArray(rtsDetail.lines) ? rtsDetail.lines.map((l, idx) => ({ ...l, serialNo: idx + 1 })) : [],
      packingDetails: {
        totalWeightKg: rtsDetail.packingDetails?.totalWeightKg ?? 0,
        boxes:
          Array.isArray(rtsDetail.packingDetails?.boxes) && rtsDetail.packingDetails.boxes.length
            ? rtsDetail.packingDetails.boxes.map((b) => ({
                material: b.material || "WOODEN",
                count: b.count ?? 1,
                dimensionsMm: b.dimensionsMm || "",
                remarks: b.remarks || "",
              }))
            : [emptyBoxRow()],
      },
      editable: !!rtsDetail.editable,
    });
  }, [rtsDetail]);

  const createRtsMutation = useMutation({
    mutationFn: () => {
      const lines = (allocationDetail?.lines || [])
        .map((line) => {
          const s = selected[String(line._id)] || {};
          const qty = Number(s.qty || 0);
          if (!(qty > 0)) return null;
          return {
            allocationLineId: line._id,
            qty,
            unitWeightKg: s.unitWeightKg === "" ? null : Number(s.unitWeightKg),
          };
        })
        .filter(Boolean);
      return apiPost(`/sales/order-allocations/${allocationOpenId}/rts`, {
        lines,
        packingDetails: {
          totalWeightKg: Number(packing.totalWeightKg || 0),
          boxes: (packing.boxes || []).map((b) => ({
            material: b.material || "",
            count: Number(b.count || 0),
            dimensionsMm: b.dimensionsMm || "",
            remarks: b.remarks || "",
          })),
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocation-detail", allocationOpenId] });
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      setAllocationOpenId(null);
      setSelected({});
      setPacking({ totalWeightKg: "", boxes: [emptyBoxRow()] });
    },
  });

  const approveRtsMutation = useMutation({
    mutationFn: (id) => apiPatch(`/sales/rts/${id}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
    },
  });

  const updateRtsMutation = useMutation({
    mutationFn: (payload) => apiPut(`/sales/rts/${rtsOpenId}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-rts"] });
      if (rtsOpenId) qc.invalidateQueries({ queryKey: ["store-rts-detail", rtsOpenId] });
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
    },
  });

  const convertAllocationToInvoiceMutation = useMutation({
    mutationFn: (id) => apiPost(`/sales/order-allocations/${id}/to-sales-invoice`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store-order-allocations"] });
    },
  });

  const rows = allocationData?.items || [];
  const rtsRows = rtsData?.items || [];
  const totalPages = Math.max(1, Math.ceil((allocationData?.total || 0) / limit));
  const rtsPages = Math.max(1, Math.ceil((rtsData?.total || 0) / limit));

  const canSubmitRts = useMemo(() => {
    const anySelected = Object.values(selected).some((x) => Number(x?.qty || 0) > 0);
    return anySelected && !createRtsMutation.isPending;
  }, [selected, createRtsMutation.isPending]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Store"
        subtitle="Order allocation processing, RTS creation, and inventory visibility."
      />

      <div className="flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {[
          { key: "orders", label: "Order List" },
          { key: "rts", label: "RTS" },
          { key: "inventory", label: "Inventory" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            className={`rounded-xl px-3 py-1.5 text-sm ${tab === t.key ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`}
            onClick={() => {
              setTab(t.key);
              setPage(1);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "inventory" ? (
        <Inventory />
      ) : tab === "orders" ? (
        <>
          <div className="rounded-2xl border bg-white p-3">
            <TextInput
              className="w-72"
              placeholder="Search allocation/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">Allocation No</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Linked</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationLoading ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={6}>Loading...</td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={6}>No order allocation found.</td></tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs">{r.allocationNo}</td>
                        <td className="px-3 py-2">{r.allocationDate ? new Date(r.allocationDate).toLocaleDateString() : "-"}</td>
                        <td className="px-3 py-2">{r.customerName}</td>
                        <td className="px-3 py-2 text-xs">{r.linkedProformaNo || r.linkedOANo || "-"}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setAllocationOpenId(r._id)}>
                              Create RTS
                            </button>
                            {r.latestApprovedRtsId ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-lg border px-2 py-1 text-xs"
                                  onClick={() =>
                                    apiGet(`/sales/rts/${r.latestApprovedRtsId}`)
                                      .then((doc) => renderPackingListPrintWindow(doc))
                                      .catch(() => {})
                                  }
                                >
                                  Print
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg border px-2 py-1 text-xs"
                                  onClick={() =>
                                    apiGet(`/sales/rts/${r.latestApprovedRtsId}`)
                                      .then((doc) => renderPackingListPrintWindow(doc, true))
                                      .catch(() => {})
                                  }
                                >
                                  Export PDF
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg border px-2 py-1 text-xs"
                                  onClick={() =>
                                    apiGet(`/sales/rts/${r.latestApprovedRtsId}`)
                                      .then((doc) =>
                                        downloadCsv(
                                          `packing-list-${doc.rtsNo || "rts"}.csv`,
                                          rtsCsvHeaders(),
                                          rtsCsvRows(doc)
                                        )
                                      )
                                      .catch(() => {})
                                  }
                                >
                                  Export CSV
                                </button>
                              </>
                            ) : null}
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() => convertAllocationToInvoiceMutation.mutate(r._id)}
                            >
                              Convert to SI
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>Page {page}/{totalPages} · {allocationData?.total || 0} allocations</span>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-2xl border bg-white p-3">
            <TextInput
              className="w-72"
              placeholder="Search RTS/customer"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="overflow-hidden rounded-2xl border bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b bg-gray-100 text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <tr>
                    <th className="px-3 py-2">RTS No</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Allocation</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Boxes</th>
                    <th className="px-3 py-2">Weight (Kg)</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rtsLoading ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={8}>Loading...</td></tr>
                  ) : rtsRows.length === 0 ? (
                    <tr><td className="px-3 py-8 text-center text-gray-500" colSpan={8}>No RTS found.</td></tr>
                  ) : (
                    rtsRows.map((r) => (
                      <tr key={r._id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs">{r.rtsNo}</td>
                        <td className="px-3 py-2">{r.rtsDate ? new Date(r.rtsDate).toLocaleDateString() : "-"}</td>
                        <td className="px-3 py-2">{r.linkedOrderAllocationNo || "-"}</td>
                        <td className="px-3 py-2">{r.customerName || "-"}</td>
                        <td className="px-3 py-2">{r.packingDetails?.boxCount ?? r.boxCount ?? 0}</td>
                        <td className="px-3 py-2">{money(r.packingDetails?.totalWeightKg ?? r.totalWeightKg ?? 0)}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            <button type="button" className="rounded-lg border px-2 py-1 text-xs" onClick={() => setRtsOpenId(r._id)}>
                              Open
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() =>
                                apiGet(`/sales/rts/${r._id}`)
                                  .then((doc) => renderPackingListPrintWindow(doc))
                                  .catch(() => {})
                              }
                            >
                              Print
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() =>
                                apiGet(`/sales/rts/${r._id}`)
                                  .then((doc) => renderPackingListPrintWindow(doc, true))
                                  .catch(() => {})
                              }
                            >
                              Export PDF
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs"
                              onClick={() =>
                                apiGet(`/sales/rts/${r._id}`)
                                  .then((doc) =>
                                    downloadCsv(
                                      `packing-list-${doc.rtsNo || "rts"}.csv`,
                                      rtsCsvHeaders(),
                                      rtsCsvRows(doc)
                                    )
                                  )
                                  .catch(() => {})
                              }
                            >
                              Export CSV
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border px-2 py-1 text-xs disabled:opacity-40"
                              disabled={String(r.status || "").toUpperCase() === "APPROVED" || !!r.linkedSalesInvoiceId}
                              onClick={() => approveRtsMutation.mutate(r._id)}
                            >
                              Approve
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-gray-600">
              <span>Page {page}/{rtsPages} · {rtsData?.total || 0} RTS</span>
              <div className="flex gap-2">
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <button type="button" className="rounded border px-2 py-1 disabled:opacity-40" disabled={page >= rtsPages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </div>
        </>
      )}

      <Modal
        open={!!allocationOpenId}
        onClose={() => {
          setAllocationOpenId(null);
          setSelected({});
          setPacking({ totalWeightKg: "", boxes: [emptyBoxRow()] });
        }}
        title={`Create RTS${allocationDetail?.allocationNo ? ` • ${allocationDetail.allocationNo}` : ""}`}
        xlarge
      >
        {!allocationDetail ? (
          <p className="text-sm text-gray-500">Loading allocation...</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() => {
                  const next = {};
                  for (const line of allocationDetail.lines || []) {
                    next[String(line._id)] = {
                      qty: Number(line.pendingQty || 0),
                      unitWeightKg: line.unitWeightKg ?? "",
                    };
                  }
                  setSelected(next);
                }}
              >
                Select All Pending
              </button>
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() => {
                  const next = {};
                  for (const line of allocationDetail.lines || []) {
                    next[String(line._id)] = {
                      qty: Number(line.qty || 0),
                      unitWeightKg: line.unitWeightKg ?? "",
                    };
                  }
                  setSelected(next);
                }}
              >
                Select Full Quantities
              </button>
              <button type="button" className="rounded-xl border px-3 py-1.5 text-xs" onClick={() => setSelected({})}>
                Clear Selection
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextInput
                placeholder="Total Weight (Kg)"
                type="number"
                value={packing.totalWeightKg}
                onChange={(e) => setPacking((p) => ({ ...p, totalWeightKg: e.target.value }))}
              />
              <div className="rounded-xl border px-3 py-2 text-xs text-gray-700">
                Total boxes: {(packing.boxes || []).reduce((acc, b) => acc + (Number(b.count || 0) || 0), 0)}
              </div>
            </div>
            <div className="rounded-xl border">
              <div className="flex items-center justify-between border-b bg-gray-50 px-3 py-2">
                <span className="text-xs font-semibold">Box details</span>
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-xs"
                  onClick={() => setPacking((p) => ({ ...p, boxes: [...(p.boxes || []), emptyBoxRow()] }))}
                >
                  + Add box row
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[900px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">S/N</th>
                      <th className="px-2 py-2 text-left">Material</th>
                      <th className="px-2 py-2 text-right">Count</th>
                      <th className="px-2 py-2 text-left">Dimensions (LxWxH mm)</th>
                      <th className="px-2 py-2 text-left">Remarks</th>
                      <th className="px-2 py-2 text-left">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(packing.boxes || []).map((box, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded-xl border px-2 py-1 text-xs"
                            value={box.material || "WOODEN"}
                            onChange={(e) =>
                              setPacking((p) => {
                                const boxes = [...(p.boxes || [])];
                                boxes[idx] = { ...box, material: e.target.value };
                                return { ...p, boxes };
                              })
                            }
                          >
                            {BOX_MATERIALS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            value={box.count ?? 1}
                            onChange={(e) =>
                              setPacking((p) => {
                                const boxes = [...(p.boxes || [])];
                                boxes[idx] = { ...box, count: e.target.value };
                                return { ...p, boxes };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            value={box.dimensionsMm || ""}
                            onChange={(e) =>
                              setPacking((p) => {
                                const boxes = [...(p.boxes || [])];
                                boxes[idx] = { ...box, dimensionsMm: e.target.value };
                                return { ...p, boxes };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            value={box.remarks || ""}
                            onChange={(e) =>
                              setPacking((p) => {
                                const boxes = [...(p.boxes || [])];
                                boxes[idx] = { ...box, remarks: e.target.value };
                                return { ...p, boxes };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <button
                            type="button"
                            className="rounded border px-2 py-1 text-xs"
                            onClick={() =>
                              setPacking((p) => {
                                const boxes = (p.boxes || []).filter((_, i) => i !== idx);
                                return { ...p, boxes: boxes.length ? boxes : [emptyBoxRow()] };
                              })
                            }
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-[1100px] w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left">S/N</th>
                    <th className="px-2 py-2 text-left">Article</th>
                    <th className="px-2 py-2 text-left">Part no</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Shipped</th>
                    <th className="px-2 py-2 text-right">Pending</th>
                    <th className="px-2 py-2 text-right">RTS Qty</th>
                    <th className="px-2 py-2 text-right">Unit wt (Kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {(allocationDetail.lines || []).map((line, idx) => {
                    const key = String(line._id);
                    const row = selected[key] || {};
                    return (
                      <tr key={key} className="border-t">
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1">{line.article}</td>
                        <td className="px-2 py-1">{line.partNumber || "-"}</td>
                        <td className="px-2 py-1">{line.description}</td>
                        <td className="px-2 py-1 text-right">{line.qty}</td>
                        <td className="px-2 py-1 text-right">{line.shippedQty || 0}</td>
                        <td className="px-2 py-1 text-right">{line.pendingQty || 0}</td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            value={row.qty ?? ""}
                            onChange={(e) =>
                              setSelected((s) => ({
                                ...s,
                                [key]: { ...row, qty: e.target.value },
                              }))
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            value={row.unitWeightKg ?? line.unitWeightKg ?? ""}
                            onChange={(e) =>
                              setSelected((s) => ({
                                ...s,
                                [key]: { ...row, unitWeightKg: e.target.value },
                              }))
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setAllocationOpenId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                disabled={!canSubmitRts}
                onClick={() => createRtsMutation.mutate()}
              >
                {createRtsMutation.isPending ? "Creating..." : "Create RTS"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!rtsOpenId} onClose={() => setRtsOpenId(null)} title="Packing List (RTS)" xlarge>
        {!rtsDetail || !rtsEditForm ? (
          <p className="text-sm text-gray-500">Loading RTS...</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <TextInput value={rtsDetail.rtsNo || ""} disabled className="bg-gray-50" />
              <TextInput
                type="date"
                value={rtsEditForm.rtsDate}
                disabled={!rtsEditForm.editable}
                onChange={(e) => setRtsEditForm((f) => ({ ...f, rtsDate: e.target.value }))}
              />
              <TextInput value={rtsDetail.customerName || ""} disabled className="bg-gray-50" />
              <TextInput value={rtsDetail.linkedOrderAllocationNo || ""} disabled className="bg-gray-50" />
            </div>
            {!rtsEditForm.editable ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">
                This RTS is linked to Sales Invoice {rtsDetail.linkedSalesInvoiceNo || "-"} and is read-only.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <TextInput
                placeholder="Total Weight (Kg)"
                type="number"
                disabled={!rtsEditForm.editable}
                value={rtsEditForm.packingDetails?.totalWeightKg ?? ""}
                onChange={(e) =>
                  setRtsEditForm((f) => ({
                    ...f,
                    packingDetails: { ...f.packingDetails, totalWeightKg: e.target.value },
                  }))
                }
              />
              <div className="rounded-xl border px-3 py-2 text-xs text-gray-700">
                Total boxes: {((rtsEditForm.packingDetails?.boxes || []).reduce((acc, b) => acc + (Number(b.count || 0) || 0), 0))}
              </div>
            </div>
            <div className="rounded-xl border">
              <div className="flex items-center justify-between border-b bg-gray-50 px-3 py-2">
                <span className="text-xs font-semibold">Box details</span>
                {rtsEditForm.editable ? (
                  <button
                    type="button"
                    className="rounded border px-2 py-1 text-xs"
                    onClick={() =>
                      setRtsEditForm((f) => ({
                        ...f,
                        packingDetails: { ...f.packingDetails, boxes: [...(f.packingDetails?.boxes || []), emptyBoxRow()] },
                      }))
                    }
                  >
                    + Add box row
                  </button>
                ) : null}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[900px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-left">S/N</th>
                      <th className="px-2 py-2 text-left">Material</th>
                      <th className="px-2 py-2 text-right">Count</th>
                      <th className="px-2 py-2 text-left">Dimensions (LxWxH mm)</th>
                      <th className="px-2 py-2 text-left">Remarks</th>
                      <th className="px-2 py-2 text-left">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rtsEditForm.packingDetails?.boxes || []).map((box, idx) => (
                      <tr key={idx} className="border-t">
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1">
                          <select
                            className="w-full rounded-xl border px-2 py-1 text-xs"
                            disabled={!rtsEditForm.editable}
                            value={box.material || "WOODEN"}
                            onChange={(e) =>
                              setRtsEditForm((f) => {
                                const boxes = [...(f.packingDetails?.boxes || [])];
                                boxes[idx] = { ...box, material: e.target.value };
                                return { ...f, packingDetails: { ...f.packingDetails, boxes } };
                              })
                            }
                          >
                            {BOX_MATERIALS.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            type="number"
                            disabled={!rtsEditForm.editable}
                            value={box.count ?? 1}
                            onChange={(e) =>
                              setRtsEditForm((f) => {
                                const boxes = [...(f.packingDetails?.boxes || [])];
                                boxes[idx] = { ...box, count: e.target.value };
                                return { ...f, packingDetails: { ...f.packingDetails, boxes } };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            disabled={!rtsEditForm.editable}
                            value={box.dimensionsMm || ""}
                            onChange={(e) =>
                              setRtsEditForm((f) => {
                                const boxes = [...(f.packingDetails?.boxes || [])];
                                boxes[idx] = { ...box, dimensionsMm: e.target.value };
                                return { ...f, packingDetails: { ...f.packingDetails, boxes } };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <TextInput
                            disabled={!rtsEditForm.editable}
                            value={box.remarks || ""}
                            onChange={(e) =>
                              setRtsEditForm((f) => {
                                const boxes = [...(f.packingDetails?.boxes || [])];
                                boxes[idx] = { ...box, remarks: e.target.value };
                                return { ...f, packingDetails: { ...f.packingDetails, boxes } };
                              })
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          {rtsEditForm.editable ? (
                            <button
                              type="button"
                              className="rounded border px-2 py-1 text-xs"
                              onClick={() =>
                                setRtsEditForm((f) => {
                                  const boxes = (f.packingDetails?.boxes || []).filter((_, i) => i !== idx);
                                  return {
                                    ...f,
                                    packingDetails: { ...f.packingDetails, boxes: boxes.length ? boxes : [emptyBoxRow()] },
                                  };
                                })
                              }
                            >
                              Remove
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <table className="min-w-[1100px] w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left">S/N</th>
                    <th className="px-2 py-2 text-left">Article</th>
                    <th className="px-2 py-2 text-left">Part no</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Unit wt (Kg)</th>
                    <th className="px-2 py-2 text-right">Total wt (Kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {(rtsEditForm.lines || []).map((line, idx) => (
                    <tr key={line._id || idx} className="border-t">
                      <td className="px-2 py-1">{idx + 1}</td>
                      <td className="px-2 py-1">{line.article}</td>
                      <td className="px-2 py-1">{line.partNumber || "-"}</td>
                      <td className="px-2 py-1">{line.description}</td>
                      <td className="px-2 py-1 text-right">{line.qty}</td>
                      <td className="px-2 py-1">
                        <TextInput
                          type="number"
                          disabled={!rtsEditForm.editable}
                          value={line.unitWeightKg ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRtsEditForm((f) => {
                              const lines = [...(f.lines || [])];
                              lines[idx] = {
                                ...line,
                                unitWeightKg: v,
                                totalWeightKg: v === "" ? null : Number(v) * Number(line.qty || 0),
                              };
                              return { ...f, lines };
                            });
                          }}
                        />
                      </td>
                      <td className="px-2 py-1 text-right">{line.totalWeightKg == null ? "" : money(line.totalWeightKg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="rounded-xl border px-3 py-1.5 text-xs" onClick={() => renderPackingListPrintWindow(rtsDetail)}>
                Print
              </button>
              <button type="button" className="rounded-xl border px-3 py-1.5 text-xs" onClick={() => renderPackingListPrintWindow(rtsDetail, true)}>
                Export PDF
              </button>
              <button
                type="button"
                className="rounded-xl border px-3 py-1.5 text-xs"
                onClick={() =>
                  downloadCsv(
                    `packing-list-${rtsDetail.rtsNo || "rts"}.csv`,
                    rtsCsvHeaders(),
                    rtsCsvRows({ ...rtsDetail, lines: rtsEditForm.lines, packingDetails: rtsEditForm.packingDetails })
                  )
                }
              >
                Export CSV
              </button>
              {rtsEditForm.editable ? (
                <button
                  type="button"
                  className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  disabled={updateRtsMutation.isPending}
                  onClick={() =>
                    updateRtsMutation.mutate({
                      rtsDate: rtsEditForm.rtsDate,
                      status: rtsEditForm.status,
                      packingDetails: {
                        totalWeightKg: Number(rtsEditForm.packingDetails?.totalWeightKg || 0),
                        boxes: (rtsEditForm.packingDetails?.boxes || []).map((b) => ({
                          material: b.material || "",
                          count: Number(b.count || 0),
                          dimensionsMm: b.dimensionsMm || "",
                          remarks: b.remarks || "",
                        })),
                      },
                      lines: (rtsEditForm.lines || []).map((line) => ({
                        allocationLineId: line.allocationLineId,
                        article: line.article,
                        partNumber: line.partNumber,
                        description: line.description,
                        qty: Number(line.qty || 0),
                        uom: line.uom || "PCS",
                        remarks: line.remarks || "",
                        materialCode: line.materialCode || "",
                        availability: line.availability || "",
                        unitWeightKg: line.unitWeightKg === "" ? null : Number(line.unitWeightKg),
                      })),
                    })
                  }
                >
                  {updateRtsMutation.isPending ? "Saving..." : "Save changes"}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

