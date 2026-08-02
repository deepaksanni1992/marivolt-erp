import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiGetWithQuery } from "../lib/api.js";

const TABS = [
  { id: "boe", label: "BOE Balance" },
  { id: "lot", label: "Lot Balance" },
  { id: "consumption", label: "Consumption" },
  { id: "trace", label: "Traceability" },
];

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function CustomsAllocationReports() {
  const { auth } = useAuth();
  const [tab, setTab] = useState("boe");
  const [search, setSearch] = useState("");
  const [article, setArticle] = useState("");
  const [boe, setBoe] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const companyId = auth?.company?.id;

  const boeQ = useQuery({
    queryKey: ["customs-report-boe", companyId, search, article],
    queryFn: () =>
      apiGetWithQuery("/customs/reports/boe-balance", {
        search: search || undefined,
        articleNumber: article || undefined,
      }),
    enabled: tab === "boe" && !!companyId,
  });

  const lotQ = useQuery({
    queryKey: ["customs-report-lot", companyId, search],
    queryFn: () =>
      apiGetWithQuery("/customs/reports/lot-balance", {
        search: search || undefined,
      }),
    enabled: tab === "lot" && !!companyId,
  });

  const consQ = useQuery({
    queryKey: ["customs-report-cons", companyId, article, dateFrom, dateTo],
    queryFn: () =>
      apiGetWithQuery("/customs/reports/consumption", {
        articleNumber: article || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      }),
    enabled: tab === "consumption" && !!companyId,
  });

  const traceQ = useQuery({
    queryKey: ["customs-report-trace", companyId, article, boe],
    queryFn: () =>
      apiGetWithQuery("/customs/reports/traceability", {
        articleNumber: article || undefined,
        boeNumber: boe || undefined,
      }),
    enabled: tab === "trace" && !!companyId && (!!article || !!boe),
  });

  const loading =
    (tab === "boe" && boeQ.isLoading) ||
    (tab === "lot" && lotQ.isLoading) ||
    (tab === "consumption" && consQ.isLoading) ||
    (tab === "trace" && traceQ.isLoading);

  const filters = useMemo(() => {
    if (tab === "trace") {
      return (
        <>
          <input
            className="rounded-xl border px-3 py-2 text-sm"
            placeholder="Article number"
            value={article}
            onChange={(e) => setArticle(e.target.value)}
          />
          <input
            className="rounded-xl border px-3 py-2 text-sm"
            placeholder="BOE number"
            value={boe}
            onChange={(e) => setBoe(e.target.value)}
          />
        </>
      );
    }
    if (tab === "consumption") {
      return (
        <>
          <input
            className="rounded-xl border px-3 py-2 text-sm"
            placeholder="Article"
            value={article}
            onChange={(e) => setArticle(e.target.value)}
          />
          <input
            type="date"
            className="rounded-xl border px-3 py-2 text-sm"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <input
            type="date"
            className="rounded-xl border px-3 py-2 text-sm"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </>
      );
    }
    return (
      <>
        <input
          className="rounded-xl border px-3 py-2 text-sm"
          placeholder={tab === "boe" ? "Search BOE / article…" : "Search lot / article / BOE…"}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {tab === "boe" ? (
          <input
            className="rounded-xl border px-3 py-2 text-sm"
            placeholder="Article filter"
            value={article}
            onChange={(e) => setArticle(e.target.value)}
          />
        ) : null}
      </>
    );
  }, [tab, search, article, boe, dateFrom, dateTo]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <PageHeader
        title="Customs Allocation Reports"
        subtitle="BOE balance, lot balance, consumption, and article ↔ BOE / BOE ↔ customer traceability."
      />

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rounded-xl px-3 py-1.5 text-sm ${
              tab === t.id ? "bg-gray-900 text-white" : "border bg-white hover:bg-gray-50"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">{filters}</div>

      {loading ? <p className="text-sm text-gray-500">Loading…</p> : null}

      {tab === "boe" && !boeQ.isLoading ? (
        <ReportTable
          columns={[
            { key: "boeNumber", header: "BOE" },
            { key: "boeDate", header: "BOE Date", render: (r) => fmtDate(r.boeDate) },
            { key: "articleCount", header: "Articles" },
            { key: "qtyImported", header: "Imported", render: (r) => fmtNum(r.qtyImported) },
            { key: "qtyAvailable", header: "Remaining", render: (r) => fmtNum(r.qtyAvailable) },
            { key: "qtyConsumed", header: "Consumed", render: (r) => fmtNum(r.qtyConsumed) },
            { key: "customsValueAED", header: "AED Remaining", render: (r) => fmtNum(r.customsValueAED) },
          ]}
          rows={boeQ.data?.items || []}
        />
      ) : null}

      {tab === "lot" && !lotQ.isLoading ? (
        <ReportTable
          columns={[
            { key: "customsLotRef", header: "Lot Ref" },
            { key: "articleNumber", header: "Article" },
            { key: "boeNumber", header: "BOE" },
            { key: "boeDate", header: "BOE Date", render: (r) => fmtDate(r.boeDate) },
            { key: "qtyAvailable", header: "Remaining", render: (r) => fmtNum(r.qtyAvailable) },
            { key: "qtyConsumed", header: "Consumed", render: (r) => fmtNum(r.qtyConsumed) },
            { key: "status", header: "Status" },
            { key: "hsCode", header: "HS" },
            { key: "countryOfOrigin", header: "COO" },
          ]}
          rows={lotQ.data?.items || []}
        />
      ) : null}

      {tab === "consumption" && !consQ.isLoading ? (
        <ReportTable
          columns={[
            { key: "movementDate", header: "Date", render: (r) => fmtDate(r.movementDate) },
            { key: "customsInvoiceNumber", header: "Customs Inv" },
            { key: "articleNumber", header: "Article" },
            { key: "boeNumber", header: "BOE" },
            { key: "qty", header: "Qty", render: (r) => fmtNum(r.qty) },
            { key: "supplierInvoiceNumber", header: "Supplier Inv" },
            { key: "hsCode", header: "HS" },
            { key: "countryOfOrigin", header: "COO" },
          ]}
          rows={consQ.data?.items || []}
        />
      ) : null}

      {tab === "trace" ? (
        <div className="space-y-4">
          {!article && !boe ? (
            <p className="text-sm text-gray-500">Enter an article and/or BOE number to trace.</p>
          ) : null}
          {article ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Article → BOE history ({article})</h3>
              <ReportTable
                columns={[
                  { key: "boeNumber", header: "BOE" },
                  { key: "boeDate", header: "BOE Date", render: (r) => fmtDate(r.boeDate) },
                  { key: "qtyImported", header: "Imported", render: (r) => fmtNum(r.qtyImported) },
                  { key: "qtyAvailable", header: "Remaining", render: (r) => fmtNum(r.qtyAvailable) },
                  { key: "qtyConsumed", header: "Consumed", render: (r) => fmtNum(r.qtyConsumed) },
                  { key: "grnNo", header: "GRN" },
                  { key: "customsLotRef", header: "Lot" },
                ]}
                rows={traceQ.data?.articleToBoe || []}
              />
            </div>
          ) : null}
          {boe ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold">BOE → Customer history ({boe})</h3>
              <ReportTable
                columns={[
                  { key: "customerName", header: "Customer" },
                  { key: "customsInvoiceNumber", header: "Customs Inv" },
                  { key: "salesInvoiceNumber", header: "Sales Inv" },
                  { key: "invoiceDate", header: "Date", render: (r) => fmtDate(r.invoiceDate) },
                  { key: "articleNumber", header: "Article" },
                  { key: "qty", header: "Qty", render: (r) => fmtNum(r.qty) },
                ]}
                rows={traceQ.data?.boeToCustomer || []}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReportTable({ columns, rows }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-100 text-xs uppercase tracking-wide text-gray-600">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-left">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!rows.length ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-gray-500">
                No rows
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={row._id || row.customsLotItemId || `${row.boeNumber}-${i}`} className="border-t">
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-xs">
                    {c.render ? c.render(row) : row[c.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
