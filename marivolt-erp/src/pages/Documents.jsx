import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { FormField, TextInput, SelectInput } from "../components/erp/FormField.jsx";
import { API_BASE, apiDelete, apiGet, apiGetWithQuery, apiPostFormData } from "../lib/api.js";

/** Must match backend `DOCUMENT_TYPES` / S3 folder mapping. */
const DOCUMENT_TYPE_OPTIONS = [
  "Supplier Invoice",
  "Customer PO",
  "Purchase Order",
  "Sales Invoice",
  "Packing List",
  "GRN Document",
  "Other",
];

function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg",
            t.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-900",
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-2">
            <span>{t.message}</span>
            <button
              type="button"
              className="shrink-0 rounded-lg px-1.5 text-xs text-gray-600 hover:bg-black/5"
              onClick={() => onDismiss(t.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Documents() {
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const limit = 20;

  const [downloadBusyId, setDownloadBusyId] = useState(null);

  const [form, setForm] = useState({
    documentType: DOCUMENT_TYPE_OPTIONS[0],
    refNo: "",
    partyName: "",
    moduleName: "",
    relatedId: "",
    remarks: "",
    file: null,
  });

  const [toasts, setToasts] = useState([]);
  const toast = useCallback((type, message) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const listQuery = useQuery({
    queryKey: ["documents", page, search],
    queryFn: () =>
      apiGetWithQuery("/documents", {
        page,
        limit,
        search: search.trim() || undefined,
      }),
  });

  const s3StatusQuery = useQuery({
    queryKey: ["documents-s3-status"],
    queryFn: () => apiGet("/documents/s3-status"),
    staleTime: 30_000,
  });

  const rows = listQuery.data?.rows || [];
  const total = listQuery.data?.total ?? 0;
  const pages = listQuery.data?.pages ?? 1;

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!form.file) throw new Error("Please choose a file to upload.");
      const fd = new FormData();
      fd.append("documentType", form.documentType);
      fd.append("refNo", form.refNo);
      fd.append("partyName", form.partyName);
      fd.append("moduleName", form.moduleName);
      fd.append("relatedId", form.relatedId);
      fd.append("remarks", form.remarks);
      fd.append("file", form.file);
      return apiPostFormData("/documents/upload", fd);
    },
    onSuccess: () => {
      toast("success", "Document uploaded successfully.");
      setForm((f) => ({
        ...f,
        refNo: "",
        partyName: "",
        moduleName: "",
        relatedId: "",
        remarks: "",
        file: null,
      }));
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["documents"] });
      setPage(1);
    },
    onError: (e) => {
      toast("error", e.message || "Upload failed.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => apiDelete(`/documents/${id}`),
    onSuccess: () => {
      toast("success", "Document deleted.");
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e) => {
      toast("error", e.message || "Delete failed.");
    },
  });

  const openSignedUrl = useCallback(
    async (id, inline) => {
      setDownloadBusyId(id);
      // Open a tab synchronously so popup blockers allow navigation after async fetch.
      const w = window.open("about:blank", "_blank", "noopener,noreferrer");
      try {
        const path = inline ? `/documents/${id}/download?inline=1` : `/documents/${id}/download`;
        const data = await apiGet(path);
        if (data?.url) {
          if (w) {
            w.opener = null;
            w.location.href = data.url;
          } else {
            window.open(data.url, "_blank", "noopener,noreferrer");
          }
        } else {
          w?.close();
          toast("error", "No download URL returned.");
        }
      } catch (e) {
        w?.close();
        toast("error", e.message || "Could not open file.");
      } finally {
        setDownloadBusyId(null);
      }
    },
    [toast],
  );

  const busy = uploadMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        subtitle="Upload and manage files in AWS S3. Metadata is stored in MongoDB; downloads use secure signed URLs."
      />

      {s3StatusQuery.isSuccess && s3StatusQuery.data?.s3Configured === false ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p className="font-semibold">S3 is not configured on this API server</p>
          <p className="mt-1 text-amber-900/90">
            View/Download need AWS credentials on the backend. In dev, requests go to{" "}
            <code className="rounded bg-amber-100/80 px-1">{API_BASE}</code> (see Vite proxy +{" "}
            <code className="rounded bg-amber-100/80 px-1">marivolt-erp/backend/.env</code>). On Render, set{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_REGION</code>,{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_ACCESS_KEY_ID</code>,{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_SECRET_ACCESS_KEY</code>,{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_S3_BUCKET</code> and redeploy.
          </p>
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Upload document</h2>
        <p className="mt-1 text-xs text-gray-500">
          Allowed: PDF, JPG, JPEG, PNG, XLS, XLSX, DOC, DOCX — max 10 MB. Field name must be{" "}
          <code className="rounded bg-gray-100 px-1">file</code>.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Document type">
            <SelectInput value={form.documentType} onChange={(e) => setForm((f) => ({ ...f, documentType: e.target.value }))}>
              {DOCUMENT_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </SelectInput>
          </FormField>
          <FormField label="Ref no">
            <TextInput value={form.refNo} onChange={(e) => setForm((f) => ({ ...f, refNo: e.target.value }))} />
          </FormField>
          <FormField label="Party name">
            <TextInput value={form.partyName} onChange={(e) => setForm((f) => ({ ...f, partyName: e.target.value }))} />
          </FormField>
          <FormField label="Module name">
            <TextInput value={form.moduleName} onChange={(e) => setForm((f) => ({ ...f, moduleName: e.target.value }))} />
          </FormField>
          <FormField label="Related ID">
            <TextInput value={form.relatedId} onChange={(e) => setForm((f) => ({ ...f, relatedId: e.target.value }))} />
          </FormField>
          <FormField label="Remarks">
            <TextInput value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} />
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <FormField label="File">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,.doc,.docx,application/pdf,image/*"
                className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border file:border-gray-300 file:bg-gray-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-100"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setForm((prev) => ({ ...prev, file: f }));
                }}
              />
            </FormField>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => uploadMutation.mutate()}
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-800 disabled:opacity-50"
          >
            {uploadMutation.isPending ? "Uploading…" : "Upload to S3"}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-gray-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Uploaded documents</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              placeholder="Search ref, party, file…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="min-w-[200px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900 sm:max-w-xs"
            />
            <button
              type="button"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50"
              onClick={() => listQuery.refetch()}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">
              <tr>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Ref no</th>
                <th className="px-4 py-3">Party</th>
                <th className="px-4 py-3">Module</th>
                <th className="px-4 py-3">File name</th>
                <th className="px-4 py-3 text-right">Size</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {listQuery.isLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No documents yet. Upload a file above.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r._id} className="hover:bg-gray-50/80">
                    <td className="px-4 py-3 text-gray-800">{r.documentType}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.refNo || "—"}</td>
                    <td className="max-w-[140px] truncate px-4 py-3 text-gray-700" title={r.partyName}>
                      {r.partyName || "—"}
                    </td>
                    <td className="max-w-[120px] truncate px-4 py-3 text-gray-600" title={r.moduleName}>
                      {r.moduleName || "—"}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-gray-800" title={r.originalFileName}>
                      {r.originalFileName}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-700">{formatBytes(r.size)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                      {r.uploadedAt ? new Date(r.uploadedAt).toLocaleString() : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        type="button"
                        className="mr-1 rounded-lg border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                        disabled={downloadBusyId === r._id}
                        onClick={() => openSignedUrl(r._id, true)}
                      >
                        {downloadBusyId === r._id ? "…" : "View"}
                      </button>
                      <button
                        type="button"
                        className="mr-1 rounded-lg border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                        disabled={downloadBusyId === r._id}
                        onClick={() => openSignedUrl(r._id, false)}
                      >
                        {downloadBusyId === r._id ? "…" : "Download"}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete “${r.originalFileName}” from S3 and database?`)) {
                            deleteMutation.mutate(r._id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3 text-sm text-gray-600">
          <span>
            Page {page} of {pages} · {total} document{total === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 disabled:opacity-40"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
