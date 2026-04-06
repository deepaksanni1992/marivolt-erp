import Material from "../models/Material.js";
import Brand from "../models/Brand.js";
import EngineModel from "../models/EngineModel.js";
import { resolveBrandNameForMaterial } from "./brandMaterialVertical.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical engine model name for a brand (ObjectId), Active only.
 */
export async function resolveEngineModelNameForBrandId(brandId, engineModelInput) {
  const trimmed = String(engineModelInput ?? "").trim();
  if (!trimmed) {
    throw new Error("Engine model is required");
  }

  const doc = await EngineModel.findOne({
    brand: brandId,
    status: "Active",
    name: new RegExp(`^${escapeRegex(trimmed)}$`, "i"),
  })
    .select("name")
    .lean();

  if (!doc) {
    throw new Error(
      "Engine model not found for this brand (add it under Engine models master)"
    );
  }

  return doc.name;
}

/**
 * Resolves brand + engine model strings for a compatibility row against masters.
 */
export async function canonicalizeCompatibilityPayload(payload) {
  const canonicalBrand = await resolveBrandNameForMaterial(
    payload.materialCode,
    payload.brand
  );

  const material = await Material.findOne({
    materialCode: String(payload.materialCode || "").trim(),
  })
    .select("vertical")
    .lean();

  if (!material) {
    throw new Error("Invalid materialCode reference in compatibility mapping");
  }

  const brandDoc = await Brand.findOne({
    vertical: material.vertical,
    status: "Active",
    name: new RegExp(`^${escapeRegex(canonicalBrand)}$`, "i"),
  })
    .select("_id")
    .lean();

  if (!brandDoc) {
    throw new Error("Brand not found for this vertical");
  }

  const canonicalEngineModel = await resolveEngineModelNameForBrandId(
    brandDoc._id,
    payload.engineModel
  );

  return {
    ...payload,
    brand: canonicalBrand,
    engineModel: canonicalEngineModel,
  };
}
