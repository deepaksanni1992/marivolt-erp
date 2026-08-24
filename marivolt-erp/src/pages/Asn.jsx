import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import LoadingButton from "../components/erp/LoadingButton.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGet, apiGetWithQuery, apiPatch, apiPost, apiPostFormData, apiDelete } from "../lib/api.js";
import { notify, confirmDialog } from "../lib/notifications.js";
import {
  ASN_DOC_TYPES,
  ASN_SHIPMENT_MODES,
  AsnStatusBadge,
  asnLineQtyTotal,
  formatAsnDate,
  incomingShipmentsPath,
  trackingDisplay,
} from "../lib/asnUi.js";
import AsnCreatePoPicker from "../components/asn/AsnCreatePoPicker.jsx";
import AsnWorkflowStrip from "../components/asn/AsnWorkflowStrip.jsx";
import AsnReceivingCompletenessPanel from "../components/asn/AsnReceivingCompletenessPanel.jsx";
import { shipArriveCompletenessWarning } from "../lib/asnReceivingCompleteness.js";

async function openAsnDocument(documentId) {
  const data = await apiGet(`/documents/${documentId}/download`);
  const url = data?.url || data?.fileUrl;
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function emptyShipment() {
  return {
    supplierInvoices: [{ invoiceNumber: "", invoiceDate: "" }],
    supplierInvoiceNumber: "",
    supplierInvoiceDate: "",
    supplierPackingListNumber: "",
    shipmentMode: "OTHER",
    forwarder: "",
    awbNumber: "",
    blNumber: "",
    trackingNumber: "",
    shipmentDate: "",
    expectedArrivalDate: "",
    actualArrivalDate: "",
    countryOfOrigin: "",
    portOfLoading: "",
    portOfArrival: "",
    numberOfPackages: "",
    grossWeight: "",
    grossWeightUom: "KG",
    remarks: "",
  };
}

function hydrateSupplierInvoices(doc = {}) {
  const rows = Array.isArray(doc.supplierInvoices) ? doc.supplierInvoices : [];
  const mapped = rows
    .map((r) => ({
      invoiceNumber: r?.invoiceNumber || "",
      invoiceDate: r?.invoiceDate ? String(r.invoiceDate).slice(0, 10) : "",
    }))
    .filter((r) => r.invoiceNumber || r.invoiceDate);
  if (mapped.length) return mapped;
  if (doc.supplierInvoiceNumber || doc.supplierInvoiceDate) {
    return [
      {
        invoiceNumber: doc.supplierInvoiceNumber || "",
        invoiceDate: doc.supplierInvoiceDate ? String(doc.supplierInvoiceDate).slice(0, 10) : "",
      },
    ];
  }
  return [{ invoiceNumber: "", invoiceDate: "" }];
}

function shipmentFromDoc(doc = {}) {
  const base = emptyShipment();
  for (const key of Object.keys(base)) {
    if (key === "supplierInvoices") continue;
    const val = doc[key];
    if (val == null || val === "") continue;
    if (String(key).toLowerCase().includes("date") && val) {
      base[key] = String(val).slice(0, 10);
    } else {
      base[key] = val;
    }
  }
  base.supplierInvoices = hydrateSupplierInvoices(doc);
  return base;
}

export default function AsnPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const creating = id === "new";
  const poId = params.get("poId") || "";
  const poNoQuery = params.get("poNo") || "";

  const canCreate = can("ASN", "create");
  const canEdit = can("ASN", "edit");
  const canPost = can("ASN", "post");
  const canCancel = can("ASN", "cancel");
  const canStoreView = can("STORE", "view");

  const [filters, setFilters] = useState({
    asnNo: "",
    supplier: "",
    poNo: poNoQuery,
    status: "",
    shipmentMode: "",
  });
  const [shipment, setShipment] = useState(emptyShipment());
  const [lineQtys, setLineQtys] = useState({});
  const [lineHs, setLineHs] = useState({});
  const [lineCoo, setLineCoo] = useState({});
  const [cancelReason, setCancelReason] = useState("");
  const [docType, setDocType] = useState(ASN_DOC_TYPES[0]);
  const [docFile, setDocFile] = useState(null);

  const listQ = useQuery({
    queryKey: ["asn", filters],
    queryFn: () =>
      apiGetWithQuery("/asn", {
        limit: 50,
        page: 1,
        asnNo: filters.asnNo || undefined,
        supplier: filters.supplier || undefined,
        poNo: filters.poNo || undefined,
        status: filters.status || undefined,
        shipmentMode: filters.shipmentMode || undefined,
      }),
    enabled: !id,
  });

  const detailQ = useQuery({
    queryKey: ["asn", id],
    queryFn: () => apiGet(`/asn/${id}`),
    enabled: Boolean(id) && !creating,
  });

  const availQ = useQuery({
    queryKey: ["asn-availability", poId],
    queryFn: () => apiGet(`/purchase-orders/${poId}/asn-availability`),
    enabled: creating && Boolean(poId) && canCreate,
  });

  const auditQ = useQuery({
    queryKey: ["asn-audit", detailQ.data?.asnNo],
    queryFn: () => apiGet(`/audit-logs/document/${encodeURIComponent(detailQ.data.asnNo)}`),
    enabled: Boolean(detailQ.data?.asnNo) && can("AUDIT", "view"),
  });

  const progressQ = useQuery({
    queryKey: ["receiving-progress", id],
    queryFn: () => apiGet(`/receiving/asn/${id}/progress`),
    enabled: Boolean(id) && !creating,
  });

  useEffect(() => {
    if (detailQ.data) {
      setShipment(shipmentFromDoc(detailQ.data));
      const next = {};
      const nextHs = {};
      const nextCoo = {};
      for (const line of detailQ.data.lines || []) {
        const key = String(line.poLineId);
        next[key] = line.asnQty;
        nextHs[key] = line.hsCode || "";
        nextCoo[key] = line.countryOfOrigin || "";
      }
      setLineQtys(next);
      setLineHs(nextHs);
      setLineCoo(nextCoo);
    }
  }, [detailQ.data]);

  useEffect(() => {
    if (availQ.data?.lines) {
      const next = {};
      const nextHs = {};
      const nextCoo = {};
      for (const line of availQ.data.lines) {
        const key = String(line.poLineId);
        next[key] = line.remainingAvailableQty > 0 ? line.remainingAvailableQty : "";
        nextHs[key] = "";
        nextCoo[key] = "";
      }
      setLineQtys(next);
      setLineHs(nextHs);
      setLineCoo(nextCoo);
    }
  }, [availQ.data]);

  const createMut = useMutation({
    mutationFn: (body) => apiPost("/asn", body),
    onSuccess: (row) => {
      notify.success(`ASN ${row.asnNo} created`);
      qc.invalidateQueries({ queryKey: ["asn"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrder"] });
      nav(`/asn/${row._id}`);
    },
    onError: (e) => notify.fromError(e),
  });

  const patchMut = useMutation({
    mutationFn: (body) => apiPatch(`/asn/${id}`, body),
    onSuccess: () => {
      notify.success("ASN updated");
      qc.invalidateQueries({ queryKey: ["asn", id] });
    },
    onError: (e) => notify.fromError(e),
  });

  const shipMut = useMutation({
    mutationFn: () => apiPost(`/asn/${id}/ship`, {}),
    onSuccess: () => {
      notify.success("ASN marked shipped");
      qc.invalidateQueries({ queryKey: ["asn"] });
    },
    onError: (e) => notify.fromError(e),
  });

  const arriveMut = useMutation({
    mutationFn: () => apiPost(`/asn/${id}/arrive`, {}),
    onSuccess: () => {
      notify.success("ASN marked arrived");
      qc.invalidateQueries({ queryKey: ["asn"] });
    },
    onError: (e) => notify.fromError(e),
  });

  async function confirmShipOrArrive(kind) {
    const completeness = detailQ.data?.receivingCompleteness;
    const warning = shipArriveCompletenessWarning(completeness);
    if (warning) {
      const ok = await confirmDialog({
        title: kind === "ship" ? "Mark shipped" : "Mark arrived",
        message: warning,
        confirmLabel: kind === "ship" ? "Mark shipped" : "Mark arrived",
      });
      if (!ok) return;
    }
    if (kind === "ship") shipMut.mutate();
    else arriveMut.mutate();
  }

  function focusCompletenessPanel() {
    const el = document.getElementById("asn-data-completeness");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function onReceiveShipmentClick(e) {
    const completeness = detailQ.data?.receivingCompleteness;
    if (completeness && !completeness.complete) {
      e.preventDefault();
      notify.error(
        completeness.summary ||
          "ASN cannot proceed to receiving until required fields are completed."
      );
      focusCompletenessPanel();
    }
  }

  const cancelMut = useMutation({
    mutationFn: (reason) => apiPost(`/asn/${id}/cancel`, { reason }),
    onSuccess: () => {
      notify.success("ASN cancelled");
      setCancelReason("");
      qc.invalidateQueries({ queryKey: ["asn"] });
    },
    onError: (e) => notify.fromError(e),
  });

  const attachMut = useMutation({
    mutationFn: async () => {
      if (!docFile) throw new Error("Choose a file");
      const fd = new FormData();
      fd.append("file", docFile);
      fd.append("documentType", docType);
      fd.append("moduleName", "ASN");
      fd.append("relatedId", String(id));
      fd.append("refNo", detailQ.data?.asnNo || "");
      fd.append("partyName", detailQ.data?.supplierName || "");
      const uploaded = await apiPostFormData("/documents/upload", fd);
      return apiPost(`/asn/${id}/attachments`, {
        documentId: uploaded._id || uploaded.id,
        documentType: docType,
        originalFilename: docFile.name,
      });
    },
    onSuccess: () => {
      notify.success("Document attached");
      setDocFile(null);
      qc.invalidateQueries({ queryKey: ["asn", id] });
    },
    onError: (e) => notify.fromError(e),
  });

  const detachMut = useMutation({
    mutationFn: (attachmentId) => apiDelete(`/asn/${id}/attachments/${attachmentId}`),
    onSuccess: () => {
      notify.success("Attachment removed");
      qc.invalidateQueries({ queryKey: ["asn", id] });
    },
    onError: (e) => notify.fromError(e),
  });

  const availabilityLines = availQ.data?.lines || [];
  const detail = detailQ.data;
  const status = String(detail?.status || "DRAFT").toUpperCase();
  const linesEditable = creating || status === "DRAFT";
  const headerEditable = creating || status === "DRAFT" || status === "SHIPPED";

  const payloadLines = useMemo(() => {
    const source = creating ? availabilityLines : detail?.lines || [];
    return source
      .map((line) => ({
        poLineId: line.poLineId,
        article: line.article,
        asnQty: Number(lineQtys[String(line.poLineId)] || 0),
        hsCode: String(lineHs[String(line.poLineId)] || "").trim(),
        countryOfOrigin: String(lineCoo[String(line.poLineId)] || "").trim(),
      }))
      .filter((l) => l.asnQty > 0);
  }, [availabilityLines, creating, detail, lineQtys, lineHs, lineCoo]);

  function setShip(key, value) {
    setShipment((prev) => ({ ...prev, [key]: value }));
  }

  function shipmentPayload() {
    const invoices = (shipment.supplierInvoices || [])
      .map((r) => ({
        invoiceNumber: String(r.invoiceNumber || "").trim(),
        invoiceDate: r.invoiceDate || null,
      }))
      .filter((r) => r.invoiceNumber || r.invoiceDate);
    const { supplierInvoiceNumber: _a, supplierInvoiceDate: _b, ...rest } = shipment;
    return {
      ...rest,
      supplierInvoices: invoices.length ? invoices : [],
    };
  }

  async function onCreate() {
    if (!poId) {
      notify.error("Open Create ASN from a purchase order");
      return;
    }
    createMut.mutate({
      sourcePoId: poId,
      ...shipmentPayload(),
      lines: payloadLines,
    });
  }

  async function onSave() {
    patchMut.mutate({
      ...shipmentPayload(),
      lines: status === "DRAFT" ? payloadLines : undefined,
    });
  }

  async function onCancel() {
    const reason = String(cancelReason || "").trim();
    if (!reason) {
      notify.error("Cancellation reason is required");
      return;
    }
    const ok = await confirmDialog({
      title: "Cancel ASN",
      message: "Cancelled quantity becomes available for another ASN. Continue?",
      confirmLabel: "Cancel ASN",
    });
    if (ok) cancelMut.mutate(reason);
  }

  if (!id) {
    const items = listQ.data?.items || [];
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Advance Shipment Notices" subtitle="Supplier shipment notifications before warehouse receiving">
          {canCreate ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white"
              to="/asn/new"
            >
              + Create ASN
            </Link>
          ) : null}
        </PageHeader>
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <TextInput placeholder="ASN no." value={filters.asnNo} onChange={(e) => setFilters((f) => ({ ...f, asnNo: e.target.value }))} />
          <TextInput placeholder="Supplier" value={filters.supplier} onChange={(e) => setFilters((f) => ({ ...f, supplier: e.target.value }))} />
          <TextInput placeholder="PO no." value={filters.poNo} onChange={(e) => setFilters((f) => ({ ...f, poNo: e.target.value }))} />
          <SelectInput value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">All statuses</option>
            {["DRAFT", "SHIPPED", "ARRIVED", "CANCELLED"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </SelectInput>
          <SelectInput value={filters.shipmentMode} onChange={(e) => setFilters((f) => ({ ...f, shipmentMode: e.target.value }))}>
            <option value="">All modes</option>
            {ASN_SHIPMENT_MODES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </SelectInput>
        </div>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-[960px] w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">ASN No.</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">PO No.</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2">AWB / BL / Tracking</th>
                <th className="px-3 py-2">Ship date</th>
                <th className="px-3 py-2">ETA</th>
                <th className="px-3 py-2">Pkgs</th>
                <th className="px-3 py-2">Created by</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row._id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono">
                    <Link className="font-semibold text-sky-800 hover:underline" to={`/asn/${row._id}`}>{row.asnNo}</Link>
                  </td>
                  <td className="px-3 py-2"><AsnStatusBadge status={row.status} /></td>
                  <td className="px-3 py-2">{row.supplierName || "—"}</td>
                  <td className="px-3 py-2 font-mono">{row.sourcePoNo || "—"}</td>
                  <td className="px-3 py-2">{row.supplierInvoiceNumber || "—"}</td>
                  <td className="px-3 py-2">{row.shipmentMode || "—"}</td>
                  <td className="px-3 py-2">{trackingDisplay(row)}</td>
                  <td className="px-3 py-2">{formatAsnDate(row.shipmentDate)}</td>
                  <td className="px-3 py-2">{formatAsnDate(row.expectedArrivalDate)}</td>
                  <td className="px-3 py-2">{row.numberOfPackages || "—"}</td>
                  <td className="px-3 py-2">{row.createdBy || "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Link className="inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold" to={`/asn/${row._id}`}>
                        View
                      </Link>
                      {canEdit && String(row.status).toUpperCase() === "DRAFT" ? (
                        <Link className="inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold" to={`/asn/${row._id}`}>
                          Edit
                        </Link>
                      ) : null}
                      {canStoreView && ["SHIPPED", "ARRIVED"].includes(String(row.status || "").toUpperCase()) ? (
                        <Link
                          className="inline-flex min-h-11 items-center rounded-lg border border-sky-300 bg-sky-50 px-3 text-xs font-semibold text-sky-900"
                          to={incomingShipmentsPath(row._id)}
                        >
                          Receive Shipment
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td className="px-3 py-10 text-center text-gray-600" colSpan={12}>
                    <p className="font-medium text-gray-800">No ASNs found.</p>
                    <p className="mt-1 text-sm">
                      Create an ASN from an eligible purchase order to begin shipment receiving.
                    </p>
                    {canCreate ? (
                      <Link
                        className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white"
                        to="/asn/new"
                      >
                        Create ASN
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (creating && !canCreate) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Create ASN" subtitle="Permission required">
          <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" onClick={() => nav("/asn")}>
            Back to list
          </button>
        </PageHeader>
        <p className="text-sm text-gray-700">You need ASN create permission to create a shipment notice.</p>
      </div>
    );
  }

  if (creating && !poId) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <PageHeader title="Create ASN" subtitle="Select an eligible purchase order">
          <button type="button" className="min-h-11 rounded-lg border px-3 text-sm" onClick={() => nav("/asn")}>
            Back to list
          </button>
        </PageHeader>
        <AsnCreatePoPicker />
      </div>
    );
  }

  const lines = creating ? availabilityLines : detail?.lines || [];

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <PageHeader
        title={creating ? "Create ASN" : detail?.asnNo || "ASN"}
        subtitle={creating ? `From ${availQ.data?.poNo || "purchase order"}` : detail?.supplierName}
      >
        <button type="button" className="min-h-11 rounded-lg border px-3 py-2 text-sm" onClick={() => nav("/asn")}>Back to list</button>
        {creating ? (
          <button type="button" className="min-h-11 rounded-lg border px-3 py-2 text-sm" onClick={() => nav("/asn/new")}>
            Change PO
          </button>
        ) : null}
      </PageHeader>

      {detail ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <AsnStatusBadge status={detail.status} />
            <span className="text-sm text-gray-600">{detail.supplierName}</span>
            <Link className="text-sm font-semibold text-sky-800" to={`/purchase?id=${detail.sourcePoId}`}>{detail.sourcePoNo}</Link>
          </div>
          <AsnWorkflowStrip
            asnStatus={detail.status}
            sessionStatus={progressQ.data?.session?.status}
            grnStatus={progressQ.data?.draftGrn?.status}
          />
          {detail.receivingCompleteness ? (
            <AsnReceivingCompletenessPanel completeness={detail.receivingCompleteness} />
          ) : null}
          {progressQ.data?.progress ? (
            <p className="text-sm text-gray-600">
              Receiving Units: {progressQ.data.progress.ruTotal || 0}
              {" · "}
              Receiving: {progressQ.data.progress.ruCompleted || 0}/{progressQ.data.progress.ruTotal || 0} completed
              {" · "}
              GRN: {progressQ.data.draftGrn?.grnNo
                ? `${progressQ.data.draftGrn.grnNo} ${progressQ.data.draftGrn.status || ""}`
                : "Not generated"}
            </p>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Shipment details</h2>
        <div className="mb-4 rounded-lg border border-slate-100 bg-slate-50/80 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Supplier Invoices</h3>
            {headerEditable ? (
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
                onClick={() =>
                  setShipment((prev) => ({
                    ...prev,
                    supplierInvoices: [...(prev.supplierInvoices || []), { invoiceNumber: "", invoiceDate: "" }],
                  }))
                }
              >
                + Add Supplier Invoice
              </button>
            ) : null}
          </div>
          <div className="space-y-2">
            {(shipment.supplierInvoices || []).map((inv, idx) => (
              <div key={`si-${idx}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <FormField label={idx === 0 ? "Invoice Number" : undefined}>
                  <TextInput
                    disabled={!headerEditable}
                    value={inv.invoiceNumber}
                    onChange={(e) =>
                      setShipment((prev) => {
                        const rows = [...(prev.supplierInvoices || [])];
                        rows[idx] = { ...rows[idx], invoiceNumber: e.target.value };
                        return { ...prev, supplierInvoices: rows };
                      })
                    }
                  />
                </FormField>
                <FormField label={idx === 0 ? "Invoice Date" : undefined}>
                  <TextInput
                    type="date"
                    disabled={!headerEditable}
                    value={inv.invoiceDate}
                    onChange={(e) =>
                      setShipment((prev) => {
                        const rows = [...(prev.supplierInvoices || [])];
                        rows[idx] = { ...rows[idx], invoiceDate: e.target.value };
                        return { ...prev, supplierInvoices: rows };
                      })
                    }
                  />
                </FormField>
                {headerEditable && (shipment.supplierInvoices || []).length > 1 ? (
                  <button
                    type="button"
                    className="mt-6 h-10 rounded border border-rose-200 px-2 text-xs text-rose-700"
                    onClick={() =>
                      setShipment((prev) => ({
                        ...prev,
                        supplierInvoices: (prev.supplierInvoices || []).filter((_, i) => i !== idx),
                      }))
                    }
                  >
                    Remove
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Packing list no.">
            <TextInput disabled={!headerEditable} value={shipment.supplierPackingListNumber} onChange={(e) => setShip("supplierPackingListNumber", e.target.value)} />
          </FormField>
          <FormField label="Shipment mode">
            <SelectInput disabled={!headerEditable} value={shipment.shipmentMode} onChange={(e) => setShip("shipmentMode", e.target.value)}>
              {ASN_SHIPMENT_MODES.map((m) => <option key={m}>{m}</option>)}
            </SelectInput>
          </FormField>
          <FormField label="Forwarder / courier">
            <TextInput disabled={!headerEditable} value={shipment.forwarder} onChange={(e) => setShip("forwarder", e.target.value)} />
          </FormField>
          <FormField label="AWB number">
            <TextInput disabled={!headerEditable} value={shipment.awbNumber} onChange={(e) => setShip("awbNumber", e.target.value)} />
          </FormField>
          <FormField label="BL number">
            <TextInput disabled={!headerEditable} value={shipment.blNumber} onChange={(e) => setShip("blNumber", e.target.value)} />
          </FormField>
          <FormField label="Tracking number">
            <TextInput disabled={!headerEditable} value={shipment.trackingNumber} onChange={(e) => setShip("trackingNumber", e.target.value)} />
          </FormField>
          <FormField label="Shipment date">
            <TextInput type="date" disabled={!headerEditable} value={shipment.shipmentDate} onChange={(e) => setShip("shipmentDate", e.target.value)} />
          </FormField>
          <FormField label="Expected arrival">
            <TextInput type="date" disabled={!headerEditable} value={shipment.expectedArrivalDate} onChange={(e) => setShip("expectedArrivalDate", e.target.value)} />
          </FormField>
          <FormField label="Actual arrival">
            <TextInput type="date" disabled={!headerEditable} value={shipment.actualArrivalDate} onChange={(e) => setShip("actualArrivalDate", e.target.value)} />
          </FormField>
          <FormField label="Country of origin (legacy header)">
            <TextInput
              disabled={!headerEditable}
              value={shipment.countryOfOrigin}
              onChange={(e) => setShip("countryOfOrigin", e.target.value)}
              title="Legacy header fallback only. Prefer line Country of Origin."
            />
          </FormField>
          <FormField label="Port / airport of pending">
            <TextInput disabled={!headerEditable} value={shipment.portOfLoading} onChange={(e) => setShip("portOfLoading", e.target.value)} />
          </FormField>
          <FormField label="Port / airport of arrival">
            <TextInput disabled={!headerEditable} value={shipment.portOfArrival} onChange={(e) => setShip("portOfArrival", e.target.value)} />
          </FormField>
          <FormField label="Packages">
            <TextInput type="number" disabled={!headerEditable} value={shipment.numberOfPackages} onChange={(e) => setShip("numberOfPackages", e.target.value)} />
          </FormField>
          <FormField label="Gross weight">
            <TextInput type="number" disabled={!headerEditable} value={shipment.grossWeight} onChange={(e) => setShip("grossWeight", e.target.value)} />
          </FormField>
          <FormField label="Weight UOM">
            <TextInput disabled={!headerEditable} value={shipment.grossWeightUom} onChange={(e) => setShip("grossWeightUom", e.target.value)} />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2 lg:col-span-3">
            <TextInput disabled={!headerEditable} value={shipment.remarks} onChange={(e) => setShip("remarks", e.target.value)} />
          </FormField>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Shipment lines</h2>
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-2 py-2">Article</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">UOM</th>
                <th className="px-2 py-2">Ordered</th>
                <th className="px-2 py-2">Received</th>
                <th className="px-2 py-2">Active ASN</th>
                <th className="px-2 py-2">Available for new ASN</th>
                <th className="px-2 py-2">ASN qty</th>
                <th className="px-2 py-2">HS Code</th>
                <th className="px-2 py-2">Country of Origin</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const key = String(line.poLineId);
                const remaining = Number(line.remainingAvailableQty || 0);
                const received = Number(line.receivedQty || 0);
                const active = Number(line.previouslyAsnQty || 0);
                return (
                  <tr key={key} className="border-t border-gray-100">
                    <td className="px-2 py-2 font-mono">{line.article || "—"}</td>
                    <td className="px-2 py-2">{line.description || line.itemName || "—"}</td>
                    <td className="px-2 py-2">{line.uom || "PCS"}</td>
                    <td className="px-2 py-2 tabular-nums">{line.poQty}</td>
                    <td className="px-2 py-2 tabular-nums">{received}</td>
                    <td className="px-2 py-2 tabular-nums">{active}</td>
                    <td className="px-2 py-2 tabular-nums">{remaining}</td>
                    <td className="px-2 py-2">
                      {linesEditable ? (
                        <input
                          className="min-h-11 w-24 rounded-lg border px-2 py-1"
                          type="number"
                          min="0"
                          max={creating ? remaining : undefined}
                          value={lineQtys[key] ?? ""}
                          onChange={(e) => setLineQtys((prev) => ({ ...prev, [key]: e.target.value }))}
                        />
                      ) : (
                        <span className="tabular-nums">{line.asnQty}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {linesEditable ? (
                        <input
                          className="min-h-11 w-28 rounded-lg border px-2 py-1 font-mono text-xs"
                          value={lineHs[key] ?? ""}
                          onChange={(e) => setLineHs((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="HS"
                        />
                      ) : (
                        <span className="font-mono text-xs">{line.hsCode || "—"}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {linesEditable ? (
                        <input
                          className="min-h-11 w-28 rounded-lg border px-2 py-1 text-xs"
                          value={lineCoo[key] ?? ""}
                          onChange={(e) =>
                            setLineCoo((prev) => ({ ...prev, [key]: e.target.value.toUpperCase() }))
                          }
                          placeholder="COO"
                        />
                      ) : (
                        <span className="text-xs">{line.countryOfOrigin || "—"}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {!creating ? (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Documents</h2>
          <ul className="space-y-2 text-sm">
            {(detail?.attachments || []).map((att) => (
              <li key={att._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-100 px-3 py-2">
                <div>
                  <div className="font-medium">{att.originalFilename || "Document"}</div>
                  <div className="text-xs text-gray-500">{att.documentType} · {att.uploadedBy || ""}</div>
                </div>
                <div className="flex gap-2">
                  {att.documentId ? (
                    <button type="button" className="text-sky-800" onClick={() => openAsnDocument(att.documentId)}>Download</button>
                  ) : null}
                  {canEdit && status !== "CANCELLED" ? (
                    <button type="button" className="text-red-700" onClick={() => detachMut.mutate(att._id)}>Remove</button>
                  ) : null}
                </div>
              </li>
            ))}
            {!(detail?.attachments || []).length ? <li className="text-gray-500">No attachments</li> : null}
          </ul>
          {canEdit && status !== "CANCELLED" ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <SelectInput value={docType} onChange={(e) => setDocType(e.target.value)}>
                {ASN_DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
              </SelectInput>
              <input type="file" onChange={(e) => setDocFile(e.target.files?.[0] || null)} />
              <LoadingButton loading={attachMut.isPending} onClick={() => attachMut.mutate()}>Attach</LoadingButton>
            </div>
          ) : null}
        </section>
      ) : null}

      {!creating && auditQ.data?.items?.length ? (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">History</h2>
          <ul className="space-y-1 text-xs text-gray-700">
            {auditQ.data.items.map((ev) => (
              <li key={ev._id}>{formatAsnDate(ev.createdAt)} · {ev.action} · {ev.description} · {ev.userName}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {creating && canCreate ? (
          <LoadingButton loading={createMut.isPending} onClick={onCreate}>Create ASN</LoadingButton>
        ) : null}
        {!creating && canEdit && headerEditable ? (
          <LoadingButton loading={patchMut.isPending} onClick={onSave}>Save</LoadingButton>
        ) : null}
        {!creating && canPost && status === "DRAFT" ? (
          <LoadingButton loading={shipMut.isPending} onClick={() => confirmShipOrArrive("ship")}>Mark shipped</LoadingButton>
        ) : null}
        {!creating && canPost && status === "SHIPPED" ? (
          <LoadingButton loading={arriveMut.isPending} onClick={() => confirmShipOrArrive("arrive")}>Mark arrived</LoadingButton>
        ) : null}
        {!creating && canStoreView && ["SHIPPED", "ARRIVED"].includes(status) ? (
          detail?.receivingCompleteness && !detail.receivingCompleteness.complete ? (
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-lg bg-slate-300 px-4 text-sm font-semibold text-slate-600"
              onClick={onReceiveShipmentClick}
              title="Complete required ASN data before receiving"
            >
              Receive Shipment
            </button>
          ) : (
            <Link className="inline-flex min-h-11 items-center rounded-lg bg-sky-800 px-4 text-sm font-semibold text-white" to={incomingShipmentsPath(id)}>
              Receive Shipment
            </Link>
          )
        ) : null}
        {!creating && canCancel && status !== "CANCELLED" && status !== "PARTIALLY_RECEIVED" && status !== "COMPLETED" ? (
          <div className="flex flex-wrap items-center gap-2">
            <TextInput placeholder="Cancellation reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            <LoadingButton loading={cancelMut.isPending} onClick={onCancel}>Cancel ASN</LoadingButton>
          </div>
        ) : null}
      </div>
      {!creating && detail ? (
        <p className="text-xs text-gray-500">Total ASN qty {asnLineQtyTotal(detail)} · created by {detail.createdBy || "—"}</p>
      ) : null}
    </div>
  );
}
