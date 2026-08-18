/** Frontend RBAC helpers for module nav / landing / Store operator UX. */

export function normalizeUserRole(role) {
  return String(role || "")
    .toLowerCase()
    .trim();
}

export function isStoreOperatorRole(role) {
  return normalizeUserRole(role) === "store_operator";
}

export function isFullAdminRole(role) {
  const r = normalizeUserRole(role);
  return r === "super_admin" || r === "company_admin" || r === "admin";
}

/** Post-login landing — Store operators go straight to Store. */
export function defaultHomePathForRole(role) {
  if (isStoreOperatorRole(role)) return "/store";
  return "/dashboard";
}

/**
 * Paths a STORE_OPERATOR may open in the SPA.
 * Profile + Store only; everything else redirects to /store.
 */
export function storeOperatorAllowedPath(pathname) {
  const p = String(pathname || "");
  if (p === "/store" || p.startsWith("/store/")) return true;
  if (p === "/profile" || p.startsWith("/profile/")) return true;
  return false;
}

export function canFromMatrix(matrix, moduleName, action) {
  const m = String(moduleName || "").toUpperCase();
  const a = String(action || "").toLowerCase();
  return Array.isArray(matrix?.[m]) && matrix[m].includes(a);
}

/** Store module tabs visible to STORE_OPERATOR. */
export const STORE_OPERATOR_TABS = Object.freeze([
  "GRN",
  "Incoming Shipments",
  "Label Queue",
  "Stock View",
  "Stock Ledger",
  "Packing",
]);

export function filterStoreTabsForRole(tabs, role) {
  if (!isStoreOperatorRole(role)) return tabs;
  return (tabs || []).filter((t) => STORE_OPERATOR_TABS.includes(t));
}
