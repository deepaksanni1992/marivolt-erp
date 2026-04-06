import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PageHeader from "../components/erp/PageHeader.jsx";
import Modal from "../components/erp/Modal.jsx";
import { FormField, SelectInput, TextInput } from "../components/erp/FormField.jsx";
import { apiDelete, apiGetWithQuery, apiPost } from "../lib/api.js";

const tabs = [
  { id: "si", label: "Sales invoices" },
  { id: "pi", label: "Purchase invoices" },
  { id: "cust", label: "Customer ledger" },
  { id: "supp", label: "Supplier ledger" },
  { id: "cash", label: "Cash / bank" },
];

const invLine = () => ({
  itemCode: "",
  description: "",
  qty: 1,
  rate: 0,
});

export default function Accounts() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("si");
  const [page, setPage] = useState(1);
  const limit = 25;
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null);

  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");

  const [siForm, setSiForm] = useState({
    customerName: "",
    linkedQuotationNumber: "",
    currency: "USD",
    taxAmount: 0,
    paymentStatus: "UNPAID",
    remarks: "",
    lines: [invLine()],
  });
  const [piForm, setPiForm] = useState({
    supplierName: "",
    linkedPoNumber: "",
    currency: "USD",
    taxAmount: 0,
    paymentStatus: "UNPAID",
    remarks: "",
    lines: [invLine()],
  });
  const [custForm, setCustForm] = useState({
    customerName: "",
    referenceType: "",
    referenceNumber: "",
    debit: 0,
    credit: 0,
    narrative: "",
  });
  const [suppForm, setSuppForm] = useState({
    supplierName: "",
    referenceType: "",
    referenceNumber: "",
    debit: 0,
    credit: 0,
    narrative: "",
  });
  const [cashForm, setCashForm] = useState({
    accountName: "Cash",
    transactionType: "RECEIPT",
    referenceNumber: "",
    partyName: "",
    amount: 0,
    mode: "",
    remarks: "",
  });

  const siQ = useQuery({
    queryKey: ["salesInvoices", page],
    queryFn: () => apiGetWithQuery("/accounts/sales-invoices", { page, limit }),
    enabled: tab === "si",
  });
  const piQ = useQuery({
    queryKey: ["purchaseInvoices", page],
    queryFn: () => apiGetWithQuery("/accounts/purchase-invoices", { page, limit }),
    enabled: tab === "pi",
  });
  const custQ = useQuery({
    queryKey: ["customerLedger", filterCustomer, page],
    queryFn: () =>
      apiGetWithQuery("/accounts/customer-ledger", {
        customerName: filterCustomer.trim(),
        page,
        limit,
      }),
    enabled: tab === "cust" && filterCustomer.trim().length > 0,
  });
  const suppQ = useQuery({
    queryKey: ["supplierLedger", filterSupplier, page],
    queryFn: () =>
      apiGetWithQuery("/accounts/supplier-ledger", {
        supplierName: filterSupplier.trim(),
        page,
        limit,
      }),
    enabled: tab === "supp" && filterSupplier.trim().length > 0,
  });
  const cashQ = useQuery({
    queryKey: ["cashBank", page],
    queryFn: () => apiGetWithQuery("/accounts/cash-bank", { page, limit }),
    enabled: tab === "cash",
  });

  const postMut = useMutation({
    mutationFn: ({ path, body }) => apiPost(path, body),
    onSuccess: (_, v) => {
      if (v.path.includes("sales-invoices")) qc.invalidateQueries({ queryKey: ["salesInvoices"] });
      if (v.path.includes("purchase-invoices"))
        qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      if (v.path.includes("customer-ledger"))
        qc.invalidateQueries({ queryKey: ["customerLedger"] });
      if (v.path.includes("supplier-ledger"))
        qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      if (v.path.includes("cash-bank")) qc.invalidateQueries({ queryKey: ["cashBank"] });
      setModal(null);
      setErr("");
    },
    onError: (e) => setErr(e.message),
  });

  const delMut = useMutation({
    mutationFn: ({ path }) => apiDelete(path),
    onSuccess: (_, v) => {
      if (v.path.includes("sales-invoices")) qc.invalidateQueries({ queryKey: ["salesInvoices"] });
      if (v.path.includes("purchase-invoices"))
        qc.invalidateQueries({ queryKey: ["purchaseInvoices"] });
      if (v.path.includes("customer-ledger"))
        qc.invalidateQueries({ queryKey: ["customerLedger"] });
      if (v.path.includes("supplier-ledger"))
        qc.invalidateQueries({ queryKey: ["supplierLedger"] });
      if (v.path.includes("cash-bank")) qc.invalidateQueries({ queryKey: ["cashBank"] });
    },
  });

  function activeRows() {
    if (tab === "si") return siQ.data?.items ?? [];
    if (tab === "pi") return piQ.data?.items ?? [];
    if (tab === "cust") return custQ.data?.items ?? [];
    if (tab === "supp") return suppQ.data?.items ?? [];
    if (tab === "cash") return cashQ.data?.items ?? [];
    return [];
  }

  function activeTotal() {
    if (tab === "si") return siQ.data?.total ?? 0;
    if (tab === "pi") return piQ.data?.total ?? 0;
    if (tab === "cust") return custQ.data?.total ?? 0;
    if (tab === "supp") return suppQ.data?.total ?? 0;
    if (tab === "cash") return cashQ.data?.total ?? 0;
    return 0;
  }

  function loading() {
    if (tab === "si") return siQ.isLoading;
    if (tab === "pi") return piQ.isLoading;
    if (tab === "cust") return custQ.isLoading;
    if (tab === "supp") return suppQ.isLoading;
    if (tab === "cash") return cashQ.isLoading;
    return false;
  }

  const total = activeTotal();
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Invoices, AR/AP style ledgers, and cash or bank movements."
      />

      {err ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2 rounded-2xl border bg-white p-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setPage(1);
            }}
            className={[
              "rounded-xl px-3 py-2 text-sm font-medium",
              tab === t.id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(tab === "cust" || tab === "supp") && (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border bg-white p-4">
          {tab === "cust" ? (
            <FormField label="Customer name (exact)" className="min-w-[220px] flex-1">
              <TextInput
                value={filterCustomer}
                onChange={(e) => setFilterCustomer(e.target.value)}
                placeholder="Required to load ledger"
              />
            </FormField>
          ) : (
            <FormField label="Supplier name (exact)" className="min-w-[220px] flex-1">
              <TextInput
                value={filterSupplier}
                onChange={(e) => setFilterSupplier(e.target.value)}
                placeholder="Required to load ledger"
              />
            </FormField>
          )}
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
            onClick={() => {
              setPage(1);
              if (tab === "cust") qc.invalidateQueries({ queryKey: ["customerLedger"] });
              else qc.invalidateQueries({ queryKey: ["supplierLedger"] });
            }}
          >
            Load
          </button>
        </div>
      )}

      <div className="mb-3 flex justify-end">
        <button
          type="button"
          className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-semibold text-white"
          onClick={() => {
            setErr("");
            setModal(tab);
          }}
        >
          {tab === "si" && "New sales invoice"}
          {tab === "pi" && "New purchase invoice"}
          {tab === "cust" && "New customer entry"}
          {tab === "supp" && "New supplier entry"}
          {tab === "cash" && "New cash / bank entry"}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <div className="overflow-x-auto">
          {tab === "si" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.invoiceNumber}</td>
                      <td className="px-3 py-2">{r.customerName}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{r.paymentStatus}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.currency} {Number(r.totalAmount || 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete invoice?"))
                              delMut.mutate({ path: `/accounts/sales-invoices/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "pi" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Invoice</th>
                  <th className="px-3 py-2">Supplier</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No rows.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 font-mono text-xs">{r.invoiceNumber}</td>
                      <td className="px-3 py-2">{r.supplierName}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.invoiceDate ? new Date(r.invoiceDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{r.paymentStatus}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.currency} {Number(r.totalAmount || 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete invoice?"))
                              delMut.mutate({ path: `/accounts/purchase-invoices/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "cust" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {!filterCustomer.trim() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Enter a customer name and click Load.
                    </td>
                  </tr>
                ) : loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No entries.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-xs">
                        {r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.referenceNumber || r.narrative}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.debit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.credit}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {Number(r.runningBalance).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete entry?"))
                              delMut.mutate({ path: `/accounts/customer-ledger/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "supp" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2 text-right">Debit</th>
                  <th className="px-3 py-2 text-right">Credit</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {!filterSupplier.trim() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Enter a supplier name and click Load.
                    </td>
                  </tr>
                ) : loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No entries.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-xs">
                        {r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.referenceNumber || r.narrative}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.debit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.credit}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {Number(r.runningBalance).toFixed(2)}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete entry?"))
                              delMut.mutate({ path: `/accounts/supplier-ledger/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
          {tab === "cash" && (
            <table className="min-w-full text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs font-semibold text-gray-600">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Party</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 w-16" />
                </tr>
              </thead>
              <tbody>
                {loading() ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Loading…
                    </td>
                  </tr>
                ) : activeRows().length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      No entries.
                    </td>
                  </tr>
                ) : (
                  activeRows().map((r) => (
                    <tr key={r._id} className="border-b border-gray-100">
                      <td className="px-3 py-2 text-xs">
                        {r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2">{r.accountName}</td>
                      <td className="px-3 py-2">{r.transactionType}</td>
                      <td className="px-3 py-2 text-xs">{r.partyName}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.amount}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-xs text-red-600"
                          onClick={() => {
                            if (confirm("Delete entry?"))
                              delMut.mutate({ path: `/accounts/cash-bank/${r._id}` });
                          }}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
        {tab !== "cust" && tab !== "supp" ? (
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
        ) : filterCustomer.trim() || filterSupplier.trim() ? (
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
        ) : null}
      </div>

      {/* Modals */}
      <Modal open={modal === "si"} onClose={() => setModal(null)} title="Sales invoice" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer *">
            <TextInput
              value={siForm.customerName}
              onChange={(e) => setSiForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked quotation #">
            <TextInput
              value={siForm.linkedQuotationNumber}
              onChange={(e) =>
                setSiForm((f) => ({ ...f, linkedQuotationNumber: e.target.value }))
              }
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={siForm.currency}
              onChange={(e) => setSiForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Tax amount">
            <TextInput
              type="number"
              step="0.01"
              value={siForm.taxAmount}
              onChange={(e) =>
                setSiForm((f) => ({ ...f, taxAmount: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Payment status">
            <SelectInput
              value={siForm.paymentStatus}
              onChange={(e) => setSiForm((f) => ({ ...f, paymentStatus: e.target.value }))}
            >
              <option value="UNPAID">UNPAID</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="PAID">PAID</option>
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={siForm.remarks}
              onChange={(e) => setSiForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Lines</span>
            <button
              type="button"
              className="underline"
              onClick={() =>
                setSiForm((f) => ({ ...f, lines: [...f.lines, invLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {siForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-4">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.rate}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], rate: Number(e.target.value) };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Desc"
                value={line.description}
                onChange={(e) => {
                  const lines = [...siForm.lines];
                  lines[idx] = { ...lines[idx], description: e.target.value };
                  setSiForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/sales-invoices", body: siForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "pi"} onClose={() => setModal(null)} title="Purchase invoice" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              value={piForm.supplierName}
              onChange={(e) => setPiForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Linked PO #">
            <TextInput
              value={piForm.linkedPoNumber}
              onChange={(e) => setPiForm((f) => ({ ...f, linkedPoNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Currency">
            <TextInput
              value={piForm.currency}
              onChange={(e) => setPiForm((f) => ({ ...f, currency: e.target.value }))}
            />
          </FormField>
          <FormField label="Tax amount">
            <TextInput
              type="number"
              step="0.01"
              value={piForm.taxAmount}
              onChange={(e) =>
                setPiForm((f) => ({ ...f, taxAmount: Number(e.target.value) }))
              }
            />
          </FormField>
          <FormField label="Payment status">
            <SelectInput
              value={piForm.paymentStatus}
              onChange={(e) => setPiForm((f) => ({ ...f, paymentStatus: e.target.value }))}
            >
              <option value="UNPAID">UNPAID</option>
              <option value="PARTIAL">PARTIAL</option>
              <option value="PAID">PAID</option>
            </SelectInput>
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={piForm.remarks}
              onChange={(e) => setPiForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Lines</span>
            <button
              type="button"
              className="underline"
              onClick={() =>
                setPiForm((f) => ({ ...f, lines: [...f.lines, invLine()] }))
              }
            >
              + Line
            </button>
          </div>
          {piForm.lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-2 gap-2 rounded-lg border p-2 sm:grid-cols-4">
              <TextInput
                placeholder="Item"
                value={line.itemCode}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], itemCode: e.target.value };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                placeholder="Qty"
                value={line.qty}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], qty: Number(e.target.value) };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                type="number"
                step="0.01"
                placeholder="Rate"
                value={line.rate}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], rate: Number(e.target.value) };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
              <TextInput
                placeholder="Desc"
                value={line.description}
                onChange={(e) => {
                  const lines = [...piForm.lines];
                  lines[idx] = { ...lines[idx], description: e.target.value };
                  setPiForm((f) => ({ ...f, lines }));
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/purchase-invoices", body: piForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "cust"} onClose={() => setModal(null)} title="Customer ledger entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Customer *">
            <TextInput
              value={custForm.customerName}
              onChange={(e) => setCustForm((f) => ({ ...f, customerName: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference type">
            <TextInput
              value={custForm.referenceType}
              onChange={(e) => setCustForm((f) => ({ ...f, referenceType: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={custForm.referenceNumber}
              onChange={(e) => setCustForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Debit">
            <TextInput
              type="number"
              step="0.01"
              value={custForm.debit}
              onChange={(e) => setCustForm((f) => ({ ...f, debit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Credit">
            <TextInput
              type="number"
              step="0.01"
              value={custForm.credit}
              onChange={(e) => setCustForm((f) => ({ ...f, credit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Narrative" className="sm:col-span-2">
            <TextInput
              value={custForm.narrative}
              onChange={(e) => setCustForm((f) => ({ ...f, narrative: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/customer-ledger", body: custForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "supp"} onClose={() => setModal(null)} title="Supplier ledger entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Supplier *">
            <TextInput
              value={suppForm.supplierName}
              onChange={(e) => setSuppForm((f) => ({ ...f, supplierName: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference type">
            <TextInput
              value={suppForm.referenceType}
              onChange={(e) => setSuppForm((f) => ({ ...f, referenceType: e.target.value }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={suppForm.referenceNumber}
              onChange={(e) => setSuppForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Debit">
            <TextInput
              type="number"
              step="0.01"
              value={suppForm.debit}
              onChange={(e) => setSuppForm((f) => ({ ...f, debit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Credit">
            <TextInput
              type="number"
              step="0.01"
              value={suppForm.credit}
              onChange={(e) => setSuppForm((f) => ({ ...f, credit: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Narrative" className="sm:col-span-2">
            <TextInput
              value={suppForm.narrative}
              onChange={(e) => setSuppForm((f) => ({ ...f, narrative: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() =>
              postMut.mutate({ path: "/accounts/supplier-ledger", body: suppForm })
            }
          >
            Save
          </button>
        </div>
      </Modal>

      <Modal open={modal === "cash"} onClose={() => setModal(null)} title="Cash / bank entry" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Account *">
            <TextInput
              value={cashForm.accountName}
              onChange={(e) => setCashForm((f) => ({ ...f, accountName: e.target.value }))}
            />
          </FormField>
          <FormField label="Type *">
            <SelectInput
              value={cashForm.transactionType}
              onChange={(e) => setCashForm((f) => ({ ...f, transactionType: e.target.value }))}
            >
              <option value="RECEIPT">RECEIPT</option>
              <option value="PAYMENT">PAYMENT</option>
            </SelectInput>
          </FormField>
          <FormField label="Amount *">
            <TextInput
              type="number"
              step="0.01"
              value={cashForm.amount}
              onChange={(e) => setCashForm((f) => ({ ...f, amount: Number(e.target.value) }))}
            />
          </FormField>
          <FormField label="Reference #">
            <TextInput
              value={cashForm.referenceNumber}
              onChange={(e) => setCashForm((f) => ({ ...f, referenceNumber: e.target.value }))}
            />
          </FormField>
          <FormField label="Party">
            <TextInput
              value={cashForm.partyName}
              onChange={(e) => setCashForm((f) => ({ ...f, partyName: e.target.value }))}
            />
          </FormField>
          <FormField label="Mode">
            <TextInput
              value={cashForm.mode}
              onChange={(e) => setCashForm((f) => ({ ...f, mode: e.target.value }))}
              placeholder="NEFT, cash…"
            />
          </FormField>
          <FormField label="Remarks" className="sm:col-span-2">
            <TextInput
              value={cashForm.remarks}
              onChange={(e) => setCashForm((f) => ({ ...f, remarks: e.target.value }))}
            />
          </FormField>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            disabled={postMut.isPending}
            onClick={() => postMut.mutate({ path: "/accounts/cash-bank", body: cashForm })}
          >
            Save
          </button>
        </div>
      </Modal>
    </div>
  );
}
