/**
 * One-off migration for existing databases:
 * - Ensures a default Vertical exists and assigns it to SPNs / materials missing `vertical`
 * - MaterialCompatibility: engineMake -> brand, applicabilityRemarks -> remarks
 * - MaterialSupplier: purchasePrice -> price
 * - Brands: default catalog under every vertical + extra brands from compatibility rows
 *
 * Optional env:
 *   MIGRATION_DEFAULT_VERTICAL_NAME  (default: "Legacy (migrated)")
 *
 * Run from backend folder: npm run migrate:item-master
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getOrCreateDefaultVertical(db) {
  const verticals = db.collection("verticals");
  const name =
    String(process.env.MIGRATION_DEFAULT_VERTICAL_NAME || "").trim() ||
    "Legacy (migrated)";

  const existing = await verticals.findOne({
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
  });
  if (existing) {
    return existing._id;
  }

  const now = new Date();
  const { insertedId } = await verticals.insertOne({
    name,
    status: "Active",
    createdAt: now,
    updatedAt: now,
  });
  return insertedId;
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const defaultVerticalId = await getOrCreateDefaultVertical(db);
  // eslint-disable-next-line no-console
  console.log("Default vertical id for legacy rows:", String(defaultVerticalId));

  const spns = db.collection("spns");
  const spnResult = await spns.updateMany(
    {
      $or: [{ vertical: { $exists: false } }, { vertical: null }],
    },
    { $set: { vertical: defaultVerticalId } }
  );
  // eslint-disable-next-line no-console
  console.log("SPN: assigned default vertical where missing", spnResult.modifiedCount);

  const compat = db.collection("materialcompatibilities");
  const compatResult = await compat.updateMany(
    {
      $and: [
        {
          $or: [
            { brand: { $exists: false } },
            { brand: null },
            { brand: "" },
          ],
        },
        { engineMake: { $exists: true, $nin: [null, ""] } },
      ],
    },
    [{ $set: { brand: "$engineMake" } }]
  );
  // eslint-disable-next-line no-console
  console.log("Compatibility: copied engineMake -> brand", compatResult.modifiedCount);

  await compat.updateMany(
    {
      $or: [
        { remarks: { $exists: false } },
        { remarks: null },
        { remarks: "" },
      ],
      applicabilityRemarks: { $exists: true },
    },
    [{ $set: { remarks: "$applicabilityRemarks" } }]
  );

  await compat.updateMany(
    {},
    { $unset: { engineMake: "", applicabilityRemarks: "" } }
  );

  const suppliers = db.collection("materialsuppliers");
  const supResult = await suppliers.updateMany(
    {
      $or: [{ price: { $exists: false } }, { price: null }],
      purchasePrice: { $exists: true },
    },
    [{ $set: { price: "$purchasePrice" } }]
  );
  // eslint-disable-next-line no-console
  console.log("Suppliers: copied purchasePrice -> price", supResult.modifiedCount);

  await suppliers.updateMany({}, { $unset: { purchasePrice: "" } });

  const materials = db.collection("materials");
  let materialFixed = 0;
  const matCursor = materials.find({
    $or: [{ vertical: { $exists: false } }, { vertical: null }],
  });
  for await (const m of matCursor) {
    const spnKey = m.spn != null ? String(m.spn).trim() : "";
    let verticalId = defaultVerticalId;
    if (spnKey) {
      const spnDoc = await spns.findOne(
        { spn: spnKey },
        { projection: { vertical: 1 } }
      );
      if (spnDoc && spnDoc.vertical) {
        verticalId = spnDoc.vertical;
      }
    }
    await materials.updateOne({ _id: m._id }, { $set: { vertical: verticalId } });
    materialFixed += 1;
  }
  // eslint-disable-next-line no-console
  console.log("Materials: assigned vertical where missing", materialFixed);

  const { ensureDefaultBrandsForEveryVertical, ensureBrandsFromCompatibilityRows } =
    await import("../src/utils/ensureDefaultBrands.js");
  await ensureDefaultBrandsForEveryVertical();
  await ensureBrandsFromCompatibilityRows();
  // eslint-disable-next-line no-console
  console.log(
    "Brands: default catalog per vertical + any brands referenced on compatibility rows"
  );

  // eslint-disable-next-line no-console
  console.log("Migration finished.");
  await mongoose.disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
