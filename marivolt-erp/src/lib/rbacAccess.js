/**
 * Single route / menu permission map for sidebar + SPA guards.
 * Checks use the effective permission matrix via `can(module, action)`,
 * not role-name allowlists (except Store Operator path lock, Price List
 * admin gate, and Settings live-admin-only).
 */
import {
  canFromMatrix,
  isFullAdminRole,
  isPriceListAdminRole,
  isStoreOperatorRole,
  storeOperatorAllowedPath,
} from "./rbac.js";

/** Actions the Role Form "All" control may grant per module. */
export const MODULE_ALLOWED_ACTIONS = Object.freeze({
  SALES: Object.freeze([
    "view",
    "create",
    "edit",
    "approve",
    "cancel",
    "export",
    "delete",
    "price_tier_sell",
    "price_tier_sell_ii",
    "price_tier_minm",
    "price_tier_rock",
  ]),
  STORE: Object.freeze(["view", "create", "edit", "approve", "cancel", "export", "delete", "post"]),
  ACCOUNTS: Object.freeze(["view", "create", "edit", "approve", "cancel", "export", "delete"]),
  LOGISTICS: Object.freeze(["view", "create", "edit", "approve", "cancel", "export"]),
  REPORTS: Object.freeze(["view", "create", "edit", "approve", "export", "delete"]),
  ITEM_MASTER: Object.freeze(["view", "create", "edit", "approve", "cancel", "export", "delete"]),
  PURCHASE: Object.freeze([
    "view",
    "create",
    "edit",
    "approve",
    "cancel",
    "export",
    "delete",
    "createFromAllocation",
  ]),
  SETTINGS: Object.freeze(["view", "create", "edit", "approve", "delete"]),
  AUDIT: Object.freeze(["view", "export"]),
  CUSTOMS: Object.freeze([
    "view",
    "create",
    "edit",
    "approve",
    "cancel",
    "export",
    "delete",
    "override",
    "reconcile",
    "reconciliation_view",
    "reconciliation_export",
  ]),
  TRACEABILITY: Object.freeze(["article_view", "article_export"]),
  LABELS: Object.freeze(["view", "create", "edit", "print", "reprint", "admin"]),
  ARTICLE_CONVERSION: Object.freeze(["view", "create", "post", "delete", "reverse", "approve", "admin"]),
  ASN: Object.freeze(["view", "create", "edit", "post", "cancel"]),
  PRICE_LIST: Object.freeze(["view", "create", "edit", "export", "delete"]),
});

export const DANGEROUS_ROLE_ACTIONS = Object.freeze(["delete", "admin", "override", "post", "reverse"]);

export const AUTHENTICATED_OPEN_PREFIXES = Object.freeze(["/profile"]);

/**
 * Longest-prefix-first rules. Keep in sync with App.jsx routes.
 * `module`/`action` are evaluated with the live `can()` helper.
 */
