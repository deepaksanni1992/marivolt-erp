import mongoose from "mongoose";

/**
 * Role master — Phase-10.
 *
 * The legacy `User.role` enum (super_admin / company_admin / admin /
 * staff / purchase_sales / accounts_logistics) keeps working — those
 * codes are still recognised by `requireRole(...)` middleware and
 * receive sensible default permission sets through `roleService`.
 *
 * On top of that, this collection lets administrators define new
 * roles per company with a granular permission matrix. The matrix
 * uses a single boolean per (module, action) pair which keeps the
 * UI simple and matches the spec:
 *     module = SALES | STORE | ACCOUNTS | LOGISTICS | REPORTS |
 *              ITEM_MASTER | PURCHASE | SETTINGS | AUDIT | CUSTOMS | TRACEABILITY
 *     action = view | create | edit | approve | cancel | export | delete |
 *              override (Customs BOE Override) | reconcile | reconciliation_view | reconciliation_export |
 *              article_view | article_export
 */
export const PERMISSION_MODULES = [
  "SALES",
  "STORE",
  "ACCOUNTS",
  "LOGISTICS",
  "REPORTS",
  "ITEM_MASTER",
  "PURCHASE",
  "SETTINGS",
  "AUDIT",
  "CUSTOMS",
  "TRACEABILITY",
  "LABELS",
  "ARTICLE_CONVERSION",
  "ASN",
  "PRICE_LIST",
];

export const PERMISSION_ACTIONS = [
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
  "article_view",
  "article_export",
  "createFromAllocation",
  "print",
  "reprint",
  "admin",
  "post",
  "reverse",
  "price_tier_sell",
  "price_tier_sell_ii",
  "price_tier_minm",
  "price_tier_rock",
];

/**
 * Actions that may be assigned to a module. Role Form "All" and API
 * sanitisation must use this list — never the global PERMISSION_ACTIONS set.
 */
export const MODULE_ALLOWED_ACTIONS = {
  SALES: [
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
  ],
  STORE: ["view", "create", "edit", "approve", "cancel", "export", "delete", "post"],
  ACCOUNTS: ["view", "create", "edit", "approve", "cancel", "export", "delete"],
  LOGISTICS: ["view", "create", "edit", "approve", "cancel", "export"],
  REPORTS: ["view", "create", "edit", "approve", "export", "delete"],
  ITEM_MASTER: ["view", "create", "edit", "approve", "cancel", "export", "delete"],
  PURCHASE: [
    "view",
    "create",
    "edit",
    "approve",
    "cancel",
    "export",
    "delete",
    "createFromAllocation",
  ],
  SETTINGS: ["view", "create", "edit", "approve", "delete"],
  AUDIT: ["view", "export"],
  CUSTOMS: [
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
  ],
  TRACEABILITY: ["article_view", "article_export"],
  LABELS: ["view", "create", "edit", "print", "reprint", "admin"],
  ARTICLE_CONVERSION: ["view", "create", "post", "delete", "reverse", "approve", "admin"],
  ASN: ["view", "create", "edit", "post", "cancel"],
  PRICE_LIST: ["view", "create", "edit", "export", "delete"],
};

export function allowedActionsForModule(moduleName) {
  const m = String(moduleName || "").toUpperCase();
  return Array.isArray(MODULE_ALLOWED_ACTIONS[m]) ? [...MODULE_ALLOWED_ACTIONS[m]] : [];
}

export const SYSTEM_ROLE_CODES = [
  "SUPER_ADMIN",
  "ADMIN",
  "SALES",
  "PURCHASE",
  "STORE",
  "STORE_OPERATOR",
  "LOGISTICS",
  "ACCOUNTS",
  "VIEW_ONLY",
];

const permissionEntrySchema = new mongoose.Schema(
  {
    module: {
      type: String,
      enum: PERMISSION_MODULES,
      required: true,
    },
    actions: {
      type: [
        {
          type: String,
          enum: PERMISSION_ACTIONS,
        },
      ],
      default: [],
    },
  },
  { _id: false }
);

const roleSchema = new mongoose.Schema(
  {
    /** Null companyId means "system role available to every company". */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    isSystem: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
    permissions: { type: [permissionEntrySchema], default: [] },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

roleSchema.index({ companyId: 1, code: 1 }, { unique: true });
roleSchema.index({ isSystem: 1, code: 1 });

export default mongoose.model("Role", roleSchema);
