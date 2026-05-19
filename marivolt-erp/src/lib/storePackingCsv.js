import { downloadCsv } from "./purchaseExport.js";

/** Import / warehouse template — Article kept for line matching on import. */
export const PACKING_CSV_IMPORT_COLUMNS = [
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

/** Customer-facing export — no Article column; includes S No. */
export const PACKING_CSV_EXPORT_COLUMNS = [
  { key: "sno", header: "S No." },
  { key: "packageNo", header: "Package No" },
  { key: "packageType", header: "Package Type" },
  { key: "dimensions", header: "Dimensions" },
  { key: "grossWeightKg", header: "Gross Weight" },
  { key: "netWeightKg", header: "Net Weight" },
  { key: "partNumber", header: "Part Number" },
  { key: "description", header: "Description" },
  { key: "uom", header: "UOM" },
  { key: "qty", header: "Qty in Package" },
  { key: "remarks", header: "Remarks" },
];

/** @deprecated Use PACKING_CSV_IMPORT_COLUMNS */
export const PACKING_CSV_COLUMNS = PACKING_CSV_IMPORT_COLUMNS;

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
  downloadCsv(`packing-template-${base}.csv`, PACKING_CSV_IMPORT_COLUMNS, rows);
}

/** Flatten package builder state for edit / re-import (customer columns, no Article). */
export function exportCurrentPackingCsv(packPackages, allocationNo = "draft") {
  const rows = [];
  let serial = 0;
  for (const pkg of packPackages || []) {
    const items = (pkg.items || []).filter((it) => Number(it.qty) > 0);
    if (!items.length) {
      rows.push({
        sno: "",
        packageNo: pkg.packageNo || "",
        packageType: pkg.packageType || "",
        dimensions: pkg.dimensions || "",
        grossWeightKg: pkg.grossWeightKg ?? "",
        netWeightKg: pkg.netWeightKg ?? "",
        partNumber: "",
        description: pkg.packageRemarks || "",
        uom: "",
        qty: "",
        remarks: pkg.packageRemarks || "",
      });
      continue;
    }
    for (const item of items) {
      serial += 1;
      rows.push({
        sno: serial,
        packageNo: pkg.packageNo || "",
        packageType: pkg.packageType || "",
        dimensions: pkg.dimensions || "",
        grossWeightKg: pkg.grossWeightKg ?? "",
        netWeightKg: pkg.netWeightKg ?? "",
        partNumber: item.spn || item.partNumber || "",
        description: item.description || "",
        uom: item.uom || "PCS",
        qty: item.qty ?? "",
        remarks: item.remarks || "",
      });
    }
  }
  const base = String(allocationNo || "draft").replace(/[^\w-]+/g, "-");
  downloadCsv(`packing-draft-${base}.csv`, PACKING_CSV_EXPORT_COLUMNS, rows);
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
