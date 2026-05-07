import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Bucket, getS3Client } from "../config/s3.js";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

function safeEnv(value, fallback = "") {
  const v = String(value ?? "").trim();
  return v || fallback;
}

function sanitizeFileName(name = "file") {
  const cleaned = String(name)
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 140);
  return cleaned || "file";
}

export function buildDatedS3Key({ folderName, prefix = "", originalFileName = "file" }) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const ts = String(now.getTime());
  const safeFolder = String(folderName || "uploads").replace(/^\/+|\/+$/g, "");
  const safePrefix = String(prefix || "file").replace(/[^\w.\-]+/g, "-");
  const safeName = sanitizeFileName(originalFileName);
  return `${safeFolder}/${yyyy}/${mm}/${safePrefix}-${ts}-${safeName}`;
}

export async function uploadFileToS3(file, folderName, options = {}) {
  if (!file?.buffer) throw new Error("No file buffer provided for S3 upload");
  const bucket = getS3Bucket();
  const client = getS3Client();
  const key =
    options.key ||
    buildDatedS3Key({
      folderName,
      prefix: options.prefix || "file",
      originalFileName: options.originalFileName || file.originalname || "file",
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

export async function deleteFileFromS3(key) {
  if (!key) return;
  const bucket = getS3Bucket();
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

export async function getSignedFileUrl(key, options = {}) {
  if (!key) throw new Error("S3 key is required");
  const bucket = getS3Bucket();
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

export { sanitizeFileName };
