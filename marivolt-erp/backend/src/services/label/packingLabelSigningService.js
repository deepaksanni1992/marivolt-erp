/**
 * MAR1 packing-label HMAC signing.
 *
 * Canonical envelope (locked Phase 1 spec):
 *   u8 formatTag = 0x01
 *   u16be(len(versionUtf8)) + versionUtf8  // "MAR1"
 *   u16be(len(labelNoUtf8)) + labelNoUtf8
 *   u16be(len(keyIdUtf8)) + keyIdUtf8
 *
 * HMAC-SHA256, truncate first 16 bytes, Base64URL without padding (22 chars).
 * Verify with crypto.timingSafeEqual on the raw 16-byte digest.
 *
 * Never log or return key material. Log keyId only.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import PackingLabelSigningKey, {
  PACKING_LABEL_SIGNING_KEY_ID_PATTERN,
} from "../../models/PackingLabelSigningKey.js";
import PackingLabelUnit, { PACKING_LABEL_NO_PATTERN } from "../../models/PackingLabelUnit.js";
import {
  LABEL_QR_PAYLOAD_OVERFLOW,
  MAR1_KEY_ID_PATTERN,
  MAR1_LABEL_NO_PATTERN,
  MAR1_MAX_PAYLOAD_BYTES,
  MAR1_SIGNATURE_B64URL_CHARS,
  MAR1_SIGNATURE_B64URL_PATTERN,
  MAR1_SIGNATURE_BYTES,
  MAR1_TOKEN_VERSION,
  buildMar1TokenExample,
  validateMar1ProductionQrToken,
} from "./packingQrLandscapeV1.js";

const ENC_PREFIX = "v1:";
const ENC_PREFIX_BYTES = "v1b:";
export const PACKING_LABEL_SECRET_ENVELOPE_VERSION = "v1";
export const PACKING_LABEL_SECRET_ENVELOPE_VERSION_BYTES = "v1b";
export const PACKING_LABEL_GCM_IV_BYTES = 12;
export const PACKING_LABEL_GCM_TAG_BYTES = 16;
export const PACKING_LABEL_SIGNING_ENCRYPTION_KEY_BYTES = 32;
export const PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV = "PACKING_LABEL_SIGNING_ENCRYPTION_KEY";
export const MAR1_FORMAT_TAG = 0x01;
export const LABEL_SIGNING_KEY_REQUIRED = "LABEL_SIGNING_KEY_REQUIRED";
export const LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED = "LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED";
export const LABEL_SIGNING_ENCRYPTION_KEY_INVALID = "LABEL_SIGNING_ENCRYPTION_KEY_INVALID";
export const LABEL_SIGNING_SECRET_FORMAT = "LABEL_SIGNING_SECRET_FORMAT";
export const LABEL_SIGNING_SECRET_UNWRAP_FAILED = "LABEL_SIGNING_SECRET_UNWRAP_FAILED";
export const LABEL_SIGNING_SECRET_REF_MISSING = "LABEL_SIGNING_SECRET_REF_MISSING";

function signingError(message, statusCode, code) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

function isAsciiOnly(value) {
  const s = String(value ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(String(value || ""), "base64url");
  } catch {
    return null;
  }
}

const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
const B64URL_UNPADDED_ALPHABET = /^[A-Za-z0-9_-]+$/;

/**
 * Decode PACKING_LABEL_SIGNING_ENCRYPTION_KEY to exactly 32 random bytes.
 * Accepted: exactly 64 hexadecimal characters, or canonical Base64URL without
 * padding that decodes to 32 bytes and round-trips.
 * Does not accept raw UTF-8, padded Base64, noncanonical encodings, hashes,
 * padding, truncation, defaults, or JWT_SECRET / TOTP_ENCRYPTION_KEY.
 */
export function decodePackingLabelSigningEncryptionKey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (HEX_32_BYTES.test(value)) {
    const hex = Buffer.from(value, "hex");
    return hex.length === PACKING_LABEL_SIGNING_ENCRYPTION_KEY_BYTES ? hex : null;
  }
  if (value.includes("=") || value.includes("+") || value.includes("/")) return null;
  if (!B64URL_UNPADDED_ALPHABET.test(value)) return null;
  const decoded = decodeBase64Url(value);
  if (!decoded || decoded.length !== PACKING_LABEL_SIGNING_ENCRYPTION_KEY_BYTES) return null;
  if (decoded.toString("base64url") !== value) return null;
  return decoded;
}

