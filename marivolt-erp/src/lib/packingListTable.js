/** Customer-facing packing list table columns (print / PDF). No internal Article column. */

export const PACKING_LIST_PRINT_COLUMNS = [
  { key: "sno", header: "S No.", className: "col-sno" },
  { key: "partNumber", header: "Part No.", className: "col-part" },
  { key: "description", header: "Description", className: "col-desc" },
  { key: "uom", header: "UOM", className: "col-uom col-center" },
  { key: "qty", header: "Qty", className: "col-qty col-center" },
  { key: "boxDetails", header: "Box Details", className: "col-box" },
];

export function formatPackingBoxDetails(pkg, { packageTypeLabel, fmtWeight }) {
  const lines = [];
  const no = String(pkg?.packageNo || "-").trim() || "-";
  const type = packageTypeLabel(pkg?.packageType);
  lines.push(type ? `${no} · ${type}` : no);
  if (pkg?.dimensions) lines.push(String(pkg.dimensions).trim());
  const g = fmtWeight(pkg?.grossWeightKg);
  const n = fmtWeight(pkg?.netWeightKg);
  const weights = [];
  if (g) weights.push(`Gross ${g} Kg`);
  if (n) weights.push(`Net ${n} Kg`);
  if (weights.length) lines.push(weights.join(" / "));
  const remarks = String(pkg?.packageRemarks || pkg?.marksAndNumbers || "").trim();
  if (remarks) lines.push(remarks);
  return lines.join("\n");
}

/**
 * @param {Array} packages Normalized packages with items[]
 * @param {{ packageTypeLabel: (v: string) => string, fmtWeight: (n: number) => string }} fmt
 */
export function buildStorePackingListPrintRows(packages, { packageTypeLabel, fmtWeight }) {
  const rows = [];
  let serial = 0;
  for (const pkg of packages || []) {
    const items = (pkg.items || []).filter((it) => Number(it.qty ?? it.packQty) > 0);
    const span = Math.max(1, items.length);
    const boxDetails = formatPackingBoxDetails(pkg, { packageTypeLabel, fmtWeight });
    const list = items.length ? items : [{ description: "", qty: "" }];
    list.forEach((item, idx) => {
      const isFirst = idx === 0;
      if (items.length) serial += 1;
      rows.push({
        className: isFirst ? "package-item-row package-box-start" : "package-item-row",
        cells: [
          items.length ? String(serial) : "",
          item.spn || item.partNumber || "",
          item.description || "",
          items.length ? item.uom || "PCS" : "",
          items.length ? String(item.qty ?? item.packQty ?? 0) : "",
          isFirst ? boxDetails : "",
        ],
        skipCells: [false, false, false, false, false, !isFirst],
        cellAttrs: [{}, {}, {}, {}, {}, isFirst ? { rowspan: span } : {}],
      });
    });
  }
  return rows;
}
