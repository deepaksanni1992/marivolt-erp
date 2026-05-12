import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiGet, apiGetWithQuery, apiPost, apiPostFormData, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";
import PurchaseOrdersModule from "./Purchase.jsx";

const TABS = [
  { id: "suppliers", label: "Supplier Master" },
  { id: "orders", label: "Purchase Orders" },
  { id: "grn", label: "GRN Receiving" },
  { id: "reports", label: "PO Reports" },
  { id: "dashboard", label: "Dashboard" },
];

const DOC_TYPES = ["Supplier Invoice", "Packing List", "BL/AWB", "Customs Docs", "Inspection Report"];

function StatusBadge({ status }) {
  const s = String(status || "").toUpperCase();
  const classes = {
    DRAFT: "bg-slate-100 text-slate-800",
    SUBMITTED: "bg-sky-100 text-sky-800",
    APPROVED: "bg-emerald-100 text-emerald-800",
    REJECTED: "bg-rose-100 text-rose-800",
    CLOSED: "bg-indigo-100 text-indigo-800",
    CANCELLED: "bg-zinc-200 text-zinc-800",
    SENT: "bg-sky-100 text-sky-800",
    PARTIAL_RECEIVED: "bg-amber-100 text-amber-800",
    RECEIVED: "bg-emerald-100 text-emerald-800",
    POSTED: "bg-emerald-100 text-emerald-800",
    PENDING_RECEIVE: "bg-amber-100 text-amber-800",
    PENDING_CANCEL: "bg-amber-100 text-amber-800",
    NOT_REQUIRED: "bg-slate-100 text-slate-800",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${classes[s] || classes.DRAFT}`}>
      {s || "—"}
    </span>
  );
}

function SupplierMasterTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const [saveError, setSaveError] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["procurement-suppliers", search],
    queryFn: () => apiGetWithQuery("/suppliers", { search: search || undefined, limit: 200 }),
  });
  const items = data?.items || [];

  const save = useMutation({
    mutationFn: (payload) => (payload._id ? apiPut(`/suppliers/${payload._id}`, payload) : apiPost("/suppliers", payload)),
    onSuccess: () => {
      setSaveError("");
      qc.invalidateQueries({ queryKey: ["procurement-suppliers"] });
      setEditing(null);
    },
    onError: (e) => setSaveError(e.message || "Save failed"),
  });

  function exportCsv() {
    downloadCsv(`suppliers-${Date.now()}.csv`, [
      { key: "supplierCode", header: "Code" },
      { key: "supplierName", header: "Supplier" },
      { key: "supplierType", header: "Type" },
      { key: "country", header: "Country" },
      { key: "contactPerson", header: "Contact" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
      { key: "currency", header: "Currency" },
      { key: "activeStatus", header: "Active" },
    ], items.map((x) => ({ ...x, activeStatus: x.activeStatus ? "YES" : "NO" })));
  }

  function exportPdf() {
    downloadPdfTable("Supplier Master", "", [
      { key: "supplierCode", header: "Code" },
      { key: "supplierName", header: "Supplier" },
      { key: "supplierType", header: "Type" },
      { key: "country", header: "Country" },
      { key: "contactPerson", header: "Contact" },
      { key: "phone", header: "Phone" },
      { key: "email", header: "Email" },
      { key: "currency", header: "Currency" },
      { key: "activeStatus", header: "Active" },
    ], items.map((x) => ({ ...x, activeStatus: x.activeStatus ? "YES" : "NO" })), "suppliers");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Search supplier">
          <TextInput value={search} onChange={(e) => setSearch(e.target.value)} />
        </FormField>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={exportCsv} type="button">Export CSV</button>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={exportPdf} type="button">Export PDF</button>
        <button
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
          onClick={() => {
            setSaveError("");
            setEditing({ supplierName: "", supplierType: "LOCAL", currency: "USD", activeStatus: true });
          }}
          type="button"
        >
          New Supplier
        </button>
      </div>
      <div className="overflow-auto rounded-2xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 text-left">Code</th>
              <th className="px-3 py-2 text-left">Supplier</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Country</th>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-left">Currency</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? <tr><td colSpan={8} className="px-3 py-6 text-center">Loading...</td></tr> : items.map((s) => (
              <tr key={s._id} className="border-t">
                <td className="px-3 py-2 font-mono">{s.supplierCode}</td>
                <td className="px-3 py-2">{s.supplierName}</td>
                <td className="px-3 py-2">{s.supplierType || "—"}</td>
                <td className="px-3 py-2">{s.country || "—"}</td>
                <td className="px-3 py-2">{s.contactPerson || "—"}</td>
                <td className="px-3 py-2">{s.currency || "USD"}</td>
                <td className="px-3 py-2"><StatusBadge status={s.activeStatus ? "APPROVED" : "CANCELLED"} /></td>
                <td className="px-3 py-2"><button className="text-xs underline" type="button" onClick={() => { setSaveError(""); setEditing(s); }}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={!!editing} onClose={() => { setSaveError(""); setEditing(null); }} title={editing?._id ? "Edit Supplier" : "New Supplier"} wide>
        {editing ? (
          <SupplierForm
            initial={editing}
            onSave={(payload) => save.mutate(payload)}
            saving={save.isPending}
            error={saveError}
            onDismissError={() => setSaveError("")}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function SupplierForm({ initial, onSave, saving, error, onDismissError }) {
  const [form, setForm] = useState({
    _id: initial._id,
    supplierCode: initial.supplierCode || "",
    supplierName: initial.supplierName || initial.name || "",
    shortName: initial.shortName || "",
    supplierType: initial.supplierType || "LOCAL",
    country: initial.country || "",
    address: initial.address || "",
    vatNo: initial.vatNo || "",
    registrationNo: initial.registrationNo || "",
    contactPerson: initial.contactPerson || "",
    phone: initial.phone || "",
    email: initial.email || "",
    paymentTerms: initial.paymentTerms || "",
    currency: initial.currency || "USD",
    remarks: initial.remarks || "",
    activeStatus: initial.activeStatus !== false,
  });
  const set = (k) => (e) => {
    onDismissError?.();
    setForm((p) => ({ ...p, [k]: e.target.value }));
  };
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onDismissError?.();
        onSave(form);
      }}
    >
      {error ? (
        <div className="sm:col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">
          {error}
        </div>
      ) : null}
      <FormField label="Supplier Code"><TextInput value={form.supplierCode} onChange={set("supplierCode")} /></FormField>
      <FormField label="Supplier Name"><TextInput value={form.supplierName} onChange={set("supplierName")} required /></FormField>
      <FormField label="Short Name"><TextInput value={form.shortName} onChange={set("shortName")} /></FormField>
      <FormField label="Supplier Type"><TextInput value={form.supplierType} onChange={set("supplierType")} /></FormField>
      <FormField label="Country"><TextInput value={form.country} onChange={set("country")} /></FormField>
      <FormField label="Currency"><TextInput value={form.currency} onChange={set("currency")} /></FormField>
      <FormField label="Contact Person"><TextInput value={form.contactPerson} onChange={set("contactPerson")} /></FormField>
      <FormField label="Phone"><TextInput value={form.phone} onChange={set("phone")} /></FormField>
      <FormField label="Email"><TextInput value={form.email} onChange={set("email")} /></FormField>
      <FormField label="TRN/VAT"><TextInput value={form.vatNo} onChange={set("vatNo")} /></FormField>
      <FormField label="Registration No"><TextInput value={form.registrationNo} onChange={set("registrationNo")} /></FormField>
      <FormField label="Payment Terms"><TextInput value={form.paymentTerms} onChange={set("paymentTerms")} /></FormField>
      <FormField label="Address" className="sm:col-span-2"><TextInput value={form.address} onChange={set("address")} /></FormField>
      <FormField label="Remarks" className="sm:col-span-2"><TextInput value={form.remarks} onChange={set("remarks")} /></FormField>
      <div className="sm:col-span-2 flex justify-end"><button disabled={saving} className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Save"}</button></div>
    </form>
  );
}

function GrnTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [docType, setDocType] = useState("Supplier Invoice");
  const [docFile, setDocFile] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["procurement-grn", status],
    queryFn: () => apiGetWithQuery("/grn", { status: status || undefined, limit: 200 }),
  });
  const rows = useMemo(() => data?.items || [], [data]);
  const { data: detail, refetch: refetchDetail } = useQuery({
    queryKey: ["procurement-grn-detail", selected?.grnNo],
    queryFn: () => apiGet(`/grn/${selected.grnNo}`),
    enabled: !!selected?.grnNo,
  });
  const act = useMutation({
    mutationFn: ({ grnNo, action }) => apiPost(`/grn/${grnNo}/${action}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["procurement-grn"] });
      qc.invalidateQueries({ queryKey: ["purchaseOrders"] });
      refetchDetail();
    },
  });
  const saveGrn = useMutation({
    mutationFn: (payload) => apiPut(`/grn/${payload.grnNo}`, payload.body),
    onSuccess: () => {
      setEditOpen(false);
      qc.invalidateQueries({ queryKey: ["procurement-grn"] });
      refetchDetail();
    },
  });
  const uploadDoc = useMutation({
    mutationFn: async ({ file, documentType }) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("documentType", documentType);
      fd.append("moduleName", "PROCUREMENT");
      fd.append("refNo", detail?.grnNo || "");
      fd.append("partyName", detail?.supplierName || "");
      fd.append("relatedId", String(detail?._id || ""));
      const d = await apiPostFormData("/documents/upload", fd);
      const next = [...(detail?.attachments || []), {
        documentId: d._id,
        documentType: d.documentType,
        fileName: d.originalFileName,
        uploadedAt: d.uploadedAt || new Date().toISOString(),
        remarks: "",
      }];
      await apiPut(`/grn/${detail.grnNo}`, { ...detail, attachments: next, items: detail.items || [] });
      return d;
    },
    onSuccess: () => refetchDetail(),
  });
  async function openDocument(id, inline) {
    const info = await apiGet(`/documents/${id}/download${inline ? "?inline=1" : ""}`);
    if (info?.url) window.open(info.url, "_blank", "noopener,noreferrer");
  }
  const exportRows = useMemo(
    () =>
      rows.map((x) => ({
        grnNo: x.grnNo,
        grnDate: x.grnDate ? new Date(x.grnDate).toISOString().slice(0, 10) : "",
        poNo: x.poNo || "",
        supplierName: x.supplierName || "",
        status: x.status || "",
        approvalStatus: x.approvalStatus || "",
        lines: (x.items || []).length,
      })),
    [rows]
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Status">
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["DRAFT", "POSTED", "PARTIAL_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectInput>
        </FormField>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="button" onClick={() => downloadCsv(`grn-${Date.now()}.csv`, [{ key: "grnNo", header: "GRN No" }, { key: "grnDate", header: "Date" }, { key: "poNo", header: "PO No" }, { key: "supplierName", header: "Supplier" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "lines", header: "Lines" }], exportRows)}>Export CSV</button>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="button" onClick={() => downloadPdfTable("GRN Summary", "", [{ key: "grnNo", header: "GRN No" }, { key: "grnDate", header: "Date" }, { key: "poNo", header: "PO No" }, { key: "supplierName", header: "Supplier" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "lines", header: "Lines" }], exportRows, "grn-summary")}>Export PDF</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="overflow-auto rounded-2xl border bg-white">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600"><tr><th className="px-3 py-2 text-left">GRN No</th><th className="px-3 py-2 text-left">PO</th><th className="px-3 py-2 text-left">Supplier</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Approval</th><th className="px-3 py-2 text-left">Action</th></tr></thead>
            <tbody>{isLoading ? <tr><td className="px-3 py-6 text-center" colSpan={6}>Loading...</td></tr> : rows.map((g) => <tr key={g._id} className={`border-t ${selected?._id === g._id ? "bg-slate-50" : ""}`}><td className="px-3 py-2 font-mono">{g.grnNo}</td><td className="px-3 py-2">{g.poNo || "—"}</td><td className="px-3 py-2">{g.supplierName || "—"}</td><td className="px-3 py-2"><StatusBadge status={g.status} /></td><td className="px-3 py-2"><StatusBadge status={g.approvalStatus} /></td><td className="px-3 py-2"><button className="text-xs underline" type="button" onClick={() => setSelected(g)}>View</button></td></tr>)}</tbody>
          </table>
        </div>
        <div className="rounded-2xl border bg-white p-3">
          <h3 className="text-sm font-semibold">GRN Detail</h3>
          {selected ? <div className="mt-2 space-y-2 text-sm"><div><b>{selected.grnNo}</b></div><div>PO: {selected.poNo || "—"}</div><div>Supplier: {selected.supplierName || "—"}</div><div>Status: <StatusBadge status={selected.status} /></div><div>Approval: <StatusBadge status={selected.approvalStatus} /></div><div>Lines: {(detail?.items || selected.items || []).length}</div><div className="flex flex-wrap gap-2 pt-2"><button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => setEditOpen(true)}>Edit Lines</button><button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => act.mutate({ grnNo: selected.grnNo, action: "receive" })}>Receive</button><button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => act.mutate({ grnNo: selected.grnNo, action: "cancel" })}>Cancel</button><button className="rounded border px-2 py-1 text-xs" type="button" onClick={() => act.mutate({ grnNo: selected.grnNo, action: "close" })}>Close</button></div></div> : <div className="mt-2 text-sm text-slate-500">Select a GRN row.</div>}
        </div>
      </div>
      <div className="rounded-2xl border bg-white p-3">
        <div className="mb-2 text-sm font-semibold">Supplier Documents</div>
        {detail ? (
          <>
            <div className="mb-2 flex flex-wrap items-end gap-2">
              <FormField label="Document Type"><SelectInput value={docType} onChange={(e) => setDocType(e.target.value)}>{DOC_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}</SelectInput></FormField>
              <input type="file" onChange={(e) => setDocFile(e.target.files?.[0] || null)} className="text-xs" />
              <button type="button" className="rounded border px-3 py-2 text-xs" onClick={() => docFile && uploadDoc.mutate({ file: docFile, documentType: docType })}>Upload</button>
            </div>
            <div className="overflow-auto rounded border">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-left">File</th><th className="px-2 py-1 text-left">Uploaded</th><th className="px-2 py-1 text-left">Action</th></tr></thead>
                <tbody>{(detail.attachments || []).length ? detail.attachments.map((a) => <tr key={String(a._id || a.documentId)} className="border-t"><td className="px-2 py-1">{a.documentType || "—"}</td><td className="px-2 py-1">{a.fileName || "—"}</td><td className="px-2 py-1">{a.uploadedAt ? new Date(a.uploadedAt).toLocaleString() : "—"}</td><td className="px-2 py-1 space-x-2"><button type="button" className="underline" onClick={() => openDocument(a.documentId, true)}>Preview</button><button type="button" className="underline" onClick={() => openDocument(a.documentId, false)}>Download</button></td></tr>) : <tr><td colSpan={4} className="px-2 py-3 text-center text-slate-500">No documents</td></tr>}</tbody>
              </table>
            </div>
          </>
        ) : <div className="text-sm text-slate-500">Select GRN first.</div>}
      </div>
      <Modal open={editOpen && !!detail} onClose={() => setEditOpen(false)} title={`Edit GRN ${detail?.grnNo || ""}`} wide>
        {detail ? <GrnLineEditor detail={detail} onSave={(body) => saveGrn.mutate({ grnNo: detail.grnNo, body })} saving={saveGrn.isPending} /> : null}
      </Modal>
    </div>
  );
}

