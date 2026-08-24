import {
  asnCompletenessStatusLabel,
  groupCompletenessMissingByArticle,
} from "../../lib/asnReceivingCompleteness.js";

/**
 * Visible Data Completeness panel for ASN detail / incoming shipment.
 */
export default function AsnReceivingCompletenessPanel({
  completeness,
  id = "asn-data-completeness",
  className = "",
}) {
  if (!completeness) return null;
  const missing = completeness.missing || [];
  const grouped = groupCompletenessMissingByArticle(missing);
  const complete = Boolean(completeness.complete);

  return (
    <section
      id={id}
      className={`rounded-xl border p-4 ${
        complete ? "border-emerald-200 bg-emerald-50" : "border-amber-300 bg-amber-50"
      } ${className}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">Data Completeness</h2>
        <span
          className={`text-sm font-semibold ${complete ? "text-emerald-800" : "text-amber-950"}`}
        >
          {asnCompletenessStatusLabel(completeness)}
        </span>
      </div>
      {complete ? (
        <p className="mt-2 text-sm text-emerald-900">ASN is complete for receiving.</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-amber-950">
            {completeness.summary ||
              "Required ASN data is missing. Receiving Unit planning/printing and new receiving sessions are blocked until these are completed."}
          </p>
          {grouped.document.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-950">
              {grouped.document.map((item) => (
                <li key={`${item.field}-${item.code}`}>{item.label || item.field}</li>
              ))}
            </ul>
          ) : null}
          {grouped.lines.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-amber-200 text-xs uppercase tracking-wide text-amber-900">
                    <th className="py-1.5 pr-4 font-semibold">Article</th>
                    <th className="py-1.5 font-semibold">Missing</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.lines.map((row) => (
                    <tr key={row.article} className="border-b border-amber-100 last:border-0">
                      <td className="py-1.5 pr-4 font-mono font-semibold text-amber-950">{row.article}</td>
                      <td className="py-1.5 text-amber-950">{row.labels.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
