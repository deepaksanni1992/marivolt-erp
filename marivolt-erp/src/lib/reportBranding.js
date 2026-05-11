/** Shared Marivolt / Okeanos print & preview branding (quotations, reports, PO preview). */
export function getReportBranding(companyNameRaw = "") {
  const companyName = String(companyNameRaw || "").toLowerCase();
  const isMarivolt = companyName.includes("marivolt");
  const isOkeanos = companyName.includes("okeanos");
  const useBrandedLayout = isMarivolt || isOkeanos;
  const printLogo = isMarivolt
    ? "/brand/marivolt-icon.png"
    : isOkeanos
      ? "/brand/okeanos-logo.png"
      : "";
  const companyDisplayName = isMarivolt ? "MariVolt" : isOkeanos ? "OKEANOS" : "";
  const companySubtitle = useBrandedLayout ? "Marine Engine Spares" : "";
  const reportAddress = isMarivolt
    ? "LV09B, Hamriyah freezone phase 2, Sharjah, UAE"
    : isOkeanos
      ? "C1 Building, Ajman Freezone, Ajman, UAE"
      : "";
  const reportEmail = isMarivolt ? "sales@marivolt.co" : isOkeanos ? "Sales@okeanos.pro" : "";
  const reportPhone = isMarivolt ? "+971-543053047" : isOkeanos ? "+971-543050000" : "";
  const reportWebsite = isMarivolt ? "www.marivolt.co" : isOkeanos ? "www.okfze.com" : "";
  const reportFooterName = isMarivolt ? "Marivolt FZE" : isOkeanos ? "Okeanos FZE" : companyDisplayName;
  const reportFooterSubline = isMarivolt ? "LV09B" : "";
  return {
    isMarivolt,
    isOkeanos,
    useBrandedLayout,
    printLogo,
    companyDisplayName,
    companySubtitle,
    reportAddress,
    reportEmail,
    reportPhone,
    reportWebsite,
    reportFooterName,
    reportFooterSubline,
  };
}