export function resolvePackingLabelSigningEncryptionKeyBytes() {
  const raw = String(process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] ?? "").trim();
  if (!raw) {
    throw signingError(
      "PACKING_LABEL_SIGNING_ENCRYPTION_KEY is required to wrap packing-label signing secrets.",
      409,
      LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED
    );
  }
  const bytes = decodePackingLabelSigningEncryptionKey(raw);
  if (!bytes) {
    throw signingError(
      "PACKING_LABEL_SIGNING_ENCRYPTION_KEY must decode to exactly 32 bytes.",
      409,
      LABEL_SIGNING_ENCRYPTION_KEY_INVALID
    );
  }
  return bytes;
}

/**
 * Parse the versioned AES-256-GCM envelope without decrypting.
 * Format: v1:<nonceB64url>.<ciphertextB64url>.<tagB64url>   (UTF-8 string plaintext)
 *         v1b:<nonceB64url>.<ciphertextB64url>.<tagB64url>  (raw HMAC key bytes)
 */
export function parsePackingLabelSecretEnvelope(stored) {
  const value = String(stored || "").trim();
  let version = PACKING_LABEL_SECRET_ENVELOPE_VERSION;
  let payload = "";
  if (value.startsWith(ENC_PREFIX_BYTES)) {
    version = PACKING_LABEL_SECRET_ENVELOPE_VERSION_BYTES;
    payload = value.slice(ENC_PREFIX_BYTES.length);
  } else if (value.startsWith(ENC_PREFIX)) {
    payload = value.slice(ENC_PREFIX.length);
  } else {
    throw signingError("Invalid packing-label signing secret envelope.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const parts = payload.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw signingError("Invalid packing-label signing secret envelope.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const nonce = decodeBase64Url(parts[0]);
  const ciphertext = decodeBase64Url(parts[1]);
  const tag = decodeBase64Url(parts[2]);
  if (
    !nonce ||
    !ciphertext ||
    !tag ||
    nonce.length !== PACKING_LABEL_GCM_IV_BYTES ||
    ciphertext.length < 1 ||
    tag.length !== PACKING_LABEL_GCM_TAG_BYTES
  ) {
    throw signingError("Invalid packing-label signing secret envelope.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  return {
    version,
    nonce,
    ciphertext,
    tag,
  };
}

function formatPackingLabelSecretEnvelope({ nonce, ciphertext, tag, version = PACKING_LABEL_SECRET_ENVELOPE_VERSION }) {
  const prefix = version === PACKING_LABEL_SECRET_ENVELOPE_VERSION_BYTES ? ENC_PREFIX_BYTES : ENC_PREFIX;
  return `${prefix}${Buffer.from(nonce).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}.${Buffer.from(tag).toString("base64url")}`;
}

function gcmSeal(plaintext, version) {
  const key = resolvePackingLabelSigningEncryptionKeyBytes();
  try {
    const nonce = crypto.randomBytes(PACKING_LABEL_GCM_IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== PACKING_LABEL_GCM_TAG_BYTES) {
      throw signingError("Packing-label signing secret could not be wrapped.", 409, LABEL_SIGNING_SECRET_UNWRAP_FAILED);
    }
    return formatPackingLabelSecretEnvelope({ nonce, ciphertext, tag, version });
  } finally {
    key.fill(0);
  }
}

function gcmOpen(stored, expectedVersion) {
  const value = String(stored || "").trim();
  if (!value) {
    throw signingError("Packing-label signing secret envelope is missing.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const parsed = parsePackingLabelSecretEnvelope(value);
  if (expectedVersion && parsed.version !== expectedVersion) {
    throw signingError("Invalid packing-label signing secret envelope.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const key = resolvePackingLabelSigningEncryptionKeyBytes();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, parsed.nonce);
    decipher.setAuthTag(parsed.tag);
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
  } catch (err) {
    if (err?.code === LABEL_SIGNING_SECRET_FORMAT) throw err;
    throw signingError(
      "Packing-label signing secret could not be unwrapped.",
      409,
      LABEL_SIGNING_SECRET_UNWRAP_FAILED
    );
  } finally {
    key.fill(0);
  }
}

/** AES-256-GCM. New random 12-byte nonce every call. UTF-8 string plaintext (v1). */
export function encryptPackingLabelSigningSecret(plainSecret) {
  const plain = String(plainSecret || "");
  if (!plain) {
    throw signingError("Packing-label signing secret is empty.", 409, LABEL_SIGNING_KEY_REQUIRED);
  }
  return gcmSeal(Buffer.from(plain, "utf8"), PACKING_LABEL_SECRET_ENVELOPE_VERSION);
}

/** AES-256-GCM wrap of raw HMAC key bytes (v1b). Does not stringify the buffer. */
export function encryptPackingLabelSigningSecretBytes(secretBytes) {
  if (!Buffer.isBuffer(secretBytes) || secretBytes.length < 1) {
    throw signingError("Packing-label signing secret is empty.", 409, LABEL_SIGNING_KEY_REQUIRED);
  }
  return gcmSeal(secretBytes, PACKING_LABEL_SECRET_ENVELOPE_VERSION_BYTES);
}

export function decryptPackingLabelSigningSecret(stored) {
  return gcmOpen(stored, PACKING_LABEL_SECRET_ENVELOPE_VERSION).toString("utf8");
}

export function decryptPackingLabelSigningSecretBytes(stored) {
  return gcmOpen(stored, PACKING_LABEL_SECRET_ENVELOPE_VERSION_BYTES);
}

/** Returns a UTF-8 string for v1 envelopes or a Buffer for v1b envelopes. */
export function unwrapPackingLabelSigningSecret(stored) {
  const value = String(stored || "").trim();
  if (value.startsWith(ENC_PREFIX_BYTES)) return decryptPackingLabelSigningSecretBytes(value);
  return decryptPackingLabelSigningSecret(value);
}

export function buildMar1CanonicalBytes({
  labelNo,
  keyId,
  version = MAR1_TOKEN_VERSION,
  formatTag = MAR1_FORMAT_TAG,
} = {}) {
  const versionUtf8 = Buffer.from(String(version || MAR1_TOKEN_VERSION), "utf8");
  const labelUtf8 = Buffer.from(String(labelNo || ""), "utf8");
  const keyUtf8 = Buffer.from(String(keyId || ""), "ascii");
  const parts = [
    Buffer.from([formatTag & 0xff]),
    Buffer.alloc(2),
    versionUtf8,
    Buffer.alloc(2),
    labelUtf8,
    Buffer.alloc(2),
    keyUtf8,
  ];
  parts[1].writeUInt16BE(versionUtf8.length, 0);
  parts[3].writeUInt16BE(labelUtf8.length, 0);
  parts[5].writeUInt16BE(keyUtf8.length, 0);
  return Buffer.concat(parts);
}

export function hmacMar1SignatureBytes(canonicalBytes, secret) {
  const missing = Buffer.isBuffer(secret) ? secret.length < 1 : !secret;
  if (missing) {
    throw signingError("Signing secret is required", 409, LABEL_SIGNING_KEY_REQUIRED);
  }
  const allocated = !Buffer.isBuffer(secret);
  const key = allocated ? Buffer.from(String(secret), "utf8") : secret;
  try {
    const digest = crypto.createHmac("sha256", key);
    digest.update(canonicalBytes);
    return digest.digest().subarray(0, MAR1_SIGNATURE_BYTES);
  } finally {
    if (allocated) key.fill(0);
  }
}

export function encodeMar1Signature(raw16) {
  return Buffer.from(raw16).toString("base64url");
}

export function decodeMar1Signature(signatureB64Url) {
  const s = String(signatureB64Url || "");
  if (!MAR1_SIGNATURE_B64URL_PATTERN.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  if (buf.length !== MAR1_SIGNATURE_BYTES) return null;
  return buf;
}

export function parseMar1Token(token) {
  const raw = String(token ?? "");
  if (!raw || !isAsciiOnly(raw)) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "MAR1 token must be ASCII" };
  }
  const parts = raw.split(".");
  if (parts.length !== 4) {
    return {
      ok: false,
      code: "LABEL_QR_TOKEN_INVALID",
      message: "MAR1 token must be MAR1.<labelNo>.<keyId>.<signatureBase64Url>",
    };
  }
  const [version, labelNo, keyId, signature] = parts;
  if (version !== MAR1_TOKEN_VERSION) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "QR token version must be MAR1" };
  }
  if (!MAR1_LABEL_NO_PATTERN.test(labelNo) || !PACKING_LABEL_NO_PATTERN.test(labelNo)) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "labelNo must match ^MAR-PL-[0-9]{1,8}$" };
  }
  if (!MAR1_KEY_ID_PATTERN.test(keyId) || !PACKING_LABEL_SIGNING_KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "keyId must match ^K[0-9]{1,2}$" };
  }
  if (/=/.test(signature) || !MAR1_SIGNATURE_B64URL_PATTERN.test(signature)) {
    return {
      ok: false,
      code: "LABEL_QR_TOKEN_INVALID",
      message: `signature must be exactly ${MAR1_SIGNATURE_B64URL_CHARS} Base64URL characters without padding`,
    };
  }
  if (signature.length !== MAR1_SIGNATURE_B64URL_CHARS) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "signature length invalid" };
  }
  const rawSig = decodeMar1Signature(signature);
  if (!rawSig) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "signature encoding invalid" };
  }
  if (Buffer.byteLength(raw, "ascii") > MAR1_MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: LABEL_QR_PAYLOAD_OVERFLOW,
      message: `Production QR payload exceeds ${MAR1_MAX_PAYLOAD_BYTES} ASCII bytes`,
    };
  }
  return { ok: true, version, labelNo, keyId, signature, rawSignature: rawSig, token: raw };
}