export const ROUTE_ACCESS_RULES = Object.freeze([
  { prefix: "/dashboard/data-health", module: "REPORTS", action: "view" },
  { prefix: "/dashboard/stock-bucket-integrity", module: "SETTINGS", action: "view", requireAdmin: true },
  { prefix: "/dashboard", module: "REPORTS", action: "view" },
  { prefix: "/customs/dashboard", module: "CUSTOMS", action: "view" },
  { prefix: "/customs", module: "CUSTOMS", action: "view" },
  { prefix: "/inventory/integrity/reservation", module: "SETTINGS", action: "view", requireAdmin: true },
  { prefix: "/inventory", module: "STORE", action: "view" },
  { prefix: "/items", module: "ITEM_MASTER", action: "view" },
  { prefix: "/price-list", module: "PRICE_LIST", action: "view", requirePriceListAdmin: true },
  { prefix: "/purchase", module: "PURCHASE", action: "view" },
  { prefix: "/asn", module: "ASN", action: "view" },
  { prefix: "/sales/man-rfq", module: "SALES", action: "create" },
  { prefix: "/sales", module: "SALES", action: "view" },
  { prefix: "/store", module: "STORE", action: "view" },
  {
    prefix: "/search",
    any: [
      ["REPORTS", "view"],
      ["SALES", "view"],
      ["PURCHASE", "view"],
      ["STORE", "view"],
      ["ACCOUNTS", "view"],
      ["CUSTOMS", "view"],
      ["ITEM_MASTER", "view"],
    ],
  },
  { prefix: "/traceability/article", module: "TRACEABILITY", action: "article_view" },
  { prefix: "/logistics", module: "LOGISTICS", action: "view" },
  { prefix: "/accounts", module: "ACCOUNTS", action: "view" },
  { prefix: "/documents", module: "REPORTS", action: "view" },
  { prefix: "/bom", module: "ITEM_MASTER", action: "view" },
  { prefix: "/kitting", module: "ITEM_MASTER", action: "view" },
  { prefix: "/dekitting", module: "ITEM_MASTER", action: "view" },
  { prefix: "/audit", module: "AUDIT", action: "view" },
  { prefix: "/settings", requireAdmin: true },
  { prefix: "/profile", allowAuthenticated: true },
]);

export const SIDEBAR_NAV = Object.freeze([
  {
    type: "group",
    id: "dashboard",
    label: "Dashboard",
    items: Object.freeze([
      { to: "/dashboard", label: "ERP BI Dashboard" },
      { to: "/customs/dashboard", label: "Customs Dashboard" },
      { to: "/dashboard/data-health", label: "Data Health Dashboard" },
      { to: "/dashboard/stock-bucket-integrity", label: "Stock Bucket Integrity" },
    ]),
  },
  {
    type: "group",
    id: "inventory",
    label: "Inventory",
    items: Object.freeze([
      { to: "/inventory", label: "Stock Balances" },
      { to: "/inventory/integrity/reservation", label: "Reservation Integrity" },
    ]),
  },
  {
    type: "group",
    id: "master",
    label: "Master data",
    items: Object.freeze([
      { to: "/items", label: "Item Master" },
      { to: "/price-list", label: "Price List" },
    ]),
  },
  {
    type: "group",
    id: "sales",
    label: "Sales",
    items: Object.freeze([
      { to: "/sales", label: "Quotations & OA" },
      { to: "/sales/man-rfq", label: "MAN RFQ / Quotation" },
    ]),
  },
  { type: "link", to: "/purchase", label: "Purchase" },
  { type: "link", to: "/asn", label: "ASN" },
  { type: "link", to: "/store", label: "Store" },
  { type: "link", to: "/logistics", label: "Logistics" },
  { type: "link", to: "/accounts", label: "Accounts" },
  {
    type: "group",
    id: "customs",
    label: "Customs",
    items: Object.freeze([
      { to: "/customs/stock", label: "Customs Stock" },
      { to: "/customs/ledger", label: "Customs Stock Ledger" },
      { to: "/customs/invoices", label: "Customs Invoice" },
      { to: "/customs/allocation-reports", label: "Customs Allocation Reports" },
      { to: "/customs/reconciliation", label: "Customs Reconciliation" },
    ]),
  },
  {
    type: "group",
    id: "documents",
    label: "Documents",
    items: Object.freeze([
      { to: "/documents", label: "Documents" },
      { to: "/traceability/article", label: "Article Traceability" },
    ]),
  },
  { type: "link", to: "/bom", label: "BOM" },
  { type: "link", to: "/kitting", label: "Kitting" },
  { type: "link", to: "/dekitting", label: "De-Kitting" },
  { type: "link", to: "/audit", label: "Audit Trail" },
  { type: "link", to: "/settings", label: "Settings" },
]);

export function allowedActionsForModule(moduleName) {
  const m = String(moduleName || "").toUpperCase();
  return MODULE_ALLOWED_ACTIONS[m] ? [...MODULE_ALLOWED_ACTIONS[m]] : [];
}

