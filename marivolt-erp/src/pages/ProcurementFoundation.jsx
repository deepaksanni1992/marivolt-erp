import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiGetWithQuery, apiPost, apiPut } from "../lib/api.js";
import { downloadCsv, downloadPdfTable } from "../lib/purchaseExport.js";

const TABS = [
  { id: "suppliers", label: "Supplier Master" },
  { id: "requisitions", label: "Purchase Requisitions" },
  { id: "orders", label: "Purchase Orders" },
];

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
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${classes[s] || classes.DRAFT}`}>{s || "—"}</span>;
}

function SupplierMasterTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["procurement-suppliers", search],
    queryFn: () => apiGetWithQuery("/suppliers", { search: search || undefined, limit: 200 }),
  });
  const items = data?.items || [];

  const save = useMutation({
    mutationFn: (payload) => (payload._id ? apiPut(`/suppliers/${payload._id}`, payload) : apiPost("/suppliers", payload)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["procurement-suppliers"] });
      setEditing(null);
    },
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
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white" onClick={() => setEditing({ supplierName: "", supplierType: "LOCAL", currency: "USD", activeStatus: true })} type="button">New Supplier</button>
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
                <td className="px-3 py-2"><button className="text-xs underline" type="button" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?._id ? "Edit Supplier" : "New Supplier"} wide>
        {editing ? <SupplierForm initial={editing} onSave={(payload) => save.mutate(payload)} saving={save.isPending} /> : null}
      </Modal>
    </div>
  );
}

function SupplierForm({ initial, onSave, saving }) {
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
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  return (
    <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave(form); }}>
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

function PurchaseRequisitionTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["procurement-pr", status],
    queryFn: () => apiGetWithQuery("/purchase-orders/requisitions", { status: status || undefined, limit: 200 }),
  });
  const items = useMemo(() => data?.items || [], [data]);
  const save = useMutation({
    mutationFn: (payload) => (payload._id ? apiPut(`/purchase-orders/requisitions/${payload._id}`, payload) : apiPost("/purchase-orders/requisitions", payload)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["procurement-pr"] }),
  });
  const act = useMutation({
    mutationFn: ({ id, action }) => apiPost(`/purchase-orders/requisitions/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["procurement-pr"] }),
  });

  const exportRows = useMemo(() => items.map((x) => ({
    prNo: x.prNo,
    status: x.status,
    approvalStatus: x.approvalStatus,
    requester: x.requester,
    department: x.department,
    requiredDate: x.requiredDate ? new Date(x.requiredDate).toISOString().slice(0, 10) : "",
    lineCount: (x.lines || []).length,
  })), [items]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Status">
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "CLOSED", "CANCELLED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectInput>
        </FormField>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => downloadCsv(`pr-${Date.now()}.csv`, [{ key: "prNo", header: "PR No" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "requester", header: "Requester" }, { key: "department", header: "Dept" }, { key: "requiredDate", header: "Required Date" }, { key: "lineCount", header: "Lines" }], exportRows)} type="button">Export CSV</button>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => downloadPdfTable("Purchase Requisitions", "", [{ key: "prNo", header: "PR No" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "requester", header: "Requester" }, { key: "department", header: "Dept" }, { key: "requiredDate", header: "Required Date" }, { key: "lineCount", header: "Lines" }], exportRows, "purchase-requisitions")} type="button">Export PDF</button>
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white" type="button" onClick={() => setEditing({ requester: "", department: "", remarks: "", lines: [{ article: "", description: "", qty: 1, uom: "PCS", remarks: "" }] })}>New PR</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="overflow-auto rounded-2xl border bg-white">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600">
              <tr><th className="px-3 py-2 text-left">PR No</th><th className="px-3 py-2 text-left">Requester</th><th className="px-3 py-2 text-left">Dept</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Approval</th><th className="px-3 py-2 text-left">Action</th></tr>
            </thead>
            <tbody>
              {isLoading ? <tr><td colSpan={6} className="px-3 py-6 text-center">Loading...</td></tr> : items.map((pr) => (
                <tr key={pr._id} className={`border-t ${selected?._id === pr._id ? "bg-slate-50" : ""}`}>
                  <td className="px-3 py-2 font-mono">{pr.prNo}</td>
                  <td className="px-3 py-2">{pr.requester || "—"}</td>
                  <td className="px-3 py-2">{pr.department || "—"}</td>
                  <td className="px-3 py-2"><StatusBadge status={pr.status} /></td>
                  <td className="px-3 py-2"><StatusBadge status={pr.approvalStatus} /></td>
                  <td className="px-3 py-2 space-x-2"><button className="text-xs underline" onClick={() => setSelected(pr)} type="button">View</button><button className="text-xs underline" onClick={() => setEditing(pr)} type="button">Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-2xl border bg-white p-3">
          <h3 className="text-sm font-semibold">PR Detail</h3>
          {selected ? (
            <div className="mt-2 space-y-2 text-sm">
              <div><b>{selected.prNo}</b></div>
              <div>Status: <StatusBadge status={selected.status} /> </div>
              <div>Approval: <StatusBadge status={selected.approvalStatus} /></div>
              <div>Requester: {selected.requester || "—"}</div>
              <div>Department: {selected.department || "—"}</div>
              <div>Lines: {(selected.lines || []).length}</div>
              <div className="flex flex-wrap gap-2 pt-2">
                <button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "submit" })} type="button">Submit</button>
                <button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "approve" })} type="button">Approve</button>
                <button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "reject" })} type="button">Reject</button>
                <button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "cancel" })} type="button">Cancel</button>
              </div>
            </div>
          ) : <div className="mt-2 text-sm text-slate-500">Select a PR row.</div>}
        </div>
      </div>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?._id ? "Edit PR" : "New PR"} wide>
        {editing ? <PRForm initial={editing} onSave={(payload) => save.mutate(payload)} saving={save.isPending} /> : null}
      </Modal>
    </div>
  );
}

