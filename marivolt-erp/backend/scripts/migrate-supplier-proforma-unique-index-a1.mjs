/**
 * A1 — Controlled unique index for active Supplier Proformas.
 * Default: dry-run. Execute: node scripts/migrate-supplier-proforma-unique-index-a1.mjs --execute
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX } from "../src/utils/supplierProforma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");

function mask(s) {
  const t = String(s ?? "");
  if (t.length <= 4) return "****";
  return `${t.slice(0, 2)}…${t.slice(-2)}`;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== A1 Supplier Proforma unique index ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const coll = db.collection("supplierproformas");

  const dups = await coll
    .aggregate([
      {
        $match: {
          documentStatus: { $in: ["DRAFT", "RECEIVED", "APPROVED"] },
          normalizedSupplierProformaNo: { $type: "string" },
        },
      },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            supplierId: "$supplierId",
            norm: "$normalizedSupplierProformaNo",
          },
          n: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    indexSpec: SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX,
    activeDuplicateGroups: dups.length,
    samples: dups.slice(0, 20).map((g) => ({
      companyId: mask(g._id.companyId),
      supplierId: mask(g._id.supplierId),
      norm: mask(g._id.norm),
      n: g.n,
    })),
  };
  const outPath = path.join(evidenceDir, `supplier-proforma-index-a1-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  console.log("Duplicate active groups:", dups.length);
  console.log("Evidence:", outPath);

  if (dups.length) {
    console.error("ABORT: active duplicates exist. Resolve before creating unique index.");
    await mongoose.disconnect();
    process.exit(2);
  }

  if (!EXECUTE) {
    console.log("Dry-run OK — re-run with --execute to create index.");
    await mongoose.disconnect();
    return;
  }

  const existing = await coll.indexes();
  if (existing.some((i) => i.name === SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.name)) {
    console.log("Index already exists:", SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.name);
  } else {
    await coll.createIndex(SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.key, {
      name: SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.name,
      unique: true,
      partialFilterExpression: SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.partialFilterExpression,
    });
    console.log("Created index:", SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.name);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
