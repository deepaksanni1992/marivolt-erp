import crypto from "crypto";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";

const ENC_PREFIX = "v1:";

function encryptionKey() {
  const raw = String(process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET || "").trim();
  if (!raw) {
    throw new Error("TOTP_ENCRYPTION_KEY or JWT_SECRET is required for 2FA");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/** Generate a unique base32 secret for one user — never shared across users. */
export function generateUserTotpSecret() {
  return generateSecret();
}

export function encryptTotpSecret(plainSecret) {
  const plain = String(plainSecret || "").trim();
  if (!plain) return "";
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptTotpSecret(stored) {
  const value = String(stored || "").trim();
  if (!value) return "";
  if (!value.startsWith(ENC_PREFIX)) {
    throw new Error("Invalid stored TOTP secret format");
  }
  const payload = value.slice(ENC_PREFIX.length);
  const [ivB64, dataB64, tagB64] = payload.split(".");
  if (!ivB64 || !dataB64 || !tagB64) {
    throw new Error("Invalid stored TOTP secret format");
  }
  const key = encryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return plain;
}

export function verifyUserTotpCode(encryptedSecret, token) {
  const code = String(token || "").replace(/\s+/g, "").trim();
  if (!/^\d{6}$/.test(code)) return false;
  let secret;
  try {
    secret = decryptTotpSecret(encryptedSecret);
  } catch {
    return false;
  }
  if (!secret) return false;
  try {
    const result = verifySync({
      secret,
      token: code,
      epochTolerance: 30,
    });
    return !!result?.valid;
  } catch {
    return false;
  }
}

export function totpIssuerLabel(company) {
  if (company?.name && company?.code) {
    return `${company.name} (${company.code})`;
  }
  return company?.name || company?.code || "Marivolt ERP";
}

export function totpAccountName(user) {
  const username = String(user?.username || "").trim();
  const email = String(user?.email || "").trim();
  const name = String(user?.name || "").trim();
  if (username) return username;
  if (email) return email;
  return name || "user";
}

/** otpauth label shown in Authenticator apps for this user only. */
export function buildOtpAuthUrl(user, plainSecret, company = null) {
  const issuer = totpIssuerLabel(company);
  const label = totpAccountName(user);
  return generateURI({
    issuer,
    label,
    secret: plainSecret,
  });
}

export async function buildTotpQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
}

export function clearUserTwoFactorFields() {
  return {
    twoFactorEnabled: false,
    twoFactorSecret: "",
    twoFactorEnabledAt: null,
    twoFactorLastVerifiedAt: null,
  };
}

export function userTwoFactorPublicStatus(user) {
  return {
    twoFactorEnabled: !!user?.twoFactorEnabled,
    twoFactorEnabledAt: user?.twoFactorEnabledAt || null,
    twoFactorLastVerifiedAt: user?.twoFactorLastVerifiedAt || null,
  };
}