function GrnLineEditor({ detail, onSave, saving }) {
  const [items, setItems] = useState((detail.items || []).map((x) => ({ ...x })));
  const [remarks, setRemarks] = useState(detail.remarks || "");
  function upd(i, key, v) {
    setItems((prev) => prev.map((ln, idx) => (idx === i ? { ...ln, [key]: v } : ln)));
  }
  function valid(ln) {
    const r = Number(ln.receivedQty) || 0;
    const rej = Number(ln.rejectedQty) || 0;
    const can = Number(ln.cancelledQty) || 0;
    const pending = Number(ln.pendingQty) || 0;
    return r + rej + can <= pending;
  }
  const invalidCount = items.filter((x) => !valid(x)).length;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (invalidCount) return; onSave({ ...detail, remarks, items }); }} className="space-y-3">
      <div className="overflow-auto rounded border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs"><tr><th className="px-2 py-2 text-left">Article</th><th className="px-2 py-2 text-left">Pending</th><th className="px-2 py-2 text-left">Received</th><th className="px-2 py-2 text-left">Rejected</th><th className="px-2 py-2 text-left">Cancelled</th><th className="px-2 py-2 text-left">Remarks</th><th className="px-2 py-2 text-left">Recovery</th></tr></thead>
          <tbody>{items.map((ln, i) => <tr key={`${ln.article}-${i}`} className={`border-t ${!valid(ln) ? "bg-rose-50" : ""}`}><td className="px-2 py-2">{ln.article}</td><td className="px-2 py-2">{Number(ln.pendingQty) || 0}</td><td className="px-2 py-2"><TextInput type="number" value={ln.receivedQty ?? 0} onChange={(e) => upd(i, "receivedQty", Number(e.target.value))} /></td><td className="px-2 py-2"><TextInput type="number" value={ln.rejectedQty ?? 0} onChange={(e) => upd(i, "rejectedQty", Number(e.target.value))} /></td><td className="px-2 py-2"><TextInput type="number" value={ln.cancelledQty ?? 0} onChange={(e) => upd(i, "cancelledQty", Number(e.target.value))} /></td><td className="px-2 py-2"><TextInput value={ln.remarks || ""} onChange={(e) => upd(i, "remarks", e.target.value)} /></td><td className="px-2 py-2 text-xs">{(ln.recoveryInfo || []).join("; ") || "—"}</td></tr>)}</tbody>
        </table>
      </div>
      {invalidCount ? <div className="text-sm text-rose-700">Fix {invalidCount} line(s): received + rejected + cancelled cannot exceed pending.</div> : null}
      <FormField label="GRN Remarks"><TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} /></FormField>
      <div className="flex justify-end"><button type="submit" disabled={saving || invalidCount > 0} className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Save GRN Lines"}</button></div>
    </form>
  );
}

