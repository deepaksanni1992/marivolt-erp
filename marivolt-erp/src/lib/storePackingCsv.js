import { downloadCsv } from "./purchaseExport.js";

export const PACKING_CSV_COLUMNS = [
  { key: "packageNo", header: "Package No" },
  { key: "packageType", header: "Package Type" },
  { key: "dimensions", header: "Dimensions" },
  { key: "grossWeightKg", header: "Gross Weight" },
  { key: "netWeightKg", header: "Net Weight" },
  { key: "article", header: "Article" },
  { key: "description", header: "Description" },
  { key: "partNumber", header: "Part Number" },
  { key: "uom", header: "UOM" },
  { key: "qty", header: "Qty in Package" },
  { key: "remarks", header: "Remarks" },
];

/** One row per pending allocation line; package fields blank for offline fill. */
export function exportPackingTemplateCsv(lines, allocationNo = "allocation") {
  const rows = (lines || [])
    .filter((ln) => (Number(ln.pendingPack) || 0) > 0)
    .map((ln) => ({
      packageNo: "",
      packageType: "",
      dimensions: "",
      grossWeightKg: "",
      netWeightKg: "",
      article: ln.article || "",
      description: ln.description || "",
      partNumber: ln.partNumber || "",
      uom: ln.uom || "PCS",
      qty: "",
      remarks: "",
    }));
  const base = String(allocationNo || "allocation").replace(/[^\w-]+/g, "-");
  downloadCsv(`packing-template-${base}.csv`, PACKING_CSV_COLUMNS, rows);
}

/** Flatten package builder state for edit / re-import. */
export function exportCurrentPackingCsv(packPackages, allocationNo = "draft") {
  const rows = [];
  for (const pkg of packPackages || []) {
    const header = {
      packageNo: pkg.packageNo || "",
      packageType: pkg.packageType || "",
      dimensions: pkg.dimensions || "",
      grossWeightKg: pkg.grossWeightKg ?? "",
      netWeightKg: pkg.netWeightKg ?? "",
      article: "",
      description: "",
      partNumber: "",
      uom: "",
      qty: "",
      remarks: pkg.packageRemarks || "",
    };
    const items = (pkg.items || []).filter((it) => Number(it.qty) > 0);
    if (!items.length) {
      rows.push(header);
      continue;
    }
    for (const item of items) {
      rows.push({
        packageNo: pkg.packageNo || "",
        packageType: pkg.packageType || "",
        dimensions: pkg.dimensions || "",
        grossWeightKg: pkg.grossWeightKg ?? "",
        netWeightKg: pkg.netWeightKg ?? "",
        article: item.article || "",
        description: item.description || "",
        partNumber: item.spn || item.partNumber || "",
        uom: item.uom || "PCS",
        qty: item.qty ?? "",
        remarks: item.remarks || "",
      });
    }
  }
  const base = String(allocationNo || "draft").replace(/[^\w-]+/g, "-");
  downloadCsv(`packing-draft-${base}.csv`, PACKING_CSV_COLUMNS, rows);
}

/** Map API import packages to UI package shape. */
export function mapImportPackagesToUi(apiPackages = []) {
  return apiPackages.map((pkg, idx) => ({
    id: `${Date.now()}-${idx}-${Math.random().toString(16).slice(2)}`,
    packageNo: pkg.packageNo || `Carton-${idx + 1}`,
    packageType: pkg.packageType || "Carton",
    dimensions: pkg.dimensions || "",
    grossWeightKg: pkg.grossWeightKg ?? "",
    netWeightKg: pkg.netWeightKg ?? "",
    packageRemarks: pkg.packageRemarks || "",
    marksAndNumbers: pkg.marksAndNumbers || pkg.packageRemarks || "",
    items: (pkg.items || []).map((it) => ({
      allocationLineId: it.allocationLineId,
      article: it.article,
      description: it.description || "",
      spn: it.spn || it.partNumber || "",
      materialCode: it.materialCode || "",
      qty: Number(it.qty) || 0,
      uom: it.uom || "PCS",
      remarks: it.remarks || "",
    })),
  }));
}
