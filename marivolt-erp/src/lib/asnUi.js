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

export function incomingShipmentsPath(asnId = "") {
  const tab = encodeURIComponent("Incoming Shipments");
  const id = String(asnId || "").trim();
  if (id) return `/store?tab=${tab}&asnId=${encodeURIComponent(id)}`;
  return `/store?tab=${tab}`;
}

/** Default Incoming Shipments list uses incoming=1 (no CSV status) so SHIPPED ASNs are not dropped. */
export function incomingAsnListQuery({ status, search } = {}) {
  const params = {
    limit: 50,
    page: 1,
    asnNo: search || undefined,
  };
  if (status === "SHIPPED" || status === "ARRIVED") {
    params.status = status;
  } else {
    params.incoming = "1";
  }
  return params;
}

export function isAsnReceivingGrn(grn) {
  if (!grn) return false;
  if (String(grn.sourceType || "").toUpperCase() === "ASN_RECEIVING") return true;
  return Boolean(grn.receivingSessionId);
}

export function grnSourceLabel(grn) {
  if (isAsnReceivingGrn(grn)) return "ASN Receiving";
  const src = String(grn?.sourceType || "").trim().toUpperCase();
  if (!src || src === "MANUAL_PO") return "Direct PO";
  return src.replace(/_/g, " ");
}

export function grnSourceDetail(grn) {
  if (isAsnReceivingGrn(grn)) {
    return grn.asnNo ? `ASN: ${grn.asnNo}` : "ASN Receiving";
  }
  const src = String(grn?.sourceType || "").trim().toUpperCase();
  if (src && src !== "MANUAL_PO") {
    return src.replace(/_/g, " ");
  }
  return grn?.poNo ? `PO: ${grn.poNo}` : "Direct PO";
}
