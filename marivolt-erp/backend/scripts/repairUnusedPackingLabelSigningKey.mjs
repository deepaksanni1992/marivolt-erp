/**
 * Repair unused ACTIVE MAR packing-label K1 by replacing only encryptedSecret.
 *
 * Default: DRY RUN. Does not generate a signing secret or write unless every
 * apply guard and unused-key preflight is present.
 *
 * Never prints plaintext secrets, envelopes, encryption keys, or MongoDB URIs.
 * Never deletes, reinserts, rotates keyId, or mutates indexes.
 * Never mints PackingLabelUnits, increments counters, or creates print jobs.
 *
 *   node scripts/repairUnusedPackingLabelSigningKey.mjs --company-code MAR --key-id K1
 *   NODE_ENV=production node scripts/repairUnusedPackingLabelSigningKey.mjs --apply --company-code MAR --key-id K1 --operator-email admin@marivoltz.com --confirm REKEY_UNUSED_FIRST_ACTIVE_PACKING_KEY
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKING_LABEL_SIGNING_KEY_ID_PATTERN } from "../src/models/PackingLabelSigningKey.js";
import { PACKING_LABEL_NO_PATTERN } from "../src/models/PackingLabelUnit.js";
import { PACKING_QR_LANDSCAPE_V1_CODE } from "../src/services/label/packingQrLandscapeV1.js";
import {
  LABEL_SIGNING_ENCRYPTION_KEY_INVALID,
  LABEL_SIGNING_SECRET_UNWRAP_FAILED,
  encryptPackingLabelSigningSecretBytes,
  signMar1Token,
  unwrapPackingLabelSigningSecret,
  verifyMar1TokenLocal,
} from "../src/services/label/packingLabelSigningService.js";
import {
  PACKING_LABEL_INDEX_SPECS,
  PACKING_LABEL_SIGNING_KEY_COLLECTION,
  PACKING_LABEL_UNIT_COLLECTION,
  indexMatchesApprovedSpec,
} from "./ensurePackingLabelIndexes.mjs";
import {
  BLOCKED_COMPANY_AMBIGUOUS,
  BLOCKED_COMPANY_INACTIVE,
  BLOCKED_COMPANY_NOT_FOUND,
  BLOCKED_INDEXES_NOT_READY,
  BLOCKED_INVALID_KEY_ID,
  BLOCKED_OPERATOR_AMBIGUOUS,
  BLOCKED_OPERATOR_INACTIVE,
  BLOCKED_OPERATOR_NOT_AUTHORIZED,
  BLOCKED_OPERATOR_NOT_FOUND,
  BLOCKED_OPERATOR_NOT_PRIVILEGED,
  COMPANY_COLLECTION,
  HMAC_SECRET_BYTES,
  PACKING_LABEL_APPLY_GUARDS_MISSING,
  PACKING_LABEL_OPERATOR_REQUIRED,
  USER_COLLECTION,
  evaluateEncryptionReadiness,
  generatePackingLabelHmacSecretBytes,
  normalizeOperatorEmail,
  operatorIsPrivileged,
  redactSecrets,
  userAuthorizedForCompany,
  wrapGeneratedSigningSecret,
} from "./provisionPackingLabelSigningKey.mjs";

export const REQUIRED_COMPANY_CODE = "MAR";
export const REQUIRED_KEY_ID = "K1";
export const REQUIRED_OPERATOR_EMAIL = "admin@marivoltz.com";
export const REQUIRED_CONFIRM = "REKEY_UNUSED_FIRST_ACTIVE_PACKING_KEY";
export const REQUESTED_STATUS = "ACTIVE";
export const LABEL_PRINT_JOB_COLLECTION = "labelprintjobs";
export const LABEL_PRINT_HISTORY_COLLECTION = "labelprinthistories";
export const COUNTER_COLLECTION = "counters";
export const PACKING_LABEL_COUNTER_KEY = "packingLabelUnit";
export const LOCKED_TEST_LABEL_NO = "MAR-PL-000001";

export const PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED = "PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED";
export const PACKING_LABEL_KEY_REPAIR_UNSAFE = "PACKING_LABEL_KEY_REPAIR_UNSAFE";
export const PACKING_LABEL_KEY_REPAIR_CONFLICT = "PACKING_LABEL_KEY_REPAIR_CONFLICT";
export const PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED = "PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED";
export const BLOCKED_SIGNING_KEY_COUNT = "BLOCKED_SIGNING_KEY_COUNT";
export const BLOCKED_KEY_NOT_ACTIVE_K1 = "BLOCKED_KEY_NOT_ACTIVE_K1";
export const BLOCKED_SECRET_REF = "BLOCKED_SECRET_REF";
export const BLOCKED_ENVELOPE_NOT_V1B = "BLOCKED_ENVELOPE_NOT_V1B";

export const SIGNING_KEY_INDEX_SPECS = Object.freeze(
  PACKING_LABEL_INDEX_SPECS.filter((spec) => spec.collection === PACKING_LABEL_SIGNING_KEY_COLLECTION)
);

const SECRET_FIELD_NAMES = new Set(["encryptedSecret", "secretRef", "passwordHash", "twoFactorSecret"]);
/** Complete MAR1 K1 token inside TSPL/raw-face payloads. Signature is exactly 22 Base64URL chars. */
export const MAR1_K1_COMPLETE_TOKEN_RE = /MAR1\.MAR-PL-[0-9]{1,8}\.K1\.[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/;

export function buildLabelPrintJobDependencyFilter(companyId) {
  if (companyId == null || companyId === "") {
    throw new Error("companyId is required for packing-label job dependency query");
  }
  return {
    companyId,
    $or: [
      { "lines.packingLabelUnitId": { $type: "objectId" } },
      { "lines.labelId": PACKING_LABEL_NO_PATTERN },
      { "lines.labelNo": PACKING_LABEL_NO_PATTERN },
      { "lines.barcodeValue": PACKING_LABEL_NO_PATTERN },
      { tsplPayload: MAR1_K1_COMPLETE_TOKEN_RE },
      { rawFacePayloads: MAR1_K1_COMPLETE_TOKEN_RE },
    ],
  };
}

export function parseRepairUnusedPackingLabelSigningKeyArgs(argv = []) {
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
  if (parsed.operatorEmail) parsed.operatorEmail = normalizeOperatorEmail(parsed.operatorEmail);
  return parsed;
}

export function evaluateRepairApplyGuards({
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
  if (normalizeOperatorEmail(operatorEmail) !== REQUIRED_OPERATOR_EMAIL) {
    missing.push(`--operator-email ${REQUIRED_OPERATOR_EMAIL}`);
  }
  return { ok: missing.length === 0, missing };
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

export function envelopePrefixVersion(stored) {
  const value = String(stored || "").trim();
  if (value.startsWith("v1b:")) return "v1b";
  if (value.startsWith("v1:")) return "v1";
  return "";
}

function secretPresent(value) {
  return String(value || "").trim() !== "";
}

export function probeCurrentEnvelopeUnwrap(encryptedSecret, unwrapFn = unwrapPackingLabelSigningSecret) {
  let recovered;
  try {
    recovered = unwrapFn(encryptedSecret);
    return { ready: true, code: null };
  } catch (err) {
    return { ready: false, code: err?.code || LABEL_SIGNING_ENCRYPTION_KEY_INVALID };
  } finally {
    if (Buffer.isBuffer(recovered)) recovered.fill(0);
  }
}

function emptyDependencies() {
  return {
    packingLabelUnitsMar: 0,
    packingLabelUnitsLandscape: 0,
    packingLabelUnitsSignedByK1: 0,
    landscapeJobs: 0,
    jobsReferencingSigningKey: 0,
    marPlIdentities: 0,
    packingLabelCounterSeq: 0,
    packingLabelCounterExists: false,
  };
}

async function collectionExists(db, name) {
  const rows = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return rows.length > 0;
}

async function findMany(col, filter, projection) {
  const cursor = col.find(filter, projection ? { projection } : {});
  return cursor.toArray();
}

async function safeCount(db, name, filter = {}) {
  if (!(await collectionExists(db, name))) return 0;
  return db.collection(name).countDocuments(filter);
}

async function collectDependencyCounts(db, companyId) {
  const counts = emptyDependencies();
  counts.packingLabelUnitsMar = await safeCount(db, PACKING_LABEL_UNIT_COLLECTION, { companyId });
  counts.packingLabelUnitsLandscape = await safeCount(db, PACKING_LABEL_UNIT_COLLECTION, {
    $or: [{ qrVersion: "MAR1" }, { signingKeyId: REQUIRED_KEY_ID }, { labelNo: PACKING_LABEL_NO_PATTERN }],
  });
  counts.packingLabelUnitsSignedByK1 = await safeCount(db, PACKING_LABEL_UNIT_COLLECTION, {
    signingKeyId: REQUIRED_KEY_ID,
  });
  const jobDependencyFilter = buildLabelPrintJobDependencyFilter(companyId);
  counts.landscapeJobs = await safeCount(db, LABEL_PRINT_JOB_COLLECTION, {
    companyId,
    templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
  });
  counts.jobsReferencingSigningKey = await safeCount(db, LABEL_PRINT_JOB_COLLECTION, jobDependencyFilter);
  counts.marPlIdentities =
    counts.packingLabelUnitsSignedByK1 +
    counts.jobsReferencingSigningKey +
    (await safeCount(db, LABEL_PRINT_HISTORY_COLLECTION, { companyId, templateCode: PACKING_QR_LANDSCAPE_V1_CODE }));

  if (await collectionExists(db, COUNTER_COLLECTION)) {
    const rows = await findMany(
      db.collection(COUNTER_COLLECTION),
      { companyId, key: PACKING_LABEL_COUNTER_KEY },
      { _id: 1, seq: 1, key: 1 }
    );
    counts.packingLabelCounterExists = rows.length > 0;
    counts.packingLabelCounterSeq = rows.length ? Number(rows[0].seq || 0) : 0;
  }
  return counts;
}

function dependenciesUnsafe(counts) {
  return (
    Number(counts.packingLabelUnitsMar || 0) !== 0 ||
    Number(counts.packingLabelUnitsLandscape || 0) !== 0 ||
    Number(counts.packingLabelUnitsSignedByK1 || 0) !== 0 ||
    Number(counts.landscapeJobs || 0) !== 0 ||
    Number(counts.jobsReferencingSigningKey || 0) !== 0 ||
    Number(counts.marPlIdentities || 0) !== 0 ||
    Number(counts.packingLabelCounterSeq || 0) !== 0
  );
}

export async function runRepairUnusedPackingLabelSigningKey({
  db,
  argv = [],
  nodeEnv = "",
  uriConfigured = false,
  env = process.env,
  generateHmacSecretBytes = generatePackingLabelHmacSecretBytes,
  encryptSecret = encryptPackingLabelSigningSecretBytes,
  unwrapSecret = unwrapPackingLabelSigningSecret,
} = {}) {
  if (!db) throw new Error("database handle required");
  const args = parseRepairUnusedPackingLabelSigningKeyArgs(argv);
  const encryption = evaluateEncryptionReadiness(env);
  const guards = evaluateRepairApplyGuards({
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
    status: null,
    recordId: null,
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
      unusedKeyReady: false,
    },
    operatorEmail: null,
    operatorUserId: null,
    dependencyCounts: emptyDependencies(),
    currentUnwrapReady: false,
    created: false,
    updated: false,
    result: "READY_TO_REPAIR",
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

  const keys = await findMany(
    keyCol,
    { companyId: company._id },
    {
      _id: 1,
      companyId: 1,
      keyId: 1,
      status: 1,
      encryptedSecret: 1,
      secretRef: 1,
      createdAt: 1,
      createdBy: 1,
      createdByUserId: 1,
      activatedAt: 1,
      retiredAt: 1,
      updatedAt: 1,
    }
  );
  if (keys.length !== 1) {
    report.result = BLOCKED_SIGNING_KEY_COUNT;
    report.errorCode = BLOCKED_SIGNING_KEY_COUNT;
    return report;
  }
  const current = keys[0];
  report.recordId = String(current._id);
  report.keyId = String(current.keyId || "");
  report.status = String(current.status || "");
  if (String(current.keyId || "").toUpperCase() !== REQUIRED_KEY_ID || String(current.status || "") !== REQUESTED_STATUS) {
    report.result = BLOCKED_KEY_NOT_ACTIVE_K1;
    report.errorCode = BLOCKED_KEY_NOT_ACTIVE_K1;
    return report;
  }
  if (secretPresent(current.secretRef)) {
    report.result = BLOCKED_SECRET_REF;
    report.errorCode = BLOCKED_SECRET_REF;
    return report;
  }
  if (!secretPresent(current.encryptedSecret) || envelopePrefixVersion(current.encryptedSecret) !== "v1b") {
    report.result = BLOCKED_ENVELOPE_NOT_V1B;
    report.errorCode = BLOCKED_ENVELOPE_NOT_V1B;
    return report;
  }

  report.dependencyCounts = await collectDependencyCounts(db, company._id);
  if (dependenciesUnsafe(report.dependencyCounts)) {
    report.result = PACKING_LABEL_KEY_REPAIR_UNSAFE;
    report.errorCode = PACKING_LABEL_KEY_REPAIR_UNSAFE;
    return report;
  }
  report.preflight.unusedKeyReady = true;

  const unwrapProbe = probeCurrentEnvelopeUnwrap(current.encryptedSecret, unwrapSecret);
  report.currentUnwrapReady = unwrapProbe.ready === true;
  if (unwrapProbe.ready) {
    report.result = PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED;
    report.errorCode = PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED;
    return report;
  }
  if (unwrapProbe.code !== LABEL_SIGNING_SECRET_UNWRAP_FAILED) {
    report.result = unwrapProbe.code || LABEL_SIGNING_SECRET_UNWRAP_FAILED;
    report.errorCode = unwrapProbe.code || LABEL_SIGNING_SECRET_UNWRAP_FAILED;
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
    report.result = "READY_TO_REPAIR";
    return report;
  }

  const originalCreatedAt = current.createdAt;
  const originalCreatedBy = current.createdBy;
  const originalCreatedByUserId = current.createdByUserId;
  const currentEnvelope = String(current.encryptedSecret);

  const secretBytes = generateHmacSecretBytes();
  let envelope = "";
  try {
    envelope = wrapGeneratedSigningSecret(secretBytes, encryptSecret);
  } catch (err) {
    if (Buffer.isBuffer(secretBytes)) secretBytes.fill(0);
    envelope = "";
    report.result = err?.code || LABEL_SIGNING_ENCRYPTION_KEY_INVALID;
    report.errorCode = err?.code || LABEL_SIGNING_ENCRYPTION_KEY_INVALID;
    return report;
  }

  const now = new Date();
  const filter = {
    _id: current._id,
    companyId: current.companyId,
    keyId: REQUIRED_KEY_ID,
    status: REQUESTED_STATUS,
    encryptedSecret: currentEnvelope,
    $or: [{ secretRef: { $exists: false } }, { secretRef: "" }, { secretRef: null }],
  };
  const update = { $set: { encryptedSecret: envelope, updatedAt: now } };
  envelope = "";

  let matchedCount = 0;
  try {
    const result = await keyCol.updateOne(filter, update);
    matchedCount = Number(result?.matchedCount || 0);
  } catch (err) {
    report.result = err?.code || PACKING_LABEL_KEY_REPAIR_CONFLICT;
    report.errorCode = err?.code || PACKING_LABEL_KEY_REPAIR_CONFLICT;
    return report;
  }
  if (matchedCount !== 1) {
    report.result = PACKING_LABEL_KEY_REPAIR_CONFLICT;
    report.errorCode = PACKING_LABEL_KEY_REPAIR_CONFLICT;
    return report;
  }

  const storedRows = await findMany(
    keyCol,
    { _id: current._id },
    {
      _id: 1,
      companyId: 1,
      keyId: 1,
      status: 1,
      encryptedSecret: 1,
      secretRef: 1,
      createdAt: 1,
      createdBy: 1,
      createdByUserId: 1,
    }
  );
  const stored = storedRows[0];
  if (
    !stored ||
    String(stored._id) !== String(current._id) ||
    String(stored.keyId || "") !== REQUIRED_KEY_ID ||
    String(stored.status || "") !== REQUESTED_STATUS ||
    String(stored.createdBy || "") !== String(originalCreatedBy || "") ||
    String(stored.createdByUserId || "") !== String(originalCreatedByUserId || "") ||
    String(stored.createdAt || "") !== String(originalCreatedAt || "") ||
    envelopePrefixVersion(stored.encryptedSecret) !== "v1b" ||
    secretPresent(stored.secretRef)
  ) {
    report.result = PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED;
    report.errorCode = PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED;
    return report;
  }

  let recovered;
  try {
    recovered = unwrapSecret(stored.encryptedSecret);
    if (!Buffer.isBuffer(recovered) || recovered.length !== HMAC_SECRET_BYTES) {
      throw new Error("repaired secret is not 32 raw bytes");
    }
    const signed = signMar1Token({ labelNo: LOCKED_TEST_LABEL_NO, keyId: REQUIRED_KEY_ID, secret: recovered });
    const verified = verifyMar1TokenLocal({
      token: signed.token,
      secret: recovered,
      expectedLabelNo: LOCKED_TEST_LABEL_NO,
      expectedKeyId: REQUIRED_KEY_ID,
    });
    if (!verified.ok) {
      throw new Error(verified.message || "repaired signature verification failed");
    }
  } catch (err) {
    report.result = err?.code || PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED;
    report.errorCode = err?.code || PACKING_LABEL_KEY_REPAIR_VERIFY_FAILED;
    return report;
  } finally {
    if (Buffer.isBuffer(recovered)) recovered.fill(0);
  }

  report.dependencyCounts = await collectDependencyCounts(db, company._id);
  if (dependenciesUnsafe(report.dependencyCounts)) {
    report.result = PACKING_LABEL_KEY_REPAIR_UNSAFE;
    report.errorCode = PACKING_LABEL_KEY_REPAIR_UNSAFE;
    return report;
  }

  report.updated = true;
  report.currentUnwrapReady = true;
  report.result = "REPAIRED";
  report.errorCode = null;
  return report;
}

export function publicReport(report) {
  return {
    mode: report.mode,
    databaseName: report.databaseName,
    companyCode: report.companyCode,
    companyId: report.companyId,
    keyId: report.keyId,
    status: report.status,
    recordId: report.recordId,
    operatorEmail: report.operatorEmail || null,
    operatorUserId: report.operatorUserId || null,
    dependencyCounts: report.dependencyCounts || emptyDependencies(),
    currentUnwrapReady: report.currentUnwrapReady === true,
    created: false,
    updated: report.updated === true,
    result: report.result,
    errorCode: report.errorCode,
    applyRequested: report.applyRequested === true,
    applyAuthorized: report.applyAuthorized === true,
    preflight: {
      companyResolved: report.preflight?.companyResolved === true,
      operatorReady: report.preflight?.operatorReady === true,
      unusedKeyReady: report.preflight?.unusedKeyReady === true,
      indexesReady: report.preflight?.indexesReady === true,
    },
    applyGuards: {
      missing: report.applyGuards?.missing || [],
    },
  };
}

export function exitCodeForReport(report) {
  if (!report) return 1;
  if (report.result === "REPAIRED" || report.result === "READY_TO_REPAIR") return 0;
  if (report.result === PACKING_LABEL_KEY_REPAIR_NOT_REQUIRED) return 0;
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
      dependencyCounts: emptyDependencies(),
    });
    console.log(redactSecrets(JSON.stringify(report, null, 2)));
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 20000,
    });
    const report = publicReport(
      await runRepairUnusedPackingLabelSigningKey({
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