export function signMar1Token({ labelNo, keyId, secret }) {
  if (!MAR1_LABEL_NO_PATTERN.test(String(labelNo || ""))) {
    throw signingError("labelNo must match ^MAR-PL-[0-9]{1,8}$", 400, "LABEL_QR_TOKEN_INVALID");
  }
  if (!MAR1_KEY_ID_PATTERN.test(String(keyId || ""))) {
    throw signingError("keyId must match ^K[0-9]{1,2}$", 400, "LABEL_QR_TOKEN_INVALID");
  }
  if (Buffer.isBuffer(secret) ? secret.length < 1 : !secret) {
    throw signingError("Signing secret is required", 409, LABEL_SIGNING_KEY_REQUIRED);
  }
  const canonical = buildMar1CanonicalBytes({ labelNo, keyId });
  const raw = hmacMar1SignatureBytes(canonical, secret);
  const signature = encodeMar1Signature(raw);
  const token = buildMar1TokenExample(labelNo, keyId, signature);
  const capacity = validateMar1ProductionQrToken({ token, labelNo, keyId, signature });
  if (!capacity.ok) {
    const overflow = (capacity.errors || []).find((e) => e.code === LABEL_QR_PAYLOAD_OVERFLOW);
    throw signingError(
      overflow?.message || "Production QR payload exceeds Version 5 ECC H capacity",
      409,
      LABEL_QR_PAYLOAD_OVERFLOW
    );
  }
  return {
    token,
    labelNo,
    keyId,
    signature,
    qrVersion: MAR1_TOKEN_VERSION,
    payloadBytes: capacity.payloadBytes,
  };
}