function PRForm({ initial, onSave, saving }) {
  const [form, setForm] = useState({
    _id: initial._id,
    requester: initial.requester || "",
    department: initial.department || "",
    requiredDate: initial.requiredDate ? new Date(initial.requiredDate).toISOString().slice(0, 10) : "",
    remarks: initial.remarks || "",
    lines: (initial.lines && initial.lines.length ? initial.lines : [{ article: "", description: "", qty: 1, uom: "PCS", remarks: "" }]).map((x) => ({ ...x, requiredDate: x.requiredDate ? new Date(x.requiredDate).toISOString().slice(0, 10) : "" })),
  });
  function updateLine(i, key, val) {
    setForm((p) => ({ ...p, lines: p.lines.map((ln, idx) => (idx === i ? { ...ln, [key]: val } : ln)) }));
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Requester"><TextInput value={form.requester} onChange={(e) => setForm((p) => ({ ...p, requester: e.target.value }))} /></FormField>
        <FormField label="Department"><TextInput value={form.department} onChange={(e) => setForm((p) => ({ ...p, department: e.target.value }))} /></FormField>
        <FormField label="Required Date"><TextInput type="date" value={form.requiredDate} onChange={(e) => setForm((p) => ({ ...p, requiredDate: e.target.value }))} /></FormField>
        <FormField label="Remarks"><TextInput value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} /></FormField>
      </div>
      <div className="overflow-auto rounded-xl border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-2 py-2 text-left">Article</th><th className="px-2 py-2 text-left">Description</th><th className="px-2 py-2 text-left">Qty</th><th className="px-2 py-2 text-left">UOM</th><th className="px-2 py-2 text-left">Required</th></tr></thead>
          <tbody>
            {form.lines.map((ln, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-2"><TextInput value={ln.article || ""} onChange={(e) => updateLine(i, "article", e.target.value)} /></td>
                <td className="px-2 py-2"><TextInput value={ln.description || ""} onChange={(e) => updateLine(i, "description", e.target.value)} /></td>
                <td className="px-2 py-2"><TextInput type="number" value={ln.qty || 0} onChange={(e) => updateLine(i, "qty", Number(e.target.value))} /></td>
                <td className="px-2 py-2"><TextInput value={ln.uom || "PCS"} onChange={(e) => updateLine(i, "uom", e.target.value)} /></td>
                <td className="px-2 py-2"><TextInput type="date" value={ln.requiredDate || ""} onChange={(e) => updateLine(i, "requiredDate", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between"><button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => setForm((p) => ({ ...p, lines: [...p.lines, { article: "", description: "", qty: 1, uom: "PCS", remarks: "" }] }))}>Add Line</button><button disabled={saving} className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Save PR"}</button></div>
    </form>
  );
}

function PurchaseOrderTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null);
  const { data } = useQuery({ queryKey: ["procurement-po", status], queryFn: () => apiGetWithQuery("/purchase-orders", { status: status || undefined, limit: 200 }) });
  const { data: supplierData } = useQuery({ queryKey: ["procurement-po-suppliers"], queryFn: () => apiGetWithQuery("/suppliers", { limit: 500 }) });
  const items = data?.items || [];
  const suppliers = supplierData?.items || [];
  const save = useMutation({
    mutationFn: (payload) => (payload._id ? apiPut(`/purchase-orders/${payload._id}`, payload) : apiPost("/purchase-orders", payload)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["procurement-po"] }),
  });
  const act = useMutation({
    mutationFn: ({ id, action }) => apiPost(`/purchase-orders/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["procurement-po"] }),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Status">
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {["DRAFT", "SENT", "PARTIAL_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED", "REJECTED"].map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectInput>
        </FormField>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="button" onClick={() => downloadCsv(`po-${Date.now()}.csv`, [{ key: "poNo", header: "PO No" }, { key: "supplierName", header: "Supplier" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "grandTotal", header: "Amount" }], items)}>Export CSV</button>
        <button className="rounded-lg border px-3 py-2 text-sm font-semibold" type="button" onClick={() => downloadPdfTable("Purchase Orders", "", [{ key: "poNo", header: "PO No" }, { key: "supplierName", header: "Supplier" }, { key: "status", header: "Status" }, { key: "approvalStatus", header: "Approval" }, { key: "grandTotal", header: "Amount" }], items, "purchase-orders")}>Export PDF</button>
        <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white" type="button" onClick={() => setEditing({ supplierId: "", currency: "USD", exchangeRate: 1, lines: [{ article: "", description: "", orderedQty: 1, unitPrice: 0, uom: "PCS" }] })}>New PO</button>
      </div>
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="overflow-auto rounded-2xl border bg-white">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-600"><tr><th className="px-3 py-2 text-left">PO No</th><th className="px-3 py-2 text-left">Supplier</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Approval</th><th className="px-3 py-2 text-left">Amount</th><th className="px-3 py-2 text-left">Action</th></tr></thead>
            <tbody>{items.map((po) => <tr key={po._id} className={`border-t ${selected?._id === po._id ? "bg-slate-50" : ""}`}><td className="px-3 py-2 font-mono">{po.poNo || po.poNumber}</td><td className="px-3 py-2">{po.supplierName}</td><td className="px-3 py-2"><StatusBadge status={po.status} /></td><td className="px-3 py-2"><StatusBadge status={po.approvalStatus} /></td><td className="px-3 py-2">{Number(po.grandTotal || 0).toFixed(2)}</td><td className="px-3 py-2 space-x-2"><button className="text-xs underline" type="button" onClick={() => setSelected(po)}>View</button><button className="text-xs underline" type="button" onClick={() => setEditing(po)}>Edit</button></td></tr>)}</tbody>
          </table>
        </div>
        <div className="rounded-2xl border bg-white p-3">
          <h3 className="text-sm font-semibold">PO Detail</h3>
          {selected ? <div className="mt-2 space-y-2 text-sm"><div><b>{selected.poNo || selected.poNumber}</b></div><div>Supplier: {selected.supplierName}</div><div>Status: <StatusBadge status={selected.status} /></div><div>Approval: <StatusBadge status={selected.approvalStatus} /></div><div>Lines: {(selected.lines || []).length}</div><div className="flex flex-wrap gap-2 pt-2"><button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "submit" })} type="button">Submit</button><button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "approve" })} type="button">Approve</button><button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "reject" })} type="button">Reject</button><button className="rounded border px-2 py-1 text-xs" onClick={() => act.mutate({ id: selected._id, action: "cancel" })} type="button">Cancel</button></div></div> : <div className="mt-2 text-sm text-slate-500">Select a PO row.</div>}
        </div>
      </div>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?._id ? "Edit PO" : "New PO"} wide>
        {editing ? <POForm initial={editing} suppliers={suppliers} onSave={(payload) => save.mutate(payload)} saving={save.isPending} /> : null}
      </Modal>
    </div>
  );
}

function POForm({ initial, suppliers, onSave, saving }) {
  const [form, setForm] = useState({
    _id: initial._id,
    supplierId: initial.supplierId || "",
    supplierName: initial.supplierName || "",
    currency: initial.currency || "USD",
    exchangeRate: Number(initial.exchangeRate || 1),
    paymentTerms: initial.paymentTerms || "",
    expectedDeliveryDate: initial.expectedDeliveryDate ? new Date(initial.expectedDeliveryDate).toISOString().slice(0, 10) : "",
    remarks: initial.remarks || "",
    lines: (initial.lines && initial.lines.length ? initial.lines : [{ article: "", description: "", orderedQty: 1, unitPrice: 0, uom: "PCS", remarks: "" }]).map((x) => ({ ...x, orderedQty: Number(x.orderedQty ?? x.qty ?? 1), unitPrice: Number(x.unitPrice || 0) })),
  });
  function updateLine(i, key, val) {
    setForm((p) => ({ ...p, lines: p.lines.map((ln, idx) => (idx === i ? { ...ln, [key]: val } : ln)) }));
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(form); }} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Supplier"><SelectInput value={form.supplierId} onChange={(e) => {
          const id = e.target.value;
          const s = suppliers.find((x) => String(x._id) === id);
          setForm((p) => ({ ...p, supplierId: id, supplierName: s?.supplierName || s?.name || "" }));
        }}><option value="">Select supplier</option>{suppliers.map((s) => <option key={s._id} value={s._id}>{s.supplierCode} - {s.supplierName || s.name}</option>)}</SelectInput></FormField>
        <FormField label="Currency"><TextInput value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))} /></FormField>
        <FormField label="Exchange Rate"><TextInput type="number" value={form.exchangeRate} onChange={(e) => setForm((p) => ({ ...p, exchangeRate: Number(e.target.value) }))} /></FormField>
        <FormField label="Payment Terms"><TextInput value={form.paymentTerms} onChange={(e) => setForm((p) => ({ ...p, paymentTerms: e.target.value }))} /></FormField>
        <FormField label="Expected Delivery Date"><TextInput type="date" value={form.expectedDeliveryDate} onChange={(e) => setForm((p) => ({ ...p, expectedDeliveryDate: e.target.value }))} /></FormField>
        <FormField label="Remarks"><TextInput value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} /></FormField>
      </div>
      <div className="overflow-auto rounded-xl border">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-2 py-2 text-left">Article</th><th className="px-2 py-2 text-left">Description</th><th className="px-2 py-2 text-left">Ordered</th><th className="px-2 py-2 text-left">UOM</th><th className="px-2 py-2 text-left">Unit Price</th></tr></thead>
          <tbody>{form.lines.map((ln, i) => <tr key={i} className="border-t"><td className="px-2 py-2"><TextInput value={ln.article || ln.itemCode || ""} onChange={(e) => updateLine(i, "article", e.target.value)} /></td><td className="px-2 py-2"><TextInput value={ln.description || ""} onChange={(e) => updateLine(i, "description", e.target.value)} /></td><td className="px-2 py-2"><TextInput type="number" value={ln.orderedQty || 0} onChange={(e) => updateLine(i, "orderedQty", Number(e.target.value))} /></td><td className="px-2 py-2"><TextInput value={ln.uom || "PCS"} onChange={(e) => updateLine(i, "uom", e.target.value)} /></td><td className="px-2 py-2"><TextInput type="number" value={ln.unitPrice || 0} onChange={(e) => updateLine(i, "unitPrice", Number(e.target.value))} /></td></tr>)}</tbody>
        </table>
      </div>
      <div className="flex justify-between"><button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => setForm((p) => ({ ...p, lines: [...p.lines, { article: "", description: "", orderedQty: 1, unitPrice: 0, uom: "PCS" }] }))}>Add Line</button><button disabled={saving} className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">{saving ? "Saving..." : "Save PO"}</button></div>
    </form>
  );
}

export default function ProcurementFoundation() {
  const [tab, setTab] = useState("suppliers");
  return (
    <div className="space-y-4">
      <PageHeader title="Procurement Foundation" subtitle="Phase-11.1 Supplier Master, PR and PO core architecture." />
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={tab === t.id ? "rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white" : "rounded-xl border px-3 py-2 text-sm font-semibold"}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "suppliers" && <SupplierMasterTab />}
      {tab === "requisitions" && <PurchaseRequisitionTab />}
      {tab === "orders" && <PurchaseOrderTab />}
    </div>
  );
}
