/**
 * Visual 100×50 mm ASN Receiving Unit preview (HTML approximation of TSPL face).
 * Shows the same RU number, barcode value, and planned qty that will print.
 */
export default function AsnRuLabelPreviewFace({
  article = "",
  partNo = "",
  description = "",
  plannedQty = 0,
  uom = "PCS",
  asnNo = "",
  ruNo = "",
  barcodeValue = "",
  companyName = "MARIVOLT",
}) {
  const qtyText = `${plannedQty} ${uom || "PCS"}`.trim();
  const barcode = barcodeValue || ruNo || "";
  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div
        className="relative overflow-hidden rounded-xl border-2 border-slate-800 bg-white text-slate-900 shadow-sm"
        style={{ aspectRatio: "2 / 1" }}
      >
        <div className="flex h-full flex-col px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{companyName}</div>
          <div className="mt-0.5 text-xl font-black leading-none tracking-tight">{article || "—"}</div>
          <div className="mt-1 text-base font-bold leading-tight">{partNo || "—"}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-snug text-slate-700">{description || "—"}</div>
          <div className="mt-auto grid grid-cols-[1fr_auto] items-end gap-2">
            <div>
              <div className="text-lg font-black leading-none">Qty: {qtyText}</div>
              <div className="mt-1 font-mono text-[11px]">ASN: {asnNo || "—"}</div>
              <div className="font-mono text-[11px] font-semibold">RU: {ruNo || "—"}</div>
            </div>
            <div className="min-w-[42%] text-center">
              <div className="mx-auto h-8 w-full max-w-[140px] bg-[repeating-linear-gradient(90deg,#0f172a_0_2px,#fff_2px_4px)]" />
              <div className="mt-1 font-mono text-[10px] font-semibold tracking-wide">{barcode || "—"}</div>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-1 text-center text-[11px] text-slate-500">100 × 50 mm · Code128 = RU number</p>
    </div>
  );
}
