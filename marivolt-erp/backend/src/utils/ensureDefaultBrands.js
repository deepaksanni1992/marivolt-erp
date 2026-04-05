import mongoose from "mongoose";
import Brand from "../models/Brand.js";
import Vertical from "../models/Vertical.js";
import Material from "../models/Material.js";
import MaterialCompatibility from "../models/MaterialCompatibility.js";
import { DEFAULT_BRANDS_PER_VERTICAL } from "../constants/masterValues.js";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create default catalog brands for one vertical (skips existing names, case-insensitive).
 */
export async function ensureDefaultBrandsForVertical(verticalId) {
  if (!verticalId || !mongoose.Types.ObjectId.isValid(String(verticalId))) {
    return;
  }
  const v = await Vertical.exists({ _id: verticalId });
  if (!v) return;

  for (const name of DEFAULT_BRANDS_PER_VERTICAL) {
    const exists = await Brand.findOne({
      vertical: verticalId,
      name: new RegExp(`^${escapeRegex(name)}$`, "i"),
    }).select("_id");
    if (!exists) {
      await Brand.create({
        vertical: verticalId,
        name,
        status: "Active",
      });
    }
  }
}

/** Default brands for every vertical in the database. */
export async function ensureDefaultBrandsForEveryVertical() {
  const verticals = await Vertical.find({}).select("_id").lean();
  for (const row of verticals) {
    await ensureDefaultBrandsForVertical(row._id);
  }
}

/**
 * Ensures a Brand row exists for each distinct compatibility.brand per material vertical.
 */
export async function ensureBrandsFromCompatibilityRows() {
  const rows = await MaterialCompatibility.find({})
    .select("materialCode brand")
    .lean();

  const seen = new Set();

  for (const row of rows) {
    const b = String(row.brand ?? "").trim();
    if (!b) continue;

    const mat = await Material.findOne({ materialCode: row.materialCode })
      .select("vertical")
      .lean();
    if (!mat?.vertical) continue;

    const key = `${mat.vertical}:${b.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const exists = await Brand.findOne({
      vertical: mat.vertical,
      name: new RegExp(`^${escapeRegex(b)}$`, "i"),
    }).select("_id");
    if (!exists) {
      await Brand.create({
        vertical: mat.vertical,
        name: b,
        status: "Active",
      });
    }
  }
}
