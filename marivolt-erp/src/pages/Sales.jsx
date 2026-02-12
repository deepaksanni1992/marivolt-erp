import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { apiDelete, apiGet, apiPost } from "../lib/api.js";

export default function Sales() {
  const [activeSub, setActiveSub] = useState("Customer Master");
  const [customers, setCustomers] = useState([]);
  const [customerErr, setCustomerErr] = useState("");
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerForm, setCustomerForm] = useState({
    name: "",
    contactName: "",
    phone: "",
    email: "",
    address: "",
    paymentTerms: "CREDIT",
    notes: "",
  });

  const [items, setItems] = useState([]);
  const [quotationItems, setQuotationItems] = useState([
    { sku: "", description: "", uom: "", qty: 1, unitPrice: 0 },
  ]);
  const [quotationForm, setQuotationForm] = useState({
    customerId: "",
    customerName: "",
    paymentTerms: "CREDIT",
    notes: "",
  });
  const [salesErr, setSalesErr] = useState("");
  const [salesLoading, setSalesLoading] = useState(false);

  const [quotationList, setQuotationList] = useState([]);
  const [ocList, setOcList] = useState([]);
  const [piList, setPiList] = useState([]);
  const [ptgList, setPtgList] = useState([]);
  const [invoiceList, setInvoiceList] = useState([]);
  const [ciplList, setCiplList] = useState([]);
  const [itemFilters, setItemFilters] = useState({
    vertical: "",
    engine: "",
    model: "",
    config: "",
    article: "",
  });

  function downloadCsv(filename, rows) {
    const csv = rows
      .map((row) =>
        row
          .map((cell) =>
            `"${String(cell ?? "")
              .replace(/"/g, '""')
              .replace(/\r?\n/g, " ")}"`
          )
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function loadCustomers() {
    setCustomerErr("");
    setCustomerLoading(true);
    try {
      const data = await apiGet("/sales/customers");
      setCustomers(data);
    } catch (e) {
      setCustomerErr(e.message || "Failed to load customers");
    } finally {
      setCustomerLoading(false);
    }
  }

  async function loadItems() {
    try {
      const data = await apiGet("/items");
      setItems(data);
    } catch {
      // ignore
    }
  }

  async function loadDocs(type, setState) {
    setSalesErr("");
    setSalesLoading(true);
    try {
      const data = await apiGet(`/sales/docs?type=${type}`);
      setState(data);
    } catch (e) {
      setSalesErr(e.message || "Failed to load sales docs");
    } finally {
      setSalesLoading(false);
    }
  }

  useEffect(() => {
    loadCustomers();
    loadItems();
    loadDocs("QUOTATION", setQuotationList);
    loadDocs("ORDER_CONFIRMATION", setOcList);
    loadDocs("PROFORMA_INVOICE", setPiList);
    loadDocs("PTG", setPtgList);
    loadDocs("INVOICE", setInvoiceList);
    loadDocs("CIPL", setCiplList);
  }, []);

  function onCustomerChange(e) {
    const { name, value } = e.target;
    setCustomerForm((p) => ({ ...p, [name]: value }));
  }

  function applyCustomer(id) {
    const customer = customers.find((c) => c._id === id);
    if (!customer) {
      setQuotationForm((p) => ({
        ...p,
        customerId: "",
        customerName: "",
        paymentTerms: "CREDIT",
      }));
      return;
    }
    setQuotationForm((p) => ({
      ...p,
      customerId: customer._id,
      customerName: customer.name,
      paymentTerms: customer.paymentTerms || "CREDIT",
    }));
  }

  function onQuotationChange(e) {
    const { name, value } = e.target;
    setQuotationForm((p) => ({ ...p, [name]: value }));
  }

  function onQuotationItemChange(index, field, value) {
    setQuotationItems((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        if (field === "sku") {
          const item = items.find((it) => it.sku === value);
          return {
            ...row,
            sku: value,
            description: item?.name || row.description,
            uom: item?.uom || row.uom,
          };
        }
        return { ...row, [field]: value };
      })
    );
  }

  function addQuotationItem() {
    setQuotationItems((prev) => [
      ...prev,
      { sku: "", description: "", uom: "", qty: 1, unitPrice: 0 },
    ]);
  }

  function removeQuotationItem(index) {
    setQuotationItems((prev) => prev.filter((_, i) => i !== index));
  }

  const quotationTotals = useMemo(() => {
    const subTotal = quotationItems.reduce((sum, row) => {
      const qty = Number(row.qty) || 0;
      const rate = Number(row.unitPrice) || 0;
      return sum + qty * rate;
    }, 0);
    return { subTotal, grandTotal: subTotal };
  }, [quotationItems]);

  const filteredItemsForFilters = useMemo(() => {
    return items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (itemFilters.model && (it.model || "") !== itemFilters.model) {
        return false;
      }
      if (itemFilters.config && (it.config || "") !== itemFilters.config) {
        return false;
      }
      if (itemFilters.article && (it.article || "") !== itemFilters.article) {
        return false;
      }
      return true;
    });
  }, [items, itemFilters]);

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter(Boolean))).sort();
  }

  const verticalOptions = useMemo(
    () => uniqueSorted(items.map((it) => it.category)),
    [items]
  );

  const engineOptions = useMemo(() => {
    const base = itemFilters.vertical
      ? items.filter((it) => (it.category || "") === itemFilters.vertical)
      : items;
    return uniqueSorted(base.map((it) => it.engine));
  }, [items, itemFilters.vertical]);

  const modelOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      return true;
    });
    return uniqueSorted(base.map((it) => it.model));
  }, [items, itemFilters.vertical, itemFilters.engine]);

  const configOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (itemFilters.model && (it.model || "") !== itemFilters.model) {
        return false;
      }
      return true;
    });
    return uniqueSorted(base.map((it) => it.config));
  }, [items, itemFilters.vertical, itemFilters.engine, itemFilters.model]);

  const articleOptions = useMemo(() => {
    const base = items.filter((it) => {
      if (itemFilters.vertical && (it.category || "") !== itemFilters.vertical) {
        return false;
      }
      if (itemFilters.engine && (it.engine || "") !== itemFilters.engine) {
        return false;
      }
      if (itemFilters.model && (it.model || "") !== itemFilters.model) {
        return false;
      }
      if (itemFilters.config && (it.config || "") !== itemFilters.config) {
        return false;
      }
      return true;
    });
    return uniqueSorted(base.map((it) => it.article));
  }, [
    items,
    itemFilters.vertical,
    itemFilters.engine,
    itemFilters.model,
    itemFilters.config,
  ]);

  const filteredItemsForSku = useMemo(() => {
    if (
      !itemFilters.vertical &&
      !itemFilters.engine &&
      !itemFilters.model &&
      !itemFilters.config &&
      !itemFilters.article
    ) {
      return items;
    }
    return filteredItemsForFilters;
  }, [items, filteredItemsForFilters, itemFilters]);

  async function addCustomer(e) {
    e.preventDefault();
    setCustomerErr("");
    if (!customerForm.name.trim()) {
      setCustomerErr("Customer name is required.");
      return;
    }
    try {
      const created = await apiPost("/sales/customers", {
        ...customerForm,
        name: customerForm.name.trim(),
      });
      setCustomers((prev) => [created, ...prev]);
      setCustomerForm({
        name: "",
        contactName: "",
        phone: "",
        email: "",
        address: "",
        paymentTerms: "CREDIT",
        notes: "",
      });
    } catch (e2) {
      setCustomerErr(e2.message || "Failed to add customer");
    }
  }

  async function deleteCustomer(id) {
    const ok = confirm("Delete this customer?");
    if (!ok) return;
    setCustomerErr("");
    try {
      await apiDelete(`/sales/customers/${id}`);
      setCustomers((prev) => prev.filter((c) => c._id !== id));
    } catch (e) {
      setCustomerErr(e.message || "Failed to delete customer");
    }
  }

  async function createQuotation() {
    setSalesErr("");
    if (!quotationForm.customerName.trim()) {
      setSalesErr("Customer is required.");
      return;
    }
    if (!quotationItems.length) {
      setSalesErr("At least one item is required.");
      return;
    }
    const itemsPayload = quotationItems.map((row) => ({
      sku: row.sku || "",
      description: row.description || "",
      uom: row.uom || "",
      qty: Number(row.qty) || 0,
      unitPrice: Number(row.unitPrice) || 0,
    }));
    try {
      const created = await apiPost("/sales/quotation", {
        ...quotationForm,
        items: itemsPayload,
        subTotal: quotationTotals.subTotal,
        grandTotal: quotationTotals.grandTotal,
      });
      setQuotationList((prev) => [created, ...prev]);
      setQuotationItems([{ sku: "", description: "", uom: "", qty: 1, unitPrice: 0 }]);
      setQuotationForm((p) => ({ ...p, notes: "" }));
      alert("Quotation created ✅");
    } catch (e) {
      setSalesErr(e.message || "Failed to create quotation");
    }
  }

  async function convertDoc(doc, targetType) {
    setSalesErr("");
    try {
      const converted = await apiPost(`/sales/convert/${doc._id}`, {
        targetType,
      });
      if (targetType === "ORDER_CONFIRMATION") {
        setOcList((prev) => [converted, ...prev]);
      }
      if (targetType === "PROFORMA_INVOICE") {
        setPiList((prev) => [converted, ...prev]);
      }
      if (targetType === "PTG") {
        setPtgList((prev) => [converted, ...prev]);
      }
      if (targetType === "INVOICE") {
        setInvoiceList((prev) => [converted, ...prev]);
      }
      if (targetType === "CIPL") {
        setCiplList((prev) => [converted, ...prev]);
      }
      alert(`${targetType.replace(/_/g, " ")} created ✅`);
    } catch (e) {
      setSalesErr(e.message || "Failed to convert");
    }
  }

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.name, c.contactName, c.phone, c.email, c.address]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [customers, customerQuery]);

  function onItemFilterChange(field, value) {
    setItemFilters((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "vertical") {
        next.engine = "";
        next.model = "";
        next.config = "";
        next.article = "";
      } else if (field === "engine") {
        next.model = "";
        next.config = "";
        next.article = "";
      } else if (field === "model") {
        next.config = "";
        next.article = "";
      } else if (field === "config") {
        next.article = "";
      }
      return next;
    });
  }

  function exportQuotationItemsCsv() {
    const rows = [
      ["SKU", "Description", "UOM", "Qty", "Unit Price"],
      ...quotationItems.map((row) => [
        row.sku || "",
        row.description || "",
        row.uom || "",
        Number(row.qty) || 0,
        Number(row.unitPrice) || 0,
      ]),
    ];
    downloadCsv("quotation-items.csv", rows);
  }

  async function handleQuotationExcelImport(file) {
    if (!file) return;
    setSalesErr("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const normalized = rows.map((row) => {
        const entry = {};
        Object.entries(row).forEach(([k, v]) => {
          const key = String(k).toLowerCase().replace(/\s+/g, "");
          entry[key] = v;
        });
        return entry;
      });

      const itemsFromExcel = normalized.map((row) => {
        const rawSku =
          row.sku ||
          row.partno ||
          row.partnumber ||
          row.article ||
          row.articleno ||
          "";
        const matchedItem = items.find((it) => it.sku === String(rawSku || "").trim());
        const description =
          row.description ||
          row.itemname ||
          row.name ||
          matchedItem?.description ||
          matchedItem?.name ||
          "";
        const uom = row.uom || row.unit || matchedItem?.uom || "";
        const qty = row.qty || row.quantity || row.q || 1;
        const unitPrice = row.unitprice || row.rate || row.price || 0;

        return {
          sku: String(rawSku || "").trim(),
          description: String(description || "").trim(),
          uom: String(uom || "").trim(),
          qty: Number(qty) || 0,
          unitPrice: Number(unitPrice) || 0,
        };
      });

      const filtered = itemsFromExcel.filter(
        (row) => row.sku || row.description || row.qty
      );
      if (!filtered.length) {
        setSalesErr("Excel import has no valid quotation item rows.");
        return;
      }

      setQuotationItems(filtered);
    } catch (e) {
      setSalesErr(e.message || "Failed to import quotation Excel file.");
    }
  }

  function exportQuotationsCsv(options = { pendingOnly: false }) {
    const rows = [
      ["Doc No", "Date", "Customer", "Terms", "Total", "Status", "Notes"],
      ...quotationList
        .filter((doc) => {
          if (!options.pendingOnly) return true;
          const status = doc.status || "OPEN";
          return status === "OPEN";
        })
        .map((doc) => [
          doc.docNo || "",
          doc.createdAt
            ? new Date(doc.createdAt).toLocaleDateString()
            : "",
          doc.customerName || "",
          doc.paymentTerms || "",
          Number(doc.grandTotal || 0).toFixed(2),
          doc.status || "OPEN",
          doc.notes || "",
        ]),
    ];
    const filename = options.pendingOnly
      ? "pending-quotations.csv"
      : "quotations.csv";
    downloadCsv(filename, rows);
  }

  function exportCustomersCsv() {
    const rows = [
      [
        "Name",
        "Contact Name",
        "Phone",
        "Email",
        "Address",
        "Payment Terms",
        "Notes",
      ],
      ...filteredCustomers.map((c) => [
        c.name || "",
        c.contactName || "",
        c.phone || "",
        c.email || "",
        c.address || "",
        c.paymentTerms || "",
        c.notes || "",
      ]),
    ];
    downloadCsv("customers.csv", rows);
  }

  async function handleCustomerImport(file) {
    if (!file) return;
    setCustomerErr("");
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const normalized = rows.map((row) => {
        const entry = {};
        Object.entries(row).forEach(([k, v]) => {
          const key = String(k).toLowerCase().replace(/\s+/g, "");
          entry[key] = v;
        });
        return entry;
      });

      const customersFromExcel = normalized.map((row) => {
        const name =
          row.name || row.customer || row.customername || row.company || "";
        const contactName =
          row.contactname || row.contactperson || row.contact || "";
        const phone = row.phone || row.mobile || row.tel || "";
        const email = row.email || "";
        const address = row.address || "";
        const rawTerms = String(row.paymentterms || row.terms || "").toUpperCase();
        const paymentTerms = rawTerms.includes("ADV") ? "ADVANCE" : "CREDIT";
        const notes = row.notes || row.note || "";

        return {
          name: String(name || "").trim(),
          contactName: String(contactName || "").trim(),
          phone: String(phone || "").trim(),
          email: String(email || "").trim(),
          address: String(address || "").trim(),
          paymentTerms,
          notes: String(notes || "").trim(),
        };
      });

      const filtered = customersFromExcel.filter((row) => row.name);
      if (!filtered.length) {
        setCustomerErr("Excel import has no valid customer rows.");
        return;
      }

      const results = await Promise.allSettled(
        filtered.map((row) => apiPost("/sales/customers", row))
      );
      const created = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - created;
      if (failed) {
        setCustomerErr(
          `Imported ${created} customers. ${failed} failed (duplicates or invalid).`
        );
      } else {
        setCustomerErr(`Imported ${created} customers successfully.`);
      }
      await loadCustomers();
    } catch (e) {
      setCustomerErr(e.message || "Failed to import customers.");
    }
  }

  const subModules = [
    "Customer Master",
    "Quotation",
    "Order Confirmation",
    "Proforma Invoice",
    "PTG",
    "Invoice",
    "CIPL",
  ];

  function renderDocTable(rows, actions) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-600">
            <tr>
              <th className="py-2 pr-3">Doc No</th>
              <th className="py-2 pr-3">Customer</th>
              <th className="py-2 pr-3">Terms</th>
              <th className="py-2 pr-3">Total</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="py-6 text-gray-500" colSpan={6}>
                  No records.
                </td>
              </tr>
            ) : (
              rows.map((doc) => (
                <tr key={doc._id} className="border-b last:border-b-0">
                  <td className="py-2 pr-3 font-medium">{doc.docNo}</td>
                  <td className="py-2 pr-3">{doc.customerName}</td>
                  <td className="py-2 pr-3">{doc.paymentTerms || "-"}</td>
                  <td className="py-2 pr-3">
                    {Number(doc.grandTotal || 0).toFixed(2)}
                  </td>
                  <td className="py-2 pr-3">{doc.status || "OPEN"}</td>
                  <td className="py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {actions(doc)}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-white p-3">
        <div className="flex flex-wrap gap-2">
          {subModules.map((label) => (
            <button
              key={label}
              onClick={() => setActiveSub(label)}
              className={[
                "rounded-xl px-3 py-2 text-sm border",
                activeSub === label
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 hover:bg-gray-50",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {customerErr && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {customerErr}
        </div>
      )}
      {salesErr && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {salesErr}
        </div>
      )}

      {activeSub === "Customer Master" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border bg-white p-6">
            <h3 className="text-base font-semibold">Add Customer</h3>
            <form onSubmit={addCustomer} className="mt-4 space-y-3">
              <div>
                <label className="text-sm text-gray-600">Name *</label>
                <input
                  name="name"
                  value={customerForm.name}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Contact Name</label>
                <input
                  name="contactName"
                  value={customerForm.contactName}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Phone</label>
                <input
                  name="phone"
                  value={customerForm.phone}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Email</label>
                <input
                  name="email"
                  value={customerForm.email}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Address</label>
                <input
                  name="address"
                  value={customerForm.address}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Payment Terms</label>
                <select
                  name="paymentTerms"
                  value={customerForm.paymentTerms}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                >
                  <option value="CREDIT">Credit</option>
                  <option value="ADVANCE">Advance</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-gray-600">Notes</label>
                <input
                  name="notes"
                  value={customerForm.notes}
                  onChange={onCustomerChange}
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                />
              </div>
              <button className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white">
                + Add Customer
              </button>
            </form>
          </div>

          <div className="rounded-2xl border bg-white p-6 lg:col-span-2">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h3 className="text-base font-semibold">Customers</h3>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <div className="flex gap-2">
                  <input
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    className="w-full md:w-80 rounded-xl border px-3 py-2 text-sm"
                    placeholder="Search customers..."
                  />
                  <button
                    onClick={loadCustomers}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Refresh
                  </button>
                </div>
                <div className="flex gap-2 md:ml-2">
                  <button
                    onClick={exportCustomersCsv}
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Export
                  </button>
                  <label className="inline-flex cursor-pointer items-center rounded-xl border px-3 py-2 text-sm hover:bg-gray-50">
                    <span>Import Excel</span>
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(e) => handleCustomerImport(e.target.files?.[0])}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            </div>
            <div className="mt-4">
              {customerLoading ? (
                <div className="text-sm text-gray-600">Loading...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-gray-600">
                      <tr>
                        <th className="py-2 pr-3">Name</th>
                        <th className="py-2 pr-3">Contact</th>
                        <th className="py-2 pr-3">Phone</th>
                        <th className="py-2 pr-3">Email</th>
                        <th className="py-2 pr-3">Terms</th>
                        <th className="py-2 pr-3">Address</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCustomers.length === 0 ? (
                        <tr>
                          <td className="py-6 text-gray-500" colSpan={7}>
                            No customers yet.
                          </td>
                        </tr>
                      ) : (
                        filteredCustomers.map((c) => (
                          <tr key={c._id} className="border-b last:border-b-0">
                            <td className="py-2 pr-3 font-medium">{c.name}</td>
                            <td className="py-2 pr-3">{c.contactName || "-"}</td>
                            <td className="py-2 pr-3">{c.phone || "-"}</td>
                            <td className="py-2 pr-3">{c.email || "-"}</td>
                            <td className="py-2 pr-3">{c.paymentTerms || "-"}</td>
                            <td className="py-2 pr-3">{c.address || "-"}</td>
                            <td className="py-2 text-right">
                              <button
                                onClick={() => deleteCustomer(c._id)}
                                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
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
              )}
            </div>
          </div>
        </div>
      )}

      {activeSub === "Quotation" && (
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Create Quotation</h2>
              <button
                onClick={() => loadDocs("QUOTATION", setQuotationList)}
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-1 space-y-3">
                <div>
                  <label className="text-sm text-gray-600">Customer</label>
                  <select
                    value={quotationForm.customerId}
                    onChange={(e) => applyCustomer(e.target.value)}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  >
                    <option value="">Select customer...</option>
                    {customers.map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.name} • {c.paymentTerms}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-600">Notes</label>
                  <textarea
                    name="notes"
                    value={quotationForm.notes}
                    onChange={onQuotationChange}
                    rows={3}
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                  />
                </div>
                <button
                  onClick={createQuotation}
                  className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  Save Quotation
                </button>
              </div>

              <div className="lg:col-span-2">
                <div className="mb-3 grid gap-2 md:grid-cols-5">
                  <div>
                    <label className="text-xs text-gray-600">Vertical</label>
                    <select
                      value={itemFilters.vertical}
                      onChange={(e) =>
                        onItemFilterChange("vertical", e.target.value)
                      }
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {verticalOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Engine</label>
                    <select
                      value={itemFilters.engine}
                      onChange={(e) => onItemFilterChange("engine", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {engineOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Model</label>
                    <select
                      value={itemFilters.model}
                      onChange={(e) => onItemFilterChange("model", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {modelOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Config</label>
                    <select
                      value={itemFilters.config}
                      onChange={(e) => onItemFilterChange("config", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {configOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-600">Article</label>
                    <select
                      value={itemFilters.article}
                      onChange={(e) => onItemFilterChange("article", e.target.value)}
                      className="mt-1 w-full rounded-lg border px-2 py-1 text-xs"
                    >
                      <option value="">All</option>
                      {articleOptions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">Items</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={addQuotationItem}
                      className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      + Add Line
                    </button>
                    <button
                      onClick={exportQuotationItemsCsv}
                      className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Export Items
                    </button>
                    <label className="inline-flex cursor-pointer items-center rounded-lg border px-3 py-1 text-xs hover:bg-gray-50">
                      <span>Import Excel</span>
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        onChange={(e) =>
                          handleQuotationExcelImport(e.target.files?.[0])
                        }
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b text-gray-600">
                      <tr>
                        <th className="py-2 pr-3">SKU</th>
                        <th className="py-2 pr-3">Description</th>
                        <th className="py-2 pr-3">UOM</th>
                        <th className="py-2 pr-3">Qty</th>
                        <th className="py-2 pr-3">Unit Price</th>
                        <th className="py-2 pr-3">Total</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotationItems.map((row, idx) => {
                        const qty = Number(row.qty) || 0;
                        const rate = Number(row.unitPrice) || 0;
                        return (
                          <tr key={idx} className="border-b last:border-b-0">
                            <td className="py-2 pr-3">
                              <select
                                value={row.sku}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "sku", e.target.value)
                                }
                                className="w-32 rounded-lg border px-2 py-1 text-xs"
                              >
                                <option value="">Select...</option>
                                {filteredItemsForSku.map((it) => (
                                  <option key={it._id} value={it.sku}>
                                    {it.sku}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                value={row.description}
                                onChange={(e) =>
                                  onQuotationItemChange(
                                    idx,
                                    "description",
                                    e.target.value
                                  )
                                }
                                className="w-40 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                value={row.uom}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "uom", e.target.value)
                                }
                                className="w-16 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                type="number"
                                min="0"
                                value={row.qty}
                                onChange={(e) =>
                                  onQuotationItemChange(idx, "qty", e.target.value)
                                }
                                className="w-20 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              <input
                                type="number"
                                min="0"
                                value={row.unitPrice}
                                onChange={(e) =>
                                  onQuotationItemChange(
                                    idx,
                                    "unitPrice",
                                    e.target.value
                                  )
                                }
                                className="w-24 rounded-lg border px-2 py-1 text-xs"
                              />
                            </td>
                            <td className="py-2 pr-3">
                              {(qty * rate).toFixed(2)}
                            </td>
                            <td className="py-2 text-right">
                              {quotationItems.length > 1 && (
                                <button
                                  onClick={() => removeQuotationItem(idx)}
                                  className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50"
                                >
                                  Remove
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-xs text-gray-600">
                  Sub Total: {quotationTotals.subTotal.toFixed(2)} • Grand Total:{" "}
                  {quotationTotals.grandTotal.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 space-y-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <h2 className="text-base font-semibold">Quotations</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => exportQuotationsCsv({ pendingOnly: false })}
                  className="rounded-xl border px-3 py-2 text-xs hover:bg-gray-50"
                >
                  Quotation Report
                </button>
                <button
                  onClick={() => exportQuotationsCsv({ pendingOnly: true })}
                  className="rounded-xl border px-3 py-2 text-xs hover:bg-gray-50"
                >
                  Pending Quotation Report
                </button>
              </div>
            </div>
            {renderDocTable(quotationList, (doc) => (
              <button
                onClick={() => convertDoc(doc, "ORDER_CONFIRMATION")}
                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
              >
                Order Confirmation
              </button>
            ))}
          </div>
        </div>
      )}

      {activeSub === "Order Confirmation" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Order Confirmations</h2>
            <button
              onClick={() => loadDocs("ORDER_CONFIRMATION", setOcList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ocList, (doc) =>
            doc.paymentTerms === "ADVANCE" ? (
              <button
                onClick={() => convertDoc(doc, "PROFORMA_INVOICE")}
                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
              >
                Proforma Invoice
              </button>
            ) : (
              <button
                onClick={() => convertDoc(doc, "PTG")}
                className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
              >
                Send to PTG
              </button>
            )
          )}
        </div>
      )}

      {activeSub === "Proforma Invoice" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Proforma Invoices</h2>
            <button
              onClick={() => loadDocs("PROFORMA_INVOICE", setPiList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(piList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "PTG")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Send to PTG
            </button>
          ))}
        </div>
      )}

      {activeSub === "PTG" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">PTG</h2>
            <button
              onClick={() => loadDocs("PTG", setPtgList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ptgList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "INVOICE")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Create Invoice
            </button>
          ))}
          <div className="text-xs text-gray-500">
            PTG packing dimensions are managed in Store → PTG.
          </div>
        </div>
      )}

      {activeSub === "Invoice" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Invoices</h2>
            <button
              onClick={() => loadDocs("INVOICE", setInvoiceList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(invoiceList, (doc) => (
            <button
              onClick={() => convertDoc(doc, "CIPL")}
              className="rounded-lg border px-3 py-1 text-xs hover:bg-gray-50"
            >
              Create CIPL
            </button>
          ))}
        </div>
      )}

      {activeSub === "CIPL" && (
        <div className="rounded-2xl border bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">CIPL</h2>
            <button
              onClick={() => loadDocs("CIPL", setCiplList)}
              className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
          {renderDocTable(ciplList, () => null)}
        </div>
      )}

      {salesLoading && (
        <div className="text-sm text-gray-500">Loading...</div>
      )}
    </div>
  );
}
