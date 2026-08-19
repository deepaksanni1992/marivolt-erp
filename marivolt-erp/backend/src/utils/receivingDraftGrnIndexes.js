/**
 * Phase 4B — unique GRN index: one active ASN_RECEIVING GRN per receiving session.
 *
 * Production Atlas must not rely on Mongoose autoIndex.
 *   node scripts/migrate-asn-receiving-grn-indexes.mjs
 *   node scripts/migrate-asn-receiving-grn-indexes.mjs --execute
 */
import { findMatchingIndex, indexSatisfiesSpec } from "./receivingInspectionIndexes.js";
import { GRN_ACTIVE_ASN_RECEIVING_STATUSES } from "./grnReceiptQty.js";

export const GRN_COLLECTION = "grns";
export const GRN_ASN_RECEIVING_SESSION_UNIQUE_INDEX = "grns_one_active_asn_receiving_session";

export function asnReceivingGrnSessionPartialFilter() {
  return {
    receivingSessionId: { $type: "objectId" },
    status: { $in: [...GRN_ACTIVE_ASN_RECEIVING_STATUSES] },
  };
}

export const ASN_RECEIVING_GRN_INDEX_SPECS = Object.freeze([
  {
    collection: GRN_COLLECTION,
    name: GRN_ASN_RECEIVING_SESSION_UNIQUE_INDEX,
    key: { companyId: 1, receivingSessionId: 1 },
    unique: true,
    partialFilterExpression: asnReceivingGrnSessionPartialFilter(),
  },
]);

export function evaluateAsnReceivingGrnIndexInventory(indexesByCollection = {}) {
  const results = [];
  for (const spec of ASN_RECEIVING_GRN_INDEX_SPECS) {
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

export async function ensureAsnReceivingGrnIndexes(db, { create = true } = {}) {
  const report = [];
  for (const spec of ASN_RECEIVING_GRN_INDEX_SPECS) {
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
