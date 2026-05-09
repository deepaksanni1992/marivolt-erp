import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiDelete, apiGet, apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";

const emptyShipment = {
  direction: "EXPORT",
  mode: "SEA",
  status: "PLANNED",
  trackingStatus: "booked",
  customerName: "",
  supplierName: "",
  docType: "",
  docNo: "",
  linkedPoNumber: "",
  linkedQuotationNumber: "",
  linkedSalesInvoiceNumber: "",
  linkedPurchaseInvoiceNumber: "",
  linkedDispatchId: "",
  linkedDispatchNo: "",
  linkedRtsNo: "",
  incoterm: "",
  vesselOrFlight: "",
  voyageOrFlightNo: "",
  blAwbNo: "",
  awbNo: "",
  blNo: "",
  courier: "",
  shippingLine: "",
  vessel: "",
  voyage: "",
  containerNo: "",
  origin: "",
  destination: "",
  weightKg: 0,
  freightCost: 0,
  customsCost: 0,
  truckingCost: 0,
  handlingCost: 0,
  courierCost: 0,
  insuranceCost: 0,
  dutyCost: 0,
  otherCharges: 0,
  currency: "USD",
  trackingUrl: "",
  packages: [],
  exportDocuments: [],
  expenses: [],
  plannedEta: "",
  actualEta: "",
  remarks: "",
};

const shipmentStatuses = ["READY", "BOOKED", "PICKED_UP", "CUSTOMS_CLEARANCE", "IN_TRANSIT", "ARRIVED", "DELIVERED", "CLOSED", "CANCELLED"];
const exportDocTypes = ["COO", "WEIGHT_LIST", "CONTAINER_LOAD_PLAN", "EXPORT_CHECKLIST", "COMMERCIAL_INVOICE", "PACKING_LIST"];

