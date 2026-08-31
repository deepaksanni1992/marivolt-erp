/**
 * PackingLabelSigningKey encryption hardening.
 * Run: node scripts/packingLabelSigningEncryption.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LABEL_SIGNING_ENCRYPTION_KEY_INVALID,
  LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED,
  LABEL_SIGNING_SECRET_FORMAT,
  LABEL_SIGNING_SECRET_REF_MISSING,
  LABEL_SIGNING_SECRET_UNWRAP_FAILED,
  PACKING_LABEL_GCM_IV_BYTES,
  PACKING_LABEL_GCM_TAG_BYTES,
  PACKING_LABEL_SECRET_ENVELOPE_VERSION,
  PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV,
  assertExactlyOnePackingLabelSecretSource,
  assertPackingLabelSigningSecretReady,
  decryptPackingLabelSigningSecret,
  decodePackingLabelSigningEncryptionKey,
  encryptPackingLabelSigningSecret,
  parsePackingLabelSecretEnvelope,
  publicPackingLabelSigningKey,
  resolvePackingLabelSigningEncryptionKeyBytes,
  resolvePackingLabelSigningSecretFromKeyDoc,
  signMar1Token,
  signMar1TokenWithKeyDoc,
  encryptPackingLabelSigningSecretBytes,
  decryptPackingLabelSigningSecretBytes,
  unwrapPackingLabelSigningSecret,
} from "../src/services/label/packingLabelSigningService.js";
import PackingLabelSigningKey from "../src/models/PackingLabelSigningKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const KEY_HEX = KEY_BYTES.toString("hex");
const KEY_B64URL = KEY_BYTES.toString("base64url");
const KEY_B64_PADDED = KEY_BYTES.toString("base64");
const KEY_UTF8_32 = "0123456789abcdef0123456789abcdef";
const HMAC_PLAIN = "phase2-test-only-hmac-secret-not-for-production";
const ENV_HMAC = "PACKING_LABEL_HMAC_TEST_SECRET";
const SECRET_REF = `env:${ENV_HMAC}`;

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const saved = {
  packing: process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV],
  jwt: process.env.JWT_SECRET,
  totp: process.env.TOTP_ENCRYPTION_KEY,
  hmac: process.env[ENV_HMAC],
};

function setPackingKey(value) {
  if (value == null) delete process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV];
  else process.env[PACKING_LABEL_SIGNING_ENCRYPTION_KEY_ENV] = value;
}

function restoreEnv() {
  setPackingKey(saved.packing);
  if (saved.jwt == null) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = saved.jwt;
  if (saved.totp == null) delete process.env.TOTP_ENCRYPTION_KEY;
  else process.env.TOTP_ENCRYPTION_KEY = saved.totp;
  if (saved.hmac == null) delete process.env[ENV_HMAC];
  else process.env[ENV_HMAC] = saved.hmac;
}

function assertErrorOmitsSensitive(err, extras = []) {
  const blob = `${err?.message || ""}\n${err?.code || ""}`;
  for (const s of [KEY_HEX, KEY_B64URL, KEY_B64_PADDED, KEY_UTF8_32, HMAC_PLAIN, SECRET_REF, ...extras]) {
    if (s && String(s).length > 8) {
      assert.ok(!blob.includes(String(s)), "error leaked secret source or encryption key");
    }
  }
}

function catchCode(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

console.log("\nPacking label signing encryption\n");

const signSrc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelSigningService.js"), "utf8");
const packingSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelService.js"), "utf8");
const unitSvc = fs.readFileSync(path.join(srcRoot, "services", "label", "packingLabelUnitService.js"), "utf8");
const keyModelSrc = fs.readFileSync(path.join(srcRoot, "models", "PackingLabelSigningKey.js"), "utf8");

try {
  run("encryptedSecret only accepted", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const secret = resolvePackingLabelSigningSecretFromKeyDoc({
      keyId: "K1",
      status: "ACTIVE",
      encryptedSecret: envelope,
    });
    assert.equal(secret, HMAC_PLAIN);
    const doc = new PackingLabelSigningKey({
      companyId: "000000000000000000000001",
      keyId: "K1",
      encryptedSecret: envelope,
      status: "ACTIVE",
    });
    assert.equal(doc.validateSync(), undefined);
  });

  run("secretRef only accepted", () => {
    setPackingKey(null);
    process.env[ENV_HMAC] = HMAC_PLAIN;
    const secret = resolvePackingLabelSigningSecretFromKeyDoc({
      keyId: "K1",
      status: "ACTIVE",
      secretRef: SECRET_REF,
    });
    assert.equal(secret, HMAC_PLAIN);
    assertPackingLabelSigningSecretReady({
      keyId: "K1",
      status: "VERIFY_ONLY",
      secretRef: SECRET_REF,
    });
    const doc = new PackingLabelSigningKey({
      companyId: "000000000000000000000001",
      keyId: "K1",
      secretRef: SECRET_REF,
      status: "ACTIVE",
    });
    assert.equal(doc.validateSync(), undefined);
  });

  run("neither rejected", () => {
    const threw = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({ keyId: "K1", status: "ACTIVE" })
    );
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_FORMAT);
    assertErrorOmitsSensitive(threw);
    const empty = catchCode(() =>
      assertExactlyOnePackingLabelSecretSource({ encryptedSecret: "", secretRef: "  " })
    );
    assert.equal(empty?.code, LABEL_SIGNING_SECRET_FORMAT);
    const doc = new PackingLabelSigningKey({
      companyId: "000000000000000000000001",
      keyId: "K1",
      status: "ACTIVE",
    });
    assert.ok(doc.validateSync());
  });

  run("both rejected", () => {
    setPackingKey(KEY_HEX);
    process.env[ENV_HMAC] = HMAC_PLAIN;
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const threw = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({
        keyId: "K1",
        status: "ACTIVE",
        encryptedSecret: envelope,
        secretRef: SECRET_REF,
      })
    );
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_FORMAT);
    assertErrorOmitsSensitive(threw, [envelope]);
    const doc = new PackingLabelSigningKey({
      companyId: "000000000000000000000001",
      keyId: "K1",
      encryptedSecret: envelope,
      secretRef: SECRET_REF,
      status: "ACTIVE",
    });
    assert.ok(doc.validateSync());
  });

  run("malformed legacy record containing both rejected", () => {
    setPackingKey(KEY_HEX);
    process.env[ENV_HMAC] = HMAC_PLAIN;
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const legacy = {
      keyId: "K1",
      status: "VERIFY_ONLY",
      encryptedSecret: envelope,
      secretRef: SECRET_REF,
    };
    const threw = catchCode(() => resolvePackingLabelSigningSecretFromKeyDoc(legacy));
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_FORMAT);
    assertErrorOmitsSensitive(threw, [envelope, SECRET_REF]);
    const signThrew = catchCode(() =>
      signMar1TokenWithKeyDoc(legacy, "MAR-PL-000001", { newLabel: false })
    );
    assert.equal(signThrew?.code, LABEL_SIGNING_SECRET_FORMAT);
    assert.ok(!signSrc.includes("secretRef is preferred"));
    assert.ok(!keyModelSrc.includes("Takes precedence"));
  });

  run("64-character hex key accepted", () => {
    assert.equal(KEY_HEX.length, 64);
    setPackingKey(KEY_HEX);
    delete process.env.JWT_SECRET;
    delete process.env.TOTP_ENCRYPTION_KEY;
    const bytes = resolvePackingLabelSigningEncryptionKeyBytes();
    assert.equal(bytes.length, 32);
    assert.ok(bytes.equals(KEY_BYTES));
    assert.ok(decodePackingLabelSigningEncryptionKey(KEY_HEX).equals(KEY_BYTES));
  });

  run("canonical unpadded Base64URL encoding of 32 bytes accepted", () => {
    assert.ok(!KEY_B64URL.includes("="));
    setPackingKey(KEY_B64URL);
    const bytes = resolvePackingLabelSigningEncryptionKeyBytes();
    assert.equal(bytes.length, 32);
    assert.ok(bytes.equals(KEY_BYTES));
    assert.equal(bytes.toString("base64url"), KEY_B64URL);
  });

  run("raw 32-character UTF-8 key rejected", () => {
    assert.equal(Buffer.byteLength(KEY_UTF8_32, "utf8"), 32);
    setPackingKey(KEY_UTF8_32);
    const threw = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(threw?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    assert.equal(decodePackingLabelSigningEncryptionKey(KEY_UTF8_32), null);
    assertErrorOmitsSensitive(threw);
  });

  run("padded Base64 rejected", () => {
    assert.ok(KEY_B64_PADDED.includes("=") || /[+/=]/.test(KEY_B64_PADDED));
    setPackingKey(KEY_B64_PADDED);
    const threw = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(threw?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    assert.equal(decodePackingLabelSigningEncryptionKey(KEY_B64_PADDED), null);
    assertErrorOmitsSensitive(threw);
  });

  run("noncanonical Base64URL rejected", () => {
    const paddedUrl = `${KEY_B64URL}=`;
    setPackingKey(paddedUrl);
    const paddedThrew = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(paddedThrew?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    assert.equal(decodePackingLabelSigningEncryptionKey(paddedUrl), null);
    const swapped = KEY_B64URL.replace(/-/g, "+").replace(/_/g, "/");
    if (swapped !== KEY_B64URL) {
      setPackingKey(swapped);
      const swappedThrew = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
      assert.equal(swappedThrew?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    }
  });

  run("short decoded key rejected", () => {
    setPackingKey(KEY_HEX.slice(0, 32));
    const shortHex = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(shortHex?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    const shortBytes = crypto.randomBytes(16);
    setPackingKey(shortBytes.toString("base64url"));
    const shortB64 = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(shortB64?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    assertErrorOmitsSensitive(shortHex);
  });

  run("long decoded key rejected", () => {
    setPackingKey(`${KEY_HEX}aa`);
    const longHex = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(longHex?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    const longBytes = crypto.randomBytes(33);
    setPackingKey(longBytes.toString("base64url"));
    const longB64 = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(longB64?.code, LABEL_SIGNING_ENCRYPTION_KEY_INVALID);
    assertErrorOmitsSensitive(longHex);
  });

  run("missing encryption key rejected", () => {
    setPackingKey(null);
    delete process.env.JWT_SECRET;
    delete process.env.TOTP_ENCRYPTION_KEY;
    const threw = catchCode(() => resolvePackingLabelSigningEncryptionKeyBytes());
    assert.equal(threw?.code, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
    assert.ok(!String(threw.message).includes("JWT_SECRET"));
    assert.ok(!String(threw.message).includes("TOTP_ENCRYPTION_KEY"));
  });

  run("JWT_SECRET alone is not accepted", () => {
    setPackingKey(null);
    process.env.JWT_SECRET = "a-jwt-secret-that-is-definitely-long-enough-for-tokens";
    delete process.env.TOTP_ENCRYPTION_KEY;
    const threw = catchCode(() => encryptPackingLabelSigningSecret(HMAC_PLAIN));
    assert.equal(threw?.code, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
    assert.ok(!signSrc.includes("process.env.JWT_SECRET"));
  });

  run("TOTP_ENCRYPTION_KEY alone is not accepted", () => {
    setPackingKey(null);
    delete process.env.JWT_SECRET;
    process.env.TOTP_ENCRYPTION_KEY = "replace-with-strong-totp-encryption-key!!";
    const threw = catchCode(() => encryptPackingLabelSigningSecret(HMAC_PLAIN));
    assert.equal(threw?.code, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
    assert.ok(!signSrc.includes("process.env.TOTP_ENCRYPTION_KEY"));
  });

  run("random nonce differs between two encryptions", () => {
    setPackingKey(KEY_HEX);
    const a = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const b = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    assert.notEqual(a, b);
    const pa = parsePackingLabelSecretEnvelope(a);
    const pb = parsePackingLabelSecretEnvelope(b);
    assert.equal(pa.version, PACKING_LABEL_SECRET_ENVELOPE_VERSION);
    assert.equal(pa.nonce.length, PACKING_LABEL_GCM_IV_BYTES);
    assert.equal(pa.tag.length, PACKING_LABEL_GCM_TAG_BYTES);
    assert.ok(!pa.nonce.equals(pb.nonce));
    assert.equal(a.startsWith("v1:"), true);
    assert.equal(a.split(".").length, 3);
  });

  run("round-trip encryption/decryption", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    assert.equal(decryptPackingLabelSigningSecret(envelope), HMAC_PLAIN);
    const parsed = parsePackingLabelSecretEnvelope(envelope);
    assert.ok(parsed.nonce);
    assert.ok(parsed.ciphertext);
    assert.ok(parsed.tag);
  });

  run("modified nonce rejected", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const parsed = parsePackingLabelSecretEnvelope(envelope);
    parsed.nonce[0] ^= 0xff;
    const tampered = `v1:${parsed.nonce.toString("base64url")}.${parsed.ciphertext.toString("base64url")}.${parsed.tag.toString("base64url")}`;
    const threw = catchCode(() => decryptPackingLabelSigningSecret(tampered));
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_UNWRAP_FAILED);
    assertErrorOmitsSensitive(threw, [envelope, tampered]);
  });

  run("modified ciphertext rejected", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const parsed = parsePackingLabelSecretEnvelope(envelope);
    parsed.ciphertext[0] ^= 0xff;
    const tampered = `v1:${parsed.nonce.toString("base64url")}.${parsed.ciphertext.toString("base64url")}.${parsed.tag.toString("base64url")}`;
    const threw = catchCode(() => decryptPackingLabelSigningSecret(tampered));
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_UNWRAP_FAILED);
    assertErrorOmitsSensitive(threw);
  });

  run("modified authentication tag rejected", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const parsed = parsePackingLabelSecretEnvelope(envelope);
    parsed.tag[0] ^= 0xff;
    const tampered = `v1:${parsed.nonce.toString("base64url")}.${parsed.ciphertext.toString("base64url")}.${parsed.tag.toString("base64url")}`;
    const threw = catchCode(() => decryptPackingLabelSigningSecret(tampered));
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_UNWRAP_FAILED);
    assertErrorOmitsSensitive(threw);
  });

  run("malformed v1 envelope rejected", () => {
    setPackingKey(KEY_HEX);
    const cases = ["", "v2:x.y.z", "v1:onlyone", "v1:a.b", "v1:not-valid-nonce.ci.tag", "plain-secret"];
    for (const stored of cases) {
      const threw = catchCode(() => decryptPackingLabelSigningSecret(stored));
      assert.ok(threw, "expected envelope reject");
      assert.ok(
        threw.code === LABEL_SIGNING_SECRET_FORMAT || threw.code === LABEL_SIGNING_SECRET_UNWRAP_FAILED
      );
      assert.ok(!String(threw.message).includes(stored) || stored.length < 8);
    }
  });

  run("missing secretRef variable rejected", () => {
    delete process.env.PACKING_LABEL_HMAC_MISSING;
    const threw = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({
        keyId: "K1",
        secretRef: "env:PACKING_LABEL_HMAC_MISSING",
      })
    );
    assert.equal(threw?.code, LABEL_SIGNING_SECRET_REF_MISSING);
    assert.ok(!String(threw.message).includes(HMAC_PLAIN));
  });

  run("VERIFY_ONLY uses the same encryption-key and exclusivity rules", () => {
    setPackingKey(KEY_HEX);
    process.env[ENV_HMAC] = HMAC_PLAIN;
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const secret = resolvePackingLabelSigningSecretFromKeyDoc({
      keyId: "K1",
      status: "VERIFY_ONLY",
      encryptedSecret: envelope,
    });
    assert.equal(secret, HMAC_PLAIN);
    setPackingKey(null);
    const missingEnc = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({
        keyId: "K1",
        status: "VERIFY_ONLY",
        encryptedSecret: envelope,
      })
    );
    assert.equal(missingEnc?.code, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
    const both = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({
        keyId: "K1",
        status: "VERIFY_ONLY",
        encryptedSecret: envelope,
        secretRef: SECRET_REF,
      })
    );
    assert.equal(both?.code, LABEL_SIGNING_SECRET_FORMAT);
    const signed = signMar1TokenWithKeyDoc(
      { keyId: "K1", status: "VERIFY_ONLY", secretRef: SECRET_REF },
      "MAR-PL-000001",
      { newLabel: false }
    );
    assert.equal(signed.keyId, "K1");
    assert.equal(signed.signingKeyStatus, "VERIFY_ONLY");
  });

  run("no secret source appears in API, logs, or error output", () => {
    setPackingKey(KEY_HEX);
    process.env[ENV_HMAC] = HMAC_PLAIN;
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const api = publicPackingLabelSigningKey({
      _id: "id1",
      companyId: "c1",
      keyId: "K1",
      status: "ACTIVE",
      encryptedSecret: envelope,
      secretRef: SECRET_REF,
      activatedAt: new Date(),
    });
    assert.equal(api.keyId, "K1");
    assert.equal(api.encryptedSecret, undefined);
    assert.equal(api.secretRef, undefined);
    const json = JSON.stringify(api);
    assert.ok(!json.includes(envelope));
    assert.ok(!json.includes(HMAC_PLAIN));
    assert.ok(!json.includes(KEY_HEX));
    assert.ok(!json.includes(SECRET_REF));
    const doc = new PackingLabelSigningKey({
      companyId: "000000000000000000000001",
      keyId: "K1",
      encryptedSecret: envelope,
      status: "ACTIVE",
    });
    const serialized = doc.toJSON();
    assert.equal(serialized.encryptedSecret, undefined);
    assert.equal(serialized.secretRef, undefined);
    const bothErr = catchCode(() =>
      resolvePackingLabelSigningSecretFromKeyDoc({
        keyId: "K1",
        encryptedSecret: envelope,
        secretRef: SECRET_REF,
      })
    );
    assertErrorOmitsSensitive(bothErr, [envelope]);
    assert.ok(keyModelSrc.includes("omitSecretMaterial") || keyModelSrc.includes("delete ret.encryptedSecret"));
    assert.ok(keyModelSrc.includes("delete ret.secretRef"));
    assert.ok(keyModelSrc.includes("select: false"));
    assert.ok(unitSvc.includes("delete out.encryptedSecret"));
    assert.ok(unitSvc.includes("delete out.secretRef"));
    assert.ok(unitSvc.includes("delete out.nonce"));
    assert.ok(unitSvc.includes("delete out.ciphertext"));
    assert.ok(unitSvc.includes("delete out.tag"));
    assert.ok(!signSrc.includes("console.log"));
    assert.ok(!signSrc.includes("console.info"));
  });

  run("rejection happens before PackingLabelUnit and LabelPrintJob creation", () => {
    const requireIdx = packingSvc.indexOf("requireActivePackingLabelSigningKey");
    const assertIdx = packingSvc.indexOf("assertPackingLabelSigningSecretReady");
    const mintIdx = packingSvc.indexOf("mintPackingLabelUnits");
    const createIdx = packingSvc.indexOf("LabelPrintJob.create");
    const landscapeStart = packingSvc.indexOf("async function createLandscapePackingLabelJobs");
    assert.ok(landscapeStart > 0);
    const landscape = packingSvc.slice(landscapeStart);
    const a = landscape.indexOf("assertPackingLabelSigningSecretReady");
    const m = landscape.indexOf("mintPackingLabelUnits");
    const c = landscape.indexOf("LabelPrintJob.create");
    assert.ok(a >= 0 && m > a, "secret readiness must run before mint");
    assert.ok(c > m, "job create stays after mint");
    assert.ok(requireIdx >= 0 && assertIdx >= 0 && mintIdx > assertIdx);
    assert.ok(createIdx > mintIdx);
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    const both = catchCode(() =>
      assertPackingLabelSigningSecretReady({
        keyId: "K1",
        status: "ACTIVE",
        encryptedSecret: envelope,
        secretRef: SECRET_REF,
      })
    );
    assert.equal(both?.code, LABEL_SIGNING_SECRET_FORMAT);
    setPackingKey(null);
    const missing = catchCode(() =>
      assertPackingLabelSigningSecretReady({
        keyId: "K1",
        status: "ACTIVE",
        encryptedSecret: envelope,
      })
    );
    assert.equal(missing?.code, LABEL_SIGNING_ENCRYPTION_KEY_REQUIRED);
    const neither = catchCode(() =>
      assertPackingLabelSigningSecretReady({ keyId: "K1", status: "ACTIVE" })
    );
    assert.equal(neither?.code, LABEL_SIGNING_SECRET_FORMAT);
  });

  run("raw 32-byte HMAC key wraps as v1b and unwraps to the same bytes", () => {
    setPackingKey(KEY_HEX);
    const raw = crypto.randomBytes(32);
    const expected = Buffer.from(raw);
    const envelope = encryptPackingLabelSigningSecretBytes(raw);
    assert.equal(envelope.startsWith("v1b:"), true);
    assert.equal(envelope.startsWith("v1:"), false);
    const recovered = decryptPackingLabelSigningSecretBytes(envelope);
    assert.ok(Buffer.isBuffer(recovered));
    assert.ok(recovered.equals(expected));
    const unwrapped = unwrapPackingLabelSigningSecret(envelope);
    assert.ok(Buffer.isBuffer(unwrapped));
    assert.ok(unwrapped.equals(expected));
    const asString = catchCode(() => decryptPackingLabelSigningSecret(envelope));
    assert.equal(asString?.code, LABEL_SIGNING_SECRET_FORMAT);
  });

  run("binary wrap of locked HMAC material reproduces the existing MAR1 token", () => {
    setPackingKey(KEY_HEX);
    const lockedSecret = "phase2-test-only-hmac-secret-not-for-production";
    const fromString = signMar1Token({
      labelNo: "MAR-PL-000001",
      keyId: "K1",
      secret: lockedSecret,
    });
    assert.equal(fromString.token, "MAR1.MAR-PL-000001.K1.cVAnxjW_hpd7OsrL-3KntQ");
    const raw = Buffer.from(lockedSecret, "utf8");
    const envelope = encryptPackingLabelSigningSecretBytes(raw);
    const recovered = unwrapPackingLabelSigningSecret(envelope);
    const fromBytes = signMar1Token({
      labelNo: "MAR-PL-000001",
      keyId: "K1",
      secret: recovered,
    });
    assert.equal(fromBytes.token, fromString.token);
    const viaDoc = signMar1TokenWithKeyDoc(
      { keyId: "K1", status: "ACTIVE", encryptedSecret: envelope },
      "MAR-PL-000001",
      { newLabel: true }
    );
    assert.equal(viaDoc.token, fromString.token);
  });

  run("v1 string envelopes remain compatible beside v1b", () => {
    setPackingKey(KEY_HEX);
    const envelope = encryptPackingLabelSigningSecret(HMAC_PLAIN);
    assert.equal(envelope.startsWith("v1:"), true);
    assert.equal(decryptPackingLabelSigningSecret(envelope), HMAC_PLAIN);
    assert.equal(unwrapPackingLabelSigningSecret(envelope), HMAC_PLAIN);
  });
} finally {
  restoreEnv();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
