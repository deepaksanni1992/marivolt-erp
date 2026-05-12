import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Bucket, getS3BucketForTenant, getS3Client } from "../config/s3.js";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

function safeEnv(value, fallback = "") {
  const v = String(value ?? "").trim();
  return v || fallback;
}

export function sanitizeFileName(name = "file") {
  const cleaned = String(name)
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 140);
  return cleaned || "file";
}

function slugTenantSegment(companyCode) {
  const s = String(companyCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, "");
  return s.slice(0, 24) || "TENANT";
}

/**
 * Prefix all uploads for a company: `[AWS_S3_KEY_PREFIX/]tenants/{CODE}/{companyId}`.
 * Isolates tenants (e.g. Marivolt MAR vs Okeanos OKE) under distinct S3 prefixes.
 */
export function buildCompanyTenantPrefix({ companyId, companyCode }) {
  const globalPrefix = safeEnv(
    process.env.AWS_S3_KEY_PREFIX || process.env.AWS_S3_BASE_PREFIX,
    "",
  ).replace(/^\/+|\/+$/g, "");
  const tenant = slugTenantSegment(companyCode);
  const cid = String(companyId || "").replace(/[^a-f0-9]/gi, "");
  const parts = [];
  if (globalPrefix) parts.push(globalPrefix);
  parts.push("tenants", tenant, cid || "no-company");
  return parts.join("/");
}

/** Full S3 object key for ERP document uploads (always under tenant prefix). */
export function buildTenantDocumentObjectKey({ companyId, companyCode, documentFolder, originalFileName }) {
  const folder = String(documentFolder || "others").replace(/^\/+|\/+$/g, "");
  const uuid = randomUUID();
  const safe = sanitizeFileName(originalFileName);
  return `${buildCompanyTenantPrefix({ companyId, companyCode })}/${folder}/${uuid}-${safe}`;
}

export function buildDatedS3Key({ folderName, prefix = "", originalFileName = "file", tenantPrefix = "" }) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const ts = String(now.getTime());
  const safeFolder = String(folderName || "uploads").replace(/^\/+|\/+$/g, "");
  const safePrefix = String(prefix || "file").replace(/[^\w.\-]+/g, "-");
  const safeName = sanitizeFileName(originalFileName);
  const inner = `${safeFolder}/${yyyy}/${mm}/${safePrefix}-${ts}-${safeName}`;
  const root = String(tenantPrefix || "").replace(/^\/+|\/+$/g, "");
  return root ? `${root}/${inner}` : inner;
}

export async function uploadFileToS3(file, folderName, options = {}) {
  if (!file?.buffer) throw new Error("No file buffer provided for S3 upload");
  const bucket = options.bucket || getS3BucketForTenant(options.companyCode);
  const client = getS3Client();
  const key =
    options.key ||
    buildDatedS3Key({
      folderName,
      prefix: options.prefix || "file",
      originalFileName: options.originalFileName || file.originalname || "file",
      tenantPrefix: options.tenantPrefix || "",
    });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: options.contentType || file.mimetype || "application/octet-stream",
    })
  );

  return {
    provider: "AWS_S3",
    bucket,
    key,
    originalName: options.originalFileName || file.originalname || "",
    mimeType: options.contentType || file.mimetype || "application/octet-stream",
    size: Number(options.size || file.size || 0),
    uploadedAt: new Date(),
  };
}

export async function deleteFileFromS3(key, bucket) {
  if (!key) return;
  const b = bucket && String(bucket).trim() ? String(bucket).trim() : getS3Bucket();
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: b,
      Key: key,
    })
  );
}

export async function getSignedFileUrl(key, options = {}) {
  if (!key) throw new Error("S3 key is required");
  const bucket = options.bucket && String(options.bucket).trim() ? String(options.bucket).trim() : getS3Bucket();
  const client = getS3Client();
  const expiresIn = Math.max(
    30,
    Number(options.expiresIn || safeEnv(process.env.AWS_S3_SIGNED_URL_TTL_SECONDS, DEFAULT_SIGNED_URL_TTL_SECONDS))
  );
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: options.contentDisposition,
  });
  const url = await getSignedUrl(client, command, { expiresIn });
  return { url, expiresIn };
}
