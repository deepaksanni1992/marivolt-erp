import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import Document, { DOCUMENT_TYPES } from "../models/Document.js";
import { getS3Client, getS3Bucket, buildS3ObjectPublicUrl } from "../config/s3.js";
import { scopeToCompany } from "../middleware/auth.js";
import { writeAudit } from "../services/auditService.js";

/** Map UI document type → S3 prefix folder (no leading/trailing slashes). */
const DOCUMENT_TYPE_TO_FOLDER = {
  "Supplier Proforma Invoice": "supplier-proforma",
  "Supplier Tax Invoice": "supplier-tax-invoices",
  "Commercial Invoice": "commercial-invoices",
  "Delivery Note": "delivery-notes",
  "Supplier Bank Details": "supplier-bank-details",
  "Payment Instruction": "payment-instructions",
  "Supplier Invoice": "supplier-invoices",
  "Customer PO": "customer-po",
  "Purchase Order": "purchase-orders",
  "Sales Invoice": "sales-invoices",
  "Packing List": "packing-lists",
  "BL/AWB": "bl-awb",
  "Customs Docs": "customs-docs",
  "Inspection Report": "inspection-reports",
  "Bank Transfer Proof": "bank-transfer-proof",
  "Supplier Receipt": "supplier-receipts",
  "SWIFT Copy": "swift-copies",
  "Shipping Document": "shipping-documents",
  "GRN Document": "grn-documents",
  Other: "others",
};

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const ALLOWED_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".xls", ".xlsx", ".doc", ".docx"]);

function extensionOf(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i) : "";
}

function validateFile(file) {
  if (!file || !file.buffer) {
    return "No file uploaded. Use form field name \"file\".";
  }
  const ext = extensionOf(file.originalname);
  if (!ALLOWED_EXT.has(ext)) {
    return `File type not allowed. Permitted: PDF, JPG, JPEG, PNG, XLS, XLSX, DOC, DOCX. Got: ${ext || "(none)"}`;
  }
  const mime = String(file.mimetype || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return `MIME type not allowed: ${mime || "unknown"}`;
  }
  const max = 10 * 1024 * 1024;
  if (file.size > max) {
    return "File exceeds maximum size of 10 MB.";
  }
  return null;
}

