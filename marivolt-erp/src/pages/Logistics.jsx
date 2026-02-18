import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiPost, apiPut } from "../lib/api.js";

export default function Logistics() {
  const [shipments, setShipments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(getEmptyForm());

  function getStatusOptions() {
    return ["PLANNED", "BOOKED", "IN_TRANSIT", "ARRIVED", "DELIVERED", "CLOSED", "CANCELLED"];
  }

  function getDirectionOptions() {
    return ["IMPORT", "EXPORT", "LOCAL"];
  }

  function getModeOptions() {
    return ["SEA", "AIR", "ROAD", "COURIER"];
  }

  async function loadShipments() {
    setErr("");
    setLoading(true);
    try {
      const data = await apiGet("/logistics/shipments");
      setShipments(data);
    } catch (e) {
      setErr(e.message || "Failed to load logistics shipments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadShipments();
  }, []);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return shipments.filter((s) => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (directionFilter && s.direction !== directionFilter) return false;
      if (modeFilter && s.mode !== modeFilter) return false;
      if (!query) return true;
      const haystack = [
        s.refNo,
        s.customerName,
        s.supplierName,
        s.docNo,
        s.docType,
        s.vesselOrFlight,
        s.containerNo,
        s.origin,
        s.destination,
        s.blAwbNo,
        s.remarks,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [shipments, q, statusFilter, directionFilter, modeFilter]);

  function onFormChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function startNew() {
    setEditingId(null);
    setForm(getEmptyForm());
  }

  function editShipment(s) {
    setEditingId(s._id);
    setForm({
      ...getEmptyForm(),
      ...s,
      etd: s.etd ? s.etd.slice(0, 10) : "",
      eta: s.eta ? s.eta.slice(0, 10) : "",
      freightCost: s.freightCost ?? "",
      insuranceCost: s.insuranceCost ?? "",
      dutyCost: s.dutyCost ?? "",
      otherCharges: s.otherCharges ?? "",
    });
  }

  async function saveShipment(e) {
    e.preventDefault();
    setErr("");
    try {
      const payload = {
        direction: form.direction || "EXPORT",
        mode: form.mode || "SEA",
        status: form.status || "PLANNED",
        customerName: (form.customerName || "").trim(),
        supplierName: (form.supplierName || "").trim(),
        docType: (form.docType || "").trim(),
        docNo: (form.docNo || "").trim(),
        incoterm: (form.incoterm || "").trim(),
        vesselOrFlight: (form.vesselOrFlight || "").trim(),
        voyageOrFlightNo: (form.voyageOrFlightNo || "").trim(),
        blAwbNo: (form.blAwbNo || "").trim(),
        containerNo: (form.containerNo || "").trim(),
        origin: (form.origin || "").trim(),
        destination: (form.destination || "").trim(),
        etd: form.etd || null,
        eta: form.eta || null,
        freightCost: Number(form.freightCost) || 0,
        insuranceCost: Number(form.insuranceCost) || 0,
        dutyCost: Number(form.dutyCost) || 0,
        otherCharges: Number(form.otherCharges) || 0,
        currency: (form.currency || "USD").trim(),
        remarks: (form.remarks || "").trim(),
      };
      if (!payload.customerName && !payload.supplierName) {
        setErr("Customer or Supplier is required.");
        return;
      }
      if (editingId) {
        await apiPut(`/logistics/shipments/${editingId}`, payload);
      } else {
        await apiPost("/logistics/shipments", payload);
      }
      await loadShipments();
      setEditingId(null);
      setForm(getEmptyForm());
    } catch (e2) {
      setErr(e2.message || "Failed to save shipment");
    }
  }

  async function deleteShipment(id) {
    if (!window.confirm("Delete this shipment?")) return;
    setErr("");
    try {
      await apiDelete(`/logistics/shipments/${id}`);
      setShipments((prev) => prev.filter((s) => s._id !== id));
    } catch (e) {
      setErr(e.message || "Failed to delete shipment");
    }
  }

  function exportShipmentsExcel() {
    const headers = [
      "Ref No",
      "Direction",
      "Mode",
      "Status",
      "Customer",
      "Supplier",
      "Doc Type",
      "Doc No",
      "Incoterm",
      "Origin",
      "Destination",
      "ETD",
      "ETA",
      "Vessel/Flight",
      "BL/AWB",
      "Container",
      "Freight",
      "Insurance",
      "Duty",
      "Other",
      "Currency",
      "Total Cost",
      "Remarks",
    ];
    const rows = shipments.map((s) => [
      s.refNo,
      s.direction,
      s.mode,
      s.status,
      s.customerName,
      s.supplierName,
      s.docType,
      s.docNo,
      s.incoterm,
      s.origin,
      s.destination,
      s.etd ? s.etd.slice(0, 10) : "",
      s.eta ? s.eta.slice(0, 10) : "",
      s.vesselOrFlight,
      s.blAwbNo,
      s.containerNo,
      s.freightCost ?? 0,
      s.insuranceCost ?? 0,
      s.dutyCost ?? 0,
      s.otherCharges ?? 0,
      s.currency || "",
      s.totalCost ?? 0,
      s.remarks || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Shipments");
    XLSX.writeFile(wb, "logistics-shipments.xlsx");
  }

  function downloadShipmentsTemplate() {
    const headers = [
      "Direction",
      "Mode",
      "Status",
      "Customer",
      "Supplier",
      "Doc Type",
      "Doc No",
      "Incoterm",
      "Origin",
      "Destination",
      "ETD",
      "ETA",
      "Vessel/Flight",
      "BL/AWB",
      "Container",
      "Freight",
      "Insurance",
      "Duty",
      "Other",
      "Currency",
      "Remarks",
    ];
    const example = [
      "EXPORT",
      "SEA",
      "BOOKED",
      "Cool Co management AG",
      "",
      "INVOICE",
      "INV-2026-001",
      "FOB",
      "Jebel Ali, UAE",
      "Hamburg, DE",
      "2026-03-01",
      "2026-04-05",
      "vessel name",
      "BL123456",
      "CONT-123456-7",
      1500,
      0,
      0,
      250,
      "USD",
      "Example export shipment",
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    XLSX.writeFile(wb, "logistics-shipments-template.xlsx");
  }

  async function handleShipmentsImport(file) {
    if (!file) return;
    setErr("");
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
      const payloads = normalized
        .map((row) => {
          const direction = String(row.direction || "").toUpperCase() || "EXPORT";
          const mode = String(row.mode || "").toUpperCase() || "SEA";
          const status = String(row.status || "").toUpperCase() || "PLANNED";
          const customerName = String(row.customer || "").trim();
          const supplierName = String(row.supplier || "").trim();
          if (!customerName && !supplierName) return null;
          return {
            direction,
            mode,
            status,
            customerName,
            supplierName,
            docType: String(row.doctype || "").trim(),
            docNo: String(row.docno || "").trim(),
            incoterm: String(row.incoterm || "").trim(),
            origin: String(row.origin || "").trim(),
            destination: String(row.destination || "").trim(),
            etd: row.etd ? String(row.etd).slice(0, 10) : null,
            eta: row.eta ? String(row.eta).slice(0, 10) : null,
            vesselOrFlight: String(row.vesselflight || "").trim(),
            blAwbNo: String(row.blawb || "").trim(),
            containerNo: String(row.container || "").trim(),
            freightCost: Number(row.freight) || 0,
            insuranceCost: Number(row.insurance) || 0,
            dutyCost: Number(row.duty) || 0,
            otherCharges: Number(row.other) || 0,
            currency: String(row.currency || "USD").trim(),
            remarks: String(row.remarks || "").trim(),
          };
        })
        .filter(Boolean);
      if (!payloads.length) {
        setErr("Import file has no valid shipment rows.");
        return;
      }
      // Simple sequential import
      for (const payload of payloads) {
        // ignore errors per-row, we just stop on first error
        // to keep behaviour predictable
        await apiPost("/logistics/shipments", payload);
      }
      await loadShipments();
      alert(`Imported ${payloads.length} shipment(s) successfully.`);
    } catch (e) {
      setErr(e.message || "Failed to import shipments");
    }
  }

  const totalFreight = filtered.reduce((sum, s) => sum + (Number(s.freightCost) || 0), 0);
  const totalOther = filtered.reduce(
    (sum, s) =>
      sum +
      (Number(s.insuranceCost) || 0) +
      (Number(s.dutyCost) || 0) +
      (Number(s.otherCharges) || 0),
    0
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-base font-semibold">Logistics</h1>
            <p className="mt-1 text-sm text-gray-600">
              Plan and track import/export shipments with basic cost breakdown.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startNew}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs hover:bg-gray-50"
            >
              + New shipment
            </button>
            <button
              type="button"
              onClick={exportShipmentsExcel}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs hover:bg-gray-50"
            >
              Export Excel
            </button>
            <button
              type="button"
              onClick={downloadShipmentsTemplate}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs hover:bg-gray-50"
            >
              Download template
            </button>
            <label className="inline-flex cursor-pointer items-center rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs hover:bg-gray-50">
              Import Excel
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => handleShipmentsImport(e.target.files?.[0])}
              />
            </label>
          </div>
        </div>

        {err && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {err}
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div>
            <label className="text-xs text-gray-600">Search</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ref, customer, doc no, container..."
              className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Direction</label>
            <select
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
            >
              <option value="">All</option>
              {getDirectionOptions().map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Mode</label>
            <select
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
            >
              <option value="">All</option>
              {getModeOptions().map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
            >
              <option value="">All</option>
              {getStatusOptions().map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {/* Form */}
          <div className="space-y-3 rounded-xl border bg-gray-50/60 p-4">
            <h2 className="text-sm font-semibold text-gray-800">
              {editingId ? "Edit shipment" : "New shipment"}
            </h2>
            <form onSubmit={saveShipment} className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Direction</label>
                  <select
                    name="direction"
                    value={form.direction}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  >
                    {getDirectionOptions().map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600">Mode</label>
                  <select
                    name="mode"
                    value={form.mode}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  >
                    {getModeOptions().map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-600">Status</label>
                  <select
                    name="status"
                    value={form.status}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  >
                    {getStatusOptions().map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Customer</label>
                  <input
                    name="customerName"
                    value={form.customerName}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="End customer"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Supplier / Forwarder</label>
                  <input
                    name="supplierName"
                    value={form.supplierName}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="Supplier or freight forwarder"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Doc type</label>
                  <input
                    name="docType"
                    value={form.docType}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="e.g. INVOICE"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-gray-600">Doc no.</label>
                  <input
                    name="docNo"
                    value={form.docNo}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="Link to sales / purchase doc"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Incoterm</label>
                  <input
                    name="incoterm"
                    value={form.incoterm}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="FOB, CIF, EXW..."
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Currency</label>
                  <input
                    name="currency"
                    value={form.currency}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="USD"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Origin</label>
                  <input
                    name="origin"
                    value={form.origin}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="Port / city of loading"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Destination</label>
                  <input
                    name="destination"
                    value={form.destination}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    placeholder="Port / city of discharge"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600">ETD</label>
                  <input
                    type="date"
                    name="etd"
                    value={form.etd}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">ETA</label>
                  <input
                    type="date"
                    name="eta"
                    value={form.eta}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Vessel / Flight</label>
                  <input
                    name="vesselOrFlight"
                    value={form.vesselOrFlight}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">BL / AWB no.</label>
                  <input
                    name="blAwbNo"
                    value={form.blAwbNo}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Container no.</label>
                  <input
                    name="containerNo"
                    value={form.containerNo}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="text-xs text-gray-600">Freight</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="freightCost"
                    value={form.freightCost}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Insurance</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="insuranceCost"
                    value={form.insuranceCost}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Duty / Taxes</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="dutyCost"
                    value={form.dutyCost}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600">Other charges</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="otherCharges"
                    value={form.otherCharges}
                    onChange={onFormChange}
                    className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-600">Remarks</label>
                <textarea
                  name="remarks"
                  value={form.remarks}
                  onChange={onFormChange}
                  rows={2}
                  className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                {editingId && (
                  <button
                    type="button"
                    onClick={startNew}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white"
                >
                  {editingId ? "Update shipment" : "Save shipment"}
                </button>
              </div>
            </form>
          </div>

          {/* Table */}
          <div className="min-w-0 overflow-x-auto rounded-xl border">
            <table className="min-w-full text-left text-xs">
              <thead className="border-b bg-gray-50 text-gray-600">
                <tr>
                  <th className="py-2 px-3">Ref</th>
                  <th className="py-2 px-3">Direction</th>
                  <th className="py-2 px-3">Mode</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Customer / Supplier</th>
                  <th className="py-2 px-3">Route</th>
                  <th className="py-2 px-3">ETD / ETA</th>
                  <th className="py-2 px-3">BL / AWB</th>
                  <th className="py-2 px-3 text-right">Freight</th>
                  <th className="py-2 px-3 text-right">Other</th>
                  <th className="py-2 px-3 text-right">Total</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="py-4 px-3 text-center text-xs text-gray-500" colSpan={12}>
                      Loading shipments...
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td className="py-4 px-3 text-center text-xs text-gray-500" colSpan={12}>
                      No shipments found.
                    </td>
                  </tr>
                ) : (
                  filtered.map((s) => {
                    const freight = Number(s.freightCost) || 0;
                    const others =
                      (Number(s.insuranceCost) || 0) +
                      (Number(s.dutyCost) || 0) +
                      (Number(s.otherCharges) || 0);
                    const total = freight + others;
                    return (
                      <tr key={s._id} className="border-b last:border-b-0">
                        <td className="py-2 px-3 font-medium text-gray-800">{s.refNo}</td>
                        <td className="py-2 px-3">{s.direction}</td>
                        <td className="py-2 px-3">{s.mode}</td>
                        <td className="py-2 px-3">{s.status}</td>
                        <td className="py-2 px-3">
                          <div className="max-w-[200px] truncate text-gray-700">
                            {s.customerName || "—"}
                            {s.supplierName ? ` / ${s.supplierName}` : ""}
                          </div>
                          {s.docNo && (
                            <div className="text-[11px] text-gray-500">
                              {s.docType || "DOC"}: {s.docNo}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3">
                          <div className="text-gray-700">
                            {s.origin || "—"} → {s.destination || "—"}
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          <div className="text-gray-700 text-[11px]">
                            {s.etd ? `ETD ${String(s.etd).slice(0, 10)}` : "ETD —"}
                          </div>
                          <div className="text-gray-700 text-[11px]">
                            {s.eta ? `ETA ${String(s.eta).slice(0, 10)}` : "ETA —"}
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          <div className="max-w-[140px] truncate text-gray-700" title={s.blAwbNo}>
                            {s.blAwbNo || "—"}
                          </div>
                          {s.containerNo && (
                            <div className="text-[11px] text-gray-500" title={s.containerNo}>
                              {s.containerNo}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {freight ? `${s.currency || ""} ${freight.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {others ? `${s.currency || ""} ${others.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {total ? `${s.currency || ""} ${total.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => editShipment(s)}
                            className="mr-1 rounded border px-2 py-1 text-[11px] hover:bg-gray-50"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteShipment(s._id)}
                            className="rounded border border-red-300 px-2 py-1 text-[11px] text-red-700 hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {filtered.length > 0 && (
                <tfoot className="bg-gray-50 text-[11px] text-gray-700">
                  <tr>
                    <td className="py-2 px-3" colSpan={8}>
                      Totals for filtered shipments
                    </td>
                    <td className="py-2 px-3 text-right">
                      {totalFreight ? totalFreight.toFixed(2) : "—"}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {totalOther ? totalOther.toFixed(2) : "—"}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {(totalFreight + totalOther).toFixed(2)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function getEmptyForm() {
  return {
    direction: "EXPORT",
    mode: "SEA",
    status: "PLANNED",
    customerName: "",
    supplierName: "",
    docType: "",
    docNo: "",
    incoterm: "",
    origin: "",
    destination: "",
    etd: "",
    eta: "",
    vesselOrFlight: "",
    blAwbNo: "",
    containerNo: "",
    freightCost: "",
    insuranceCost: "",
    dutyCost: "",
    otherCharges: "",
    currency: "USD",
    remarks: "",
  };
}
