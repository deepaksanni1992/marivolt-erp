import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, TextInput, SelectInput } from "../components/erp/FormField.jsx";
import {
  API_BASE,
  apiDelete,
  apiGet,
  apiGetWithQuery,
  apiPost,
  apiPostFormData,
  isUsingSameOriginApiProxy,
} from "../lib/api.js";

/** Must match backend `DOCUMENT_TYPES` / S3 folder mapping. */
const DOCUMENT_TYPE_OPTIONS = [
  "Supplier Invoice",
  "Customer PO",
  "Purchase Order",
  "Sales Invoice",
  "Packing List",
  "Shipping Document",
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
  const [tab, setTab] = useState("communication");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [portalRef, setPortalRef] = useState("");
  const [tokenForm, setTokenForm] = useState({
    partyType: "CUSTOMER",
    partyName: "",
    partyEmail: "",
    portalReference: "",
    expiresAt: "",
  });
  const [messageForm, setMessageForm] = useState({
    direction: "INTERNAL_NOTE",
    channel: "SYSTEM",
    visibility: "INTERNAL",
    portalVisible: false,
    recipient: "",
    subject: "",
    message: "",
  });
  const [threadFilters, setThreadFilters] = useState({
    search: "",
    documentNo: "",
    party: "",
    status: "",
  });
  const [linkedDocDraft, setLinkedDocDraft] = useState({
    documentType: "QUOTATION",
    documentNo: "",
    documentId: "",
  });
  const [threadForm, setThreadForm] = useState({
    threadType: "CUSTOMER_COMMUNICATION",
    partyType: "CUSTOMER",
    partyName: "",
    partyEmail: "",
    relatedModule: "DOCUMENTS",
    subject: "",
    linkedDocuments: [],
  });

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
  const threadListQuery = useQuery({
    queryKey: ["communication-threads", page, threadFilters],
    queryFn: () =>
      apiGetWithQuery("/communication/threads", {
        page,
        limit: 10,
        search: threadFilters.search || undefined,
        documentNo: threadFilters.documentNo || undefined,
        party: threadFilters.party || undefined,
        status: threadFilters.status || undefined,
      }),
  });
  const threadDetailQuery = useQuery({
    queryKey: ["communication-thread-detail", selectedThreadId],
    queryFn: () => apiGet(`/communication/threads/${selectedThreadId}`),
    enabled: Boolean(selectedThreadId),
  });
  const approvalsQuery = useQuery({
    queryKey: ["communication-approvals", page],
    queryFn: () => apiGetWithQuery("/communication/approvals", { page, limit: 20 }),
  });
  const portalDocsQuery = useQuery({
    queryKey: ["portal-docs", portalRef],
    queryFn: () => apiGetWithQuery("/communication/portal/documents", { portalReference: portalRef }),
    enabled: Boolean(portalRef),
  });
  const activityQuery = useQuery({
    queryKey: ["communication-activity"],
    queryFn: () => apiGet("/communication/reports/activity"),
  });
  const portalLogQuery = useQuery({
    queryKey: ["portal-access-log"],
    queryFn: () => apiGet("/communication/reports/portal-access-log"),
  });

  const createThreadMutation = useMutation({
    mutationFn: () => apiPost("/communication/threads", threadForm),
    onSuccess: () => {
      toast("success", "Communication thread created.");
      setThreadForm((s) => ({ ...s, partyName: "", partyEmail: "", subject: "", linkedDocuments: [] }));
      qc.invalidateQueries({ queryKey: ["communication-threads"] });
    },
    onError: (e) => toast("error", e.message || "Could not create thread."),
  });
  const updateThreadStatusMutation = useMutation({
    mutationFn: ({ id, status }) => apiPost(`/communication/threads/${id}/status`, { status }),
    onSuccess: () => {
      toast("success", "Thread status updated.");
      qc.invalidateQueries({ queryKey: ["communication-thread-detail", selectedThreadId] });
      qc.invalidateQueries({ queryKey: ["communication-threads"] });
    },
    onError: (e) => toast("error", e.message || "Could not update thread status."),
  });
  const addMessageMutation = useMutation({
    mutationFn: () =>
      apiPost(`/communication/threads/${selectedThreadId}/messages`, {
        ...messageForm,
        portalVisible: messageForm.portalVisible,
      }),
    onSuccess: () => {
      toast("success", "Message posted.");
      setMessageForm((s) => ({ ...s, subject: "", message: "" }));
      qc.invalidateQueries({ queryKey: ["communication-thread-detail", selectedThreadId] });
      qc.invalidateQueries({ queryKey: ["communication-threads"] });
    },
    onError: (e) => toast("error", e.message || "Could not post message."),
  });
  const createApprovalMutation = useMutation({
    mutationFn: (body) => apiPost("/communication/approvals", body),
    onSuccess: () => {
      toast("success", "Approval request created.");
      qc.invalidateQueries({ queryKey: ["communication-approvals"] });
    },
    onError: (e) => toast("error", e.message || "Could not create approval."),
  });
  const decideApprovalMutation = useMutation({
    mutationFn: ({ id, status }) => apiPost(`/communication/approvals/${id}/decide`, { status }),
    onSuccess: () => {
      toast("success", "Approval updated.");
      qc.invalidateQueries({ queryKey: ["communication-approvals"] });
    },
    onError: (e) => toast("error", e.message || "Could not decide approval."),
  });
  const createPortalTokenMutation = useMutation({
    mutationFn: () => apiPost("/communication/portal/access-tokens", tokenForm),
    onSuccess: (r) => {
      toast("success", `Portal token created. Copy now: ${r.token}`);
      setTokenForm((s) => ({ ...s, partyName: "", partyEmail: "", portalReference: "", expiresAt: "" }));
    },
    onError: (e) => toast("error", e.message || "Could not create token."),
  });

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
      try {
        const path = inline ? `/documents/${id}/download?inline=1` : `/documents/${id}/download`;
        const data = await apiGet(path);
        if (!data?.url) {
          toast("error", "No download URL returned.");
          return;
        }
        // After async fetch, avoid `about:blank` + assign (leaves an empty tab if the API errors).
        // Programmatic <a target="_blank"> usually opens the S3 URL without a stuck blank tab.
        const a = document.createElement("a");
        a.href = data.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (e) {
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
            View/Download need non-empty{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_REGION</code> (or{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_DEFAULT_REGION</code>),{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_ACCESS_KEY_ID</code>,{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_SECRET_ACCESS_KEY</code>,{" "}
            <code className="rounded bg-amber-100/80 px-1">AWS_S3_BUCKET</code> in{" "}
            <code className="rounded bg-amber-100/80 px-1">marivolt-erp/backend/.env</code> (remove UTF-8 BOM if the file was edited in Notepad). API base:{" "}
            <code className="rounded bg-amber-100/80 px-1">{API_BASE}</code>
            {isUsingSameOriginApiProxy()
              ? " — UI uses the Vite proxy to your local API (port 5000); restart the backend after saving .env."
              : " — on Render, set the same four keys in Environment and redeploy."}
          </p>
          {s3StatusQuery.data?.awsEnvPresence ? (
            <p className="mt-2 text-xs text-amber-900/90">
              Detected on server (non-secret): region={String(s3StatusQuery.data.awsEnvPresence.hasRegion)}, accessKeyId=
              {String(s3StatusQuery.data.awsEnvPresence.hasAccessKeyId)}, secretKey=
              {String(s3StatusQuery.data.awsEnvPresence.hasSecretAccessKey)}, bucket=
              {String(s3StatusQuery.data.awsEnvPresence.hasBucket)}
            </p>
          ) : null}
        </div>
      ) : null}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="flex flex-wrap gap-2 rounded-2xl border border-gray-200 bg-white p-2">
        {[
          { id: "communication", label: "Communication Threads" },
          { id: "approvals", label: "Approvals" },
          { id: "portal", label: "Portal Docs" },
          { id: "uploaded", label: "Uploaded Docs" },
          { id: "activity", label: "Recent Activity" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={tab === t.id ? "rounded-lg bg-gray-900 px-3 py-2 text-sm text-white" : "rounded-lg px-3 py-2 text-sm hover:bg-gray-100"}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "communication" ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Communication threads (Phase-15 foundation)</h2>
        <p className="mt-1 text-xs text-gray-500">
          Prepare customer/supplier communication and portal-ready conversation context.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <TextInput placeholder="Thread search" value={threadFilters.search} onChange={(e) => setThreadFilters((s) => ({ ...s, search: e.target.value }))} />
          <TextInput placeholder="Document no filter" value={threadFilters.documentNo} onChange={(e) => setThreadFilters((s) => ({ ...s, documentNo: e.target.value }))} />
          <TextInput placeholder="Party filter" value={threadFilters.party} onChange={(e) => setThreadFilters((s) => ({ ...s, party: e.target.value }))} />
          <SelectInput value={threadFilters.status} onChange={(e) => setThreadFilters((s) => ({ ...s, status: e.target.value }))}>
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="WAITING_REPLY">Waiting reply</option>
            <option value="CLOSED">Closed</option>
          </SelectInput>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <FormField label="Type">
            <SelectInput value={threadForm.threadType} onChange={(e) => setThreadForm((s) => ({ ...s, threadType: e.target.value }))}>
              <option value="CUSTOMER_COMMUNICATION">Customer communication</option>
              <option value="SUPPLIER_COMMUNICATION">Supplier communication</option>
              <option value="DOCUMENT_APPROVAL">Document approval</option>
              <option value="INTERNAL_REVIEW">Internal review</option>
            </SelectInput>
          </FormField>
          <FormField label="Party type">
            <SelectInput value={threadForm.partyType} onChange={(e) => setThreadForm((s) => ({ ...s, partyType: e.target.value }))}>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="INTERNAL">Internal</option>
            </SelectInput>
          </FormField>
          <FormField label="Related module">
            <TextInput value={threadForm.relatedModule} onChange={(e) => setThreadForm((s) => ({ ...s, relatedModule: e.target.value }))} />
          </FormField>
          <FormField label="Party name">
            <TextInput value={threadForm.partyName} onChange={(e) => setThreadForm((s) => ({ ...s, partyName: e.target.value }))} />
          </FormField>
          <FormField label="Party email">
            <TextInput value={threadForm.partyEmail} onChange={(e) => setThreadForm((s) => ({ ...s, partyEmail: e.target.value }))} />
          </FormField>
          <FormField label="Subject">
            <TextInput value={threadForm.subject} onChange={(e) => setThreadForm((s) => ({ ...s, subject: e.target.value }))} />
          </FormField>
        </div>
        <div className="mt-3 rounded-xl border p-3">
          <p className="text-xs font-semibold text-gray-700">Link documents</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <SelectInput value={linkedDocDraft.documentType} onChange={(e) => setLinkedDocDraft((s) => ({ ...s, documentType: e.target.value }))}>
              <option value="QUOTATION">Quotation</option>
              <option value="SALES_INVOICE">Invoice</option>
              <option value="SHIPMENT">Shipment</option>
              <option value="PURCHASE_ORDER">PO</option>
              <option value="GRN">GRN</option>
              <option value="PAYMENT">Payment</option>
            </SelectInput>
            <TextInput placeholder="Document no" value={linkedDocDraft.documentNo} onChange={(e) => setLinkedDocDraft((s) => ({ ...s, documentNo: e.target.value }))} />
            <TextInput placeholder="Document id" value={linkedDocDraft.documentId} onChange={(e) => setLinkedDocDraft((s) => ({ ...s, documentId: e.target.value }))} />
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              onClick={() => {
                if (!linkedDocDraft.documentNo.trim() && !linkedDocDraft.documentId.trim()) return;
                setThreadForm((s) => ({ ...s, linkedDocuments: [...(s.linkedDocuments || []), { ...linkedDocDraft }] }));
                setLinkedDocDraft((s) => ({ ...s, documentNo: "", documentId: "" }));
              }}
            >
              + Add linked doc
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {(threadForm.linkedDocuments || []).map((d, idx) => (
              <span key={`${d.documentType}-${d.documentNo}-${idx}`} className="rounded bg-gray-100 px-2 py-1 text-[11px]">
                {d.documentType}: {d.documentNo || d.documentId}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <button
            type="button"
            className="rounded-xl border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            disabled={createThreadMutation.isPending}
            onClick={() => createThreadMutation.mutate()}
          >
            {createThreadMutation.isPending ? "Creating..." : "Create communication thread"}
          </button>
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-2 py-2 text-left">Thread No</th>
                <th className="px-2 py-2 text-left">Type</th>
                <th className="px-2 py-2 text-left">Party</th>
                <th className="px-2 py-2 text-left">Subject</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2 text-left">Portal Ready</th>
                <th className="px-2 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {(threadListQuery.data?.items || []).length === 0 ? (
                <tr><td colSpan={7} className="px-2 py-4 text-center text-gray-500">No communication threads yet.</td></tr>
              ) : (
                (threadListQuery.data?.items || []).map((r) => (
                  <tr key={r._id} className="border-t">
                    <td className="px-2 py-1 font-mono">{r.threadNo}</td>
                    <td className="px-2 py-1">{r.threadType}</td>
                    <td className="px-2 py-1">{r.partyName || r.partyEmail || "—"}</td>
                    <td className="px-2 py-1">{r.subject || "—"}</td>
                    <td className="px-2 py-1">
                      <span className={`rounded px-1.5 py-0.5 ${r.status === "OPEN" ? "bg-emerald-100 text-emerald-700" : r.status === "WAITING_REPLY" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"}`}>{r.status}</span>
                    </td>
                    <td className="px-2 py-1">{r.portalReady ? <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700">Portal-ready</span> : "No"}</td>
                    <td className="px-2 py-1">
                      <button type="button" className="rounded border px-2 py-0.5" onClick={() => setSelectedThreadId(r._id)}>Open</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      ) : null}

      {tab === "uploaded" ? (
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
      ) : null}

      {tab === "uploaded" ? (
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
      ) : null}

      {tab === "approvals" ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border px-3 py-2 text-xs"
              onClick={() =>
                createApprovalMutation.mutate({
                  linkedDocumentType: "SALES_INVOICE",
                  linkedDocumentId: "TEMP-LINK",
                  linkedDocumentNo: "TEMP-0001",
                  approver: "",
                  remarks: "Manual approval request",
                })
              }
            >
              + New Approval Request
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {["Approval No", "Document Type", "Document No", "Status", "Approver", "Date", "Action"].map((h) => <th key={h} className="px-2 py-2 text-left">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {(approvalsQuery.data?.items || []).length === 0 ? (
                  <tr><td colSpan={7} className="px-2 py-4 text-center text-gray-500">No approvals.</td></tr>
                ) : (
                  (approvalsQuery.data?.items || []).map((r) => (
                    <tr key={r._id} className="border-t">
                      <td className="px-2 py-1 font-mono">{r.approvalNo}</td>
                      <td className="px-2 py-1">{r.linkedDocumentType}</td>
                      <td className="px-2 py-1">{r.linkedDocumentNo || r.linkedDocumentId}</td>
                      <td className="px-2 py-1">
                        <span className={`rounded px-1.5 py-0.5 ${r.status === "APPROVED" ? "bg-emerald-100 text-emerald-700" : r.status === "REJECTED" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{r.status}</span>
                      </td>
                      <td className="px-2 py-1">{r.approver || "—"}</td>
                      <td className="px-2 py-1">{r.approvalDate ? new Date(r.approvalDate).toLocaleString() : "—"}</td>
                      <td className="px-2 py-1">
                        {r.status === "PENDING" ? (
                          <div className="flex gap-1">
                            <button type="button" className="rounded border px-2 py-0.5 text-[10px]" onClick={() => decideApprovalMutation.mutate({ id: r._id, status: "APPROVED" })}>Approve</button>
                            <button type="button" className="rounded border px-2 py-0.5 text-[10px]" onClick={() => decideApprovalMutation.mutate({ id: r._id, status: "REJECTED" })}>Reject</button>
                          </div>
                        ) : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "portal" ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Portal tokenized access</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-5">
              <SelectInput value={tokenForm.partyType} onChange={(e) => setTokenForm((s) => ({ ...s, partyType: e.target.value }))}>
                <option value="CUSTOMER">Customer</option>
                <option value="SUPPLIER">Supplier</option>
              </SelectInput>
              <TextInput placeholder="Party name" value={tokenForm.partyName} onChange={(e) => setTokenForm((s) => ({ ...s, partyName: e.target.value }))} />
              <TextInput placeholder="Party email" value={tokenForm.partyEmail} onChange={(e) => setTokenForm((s) => ({ ...s, partyEmail: e.target.value }))} />
              <TextInput placeholder="Portal reference" value={tokenForm.portalReference} onChange={(e) => setTokenForm((s) => ({ ...s, portalReference: e.target.value }))} />
              <TextInput type="date" value={tokenForm.expiresAt} onChange={(e) => setTokenForm((s) => ({ ...s, expiresAt: e.target.value }))} />
            </div>
            <div className="mt-2">
              <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => createPortalTokenMutation.mutate()}>
                Create portal token
              </button>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Portal docs</h2>
            <div className="mt-3 flex gap-2">
              <TextInput placeholder="Portal reference" value={portalRef} onChange={(e) => setPortalRef(e.target.value)} />
              <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => portalDocsQuery.refetch()}>
                Load
              </button>
            </div>
            <div className="mt-3 text-xs text-gray-700">
              Threads: {(portalDocsQuery.data?.threads || []).length} · Messages: {(portalDocsQuery.data?.messages || []).length} · Attachments: {(portalDocsQuery.data?.attachments || []).length}
            </div>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">Portal access log</h2>
            <div className="mt-2 max-h-72 overflow-auto rounded border text-xs">
              {(portalLogQuery.data?.items || []).map((r) => (
                <div key={r._id} className="border-b p-2">
                  {new Date(r.createdAt).toLocaleString()} · {r.partyType} · {r.partyEmail} · {r.action} · {r.status}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">Recent communication activity</h2>
          <div className="mt-3 max-h-96 overflow-auto rounded border text-xs">
            {(activityQuery.data?.items || []).map((r) => (
              <div key={r._id} className="border-b p-2">
                {new Date(r.createdAt).toLocaleString()} · Thread {String(r.threadId)} · {r.direction} · {r.visibility} · {r.sender || r.createdBy}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Modal
        open={Boolean(selectedThreadId)}
        onClose={() => setSelectedThreadId("")}
        title={`Thread drilldown ${threadDetailQuery.data?.threadNo || ""}`}
        wide
      >
        {!threadDetailQuery.data ? (
          <div className="text-sm text-gray-500">Loading thread...</div>
        ) : (
          <div className="space-y-3">
            <div className="rounded border p-2 text-xs">
              {threadDetailQuery.data.partyType} · {threadDetailQuery.data.partyName || threadDetailQuery.data.partyEmail || "—"} ·
              <span className={`ml-1 rounded px-1.5 py-0.5 ${threadDetailQuery.data.portalReady ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-700"}`}>
                {threadDetailQuery.data.portalReady ? "Portal-ready" : "Internal only"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => updateThreadStatusMutation.mutate({ id: selectedThreadId, status: "WAITING_REPLY" })}>
                Mark waiting reply
              </button>
              <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => updateThreadStatusMutation.mutate({ id: selectedThreadId, status: "CLOSED" })}>
                Close thread
              </button>
              <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => updateThreadStatusMutation.mutate({ id: selectedThreadId, status: "OPEN" })}>
                Reopen thread
              </button>
            </div>
            <div className="max-h-72 overflow-auto rounded border p-2 text-xs">
              {(threadDetailQuery.data.messages || []).length === 0 ? (
                <div className="text-gray-500">No messages yet.</div>
              ) : (
                (threadDetailQuery.data.messages || []).map((m) => (
                  <div key={m._id} className="mb-2 rounded border p-2">
                    <div className="mb-1 flex flex-wrap gap-2">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5">{m.direction}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5">{m.visibility}</span>
                      {m.portalVisible ? <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-700">Portal visible</span> : null}
                      <span className="text-gray-500">{m.sender || m.createdBy}</span>
                      <span className="text-gray-500">{m.createdAt ? new Date(m.createdAt).toLocaleString() : ""}</span>
                    </div>
                    <div className="text-gray-800">{m.message || m.body || "—"}</div>
                    {(m.attachments || []).length ? <div className="mt-1 text-gray-600">Attachments: {(m.attachments || []).map((a) => a.fileName || String(a.documentId)).join(", ")}</div> : null}
                  </div>
                ))
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <SelectInput value={messageForm.direction} onChange={(e) => setMessageForm((s) => ({ ...s, direction: e.target.value }))}>
                <option value="INTERNAL_NOTE">Internal note</option>
                <option value="OUTBOUND">Outbound</option>
                <option value="INBOUND">Inbound</option>
              </SelectInput>
              <SelectInput value={messageForm.channel} onChange={(e) => setMessageForm((s) => ({ ...s, channel: e.target.value }))}>
                <option value="SYSTEM">System</option>
                <option value="EMAIL">Email</option>
                <option value="PORTAL">Portal</option>
              </SelectInput>
              <SelectInput value={messageForm.visibility} onChange={(e) => setMessageForm((s) => ({ ...s, visibility: e.target.value }))}>
                <option value="INTERNAL">Internal only</option>
                <option value="CUSTOMER">Customer visible</option>
                <option value="SUPPLIER">Supplier visible</option>
              </SelectInput>
              <TextInput placeholder="Recipient" value={messageForm.recipient} onChange={(e) => setMessageForm((s) => ({ ...s, recipient: e.target.value }))} />
              <TextInput className="sm:col-span-2" placeholder="Subject" value={messageForm.subject} onChange={(e) => setMessageForm((s) => ({ ...s, subject: e.target.value }))} />
              <TextInput className="sm:col-span-2" placeholder="Message" value={messageForm.message} onChange={(e) => setMessageForm((s) => ({ ...s, message: e.target.value }))} />
              <label className="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" checked={messageForm.portalVisible} onChange={(e) => setMessageForm((s) => ({ ...s, portalVisible: e.target.checked }))} />
                Portal visible
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded border px-3 py-2 text-xs" onClick={() => addMessageMutation.mutate()}>
                Add message
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
