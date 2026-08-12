/**
 * Label face company branding — layout is shared; printed company name is company-aware.
 * Do not hardcode MARIVOLT on OKE (or other) labels.
 */
export function resolveLabelCompanyBranding(company) {
  if (!company) return "COMPANY";
  const code = String(company.code || "").trim().toUpperCase();
  const short = String(company.shortName || "").trim();
  if (short) return short.toUpperCase();
  // Preserve historical MAR face text used on existing physical stock labels.
  if (code === "MAR") return "MARIVOLT FZE";
  const name = String(company.name || "").trim();
  if (name) return name.toUpperCase();
  if (code) return code;
  return "COMPANY";
}

export function resolveLabelTestTitle(company) {
  const brand = resolveLabelCompanyBranding(company);
  return `${brand} TEST LABEL`;
}
