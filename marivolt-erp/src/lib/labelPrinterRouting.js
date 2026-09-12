/** Client-side printer purpose helpers. Backend remains authoritative. */

export const LABEL_PURPOSE_GRN = "GRN";
export const LABEL_PURPOSE_GRN_PREPOST = "GRN_PREPOST";
export const LABEL_PURPOSE_PACKING = "PACKING";
export const LABEL_PURPOSE_CUSTOM_PACKING = "CUSTOM_PACKING";
export const LABEL_PURPOSE_ASN = "ASN";

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

export function printerLanguage(printer) {
  return upper(printer?.language || "TSPL") || "TSPL";
}

export function printerAllowsPurpose(printer, purpose) {
  const want = upper(purpose);
  const list = Array.isArray(printer?.supportedPurposes)
    ? printer.supportedPurposes.map(upper).filter(Boolean)
    : [];
  if (!want || !list.length) return true;
  return list.includes(want);
}

export function printerMediaLabel(printer, fallback = "100×50 mm") {
  const w = Number(printer?.widthMm);
  const h = Number(printer?.heightMm);
  if (w > 0 && h > 0) return `${w}×${h} mm`;
  return fallback;
}

export function filterPrintersForPurpose(printers = [], purpose) {
  return (printers || []).filter(
    (p) => p && p.isActive !== false && printerAllowsPurpose(p, purpose)
  );
}

export const GRN_LABEL_WIDTH_MM = 100;
export const GRN_LABEL_HEIGHT_MM = 50;

/** Unlocked media (0/unset) matches any size; locked media must equal the label. */
export function printerMediaMatches(printer, widthMm, heightMm) {
  const w = Number(printer?.widthMm);
  const h = Number(printer?.heightMm);
  if (!(w > 0 && h > 0)) return true;
  return w === Number(widthMm) && h === Number(heightMm);
}

/** GRN Article labels: purpose GRN and 100×50 mm (or unlocked). Packing 100×150 is excluded. */
export function filterPrintersForGrnLabels(printers = []) {
  return filterPrintersForPurpose(printers, LABEL_PURPOSE_GRN).filter((p) =>
    printerMediaMatches(p, GRN_LABEL_WIDTH_MM, GRN_LABEL_HEIGHT_MM)
  );
}

export function groupPrintersByAgent(printers = []) {
  const map = new Map();
  for (const p of printers || []) {
    const key = String(p.agentId || "UNASSIGNED").toUpperCase();
    if (!map.has(key)) {
      map.set(key, {
        agentId: key,
        agentName: p.agentName || "",
        computerName: p.agentComputerName || "",
        printers: [],
      });
    }
    map.get(key).printers.push(p);
  }
  return [...map.values()];
}

export function describePrinterDestination(printer, { purpose, fallbackSize } = {}) {
  if (!printer) {
    return {
      printerLabel: "Select a printer",
      agentLabel: "Not selected — jobs will not be sent to another laptop",
      sizeLabel: fallbackSize || "—",
      language: "",
      countHint: "",
    };
  }
  const size =
    purpose === LABEL_PURPOSE_PACKING && Number(printer.heightMm) === 150
      ? "100×150 mm"
      : printerMediaLabel(printer, fallbackSize || "100×50 mm");
  const lang = printerLanguage(printer);
  const model = printer.printerModel || (lang === "ZPL" ? "Zebra" : "Rongta");
  return {
    printerLabel: `${printer.displayName || printer.code} · ${model} · ${printer.windowsPrinterName || "—"}`,
    agentLabel: printer.agentName || printer.agentComputerName || printer.agentId || "—",
    sizeLabel: size,
    language: lang,
    printerCode: printer.code,
    agentId: printer.agentId,
    windowsPrinterName: printer.windowsPrinterName,
  };
}
