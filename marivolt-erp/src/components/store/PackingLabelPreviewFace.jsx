/** Shared packing/custom label 100×50 preview table (matches TSPL emphasis + row weights). */
export function PackingLabelPreviewFace({ rows = [] }) {
  return (
    <div
      className="mx-auto overflow-hidden rounded border-2 border-slate-900 bg-white shadow"
      style={{ width: 400, height: 200, aspectRatio: "2 / 1" }}
    >
      <table className="h-full w-full table-fixed border-collapse text-[11px] leading-tight">
        <tbody>
          {(rows || []).map((row) => {
            const emphasis = row.emphasis || (row.label === "QTY" ? "qty" : row.label === "Article" || row.label === "Part No." ? "strong" : "normal");
            const valueClass = [
              "border-b border-slate-300 px-1.5 py-0.5 last:border-b-0 align-middle",
              emphasis === "qty" ? "text-[15px] font-extrabold tracking-wide" : "",
              emphasis === "strong" ? "text-[12px] font-bold" : "",
              emphasis === "customer" ? "text-[12px] font-semibold" : "",
              emphasis === "normal" ? "text-[11px] font-medium text-slate-900" : "",
              emphasis === "desc" ? "text-[11px] whitespace-pre-line" : "",
              row.descriptionTruncated ? "text-amber-900" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <tr key={row.label} style={{ height: `${Math.max(6, Number(row.weight) || 8)}%` }}>
                <td className="w-[26%] border-b border-r border-slate-300 px-1 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-slate-700">
                  {row.label}
                </td>
                <td className={valueClass}>{row.value}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
