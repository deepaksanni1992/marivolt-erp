/**
 * S0 — Admin user-creation and role/company assignment policy.
 * Server-side allowlists only; never trust req.body for privileged fields.
 */

export const USER_ROLES = Object.freeze([
  "super_admin",
  "company_admin",
  "admin",
  "staff",
  "purchase_sales",
  "accounts_logistics",
  "sales",
  "purchase",
  "store",
  "store_operator",
  "logistics",
  "accounts",
  "view_only",
]);

/** Roles a company_admin / admin may assign (not super_admin). */
export const ADMIN_ASSIGNABLE_ROLES = Object.freeze([
  "company_admin",
  "admin",
  "staff",
  "purchase_sales",
  "accounts_logistics",
  "sales",
  "purchase",
  "store",
  "store_operator",
  "logistics",
  "accounts",
  "view_only",
]);

export const USER_CREATE_ALLOWED_BODY_FIELDS = Object.freeze([
  "name",
  "username",
  "email",
  "password",
  "temporaryPassword",
  "role",
  "companyIds",
  "allowedCompanies",
  "defaultCompanyId",
  "isActive",
]);

export const USER_CREATE_PROHIBITED_BODY_FIELDS = Object.freeze([
  "passwordHash",
  "twoFactorSecret",
  "twoFactorEnabled",
  "twoFactorEnabledAt",
  "twoFactorLastVerifiedAt",
  "permissionOverrides",
  "roleIds",
  "allowedBranches",
  "allowedWarehouses",
  "createdBy",
  "updatedBy",
  "lastLoginAt",
  "lastLoginIp",
  "lastLoginAgent",
  "_id",
  "id",
  "permissions",
  "isSystem",
]);

export function normalizeRole(role) {
  return String(role || "")
    .toLowerCase()
    .trim();
}

/** Human labels for Admin UI (backend remains allowlist source of truth). */
export const ROLE_DISPLAY_LABELS = Object.freeze({
  super_admin: "Super Admin",
  company_admin: "Company Admin",
  admin: "Admin",
  staff: "Staff",
  purchase_sales: "Purchase & Sales",
  accounts_logistics: "Accounts & Logistics",
  sales: "Sales",
  purchase: "Purchase",
  store: "Store",
  store_operator: "Store Operator",
  logistics: "Logistics",
  accounts: "Accounts",
  view_only: "View Only",
});

export function roleDisplayLabel(role) {
  const r = normalizeRole(role);
  return ROLE_DISPLAY_LABELS[r] || r || "—";
}

/** Roles an actor may assign in Admin Create User UI. */
export function assignableRolesForActor(actorRole) {
  const actor = normalizeRole(actorRole);
  if (actor === "super_admin") return [...USER_ROLES];
  return [...ADMIN_ASSIGNABLE_ROLES];
}

export function isSuperAdminRole(role) {
  return normalizeRole(role) === "super_admin";
}

export function isAdminRole(role) {
  const r = normalizeRole(role);
  return r === "super_admin" || r === "company_admin" || r === "admin";
}

export function authPolicyError(code, message, statusCode = 403) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * Validate role assignment. Rejects with 403 — never silent downgrade.
 */
export function assertAssignableRole({ actorRole, requestedRole }) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(requestedRole);
  if (!USER_ROLES.includes(target)) {
    throw authPolicyError("INVALID_ROLE", "Role is not in the allowed role set", 400);
  }
  if (target === "super_admin" && actor !== "super_admin") {
    throw authPolicyError(
      "SUPER_ADMIN_ASSIGN_FORBIDDEN",
      "Only a super_admin may assign the super_admin role"
    );
  }
  if (actor !== "super_admin" && !ADMIN_ASSIGNABLE_ROLES.includes(target)) {
    throw authPolicyError("ROLE_ASSIGN_FORBIDDEN", "You may not assign this role");
  }
  return target;
}

/**
 * Validate company IDs for assignment.
 * - Non-empty array of ObjectId strings required
 * - Must all be in `activeCompanyIds`
 * - Non-super actors may only assign ⊆ `actorAllowedCompanyIds`
 * - All-company grant (every active company) requires super_admin
 */
export function assertAssignableCompanies({
  actorRole,
  requestedCompanyIds,
  actorAllowedCompanyIds = [],
  activeCompanyIds = [],
}) {
  if (!Array.isArray(requestedCompanyIds) || requestedCompanyIds.length === 0) {
    throw authPolicyError(
      "COMPANY_IDS_REQUIRED",
      "companyIds must be a non-empty array of active company IDs",
      400
    );
  }
  const requested = [...new Set(requestedCompanyIds.map((x) => String(x || "").trim()).filter(Boolean))];
  if (!requested.length) {
    throw authPolicyError("COMPANY_IDS_REQUIRED", "companyIds must be a non-empty array", 400);
  }
  const active = new Set(activeCompanyIds.map(String));
  for (const id of requested) {
    if (!active.has(id)) {
      throw authPolicyError(
        "COMPANY_NOT_ACTIVE",
        "One or more company IDs are missing or inactive",
        400
      );
    }
  }

  const actor = normalizeRole(actorRole);
  if (actor === "super_admin") {
    return requested;
  }

  const actorAllowed = new Set(actorAllowedCompanyIds.map(String));
  for (const id of requested) {
    if (!actorAllowed.has(id)) {
      throw authPolicyError(
        "COMPANY_ASSIGN_FORBIDDEN",
        "You may not assign a company outside your permitted companies"
      );
    }
  }

  // All-company access (every active company when more than one exists) is super-admin only.
  // Single-company tenants still allow company_admin to assign their one company.
  if (
    active.size > 1 &&
    requested.length === active.size &&
    [...active].every((id) => requested.includes(id))
  ) {
    throw authPolicyError(
      "ALL_COMPANY_ASSIGN_FORBIDDEN",
      "Only a super_admin may grant access to all companies"
    );
  }

  return requested;
}

/**
 * Strip prohibited fields and return only allowed create-user body keys.
 * Presence of prohibited keys causes rejection (not silent strip).
 */
export function pickUserCreateBody(body = {}) {
  const raw = body && typeof body === "object" ? body : {};
  const prohibited = USER_CREATE_PROHIBITED_BODY_FIELDS.filter((k) => k in raw);
  if (prohibited.length) {
    throw authPolicyError(
      "PROTECTED_FIELD_REJECTED",
      `Protected fields are not allowed: ${prohibited.join(", ")}`,
      400
    );
  }
  const out = {};
  for (const key of USER_CREATE_ALLOWED_BODY_FIELDS) {
    if (key in raw) out[key] = raw[key];
  }
  return out;
}

export function resolveCreatePassword(picked) {
  const password = String(picked.password || picked.temporaryPassword || "");
  if (password.length < 10) {
    throw authPolicyError(
      "WEAK_PASSWORD",
      "Password must be at least 10 characters",
      400
    );
  }
  return password;
}
