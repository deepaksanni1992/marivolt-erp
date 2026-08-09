/**
 * Admin Create User helpers — mirror backend ADMIN_ASSIGNABLE_ROLES labels.
 * Backend remains the allowlist source of truth.
 */

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
  const r = String(role || "")
    .toLowerCase()
    .trim();
  return ROLE_DISPLAY_LABELS[r] || r || "—";
}

/**
 * Client-side validation before POST /auth/users.
 * Does not weaken backend checks; avoids inconsistent defaultCompany.
 */
export function validateCreateUserForm(form) {
  const errors = [];
  const email = String(form?.email || "")
    .toLowerCase()
    .trim();
  if (!email) errors.push("Email is required");

  const password = String(form?.temporaryPassword || form?.password || "");
  if (password.length < 10) errors.push("Temporary password must be at least 10 characters");

  const role = String(form?.role || "")
    .toLowerCase()
    .trim();
  if (!role) errors.push("Role is required");

  const allowed = Array.isArray(form?.allowedCompanies)
    ? [...new Set(form.allowedCompanies.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (!allowed.length) errors.push("Select at least one allowed company");

  const defaultCompany = String(form?.defaultCompanyId || "").trim();
  if (defaultCompany && !allowed.includes(defaultCompany)) {
    errors.push("Default company must be one of the allowed companies");
  }
  if (!defaultCompany && allowed.length) {
    // Backend falls back to first allowed; still require explicit selection in UI.
    errors.push("Default company is required");
  }

  return { ok: errors.length === 0, errors, allowed, email, role, password, defaultCompany };
}

export function buildCreateUserPayload(form, { allowed, email, role, password, defaultCompany }) {
  const username = String(form?.username || "")
    .toLowerCase()
    .trim();
  const name = String(form?.name || "").trim();
  return {
    name,
    email,
    ...(username ? { username } : {}),
    role,
    temporaryPassword: password,
    allowedCompanies: allowed,
    companyIds: allowed,
    defaultCompanyId: defaultCompany,
    isActive: form?.isActive !== false,
  };
}

/** Whether Settings → Users Create User controls should render. */
export function canShowCreateUserUi(role) {
  const r = String(role || "")
    .toLowerCase()
    .trim();
  return r === "super_admin" || r === "company_admin" || r === "admin";
}
