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
    PO_CANCELLED: "bg-rose-50 text-rose-900 ring-rose-200",
  };
  return map[s] || map.NOT_CONVERTED;
}
