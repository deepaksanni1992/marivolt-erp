import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../context/AuthContext.jsx";
import { apiGet, apiPost } from "../../lib/api.js";

const ELIGIBLE = new Set(["ISSUED", "DISPATCHED", "PARTIALLY_PAID", "PAID"]);

function isAdminRole(role) {
  const r = String(role || "").toLowerCase();
  return ["super_admin", "admin", "company_admin"].includes(r);
}

function statusTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "POSTED") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (s === "DRAFT") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (s === "CANCELLED") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

export default function SalesCustomsInvoicePanel({ salesInvoice }) {
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { auth } = useAuth();
  const salesInvoiceId = salesInvoice?._id;
  const status = String(salesInvoice?.status || "").toUpperCase();
  const eligible = ELIGIBLE.has(status);
  const allowOverride = isAdminRole(auth?.user?.role);

  const customsStatusQ = useQuery({
    queryKey: ["customs-status", auth?.company?.id],
    queryFn: () => apiGet("/customs/status"),
    staleTime: 60_000,
  });

  const customsEnabled = customsStatusQ.data?.enabled !== false;

  const eligibilityQ = useQuery({
    queryKey: ["customs-invoice-eligibility", salesInvoiceId, auth?.company?.id],
    queryFn: () => apiGet(`/customs/invoices/by-sales-invoice/${salesInvoiceId}/eligibility`),
    enabled: !!salesInvoiceId && eligible && customsEnabled,
  });

  const customsInvoice = eligibilityQ.data?.customsInvoice || null;

  const createMutation = useMutation({
    mutationFn: () => apiPost(`/customs/invoices/from-sales-invoice/${salesInvoiceId}`, {}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["customs-invoice-eligibility", salesInvoiceId] });
      const id = data?.item?._id;
      if (id) nav(`/customs/invoices/${id}`);
    },
    onError: (err) => window.alert(err.message || "Failed to create customs invoice"),
  });

  const summary = useMemo(() => {
    if (!customsInvoice?.items?.length) return null;
    let lines = 0;
    let allocs = 0;
    for (const line of customsInvoice.items) {
      lines += 1;
      allocs += (line.allocations || []).length;
    }
    return { lines, allocs };
  }, [customsInvoice]);

  if (!customsEnabled || customsStatusQ.isLoading) return null;

  if (!eligible) {
    return (
      <div className="rounded-xl border border-dashed bg-slate-50 px-3 py-2 text-xs text-gray-600">
        Customs invoice is available after the sales invoice is issued (not draft or cancelled).
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-900">Customs Invoice</div>
          <div className="text-xs text-gray-500">Allocate exported qty from imported customs lots (FIFO).</div>
        </div>
        {customsInvoice ? (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusTone(customsInvoice.status)}`}
          >
            {customsInvoice.status}
          </span>
        ) : null}
      </div>

      {eligibilityQ.isLoading ? (
        <p className="mt-2 text-xs text-gray-500">Checking customs invoice…</p>
      ) : customsInvoice ? (
        <div className="mt-3 space-y-2 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <div className="text-xs text-gray-500">Customs Invoice No</div>
              <div className="font-mono text-xs">{customsInvoice.customsInvoiceNumber}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Lines / allocations</div>
              <div className="text-xs">
                {summary?.lines ?? 0} lines · {summary?.allocs ?? 0} BL splits
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Date</div>
              <div className="text-xs">
                {customsInvoice.invoiceDate
                  ? new Date(customsInvoice.invoiceDate).toLocaleDateString()
                  : "—"}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/customs/invoices/${customsInvoice._id}`}
              className="rounded-xl border px-2 py-1 text-xs hover:bg-gray-50"
            >
              {customsInvoice.status === "DRAFT" ? "Edit Customs Invoice" : "View Customs Invoice"}
            </Link>
          </div>
          {customsInvoice.status === "DRAFT" ? (
            <p className="text-xs text-amber-700">
              Draft — review FIFO allocations, adjust BL splits, then finalize to reduce customs stock.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "Creating…" : "Create Customs Invoice"}
          </button>
          {allowOverride ? (
            <span className="text-xs text-gray-500">Override available on detail page if stock is short.</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
