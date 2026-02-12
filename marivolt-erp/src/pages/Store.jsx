import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api.js";

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
  }, []);

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
    } catch (e) {
      setGrnErr(e.message || "Failed to save GRN");
    } finally {
      setGrnSaving(false);
    }
  }

  const subModules = ["GRN"];

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
            <button
              onClick={loadPurchaseOrders}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh POs
            </button>
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
    </div>
  );
}
  