export function verifyMar1SignatureBytes(expected16, actual16) {
  const a = Buffer.from(expected16);
  const b = Buffer.from(actual16 || []);
  if (a.length !== MAR1_SIGNATURE_BYTES || b.length !== MAR1_SIGNATURE_BYTES) {
    crypto.timingSafeEqual(a.length === MAR1_SIGNATURE_BYTES ? a : Buffer.alloc(MAR1_SIGNATURE_BYTES), Buffer.alloc(MAR1_SIGNATURE_BYTES));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function verifyMar1TokenLocal({ token, secret, expectedLabelNo = null, expectedKeyId = null }) {
  const parsed = parseMar1Token(token);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  if (expectedLabelNo && parsed.labelNo !== expectedLabelNo) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "labelNo mismatch" };
  }
  if (expectedKeyId && parsed.keyId !== expectedKeyId) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "keyId mismatch" };
  }
  const canonical = buildMar1CanonicalBytes({ labelNo: parsed.labelNo, keyId: parsed.keyId });
  const expected = hmacMar1SignatureBytes(canonical, secret);
  const match = verifyMar1SignatureBytes(expected, parsed.rawSignature);
  if (!match) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "signature mismatch" };
  }
  return {
    ok: true,
    labelNo: parsed.labelNo,
    keyId: parsed.keyId,
    qrVersion: MAR1_TOKEN_VERSION,
    comparedBytes: MAR1_SIGNATURE_BYTES,
    constantTime: true,
  };
}