export function actionAllowedForModule(moduleName, action) {
  return allowedActionsForModule(moduleName).includes(String(action || "").toLowerCase());
}

export function selectedPermissionSummary(permissions) {
  return (permissions || [])
    .filter((p) => Array.isArray(p?.actions) && p.actions.length)
    .map((p) => `${p.module}: ${p.actions.join(", ")}`);
}

export function hasDangerousRoleActions(permissions) {
  const danger = new Set(DANGEROUS_ROLE_ACTIONS);
  return (permissions || []).some((p) => (p?.actions || []).some((a) => danger.has(String(a).toLowerCase())));
}

export function matchRouteAccessRule(pathname) {
  const p = String(pathname || "");
  if (!p || p === "/") return null;
  const ranked = [...ROUTE_ACCESS_RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  return ranked.find((rule) => p === rule.prefix || p.startsWith(`${rule.prefix}/`)) || null;
}

function ruleAllows(rule, { role, can }) {
  if (!rule) return false;
  if (rule.allowAuthenticated) return true;
  if (rule.requirePriceListAdmin && !isPriceListAdminRole(role)) return false;
  if (rule.requireAdmin && !isFullAdminRole(role)) return false;
  if (Array.isArray(rule.any) && rule.any.length) {
    return rule.any.some(([moduleName, action]) => can(moduleName, action));
  }
  if (rule.module) return can(rule.module, rule.action || "view");
  return Boolean(rule.requireAdmin || rule.requirePriceListAdmin);
}

/** Live matrix checks — never grant access before bootstrap succeeds. */
export function canPerform({ permissionsReady, permissionFailed, liveRole, matrix }, moduleName, action) {
  if (permissionFailed || !permissionsReady || matrix == null) return false;
  if (String(liveRole || "").toLowerCase().trim() === "super_admin") return true;
  return canFromMatrix(matrix, moduleName, action);
}

/**
 * @param {string} pathname
 * @param {{ role: string, can: Function, permissionsReady?: boolean }} ctx
 */
export function canAccessPath(pathname, ctx) {
  const role = ctx?.role;
  const can = typeof ctx?.can === "function" ? ctx.can : () => false;
  const p = String(pathname || "");
  if (!p || p === "/") return true;
  if (AUTHENTICATED_OPEN_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
    return true;
  }
  if (ctx?.permissionsReady === false) return false;
  if (ctx?.permissionFailed) return false;
  if (isStoreOperatorRole(role)) return storeOperatorAllowedPath(p);
  const rule = matchRouteAccessRule(p);
  if (!rule) return false;
  return ruleAllows(rule, { role, can });
}

export function filterSidebarNav(nav, ctx) {
  const items = Array.isArray(nav) ? nav : SIDEBAR_NAV;
  const out = [];
  for (const entry of items) {
    if (entry.type === "group") {
      const children = (entry.items || []).filter((item) => canAccessPath(item.to, ctx));
      if (!children.length) continue;
      out.push({ ...entry, items: children });
      continue;
    }
    if (canAccessPath(entry.to, ctx)) out.push(entry);
  }
  return out;
}

export function firstAuthorizedPath(ctx) {
  const role = ctx?.role;
  if (isStoreOperatorRole(role)) return "/store";
  for (const entry of SIDEBAR_NAV) {
    if (entry.type === "group") {
      for (const item of entry.items || []) {
        if (canAccessPath(item.to, ctx)) return item.to;
      }
      continue;
    }
    if (canAccessPath(entry.to, ctx)) return entry.to;
  }
  return "/profile";
}

export function pathAccessDenied(pathname, ctx) {
  return !canAccessPath(pathname, ctx);
}

/** Helper for tests: `can` bound to a static matrix. */
export function canFromStaticMatrix(matrix) {
  return (moduleName, action) => canFromMatrix(matrix, moduleName, action);
}
