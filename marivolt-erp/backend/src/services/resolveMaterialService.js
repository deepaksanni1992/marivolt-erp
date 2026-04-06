import Material from "../models/Material.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import Article from "../models/Article.js";
import MaterialSupplier from "../models/MaterialSupplier.js";
import Brand from "../models/Brand.js";
import { resolveBrandNameForVertical } from "../utils/brandMaterialVertical.js";
import { resolveEngineModelNameForBrandId } from "../utils/compatibilityCanonical.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve material(s) for given SPN + brand + engine combination.
 *
 * @param {{ spn: string, brand?: string, engineMake?: string, engineModel: string, configuration: string, cylinderCount: string, esn?: number|null }} params
 * engineMake is accepted as a legacy alias for brand.
 */
export async function resolveMaterial(params) {
  const {
    spn,
    brand,
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

  const brandSource = brand ?? engineMake;
  const brandTrimmed = String(brandSource || "").trim();
  if (!brandTrimmed) {
    throw new Error("Brand is required");
  }

  const materials = await Material.find({
    spn: spnTrimmed,
    status: "Active",
  }).lean();

  if (!materials.length) {
    return [];
  }

  const verticalId = materials[0].vertical;
  let canonicalBrand;
  try {
    canonicalBrand = await resolveBrandNameForVertical(verticalId, brandTrimmed);
  } catch (e) {
    throw new Error(e.message);
  }

  const brandDoc = await Brand.findOne({
    vertical: verticalId,
    status: "Active",
    name: new RegExp(`^${escapeRegex(canonicalBrand)}$`, "i"),
  })
    .select("_id")
    .lean();

  if (!brandDoc) {
    throw new Error("Brand not found for this vertical");
  }

  let canonicalEngineModel;
  try {
    canonicalEngineModel = await resolveEngineModelNameForBrandId(
      brandDoc._id,
      engineModel
    );
  } catch (e) {
    throw new Error(e.message);
  }

  const materialCodes = materials.map((m) => m.materialCode);

  const compatQuery = {
    materialCode: { $in: materialCodes },
    brand: canonicalBrand,
    engineModel: canonicalEngineModel,
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
      return true;
    }

    const from = row.esnFrom ?? null;
    const to = row.esnTo ?? null;

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
        price: s.price ?? s.purchasePrice,
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