function publicSigningKey(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    companyId: doc.companyId,
    keyId: doc.keyId,
    status: doc.status,
    activatedAt: doc.activatedAt || null,
    retiredAt: doc.retiredAt || null,
  };
}

function resolveSecretRef(secretRef) {
  const ref = String(secretRef || "").trim();
  if (!ref.startsWith("env:")) {
    throw signingError("Invalid packing-label signing secret reference.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const envName = ref.slice(4).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
    throw signingError("Invalid packing-label signing secret reference.", 409, LABEL_SIGNING_SECRET_FORMAT);
  }
  const fromEnv = process.env[envName];
  if (fromEnv == null || String(fromEnv) === "") {
    throw signingError(
      "Packing-label signing secret environment variable is not set.",
      409,
      LABEL_SIGNING_SECRET_REF_MISSING
    );
  }
  return String(fromEnv);
}

function secretSourcePresent(value) {
  return String(value || "").trim() !== "";
}

/**
 * Exactly one of encryptedSecret or secretRef. Both or neither fail closed.
 * Does not prefer either field. Never echoes source values.
 */
export function assertExactlyOnePackingLabelSecretSource(keyDoc) {
  const hasEncrypted = secretSourcePresent(keyDoc?.encryptedSecret);
  const hasRef = secretSourcePresent(keyDoc?.secretRef);
  if (hasEncrypted === hasRef) {
    throw signingError(
      "Packing-label signing key must have exactly one secret source.",
      409,
      LABEL_SIGNING_SECRET_FORMAT
    );
  }
}

/**
 * Resolve the HMAC secret for ACTIVE or VERIFY_ONLY keys.
 * Exactly one of encryptedSecret or secretRef. encryptedSecret requires
 * PACKING_LABEL_SIGNING_ENCRYPTION_KEY. Never returns envelope parts or the encryption key.
 */
export function resolvePackingLabelSigningSecretFromKeyDoc(keyDoc) {
  if (!keyDoc) {
    throw signingError(
      "An ACTIVE packing-label signing key is required before identity creation or printing.",
      409,
      LABEL_SIGNING_KEY_REQUIRED
    );
  }
  assertExactlyOnePackingLabelSecretSource(keyDoc);
  const ref = String(keyDoc.secretRef || "").trim();
  if (ref) return resolveSecretRef(ref);
  return unwrapPackingLabelSigningSecret(String(keyDoc.encryptedSecret || "").trim());
}

/** Fail closed before minting identities or creating print jobs. */
export function assertPackingLabelSigningSecretReady(keyDoc) {
  const secret = resolvePackingLabelSigningSecretFromKeyDoc(keyDoc);
  if (Buffer.isBuffer(secret)) secret.fill(0);
  return true;
}

function normalizeCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) {
    throw signingError("companyId is required", 400, "LABEL_COMPANY_REQUIRED");
  }
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : companyId;
}

const SIGNING_KEY_SECRET_SELECT = "+encryptedSecret +secretRef";

export async function getActivePackingLabelSigningKey(companyId) {
  const cid = normalizeCompanyId(companyId);
  const row = await PackingLabelSigningKey.findOne({ companyId: cid, status: "ACTIVE" })
    .select(SIGNING_KEY_SECRET_SELECT)
    .lean();
  return row || null;
}

export async function requireActivePackingLabelSigningKey(companyId) {
  const row = await getActivePackingLabelSigningKey(companyId);
  if (!row) {
    throw signingError(
      "An ACTIVE packing-label signing key is required before identity creation or printing.",
      409,
      LABEL_SIGNING_KEY_REQUIRED
    );
  }
  assertPackingLabelSigningSecretReady(row);
  return row;
}

export async function loadPackingLabelSigningKey(companyId, keyId) {
  const cid = normalizeCompanyId(companyId);
  const id = String(keyId || "").trim().toUpperCase();
  if (!PACKING_LABEL_SIGNING_KEY_ID_PATTERN.test(id)) return null;
  return PackingLabelSigningKey.findOne({ companyId: cid, keyId: id })
    .select(SIGNING_KEY_SECRET_SELECT)
    .lean();
}

export function publicPackingLabelSigningKey(doc) {
  return publicSigningKey(doc);
}

