/** Admin roles and designated users who may delete approved sales quotations. */
const QUOTATION_DELETE_ROLES = new Set(["super_admin", "company_admin", "admin"]);
const QUOTATION_DELETE_USERNAMES = new Set(["deepak007"]);

export function isSalesQuotationDeleteAdmin(req) {
  const role = String(req.user?.role || "")
    .toLowerCase()
    .trim();
  const username = String(req.user?.username || "")
    .toLowerCase()
    .trim();
  if (QUOTATION_DELETE_USERNAMES.has(username)) return true;
  return QUOTATION_DELETE_ROLES.has(role);
}

export function quotationDeleteBlockReason(row, { hasActiveOA = false } = {}) {
  if (!row) return "Quotation not found.";
  const st = String(row.status || "").toUpperCase();
  if (st === "CANCELLED") return "Quotation is already cancelled.";
  if (hasActiveOA) {
    return "Cancel the linked order acknowledgement first, then delete this quotation.";
  }
  if (!["DRAFT", "APPROVED", "CONVERTED"].includes(st)) {
    return "Only draft, approved, or converted quotations (with no active OA) can be deleted.";
  }
  return "";
}

export function quotationCanBeDeleted(row, { hasActiveOA = false } = {}) {
  return !quotationDeleteBlockReason(row, { hasActiveOA });
}
