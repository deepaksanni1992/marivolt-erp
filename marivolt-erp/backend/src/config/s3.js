/**
 * AWS S3 — lazy client so env is read only after loadEnv.js + dotenv have run.
 * Do not instantiate S3 at module top level (imports run before server.js body).
 */
import { S3Client } from "@aws-sdk/client-s3";

let cachedClient = null;

/** @returns {S3Client} */
export function getS3Client() {
  if (cachedClient) return cachedClient;

  const region = String(
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  ).trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();

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
  const b = String(process.env.AWS_S3_BUCKET || "").trim();
  if (!b) {
    throw new Error("AWS_S3_BUCKET is not set on the server.");
  }
  return b;
}

/** Canonical object URL (bucket may still be private; use signed URLs for access). */
export function buildS3ObjectPublicUrl(key) {
  const region = String(
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
  ).trim();
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
    String(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim() &&
      String(process.env.AWS_ACCESS_KEY_ID || "").trim() &&
      String(process.env.AWS_SECRET_ACCESS_KEY || "").trim() &&
      String(process.env.AWS_S3_BUCKET || "").trim(),
  );
}