export function signMar1TokenWithKeyDoc(keyDoc, labelNo, { newLabel = true } = {}) {
  if (!keyDoc) {
    throw signingError(
      "An ACTIVE packing-label signing key is required before identity creation or printing.",
      409,
      LABEL_SIGNING_KEY_REQUIRED
    );
  }
  const status = String(keyDoc.status || "").toUpperCase();
  if (status === "REVOKED") {
    throw signingError("Signing key is revoked", 409, "LABEL_SIGNING_KEY_REVOKED");
  }
  if (newLabel && status !== "ACTIVE") {
    throw signingError(
      "An ACTIVE packing-label signing key is required before identity creation or printing.",
      409,
      LABEL_SIGNING_KEY_REQUIRED
    );
  }
  if (!newLabel && status !== "ACTIVE" && status !== "VERIFY_ONLY") {
    throw signingError("Signing key cannot sign or reconstruct this label", 409, "LABEL_SIGNING_KEY_REVOKED");
  }
  const secret = resolvePackingLabelSigningSecretFromKeyDoc(keyDoc);
  try {
    const signed = signMar1Token({ labelNo, keyId: keyDoc.keyId, secret });
    return { ...signed, keyId: keyDoc.keyId, signingKeyStatus: status };
  } finally {
    if (Buffer.isBuffer(secret)) secret.fill(0);
  }
}

export async function signPackingLabelUnitToken(companyId, labelNo, { allowVerifyOnly = false } = {}) {
  const key = allowVerifyOnly
    ? await loadKeyForExistingLabel(companyId, labelNo)
    : await requireActivePackingLabelSigningKey(companyId);
  return signMar1TokenWithKeyDoc(key, labelNo, { newLabel: !allowVerifyOnly });
}

async function loadKeyForExistingLabel(companyId, labelNo) {
  const cid = normalizeCompanyId(companyId);
  const unit = await PackingLabelUnit.findOne({
    companyId: cid,
    labelNo: String(labelNo || "").trim().toUpperCase(),
  })
    .select("signingKeyId")
    .lean();
  if (!unit?.signingKeyId) {
    return getActivePackingLabelSigningKey(companyId);
  }
  const existing = await loadPackingLabelSigningKey(companyId, unit.signingKeyId);
  if (existing && existing.status !== "REVOKED") return existing;
  return getActivePackingLabelSigningKey(companyId);
}

/**
 * Verify a MAR1 token for this request's company. Never trusts company from the QR.
 * Invalid tokens do not include Article/customer fields.
 */
export async function verifyPackingLabelMar1Token(companyId, token) {
  const parsed = parseMar1Token(token);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: parsed.message };
  }
  const cid = normalizeCompanyId(companyId);
  const unit = await PackingLabelUnit.findOne({
    companyId: cid,
    labelNo: parsed.labelNo,
  }).lean();
  if (!unit) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "Unknown packing label" };
  }
  const key = await loadPackingLabelSigningKey(companyId, parsed.keyId);
  if (!key) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "Unknown signing key" };
  }
  if (String(unit.signingKeyId || "").toUpperCase() !== parsed.keyId) {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "Signing key mismatch" };
  }
  if (key.status === "REVOKED") {
    return { ok: false, code: "LABEL_SIGNING_KEY_REVOKED", message: "Signing key is revoked" };
  }
  if (key.status !== "ACTIVE" && key.status !== "VERIFY_ONLY") {
    return { ok: false, code: "LABEL_QR_TOKEN_INVALID", message: "Signing key cannot verify" };
  }
  let secret;
  try {
    secret = resolvePackingLabelSigningSecretFromKeyDoc(key);
  } catch (e) {
    return {
      ok: false,
      code: e.code || LABEL_SIGNING_SECRET_UNWRAP_FAILED,
      message: e.message || "Signing key cannot verify",
    };
  }
  try {
    const local = verifyMar1TokenLocal({
      token: parsed.token,
      secret,
      expectedLabelNo: unit.labelNo,
      expectedKeyId: key.keyId,
    });
    if (!local.ok) {
      return { ok: false, code: local.code, message: local.message };
    }
    return {
      ok: true,
      labelNo: unit.labelNo,
      keyId: key.keyId,
      packingLabelUnitId: unit._id,
      qrVersion: unit.qrVersion || MAR1_TOKEN_VERSION,
      status: unit.status,
      constantTime: true,
    };
  } finally {
    if (Buffer.isBuffer(secret)) secret.fill(0);
  }
}
