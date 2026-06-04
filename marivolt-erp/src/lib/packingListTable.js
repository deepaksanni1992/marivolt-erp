/** Customer-facing packing list table columns (print / PDF). No internal Article column. */

export const PACKING_LIST_PRINT_COLUMNS = [
  { key: "sno", header: "S No.", className: "col-sno" },
  { key: "packageNo", header: "Package", className: "col-pack" },
  { key: "packageType", header: "Type", className: "col-pack-type" },
  { key: "dimensions", header: "Dimensions", className: "col-dim" },
  { key: "grossWeightKg", header: "Gross Kg", className: "col-weight col-right" },
  { key: "netWeightKg", header: "Net Kg", className: "col-weight col-right" },
  { key: "partNumber", header: "Part #", className: "col-part" },
  { key: "description", header: "Description", className: "col-desc" },
  { key: "uom", header: "UOM", className: "col-uom col-center" },
  { key: "qty", header: "Qty", className: "col-qty col-center" },
];

/**
 * @param {Array} packages Normalized packages with items[]
 * @param {{ packageTypeLabel: (v: string) => string, fmtWeight: (n: number) => string }} fmt
 */
export function buildStorePackingListPrintRows(packages, { packageTypeLabel, fmtWeight }) {
  const rows = [];
  let serial = 0;
  for (const pkg of packages || []) {
    rows.push({
      isGroupHeader: true,
      cells: [
        "",
        pkg.packageNo || "-",
        packageTypeLabel(pkg.packageType),
        pkg.dimensions || "-",
        fmtWeight(pkg.grossWeightKg),
        fmtWeight(pkg.netWeightKg),
        "",
        pkg.packageRemarks || pkg.marksAndNumbers || "",
        "",
        "",
      ],
    });
    for (const item of pkg.items || []) {
      serial += 1;
      rows.push({
        className: "package-item-row",
        cells: [
          String(serial),
          "",
          "",
          "",
          "",
          "",
          item.spn || item.partNumber || "",
          item.description || "",
          item.uom || "PCS",
          String(item.qty ?? item.packQty ?? 0),
        ],
      });
    }
  }
  return rows;
}
