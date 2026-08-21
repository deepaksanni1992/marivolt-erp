/**
 * CustomsBoe legal identity index — companyId + normalizedBoeNumber.
 *
 * Production must NOT rely on Mongoose autoIndex.
 * Create only via migration after backfill + collision check:
 *   npm run migrate:customs-boe-identity-indexes
 *   npm run migrate:customs-boe-identity-indexes -- --execute
 *
 * Boot verifies presence and warns; it does not create this unique index.
 *
 * Partial filter uses the same MongoDB 6+ / Atlas-supported operators as
 * receivingUnitPhotos_retry_idempotency: { $type: "string", $gt: "" }.
 * CANCELLED parents remain in the unique set — legal BOE number is never freed.
 */
import { findMatchingIndex, indexSatisfiesSpec } from "./receivingInspectionIndexes.js";

export const CUSTOMS_BOE_COLLECTION = "customsboes";
export const CUSTOMS_BOE_NORMALIZED_IDENTITY_INDEX = "customsBoe_company_normalizedBoeNumber_unique";

/**
 * Non-empty string only — excludes missing/null/"" legacy rows until backfilled.
 * Does NOT filter by status (CANCELLED still occupies the legal identity).
 */
export function customsBoeNormalizedIdentityPartialFilter() {
  return {
    normalizedBoeNumber: { $type: "string", $gt: "" },
  };
}

export const CUSTOMS_BOE_IDENTITY_INDEX_SPECS = Object.freeze([
  {
    collection: CUSTOMS_BOE_COLLECTION,
    name: CUSTOMS_BOE_NORMALIZED_IDENTITY_INDEX,
    key: { companyId: 1, normalizedBoeNumber: 1 },
    unique: true,
    partialFilterExpression: customsBoeNormalizedIdentityPartialFilter(),
  },
]);

export function evaluateCustomsBoeIdentityIndexInventory(indexesByCollection = {}) {
  const results = [];
  for (const spec of CUSTOMS_BOE_IDENTITY_INDEX_SPECS) {
    const indexes = indexesByCollection[spec.collection] || [];
    const found = findMatchingIndex(indexes, spec);
    const ok = indexSatisfiesSpec(found, spec);
    results.push({
      collection: spec.collection,
      name: spec.name,
      unique: spec.unique === true,
      required: true,
      present: Boolean(found),
      ok,
      missing: !found,
      mismatch: Boolean(found) && !ok,
      partialFilterExpression: spec.partialFilterExpression || null,
      key: spec.key,
    });
  }
  const missing = results.filter((r) => !r.ok);
  return { ok: missing.length === 0, missing, results };
}

/**
 * Ensure/verify CustomsBoe identity index.
 * Default create=false — boot and dry-run must not mutate.
 */
export async function ensureCustomsBoeIdentityIndexes(db, { create = false } = {}) {
  const report = [];
  for (const spec of CUSTOMS_BOE_IDENTITY_INDEX_SPECS) {
    const coll = db.collection(spec.collection);
    let indexes = [];
    try {
      indexes = await coll.indexes();
    } catch (err) {
      if (err?.codeName !== "NamespaceNotFound" && Number(err?.code) !== 26) throw err;
    }
    const found = findMatchingIndex(indexes, spec);
    if (found && indexSatisfiesSpec(found, spec)) {
      report.push({ name: found.name || spec.name, collection: spec.collection, action: "exists" });
      continue;
    }
    if (!create) {
      report.push({ name: spec.name, collection: spec.collection, action: "missing" });
      continue;
    }
    const options = { name: spec.name, unique: spec.unique === true };
    if (spec.partialFilterExpression) options.partialFilterExpression = spec.partialFilterExpression;
    await coll.createIndex(spec.key, options);
    report.push({ name: spec.name, collection: spec.collection, action: "created" });
  }
  return report;
}
