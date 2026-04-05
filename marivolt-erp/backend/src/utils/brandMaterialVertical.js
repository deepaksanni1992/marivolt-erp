import Material from "../models/Material.js";
import Brand from "../models/Brand.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function resolveBrandNameForVertical(verticalId, brandInput) {
  const trimmed = String(brandInput ?? "").trim();
  if (!trimmed) {
    throw new Error("Brand is required");
  }

  const brandDoc = await Brand.findOne({
    vertical: verticalId,
    status: "Active",
    name: new RegExp(`^${escapeRegex(trimmed)}$`, "i"),
  })
    .select("name")
    .lean();

  if (!brandDoc) {
    throw new Error(
      "Brand not found for this vertical (create the brand under the material's vertical first)"
    );
  }

  return brandDoc.name;
}

/**
 * Ensures an active Brand exists for the material's vertical and returns canonical brand name.
 */
export async function resolveBrandNameForMaterial(materialCode, brandInput) {
  const material = await Material.findOne({
    materialCode: String(materialCode || "").trim(),
  })
    .select("vertical")
    .lean();

  if (!material) {
    throw new Error("Invalid materialCode reference in compatibility mapping");
  }

  return resolveBrandNameForVertical(material.vertical, brandInput);
}
