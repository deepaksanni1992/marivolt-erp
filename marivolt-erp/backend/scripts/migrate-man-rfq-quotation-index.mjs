/**
 * Production index replacement for MAN RFQ quotation idempotency.
 *
 * Default is dry-run (no writes). --apply is required for any mutation.
 * Abort instead of dropping indexes when duplicates or unexpected conflicts exist.
 *
 * Old index to replace if present:
 *   keys: { companyId: 1, manRfqIdempotencyKey: 1 }
 *   unique: true
 *   partialFilterExpression: { manRfqIdempotencyKey: { $type: "string", $gt: "" } }
 *   (no sourceType — typically named companyId_1_manRfqIdempotencyKey_1)
 *
 * Intended index:
 *   name: uniq_company_manRfqIdempotencyKey_manRfq
 *   keys: { companyId: 1, manRfqIdempotencyKey: 1 }
 *   unique: true
 *   partialFilterExpression: {
 *     sourceType: "MAN_RFQ",
 *     manRfqIdempotencyKey: { $type: "string", $gt: "" }
 *   }
 *
 * Dry-run: node scripts/migrate-man-rfq-quotation-index.mjs
 * Apply:   node scripts/migrate-man-rfq-quotation-index.mjs --apply
 */
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const NEW_NAME = "uniq_company_manRfqIdempotencyKey_manRfq";
const NEW_KEYS = { companyId: 1, manRfqIdempotencyKey: 1 };
const NEW_PARTIAL = {
  sourceType: "MAN_RFQ",
  manRfqIdempotencyKey: { $type: "string", $gt: "" },
};
const OLD_PARTIAL = { manRfqIdempotencyKey: { $type: "string", $gt: "" } };

if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../.env") });

function stable(value) {
  return JSON.stringify(value || {});
}

function sameKeys(idx) {
  const key = idx.key || {};
  const names = Object.keys(key);
  return names.length === 2 && key.companyId === 1 && key.manRfqIdempotencyKey === 1;
}

function isIntendedIndex(idx) {
  return (
    idx?.name === NEW_NAME &&
    idx?.unique === true &&
    sameKeys(idx) &&
    stable(idx.partialFilterExpression) === stable(NEW_PARTIAL)
  );
}

function isLegacyManRfqIndex(idx) {
  if (!sameKeys(idx) || !idx.unique || idx.name === NEW_NAME) return false;
  const pfe = idx.partialFilterExpression || {};
  const pfeJson = stable(pfe);
  if (pfeJson === stable(OLD_PARTIAL)) return true;
  if (idx.sparse === true) return true;
  if (!pfe.sourceType) return true;
  return false;
}

function isUnexpectedSameKeyIndex(idx) {
  if (!sameKeys(idx) || idx.name === NEW_NAME) return false;
  if (isLegacyManRfqIndex(idx)) return false;
  return true;
}

function summarizeIndex(idx) {
  return {
    name: idx.name,
    key: idx.key,
    unique: Boolean(idx.unique),
    sparse: idx.sparse,
    partialFilterExpression: idx.partialFilterExpression || null,
  };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const dbName = mongoose.connection.name;
  const col = mongoose.connection.collection("quotations");
  const indexes = await col.indexes();
  const intended = indexes.filter(isIntendedIndex);
  const legacy = indexes.filter(isLegacyManRfqIndex);
  const unexpected = indexes.filter(isUnexpectedSameKeyIndex);
  const namedWrong = indexes.find((idx) => idx.name === NEW_NAME && !isIntendedIndex(idx));

  const duplicates = await col
    .aggregate([
      {
        $match: {
          sourceType: "MAN_RFQ",
          manRfqIdempotencyKey: { $type: "string", $gt: "" },
        },
      },
      {
        $group: {
          _id: { companyId: "$companyId", manRfqIdempotencyKey: "$manRfqIdempotencyKey" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  console.log("mode:", apply ? "APPLY" : "DRY-RUN");
  console.log("database:", dbName);
  console.log("collection: quotations");
  console.log("existing quotation indexes:");
  console.log(JSON.stringify(indexes.map(summarizeIndex), null, 2));
  console.log("proposed index:");
  console.log(
    JSON.stringify(
      {
        name: NEW_NAME,
        key: NEW_KEYS,
        unique: true,
        partialFilterExpression: NEW_PARTIAL,
      },
      null,
      2
    )
  );
  console.log("legacy MAN RFQ indexes to replace:", legacy.map((i) => i.name).join(", ") || "(none)");
  console.log("intended index present:", intended.length === 1);
  console.log("duplicate qualifying MAN_RFQ keys:", duplicates.length);

  const blockers = [];
  if (namedWrong) {
    blockers.push(
      `Index ${NEW_NAME} exists with a different definition: ${stable(summarizeIndex(namedWrong))}`
    );
  }
  if (intended.length > 1) {
    blockers.push("Multiple indexes already match the intended definition");
  }
  if (unexpected.length) {
    blockers.push(
      `Unexpected unique/same-key index(es) will not be dropped: ${unexpected.map((i) => i.name).join(", ")}`
    );
  }
  if (duplicates.length) {
    blockers.push(
      `${duplicates.length} duplicate MAN_RFQ (companyId, manRfqIdempotencyKey) group(s) would prevent the unique partial index`
    );
  }

  if (blockers.length) {
    for (const b of blockers) console.error("ABORT:", b);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!apply) {
    console.log("dry-run only. No indexes were dropped or created. Re-run with --apply to mutate.");
    await mongoose.disconnect();
    return;
  }

  for (const idx of legacy) {
    console.log("dropping", idx.name);
    await col.dropIndex(idx.name);
  }
  if (!intended.length) {
    console.log("creating", NEW_NAME);
    await col.createIndex(NEW_KEYS, {
      unique: true,
      name: NEW_NAME,
      partialFilterExpression: NEW_PARTIAL,
    });
  } else {
    console.log("intended index already present; no create");
  }
  await mongoose.disconnect();
  console.log("done");
}

main().catch(async (err) => {
  console.error(err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