function statusBadgeClass(status = "") {
  const s = String(status || "").toUpperCase();
  if (["DELIVERED", "CLOSED"].includes(s)) return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (["IN_TRANSIT", "ARRIVED", "CUSTOMS_CLEARANCE"].includes(s)) return "bg-blue-50 text-blue-700 ring-blue-200";
  if (["CANCELLED"].includes(s)) return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

export default function Logistics() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 20;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyShipment);
  const [err, setErr] = useState("");
  const [dashboardWarehouse, setDashboardWarehouse] = useState("");
  const [filters, setFilters] = useState({ status: "", customerName: "", awbNo: "", blNo: "", delayedOnly: false });

  const { data, isLoading, error } = useQuery({
    queryKey: ["shipments", page, filters],
    queryFn: () => apiGetWithQuery("/shipments", { page, limit, ...filters, delayedOnly: filters.delayedOnly ? "1" : undefined }),
  });

  const { data: dashboardData } = useQuery({
    queryKey: ["logistics-dashboard", dashboardWarehouse],
    queryFn: () => apiGetWithQuery("/shipments/dashboard", { warehouse: dashboardWarehouse || undefined }),
  });

  const { data: dispatchData } = useQuery({
    queryKey: ["logistics-dispatches"],
    queryFn: () => apiGetWithQuery("/shipments/dispatches", { page: 1, limit: 50 }),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = { ...form };
      if (payload.etd) payload.etd = new Date(payload.etd).toISOString();
      else delete payload.etd;
      if (payload.eta) payload.eta = new Date(payload.eta).toISOString();
      else delete payload.eta;
      if (payload.plannedEta) payload.plannedEta = new Date(payload.plannedEta).toISOString();
      else delete payload.plannedEta;
      if (payload.actualEta) payload.actualEta = new Date(payload.actualEta).toISOString();
      else delete payload.actualEta;
      if (!payload.linkedDispatchId) delete payload.linkedDispatchId;
      return editingId
        ? apiPut(`/shipments/${editingId}`, payload)
        : apiPost("/shipments", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
      setModalOpen(false);
      setEditingId(null);
      setForm(emptyShipment);
    },
    onError: (e) => setErr(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/shipments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shipments"] }),
  });

  const trackingMutation = useMutation({
    mutationFn: ({ id, status }) => apiPut(`/shipments/${id}`, { status: status === "delivered" ? "DELIVERED" : "IN_TRANSIT", trackingStatus: status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
      qc.invalidateQueries({ queryKey: ["logistics-dashboard"] });
      qc.invalidateQueries({ queryKey: ["logistics-dispatches"] });
    },
    onError: (e) => setErr(e.message),
  });

  async function openEdit(id) {
    setErr("");
    setEditingId(id);
    const row = await apiGet(`/shipments/${id}`);
    const etdStr = row.etd ? String(row.etd).slice(0, 10) : "";
    const etaStr = row.eta ? String(row.eta).slice(0, 10) : "";
    const plannedEtaStr = row.plannedEta ? String(row.plannedEta).slice(0, 10) : "";
    const actualEtaStr = row.actualEta ? String(row.actualEta).slice(0, 10) : "";
    setForm({
      ...emptyShipment,
      ...row,
      etd: etdStr,
      eta: etaStr,
      plannedEta: plannedEtaStr,
      actualEta: actualEtaStr,
    });
    setModalOpen(true);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyShipment);
    setErr("");
    setModalOpen(true);
  }

  const rows = data?.items ?? [];
  const dispatchRows = dispatchData?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  async function printPackingList(dispatchId) {
    try {
      const data = await apiGet(`/shipments/dispatches/${dispatchId}/packing-list`);
      const p = data?.packingList || {};
      const lineRows = (p.lines || [])
        .map(
          (l) => `<tr><td>${l.article || ""}</td><td>${l.description || ""}</td><td style="text-align:right">${l.qty || 0}</td><td>${l.uom || ""}</td><td>${l.weight || ""}</td><td>${l.dimensions || ""}</td><td>${l.packageCount || ""}</td><td>${l.marksAndNumbers || ""}</td><td>${l.countryOfOrigin || ""}</td></tr>`
        )
        .join("");
      const w = window.open("", "_blank");
      if (!w) return;
      w.document.write(`<html><head><title>${p.packingListNo || "Packing List"}</title></head><body style="font-family:Arial;padding:24px"><h2>Packing List</h2><div><b>No:</b> ${p.packingListNo || ""}</div><div><b>Customer:</b> ${p.customerName || ""}</div><div><b>Invoice:</b> ${p.invoiceNo || ""}</div><div><b>RTS:</b> ${p.rtsNo || ""}</div><table border="1" cellspacing="0" cellpadding="6" width="100%" style="margin-top:16px;border-collapse:collapse;font-size:12px"><thead><tr><th>Article</th><th>Description</th><th>Qty</th><th>UOM</th><th>Weight</th><th>Dimensions</th><th>Packages</th><th>Marks</th><th>COO</th></tr></thead><tbody>${lineRows}</tbody></table></body></html>`);
      w.document.close();
      w.focus();
      w.print();
    } catch (e) {
      setErr(e.message || "Could not print packing list");
    }
  }

  function exportShipmentsCsv() {
    if (!rows.length) return;
    const safe = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Shipment Ref", "Dispatch", "Customer", "Status", "Tracking", "AWB", "BL", "Courier", "ETA", "Delayed Days", "Tracking URL"];
    const body = rows.map((r) => [r.shipmentRef, r.linkedDispatchNo, r.customerName, r.status, r.trackingStatus, r.awbNo, r.blNo, r.courier, r.eta ? new Date(r.eta).toISOString().slice(0, 10) : "", r.delayedDays || 0, r.trackingUrl].map(safe).join(","));
    const blob = new Blob([[header.map(safe).join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shipment-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportDispatchCsv() {
    if (!dispatchRows.length) return;
    const safe = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Dispatch", "Customer", "Invoice", "RTS", "Status", "Dispatched Qty", "Pending Qty", "AWB", "BL"];
    const body = dispatchRows.map((d) => [d.dispatchNo, d.customerName, d.linkedSalesInvoiceNo, d.linkedRtsNo, d.status, d.dispatchedQty || 0, d.pendingQty || 0, d.awbNo, d.blNo].map(safe).join(","));
    const blob = new Blob([[header.map(safe).join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dispatch-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader title="Logistics" subtitle="Shipments and transport links to trade docs.">
        <button
          type="button"
          onClick={exportShipmentsCsv}
          className="rounded-xl border px-3 py-2 text-sm font-semibold"
          disabled={!rows.length}
        >
          Export shipment CSV
        </button>
        <button
          type="button"
          onClick={exportDispatchCsv}
          className="rounded-xl border px-3 py-2 text-sm font-semibold"
          disabled={!dispatchRows.length}
        >
          Export dispatch CSV
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
        >
          New shipment
        </button>
      </PageHeader>

      {(error || err) && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error?.message || err}
        </div>
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-5">
        {[
          ["Pending dispatch", dashboardData?.pendingDispatch || 0],
          ["In transit", dashboardData?.inTransit || 0],
          ["Delayed", dashboardData?.delayedShipments || 0],
          ["Delivered", dashboardData?.delivered || 0],
          ["Backorders", dashboardData?.backorders || 0],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="mb-4 grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-4">
        <FormField label="Dashboard Warehouse">
          <TextInput
            value={dashboardWarehouse}
            onChange={(e) => setDashboardWarehouse(e.target.value.toUpperCase())}
            placeholder="ALL / MAIN / BRANCH..."
          />
        </FormField>
      </div>

      <div className="mb-4 grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-5">
        <FormField label="Shipment Status">
          <SelectInput value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">All</option>
            {shipmentStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectInput>
        </FormField>
        <FormField label="Customer">
          <TextInput value={filters.customerName} onChange={(e) => setFilters((f) => ({ ...f, customerName: e.target.value }))} />
        </FormField>
        <FormField label="AWB">
          <TextInput value={filters.awbNo} onChange={(e) => setFilters((f) => ({ ...f, awbNo: e.target.value }))} />
        </FormField>
        <FormField label="BL">
          <TextInput value={filters.blNo} onChange={(e) => setFilters((f) => ({ ...f, blNo: e.target.value }))} />
        </FormField>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={filters.delayedOnly} onChange={(e) => setFilters((f) => ({ ...f, delayedOnly: e.target.checked }))} />
          Delayed only
        </label>
      </div>

      <div className="mb-4 overflow-hidden rounded-2xl border bg-white">
        <div className="border-b px-4 py-3">
          <div className="font-semibold">Dispatch Summary</div>
          <div className="text-xs text-gray-500">Sales dispatches linked to invoice/RTS with packing-list access.</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-3 py-2">Dispatch</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">RTS</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Dispatched</th>
                <th className="px-3 py-2 text-right">Pending</th>
                <th className="px-3 py-2">Shipment</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dispatchRows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">No dispatches.</td></tr>
              ) : dispatchRows.map((d) => (
                <tr key={d._id} className="border-b border-gray-100">
                  <td className="px-3 py-2 font-mono text-xs">{d.dispatchNo}</td>
                  <td className="px-3 py-2">{d.customerName}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.linkedSalesInvoiceNo || "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d.linkedRtsNo || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(d.status)}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(d.dispatchedQty || 0).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{Number(d.pendingQty || 0).toFixed(2)}</td>
                  <td className="px-3 py-2 text-xs">{d.awbNo || d.blNo || d.containerNo || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => printPackingList(d._id)}>Packing List</button>
                      <button
                        type="button"
                        className="rounded border px-2 py-1 text-xs"
                        onClick={() => {
                          setEditingId(null);
                          setForm((f) => ({
                            ...emptyShipment,
                            ...f,
                            customerName: d.customerName || "",
                            docType: "SALES_DISPATCH",
                            docNo: d.dispatchNo || "",
                            linkedDispatchId: d._id,
                            linkedDispatchNo: d.dispatchNo || "",
                            linkedSalesInvoiceNumber: d.linkedSalesInvoiceNo || "",
                            linkedRtsNo: d.linkedRtsNo || "",
                          }));
                          setModalOpen(true);
                        }}
                      >
                        Create Shipment
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-3 py-2">Ref</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    No shipments.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50/80">
                    <td className="px-3 py-2 font-mono text-xs">{r.shipmentRef}</td>
                    <td className="px-3 py-2">{r.direction}</td>
                    <td className="px-3 py-2">{r.mode}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass(r.status)}`}>
                        {r.status}
                      </span>
                      <div className="mt-1 text-xs text-gray-500">{r.trackingStatus || "booked"}</div>
                      {Number(r.delayedDays || 0) > 0 ? (
                        <div className="mt-1 text-xs font-semibold text-rose-700">Delayed {r.delayedDays}d</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate">
                      {r.origin} → {r.destination}
                      {r.trackingUrl ? (
                        <a className="ml-2 text-blue-600 underline" href={r.trackingUrl} target="_blank" rel="noreferrer">Track</a>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-gray-500">
                        {["READY", "BOOKED", "PICKED_UP", "CUSTOMS_CLEARANCE", "IN_TRANSIT", "ARRIVED", "DELIVERED"].map((s) => (
                          <span key={s} className={String(r.status || "").toUpperCase() === s ? "font-semibold text-gray-900" : ""}>{s.replaceAll("_", " ")}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs"
                          onClick={() => openEdit(r._id)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs"
                          disabled={trackingMutation.isPending}
                          onClick={() => trackingMutation.mutate({ id: r._id, status: "in_transit" })}
                        >
                          Transit
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border px-2 py-1 text-xs"
                          disabled={trackingMutation.isPending}
                          onClick={() => trackingMutation.mutate({ id: r._id, status: "delivered" })}
                        >
                          Delivered
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700"
                          onClick={() => {
                            if (confirm(`Delete ${r.shipmentRef}?`)) deleteMutation.mutate(r._id);
                          }}
                        >
                          Del
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
          <span>
            Page {page}/{totalPages} · {total} rows
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </button>
            <button
              type="button"
              className="rounded-lg border px-2 py-1 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingId(null);
        }}
        title={editingId ? "Edit shipment" : "New shipment"}
        wide
      >
        <div className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          <FormField label="Direction">
            <SelectInput
              value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value }))}
            >
              <option value="IMPORT">IMPORT</option>
              <option value="EXPORT">EXPORT</option>
              <option value="LOCAL">LOCAL</option>
            </SelectInput>
          </FormField>
          <FormField label="Mode">
            <SelectInput
              value={form.mode}
              onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
            >
              <option value="SEA">SEA</option>
              <option value="AIR">AIR</option>
              <option value="ROAD">ROAD</option>
              <option value="COURIER">COURIER</option>
            </SelectInput>
          </FormField>
          <FormField label="Status">
            <SelectInput
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            >
              {shipmentStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Tracking status">
            <SelectInput
              value={form.trackingStatus}
              onChange={(e) => setForm((f) => ({ ...f, trackingStatus: e.target.value }))}
            >
              <option value="booked">booked</option>
              <option value="picked_up">picked up</option>
              <option value="customs">customs</option>
              <option value="in_transit">in transit</option>
              <option value="delivered">delivered</option>
            </SelectInput>
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Customer">
            <TextInput
              value={form.customerName}
              onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Supplier">
            <TextInput
              value={form.supplierName}
              onChange={(e) => setForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Doc type">
            <TextInput
              value={form.docType}
              onChange={(e) => setForm((f) => ({ ...f, docType: e.target.value }))}
            />
          </FormField>
          <FormField label="Doc #">
            <TextInput
              value={form.docNo}
              onChange={(e) => setForm((f) => ({ ...f, docNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked dispatch #">
            <TextInput
              value={form.linkedDispatchNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, linkedDispatchNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked RTS #">
            <TextInput
              value={form.linkedRtsNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, linkedRtsNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked PO #">
            <TextInput
              value={form.linkedPoNumber}
              onChange={(e) => setForm((f) => ({ ...f, linkedPoNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked quote #">
            <TextInput
              value={form.linkedQuotationNumber}
              onChange={(e) =>
                setForm((f) => ({ ...f, linkedQuotationNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Linked sales inv #">
            <TextInput
              value={form.linkedSalesInvoiceNumber}
              onChange={(e) =>
                setForm((f) => ({ ...f, linkedSalesInvoiceNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Linked purchase inv #">
            <TextInput
              value={form.linkedPurchaseInvoiceNumber}
              onChange={(e) =>
                setForm((f) => ({ ...f, linkedPurchaseInvoiceNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Origin">
            <TextInput
              value={form.origin}
              onChange={(e) => setForm((f) => ({ ...f, origin: e.target.value }))}
            />
          </FormField>
          <FormField label="Destination">
            <TextInput
              value={form.destination}
              onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
            />
          </FormField>
          <FormField label="ETD (date)">
            <TextInput
              type="date"
              value={form.etd || ""}
              onChange={(e) => setForm((f) => ({ ...f, etd: e.target.value }))}
            />
          </FormField>
          <FormField label="ETA (date)">
            <TextInput
              type="date"
              value={form.eta || ""}
              onChange={(e) => setForm((f) => ({ ...f, eta: e.target.value }))}
            />
          </FormField>
          <FormField label="Planned ETA">
            <TextInput
              type="date"
              value={form.plannedEta || ""}
              onChange={(e) => setForm((f) => ({ ...f, plannedEta: e.target.value }))}
            />
          </FormField>
          <FormField label="Actual ETA / arrival">
            <TextInput
              type="date"
              value={form.actualEta || ""}
              onChange={(e) => setForm((f) => ({ ...f, actualEta: e.target.value }))}
            />
          </FormField>
          <FormField label="Vessel / flight">
            <TextInput
              value={form.vesselOrFlight}
              onChange={(e) => setForm((f) => ({ ...f, vesselOrFlight: e.target.value }))}
            />
          </FormField>
          <FormField label="Shipping line">
            <TextInput
              value={form.shippingLine || ""}
              onChange={(e) => setForm((f) => ({ ...f, shippingLine: e.target.value }))}
            />
          </FormField>
          <FormField label="Courier">
            <TextInput
              value={form.courier || ""}
              onChange={(e) => setForm((f) => ({ ...f, courier: e.target.value }))}
            />
          </FormField>
          <FormField label="Voyage / flight no">
            <TextInput
              value={form.voyageOrFlightNo}
              onChange={(e) => setForm((f) => ({ ...f, voyageOrFlightNo: e.target.value }))}
            />
          </FormField>
          <FormField label="B/L or AWB">
            <TextInput
              value={form.blAwbNo}
              onChange={(e) => setForm((f) => ({ ...f, blAwbNo: e.target.value }))}
            />
          </FormField>
          <FormField label="AWB No">
            <TextInput
              value={form.awbNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, awbNo: e.target.value }))}
            />
          </FormField>
          <FormField label="BL No">
            <TextInput
              value={form.blNo || ""}
              onChange={(e) => setForm((f) => ({ ...f, blNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Container">
            <TextInput
              value={form.containerNo}
              onChange={(e) => setForm((f) => ({ ...f, containerNo: e.target.value }))}
            />
          </FormField>
          <FormField label="Tracking URL" className="sm:col-span-2">
            <TextInput
              value={form.trackingUrl || ""}
              onChange={(e) => setForm((f) => ({ ...f, trackingUrl: e.target.value }))}
            />
          </FormField>
          <FormField label="Incoterm">
            <TextInput
              value={form.incoterm}
              onChange={(e) => setForm((f) => ({ ...f, incoterm: e.target.value }))}
            />
          </FormField>
          <FormField label="Weight kg">
            <TextInput
              type="number"
              value={form.weightKg}
              onChange={(e) => setForm((f) => ({ ...f, weightKg: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Freight">
            <TextInput
              type="number"
              step="0.01"
              value={form.freightCost}
              onChange={(e) =>
                setForm((f) => ({ ...f, freightCost: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Customs">
            <TextInput
              type="number"
              step="0.01"
              value={form.customsCost || 0}
              onChange={(e) => setForm((f) => ({ ...f, customsCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Trucking">
            <TextInput
              type="number"
              step="0.01"
              value={form.truckingCost || 0}
              onChange={(e) => setForm((f) => ({ ...f, truckingCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Handling">
            <TextInput
              type="number"
              step="0.01"
              value={form.handlingCost || 0}
              onChange={(e) => setForm((f) => ({ ...f, handlingCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Courier cost">
            <TextInput
              type="number"
              step="0.01"
              value={form.courierCost || 0}
              onChange={(e) => setForm((f) => ({ ...f, courierCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Insurance">
            <TextInput
              type="number"
              step="0.01"
              value={form.insuranceCost}
              onChange={(e) =>
                setForm((f) => ({ ...f, insuranceCost: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Duty">
            <TextInput
              type="number"
              step="0.01"
              value={form.dutyCost}
              onChange={(e) => setForm((f) => ({ ...f, dutyCost: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Other charges">
            <TextInput
              type="number"
              step="0.01"
              value={form.otherCharges}
              onChange={(e) =>
                setForm((f) => ({ ...f, otherCharges: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={form.remarks}
              onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
          <div className="sm:col-span-2 rounded-xl border bg-gray-50 p-3">
            <div className="mb-2 text-sm font-semibold">Export Documents</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {exportDocTypes.map((docType) => {
                const current = (form.exportDocuments || []).find((d) => d.documentType === docType) || { documentType: docType, status: "PENDING" };
                return (
                  <FormField key={docType} label={docType.replaceAll("_", " ")}>
                    <SelectInput
                      value={current.status || "PENDING"}
                      onChange={(e) => {
                        const others = (form.exportDocuments || []).filter((d) => d.documentType !== docType);
                        setForm((f) => ({ ...f, exportDocuments: [...others, { documentType: docType, status: e.target.value }] }));
                      }}
                    >
                      <option value="PENDING">Pending</option>
                      <option value="GENERATED">Generated</option>
                      <option value="UPLOADED">Uploaded</option>
                    </SelectInput>
                  </FormField>
                );
              })}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t pt-4">
          <button
            type="button"
            className="rounded-xl border px-4 py-2 text-sm"
            onClick={() => setModalOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={saveMutation.isPending}
            onClick={() => {
              setErr("");
              saveMutation.mutate();
            }}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
