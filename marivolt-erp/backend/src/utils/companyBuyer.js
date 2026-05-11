/**
 * Buyer block on purchase orders = snapshot of the active Company master at save time.
 */
export function buyerSnapshotFromCompany(company) {
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
