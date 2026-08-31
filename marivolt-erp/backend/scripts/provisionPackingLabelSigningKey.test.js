/**
 * Local tests for provisionPackingLabelSigningKey.mjs.
 * Uses an in-memory fake database only. Never connects to production.
 *
 * Run: node scripts/provisionPackingLabelSigningKey.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED,
  PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV,
  decryptPackingLabelSigningSecretBytes,
  signMar1Token,
} from "../src/services/label/packingLabelSigningService.js";
import {
  BLOCKED_ACTIVE_KEY_EXISTS,
  BLOCKED_COMPANY_AMBIGUOUS,
  BLOCKED_COMPANY_NOT_FOUND,
  BLOCKED_INDEXES_NOT_READY,
  BLOCKED_KEY_ID_EXISTS,
  BLOCKED_OPERATOR_AMBIGUOUS,
  BLOCKED_OPERATOR_INACTIVE,
  BLOCKED_OPERATOR_NOT_AUTHORIZED,
  BLOCKED_OPERATOR_NOT_FOUND,
  BLOCKED_OPERATOR_NOT_PRIVILEGED,
  COMPANY_COLLECTION,
  HMAC_SECRET_BYTES,
  PACKING_LABEL_OPERATOR_REQUIRED,
  PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT,
  REQUIRED_CONFIRM,
  SIGNING_KEY_INDEX_SPECS,
  USER_COLLECTION,
  parseProvisionPackingLabelSigningKeyArgs,
  publicReport,
  redactSecrets,
  runProvisionPackingLabelSigningKey,
} from "./provisionPackingLabelSigningKey.mjs";
import { PACKING_LABEL_SIGNING_KEY_COLLECTION } from "./ensurePackingLabelIndexes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "provisionPackingLabelSigningKey.mjs"), "utf8");

const TEST_ENC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i + 3) % 256)).toString("hex");
const COMPANY_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const APPLY_ARGV = [
  "--apply",
  "--company-code",
  "MAR",
  "--key-id",
  "K1",
  "--confirm",
  REQUIRED_CONFIRM,
  "--operator-email",
  "ops@marivolt.example",
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
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndDelete",
  "findOneAndReplace",
  "bulkWrite",
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

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => String(doc[key]) === String(expected));
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
    this.calls = { insertOne: [], createIndex: [] };
    for (const method of MUTATION_METHODS) {
      this.calls[method] = [];
      this[method] = async (...args) => {
        this.calls[method].push(args);
        throw new Error(`unexpected mutation: ${method}`);
      };
    }
    this.failNextInsert = null;
  }

  find(filter = {}, options = {}) {
    return {
      toArray: async () =>
        this.docs.filter((doc) => matchesFilter(doc, filter)).map((doc) => projectDoc(doc, options.projection)),
    };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
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

  async insertOne(doc) {
    this.calls.insertOne.push({
      keys: Object.keys(doc).sort(),
      hasEncryptedSecret: Boolean(doc.encryptedSecret),
      hasSecretRef: Object.prototype.hasOwnProperty.call(doc, "secretRef"),
      status: doc.status,
      keyId: doc.keyId,
    });
    if (this.failNextInsert) {
      const err = this.failNextInsert;
      this.failNextInsert = null;
      throw err;
    }
    const companyId = String(doc.companyId);
    if (this.docs.some((row) => String(row.companyId) === companyId && String(row.keyId) === String(doc.keyId))) {
      const err = new Error("E11000 duplicate key");
      err.code = 11000;
      throw err;
    }
    if (
      doc.status === "ACTIVE" &&
      this.docs.some((row) => String(row.companyId) === companyId && row.status === "ACTIVE")
    ) {
      const err = new Error("E11000 duplicate key");
      err.code = 11000;
      throw err;
    }
    const stored = clone(doc);
    stored._id = stored._id || crypto.randomBytes(12).toString("hex");
    this.exists = true;
    this.docs.push(stored);
    return { insertedId: stored._id };
  }
}

class FakeDb {
  constructor(state = {}) {
    this.databaseName = "packing-label-provision-test";
    this.collections = {
      [COMPANY_COLLECTION]: new FakeCollection(COMPANY_COLLECTION, state[COMPANY_COLLECTION] || { exists: true }),
      [USER_COLLECTION]: new FakeCollection(USER_COLLECTION, state[USER_COLLECTION] || { exists: true }),
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: new FakeCollection(
        PACKING_LABEL_SIGNING_KEY_COLLECTION,
        state[PACKING_LABEL_SIGNING_KEY_COLLECTION] || { exists: false }
      ),
    };
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

  mutationCallCount() {
    let n = 0;
    for (const col of Object.values(this.collections)) {
      for (const method of MUTATION_METHODS) n += col.calls[method].length;
    }
    return n;
  }
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
          email: "ops@marivolt.example",
          isActive: true,
          role: "company_admin",
          allowedCompanies: [COMPANY_ID],
          defaultCompany: COMPANY_ID,
        },
      ],
    },
    [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
      exists: true,
      docs: [],
      indexes: approvedSigningIndexes(),
    },
    ...overrides,
  };
}

function assertNoSecrets(text) {
  const blob = String(text);
  assert.equal(/mongodb(\+srv)?:\/\//i.test(blob), false);
  assert.equal(/\bv1b?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(blob), false);
  assert.equal(blob.includes(TEST_ENC_KEY), false);
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

console.log("provisionPackingLabelSigningKey.test.js");

await run("1. apply without operator email is blocked before randomBytes and insert", async () => {
  let generated = 0;
  const db = new FakeDb(readyState());
  const report = await runProvisionPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV_NO_OPERATOR,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(report.result, PACKING_LABEL_OPERATOR_REQUIRED);
  assert.equal(report.preflight.operatorReady, false);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.insertOne.length, 0);
});

await run("dry-run without operator reports operatorReady false", async () => {
  const db = new FakeDb(readyState());
  const report = await runProvisionPackingLabelSigningKey({ db, argv: DRY_ARGV, ...APPLY_ENV });
  assert.equal(report.mode, "DRY_RUN");
  assert.equal(report.result, "READY_TO_PROVISION");
  assert.equal(report.preflight.operatorReady, false);
});

await run("2. inactive operator rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: "ops@marivolt.example",
            isActive: false,
            role: "company_admin",
            allowedCompanies: [COMPANY_ID],
            defaultCompany: COMPANY_ID,
          },
        ],
      },
    })
  );
  const report = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_INACTIVE);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.insertOne.length, 0);
});

await run("3. operator unauthorized for MAR rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: "ops@marivolt.example",
            isActive: true,
            role: "company_admin",
            allowedCompanies: ["eeeeeeeeeeeeeeeeeeeeeeee"],
            defaultCompany: null,
          },
        ],
      },
    })
  );
  const report = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_NOT_AUTHORIZED);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.insertOne.length, 0);
});

await run("4. nonprivileged role rejected", async () => {
  const db = new FakeDb(
    readyState({
      [USER_COLLECTION]: {
        exists: true,
        docs: [
          {
            _id: USER_ID,
            email: "ops@marivolt.example",
            isActive: true,
            role: "staff",
            allowedCompanies: [COMPANY_ID],
            defaultCompany: COMPANY_ID,
          },
        ],
      },
    })
  );
  const report = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_OPERATOR_NOT_PRIVILEGED);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).calls.insertOne.length, 0);
});

await run("5-6. valid privileged MAR operator accepted with createdBy fields", async () => {
  const db = new FakeDb(readyState());
  const report = await runProvisionPackingLabelSigningKey({
    db,
    argv: ["--apply", "--company-code", "MAR", "--key-id", "K1", "--confirm", REQUIRED_CONFIRM, "--operator-email", "  Ops@Marivolt.Example  "],
    ...APPLY_ENV,
  });
  assert.equal(report.result, "PROVISIONED");
  assert.equal(report.preflight.operatorReady, true);
  assert.equal(report.operatorEmail, "ops@marivolt.example");
  assert.equal(report.operatorUserId, USER_ID);
  const stored = db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs[0];
  assert.equal(stored.createdBy, "ops@marivolt.example");
  assert.equal(String(stored.createdByUserId), USER_ID);
});

await run("company resolution requires exactly one result", async () => {
  const none = new FakeDb(readyState({ [COMPANY_COLLECTION]: { exists: true, docs: [] } }));
  assert.equal(
    (await runProvisionPackingLabelSigningKey({ db: none, argv: DRY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_COMPANY_NOT_FOUND
  );
  const two = new FakeDb(
    readyState({
      [COMPANY_COLLECTION]: {
        exists: true,
        docs: [
          { _id: COMPANY_ID, code: "MAR", isActive: true },
          { _id: "cccccccccccccccccccccccc", code: "MAR", isActive: true },
        ],
      },
    })
  );
  assert.equal(
    (await runProvisionPackingLabelSigningKey({ db: two, argv: DRY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_COMPANY_AMBIGUOUS
  );
});

await run("missing indexes block", async () => {
  const db = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: { exists: true, docs: [], indexes: [defaultIdIndex()] },
    })
  );
  const report = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(report.result, BLOCKED_INDEXES_NOT_READY);
});

await run("7-11. apply generates 32 raw bytes, no string conversion, envelope decrypts, buffer zeroed", async () => {
  assert.equal(SCRIPT_SOURCE.includes('toString("hex")'), false);
  assert.equal(SCRIPT_SOURCE.includes('toString("base64")'), false);
  assert.equal(SCRIPT_SOURCE.includes('toString("base64url")'), false);
  const db = new FakeDb(readyState());
  const live = crypto.randomBytes(HMAC_SECRET_BYTES);
  const expected = Buffer.from(live);
  const report = await runProvisionPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => live,
  });
  assert.equal(report.result, "PROVISIONED");
  assert.equal(live.length, 32);
  assert.ok(live.every((b) => b === 0));
  const stored = db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs[0];
  assert.equal(stored.encryptedSecret.startsWith("v1b:"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, "secretRef"), false);
  const recovered = decryptPackingLabelSigningSecretBytes(stored.encryptedSecret);
  assert.ok(recovered.equals(expected));
  const fromString = signMar1Token({
    labelNo: "MAR-PL-000001",
    keyId: "K1",
    secret: "phase2-test-only-hmac-secret-not-for-production",
  });
  assert.equal(fromString.token, "MAR1.MAR-PL-000001.K1.cVAnxjW_hpd7OsrL-3KntQ");
  const printed = JSON.stringify(publicReport(report));
  assert.equal(printed.includes(stored.encryptedSecret), false);
  assert.equal(printed.includes(expected.toString("hex")), false);
});

await run("10. signing wrapped raw bytes matches locked MAR1 token", async () => {
  const locked = "phase2-test-only-hmac-secret-not-for-production";
  const fromString = signMar1Token({ labelNo: "MAR-PL-000001", keyId: "K1", secret: locked });
  const fromBytes = signMar1Token({
    labelNo: "MAR-PL-000001",
    keyId: "K1",
    secret: Buffer.from(locked, "utf8"),
  });
  assert.equal(fromBytes.token, fromString.token);
  assert.equal(fromString.token, "MAR1.MAR-PL-000001.K1.cVAnxjW_hpd7OsrL-3KntQ");
});

await run("12. original generated buffer is zeroed if wrapping or insertion fails", async () => {
  const wrapFail = new FakeDb(readyState());
  const liveWrap = crypto.randomBytes(HMAC_SECRET_BYTES);
  await runProvisionPackingLabelSigningKey({
    db: wrapFail,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => liveWrap,
    encryptSecret: () => {
      throw new Error("wrap failed");
    },
  });
  assert.ok(liveWrap.every((b) => b === 0));
  assert.equal(wrapFail.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs.length, 0);

  const insertFail = new FakeDb(readyState());
  const liveInsert = crypto.randomBytes(HMAC_SECRET_BYTES);
  const err = new Error("E11000 duplicate key");
  err.code = 11000;
  insertFail.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).failNextInsert = err;
  const report = await runProvisionPackingLabelSigningKey({
    db: insertFail,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => liveInsert,
  });
  assert.equal(report.result, PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT);
  assert.ok(liveInsert.every((b) => b === 0));
});

await run("13. plaintext bytes/envelope never appear in output", async () => {
  const db = new FakeDb(readyState());
  const report = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  const printed = redactSecrets(JSON.stringify(publicReport(report), null, 2));
  assertNoSecrets(printed);
  assert.equal("encryptedSecret" in publicReport(report), false);
  const leaked = redactSecrets(
    "failed mongodb+srv://user:secret@cluster.mongodb.net/erp v1b:abc.def.ghi PACKING_LABEL_SIGNING_ENCRYPTION_KEY=deadbeef"
  );
  assertNoSecrets(leaked);
});

await run("15. second apply remains blocked without generating another secret", async () => {
  const db = new FakeDb(readyState());
  const first = await runProvisionPackingLabelSigningKey({ db, argv: APPLY_ARGV, ...APPLY_ENV });
  assert.equal(first.result, "PROVISIONED");
  let generated = 0;
  const second = await runProvisionPackingLabelSigningKey({
    db,
    argv: APPLY_ARGV,
    ...APPLY_ENV,
    generateHmacSecretBytes: () => {
      generated += 1;
      return crypto.randomBytes(HMAC_SECRET_BYTES);
    },
  });
  assert.equal(second.result, BLOCKED_ACTIVE_KEY_EXISTS);
  assert.equal(generated, 0);
  assert.equal(db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION).docs.length, 1);
});

await run("existing ACTIVE and K1 still block", async () => {
  const active = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        indexes: approvedSigningIndexes(),
        docs: [{ _id: "k1", companyId: COMPANY_ID, keyId: "K9", status: "ACTIVE" }],
      },
    })
  );
  assert.equal(
    (await runProvisionPackingLabelSigningKey({ db: active, argv: APPLY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_ACTIVE_KEY_EXISTS
  );
  const keyId = new FakeDb(
    readyState({
      [PACKING_LABEL_SIGNING_KEY_COLLECTION]: {
        exists: true,
        indexes: approvedSigningIndexes(),
        docs: [{ _id: "k1", companyId: COMPANY_ID, keyId: "K1", status: "VERIFY_ONLY" }],
      },
    })
  );
  assert.equal(
    (await runProvisionPackingLabelSigningKey({ db: keyId, argv: APPLY_ARGV, ...APPLY_ENV })).result,
    BLOCKED_KEY_ID_EXISTS
  );
});

await run("dry-run without encryption key uses LABEL_SIGNING_* code", async () => {
  delete process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV];
  const db = new FakeDb(readyState());
  const report = await runProvisionPackingLabelSigningKey({
    db,
    argv: DRY_ARGV,
    ...APPLY_ENV,
    env: {},
  });
  assert.equal(report.result, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
  assert.equal(report.encryptionReady, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
