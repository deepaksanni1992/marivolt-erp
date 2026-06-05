/**
 * Role / Permission service — Phase-10.
 *
 * Resolves the effective permission matrix for a request and exposes
 * helpers that controllers/middleware can call:
 *
 *   - getDefaultPermissionsForRole(roleCode)
 *   - resolvePermissions(req)        → cached on req
 *   - hasPermission(req, module, action)
 *
 * The legacy `User.role` enum is mapped to a sensible default
 * permission matrix. Custom Role documents (Phase-10) override or
 * extend that matrix; per-user `permissionOverrides` always win.
 */
import Role, {
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  SYSTEM_ROLE_CODES,
} from "../models/Role.js";
import User from "../models/User.js";

const ALL_ACTIONS = [...PERMISSION_ACTIONS];
const READ_ONLY_ACTIONS = ["view", "export"];

/** Quick helper: build a {module: [actions]} record. */
function buildMatrix(perModule) {
  const result = {};
  for (const m of PERMISSION_MODULES) {
    result[m] = perModule[m] || [];
  }
  return result;
}

const FULL_ACCESS = buildMatrix(
  Object.fromEntries(PERMISSION_MODULES.map((m) => [m, [...ALL_ACTIONS]]))
);

const SYSTEM_DEFAULTS = {
  SUPER_ADMIN: FULL_ACCESS,
  ADMIN: FULL_ACCESS,
  COMPANY_ADMIN: FULL_ACCESS,
  SALES: buildMatrix({
    SALES: ["view", "create", "edit", "approve", "cancel", "export"],
    CUSTOMS: ["view", "create"],
    REPORTS: READ_ONLY_ACTIONS,
    ITEM_MASTER: ["view", "export"],
    ACCOUNTS: ["view"],
    LOGISTICS: ["view"],
    STORE: ["view"],
  }),
  PURCHASE: buildMatrix({
    PURCHASE: ["view", "create", "edit", "approve", "cancel", "export"],
    ITEM_MASTER: ["view", "create", "edit", "export"],
    REPORTS: READ_ONLY_ACTIONS,
    STORE: ["view"],
  }),
  STORE: buildMatrix({
    STORE: ["view", "create", "edit", "approve", "cancel", "export"],
    CUSTOMS: ["view", "create"],
    ITEM_MASTER: ["view", "export"],
    REPORTS: READ_ONLY_ACTIONS,
    PURCHASE: ["view"],
  }),
  LOGISTICS: buildMatrix({
    LOGISTICS: ["view", "create", "edit", "approve", "cancel", "export"],
    REPORTS: READ_ONLY_ACTIONS,
    SALES: ["view"],
    STORE: ["view"],
  }),
  ACCOUNTS: buildMatrix({
    ACCOUNTS: ["view", "create", "edit", "approve", "cancel", "export"],
    CUSTOMS: ["view", "export", "reconcile"],
    REPORTS: READ_ONLY_ACTIONS,
    SALES: ["view"],
  }),
  VIEW_ONLY: buildMatrix(
    Object.fromEntries(PERMISSION_MODULES.map((m) => [m, READ_ONLY_ACTIONS]))
  ),
};

/** Map legacy enum codes → Phase-10 system role codes. */
const LEGACY_ROLE_MAP = {
  super_admin: "SUPER_ADMIN",
  company_admin: "COMPANY_ADMIN",
  admin: "ADMIN",
  staff: "VIEW_ONLY",
  purchase_sales: "SALES",
  accounts_logistics: "ACCOUNTS",
  sales: "SALES",
  purchase: "PURCHASE",
  store: "STORE",
  logistics: "LOGISTICS",
  accounts: "ACCOUNTS",
  view_only: "VIEW_ONLY",
};

export function normaliseRoleCode(code) {
  const raw = String(code || "").trim();
  if (!raw) return "";
  if (LEGACY_ROLE_MAP[raw.toLowerCase()]) return LEGACY_ROLE_MAP[raw.toLowerCase()];
  return raw.toUpperCase();
}

export function getDefaultPermissionsForRole(roleCode) {
  const normalised = normaliseRoleCode(roleCode);
  return SYSTEM_DEFAULTS[normalised] || buildMatrix({});
}

/** Merge `extra` permissions into `base`, returning a new matrix. */
function mergeMatrix(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const [module, actions] of Object.entries(extra)) {
    const existing = new Set(out[module] || []);
    for (const a of actions || []) existing.add(a);
    out[module] = Array.from(existing);
  }
  return out;
}

function permissionsFromRoleDoc(roleDoc) {
  if (!roleDoc) return {};
  const out = {};
  for (const entry of roleDoc.permissions || []) {
    out[entry.module] = entry.actions || [];
  }
  return out;
}

function permissionsFromOverrides(overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return {};
  const out = {};
  for (const entry of overrides) {
    if (!entry?.module) continue;
    out[String(entry.module).toUpperCase()] = entry.actions || [];
  }
  return out;
}

/**
 * Compute and memoise the permission matrix for the current request.
 * Uses req.user.id when present, otherwise falls back to the request's
 * declared role enum.
 */
export async function resolvePermissions(req) {
  if (req?._permissions) return req._permissions;

  const roleCode = req?.user?.role || "";
  const base = getDefaultPermissionsForRole(roleCode);
  let merged = base;

  if (req?.user?.id) {
    try {
      const user = await User.findById(req.user.id)
        .select("roleIds permissionOverrides role")
        .lean();
      if (user?.roleIds?.length) {
        const docs = await Role.find({
          _id: { $in: user.roleIds },
          isActive: true,
        })
          .select("permissions code")
          .lean();
        for (const doc of docs) {
          merged = mergeMatrix(merged, permissionsFromRoleDoc(doc));
        }
      }
      if (user?.permissionOverrides?.length) {
        merged = mergeMatrix(merged, permissionsFromOverrides(user.permissionOverrides));
      }
    } catch {
      // Soft fall-through: legacy role defaults remain.
    }
  }

  req._permissions = merged;
  return merged;
}

export async function hasPermission(req, moduleName, action) {
  const matrix = await resolvePermissions(req);
  const m = String(moduleName || "").toUpperCase();
  const a = String(action || "").toLowerCase();
  return Array.isArray(matrix[m]) && matrix[m].includes(a);
}

export const ROLE_DEFAULTS = SYSTEM_DEFAULTS;
export { PERMISSION_MODULES, PERMISSION_ACTIONS, SYSTEM_ROLE_CODES };
