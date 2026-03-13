import Material from "../models/Material.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import Article from "../models/Article.js";
import MaterialSupplier from "../models/MaterialSupplier.js";

/**
 * Resolve material(s) for given SPN + engine combination.
 *
 * @param {{ spn: string, engineMake: string, engineModel: string, configuration: string, cylinderCount: string, esn?: number|null }} params
 */
export async function resolveMaterial(params) {
  const {
    spn,
    engineMake,
    engineModel,
    configuration,
    cylinderCount,
    esn,
  } = params;

  const spnTrimmed = String(spn || "").trim();
  if (!spnTrimmed) {
    throw new Error("SPN is required");
  }

  // 1. Find materials linked to SPN
  const materials = await Material.find({
    spn: spnTrimmed,
    status: "Active",
  }).lean();

  if (!materials.length) {
    return [];
  }

  const materialCodes = materials.map((m) => m.materialCode);

  // 2. Find compatibility rows matching engine info
  const compatQuery = {
    materialCode: { $in: materialCodes },
    engineMake: String(engineMake || "").trim(),
    engineModel: String(engineModel || "").trim(),
    configuration: String(configuration || "").trim(),
    cylinderCount: String(cylinderCount || "").trim(),
    status: "Active",
  };

  const compatRows = await MaterialCompatibility.find(compatQuery).lean();

  if (!compatRows.length) {
    return [];
  }

  const numericEsn =
    esn === undefined || esn === null || esn === ""
      ? null
      : Number(esn);

  const filteredCompat = compatRows.filter((row) => {
    if (numericEsn === null || Number.isNaN(numericEsn)) {
      // No ESN constraint when lookup has no ESN
      return true;
    }

    const from = row.esnFrom ?? null;
    const to = row.esnTo ?? null;

    // If both bounds missing, treat as generally applicable
    if (from === null && to === null) return true;

    if (from !== null && numericEsn < from) return false;
    if (to !== null && numericEsn > to) return false;
    return true;
  });

  if (!filteredCompat.length) {
    return [];
  }

  const matchedMaterialCodes = [
    ...new Set(filteredCompat.map((r) => r.materialCode)),
  ];

  // 3. Fetch articles and suppliers
  const [articles, suppliers] = await Promise.all([
    Article.find({
      materialCode: { $in: matchedMaterialCodes },
      status: "Active",
    }).lean(),
    MaterialSupplier.find({
      materialCode: { $in: matchedMaterialCodes },
      status: "Active",
    }).lean(),
  ]);

  const articlesByMaterial = new Map();
  articles.forEach((a) => {
    const key = a.materialCode;
    if (!articlesByMaterial.has(key)) articlesByMaterial.set(key, []);
    articlesByMaterial.get(key).push(a);
  });

  const suppliersByMaterial = new Map();
  suppliers.forEach((s) => {
    const key = s.materialCode;
    if (!suppliersByMaterial.has(key)) suppliersByMaterial.set(key, []);
    suppliersByMaterial.get(key).push(s);
  });

  return matchedMaterialCodes.map((code) => {
    const material = materials.find((m) => m.materialCode === code);
    const materialArticles = articlesByMaterial.get(code) || [];
    const materialSuppliers = suppliersByMaterial.get(code) || [];

    return {
      materialCode: code,
      spn: material?.spn || spnTrimmed,
      shortDescription: material?.shortDescription || "",
      itemType: material?.itemType || "",
      unit: material?.unit || "",
      status: material?.status || "",
      articles: materialArticles.map((a) => ({
        articleNo: a.articleNo,
        description: a.description,
        drawingNo: a.drawingNo,
        maker: a.maker,
        brand: a.brand,
        unit: a.unit,
        weight: a.weight,
        hsnCode: a.hsnCode,
        status: a.status,
        remarks: a.remarks,
      })),
      suppliers: materialSuppliers.map((s) => ({
        supplierName: s.supplierName,
        supplierArticleNo: s.supplierArticleNo,
        supplierDescription: s.supplierDescription,
        currency: s.currency,
        purchasePrice: s.purchasePrice,
        leadTimeDays: s.leadTimeDays,
        moq: s.moq,
        supplierCountry: s.supplierCountry,
        preferred: s.preferred,
        status: s.status,
        remarks: s.remarks,
      })),
    };
  });
}