function ReportsTab() {
  const { data: openData } = useQuery({ queryKey: ["po-open-report"], queryFn: () => apiGet("/purchase-orders/reports/open") });
  const { data: pendingData } = useQuery({ queryKey: ["po-pending-report"], queryFn: () => apiGet("/purchase-orders/reports/pending") });
  const openRows = openData?.items || [];
  const pendingRows = (pendingData?.items || []).map((x) => ({
    poNo: x.poNo || x.poNumber,
    supplier: x.supplierName,
    ordered: x._report?.totalOrderedQty || 0,
    received: x._report?.totalReceivedQty || 0,
    pending: x._report?.pendingQty || 0,
    eta: x._report?.eta ? new Date(x._report.eta).toISOString().slice(0, 10) : "",
    status: x.status,
    warehouse: x._report?.warehouse || "",
  }));
  const columns = [{ key: "poNo", header: "PO No" }, { key: "supplier", header: "Supplier" }, { key: "ordered", header: "Ordered" }, { key: "received", header: "Received" }, { key: "pending", header: "Pending" }, { key: "eta", header: "ETA" }, { key: "status", header: "Status" }, { key: "warehouse", header: "Warehouse" }];
  return (
    <div className="space-y-4">
      <div className="flex gap-2"><button className="rounded border px-3 py-2 text-sm" type="button" onClick={() => downloadCsv(`open-po-${Date.now()}.csv`, columns, openRows)}>Export Open PO CSV</button><button className="rounded border px-3 py-2 text-sm" type="button" onClick={() => downloadPdfTable("Open PO Report", "", columns, openRows, "open-po-report")}>Export Open PO PDF</button><button className="rounded border px-3 py-2 text-sm" type="button" onClick={() => downloadCsv(`pending-po-${Date.now()}.csv`, columns, pendingRows)}>Export Pending PO CSV</button></div>
      <ReportTable title="Open PO Report" rows={openRows} />
      <ReportTable title="Pending PO Report" rows={pendingRows} />
    </div>
  );
}

