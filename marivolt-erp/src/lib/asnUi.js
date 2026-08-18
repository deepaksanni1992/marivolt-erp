export const ASN_DOC_TYPES = [
  "Supplier Invoice",
  "Packing List",
  "BL/AWB",
  "Certificate of Origin",
  "Test Certificate",
  "Shipping Document",
  "ASN Document",
  "Other",
];

export const ASN_SHIPMENT_MODES = ["AIR", "SEA", "COURIER", "ROAD", "LOCAL", "OTHER"];

export { default as AsnStatusBadge } from "../components/asn/AsnStatusBadge.jsx";

export function formatAsnDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

export function trackingDisplay(row = {}) {
  return row.awbNumber || row.blNumber || row.trackingNumber || "—";
}

export function asnLineQtyTotal(row = {}) {
  return (row.lines || []).reduce((s, l) => s + (Number(l.asnQty) || 0), 0);
}
