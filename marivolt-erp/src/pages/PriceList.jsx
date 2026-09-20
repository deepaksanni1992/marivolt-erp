import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDownload, apiGet, apiPost, apiPostFormData, apiPut } from "../lib/api.js";
import { notify } from "../lib/notifications.js";
import { useAuth } from "../context/AuthContext.jsx";
import { isPriceListAdminRole } from "../lib/rbac.js";
import LoadingButton from "../components/erp/LoadingButton.jsx";

function money(v) {
  if (v == null || v === "") return "—";
  return String(v);
}

export default function PriceList() {
  const { can, role } = useAuth();
  const allowed = isPriceListAdminRole(role) && can("PRICE_LIST", "view");
  const canEdit = can("PRICE_LIST", "edit");
  const canExport = can("PRICE_LIST", "export");
  const canCreate = can("PRICE_LIST", "create");
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [preview, setPreview] = useState(null);
  const [edit, setEdit] = useState(null);

  const list = useQuery({
    queryKey: ["man-price-list", q],
    queryFn: () => apiGet(`/price-list?q=${encodeURIComponent(q)}`),
    enabled: allowed,
  });

  const previewMut = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return apiPostFormData("/price-list/import/preview", fd);
    },
    onSuccess: (data) => {
      setPreview(data);
      notify.info("Preview ready — review before apply.");
    },
    onError: (e) => notify.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: (previewId) => apiPost("/price-list/import/apply", { previewId }),
    onSuccess: (data) => {
      notify.success(`Applied ${data.applied?.length || 0} articles`);
      setPreview(null);
      qc.invalidateQueries({ queryKey: ["man-price-list"] });
    },
    onError: (e) => notify.error(e.message),
  });

  const saveMut = useMutation({
    mutationFn: (row) => apiPut(`/price-list/${encodeURIComponent(row.article)}`, row),
    onSuccess: () => {
      notify.success("Price list saved");
      setEdit(null);
      qc.invalidateQueries({ queryKey: ["man-price-list"] });
    },
    onError: (e) => notify.error(e.message),
  });

  if (!allowed) {
    return (
      <div className="rounded-2xl border bg-white p-6 text-sm text-slate-600">
        Price List is available to Admin and Super Admin only.
      </div>
    );
  }

  const rows = list.data?.items || [];

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">MAN Price List</h1>
            <p className="text-sm text-slate-600">
              One current record per Article. Selling prices are uploaded independently — not derived from margins.
              Availability is live stock, never imported.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canExport ? (
              <>
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm"
                  onClick={() => apiDownload("/price-list/template", "man-price-list-template.csv")}
                >
                  Template CSV
                </button>
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm"
                  onClick={() => apiDownload("/price-list/export", "man-price-list.csv")}
                >
                  Export CSV
                </button>
              </>
            ) : null}
            {canCreate ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => e.target.files?.[0] && previewMut.mutate(e.target.files[0])}
                />
                <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={() => fileRef.current?.click()}>
                  Import CSV
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="mt-3">
          <input
            className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm"
            placeholder="Search article"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {preview ? (
        <div className="rounded-2xl border bg-white p-4">
          <h2 className="mb-2 font-semibold">Import preview</h2>
          <p className="mb-3 text-xs text-slate-600">{preview.availabilityNote}</p>
          {(preview.errors || []).length ? (
            <div className="mb-3 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
              {(preview.errors || []).map((e, i) => (
                <div key={i}>
                  Row {e.rowNumber}: {e.article} — {e.message}
                </div>
              ))}
            </div>
          ) : null}
          <div className="max-h-80 overflow-auto text-xs">
            <table className="min-w-full">
              <thead>
                <tr className="text-left">
                  <th className="p-1">Article</th>
                  <th className="p-1">Item changes</th>
                  <th className="p-1">Price changes</th>
                  <th className="p-1">Warnings</th>
                </tr>
              </thead>
              <tbody>
                {(preview.rows || []).map((r) => (
                  <tr key={`${r.rowNumber}-${r.article}`} className="border-t">
                    <td className="p-1 font-mono">{r.article || "—"}</td>
                    <td className="p-1">{JSON.stringify(r.itemChanges || {})}</td>
                    <td className="p-1">{JSON.stringify(r.priceChanges || {})}</td>
                    <td className="p-1">{(r.warnings || r.errors || []).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <LoadingButton
              disabled={!preview.canApply || !canEdit}
              loading={applyMut.isPending}
              onClick={() => applyMut.mutate(preview.previewId)}
            >
              Apply import
            </LoadingButton>
            <button type="button" className="rounded-xl border px-3 py-2 text-sm" onClick={() => setPreview(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-auto rounded-2xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              {["Article", "Description", "UOM", "SPN", "Engine Model", "Configuration", "Specs", "Sell", "Sell II", "Minm", "Rock", "Buy", "Next Buy", "Cur", "Lead", "Available Stock", ""].map(
                (h) => (
                  <th key={h} className="px-2 py-2">
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.article} className="border-t">
                <td className="px-2 py-1 font-mono">{row.article}</td>
                <td className="px-2 py-1">{row.description}</td>
                <td className="px-2 py-1">{row.uom}</td>
                <td className="px-2 py-1 font-mono">{row.spn}</td>
                <td className="px-2 py-1">{row.model || "—"}</td>
                <td className="px-2 py-1">{row.config || "—"}</td>
                <td className="px-2 py-1">{row.specs || "—"}</td>
                <td className="px-2 py-1">{money(row.sellPrice)}</td>
                <td className="px-2 py-1">{money(row.sellIi)}</td>
                <td className="px-2 py-1">{money(row.minm)}</td>
                <td className="px-2 py-1">{money(row.rock)}</td>
                <td className="px-2 py-1">{money(row.buy)}</td>
                <td className="px-2 py-1">{money(row.nextBuy)}</td>
                <td className="px-2 py-1">{row.currency}</td>
                <td className="px-2 py-1">{row.leadTime || "—"}</td>
                <td className="px-2 py-1">{row.availableQty}</td>
                <td className="px-2 py-1">
                  {canEdit ? (
                    <button type="button" className="text-xs font-semibold" onClick={() => setEdit({ ...row })}>
                      Edit
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit ? (
        <div className="fixed inset-0 z-40 bg-black/30">
          <div className="absolute right-0 top-0 h-full w-full max-w-lg overflow-auto bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-lg font-semibold">Edit {edit.article}</h2>
            <p className="mb-3 text-xs text-slate-500">Blank fields can be cleared here. CSV blanks never delete values.</p>
            {["sellPrice", "sellIi", "minm", "rock", "buy", "nextBuy", "currency", "leadTime"].map((key) => (
              <label key={key} className="mb-2 block text-sm">
                {key}
                <input
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={edit[key] ?? ""}
                  onChange={(e) => setEdit((v) => ({ ...v, [key]: e.target.value }))}
                />
              </label>
            ))}
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={edit.isActive !== false}
                onChange={(e) => setEdit((v) => ({ ...v, isActive: e.target.checked }))}
              />
              Active
            </label>
            <div className="flex gap-2">
              <LoadingButton loading={saveMut.isPending} onClick={() => saveMut.mutate(edit)}>
                Save
              </LoadingButton>
              <button type="button" className="rounded border px-3 py-2" onClick={() => setEdit(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-xs text-slate-500">
        Linked Item Master: <Link className="underline" to="/items">open Item Master</Link>
      </p>
    </div>
  );
}
