/**
 * AWS S3 client for document storage.
 * Credentials and bucket are read only from environment (Render / local .env).
 * Never import this module in the frontend.
 */
import { S3Client } from "@aws-sdk/client-s3";

let cachedClient = null;

/** @returns {S3Client} */
export function getS3Client() {
  if (cachedClient) return cachedClient;

  const region = String(process.env.AWS_REGION || "").trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 is not configured. Set AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY on the server.",
    );
  }

  cachedClient = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

/** Bucket name from env (e.g. marivolt-erp-documents). */
export function getS3Bucket() {
  const b = String(process.env.AWS_S3_BUCKET || "").trim();
  if (!b) throw new Error("AWS_S3_BUCKET is not set on the server.");
  return b;
}

/** Public URL pattern for the object (object may still be private; use signed URLs for access). */
export function buildS3ObjectPublicUrl(key) {
  const region = String(process.env.AWS_REGION || "").trim();
  const bucket = getS3Bucket();
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
}
