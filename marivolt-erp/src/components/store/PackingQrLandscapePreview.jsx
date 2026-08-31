/**
 * Dot-accurate 100×150 landscape packing preview.
 * Geometry authority is the shared layout result (viewBox 0 0 1200 800), not CSS 400×200.
 */
export function PackingQrLandscapePreview({
  svg = "",
  layout = null,
  blocked = false,
  errors = [],
  identityReady = false,
}) {
  const markup = String(svg || "");
  const codes = errors.length
    ? errors
    : layout?.errorCodes || [];
  const src = markup
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    : "";
  const persisted = identityReady || layout?.qr?.validIdentity === true;
  return (
    <div>
      {blocked || codes.length ? (
        <p className="mb-2 text-xs font-medium text-rose-800">
          Preview blocked: {codes.join(", ") || "LABEL overflow"}
        </p>
      ) : null}
      {src ? (
        <div className="overflow-auto rounded border bg-slate-100 p-2">
          <img
            alt="Packing QR landscape 100×150 preview"
            src={src}
            className="mx-auto h-auto w-full max-w-[900px]"
          />
        </div>
      ) : (
        <p className="text-xs text-slate-500">No preview geometry.</p>
      )}
      <p className={`mt-2 text-xs ${persisted ? "text-slate-700" : "text-amber-900"}`}>
        {persisted
          ? `Persisted label ${layout?.fields?.labelId || ""} — QR token matches the print payload.`
          : "PREVIEW QR is not a valid ERP scan identity. First print mints a permanent MAR-PL number."}
      </p>
      {layout?.fields?.vesselPlantSourceMissing ? (
        <p className="mt-1 text-xs text-slate-600">
          Vessel/Plant is blank: no dedicated source field on the allocation or packing record.
        </p>
      ) : null}
    </div>
  );
}
