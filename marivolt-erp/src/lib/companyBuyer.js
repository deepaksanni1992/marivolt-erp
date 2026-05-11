/**
 * Maps the active company (from auth) to PO buyer header fields.
 * Keep in sync with backend `buyerSnapshotFromCompany`.
 */
export function buyerDefaultsFromCompany(company) {
  if (!company) {
    return {
      buyerLegalName: "",
      buyerAddressLine: "",
      buyerPhone: "",
      buyerEmail: "",
      buyerWeb: "",
      buyerTrnNo: "",
    };
  }
  return {
    buyerLegalName: String(company.name || "").trim(),
    buyerAddressLine: String(company.address || "").trim(),
    buyerPhone: String(company.phone || "").trim(),
    buyerEmail: String(company.email || "").trim(),
    buyerWeb: String(company.website || "").trim(),
    buyerTrnNo: String(company.trnNo || "").trim(),
  };
}
