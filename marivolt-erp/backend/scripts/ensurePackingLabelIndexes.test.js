/**
 * Local tests for ensurePackingLabelIndexes.mjs.
 * Uses an in-memory fake database only. Never connects to production.
 *
 * Run: node scripts/ensurePackingLabelIndexes.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKING_LABEL_APPLY_GUARDS_MISSING,
  PACKING_LABEL_COLLECTION_NOT_EMPTY,
  PACKING_LABEL_INDEX_CONFLICT,
  PACKING_LABEL_INDEX_SPECS,
  PACKING_LABEL_SIGNING_KEY_COLLECTION,
  PACKING_LABEL_UNIT_COLLECTION,
  evaluatePackingLabelIndexes,
  indexMatchesApprovedSpec,
  parseEnsurePackingLabelIndexArgs,
  redactSecrets,
  runEnsurePackingLabelIndexes,
} from "./ensurePackingLabelIndexes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "ensurePackingLabelIndexes.mjs");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");

const APPLY_ARGV = ["--apply", "--company-scope", "MAR", "--confirm", "EMPTY_NEW_COLLECTIONS"];
const APPLY_ENV = { nodeEnv: "production", uriConfigured: true };

const MUTATION_METHODS = [
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "bulkWrite",
  "drop",
  "dropIndex",
  "dropIndexes",
  "rename",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultIdIndex() {
  return { name: "_id_", key: { _id: 1 }, unique: false, sparse: false };
}

class FakeCollection {
  constructor(name, { exists = false, documentCount = 0, indexes = [] } = {}) {
    this.collectionName = name;
    this.exists = exists;
    this.documentCount = documentCount;
    this._indexes = indexes.map(clone);
    this.calls = { createIndex: [], createIndexes: [] };
    for (const method of MUTATION_METHODS) {
      this.calls[method] = [];
      this[method] = async (...args) => {
        this.calls[method].push(args);
        throw new Error(`unexpected mutation: ${method}`);
      };
    }
  }

  async indexes() {
    if (!this.exists) {
      const err = new Error("ns does not exist");
      err.codeName = "NamespaceNotFound";
      err.code = 26;
      throw err;
    }
    return this._indexes.map(clone);
  }

  async countDocuments() {
    return this.documentCount;
  }

  async estimatedDocumentCount() {
    return this.documentCount;
  }

  async createIndex(key, options = {}) {
    this.calls.createIndex.push({ key: clone(key), options: clone(options) });
    if (!this.exists) {
      this.exists = true;
      this._indexes = [defaultIdIndex()];
    }
    this._indexes.push({
      name: options.name || "unnamed",
      key: clone(key),
      unique: options.unique === true,
      sparse: options.sparse === true,
      partialFilterExpression: options.partialFilterExpression || null,
    });
    return options.name;
  }

  async createIndexes(specs) {
    this.calls.createIndexes.push(clone(specs));
    const names = [];
    for (const spec of specs) names.push(await this.createIndex(spec.key, spec));
    return names;
  }
}

class FakeDb {
  constructor(state = {}) {
    this.databaseName = "packing-label-index-test";
    this.collections = {
      [PACKING_LABEL_UNIT_COLLECTION]: new FakeCollection(
        PACKING_LABEL_UNIT_COLLECTION,
        state[PACKING_LABEL_UNIT_COLLECTION] || {}
      ),
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: new FakeCollection(
        PACKING_LABEL_SIGNING_KEY_COLLECTION,
        state[PACKING_LABEL_SIGNING_KEY_COLLECTION] || {}
      ),
    };
  }

  collection(name) {
    if (!this.collections[name]) {
      this.collections[name] = new FakeCollection(name, {});
    }
    return this.collections[name];
  }

  listCollections(filter = {}) {
    const wanted = filter?.name;
    return {
      toArray: async () =>
        Object.values(this.collections)
          .filter((col) => col.exists && (!wanted || col.collectionName === wanted))
          .map((col) => ({ name: col.collectionName })),
    };
  }

  mutationCallCount() {
    let n = 0;
    for (const col of Object.values(this.collections)) {
      for (const method of MUTATION_METHODS) n += col.calls[method].length;
    }
    return n;
  }

  createIndexCount() {
    return Object.values(this.collections).reduce((n, col) => n + col.calls.createIndex.length, 0);
  }

  createdIndexNames() {
    return Object.values(this.collections).flatMap((col) =>
      col.calls.createIndex.map((row) => `${col.collectionName}.${row.options.name}`)
    );
  }
}

function assertNoSecrets(text) {
  const blob = String(text);
  assert.equal(/mongodb(\+srv)?:\/\//i.test(blob), false);
  assert.equal(/:[^:@/\s]+@/.test(blob), false);
}

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

console.log("ensurePackingLabelIndexes.test.js");

await run("1. dry-run is default", async () => {
  const parsed = parseEnsurePackingLabelIndexArgs([]);
  assert.equal(parsed.apply, false);
  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: [] });
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.applyRequested, false);
  assert.equal(report.applyAuthorized, false);
});

await run("2. dry-run creates nothing", async () => {
  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: [] });
  assert.equal(db.createIndexCount(), 0);
  assert.equal(report.indexesCreated.length, 0);
  assert.equal(report.postApplyIndexes, null);
});

await run("3. missing apply guards create nothing", async () => {
  const cases = [
    ["--apply"],
    ["--apply", "--company-scope", "MAR"],
    ["--apply", "--confirm", "EMPTY_NEW_COLLECTIONS"],
    ["--apply", "--company-scope", "OKE", "--confirm", "EMPTY_NEW_COLLECTIONS"],
  ];
  for (const argv of cases) {
    const db = new FakeDb();
    const report = await runEnsurePackingLabelIndexes({
      db,
      argv,
      nodeEnv: "production",
      uriConfigured: true,
    });
    assert.equal(report.mode, "DRY_RUN", argv.join(" "));
    assert.equal(db.createIndexCount(), 0, argv.join(" "));
    assert.equal(report.indexesCreated.length, 0);
  }

  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({
    db,
    argv: APPLY_ARGV,
    nodeEnv: "development",
    uriConfigured: true,
  });
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.errorCode, PACKING_LABEL_APPLY_GUARDS_MISSING);
  assert.equal(db.createIndexCount(), 0);
});

await run("4. absent collections report EMPTY_NEEDS_INDEX_CREATION", async () => {
  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: [] });
  assert.equal(report.result, "EMPTY_NEEDS_INDEX_CREATION");
  assert.equal(report.collections[PACKING_LABEL_UNIT_COLLECTION].exists, false);
  assert.equal(report.collections[PACKING_LABEL_SIGNING_KEY_COLLECTION].exists, false);
  assert.equal(report.proposedMissingIndexes.length, PACKING_LABEL_INDEX_SPECS.length);
});

await run("5. apply creates exactly the approved indexes", async () => {
  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.mode, "APPLY");
  assert.equal(report.result, "READY");
  assert.equal(report.indexesCreated.length, PACKING_LABEL_INDEX_SPECS.length);
  assert.equal(db.createIndexCount(), PACKING_LABEL_INDEX_SPECS.length);

  const createdNames = db.createdIndexNames().sort();
  const expectedNames = PACKING_LABEL_INDEX_SPECS.map((spec) => `${spec.collection}.${spec.name}`).sort();
  assert.deepEqual(createdNames, expectedNames);

  for (const spec of PACKING_LABEL_INDEX_SPECS) {
    const created = db.collection(spec.collection).calls.createIndex.find((row) => row.options.name === spec.name);
    assert.ok(created, spec.name);
    assert.deepEqual(created.key, { ...spec.key });
    assert.equal(created.options.unique, spec.unique === true ? true : undefined);
    assert.equal("sparse" in created.options, false);
    if (spec.partialFilterExpression) {
      assert.deepEqual(created.options.partialFilterExpression, { ...spec.partialFilterExpression });
    } else {
      assert.equal("partialFilterExpression" in created.options, false);
    }
  }

  const unitNames = report.postApplyIndexes[PACKING_LABEL_UNIT_COLLECTION]
    .filter((ix) => ix.name !== "_id_")
    .map((ix) => ix.name)
    .sort();
  const keyNames = report.postApplyIndexes[PACKING_LABEL_SIGNING_KEY_COLLECTION]
    .filter((ix) => ix.name !== "_id_")
    .map((ix) => ix.name)
    .sort();
  assert.deepEqual(
    unitNames,
    PACKING_LABEL_INDEX_SPECS.filter((s) => s.collection === PACKING_LABEL_UNIT_COLLECTION)
      .map((s) => s.name)
      .sort()
  );
  assert.deepEqual(
    keyNames,
    PACKING_LABEL_INDEX_SPECS.filter((s) => s.collection === PACKING_LABEL_SIGNING_KEY_COLLECTION)
      .map((s) => s.name)
      .sort()
  );
});

await run("6. apply is idempotent", async () => {
  const db = new FakeDb();
  const first = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(first.result, "READY");
  const createdFirst = db.createIndexCount();
  const second = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(second.result, "READY");
  assert.equal(second.indexesCreated.length, 0);
  assert.equal(db.createIndexCount(), createdFirst);
});

await run("7. same-name conflicting index blocks", async () => {
  const db = new FakeDb({
    [PACKING_LABEL_UNIT_COLLECTION]: {
      exists: true,
      documentCount: 0,
      indexes: [
        defaultIdIndex(),
        { name: "companyId_1_labelNo_1", key: { companyId: 1 }, unique: true, sparse: false },
      ],
    },
  });
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, "BLOCKED_CONFLICT");
  assert.equal(report.errorCode, PACKING_LABEL_INDEX_CONFLICT);
  assert.equal(report.conflicts[0].kind, "SAME_NAME_MISMATCH");
  assert.equal(db.createIndexCount(), 0);
});

await run("8. equivalent differently named index blocks", async () => {
  const db = new FakeDb({
    [PACKING_LABEL_UNIT_COLLECTION]: {
      exists: true,
      documentCount: 0,
      indexes: [
        defaultIdIndex(),
        {
          name: "units_label_no_unique",
          key: { companyId: 1, labelNo: 1 },
          unique: true,
          sparse: false,
        },
      ],
    },
  });
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, "BLOCKED_CONFLICT");
  assert.equal(report.errorCode, PACKING_LABEL_INDEX_CONFLICT);
  assert.equal(report.conflicts[0].kind, "EQUIVALENT_DIFFERENT_NAME");
  assert.equal(report.conflicts[0].existing.name, "units_label_no_unique");
  assert.equal(db.createIndexCount(), 0);
});

await run("9. nonempty collection blocks", async () => {
  const db = new FakeDb({
    [PACKING_LABEL_UNIT_COLLECTION]: {
      exists: true,
      documentCount: 1,
      indexes: [defaultIdIndex()],
    },
  });
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, "BLOCKED_NONEMPTY");
  assert.equal(report.errorCode, PACKING_LABEL_COLLECTION_NOT_EMPTY);
  assert.equal(db.createIndexCount(), 0);
});

await run("10. partial ACTIVE unique index matches exactly", async () => {
  const spec = PACKING_LABEL_INDEX_SPECS.find((row) => row.name === "companyId_1");
  assert.deepEqual(spec.partialFilterExpression, { status: "ACTIVE" });
  assert.equal(spec.unique, true);

  assert.equal(
    indexMatchesApprovedSpec(
      {
        name: "companyId_1",
        key: { companyId: 1 },
        unique: true,
        partialFilterExpression: { status: "ACTIVE" },
      },
      spec
    ),
    true
  );
  assert.equal(
    indexMatchesApprovedSpec(
      { name: "companyId_1", key: { companyId: 1 }, unique: true },
      spec
    ),
    false
  );
  assert.equal(
    indexMatchesApprovedSpec(
      {
        name: "companyId_1",
        key: { companyId: 1 },
        unique: true,
        partialFilterExpression: { status: "VERIFY_ONLY" },
      },
      spec
    ),
    false
  );
  assert.equal(
    indexMatchesApprovedSpec(
      {
        name: "companyId_1",
        key: { companyId: 1 },
        unique: true,
        partialFilterExpression: { status: { $eq: "ACTIVE" } },
      },
      spec
    ),
    false
  );

  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  const created = report.postApplyIndexes[PACKING_LABEL_SIGNING_KEY_COLLECTION].find((ix) => ix.name === "companyId_1");
  assert.equal(created.unique, true);
  assert.deepEqual(created.partialFilterExpression, { status: "ACTIVE" });
  assert.equal(created.sparse, false);

  const mismatched = evaluatePackingLabelIndexes({
    [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
      exists: true,
      documentCount: 0,
      indexes: [
        defaultIdIndex(),
        {
          name: "companyId_1",
          key: { companyId: 1 },
          unique: true,
          sparse: false,
          partialFilterExpression: { status: "ACTIVE", extra: true },
        },
      ],
    },
    [PACKING_LABEL_UNIT_COLLECTION]: { exists: false, documentCount: 0, indexes: [] },
  });
  assert.equal(mismatched.result, "BLOCKED_CONFLICT");
});

await run("11. script never drops indexes", async () => {
  assert.equal(/\bdropIndex(es)?\s*\(/.test(SCRIPT_SOURCE), false);
  assert.equal(/\bsyncIndexes\s*\(/.test(SCRIPT_SOURCE), false);
  const db = new FakeDb({
    [PACKING_LABEL_UNIT_COLLECTION]: {
      exists: true,
      documentCount: 0,
      indexes: [
        defaultIdIndex(),
        { name: "leftover_unrelated_1", key: { leftover: 1 }, unique: false, sparse: false },
      ],
    },
  });
  await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(db.collection(PACKING_LABEL_UNIT_COLLECTION).calls.dropIndex.length, 0);
  assert.equal(db.collection(PACKING_LABEL_UNIT_COLLECTION).calls.dropIndexes.length, 0);
  const leftover = db
    .collection(PACKING_LABEL_UNIT_COLLECTION)
    ._indexes.find((ix) => ix.name === "leftover_unrelated_1");
  assert.ok(leftover);
});

await run("12. script performs no document mutations", async () => {
  for (const method of ["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "bulkWrite"]) {
    assert.equal(SCRIPT_SOURCE.includes(method), false, method);
  }
  const db = new FakeDb();
  await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(db.mutationCallCount(), 0);
  assert.equal(db.collection(PACKING_LABEL_UNIT_COLLECTION).documentCount, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).documentCount, 0);
});

await run("13. output contains no connection URI or credentials", async () => {
  const db = new FakeDb();
  const report = await runEnsurePackingLabelIndexes({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  const printed = redactSecrets(JSON.stringify(report, null, 2));
  assertNoSecrets(printed);
  assert.equal("uri" in report, false);
  assert.equal("mongoUri" in report, false);
  assert.equal(printed.includes(report.databaseName), true);

  const leaked = redactSecrets(
    "failed mongodb+srv://user:secret@cluster.mongodb.net/erp?retryWrites=true MONGO_URI=mongodb://example"
  );
  assertNoSecrets(leaked);
  assert.equal(leaked.includes("[redacted-uri]"), true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
