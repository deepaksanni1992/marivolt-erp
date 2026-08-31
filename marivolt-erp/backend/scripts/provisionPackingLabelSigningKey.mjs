/**
 * Out-of-band first ACTIVE packing-label signing key.
 *
 * Default: DRY RUN. Does not generate a signing secret or insert a document
 * unless every apply guard is present.
 *
 * Never prints plaintext secrets, envelopes, encryption keys, or MongoDB URIs.
 * Never rotates, replaces, retires, or overwrites an existing key.
 * Insert-only. Never update, upsert, delete, or syncIndexes.
 *
 *   node scripts/provisionPackingLabelSigningKey.mjs --company-code MAR --key-id K1
 *   NODE_ENV=production node scripts/provisionPackingLabelSigningKey.mjs --apply --company-code MAR --key-id K1 --confirm CREATE_FIRST_ACTIVE_PACKING_KEY --operator-email <email>
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKING_LABEL_SIGNING_KEY_ID_PATTERN } from "../src/models/PackingLabelSigningKey.js";
import { isAdminRole } from "../src/utils/authAdminPolicy.js";
import {
  LABEL_SIGNING_ENCRYPTION_KEY_INVALID,
  LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED,
  PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV,
  decodePackingLabelSigningEncryptionKey,
  encryptPackingLabelSigningSecretBytes,
} from "../src/services/label/packingLabelSigningService.js";
import {
  PACKING_LABEL_INDEX_SPECS,
  PACKING_LABEL_SIGNING_KEY_COLLECTION,
  indexMatchesApprovedSpec,
} from "./ensurePackingLabelIndexes.mjs";

export const COMPANY_COLLECTION = "companies";
export const USER_COLLECTION = "users";
export const REQUIRED_COMPANY_CODE = "MAR";
export const REQUIRED_KEY_ID = "K1";
export const REQUIRED_CONFIRM = "CREATE_FIRST_ACTIVE_PACKING_KEY";
export const REQUESTED_STATUS = "ACTIVE";
export const HMAC_SECRET_BYTES = 32;
export const PACKING_LABEL_PROVISION_ADMIN_ROLES = Object.freeze(["super_admin", "company_admin", "admin"]);

export const BLOCKED_ACTIVE_KEY_EXISTS = "BLOCKED_ACTIVE_KEY_EXISTS";
export const BLOCKED_KEY_ID_EXISTS = "BLOCKED_KEY_ID_EXISTS";
export const BLOCKED_INDEXES_NOT_READY = "BLOCKED_INDEXES_NOT_READY";
export const BLOCKED_COMPANY_NOT_FOUND = "BLOCKED_COMPANY_NOT_FOUND";
export const BLOCKED_COMPANY_AMBIGUOUS = "BLOCKED_COMPANY_AMBIGUOUS";
export const BLOCKED_COMPANY_INACTIVE = "BLOCKED_COMPANY_INACTIVE";
export const BLOCKED_OPERATOR_NOT_FOUND = "BLOCKED_OPERATOR_NOT_FOUND";
export const BLOCKED_OPERATOR_AMBIGUOUS = "BLOCKED_OPERATOR_AMBIGUOUS";
export const BLOCKED_OPERATOR_NOT_AUTHORIZED = "BLOCKED_OPERATOR_NOT_AUTHORIZED";
export const BLOCKED_OPERATOR_NOT_PRIVILEGED = "BLOCKED_OPERATOR_NOT_PRIVILEGED";
export const BLOCKED_OPERATOR_INACTIVE = "BLOCKED_OPERATOR_INACTIVE";
export const BLOCKED_INVALID_KEY_ID = "BLOCKED_INVALID_KEY_ID";
export const PACKING_LABEL_OPERATOR_REQUIRED = "PACKING_LABEL_OPERATOR_REQUIRED";
export const PACKING_LABEL_APPLY_GUARDS_MISSING = "PACKING_LABEL_APPLY_GUARDS_MISSING";
export const PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT = "PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT";

export const SIGNING_KEY_INDEX_SPECS = Object.freeze(
  PACKING_LABEL_INDEX_SPECS.filter((spec) => spec.collection === PACKING_LABEL_SIGNING_KEY_COLLECTION)
);

const SECRET_FIELD_NAMES = new Set(["encryptedSecret", "secretRef", "passwordHash", "twoFactorSecret"]);

export function parseProvisionPackingLabelSigningKeyArgs(argv = []) {
  const parsed = {
    apply: false,
    companyCode: null,
    keyId: null,
    confirm: null,
    operatorEmail: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (token === "--company-code") {
      parsed.companyCode = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--company-code=")) {
      parsed.companyCode = token.slice("--company-code=".length);
      continue;
    }
    if (token === "--key-id") {
      parsed.keyId = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--key-id=")) {
      parsed.keyId = token.slice("--key-id=".length);
      continue;
    }
    if (token === "--confirm") {
      parsed.confirm = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--confirm=")) {
      parsed.confirm = token.slice("--confirm=".length);
      continue;
    }
    if (token === "--operator-email") {
      parsed.operatorEmail = String(argv[i + 1] || "");
      i += 1;
      continue;
    }
    if (token.startsWith("--operator-email=")) {
      parsed.operatorEmail = token.slice("--operator-email=".length);
    }
  }
  if (parsed.companyCode) parsed.companyCode = String(parsed.companyCode).trim().toUpperCase();
  if (parsed.keyId) parsed.keyId = String(parsed.keyId).trim().toUpperCase();
  if (parsed.operatorEmail) parsed.operatorEmail = String(parsed.operatorEmail).trim().toLowerCase();
  return parsed;
}

export function evaluateApplyGuards({
  apply = false,
  companyCode = null,
  keyId = null,
  confirm = null,
  operatorEmail = null,
  nodeEnv = "",
  uriConfigured = false,
  encryptionReady = false,
} = {}) {
  const missing = [];
  if (!apply) missing.push("--apply");
  if (String(companyCode || "") !== REQUIRED_COMPANY_CODE) missing.push("--company-code MAR");
  if (String(keyId || "") !== REQUIRED_KEY_ID) missing.push("--key-id K1");
  if (String(confirm || "") !== REQUIRED_CONFIRM) missing.push(`--confirm ${REQUIRED_CONFIRM}`);
  if (String(nodeEnv || "") !== "production") missing.push("NODE_ENV=production");
  if (!uriConfigured) missing.push("configured MongoDB URI");
  if (!encryptionReady) missing.push("valid PACKING_LABEL_SIGNING_ENCRYPTION_KEY");
  if (!String(operatorEmail || "").trim()) missing.push("--operator-email");
  return { ok: missing.length === 0, missing };
}

export function evaluateEncryptionReadiness(env = process.env) {
  const raw = String(env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] ?? "").trim();
  if (!raw) return { ready: false, code: LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED };
  if (!decodePackingLabelSigningEncryptionKey(raw)) {
    return { ready: false, code: LABEL_SIGNING_ENCRYPTION_KEY_INVALID };
  }
  return { ready: true, code: null };
}

export function generatePackingLabelHmacSecretBytes() {
  return crypto.randomBytes(HMAC_SECRET_BYTES);
}

export function wrapGeneratedSigningSecret(secretBytes, encryptBytes = encryptPackingLabelSigningSecretBytes) {
  if (!Buffer.isBuffer(secretBytes) || secretBytes.length !== HMAC_SECRET_BYTES) {
    throw new Error("HMAC signing secret must be exactly 32 random bytes.");
  }
  try {
    return encryptBytes(secretBytes);
  } finally {
    secretBytes.fill(0);
  }
}

export function normalizeOperatorEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function operatorIsPrivileged(user) {
  return isAdminRole(user?.role);
}

export function userAuthorizedForCompany(user, companyId) {
  if (!user) return false;
  const cid = String(companyId);
  const allowed = (user.allowedCompanies || []).map((id) => String(id));
  if (allowed.includes(cid)) return true;
  if (user.defaultCompany != null && String(user.defaultCompany) === cid) return true;
  return false;
}

export function signingKeyIndexesReady(indexes = []) {
  const rows = (indexes || []).filter((ix) => ix.name !== "_id_");
  for (const spec of SIGNING_KEY_INDEX_SPECS) {
    const byName = rows.find((ix) => ix.name === spec.name);
    if (!byName || !indexMatchesApprovedSpec(byName, spec)) return false;
    const equivalentOther = rows.find((ix) => ix.name !== spec.name && indexMatchesApprovedSpec(ix, spec));
    if (equivalentOther) return false;
  }
  return true;
}

export function redactSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text)
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, "[redacted-uri]")
    .replace(/\bv1b?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-envelope]")
    .replace(/\b(PACKING_LABEL_SIGNING_ENCRYPTION_KEY|MONGO_URI|MONGODB_URI)\b(\s*[:=]\s*)\S+/gi, "$1$2[redacted]");
}

function publicCreatedRecord(doc) {
  if (!doc) return null;
  return { id: String(doc._id), keyId: String(doc.keyId || ""), status: String(doc.status || "") };
}

function isDuplicateKeyError(err) {
  return Boolean(err && (Number(err.code) === 11000 || err.codeName === "DuplicateKey"));
}

async function collectionExists(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return rows.length > 0;
}

async function findMany(col, filter, projection) {
  const cursor = col.find(filter, projection ? { projection } : {});
  return cursor.toArray();
}

export async function runProvisionPackingLabelSigningKey({
  db,
  argv = [],
  nodeEnv = "",
  uriConfigured = false,
  env = process.env,
  generateHmacSecretBytes = generatePackingLabelHmacSecretBytes,
  encryptSecret = encryptPackingLabelSigningSecretBytes,
} = {}) {
  if (!db) throw new Error("database handle required");
  const args = parseProvisionPackingLabelSigningKeyArgs(argv);
  const encryption = evaluateEncryptionReadiness(env);
  const guards = evaluateApplyGuards({
    apply: args.apply,
    companyCode: args.companyCode,
    keyId: args.keyId,
    confirm: args.confirm,
    operatorEmail: args.operatorEmail,
    nodeEnv,
    uriConfigured,
    encryptionReady: encryption.ready,
  });
  const applyAuthorized = guards.ok;
  const mode = applyAuthorized ? "APPLY" : "DRY_RUN";

  const report = {
    mode,
    databaseName: String(db.databaseName || ""),
    companyCode: args.companyCode || null,
    companyId: null,
    keyId: args.keyId || null,
    requestedStatus: REQUESTED_STATUS,
    applyRequested: args.apply === true,
    applyAuthorized,
    applyGuards: {
      apply: args.apply === true,
      companyCode: args.companyCode || null,
      keyId: args.keyId || null,
      confirm: args.confirm || null,
      nodeEnvProduction: String(nodeEnv || "") === "production",
      uriConfigured: uriConfigured === true,
      encryptionReady: encryption.ready,
      missing: guards.missing,
    },
    preflight: {
      companyResolved: false,
      operatorReady: false,
      operatorResolved: false,
      collectionExists: false,
      indexesReady: false,
      keyIdValid: false,
    },
    existingActiveKeyCount: 0,
    existingRequestedKeyIdCount: 0,
    encryptionReady: encryption.ready,
    operatorEmail: null,
    operatorUserId: null,
    created: false,
    createdRecord: null,
    result: "READY_TO_PROVISION",
    errorCode: null,
  };

  if (!args.companyCode) {
    report.result = BLOCKED_COMPANY_NOT_FOUND;
    report.errorCode = BLOCKED_COMPANY_NOT_FOUND;
    return report;
  }
  if (!args.keyId || !PACKING_LABEL_SIGNING_KEY_ID_PATTERN.test(args.keyId)) {
    report.result = BLOCKED_INVALID_KEY_ID;
    report.errorCode = BLOCKED_INVALID_KEY_ID;
    return report;
  }
  report.preflight.keyIdValid = true;

  if (!encryption.ready) {
    report.result = encryption.code;
    report.errorCode = encryption.code;
    return report;
  }

  const companies = await findMany(
    db.collection(COMPANY_COLLECTION),
    { code: args.companyCode },
    { _id: 1, code: 1, isActive: 1 }
  );
  if (companies.length === 0) {
    report.result = BLOCKED_COMPANY_NOT_FOUND;
    report.errorCode = BLOCKED_COMPANY_NOT_FOUND;
    return report;
  }
  if (companies.length !== 1) {
    report.result = BLOCKED_COMPANY_AMBIGUOUS;
    report.errorCode = BLOCKED_COMPANY_AMBIGUOUS;
    return report;
  }
  const company = companies[0];
  if (company.isActive === false) {
    report.result = BLOCKED_COMPANY_INACTIVE;
    report.errorCode = BLOCKED_COMPANY_INACTIVE;
    return report;
  }
  report.preflight.companyResolved = true;
  report.companyId = String(company._id);
  report.companyCode = String(company.code || args.companyCode);

  let operator = null;
  if (args.operatorEmail) {
    const users = await findMany(
      db.collection(USER_COLLECTION),
      { email: args.operatorEmail },
      { _id: 1, email: 1, isActive: 1, role: 1, allowedCompanies: 1, defaultCompany: 1 }
    );
    if (users.length === 0) {
      report.result = BLOCKED_OPERATOR_NOT_FOUND;
      report.errorCode = BLOCKED_OPERATOR_NOT_FOUND;
      return report;
    }
    if (users.length !== 1) {
      report.result = BLOCKED_OPERATOR_AMBIGUOUS;
      report.errorCode = BLOCKED_OPERATOR_AMBIGUOUS;
      return report;
    }
    const candidate = users[0];
    if (candidate.isActive === false) {
      report.result = BLOCKED_OPERATOR_INACTIVE;
      report.errorCode = BLOCKED_OPERATOR_INACTIVE;
      return report;
    }
    if (!operatorIsPrivileged(candidate)) {
      report.result = BLOCKED_OPERATOR_NOT_PRIVILEGED;
      report.errorCode = BLOCKED_OPERATOR_NOT_PRIVILEGED;
      return report;
    }
    if (!userAuthorizedForCompany(candidate, company._id)) {
      report.result = BLOCKED_OPERATOR_NOT_AUTHORIZED;
      report.errorCode = BLOCKED_OPERATOR_NOT_AUTHORIZED;
      return report;
    }
    operator = candidate;
    report.preflight.operatorResolved = true;
    report.preflight.operatorReady = true;
    report.operatorEmail = String(candidate.email || args.operatorEmail);
    report.operatorUserId = String(candidate._id);
  }

  const keyColExists = await collectionExists(db, PACKING_LABEL_SIGNING_KEY_COLLECTION);
  report.preflight.collectionExists = keyColExists;
  if (!keyColExists) {
    report.result = BLOCKED_INDEXES_NOT_READY;
    report.errorCode = BLOCKED_INDEXES_NOT_READY;
    return report;
  }

  const keyCol = db.collection(PACKING_LABEL_SIGNING_KEY_COLLECTION);
  let indexes = [];
  try {
    indexes = await keyCol.indexes();
  } catch (err) {
    if (err?.codeName !== "NamespaceNotFound" && Number(err?.code) !== 26) throw err;
  }
  const indexesReady = signingKeyIndexesReady(indexes);
  report.preflight.indexesReady = indexesReady;
  if (!indexesReady) {
    report.result = BLOCKED_INDEXES_NOT_READY;
    report.errorCode = BLOCKED_INDEXES_NOT_READY;
    return report;
  }

  const activeCount = await keyCol.countDocuments({ companyId: company._id, status: "ACTIVE" });
  const keyIdCount = await keyCol.countDocuments({ companyId: company._id, keyId: args.keyId });
  report.existingActiveKeyCount = Number(activeCount || 0);
  report.existingRequestedKeyIdCount = Number(keyIdCount || 0);

  if (report.existingActiveKeyCount > 0) {
    report.result = BLOCKED_ACTIVE_KEY_EXISTS;
    report.errorCode = BLOCKED_ACTIVE_KEY_EXISTS;
    return report;
  }
  if (report.existingRequestedKeyIdCount > 0) {
    report.result = BLOCKED_KEY_ID_EXISTS;
    report.errorCode = BLOCKED_KEY_ID_EXISTS;
    return report;
  }

  if (args.apply && !args.operatorEmail) {
    report.preflight.operatorReady = false;
    report.result = PACKING_LABEL_OPERATOR_REQUIRED;
    report.errorCode = PACKING_LABEL_OPERATOR_REQUIRED;
    return report;
  }
  if (args.apply && !applyAuthorized) {
    report.result = PACKING_LABEL_APPLY_GUARDS_MISSING;
    report.errorCode = PACKING_LABEL_APPLY_GUARDS_MISSING;
    return report;
  }
  if (!applyAuthorized) {
    report.result = "READY_TO_PROVISION";
    return report;
  }

  const secretBytes = generateHmacSecretBytes();
  let envelope;
  try {
    envelope = wrapGeneratedSigningSecret(secretBytes, encryptSecret);
  } catch (err) {
    if (Buffer.isBuffer(secretBytes)) secretBytes.fill(0);
    report.result = err?.code || LABEL_SIGNING_ENCRYPTION_KEY_INVALID;
    report.errorCode = err?.code || LABEL_SIGNING_ENCRYPTION_KEY_INVALID;
    return report;
  }

  const now = new Date();
  const doc = {
    companyId: company._id,
    keyId: args.keyId,
    encryptedSecret: envelope,
    status: REQUESTED_STATUS,
    activatedAt: now,
    retiredAt: null,
    createdBy: String(operator.email || args.operatorEmail),
    createdByUserId: operator._id,
    createdAt: now,
    updatedAt: now,
  };
  envelope = "";

  try {
    const inserted = await keyCol.insertOne(doc);
    doc.encryptedSecret = "";
    const createdId = inserted?.insertedId;
    const stored = createdId
      ? (
          await findMany(
            keyCol,
            { _id: createdId },
            { _id: 1, keyId: 1, status: 1 }
          )
        )[0]
      : null;
    report.created = true;
    report.createdRecord = publicCreatedRecord(stored || { _id: createdId, keyId: args.keyId, status: REQUESTED_STATUS });
    report.result = "PROVISIONED";
    report.errorCode = null;
    return report;
  } catch (err) {
    doc.encryptedSecret = "";
    const after = await findMany(
      keyCol,
      { companyId: company._id, keyId: args.keyId },
      { _id: 1, keyId: 1, status: 1 }
    );
    report.created = after.length > 0;
    report.createdRecord = publicCreatedRecord(after[0] || null);
    report.result = isDuplicateKeyError(err) ? PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT : PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT;
    report.errorCode = PACKING_LABEL_SIGNING_KEY_INSERT_CONFLICT;
    return report;
  }
}

export function publicReport(report) {
  const createdRecord = report.createdRecord
    ? {
        id: String(report.createdRecord.id || ""),
        keyId: String(report.createdRecord.keyId || ""),
        status: String(report.createdRecord.status || ""),
      }
    : null;
  return {
    mode: report.mode,
    databaseName: report.databaseName,
    companyCode: report.companyCode,
    companyId: report.companyId,
    keyId: report.keyId,
    requestedStatus: report.requestedStatus,
    preflight: report.preflight,
    existingActiveKeyCount: report.existingActiveKeyCount,
    existingRequestedKeyIdCount: report.existingRequestedKeyIdCount,
    encryptionReady: report.encryptionReady === true,
    operatorReady: report.preflight?.operatorReady === true,
    operatorEmail: report.operatorEmail || null,
    operatorUserId: report.operatorUserId || null,
    created: report.created === true,
    createdRecord,
    result: report.result,
    errorCode: report.errorCode,
    applyRequested: report.applyRequested === true,
    applyAuthorized: report.applyAuthorized === true,
    applyGuards: {
      missing: report.applyGuards?.missing || [],
    },
  };
}

export function exitCodeForReport(report) {
  if (!report) return 1;
  if (report.result === "PROVISIONED" || report.result === "READY_TO_PROVISION") return 0;
  if (report.result === BLOCKED_INDEXES_NOT_READY) return 2;
  if (report.result === BLOCKED_ACTIVE_KEY_EXISTS || report.result === BLOCKED_KEY_ID_EXISTS) return 3;
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

function assertNoSecretFields(value, trail = "report") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) throw new Error(`refusing to print ${trail}.${key}`);
    if (child && typeof child === "object") assertNoSecretFields(child, `${trail}.${key}`);
  }
}

async function connectAndRun() {
  const { default: mongoose } = await import("mongoose");
  await import("../src/loadEnv.js");
  mongoose.set("autoIndex", false);
  const uriConfigured = Boolean(process.env.MONGO_URI || process.env.MONGODB_URI);
  if (!uriConfigured) {
    const report = publicReport({
      mode: "DRY_RUN",
      databaseName: "",
      result: "MONGO_URI_NOT_CONFIGURED",
      errorCode: "MONGO_URI_NOT_CONFIGURED",
      preflight: {},
      applyGuards: { missing: ["configured MongoDB URI"] },
    });
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 20000,
    });
    const report = publicReport(
      await runProvisionPackingLabelSigningKey({
        db: mongoose.connection.db,
        argv: process.argv.slice(2),
        nodeEnv: process.env.NODE_ENV,
        uriConfigured: true,
      })
    );
    assertNoSecretFields(report);
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