function ReportTable({ title, rows }) {
  return (
    <div className="rounded-2xl border bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs"><tr><th className="px-2 py-2 text-left">PO No</th><th className="px-2 py-2 text-left">Supplier</th><th className="px-2 py-2 text-left">Ordered</th><th className="px-2 py-2 text-left">Received</th><th className="px-2 py-2 text-left">Pending</th><th className="px-2 py-2 text-left">ETA</th><th className="px-2 py-2 text-left">Status</th><th className="px-2 py-2 text-left">Warehouse</th></tr></thead>
          <tbody>{rows.length ? rows.map((r) => <tr key={`${r.poNo}-${r.status}-${r.pending}`} className="border-t"><td className="px-2 py-1">{r.poNo}</td><td className="px-2 py-1">{r.supplier}</td><td className="px-2 py-1">{r.ordered}</td><td className="px-2 py-1">{r.received}</td><td className="px-2 py-1 font-semibold">{r.pending}</td><td className="px-2 py-1">{r.eta || "—"}</td><td className="px-2 py-1"><StatusBadge status={r.status} /></td><td className="px-2 py-1">{r.warehouse || "—"}</td></tr>) : <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-500">No rows</td></tr>}</tbody>
        </table>
      </div>
    </div>
  );
}

function DashboardTab() {
  const { data } = useQuery({ queryKey: ["procurement-dashboard"], queryFn: () => apiGet("/purchase-orders/reports/dashboard") });
  const widgets = data?.widgets || {};
  const suppliers = data?.supplierOutstanding || [];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Open POs", widgets.openPos || 0],
          ["Pending Receipts", widgets.pendingReceipts || 0],
          ["Delayed Suppliers", widgets.delayedSuppliers || 0],
          ["Partial GRNs", widgets.partialGrns || 0],
          ["Supplier Outstanding", suppliers.reduce((n, x) => n + (Number(x.pendingQty) || 0), 0)],
        ].map(([label, value]) => <div key={label} className="rounded-2xl border bg-white p-4"><div className="text-xs uppercase text-slate-500">{label}</div><div className="mt-1 text-2xl font-bold">{value}</div></div>)}
      </div>
      <div className="rounded-2xl border bg-white p-3">
        <h3 className="mb-2 text-sm font-semibold">Supplier Outstanding</h3>
        <div className="overflow-auto">
          <table className="min-w-full text-sm"><thead className="bg-slate-50 text-xs"><tr><th className="px-2 py-2 text-left">Supplier</th><th className="px-2 py-2 text-left">Pending Qty</th></tr></thead><tbody>{suppliers.length ? suppliers.map((s) => <tr key={s.supplierName} className="border-t"><td className="px-2 py-1">{s.supplierName}</td><td className="px-2 py-1">{s.pendingQty}</td></tr>) : <tr><td colSpan={2} className="px-2 py-4 text-center text-slate-500">No outstanding suppliers</td></tr>}</tbody></table>
        </div>
      </div>
    </div>
  );
}

export default function ProcurementFoundation() {
  const [tab, setTab] = useState("suppliers");
  return (
    <div className="space-y-4">
      <PageHeader title="Procurement Foundation" subtitle="Supplier Master, purchase orders, GRN, reports, and dashboard." />
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={tab === t.id ? "rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white" : "rounded-xl border px-3 py-2 text-sm font-semibold"}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "suppliers" && <SupplierMasterTab />}
      {tab === "orders" && <PurchaseOrdersModule procurementEmbed />}
      {tab === "grn" && <GrnTab />}
      {tab === "reports" && <ReportsTab />}
      {tab === "dashboard" && <DashboardTab />}
    </div>
  );
}
