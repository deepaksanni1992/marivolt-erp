/**
 * Phase 2 packing-label MongoDB collections/indexes.
 *
 * Default: DRY RUN. Creates nothing unless every apply guard is present.
 * Never drops, renames, or rebuilds indexes. Never calls syncIndexes.
 * Never inserts, updates, deletes, or transforms documents.
 * Never prints the MongoDB URI or credentials.
 *
 *   node scripts/ensurePackingLabelIndexes.mjs
 *   node scripts/ensurePackingLabelIndexes.mjs --apply --company-scope MAR --confirm EMPTY_NEW_COLLECTIONS
 *
 * Apply also requires NODE_ENV=production and MONGO_URI already configured.
 * --company-scope MAR is operator confirmation only; indexes remain global.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKING_LABEL_UNIT_COLLECTION = "packingLabelUnits";
export const PACKING_LABEL_SIGNING_KEY_COLLECTION = "packingLabelSigningKeys";
export const REQUIRED_COMPANY_SCOPE = "MAR";
export const REQUIRED_CONFIRM = "EMPTY_NEW_COLLECTIONS";
export const PACKING_LABEL_INDEX_CONFLICT = "PACKING_LABEL_INDEX_CONFLICT";
export const PACKING_LABEL_COLLECTION_NOT_EMPTY = "PACKING_LABEL_COLLECTION_NOT_EMPTY";
export const PACKING_LABEL_APPLY_GUARDS_MISSING = "PACKING_LABEL_APPLY_GUARDS_MISSING";

export const PACKING_LABEL_INDEX_SPECS = Object.freeze([
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_labelNo_1",
    key: Object.freeze({ companyId: 1, labelNo: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_barcodeValue_1",
    key: Object.freeze({ companyId: 1, barcodeValue: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_originKey_1",
    key: Object.freeze({ companyId: 1, originKey: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_allocationId_1_status_1",
    key: Object.freeze({ companyId: 1, allocationId: 1, status: 1 }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_packingId_1_status_1",
    key: Object.freeze({ companyId: 1, packingId: 1, status: 1 }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "companyId_1_firstPrintJobId_1",
    key: Object.freeze({ companyId: 1, firstPrintJobId: 1 }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "allocationId_1",
    key: Object.freeze({ allocationId: 1 }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_UNIT_COLLECTION,
    name: "status_1",
    key: Object.freeze({ status: 1 }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_SIGNING_KEY_COLLECTION,
    name: "companyId_1_keyId_1",
    key: Object.freeze({ companyId: 1, keyId: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: PACKING_LABEL_SIGNING_KEY_COLLECTION,
    name: "companyId_1",
    key: Object.freeze({ companyId: 1 }),
    unique: true,
    partialFilterExpression: Object.freeze({ status: "ACTIVE" }),
  }),
  Object.freeze({
    collection: PACKING_LABEL_SIGNING_KEY_COLLECTION,
    name: "status_1",
    key: Object.freeze({ status: 1 }),
  }),
]);

const TARGET_COLLECTIONS = Object.freeze([
  PACKING_LABEL_UNIT_COLLECTION,
  PACKING_LABEL_SIGNING_KEY_COLLECTION,
]);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function summarizeIndex(ix = {}) {
  return {
    name: ix.name || "",
    key: cloneJson(ix.key || {}),
    unique: ix.unique === true,
    sparse: ix.sparse === true,
    partialFilterExpression: ix.partialFilterExpression ? cloneJson(ix.partialFilterExpression) : null,
  };
}

export function specToApprovedIndex(spec) {
  return {
    collection: spec.collection,
    name: spec.name,
    key: cloneJson(spec.key),
    unique: spec.unique === true,
    sparse: false,
    partialFilterExpression: spec.partialFilterExpression ? cloneJson(spec.partialFilterExpression) : null,
  };
}

export function keysEqual(a = {}, b = {}) {
  const left = Object.entries(a);
  const right = Object.entries(b);
  if (left.length !== right.length) return false;
  return left.every(([field, dir], i) => right[i][0] === field && Number(right[i][1]) === Number(dir));
}

function partialEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function indexOptionsEqual(actual, spec) {
  const row = summarizeIndex(actual);
  return (
    row.unique === (spec.unique === true) &&
    row.sparse === (spec.sparse === true) &&
    partialEqual(row.partialFilterExpression, spec.partialFilterExpression || null)
  );
}

export function indexMatchesApprovedSpec(actual, spec) {
  if (!actual) return false;
  return keysEqual(actual.key, spec.key) && indexOptionsEqual(actual, spec);
}

export function parseEnsurePackingLabelIndexArgs(argv = []) {
  const parsed = { apply: false, companyScope: null, confirm: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (token === "--company-scope") {
      parsed.companyScope = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--company-scope=")) {
      parsed.companyScope = token.slice("--company-scope=".length);
      continue;
    }
    if (token === "--confirm") {
      parsed.confirm = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--confirm=")) {
      parsed.confirm = token.slice("--confirm=".length);
    }
  }
  return parsed;
}

export function evaluateApplyGuards({
  apply = false,
  companyScope = null,
  confirm = null,
  nodeEnv = "",
  uriConfigured = false,
} = {}) {
  const missing = [];
  if (!apply) missing.push("--apply");
  if (String(companyScope || "") !== REQUIRED_COMPANY_SCOPE) missing.push("--company-scope MAR");
  if (String(confirm || "") !== REQUIRED_CONFIRM) missing.push("--confirm EMPTY_NEW_COLLECTIONS");
  if (String(nodeEnv || "") !== "production") missing.push("NODE_ENV=production");
  if (!uriConfigured) missing.push("configured MongoDB URI");
  return { ok: missing.length === 0, missing };
}

export function redactSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text)
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, "[redacted-uri]")
    .replace(/(mongodb(\+srv)?:\/\/)[^"'\\s]+/gi, "$1[redacted-uri]")
    .replace(/([?&](authSource|username|password|ssl)=)[^&"'\\s]+/gi, "$1[redacted]")
    .replace(/\b(MONGO_URI|MONGODB_URI)\b(\s*[:=]\s*)\S+/gi, "$1$2[redacted]");
}

function createOptionsFromSpec(spec) {
  const options = { name: spec.name };
  if (spec.unique === true) options.unique = true;
  if (spec.partialFilterExpression) options.partialFilterExpression = cloneJson(spec.partialFilterExpression);
  return options;
}

export function evaluatePackingLabelIndexes(collections = {}) {
  const conflicts = [];
  const missing = [];
  const present = [];

  for (const spec of PACKING_LABEL_INDEX_SPECS) {
    const approved = specToApprovedIndex(spec);
    const indexes = (collections[spec.collection]?.indexes || []).filter((ix) => ix.name !== "_id_");
    const byName = indexes.find((ix) => ix.name === spec.name) || null;
    const equivalents = indexes.filter((ix) => indexMatchesApprovedSpec(ix, spec));

    if (byName && !indexMatchesApprovedSpec(byName, spec)) {
      conflicts.push({
        code: PACKING_LABEL_INDEX_CONFLICT,
        kind: "SAME_NAME_MISMATCH",
        collection: spec.collection,
        approved,
        existing: summarizeIndex(byName),
      });
      continue;
    }

    const equivalentOtherName = equivalents.find((ix) => ix.name !== spec.name);
    if (equivalentOtherName) {
      conflicts.push({
        code: PACKING_LABEL_INDEX_CONFLICT,
        kind: "EQUIVALENT_DIFFERENT_NAME",
        collection: spec.collection,
        approved,
        existing: summarizeIndex(equivalentOtherName),
      });
      continue;
    }

    if (byName && indexMatchesApprovedSpec(byName, spec)) {
      present.push(approved);
      continue;
    }

    missing.push(approved);
  }

  const nonemptyCollections = TARGET_COLLECTIONS.filter(
    (name) => Number(collections[name]?.documentCount || 0) > 0
  );
  const existence = Object.fromEntries(
    TARGET_COLLECTIONS.map((name) => [
      name,
      {
        exists: collections[name]?.exists === true,
        documentCount: Number(collections[name]?.documentCount || 0),
      },
    ])
  );

  let result = "READY";
  let errorCode = null;
  if (conflicts.length) {
    result = "BLOCKED_CONFLICT";
    errorCode = PACKING_LABEL_INDEX_CONFLICT;
  } else if (missing.length && nonemptyCollections.length) {
    result = "BLOCKED_NONEMPTY";
    errorCode = PACKING_LABEL_COLLECTION_NOT_EMPTY;
  } else if (missing.length) {
    result = "EMPTY_NEEDS_INDEX_CREATION";
  }

  return {
    existence,
    nonemptyCollections,
    present,
    proposedMissingIndexes: missing,
    conflicts,
    result,
    errorCode,
  };
}

async function collectionExists(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return rows.length > 0;
}

async function countDocumentsSafe(col) {
  if (typeof col.countDocuments === "function") return col.countDocuments({});
  if (typeof col.estimatedDocumentCount === "function") return col.estimatedDocumentCount();
  return 0;
}

export async function inspectPackingLabelCollections(db) {
  const collections = {};
  for (const name of TARGET_COLLECTIONS) {
    const exists = await collectionExists(db, name);
    let documentCount = 0;
    let indexes = [];
    if (exists) {
      const col = db.collection(name);
      documentCount = await countDocumentsSafe(col);
      indexes = (await col.indexes()).map(summarizeIndex);
    }
    collections[name] = { exists, documentCount, indexes };
  }
  return collections;
}

async function createMissingApprovedIndexes(db, missing) {
  const created = [];
  for (const spec of missing) {
    const col = db.collection(spec.collection);
    await col.createIndex(spec.key, createOptionsFromSpec(spec));
    created.push(spec);
  }
  return created;
}

function existingIndexesByCollection(collections) {
  return Object.fromEntries(
    TARGET_COLLECTIONS.map((name) => [name, (collections[name]?.indexes || []).map(summarizeIndex)])
  );
}

export async function runEnsurePackingLabelIndexes({
  db,
  argv = [],
  nodeEnv = "",
  uriConfigured = false,
} = {}) {
  if (!db) throw new Error("database handle required");
  const args = parseEnsurePackingLabelIndexArgs(argv);
  const guards = evaluateApplyGuards({
    apply: args.apply,
    companyScope: args.companyScope,
    confirm: args.confirm,
    nodeEnv,
    uriConfigured,
  });
  const applyAuthorized = guards.ok;
  const mode = applyAuthorized ? "APPLY" : "DRY_RUN";

  const collections = await inspectPackingLabelCollections(db);
  const evaluation = evaluatePackingLabelIndexes(collections);

  const report = {
    mode,
    databaseName: String(db.databaseName || ""),
    applyRequested: args.apply === true,
    applyAuthorized,
    applyGuards: {
      apply: args.apply === true,
      companyScope: args.companyScope || null,
      confirm: args.confirm || null,
      nodeEnvProduction: String(nodeEnv || "") === "production",
      uriConfigured: uriConfigured === true,
      missing: guards.missing,
    },
    collections: Object.fromEntries(
      TARGET_COLLECTIONS.map((name) => [
        name,
        {
          exists: collections[name].exists,
          documentCount: collections[name].documentCount,
        },
      ])
    ),
    existingIndexes: existingIndexesByCollection(collections),
    proposedMissingIndexes: evaluation.proposedMissingIndexes,
    conflicts: evaluation.conflicts,
    indexesCreated: [],
    postApplyIndexes: null,
    result: evaluation.result,
    errorCode: evaluation.errorCode,
  };

  if (args.apply && !applyAuthorized) {
    report.errorCode = report.errorCode || PACKING_LABEL_APPLY_GUARDS_MISSING;
    return report;
  }

  if (!applyAuthorized) return report;
  if (evaluation.result === "BLOCKED_CONFLICT" || evaluation.result === "BLOCKED_NONEMPTY") {
    return report;
  }

  if (evaluation.proposedMissingIndexes.length) {
    report.indexesCreated = await createMissingApprovedIndexes(db, evaluation.proposedMissingIndexes);
  }

  const after = await inspectPackingLabelCollections(db);
  const afterEval = evaluatePackingLabelIndexes(after);
  report.postApplyIndexes = existingIndexesByCollection(after);
  report.collections = Object.fromEntries(
    TARGET_COLLECTIONS.map((name) => [
      name,
      {
        exists: after[name].exists,
        documentCount: after[name].documentCount,
      },
    ])
  );
  report.result = afterEval.result;
  report.errorCode = afterEval.errorCode;
  report.proposedMissingIndexes = afterEval.proposedMissingIndexes;
  report.conflicts = afterEval.conflicts;
  return report;
}

export function exitCodeForReport(report) {
  if (!report) return 1;
  if (report.result === "READY") return 0;
  if (report.result === "EMPTY_NEEDS_INDEX_CREATION") return 2;
  if (report.result === "BLOCKED_CONFLICT") return 3;
  if (report.result === "BLOCKED_NONEMPTY") return 4;
  return 1;
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      path.normalize(fileURLToPath(import.meta.url)).toLowerCase() ===
      path.normalize(path.resolve(entry)).toLowerCase()
    );
  } catch {
    return false;
  }
}

async function connectAndRun() {
  const { default: mongoose } = await import("mongoose");
  await import("../src/loadEnv.js");
  mongoose.set("autoIndex", false);
  const uriConfigured = Boolean(process.env.MONGO_URI || process.env.MONGODB_URI);
  if (!uriConfigured) {
    const report = {
      mode: "DRY_RUN",
      databaseName: "",
      applyRequested: parseEnsurePackingLabelIndexArgs(process.argv.slice(2)).apply,
      result: "BLOCKED_CONFLICT",
      errorCode: "MONGO_URI_NOT_CONFIGURED",
      conflicts: [],
      indexesCreated: [],
      proposedMissingIndexes: [],
    };
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 20000,
    });
    const report = await runEnsurePackingLabelIndexes({
      db: mongoose.connection.db,
      argv: process.argv.slice(2),
      nodeEnv: process.env.NODE_ENV,
      uriConfigured: true,
    });
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    await mongoose.disconnect();
    process.exit(exitCodeForReport(report));
  } catch (err) {
    console.error(redactSecrets(String(err?.message || err)));
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

if (isExecutedDirectly()) {
  connectAndRun();
}
