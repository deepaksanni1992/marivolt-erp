/**
 * Local tests for repairUnusedPackingLabelSigningKey.mjs.
 * Uses an in-memory fake database only. Never connects to production.
 *
 * Run: node scripts/repairUnusedPackingLabelSigningKey.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LABEL_SIGNING_SECRET_UNWRAP_FAILED,
  PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV,
  decryptPackingLabelSigningSecretBytes,
  encryptPackingLabelSigningSecretBytes,
  signMar1Token,
  verifyMar1TokenLocal,
} from "../src/services/label/packingLabelSigningService.js";
import { PACKING_QR_LANDSCAPE_V1_CODE } from "../src/services/label/packingQrLandscapeV1.js";
import {
  PACKING_LABEL_SIGNING_KEY_COLLECTION,
  PACKING_LABEL_UNIT_COLLECTION,
} from "./ensurePackingLabelIndexes.mjs";
import {
  BLOCKED_OPERATOR_INACTIVE,
  BLOCKED_OPERATOR_NOT_AUTHORIZED,
  BLOCKED_OPERATOR_NOT_PRIVILEGED,
  COMPANY_COLLECTION,
  HMAC_SECRET_BYTES,
  PACKING_LABEL_APPLY_GUARDS_MISSING,
  PACKING_LABEL_OPERATOR_REQUIRED,
  USER_COLLECTION,
  redactSecrets,
} from "./provisionPackingLabelSigningKey.mjs";
import {
  BLOCKED_KEY_NOT_ACTIVE_K1,
  BLOCKED_SECRET_REF,
  BLOCKED_SIGNING_KEY_COUNT,
  COUNTER_COLLECTION,
  LABEL_PRINT_JOB_COLLECTION,
  LOCKED_TEST_LABEL_NO,
  MAR1_K1_COMPLETE_TOKEN_RE,
  PACKING_LABEL_KEY_REPAIR_CONFLICT,
  PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED,
  PACKING_LABEL_KEY_REPAIR_UNSAFE,
  REQUIRED_CONFIRM,
  REQUIRED_OPERATOR_EMAIL,
  SIGNING_KEY_INDEX_SPECS,
  buildLabelPrintJobDependencyFilter,
  publicReport,
  runRepairUnusedPackingLabelSigningKey,
} from "./repairUnusedPackingLabelSigningKey.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "repairUnusedPackingLabelSigningKey.mjs"), "utf8");

const TEST_ENC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i + 5) % 256)).toString("hex");
const OTHER_ENC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i + 11) % 256)).toString("hex");
const COMPANY_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_ID = "cccccccccccccccccccccccc";
const APPLY_ARGV = [
  "--apply",
  "--company-code",
  "MAR",
  "--key-id",
  "K1",
  "--confirm",
  REQUIRED_CONFIRM,
  "--operator-email",
  REQUIRED_OPERATOR_EMAIL,
];
const APPLY_ARGV_NO_OPERATOR = [
  "--apply",
  "--company-code",
  "MAR",
  "--key-id",
  "K1",
  "--confirm",
  REQUIRED_CONFIRM,
];
const DRY_ARGV = ["--company-code", "MAR", "--key-id", "K1"];
const APPLY_ENV = { nodeEnv: "production", uriConfigured: true };

const MUTATION_METHODS = [
  "insertOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "bulkWrite",
  "createIndex",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultIdIndex() {
  return { name: "_id_", key: { _id: 1 }, unique: false, sparse: false };
}

function approvedSigningIndexes() {
  return [
    defaultIdIndex(),
    ...SIGNING_KEY_INDEX_SPECS.map((spec) => ({
      name: spec.name,
      key: { ...spec.key },
      unique: spec.unique === true,
      sparse: false,
      partialFilterExpression: spec.partialFilterExpression || null,
    })),
  ];
}

function getNested(doc, pathKey) {
  return pathKey.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), doc);
}

function isBsonObjectIdValue(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return value._bsontype === "ObjectId" || value._bsontype === "ObjectID";
}

function matchValue(actual, expected) {
  if (expected instanceof RegExp) {
    if (Array.isArray(actual)) return actual.some((item) => expected.test(String(item || "")));
    return expected.test(String(actual || ""));
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    if ("$type" in expected) {
      const typeName = String(expected.$type || "").toLowerCase();
      if (typeName === "objectid" || expected.$type === 7) return isBsonObjectIdValue(actual);
      return false;
    }
    if ("$ne" in expected) {
      if (expected.$ne == null) return actual != null && actual !== "";
      return String(actual) !== String(expected.$ne);
    }
    if ("$in" in expected) return expected.$in.some((item) => String(item) === String(actual));
    if ("$gt" in expected) return Number(actual) > Number(expected.$gt);
  }
  if (actual == null && expected == null) return true;
  return String(actual) === String(expected);
}

function matchFilter(doc, filter = {}) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (key === "$or") return expected.some((sub) => matchFilter(doc, sub));
    if (key === "$and") return expected.every((sub) => matchFilter(doc, sub));
    if (key.startsWith("$")) return true;
    if (key.includes(".")) {
      const [head, ...rest] = key.split(".");
      const val = doc[head];
      const nested = rest.join(".");
      if (Array.isArray(val)) return val.some((item) => matchFilter(item, { [nested]: expected }));
      return matchValue(getNested(doc, key), expected);
    }
    return matchValue(doc[key], expected);
  });
}

function projectDoc(doc, projection) {
  if (!projection) {
    const copy = clone(doc);
    return copy;
  }
  const include = Object.entries(projection).filter(([, v]) => v);
  const out = {};
  for (const [key] of include) {
    if (key in doc) out[key] = clone(doc[key]);
  }
  if (projection._id !== 0 && out._id == null && doc._id != null) out._id = doc._id;
  return out;
}

class FakeCollection {
  constructor(name, { exists = false, docs = [], indexes = [] } = {}) {
    this.collectionName = name;
    this.exists = exists;
    this.docs = docs.map(clone);
    this._indexes = indexes.map(clone);
    this.calls = { updateOne: [], insertOne: [], createIndex: [] };
    for (const method of MUTATION_METHODS) {
      this.calls[method] = this.calls[method] || [];
      this[method] = async (...args) => {
        this.calls[method].push(args);
        throw new Error(`unexpected mutation: ${method}`);
      };
    }
  }

  find(filter = {}, options = {}) {
    return {
      toArray: async () =>
        this.docs.filter((doc) => matchFilter(doc, filter)).map((doc) => projectDoc(doc, options.projection)),
    };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchFilter(doc, filter)).length;
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

  async updateOne(filter, update) {
    this.calls.updateOne.push({
      filterKeys: Object.keys(filter || {}).sort(),
      setKeys: Object.keys(update?.$set || {}).sort(),
      updateKeys: Object.keys(update || {}).sort(),
    });
    const matches = this.docs.filter((doc) => matchFilter(doc, filter));
    if (matches.length !== 1) return { matchedCount: matches.length, modifiedCount: 0 };
    const doc = matches[0];
    if (update?.$set) Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

class FakeDb {
  constructor(state = {}) {
    this.databaseName = "packing-label-repair-test";
    this.collections = {};
    for (const [name, cfg] of Object.entries(state)) {
      this.collections[name] = new FakeCollection(name, cfg);
    }
  }

  collection(name) {
    if (!this.collections[name]) this.collections[name] = new FakeCollection(name, {});
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

  unexpectedMutationCount() {
    let n = 0;
    for (const col of Object.values(this.collections)) {
      for (const method of MUTATION_METHODS) n += (col.calls[method] || []).length;
    }
    return n;
  }
}

function staleEnvelope() {
  const saved = process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV];
  process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] = OTHER_ENC_KEY;
  try {
    const bytes = crypto.randomBytes(HMAC_SECRET_BYTES);
    try {
      return encryptPackingLabelSigningSecretBytes(bytes);
    } finally {
      bytes.fill(0);
    }
  } finally {
    process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] = saved;
  }
}

function currentKeyDoc(overrides = {}) {
  const createdAt = "2026-08-31T13:05:28.673Z";
  return {
    _id: KEY_ID,
    companyId: COMPANY_ID,
    keyId: "K1",
    status: "ACTIVE",
    encryptedSecret: staleEnvelope(),
    createdAt,
    updatedAt: createdAt,
    createdBy: "admin@marivoltz.com",
    createdByUserId: USER_ID,
    activatedAt: createdAt,
    retiredAt: null,
    ...overrides,
  };
}

const OTHER_COMPANY_ID = "ffffffffffffffffffffffff";
const SIG22 = "xY7_k2LmN9pQrStUvWx-zA";
const COMPLETE_MAR1_K1_TOKEN = `MAR1.MAR-PL-000001.K1.${SIG22}`;

function fakeObjectId(id = "dddddddddddddddddddddddd") {
  return { _bsontype: "ObjectId", id };
}

function packingJob(overrides = {}) {
  return {
    _id: overrides._id || "job1",
    companyId: COMPANY_ID,
    sourceType: "PACKING",
    templateCode: "PACKING_STANDARD_100X50",
    packingMode: "PRE_PACKING",
    status: "COMPLETED",
    lines: [],
    ...overrides,
  };
}

const LEGACY_CUSTOM_PACKING_JOBS = [
  packingJob({
    _id: "6a8aee4fb4cf363dcdff5187",
    jobNo: "LBL202608231257512920",
    sourceType: "CUSTOM_PACKING",
    packingMode: "CUSTOM_PACKING",
    lines: [],
    tsplPayload: "SIZE 100 mm,50 mm",
  }),
  packingJob({
    _id: "6a8aee51e61a4ff86ed536af",
    jobNo: "LBL20260823125753C839",
    sourceType: "CUSTOM_PACKING",
    packingMode: "CUSTOM_PACKING",
    lines: [],
    tsplPayload: "SIZE 100 mm,50 mm",
  }),
];

async function dryRepairWithJobs(docs) {
  const db = new FakeDb(
    readyState({
      [LABEL_PRINT_JOB_COLLECTION]: { exists: true, docs },
    })
  );
  return runRepairUnusedPackingLabelSigningKey({ db, argv: DRY_ARGV, ...APPLY_ENV });
}

function readyState(overrides = {}) {
  return {
    [COMPANY_COLLECTION]: {
      exists: true,
      docs: [{ _id: COMPANY_ID, code: "MAR", isActive: true }],
    },
    [USER_COLLECTION]: {
      exists: true,
      docs: [
        {
          _id: USER_ID,
          email: REQUIRED_OPERATOR_EMAIL,
          isActive: true,
          role: "company_admin",
          allowedCompanies: [COMPANY_ID],
          defaultCompany: COMPANY_ID,
        },
      ],
    },
    [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
      exists: true,
      docs: [currentKeyDoc()],
      indexes: approvedSigningIndexes(),
    },
    [PACKING_LABEL_UNIT_COLLECTION]: { exists: true, docs: [] },
    [LABEL_PRINT_JOB_COLLECTION]: { exists: true, docs: [] },
    [COUNTER_COLLECTION]: { exists: true, docs: [] },
    ...overrides,
  };
}

function assertNoSecrets(text) {
  const blob = String(text);
  assert.equal(/mongodb(\+srv)?:\/\//i.test(blob), false);
  assert.equal(/\bv1b?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(blob), false);
  assert.equal(blob.includes(TEST_ENC_KEY), false);
  assert.equal(blob.includes(OTHER_ENC_KEY), false);
}

let passed = 0;
let failed = 0;
async function run(name, fn) {
  const saved = process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV];
  process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] = TEST_ENC_KEY;
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  } finally {
    if (saved == null) delete process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV];
    else process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] = saved;
  }
}

console.log("repairUnusedPackingLabelSigningKey.test.js");

await run("1-2. dry-run default performs no randomBytes or write", async () => {
  let generated = 0;
  const db = new FakeDb(readyState());
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: DRY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.result, "READY_TO_REPAIR");
  assert.equal(report.updated, false);
  assert.equal(report.currentUnwrapReady, false);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
  assert.equal(db.unexpectedMutationCount(), 0);
});

await run("3. missing guards remain dry-run with no write", async () => {
  const db = new FakeDb(readyState());
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: ["--apply", "--company-code", "MAR", "--key-id", "K1", "--operator-email", REQUIRED_OPERATOR_EMAIL],
    ...APPLY_ENV,
  });
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.result, PACKING_LABEL_APPLY_GUARDS_MISSING);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("3b. apply without operator email is blocked before randomBytes", async () => {
  let generated = 0;
  const db = new FakeDb(readyState());
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV_NO_OPERATOR,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(report.result, PACKING_LABEL_OPERATOR_REQUIRED);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("4. inactive operator rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: REQUIRED_OPERATOR_EMAIL,
            isActive: false,
            role: "company_admin",
            allowedCompanies: [COMPANY_ID],
            defaultCompany: COMPANY_ID,
          },
        ],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_INACTIVE);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("4b. operator unauthorized for MAR rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: REQUIRED_OPERATOR_EMAIL,
            isActive: true,
            role: "company_admin",
            allowedCompanies: ["dddddddddddddddddddddddd"],
            defaultCompany: null,
          },
        ],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_NOT_AUTHORIZED);
});

await run("4c. nonprivileged role rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: REQUIRED_OPERATOR_EMAIL,
            isActive: true,
            role: "staff",
            allowedCompanies: [COMPANY_ID],
            defaultCompany: COMPANY_ID,
          },
        ],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_NOT_PRIVILEGED);
});

await run("5. missing/wrong/multiple K1 blocks", async () => {
  const missing = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: { exists: true, docs: [], indexes: approvedSigningIndexes() },
    })
  );
  assert.equal(
    (await runRepairUnusedPackingLabelSigningKey({ db: missing, argv: APPLY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_SIGNING_KEY_COUNT
  );
  const wrong = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        docs: [currentKeyDoc({ status: "VERIFY_ONLY" })],
        indexes: approvedSigningIndexes(),
      },
    })
  );
  assert.equal(
    (await runRepairUnusedPackingLabelSigningKey({ db: wrong, argv: APPLY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_KEY_NOT_ACTIVE_K1
  );
  const many = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        docs: [currentKeyDoc(), currentKeyDoc({ _id: "dddddddddddddddddddddddd", keyId: "K2", status: "VERIFY_ONLY" })],
        indexes: approvedSigningIndexes(),
      },
    })
  );
  assert.equal(
    (await runRepairUnusedPackingLabelSigningKey({ db: many, argv: APPLY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_SIGNING_KEY_COUNT
  );
});

await run("6. secretRef blocks", async () => {
  const db = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        docs: [currentKeyDoc({ secretRef: "env:PACKING_LABEL_HMAC" })],
        indexes: approvedSigningIndexes(),
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_SECRET_REF);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("7. any PackingLabelUnit blocks", async () => {
  const db = new FakeDb(
    readyState({
      [PACKING_LABEL_UNIT_COLLECTION]: {
        exists: true,
        docs: [{ _id: "u1", companyId: COMPANY_ID, signingKeyId: "K1", labelNo: "MAR-PL-000001", qrVersion: "MAR1" }],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("8. any landscape job blocks", async () => {
  const db = new FakeDb(
    readyState({
      [LABEL_PRINT_JOB_COLLECTION]: {
        exists: true,
        docs: [{ _id: "j1", companyId: COMPANY_ID, templateCode: PACKING_QR_LANDSCAPE_V1_CODE, lines: [] }],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("9. nonzero counter blocks", async () => {
  const db = new FakeDb(
    readyState({
      [COUNTER_COLLECTION]: {
        exists: true,
        docs: [{ companyId: COMPANY_ID, key: "packingLabelUnit", seq: 1 }],
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("10. current unwrap success reports repair not required", async () => {
  const bytes = crypto.randomBytes(HMAC_SECRET_BYTES);
  let envelope;
  try {
    envelope = encryptPackingLabelSigningSecretBytes(bytes);
  } finally {
    bytes.fill(0);
  }
  let generated = 0;
  const db = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        docs: [currentKeyDoc({ encryptedSecret: envelope })],
        indexes: approvedSigningIndexes(),
      },
    })
  );
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED);
  assert.equal(report.currentUnwrapReady, true);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("11-16. unwrap failure plus zero dependencies permits apply and retains identity", async () => {
  assert.equal(SCRIPT_SOURCE.includes('toString("hex")'), false);
  assert.equal(SCRIPT_SOURCE.includes("deleteOne"), false);
  assert.equal(SCRIPT_SOURCE.includes("insertOne"), false);
  assert.equal(SCRIPT_SOURCE.includes("replaceOne"), false);
  assert.equal(SCRIPT_SOURCE.includes("createIndex"), false);
  const db = new FakeDb(readyState());
  const before = clone(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs[0]);
  const live = crypto.randomBytes(HMAC_SECRET_BYTES);
  const expected = Buffer.from(live);
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => live,
  });
  assert.equal(report.result, "REPAIRED");
  assert.equal(report.updated, true);
  assert.equal(report.created, false);
  assert.equal(report.recordId, KEY_ID);
  assert.equal(report.keyId, "K1");
  assert.equal(report.status, "ACTIVE");
  assert.equal(live.length, 32);
  assert.ok(live.every((b) => b === 0));
  const stored = db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs[0];
  assert.equal(String(stored._id), KEY_ID);
  assert.equal(String(stored.companyId), COMPANY_ID);
  assert.equal(stored.keyId, "K1");
  assert.equal(stored.status, "ACTIVE");
  assert.equal(stored.createdAt, before.createdAt);
  assert.equal(stored.createdBy, before.createdBy);
  assert.equal(String(stored.createdByUserId), String(before.createdByUserId));
  assert.equal(stored.encryptedSecret.startsWith("v1b:"), true);
  assert.notEqual(stored.encryptedSecret, before.encryptedSecret);
  assert.equal(secretPresentForTest(stored.secretRef), false);
  const recovered = decryptPackingLabelSigningSecretBytes(stored.encryptedSecret);
  assert.ok(recovered.equals(expected));
  const signed = signMar1Token({ labelNo: LOCKED_TEST_LABEL_NO, keyId: "K1", secret: recovered });
  const verified = verifyMar1TokenLocal({
    token: signed.token,
    secret: recovered,
    expectedLabelNo: LOCKED_TEST_LABEL_NO,
    expectedKeyId: "K1",
  });
  assert.equal(verified.ok, true);
  recovered.fill(0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 1);
  assert.deepEqual(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne[0].setKeys, [
    "encryptedSecret",
    "updatedAt",
  ]);
  assert.equal(db.unexpectedMutationCount(), 0);
});

function secretPresentForTest(value) {
  return String(value || "").trim() !== "";
}

await run("17. original generated buffer is zeroed if wrapping fails", async () => {
  const db = new FakeDb(readyState());
  const live = crypto.randomBytes(HMAC_SECRET_BYTES);
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => live,
    encryptSecret: () => {
      throw new Error("wrap failed");
    },
  });
  assert.notEqual(report.result, "REPAIRED");
  assert.ok(live.every((b) => b === 0));
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 0);
});

await run("18. plaintext bytes/envelope never appear in output", async () => {
  const db = new FakeDb(readyState());
  const report = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  const published = publicReport(report);
  assertNoSecrets(JSON.stringify(published));
  assertNoSecrets(redactSecrets(JSON.stringify(published)));
  assert.equal("encryptedSecret" in published, false);
  assert.equal("secretRef" in published, false);
});

await run("19. concurrent mismatch blocks safely", async () => {
  const db = new FakeDb(readyState());
  const col = db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION);
  const original = col.updateOne.bind(col);
  col.updateOne = async (filter, update) => {
    col.docs[0].encryptedSecret = "v1b:changed.concurrent.tagvaluexx";
    return original(filter, update);
  };
  let generated = 0;
  const report = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_CONFLICT);
  assert.equal(report.updated, false);
  assert.equal(generated, 1);
  assert.equal(col.docs[0].createdBy, "admin@marivoltz.com");
  assert.equal(col.docs[0].keyId, "K1");
});

await run("20. second repair is blocked as not required", async () => {
  const db = new FakeDb(readyState());
  const first = await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(first.result, "REPAIRED");
  let generated = 0;
  const second = await runRepairUnusedPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(second.result, PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 1);
});

await run("21. no delete/insert/upsert/index mutation outside exact K1 update", async () => {
  const db = new FakeDb(readyState());
  await runRepairUnusedPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(db.unexpectedMutationCount(), 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne.length, 1);
  assert.ok(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne[0].filterKeys.includes("_id"));
  assert.ok(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.updateOne[0].filterKeys.includes("encryptedSecret"));
});

await run("predicate.companyId is required and scoped", async () => {
  assert.throws(() => buildLabelPrintJobDependencyFilter(null), /companyId is required/);
  assert.throws(() => buildLabelPrintJobDependencyFilter(""), /companyId is required/);
  const filter = buildLabelPrintJobDependencyFilter(COMPANY_ID);
  assert.equal(filter.companyId, COMPANY_ID);
  assert.equal(Array.isArray(filter.$or), true);
  assert.equal(
    filter.$or.some((clause) => JSON.stringify(clause) === JSON.stringify({ "lines.packingLabelUnitId": { $type: "objectId" } })),
    true
  );
  assert.equal(SCRIPT_SOURCE.includes('{ "lines.packingLabelUnitId": { $ne: null } }'), false);
  assert.equal(SCRIPT_SOURCE.includes('"lines.signingKeyId"'), false);
  assert.equal(MAR1_K1_COMPLETE_TOKEN_RE.source.includes("{22}"), true);
});

await run("dep.1 missing lines does not match", async () => {
  const report = await dryRepairWithJobs([packingJob({ lines: undefined })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.2 empty lines does not match", async () => {
  const report = await dryRepairWithJobs([packingJob({ lines: [] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.3 null packingLabelUnitId does not match", async () => {
  const report = await dryRepairWithJobs([
    packingJob({
      lines: [
        { packingLabelUnitId: null },
        { packingLabelUnitId: "null" },
        { packingLabelUnitId: "u1" },
        { packingLabelUnitId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      ],
    }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.4 real ObjectId matches", async () => {
  const report = await dryRepairWithJobs([
    packingJob({ lines: [{ packingLabelUnitId: fakeObjectId() }] }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("dep.5 MAR-PL labelId matches", async () => {
  const report = await dryRepairWithJobs([packingJob({ lines: [{ labelId: "MAR-PL-000002" }] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("dep.6 MAR-PL labelNo matches", async () => {
  const report = await dryRepairWithJobs([packingJob({ lines: [{ labelNo: "MAR-PL-7" }] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("dep.7 MAR-PL barcodeValue matches", async () => {
  const report = await dryRepairWithJobs([packingJob({ lines: [{ barcodeValue: "MAR-PL-000001" }] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("dep.8 complete strict MAR1 K1 token matches", async () => {
  assert.equal(SIG22.length, 22);
  assert.equal(MAR1_K1_COMPLETE_TOKEN_RE.test(`QRCODE 1,1,H,6,A,90,"${COMPLETE_MAR1_K1_TOKEN}"`), true);
  const report = await dryRepairWithJobs([
    packingJob({ tsplPayload: `QRCODE 1,1,H,6,A,90,"${COMPLETE_MAR1_K1_TOKEN}"` }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
});

await run("dep.9 21-character signature does not match", async () => {
  const token = `MAR1.MAR-PL-000001.K1.${SIG22.slice(0, 21)}`;
  assert.equal(MAR1_K1_COMPLETE_TOKEN_RE.test(token), false);
  const report = await dryRepairWithJobs([packingJob({ tsplPayload: token, rawFacePayloads: [token] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.10 23-character signature does not match", async () => {
  const token = `MAR1.MAR-PL-000001.K1.${SIG22}A`;
  assert.equal(SIG22.length + 1, 23);
  assert.equal(MAR1_K1_COMPLETE_TOKEN_RE.test(token), false);
  const report = await dryRepairWithJobs([packingJob({ tsplPayload: token, rawFacePayloads: [token] })]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.11 non-Base64URL signature does not match", async () => {
  const token = `MAR1.MAR-PL-000001.K1.${"A".repeat(21)}+`;
  assert.equal(MAR1_K1_COMPLETE_TOKEN_RE.test(token), false);
  const report = await dryRepairWithJobs([
    packingJob({ tsplPayload: `MAR1.MAR-PL-000001.K1.`, rawFacePayloads: [token] }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.12 bare signingKeyId K1 does not match", async () => {
  const report = await dryRepairWithJobs([
    packingJob({
      lines: [{ signingKeyId: "K1", location: "K1", article: "K1" }],
      tsplPayload: "K1",
    }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.13 other-company job does not match", async () => {
  const report = await dryRepairWithJobs([
    packingJob({
      companyId: OTHER_COMPANY_ID,
      lines: [{ packingLabelUnitId: fakeObjectId(), labelId: "MAR-PL-000001", barcodeValue: "MAR-PL-000001" }],
      tsplPayload: `QRCODE 1,1,H,6,A,90,"${COMPLETE_MAR1_K1_TOKEN}"`,
      templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
    }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.dependencyCounts.landscapeJobs, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

await run("dep.14 known legacy CUSTOM_PACKING jobs no longer block", async () => {
  const report = await dryRepairWithJobs(LEGACY_CUSTOM_PACKING_JOBS);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
  assert.equal(report.updated, false);
});

await run("dep.15 genuine MAR dependency remains unsafe", async () => {
  const report = await dryRepairWithJobs([
    packingJob({
      companyId: COMPANY_ID,
      lines: [{ packingLabelUnitId: fakeObjectId(), labelId: "MAR-PL-000001" }],
    }),
  ]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 1);
  assert.equal(report.result, PACKING_LABEL_KEY_REPAIR_UNSAFE);
  assert.equal(report.updated, false);
});

await run("dep.16 zero genuine dependencies permits READY_TO_REPAIR", async () => {
  const report = await dryRepairWithJobs([]);
  assert.equal(report.dependencyCounts.jobsReferencingSigningKey, 0);
  assert.equal(report.dependencyCounts.landscapeJobs, 0);
  assert.equal(report.dependencyCounts.marPlIdentities, 0);
  assert.equal(report.result, "READY_TO_REPAIR");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
