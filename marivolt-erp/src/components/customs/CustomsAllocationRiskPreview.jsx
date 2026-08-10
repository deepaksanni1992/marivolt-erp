function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function boeCustomsUnitValue(alloc) {
  const n = Number(alloc?.customsUnitValue ?? alloc?.unitPrice);
  return Number.isFinite(n) ? n : null;
}

function RiskStatus({ risk }) {
  if (!risk) return null;
  if (risk.comparable === false) {
    return (
      <span className="text-amber-700">Customs price comparison unavailable — FX conversion required.</span>
    );
  }
  if (risk.warning) {
    return <span className="font-medium text-amber-800">Sales price is below BOE Customs Unit Value.</span>;
  }
  return <span className="text-emerald-700">OK</span>;
}

/** Per-allocation BOE vs sales economics from preview riskComparison rows. */
export function CustomsAllocationRiskTable({ lines = [], compact = false }) {
  if (!lines.length) return null;

  const rows = [];
  for (const line of lines) {
    const salesPrice = line.salesUnitPrice;
    const salesCurrency = line.salesCurrency || "";
    const risks = line.riskComparison || [];
    (line.allocations || []).forEach((alloc, ai) => {
      const risk = risks[ai] || risks.find((r) => r.allocationId && r.allocationId === alloc.allocationId) || {};
      const boeUnit = boeCustomsUnitValue(alloc) ?? risk.boeCustomsUnitValueCompared ?? risk.customsUnitValue;
      rows.push({
        key: `${line.articleNumber}-${ai}-${alloc.boeNumber || ai}`,
        articleNumber: line.articleNumber,
        boeNumber: alloc.boeNumber || risk.boeNumber || "—",
        allocatedQty: alloc.allocatedQty ?? alloc.qty,
        salesUnitPrice: risk.salesUnitPrice ?? salesPrice,
        salesCurrency: risk.salesCurrency ?? salesCurrency,
        boeCustomsUnitValue: boeUnit,
        boeCurrency: alloc.currency || risk.boeCurrency || "",
        difference: risk.difference,
        variancePct: risk.variancePct,
        risk,
      });
    });
  }

  if (!rows.length) return null;

  if (compact) {
    return (
      <div className="mt-2 space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="rounded border bg-white px-2 py-1">
            <span className="font-mono">{row.articleNumber}</span>
            {row.boeNumber !== "—" ? ` · BOE ${row.boeNumber}` : null}
            {" · "}
            Sales {fmtNum(row.salesUnitPrice)} {row.salesCurrency}
            {" · "}
            BOE {fmtNum(row.boeCustomsUnitValue)} {row.boeCurrency}
            {" · "}
            Δ {fmtNum(row.difference)} ({fmtPct(row.variancePct)})
            <div className="mt-0.5">
              <RiskStatus risk={row.risk} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-100">
          <tr>
            <th className="px-2 py-1 text-left">Article</th>
            <th className="px-2 py-1 text-left">BOE</th>
            <th className="px-2 py-1 text-right">Alloc Qty</th>
            <th className="px-2 py-1 text-right">Sales Unit Price</th>
            <th className="px-2 py-1 text-right">BOE Customs Unit Value</th>
            <th className="px-2 py-1 text-right">Difference</th>
            <th className="px-2 py-1 text-right">Variance %</th>
            <th className="px-2 py-1 text-left">Risk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t align-top">
              <td className="px-2 py-1 font-mono">{row.articleNumber}</td>
              <td className="px-2 py-1">{row.boeNumber}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtNum(row.allocatedQty)}</td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(row.salesUnitPrice)}
                {row.salesCurrency ? ` ${row.salesCurrency}` : ""}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {fmtNum(row.boeCustomsUnitValue)}
                {row.boeCurrency ? ` ${row.boeCurrency}` : ""}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {row.risk?.comparable === false ? "—" : fmtNum(row.difference)}
              </td>
              <td className="px-2 py-1 text-right tabular-nums">
                {row.risk?.comparable === false ? "—" : fmtPct(row.variancePct)}
              </td>
              <td className="px-2 py-1">
                <RiskStatus risk={row.risk} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function previewRequiresRiskReason(preview) {
  if (!preview) return false;
  if (preview.customsValueRiskRequiresReason) return true;
  return (preview.lines || []).some((line) => line.customsValueRiskRequiresReason);
}
