import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiGet, apiPost, apiPut } from "../lib/api.js";

export default function Store() {
  const [activeSub, setActiveSub] = useState("GRN");
  const [poList, setPoList] = useState([]);
  const [poLoading, setPoLoading] = useState(false);
  const [poErr, setPoErr] = useState("");
  const [selectedPoId, setSelectedPoId] = useState("");
  const [grnItems, setGrnItems] = useState([]);
  const [grnNote, setGrnNote] = useState("");
  const [grnErr, setGrnErr] = useState("");
  const [grnSaving, setGrnSaving] = useState(false);
  const [grnSuccess, setGrnSuccess] = useState("");
  const [grnList, setGrnList] = useState([]);
  const [grnLoading, setGrnLoading] = useState(false);
  const [grnReportErr, setGrnReportErr] = useState("");

  const [ptgList, setPtgList] = useState([]);
  const [ptgLoading, setPtgLoading] = useState(false);
  const [ptgErr, setPtgErr] = useState("");
  const [selectedPtgId, setSelectedPtgId] = useState("");
  const [ptgItems, setPtgItems] = useState([]);
  const [ptgDimensions, setPtgDimensions] = useState("");
  const [ptgWeight, setPtgWeight] = useState("");
  const [ptgNotes, setPtgNotes] = useState("");
  const [ptgSaving, setPtgSaving] = useState(false);

  async function loadPurchaseOrders() {
    setPoErr("");
    setPoLoading(true);
    try {
      const data = await apiGet("/purchase/po");
      setPoList(data);
    } catch (e) {
      setPoErr(e.message || "Failed to load purchase orders");
    } finally {
      setPoLoading(false);
    }
  }

  useEffect(() => {
    loadPurchaseOrders();
    loadGrns();
    loadPtg();
  }, []);

  async function loadGrns() {
    setGrnReportErr("");
    setGrnLoading(true);
    try {
      const data = await apiGet("/purchase/grn");
      setGrnList(data);
    } catch (e) {
      setGrnReportErr(e.message || "Failed to load GRN report");
    } finally {
      setGrnLoading(false);
    }
  }

  async function loadPtg() {
    setPtgErr("");
    setPtgLoading(true);
    try {
      const data = await apiGet("/sales/docs?type=PTG");
      setPtgList(data);
    } catch (e) {
      setPtgErr(e.message || "Failed to load PTG");
    } finally {
      setPtgLoading(false);
    }
  }

  const eligiblePos = useMemo(
    () => poList.filter((po) => ["SAVED", "PARTIAL"].includes(po.status)),
    [poList]
  );

  const selectedPo = useMemo(
    () => eligiblePos.find((po) => po._id === selectedPoId) || null,
    [eligiblePos, selectedPoId]
  );

  useEffect(() => {
    if (!selectedPo) {
      setGrnItems([]);
      return;
    }
    setGrnItems(
      (selectedPo.items || []).map((row) => ({
        articleNo: row.articleNo || "",
        description: row.description || "",
        uom: row.uom || "",
        orderedQty: Number(row.qty) || 0,
        receivedQty: Number(row.receivedQty) || 0,
        receiveQty: 0,
      }))
    );
  }, [selectedPo]);

  const selectedPtg = useMemo(
    () => ptgList.find((p) => p._id === selectedPtgId) || null,
    [ptgList, selectedPtgId]
  );

  useEffect(() => {
    if (!selectedPtg) {
      setPtgItems([]);
      setPtgDimensions("");
      setPtgWeight("");
      setPtgNotes("");
      return;
    }
    setPtgItems(
      (selectedPtg.items || []).map((it) => ({
        sku: it.sku || "",
        description: it.description || "",
        uom: it.uom || "",
        qty: Number(it.qty) || 0,
        packedQty: 0,
      }))
    );
    setPtgDimensions(selectedPtg.packing?.dimensions || "");
    setPtgWeight(selectedPtg.packing?.weight || "");
    setPtgNotes(selectedPtg.packing?.notes || "");
  }, [selectedPtg]);

  function downloadCsv(filename, rows) {
    const csv = rows
      .map((row) =>
        row
          .map((cell) =>
            `"${String(cell ?? "")
              .replace(/"/g, '""')
              .replace(/\r?\n/g, " ")}"`
          )
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function handleGrnImport(file) {
    if (!file) return;
    setGrnErr("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const normalized = rows.map((row) => {
        const entry = {};
        Object.entries(row).forEach(([k, v]) => {
          const key = String(k).toLowerCase().replace(/\s+/g, "");
          entry[key] = v;
        });
        return entry;
      });

      setGrnItems((prev) =>
        prev.map((row) => {
          const match = normalized.find((r) => {
            const article =
              r.articlenr || r.article || r.articleno || r.articlenumber || "";
            return String(article || "").trim() === row.articleNo;
          });
          if (!match) return row;
          const qty = match.receivenow || match.receive || match.qty || 0;
          const maxQty = Math.max(0, row.orderedQty - row.receivedQty);
          const next = Math.max(0, Math.min(Number(qty) || 0, maxQty));
          return { ...row, receiveQty: next };
        })
      );
    } catch (e) {
      setGrnErr(e.message || "Failed to import GRN Excel.");
    }
  }

  function exportGrnCsv() {
    if (!selectedPo) {
      setGrnErr("Select a purchase order.");
      return;
    }
    const rows = [
      ["PO No", selectedPo.poNo || ""],
      ["Supplier", selectedPo.supplierName || ""],
      [],
      ["Article", "Description", "UOM", "Ordered", "Received", "Receive Now"],
      ...grnItems.map((row) => [
        row.articleNo || "",
        row.description || "",
        row.uom || "",
        row.orderedQty || 0,
        row.receivedQty || 0,
        row.receiveQty || 0,
      ]),
    ];
    downloadCsv(`grn-${selectedPo.poNo || "po"}.csv`, rows);
  }

  async function exportGrnReportCsv() {
    const rows = [
      ["GRN No", "Date", "PO No", "Supplier", "Items", "Total Qty"],
      ...grnList.map((g) => {
        const totalQty = (g.items || []).reduce(
          (sum, it) => sum + (Number(it.qty) || 0),
          0
        );
        return [
          g.grnNo || "",
          g.createdAt ? new Date(g.createdAt).toLocaleDateString() : "",
          g.poNo || "",
          g.supplier || "",
          (g.items || []).length,
          totalQty,
        ];
      }),
    ];
    downloadCsv("grn-report.csv", rows);
  }

  async function exportGrnReportPdf() {
    const doc = new jsPDF({ format: "a4", unit: "mm" });
    doc.setTextColor(0, 0, 0);
    doc.text("GRN Report", 14, 16);
    const body = grnList.map((g) => {
      const totalQty = (g.items || []).reduce(
        (sum, it) => sum + (Number(it.qty) || 0),
        0
      );
      return [
        g.grnNo || "",
        g.createdAt ? new Date(g.createdAt).toLocaleDateString() : "",
        g.poNo || "",
        g.supplier || "",
        String((g.items || []).length),
        String(totalQty),
      ];
    });
    autoTable(doc, {
      startY: 22,
      head: [["GRN No", "Date", "PO No", "Supplier", "Items", "Total Qty"]],
      body,
      styles: { fontSize: 9 },
    });
    doc.save("grn-report.pdf");
  }

  function onReceiveQtyChange(index, value) {
    setGrnItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const maxQty = Math.max(0, row.orderedQty - row.receivedQty);
        const next = Math.max(0, Math.min(Number(value) || 0, maxQty));
        return { ...row, receiveQty: next };
      })
    );
  }

  async function saveGrn() {
    setGrnErr("");
    setGrnSuccess("");
    if (!selectedPo) {
      setGrnErr("Select a purchase order.");
      return;
    }
    const itemsPayload = grnItems
      .filter((row) => Number(row.receiveQty) > 0)
      .map((row) => ({
        sku: row.articleNo,
        articleNo: row.articleNo,
        description: row.description,
        uom: row.uom,
        qty: Number(row.receiveQty) || 0,
      }));
    if (!itemsPayload.length) {
      setGrnErr("Enter at least one GRN quantity.");
      return;
    }
    setGrnSaving(true);
    try {
      await apiPost("/purchase/grn", {
        poId: selectedPo._id,
        poNo: selectedPo.poNo,
        supplier: selectedPo.supplierName || "",
        note: grnNote,
        items: itemsPayload,
      });
      setGrnSuccess("GRN saved and stock updated ✅");
      setSelectedPoId("");
      setGrnNote("");
      setGrnItems([]);
      await loadPurchaseOrders();
      await loadGrns();
    } catch (e) {
      setGrnErr(e.message || "Failed to save GRN");
    } finally {
      setGrnSaving(false);
    }
  }

  async function savePtg() {
    setPtgErr("");
    if (!selectedPtg) {
      setPtgErr("Select a PTG document.");
      return;
    }
    const packedItems = ptgItems
      .filter((row) => Number(row.packedQty) > 0)
      .map((row) => ({ sku: row.sku, qty: Number(row.packedQty) || 0 }));
    if (!packedItems.length) {
      setPtgErr("Enter packed qty for at least one item.");
      return;
    }
    setPtgSaving(true);
    try {
      await apiPut(`/sales/ptg/${selectedPtg._id}`, {
        dimensions: ptgDimensions,
        weight: ptgWeight,
        notes: ptgNotes,
        packedItems,
      });
      await loadPtg();
      setSelectedPtgId("");
      setPtgItems([]);
      setPtgDimensions("");
      setPtgWeight("");
      setPtgNotes("");
    } catch (e) {
      setPtgErr(e.message || "Failed to save PTG");
    } finally {
      setPtgSaving(false);
    }
  }

  const subModules = ["GRN", "GRN Report", "PTG"];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {subModules.map((label) => (
            <button
              key={label}
              onClick={() => setActiveSub(label)}
              className={[
                "rounded-xl px-3 py-2 text-sm border",
                activeSub === label
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 hover:bg-gray-50",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeSub === "GRN" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-semibold">GRN</h1>
              <p className="mt-1 text-sm text-gray-600">
                Create GRN from Saved/Partial purchase orders.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                Import
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => handleGrnImport(e.target.files?.[0])}
                  className="hidden"
                />
              </label>
              <button
                onClick={exportGrnCsv}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export
              </button>
              <button
                onClick={loadPurchaseOrders}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh POs
              </button>
            </div>
          </div>

          {poErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {poErr}
            </div>
          )}
          {grnErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {grnErr}
            </div>
          )}
          {grnSuccess && (
            <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {grnSuccess}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-1 space-y-3">
              <div>
                <label className="text-sm text-gray-600">Purchase Order</label>
                <select
                  value={selectedPoId}
                  onChange={(e) => setSelectedPoId(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="">Select saved PO...</option>
                  {eligiblePos.map((po) => (
                    <option key={po._id} value={po._id}>
                      {po.poNo} • {po.supplierName} • {po.status}
                    </option>
                  ))}
                </select>
                {poLoading && (
                  <div className="mt-2 text-xs text-gray-500">Loading...</div>
                )}
              </div>
              <div>
                <label className="text-sm text-gray-600">Note</label>
                <textarea
                  value={grnNote}
                  onChange={(e) => setGrnNote(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <button
                onClick={saveGrn}
                disabled={grnSaving}
                className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {grnSaving ? "Saving..." : "Save GRN"}
              </button>
            </div>

            <div className="lg:col-span-2">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">Article</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Ordered</th>
                      <th className="py-2 pr-3">Received</th>
                      <th className="py-2 pr-3">Balance</th>
                      <th className="py-2 pr-3">Receive Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grnItems.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={7}>
                          Select a PO to load items.
                        </td>
                      </tr>
                    ) : (
                      grnItems.map((row, idx) => {
                        const balance = Math.max(
                          0,
                          row.orderedQty - row.receivedQty
                        );
                        return (
                          <tr key={`${row.articleNo}-${idx}`} className="border-b">
                            <td className="py-2 pr-3">{row.articleNo || "-"}</td>
                            <td className="py-2 pr-3">{row.description || "-"}</td>
                            <td className="py-2 pr-3">{row.uom || "-"}</td>
                            <td className="py-2 pr-3">{row.orderedQty}</td>
                            <td className="py-2 pr-3">{row.receivedQty}</td>
                            <td className="py-2 pr-3">{balance}</td>
                            <td className="py-2 pr-3">
                              <input
                                type="number"
                                min="0"
                                max={balance}
                                value={row.receiveQty}
                                onChange={(e) =>
                                  onReceiveQtyChange(idx, e.target.value)
                                }
                                disabled={balance <= 0}
                                className="w-24 rounded-lg border px-2 py-1 text-xs disabled:opacity-50"
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Items with GRN received are locked in the PO and cannot be
                reduced below received quantity.
              </div>
            </div>
          </div>
        </div>
      )}

      {activeSub === "GRN Report" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-semibold">GRN Report</h1>
              <p className="mt-1 text-sm text-gray-600">
                All saved GRNs.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={loadGrns}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
              <button
                onClick={exportGrnReportCsv}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export CSV
              </button>
              <button
                onClick={exportGrnReportPdf}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Export PDF
              </button>
            </div>
          </div>

          {grnReportErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {grnReportErr}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-gray-600">
                <tr>
                  <th className="py-2 pr-3">GRN No</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">PO No</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3">Items</th>
                  <th className="py-2 pr-3">Total Qty</th>
                </tr>
              </thead>
              <tbody>
                {grnLoading ? (
                  <tr>
                    <td className="py-6 text-gray-500" colSpan={6}>
                      Loading...
                    </td>
                  </tr>
                ) : grnList.length === 0 ? (
                  <tr>
                    <td className="py-6 text-gray-500" colSpan={6}>
                      No GRNs yet.
                    </td>
                  </tr>
                ) : (
                  grnList.map((g) => {
                    const totalQty = (g.items || []).reduce(
                      (sum, it) => sum + (Number(it.qty) || 0),
                      0
                    );
                    return (
                      <tr key={g._id} className="border-b last:border-b-0">
                        <td className="py-2 pr-3 font-medium">{g.grnNo}</td>
                        <td className="py-2 pr-3">
                          {g.createdAt
                            ? new Date(g.createdAt).toLocaleDateString()
                            : "-"}
                        </td>
                        <td className="py-2 pr-3">{g.poNo || "-"}</td>
                        <td className="py-2 pr-3">{g.supplier || "-"}</td>
                        <td className="py-2 pr-3">{(g.items || []).length}</td>
                        <td className="py-2 pr-3">{totalQty}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSub === "PTG" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-xl font-semibold">PTG</h1>
              <p className="mt-1 text-sm text-gray-600">
                Pack items and add dimensions for complete/partial orders.
              </p>
            </div>
            <button
              onClick={loadPtg}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>

          {ptgErr && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {ptgErr}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-1 space-y-3">
              <div>
                <label className="text-sm text-gray-600">PTG Document</label>
                <select
                  value={selectedPtgId}
                  onChange={(e) => setSelectedPtgId(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="">Select PTG...</option>
                  {ptgList.map((doc) => (
                    <option key={doc._id} value={doc._id}>
                      {doc.docNo} • {doc.customerName}
                    </option>
                  ))}
                </select>
                {ptgLoading && (
                  <div className="mt-2 text-xs text-gray-500">Loading...</div>
                )}
              </div>
              <div>
                <label className="text-sm text-gray-600">Packing Dimensions</label>
                <input
                  value={ptgDimensions}
                  onChange={(e) => setPtgDimensions(e.target.value)}
                  placeholder="e.g. 120x80x60 cm"
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Weight</label>
                <input
                  value={ptgWeight}
                  onChange={(e) => setPtgWeight(e.target.value)}
                  placeholder="e.g. 120 kg"
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Notes</label>
                <textarea
                  value={ptgNotes}
                  onChange={(e) => setPtgNotes(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <button
                onClick={savePtg}
                disabled={ptgSaving}
                className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ptgSaving ? "Saving..." : "Save PTG"}
              </button>
            </div>

            <div className="lg:col-span-2">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-gray-600">
                    <tr>
                      <th className="py-2 pr-3">SKU</th>
                      <th className="py-2 pr-3">Description</th>
                      <th className="py-2 pr-3">UOM</th>
                      <th className="py-2 pr-3">Qty</th>
                      <th className="py-2 pr-3">Packed Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ptgItems.length === 0 ? (
                      <tr>
                        <td className="py-6 text-gray-500" colSpan={5}>
                          Select a PTG document to load items.
                        </td>
                      </tr>
                    ) : (
                      ptgItems.map((row, idx) => (
                        <tr key={`${row.sku}-${idx}`} className="border-b">
                          <td className="py-2 pr-3">{row.sku || "-"}</td>
                          <td className="py-2 pr-3">
                            {row.description || "-"}
                          </td>
                          <td className="py-2 pr-3">{row.uom || "-"}</td>
                          <td className="py-2 pr-3">{row.qty}</td>
                          <td className="py-2 pr-3">
                            <input
                              type="number"
                              min="0"
                              max={row.qty}
                              value={row.packedQty}
                              onChange={(e) =>
                                setPtgItems((prev) =>
                                  prev.map((r, i) =>
                                    i === idx
                                      ? {
                                          ...r,
                                          packedQty: Math.max(
                                            0,
                                            Math.min(
                                              Number(e.target.value) || 0,
                                              row.qty
                                            )
                                          ),
                                        }
                                      : r
                                  )
                                )
                              }
                              className="w-24 rounded-lg border px-2 py-1 text-xs"
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
  