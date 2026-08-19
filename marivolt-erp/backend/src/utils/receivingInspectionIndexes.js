/**
 * Phase 3A Mongo index specs — shared by schema, migrate script, verify tests.
 *
 * Production Atlas must not rely on Mongoose autoIndex.
 * Mongoose disables autoIndex when NODE_ENV=production; this ERP never sets autoIndex true
 * on connect. Create/verify with:
 *   node scripts/migrate-receiving-inspection-indexes.mjs
 *   node scripts/migrate-receiving-inspection-indexes.mjs --execute
 *
 * Partial unique `$in` on status matches the proven P0.3 allocation indexes
 * (MongoDB 6+ / Atlas 8.x).
 */

export const RECEIVING_SESSION_COLLECTION = "receivingSessions";
export const RECEIVING_SESSION_UNIT_COLLECTION = "receivingSessionUnits";
export const RECEIVING_UNIT_PHOTO_COLLECTION = "receivingUnitPhotos";
export const RECEIVING_UNIT_COLLECTION = "receivingUnits";

export const RECEIVING_SESSION_NO_INDEX = "receivingSessions_company_sessionNo";
export const RECEIVING_SESSION_ACTIVE_INDEX = "receivingSessions_one_active_per_asn";
export const RECEIVING_SESSION_UNIT_UNIQUE_INDEX = "receivingSessionUnits_one_ru_per_session";
export const RECEIVING_PHOTO_RETRY_INDEX = "receivingUnitPhotos_retry_idempotency";
export const RECEIVING_UNIT_BARCODE_INDEX_KEY = Object.freeze({ companyId: 1, barcodeValue: 1 });

export const RECEIVING_SESSION_ACTIVE_STATUSES = Object.freeze(["DRAFT", "IN_PROGRESS"]);

/** MongoDB 6+ / Atlas: `$in` on string status is supported (same pattern as allocation uniqueness). */
export function receivingSessionActivePartialFilter() {
  return { status: { $in: [...RECEIVING_SESSION_ACTIVE_STATUSES] } };
}

/** Non-empty clientUploadId only — retries reuse the same unique slot. */
export function receivingPhotoRetryPartialFilter() {
  return { clientUploadId: { $type: "string", $gt: "" } };
}

export const RECEIVING_INSPECTION_INDEX_SPECS = Object.freeze([
  {
    collection: RECEIVING_SESSION_COLLECTION,
    name: RECEIVING_SESSION_NO_INDEX,
    key: { companyId: 1, sessionNo: 1 },
    unique: true,
  },
  {
    collection: RECEIVING_SESSION_COLLECTION,
    name: RECEIVING_SESSION_ACTIVE_INDEX,
    key: { companyId: 1, asnId: 1 },
    unique: true,
    partialFilterExpression: receivingSessionActivePartialFilter(),
  },
  {
    collection: RECEIVING_SESSION_UNIT_COLLECTION,
    name: RECEIVING_SESSION_UNIT_UNIQUE_INDEX,
    key: { companyId: 1, receivingSessionId: 1, receivingUnitId: 1 },
    unique: true,
  },
  {
    collection: RECEIVING_UNIT_PHOTO_COLLECTION,
    name: RECEIVING_PHOTO_RETRY_INDEX,
    key: { companyId: 1, receivingSessionUnitId: 1, clientUploadId: 1 },
    unique: true,
    partialFilterExpression: receivingPhotoRetryPartialFilter(),
  },
]);

/** Phase 2 barcode uniqueness — match by key, do not rename an existing index. */
export const RECEIVING_UNIT_BARCODE_INDEX_SPEC = Object.freeze({
  collection: RECEIVING_UNIT_COLLECTION,
  name: "companyId_1_barcodeValue_1",
  key: RECEIVING_UNIT_BARCODE_INDEX_KEY,
  unique: true,
  matchByKey: true,
});

function keysEqual(a = {}, b = {}) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Number(a[k]) === Number(b[k]));
}

function partialEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function findMatchingIndex(indexes = [], spec) {
  const byName = (indexes || []).find((row) => row.name === spec.name);
  if (byName) return byName;
  return (indexes || []).find(
    (row) =>
      keysEqual(row.key, spec.key) &&
      Boolean(row.unique) === Boolean(spec.unique) &&
      (spec.partialFilterExpression
        ? partialEqual(row.partialFilterExpression, spec.partialFilterExpression)
        : true)
  );
}

export function indexSatisfiesSpec(row, spec) {
  if (!row) return false;
  if (!keysEqual(row.key, spec.key)) return false;
  if (Boolean(row.unique) !== Boolean(spec.unique)) return false;
  if (spec.partialFilterExpression && !partialEqual(row.partialFilterExpression, spec.partialFilterExpression)) {
    return false;
  }
  return true;
}

export function evaluateIndexInventory(indexesByCollection = {}) {
  const results = [];
  for (const spec of [...RECEIVING_INSPECTION_INDEX_SPECS, RECEIVING_UNIT_BARCODE_INDEX_SPEC]) {
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
  return {
    ok: missing.length === 0,
    missing,
    results,
  };
}

/**
 * Idempotent create. Never drops unrelated indexes.
 * If a compatible index already exists (name or key+unique+partial), skip.
 */
export async function ensureReceivingInspectionIndexes(db, { create = true } = {}) {
  const report = [];
  for (const spec of [...RECEIVING_INSPECTION_INDEX_SPECS, RECEIVING_UNIT_BARCODE_INDEX_SPEC]) {
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
    if (found && spec.matchByKey) {
      report.push({
        name: found.name || spec.name,
        collection: spec.collection,
        action: "mismatch",
      });
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
