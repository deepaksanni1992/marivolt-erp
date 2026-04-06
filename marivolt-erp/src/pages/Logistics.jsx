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
  customerName: "",
  supplierName: "",
  docType: "",
  docNo: "",
  linkedPoNumber: "",
  linkedQuotationNumber: "",
  linkedSalesInvoiceNumber: "",
  linkedPurchaseInvoiceNumber: "",
  incoterm: "",
  vesselOrFlight: "",
  voyageOrFlightNo: "",
  blAwbNo: "",
  containerNo: "",
  origin: "",
  destination: "",
  weightKg: 0,
  freightCost: 0,
  insuranceCost: 0,
  dutyCost: 0,
  otherCharges: 0,
  currency: "USD",
  remarks: "",
};

export default function Logistics() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const limit = 20;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyShipment);
  const [err, setErr] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["shipments", page],
    queryFn: () => apiGetWithQuery("/shipments", { page, limit }),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = { ...form };
      if (payload.etd) payload.etd = new Date(payload.etd).toISOString();
      else delete payload.etd;
      if (payload.eta) payload.eta = new Date(payload.eta).toISOString();
      else delete payload.eta;
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

  async function openEdit(id) {
    setErr("");
    setEditingId(id);
    const row = await apiGet(`/shipments/${id}`);
    const etdStr = row.etd ? String(row.etd).slice(0, 10) : "";
    const etaStr = row.eta ? String(row.eta).slice(0, 10) : "";
    setForm({
      ...emptyShipment,
      ...row,
      etd: etdStr,
      eta: etaStr,
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
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader title="Logistics" subtitle="Shipments and transport links to trade docs.">
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
                    <td className="px-3 py-2">{r.status}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate">
                      {r.origin} → {r.destination}
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
              {[
                "PLANNED",
                "BOOKED",
                "IN_TRANSIT",
                "ARRIVED",
                "DELIVERED",
                "CLOSED",
                "CANCELLED",
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
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
          <FormField label="Vessel / flight">
            <TextInput
              value={form.vesselOrFlight}
              onChange={(e) => setForm((f) => ({ ...f, vesselOrFlight: e.target.value }))}
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
          <FormField label="Container">
            <TextInput
              value={form.containerNo}
              onChange={(e) => setForm((f) => ({ ...f, containerNo: e.target.value }))}
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
