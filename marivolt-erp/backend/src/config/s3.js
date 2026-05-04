/**
 * AWS S3 — lazy client so env is read only after loadEnv.js + dotenv have run.
 * Do not instantiate S3 at module top level (imports run before server.js body).
 */
import { S3Client } from "@aws-sdk/client-s3";

let cachedClient = null;

/** Trim + strip optional surrounding quotes from .env values. */
function envVal(v) {
  let s = String(v ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** @returns {S3Client} */
export function getS3Client() {
  if (cachedClient) return cachedClient;

  const region = envVal(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "");
  const accessKeyId = envVal(process.env.AWS_ACCESS_KEY_ID || "");
  const secretAccessKey = envVal(process.env.AWS_SECRET_ACCESS_KEY || "");

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 is not configured. Set AWS_REGION (or AWS_DEFAULT_REGION), AWS_ACCESS_KEY_ID, " +
        "AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET in marivolt-erp/backend/.env (local) or on Render.",
    );
  }

  cachedClient = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

export function getS3Bucket() {
  const b = envVal(process.env.AWS_S3_BUCKET || "");
  if (!b) {
    throw new Error("AWS_S3_BUCKET is not set on the server.");
  }
  return b;
}

/** Canonical object URL (bucket may still be private; use signed URLs for access). */
export function buildS3ObjectPublicUrl(key) {
  const region = envVal(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "");
  const bucket = getS3Bucket();
  const encodedKey = String(key || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}

/** For health checks / startup logs without throwing. */
export function isS3Configured() {
  return Boolean(
    envVal(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "") &&
      envVal(process.env.AWS_ACCESS_KEY_ID || "") &&
      envVal(process.env.AWS_SECRET_ACCESS_KEY || "") &&
      envVal(process.env.AWS_S3_BUCKET || ""),
  );
}

/** Which AWS vars are non-empty (no secret values). */
export function getS3EnvPresence() {
  return {
    hasRegion: Boolean(envVal(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "")),
    hasAccessKeyId: Boolean(envVal(process.env.AWS_ACCESS_KEY_ID || "")),
    hasSecretAccessKey: Boolean(envVal(process.env.AWS_SECRET_ACCESS_KEY || "")),
    hasBucket: Boolean(envVal(process.env.AWS_S3_BUCKET || "")),
  };
}
