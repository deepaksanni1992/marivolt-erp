export const PO_FROM_ALLOCATION_SESSION_KEY = "marivolt_po_from_allocation_v1";

export function savePoFromAllocationSession(payload) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(PO_FROM_ALLOCATION_SESSION_KEY, JSON.stringify(payload));
}

export function readPoFromAllocationSession() {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(PO_FROM_ALLOCATION_SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearPoFromAllocationSession() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(PO_FROM_ALLOCATION_SESSION_KEY);
}

export function userCanCreatePoFromAllocation(user) {
  const r = String(user?.role || "").toLowerCase().trim();
  return ["super_admin", "company_admin", "admin", "purchase", "purchase_sales", "sales"].includes(r);
}

export function poConversionStatusClass(status) {
  const s = String(status || "").toUpperCase();
  const map = {
    NOT_REQUIRED: "bg-slate-100 text-slate-700 ring-slate-200",
    NOT_CONVERTED: "bg-amber-50 text-amber-900 ring-amber-200",
    PARTIALLY_CONVERTED: "bg-sky-50 text-sky-900 ring-sky-200",
    FULLY_CONVERTED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PO_CREATED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PARTIALLY_RECEIVED: "bg-sky-50 text-sky-900 ring-sky-200",
    RECEIVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PO_CANCELLED: "bg-rose-50 text-rose-900 ring-rose-200",
  };
  return map[s] || map.NOT_CONVERTED;
}

export function allocationStockStatusClass(status) {
  const s = String(status || "").toUpperCase();
  const map = {
    FULLY_RESERVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    AVAILABLE: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PARTIALLY_RESERVED: "bg-amber-50 text-amber-900 ring-amber-200",
    PURCHASE_REQUIRED: "bg-rose-50 text-rose-900 ring-rose-200",
    PACKED: "bg-sky-50 text-sky-900 ring-sky-200",
    COMPLETED: "bg-zinc-100 text-zinc-800 ring-zinc-200",
  };
  return map[s] || "bg-zinc-50 text-zinc-700 ring-zinc-200";
}

export function allocationProcurementStatusClass(status) {
  const s = String(status || "").toUpperCase();
  const map = {
    NOT_REQUIRED: "bg-slate-100 text-slate-700 ring-slate-200",
    NOT_CONVERTED: "bg-amber-50 text-amber-900 ring-amber-200",
    PARTIALLY_CONVERTED: "bg-sky-50 text-sky-900 ring-sky-200",
    PO_CREATED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    PARTIALLY_RECEIVED: "bg-sky-50 text-sky-900 ring-sky-200",
    RECEIVED: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  };
  return map[s] || map.NOT_CONVERTED;
}

export function formatStatusLabel(status) {
  return String(status || "—")
    .replace(/_/g, " ")
    .trim();
}
