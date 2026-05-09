import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  apiGet,
  apiGetWithQuery,
  apiPost,
  apiPut,
  apiDelete,
  apiPatch,
} from "../lib/api.js";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";

const TABS = [
  { id: "companies", label: "Companies" },
  { id: "branches", label: "Branches" },
  { id: "warehouses", label: "Warehouses" },
  { id: "roles", label: "Roles & Permissions" },
  { id: "numbering", label: "Number Series" },
  { id: "approvals", label: "Approval Rules" },
  { id: "approvalQueue", label: "Approval Queue" },
  { id: "activity", label: "User Activity" },
];

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function badge(text, tone = "slate") {
  const palette = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-700",
    red: "bg-rose-100 text-rose-700",
    amber: "bg-amber-100 text-amber-700",
    sky: "bg-sky-100 text-sky-700",
    indigo: "bg-indigo-100 text-indigo-700",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette[tone] || palette.slate}`}
    >
      {text}
    </span>
  );
}

export default function Settings() {
  const [tab, setTab] = useState("companies");
  return (
    <div className="px-4 py-6">
      <PageHeader
        title="Settings"
        subtitle="Master data, roles & permissions, number series, approvals and user activity."
      />

      <div className="mb-4 flex flex-wrap gap-2 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              "rounded-t-xl px-3 py-2 text-sm font-medium",
              tab === t.id
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-700 hover:bg-slate-100",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "companies" && <CompaniesTab />}
      {tab === "branches" && <BranchesTab />}
      {tab === "warehouses" && <WarehousesTab />}
      {tab === "roles" && <RolesTab />}
      {tab === "numbering" && <NumberSeriesTab />}
      {tab === "approvals" && <ApprovalRulesTab />}
      {tab === "approvalQueue" && <ApprovalQueueTab />}
      {tab === "activity" && <ActivityTab />}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Companies                                                          */
/* ----------------------------------------------------------------- */

function CompaniesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["adminCompanies"],
    queryFn: () => apiGet("/admin/companies"),
  });
  const items = data?.items || [];

  const upsert = useMutation({
    mutationFn: (form) =>
      form._id
        ? apiPut(`/admin/companies/${form._id}`, form)
        : apiPost("/admin/companies", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminCompanies"] });
      setEditing(null);
    },
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">{items.length} companies</span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() => setEditing({ name: "", code: "", isActive: true })}
        >
          + New Company
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Country</Th>
              <Th>Currency</Th>
              <Th>TRN/VAT</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  No companies yet.
                </td>
              </tr>
            ) : (
              items.map((c) => (
                <tr key={c._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td className="font-medium">{c.code}</Td>
                  <Td>{c.name}</Td>
                  <Td>{c.country || "—"}</Td>
                  <Td>{c.defaultCurrency || c.currency || "USD"}</Td>
                  <Td>{c.trnNo || "—"}</Td>
                  <Td>{c.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-xs font-medium text-slate-700 underline"
                      onClick={() => setEditing(c)}
                    >
                      Edit
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Company" : "New Company"}
        wide
      >
        {editing ? (
          <CompanyForm
            initial={editing}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function CompanyForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    name: initial.name || "",
    shortName: initial.shortName || "",
    code: initial.code || "",
    address: initial.address || "",
    country: initial.country || "",
    email: initial.email || "",
    phone: initial.phone || "",
    trnNo: initial.trnNo || "",
    registrationNo: initial.registrationNo || "",
    currency: initial.currency || "USD",
    defaultCurrency: initial.defaultCurrency || initial.currency || "USD",
    timezone: initial.timezone || "",
    logoUrl: initial.logoUrl || "",
    isActive: initial.isActive !== false,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <FormField label="Code">
        <TextInput value={form.code} onChange={set("code")} required />
      </FormField>
      <FormField label="Name">
        <TextInput value={form.name} onChange={set("name")} required />
      </FormField>
      <FormField label="Short Name">
        <TextInput value={form.shortName} onChange={set("shortName")} />
      </FormField>
      <FormField label="Country">
        <TextInput value={form.country} onChange={set("country")} />
      </FormField>
      <FormField label="Default Currency">
        <TextInput value={form.defaultCurrency} onChange={set("defaultCurrency")} />
      </FormField>
      <FormField label="Timezone">
        <TextInput value={form.timezone} onChange={set("timezone")} placeholder="Asia/Dubai" />
      </FormField>
      <FormField label="TRN/VAT">
        <TextInput value={form.trnNo} onChange={set("trnNo")} />
      </FormField>
      <FormField label="Registration No">
        <TextInput value={form.registrationNo} onChange={set("registrationNo")} />
      </FormField>
      <FormField label="Email" className="sm:col-span-1">
        <TextInput value={form.email} onChange={set("email")} />
      </FormField>
      <FormField label="Phone" className="sm:col-span-1">
        <TextInput value={form.phone} onChange={set("phone")} />
      </FormField>
      <FormField label="Address" className="sm:col-span-2">
        <TextInput value={form.address} onChange={set("address")} />
      </FormField>
      <FormField label="Logo URL" className="sm:col-span-2">
        <TextInput value={form.logoUrl} onChange={set("logoUrl")} />
      </FormField>
      <FormField label="Status">
        <SelectInput
          value={form.isActive ? "active" : "inactive"}
          onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "active" }))}
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </FormField>

      {error ? (
        <div className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="sm:col-span-2 mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- */
/* Branches                                                           */
/* ----------------------------------------------------------------- */

function BranchesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["adminBranches"],
    queryFn: () => apiGet("/admin/branches"),
  });
  const items = data?.items || [];
  const upsert = useMutation({
    mutationFn: (form) =>
      form._id
        ? apiPut(`/admin/branches/${form._id}`, form)
        : apiPost("/admin/branches", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminBranches"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiDelete(`/admin/branches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminBranches"] }),
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">{items.length} branches</span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() => setEditing({ branchCode: "", branchName: "", isActive: true })}
        >
          + New Branch
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Country</Th>
              <Th>Warehouses</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No branches yet.
                </td>
              </tr>
            ) : (
              items.map((b) => (
                <tr key={b._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td className="font-medium">{b.branchCode}</Td>
                  <Td>{b.branchName}</Td>
                  <Td>{b.country || "—"}</Td>
                  <Td>{(b.warehouses || []).length}</Td>
                  <Td>{b.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    <button
                      type="button"
                      className="mr-2 text-xs font-medium text-slate-700 underline"
                      onClick={() => setEditing(b)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-rose-600 underline"
                      onClick={() => {
                        if (window.confirm(`Delete branch ${b.branchCode}?`)) {
                          remove.mutate(b._id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Branch" : "New Branch"}
        wide
      >
        {editing ? (
          <BranchForm
            initial={editing}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function BranchForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    branchCode: initial.branchCode || "",
    branchName: initial.branchName || "",
    address: initial.address || "",
    country: initial.country || "",
    phone: initial.phone || "",
    email: initial.email || "",
    trnNo: initial.trnNo || "",
    registrationNo: initial.registrationNo || "",
    isActive: initial.isActive !== false,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <FormField label="Branch Code">
        <TextInput value={form.branchCode} onChange={set("branchCode")} required />
      </FormField>
      <FormField label="Branch Name">
        <TextInput value={form.branchName} onChange={set("branchName")} required />
      </FormField>
      <FormField label="Country">
        <TextInput value={form.country} onChange={set("country")} />
      </FormField>
      <FormField label="Phone">
        <TextInput value={form.phone} onChange={set("phone")} />
      </FormField>
      <FormField label="Email">
        <TextInput value={form.email} onChange={set("email")} />
      </FormField>
      <FormField label="TRN">
        <TextInput value={form.trnNo} onChange={set("trnNo")} />
      </FormField>
      <FormField label="Address" className="sm:col-span-2">
        <TextInput value={form.address} onChange={set("address")} />
      </FormField>
      <FormField label="Status">
        <SelectInput
          value={form.isActive ? "active" : "inactive"}
          onChange={(e) =>
            setForm((f) => ({ ...f, isActive: e.target.value === "active" }))
          }
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </FormField>
      {error ? (
        <div className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}
      <div className="sm:col-span-2 mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- */
/* Warehouses                                                         */
/* ----------------------------------------------------------------- */

function WarehousesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data: branchesData } = useQuery({
    queryKey: ["adminBranches"],
    queryFn: () => apiGet("/admin/branches"),
  });
  const { data, isLoading } = useQuery({
    queryKey: ["adminWarehouses"],
    queryFn: () => apiGet("/admin/warehouses"),
  });
  const items = data?.items || [];
  const branches = branchesData?.items || [];

  const upsert = useMutation({
    mutationFn: (form) =>
      form._id
        ? apiPut(`/admin/warehouses/${form._id}`, form)
        : apiPost("/admin/warehouses", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminWarehouses"] });
      qc.invalidateQueries({ queryKey: ["adminBranches"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiDelete(`/admin/warehouses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminWarehouses"] }),
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">{items.length} warehouses</span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() =>
            setEditing({
              warehouseCode: "",
              warehouseName: "",
              warehouseType: "MAIN",
              isActive: true,
              branchId: "",
            })
          }
        >
          + New Warehouse
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Branch</Th>
              <Th>Type</Th>
              <Th>Default Location</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  No warehouses yet.
                </td>
              </tr>
            ) : (
              items.map((w) => (
                <tr key={w._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td className="font-medium">{w.warehouseCode}</Td>
                  <Td>{w.warehouseName}</Td>
                  <Td>{w.branchId?.branchCode || "—"}</Td>
                  <Td>{w.warehouseType}</Td>
                  <Td>{w.defaultLocation || "—"}</Td>
                  <Td>{w.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    <button
                      type="button"
                      className="mr-2 text-xs font-medium text-slate-700 underline"
                      onClick={() => setEditing({ ...w, branchId: w.branchId?._id || "" })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-rose-600 underline"
                      onClick={() => {
                        if (window.confirm(`Delete warehouse ${w.warehouseCode}?`)) {
                          remove.mutate(w._id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Warehouse" : "New Warehouse"}
        wide
      >
        {editing ? (
          <WarehouseForm
            initial={editing}
            branches={branches}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function WarehouseForm({ initial, branches, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    warehouseCode: initial.warehouseCode || "",
    warehouseName: initial.warehouseName || "",
    branchId: initial.branchId || "",
    defaultLocation: initial.defaultLocation || "",
    address: initial.address || "",
    country: initial.country || "",
    warehouseType: initial.warehouseType || "MAIN",
    isActive: initial.isActive !== false,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <FormField label="Warehouse Code">
        <TextInput value={form.warehouseCode} onChange={set("warehouseCode")} required />
      </FormField>
      <FormField label="Warehouse Name">
        <TextInput value={form.warehouseName} onChange={set("warehouseName")} required />
      </FormField>
      <FormField label="Branch">
        <SelectInput value={form.branchId} onChange={set("branchId")}>
          <option value="">—</option>
          {(branches || []).map((b) => (
            <option key={b._id} value={b._id}>
              {b.branchCode} — {b.branchName}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Type">
        <SelectInput value={form.warehouseType} onChange={set("warehouseType")}>
          {["MAIN", "BRANCH", "BONDED", "TRANSIT", "VIRTUAL", "OTHER"].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Default Location">
        <TextInput value={form.defaultLocation} onChange={set("defaultLocation")} />
      </FormField>
      <FormField label="Country">
        <TextInput value={form.country} onChange={set("country")} />
      </FormField>
      <FormField label="Address" className="sm:col-span-2">
        <TextInput value={form.address} onChange={set("address")} />
      </FormField>
      <FormField label="Status">
        <SelectInput
          value={form.isActive ? "active" : "inactive"}
          onChange={(e) =>
            setForm((f) => ({ ...f, isActive: e.target.value === "active" }))
          }
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </FormField>
      {error ? (
        <div className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}
      <div className="sm:col-span-2 mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- */
/* Roles & Permissions                                                */
/* ----------------------------------------------------------------- */

function RolesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["adminRoles"],
    queryFn: () => apiGet("/admin/roles"),
  });
  const items = data?.items || [];
  const modules = data?.modules || [];
  const actions = data?.actions || [];

  const upsert = useMutation({
    mutationFn: (form) =>
      form._id
        ? apiPut(`/admin/roles/${form._id}`, form)
        : apiPost("/admin/roles", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminRoles"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiDelete(`/admin/roles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminRoles"] }),
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">
          {items.length} roles ({items.filter((r) => r.isSystem).length} system)
        </span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() =>
            setEditing({
              code: "",
              name: "",
              description: "",
              isActive: true,
              permissions: modules.map((m) => ({ module: m, actions: [] })),
            })
          }
        >
          + New Role
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Modules</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td className="font-medium">{r.code}</Td>
                  <Td>{r.name}</Td>
                  <Td>{r.isSystem ? badge("System", "indigo") : badge("Custom", "slate")}</Td>
                  <Td>
                    {(r.permissions || [])
                      .filter((p) => p.actions?.length)
                      .map((p) => p.module)
                      .join(", ") || "—"}
                  </Td>
                  <Td>{r.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    {!r.isSystem && (
                      <>
                        <button
                          type="button"
                          className="mr-2 text-xs font-medium text-slate-700 underline"
                          onClick={() =>
                            setEditing({
                              ...r,
                              permissions: modules.map((m) => {
                                const found = (r.permissions || []).find(
                                  (p) => p.module === m
                                );
                                return { module: m, actions: found?.actions || [] };
                              }),
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-xs font-medium text-rose-600 underline"
                          onClick={() => {
                            if (window.confirm(`Delete role ${r.code}?`)) {
                              remove.mutate(r._id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Role" : "New Role"}
        xlarge
      >
        {editing ? (
          <RoleForm
            initial={editing}
            modules={modules}
            actions={actions}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function RoleForm({ initial, modules, actions, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    code: initial.code || "",
    name: initial.name || "",
    description: initial.description || "",
    isActive: initial.isActive !== false,
    permissions: initial.permissions || [],
  });
  function toggle(module, action) {
    setForm((f) => {
      const perms = f.permissions.map((p) => {
        if (p.module !== module) return p;
        const set = new Set(p.actions || []);
        if (set.has(action)) set.delete(action);
        else set.add(action);
        return { ...p, actions: Array.from(set) };
      });
      return { ...f, permissions: perms };
    });
  }
  function toggleRow(module, fill) {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.map((p) =>
        p.module === module ? { ...p, actions: fill ? [...actions] : [] } : p
      ),
    }));
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Code">
          <TextInput
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            required
          />
        </FormField>
        <FormField label="Name">
          <TextInput
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
          />
        </FormField>
        <FormField label="Status">
          <SelectInput
            value={form.isActive ? "active" : "inactive"}
            onChange={(e) =>
              setForm((f) => ({ ...f, isActive: e.target.value === "active" }))
            }
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </SelectInput>
        </FormField>
        <FormField label="Description" className="sm:col-span-3">
          <TextInput
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </FormField>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Module</Th>
              {actions.map((a) => (
                <Th key={a}>{a}</Th>
              ))}
              <Th>All</Th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => {
              const perm = form.permissions.find((p) => p.module === m);
              const enabled = new Set(perm?.actions || []);
              return (
                <tr key={m} className="border-t border-slate-100">
                  <Td className="font-medium">{m}</Td>
                  {actions.map((a) => (
                    <Td key={a}>
                      <input
                        type="checkbox"
                        checked={enabled.has(a)}
                        onChange={() => toggle(m, a)}
                      />
                    </Td>
                  ))}
                  <Td>
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => toggleRow(m, enabled.size !== actions.length)}
                    >
                      {enabled.size === actions.length ? "clear" : "all"}
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- */
/* Number Series                                                      */
/* ----------------------------------------------------------------- */

const DOC_KEYS = [
  "QUOTATION",
  "ORDER_ACK",
  "PROFORMA",
  "ORDER_ALLOCATION",
  "RTS",
  "SALES_INVOICE",
  "SALES_DISPATCH",
  "SALES_RETURN",
  "CIPL",
  "PAYMENT_RECEIPT",
  "GRN",
  "STOCK_ADJUSTMENT",
  "STOCK_TRANSFER",
];

function NumberSeriesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["adminNumberSeries"],
    queryFn: () => apiGet("/admin/number-series"),
  });
  const items = data?.items || [];
  const cycles = data?.resetCycles || ["NEVER", "DAILY", "MONTHLY", "YEARLY"];

  const upsert = useMutation({
    mutationFn: (form) => apiPost("/admin/number-series", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminNumberSeries"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiDelete(`/admin/number-series/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminNumberSeries"] }),
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">{items.length} configured series</span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() =>
            setEditing({
              docKey: "SALES_INVOICE",
              format: "{COMPANY}/{YYMMDD}.{SEQ}",
              padding: 4,
              startSeq: 1,
              resetCycle: "DAILY",
              isActive: true,
            })
          }
        >
          + New Series
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Doc Key</Th>
              <Th>Format</Th>
              <Th>Padding</Th>
              <Th>Reset</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No custom number series. Defaults are applied automatically.
                </td>
              </tr>
            ) : (
              items.map((s) => (
                <tr key={s._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td className="font-medium">{s.docKey}</Td>
                  <Td>
                    <code className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                      {[s.prefix || "", s.format, s.suffix || ""].join("")}
                    </code>
                  </Td>
                  <Td>{s.padding}</Td>
                  <Td>{s.resetCycle}</Td>
                  <Td>{s.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    <button
                      type="button"
                      className="mr-2 text-xs font-medium text-slate-700 underline"
                      onClick={() => setEditing(s)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-rose-600 underline"
                      onClick={() => {
                        if (window.confirm(`Delete number series for ${s.docKey}?`)) {
                          remove.mutate(s._id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Number Series" : "New Number Series"}
        wide
      >
        {editing ? (
          <NumberSeriesForm
            initial={editing}
            cycles={cycles}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function NumberSeriesForm({ initial, cycles, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    docKey: initial.docKey || "SALES_INVOICE",
    description: initial.description || "",
    prefix: initial.prefix || "",
    suffix: initial.suffix || "",
    format: initial.format || "{COMPANY}/{YYMMDD}.{SEQ}",
    padding: initial.padding ?? 4,
    startSeq: initial.startSeq ?? 1,
    resetCycle: initial.resetCycle || "DAILY",
    isActive: initial.isActive !== false,
    notes: initial.notes || "",
  });
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <FormField label="Document Key">
        <SelectInput value={form.docKey} onChange={set("docKey")}>
          {DOC_KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Reset Cycle">
        <SelectInput value={form.resetCycle} onChange={set("resetCycle")}>
          {cycles.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Format" className="sm:col-span-2">
        <TextInput value={form.format} onChange={set("format")} />
      </FormField>
      <FormField label="Prefix">
        <TextInput value={form.prefix} onChange={set("prefix")} />
      </FormField>
      <FormField label="Suffix">
        <TextInput value={form.suffix} onChange={set("suffix")} />
      </FormField>
      <FormField label="Padding">
        <TextInput type="number" value={form.padding} onChange={set("padding")} min="0" max="10" />
      </FormField>
      <FormField label="Start Sequence">
        <TextInput type="number" value={form.startSeq} onChange={set("startSeq")} min="0" />
      </FormField>
      <FormField label="Description" className="sm:col-span-2">
        <TextInput value={form.description} onChange={set("description")} />
      </FormField>
      <FormField label="Status">
        <SelectInput
          value={form.isActive ? "active" : "inactive"}
          onChange={(e) =>
            setForm((f) => ({ ...f, isActive: e.target.value === "active" }))
          }
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </FormField>
      <div className="sm:col-span-2 text-xs text-slate-500">
        Tokens: <code>{`{COMPANY}, {BRANCH}, {YYYY}, {YY}, {YYMMDD}, {YYYYMMDD}, {MM}, {DD}, {SEQ}`}</code>
      </div>
      {error ? (
        <div className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}
      <div className="sm:col-span-2 mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- */
/* Approval Rules + Queue                                             */
/* ----------------------------------------------------------------- */

const APPROVAL_MODULES = ["SALES", "ACCOUNTS", "STORE", "LOGISTICS", "PURCHASE"];
const APPROVAL_ACTIONS = [
  "invoice_post",
  "invoice_cancel",
  "payment_post",
  "payment_cancel",
  "adjustment_post",
  "dispatch_close",
  "po_approve",
];

function ApprovalRulesTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ["adminApprovalRules"],
    queryFn: () => apiGet("/admin/approval-rules"),
  });
  const items = data?.items || [];
  const upsert = useMutation({
    mutationFn: (form) =>
      form._id
        ? apiPut(`/admin/approval-rules/${form._id}`, form)
        : apiPost("/admin/approval-rules", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["adminApprovalRules"] });
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiDelete(`/admin/approval-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminApprovalRules"] }),
  });

  return (
    <div>
      <div className="mb-3 flex justify-between">
        <span className="text-sm text-slate-500">{items.length} approval rules</span>
        <button
          type="button"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          onClick={() =>
            setEditing({
              module: "SALES",
              actionKey: "invoice_post",
              minAmount: 0,
              currency: "USD",
              priority: 100,
              approverRoles: ["super_admin", "company_admin", "admin"],
              isActive: true,
            })
          }
        >
          + New Rule
        </button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Module</Th>
              <Th>Action</Th>
              <Th>Min Amount</Th>
              <Th>Currency</Th>
              <Th>Approver Roles</Th>
              <Th>Priority</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  No approval rules configured. Postings proceed without approval.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td>{r.module}</Td>
                  <Td>{r.actionKey}</Td>
                  <Td>{r.minAmount}</Td>
                  <Td>{r.currency}</Td>
                  <Td>{(r.approverRoles || []).join(", ") || "—"}</Td>
                  <Td>{r.priority}</Td>
                  <Td>{r.isActive ? badge("Active", "green") : badge("Inactive", "slate")}</Td>
                  <Td>
                    <button
                      type="button"
                      className="mr-2 text-xs font-medium text-slate-700 underline"
                      onClick={() => setEditing(r)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-rose-600 underline"
                      onClick={() => {
                        if (window.confirm("Delete rule?")) {
                          remove.mutate(r._id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? "Edit Approval Rule" : "New Approval Rule"}
        wide
      >
        {editing ? (
          <ApprovalRuleForm
            initial={editing}
            saving={upsert.isPending}
            error={upsert.error?.message}
            onCancel={() => setEditing(null)}
            onSave={(f) => upsert.mutate(f)}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function ApprovalRuleForm({ initial, onSave, onCancel, saving, error }) {
  const [form, setForm] = useState({
    _id: initial._id,
    module: initial.module || "SALES",
    actionKey: initial.actionKey || "invoice_post",
    description: initial.description || "",
    minAmount: initial.minAmount ?? 0,
    currency: initial.currency || "USD",
    priority: initial.priority ?? 100,
    approverRoles: (initial.approverRoles || []).join(", "),
    isActive: initial.isActive !== false,
  });
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "number" ? Number(e.target.value) : e.target.value,
    }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...form,
          approverRoles: form.approverRoles
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <FormField label="Module">
        <SelectInput value={form.module} onChange={set("module")}>
          {APPROVAL_MODULES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Action">
        <SelectInput value={form.actionKey} onChange={set("actionKey")}>
          {APPROVAL_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </SelectInput>
      </FormField>
      <FormField label="Min Amount">
        <TextInput type="number" value={form.minAmount} onChange={set("minAmount")} min="0" />
      </FormField>
      <FormField label="Currency">
        <TextInput value={form.currency} onChange={set("currency")} />
      </FormField>
      <FormField label="Priority">
        <TextInput type="number" value={form.priority} onChange={set("priority")} />
      </FormField>
      <FormField label="Status">
        <SelectInput
          value={form.isActive ? "active" : "inactive"}
          onChange={(e) =>
            setForm((f) => ({ ...f, isActive: e.target.value === "active" }))
          }
        >
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </SelectInput>
      </FormField>
      <FormField label="Approver Roles (comma-separated)" className="sm:col-span-2">
        <TextInput
          value={form.approverRoles}
          onChange={set("approverRoles")}
          placeholder="super_admin, company_admin, admin"
        />
      </FormField>
      <FormField label="Description" className="sm:col-span-2">
        <TextInput value={form.description} onChange={set("description")} />
      </FormField>
      {error ? (
        <div className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      ) : null}
      <div className="sm:col-span-2 mt-3 flex justify-end gap-2">
        <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

function ApprovalQueueTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const { data, isLoading } = useQuery({
    queryKey: ["adminApprovalQueue", statusFilter],
    queryFn: () => apiGetWithQuery("/admin/approval-requests", { status: statusFilter || undefined }),
  });
  const items = data?.items || [];
  const decide = useMutation({
    mutationFn: ({ id, decision, note }) =>
      apiPatch(`/admin/approval-requests/${id}/decide`, { decision, note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["adminApprovalQueue"] }),
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <FormField label="Status" className="w-44">
          <SelectInput value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </SelectInput>
        </FormField>
        <span className="text-sm text-slate-500">{items.length} requests</span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Date</Th>
              <Th>Module</Th>
              <Th>Action</Th>
              <Th>Document</Th>
              <Th>Customer</Th>
              <Th>Amount</Th>
              <Th>Requested By</Th>
              <Th>Status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  No matching requests.
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <Td>{fmtDate(r.createdAt)}</Td>
                  <Td>{r.module}</Td>
                  <Td>{r.actionKey}</Td>
                  <Td>{r.documentNo || "—"}</Td>
                  <Td>{r.customerName || "—"}</Td>
                  <Td>
                    {r.currency} {Number(r.amount || 0).toFixed(2)}
                  </Td>
                  <Td>{r.requestedByEmail || "—"}</Td>
                  <Td>
                    {r.status === "PENDING"
                      ? badge(r.status, "amber")
                      : r.status === "APPROVED"
                        ? badge(r.status, "green")
                        : r.status === "REJECTED"
                          ? badge(r.status, "red")
                          : badge(r.status, "slate")}
                  </Td>
                  <Td>
                    {r.status === "PENDING" && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs font-medium text-emerald-700 underline"
                          onClick={() => {
                            const note = window.prompt("Approve note (optional)") || "";
                            decide.mutate({ id: r._id, decision: "APPROVED", note });
                          }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="text-xs font-medium text-rose-700 underline"
                          onClick={() => {
                            const note = window.prompt("Reject reason") || "";
                            decide.mutate({ id: r._id, decision: "REJECTED", note });
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* User activity                                                      */
/* ----------------------------------------------------------------- */

function ActivityTab() {
  const [filters, setFilters] = useState({
    userEmail: "",
    action: "",
    fromDate: "",
    toDate: "",
  });
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["adminUserActivity", filters],
    queryFn: () => apiGetWithQuery("/admin/activity", filters),
  });
  const items = data?.items || [];
  const actions = data?.actions || [];

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
        <FormField label="User Email">
          <TextInput value={filters.userEmail} onChange={set("userEmail")} />
        </FormField>
        <FormField label="Action">
          <SelectInput value={filters.action} onChange={set("action")}>
            <option value="">All</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </SelectInput>
        </FormField>
        <FormField label="From">
          <TextInput type="date" value={filters.fromDate} onChange={set("fromDate")} />
        </FormField>
        <FormField label="To">
          <TextInput type="date" value={filters.toDate} onChange={set("toDate")} />
        </FormField>
        <div className="flex items-end">
          <button
            type="button"
            className="w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white"
            onClick={() => refetch()}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Date</Th>
              <Th>User</Th>
              <Th>Action</Th>
              <Th>Result</Th>
              <Th>IP</Th>
              <Th>Device</Th>
              <Th>Browser</Th>
              <Th>Description</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  Loading...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  No matching activity.
                </td>
              </tr>
            ) : (
              items.map((a) => (
                <tr key={a._id} className="border-t border-slate-100">
                  <Td>{fmtDate(a.createdAt)}</Td>
                  <Td>{a.userEmail || "—"}</Td>
                  <Td>{a.action}</Td>
                  <Td>
                    {a.success ? badge("OK", "green") : badge("FAIL", "red")}
                  </Td>
                  <Td>{a.ip || "—"}</Td>
                  <Td>{a.device || "—"}</Td>
                  <Td>
                    {a.browser || "—"} {a.os ? `/ ${a.os}` : ""}
                  </Td>
                  <Td className="max-w-[260px] truncate" title={a.description || ""}>
                    {a.description || "—"}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Helpers                                                            */
/* ----------------------------------------------------------------- */

function Th({ children }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </th>
  );
}

function Td({ children, className = "", ...rest }) {
  return (
    <td className={`px-3 py-2 align-middle ${className}`} {...rest}>
      {children}
    </td>
  );
}
