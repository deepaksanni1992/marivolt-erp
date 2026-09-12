export default function LabelPrintDestinationBanner({
  printerLabel,
  agentLabel,
  sizeLabel,
  countLabel,
  language,
  warning,
}) {
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800">
      <div className="font-semibold uppercase tracking-wide text-slate-500">Print destination</div>
      <dl className="mt-1 grid gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Printer</dt>
          <dd className="font-medium break-words">{printerLabel || "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Laptop / agent</dt>
          <dd className="font-medium break-words">{agentLabel || "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Label size</dt>
          <dd className="font-medium">{sizeLabel || "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Labels</dt>
          <dd className="font-medium tabular-nums">{countLabel || "—"}</dd>
        </div>
        {language ? (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">Language</dt>
            <dd className="font-mono">{language}</dd>
          </div>
        ) : null}
      </dl>
      {warning ? (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-950">{warning}</p>
      ) : null}
    </div>
  );
}