function sanitizeStoredBaseName(originalName) {
  const base = String(originalName || "document").replace(/[/\\?%*:|"<>]/g, "_").slice(0, 120);
  return base || "document";
}

/**
 * POST /api/documents/upload
 * multipart: file + text fields
 */
export async function uploadDocument(req, res) {
  try {
    const errMsg = validateFile(req.file);
    if (errMsg) return res.status(400).json({ message: errMsg });

    const documentType = String(req.body?.documentType || "").trim();
    if (!DOCUMENT_TYPES.includes(documentType)) {
      return res.status(400).json({
        message: `Invalid documentType. Allowed: ${DOCUMENT_TYPES.join(", ")}`,
      });
    }

    const refNo = String(req.body?.refNo || "").trim();
    const partyName = String(req.body?.partyName || "").trim();
    const moduleName = String(req.body?.moduleName || "").trim();
    const relatedId = String(req.body?.relatedId || "").trim();
    const remarks = String(req.body?.remarks || "").trim();

    const folder = DOCUMENT_TYPE_TO_FOLDER[documentType] || "others";
    const companyId = req.companyId;
    const uuid = randomUUID();
    const safeBase = sanitizeStoredBaseName(req.file.originalname);
    const storedFileName = `${uuid}-${safeBase}`;
    const s3Key = `${folder}/${companyId}/${storedFileName}`;

    const client = getS3Client();
    const bucket = getS3Bucket();

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }),
    );

    const fileUrl = buildS3ObjectPublicUrl(s3Key);
    const uploadedBy = String(req.user?.email || req.user?.id || "").trim();

    const doc = await Document.create({
      companyId,
      documentType,
      refNo,
      partyName,
      moduleName,
      relatedId,
      originalFileName: req.file.originalname,
      storedFileName,
      mimeType: req.file.mimetype,
      size: req.file.size,
      s3Key,
      fileUrl,
      remarks,
      uploadedBy,
      uploadedAt: new Date(),
    });
    await writeAudit(req, {
      action: "UPLOAD",
      module: moduleName || "DOCUMENTS",
      entityType: "DOCUMENT",
      entityId: doc._id,
      documentNo: refNo || doc._id,
      description: `${documentType} uploaded: ${doc.originalFileName}`,
      metadata: {
        documentType,
        relatedId,
        moduleName,
        size: doc.size,
      },
    });

    res.status(201).json(doc.toObject());
  } catch (err) {
    console.error("[documents] upload error:", err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
}

/**
 * GET /api/documents
 */
export async function listDocuments(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const q = String(req.query.search || "").trim();

    const filter = scopeToCompany(req, {});
    const moduleName = String(req.query.moduleName || "").trim();
    const relatedId = String(req.query.relatedId || "").trim();
    if (moduleName) filter.moduleName = moduleName;
    if (relatedId) filter.relatedId = relatedId;
    if (q) {
      filter.$or = [
        { refNo: new RegExp(q, "i") },
        { partyName: new RegExp(q, "i") },
        { originalFileName: new RegExp(q, "i") },
        { moduleName: new RegExp(q, "i") },
      ];
    }

    const [rows, total] = await Promise.all([
      Document.find(filter).sort({ uploadedAt: -1 }).skip(skip).limit(limit).lean(),
      Document.countDocuments(filter),
    ]);

    res.json({ rows, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("[documents] list error:", err);
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/documents/:id
 */
export async function getDocument(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid document id" });
    }
    const doc = await Document.findOne(scopeToCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Document not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * DELETE /api/documents/:id
 */
export async function deleteDocument(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid document id" });
    }
    const doc = await Document.findOne(scopeToCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Document not found" });

    const client = getS3Client();
    const bucket = getS3Bucket();
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: doc.s3Key,
      }),
    );

    await doc.deleteOne();
    await writeAudit(req, {
      action: "DELETE",
      module: doc.moduleName || "DOCUMENTS",
      entityType: "DOCUMENT",
      entityId: doc._id,
      documentNo: doc.refNo || doc._id,
      description: `${doc.documentType} deleted: ${doc.originalFileName}`,
      metadata: {
        documentType: doc.documentType,
        relatedId: doc.relatedId || "",
      },
    });
    res.json({ ok: true, message: "Document deleted" });
  } catch (err) {
    console.error("[documents] delete error:", err);
    res.status(500).json({ message: err.message || "Delete failed" });
  }
}

/** Signed URL TTL in seconds (private bucket). */
const SIGNED_URL_EXPIRES = 120;

/**
 * GET /api/documents/:id/download
 * Returns a short-lived signed URL (JSON) for the browser to open.
 */
export async function downloadDocument(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid document id" });
    }
    const doc = await Document.findOne(scopeToCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Document not found" });

    const client = getS3Client();
    const bucket = getS3Bucket();
    const asciiName = String(doc.originalFileName || "download")
      .replace(/[^\x20-\x7E]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 200);
    const inline = String(req.query.inline || "").trim() === "1";
    const disposition = inline
      ? `inline; filename="${asciiName}"`
      : `attachment; filename="${asciiName}"`;
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: doc.s3Key,
      ResponseContentDisposition: disposition,
    });
    const url = await getSignedUrl(client, command, { expiresIn: SIGNED_URL_EXPIRES });
    res.json({
      url,
      expiresIn: SIGNED_URL_EXPIRES,
      fileName: doc.originalFileName,
      mimeType: doc.mimeType,
    });
  } catch (err) {
    console.error("[documents] download error:", err);
    res.status(500).json({ message: err.message || "Could not generate download link" });
  }
}
