import crypto from "crypto";
import mongoose from "mongoose";
import CommunicationThread from "../models/CommunicationThread.js";
import CommunicationMessage from "../models/CommunicationMessage.js";
import CommunicationTemplate from "../models/CommunicationTemplate.js";
import DocumentApproval from "../models/DocumentApproval.js";
import PortalAccessToken from "../models/PortalAccessToken.js";
import PortalAccessLog from "../models/PortalAccessLog.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

const DEFAULT_TEMPLATES = [
  {
    templateCode: "QUOTATION_FOLLOWUP",
    templateName: "Quotation followup",
    templateType: "QUOTATION_FOLLOWUP",
    subjectTemplate: "Follow-up on quotation {{quotationNo}}",
    messageTemplate: "Hello {{partyName}},\n\nFollowing up on quotation {{quotationNo}}. Please share your confirmation.\n\nRegards,\n{{senderName}}",
  },
  {
    templateCode: "PAYMENT_REMINDER",
    templateName: "Payment reminder",
    templateType: "PAYMENT_REMINDER",
    subjectTemplate: "Payment reminder for invoice {{invoiceNo}}",
    messageTemplate: "Hello {{partyName}},\n\nThis is a reminder for invoice {{invoiceNo}} due on {{dueDate}}.\n\nRegards,\n{{senderName}}",
  },
  {
    templateCode: "DISPATCH_UPDATE",
    templateName: "Dispatch update",
    templateType: "DISPATCH_UPDATE",
    subjectTemplate: "Dispatch update {{dispatchNo}}",
    messageTemplate: "Hello {{partyName}},\n\nYour shipment linked to dispatch {{dispatchNo}} is updated.\n\nRegards,\n{{senderName}}",
  },
  {
    templateCode: "SUPPLIER_ENQUIRY",
    templateName: "Supplier enquiry",
    templateType: "SUPPLIER_ENQUIRY",
    subjectTemplate: "Enquiry for item {{itemCode}}",
    messageTemplate: "Hello {{supplierName}},\n\nPlease confirm availability and lead time for item {{itemCode}}.\n\nRegards,\n{{senderName}}",
  },
  {
    templateCode: "SHIPMENT_DELAY",
    templateName: "Shipment delay",
    templateType: "SHIPMENT_DELAY",
    subjectTemplate: "Shipment delay notice {{shipmentNo}}",
    messageTemplate: "Hello {{partyName}},\n\nShipment {{shipmentNo}} is delayed. Updated ETA: {{eta}}.\n\nRegards,\n{{senderName}}",
  },
];

async function ensureDefaultTemplatesSeeded(req) {
  const existing = await CommunicationTemplate.find(withCompany(req, { templateCode: { $in: DEFAULT_TEMPLATES.map((x) => x.templateCode) } }))
    .select("templateCode")
    .lean();
  const existingSet = new Set(existing.map((x) => x.templateCode));
  const docs = DEFAULT_TEMPLATES.filter((x) => !existingSet.has(x.templateCode)).map((x) => ({
    companyId: req.companyId,
    ...x,
    channel: "EMAIL",
    portalVisible: false,
    active: true,
    createdBy: req.user?.email || "system",
    updatedBy: req.user?.email || "system",
  }));
  if (docs.length) await CommunicationTemplate.insertMany(docs);
}

const LINKED_DOCUMENT_TYPES = new Set([
  "QUOTATION",
  "SALES_INVOICE",
  "PURCHASE_INVOICE",
  "SHIPMENT",
  "PURCHASE_ORDER",
  "GRN",
  "PAYMENT",
  "OTHER",
]);

function normalizeLinkedDocuments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row, idx) => {
    const documentType = String(row?.documentType || "OTHER").trim().toUpperCase();
    const documentNo = String(row?.documentNo || "").trim();
    const documentId = String(row?.documentId || "").trim();
    if (!LINKED_DOCUMENT_TYPES.has(documentType)) {
      throw new Error(`Invalid linked document type at index ${idx}`);
    }
    if (!documentNo && !documentId) {
      throw new Error(`Linked document requires documentNo or documentId at index ${idx}`);
    }
    if (documentId && !mongoose.Types.ObjectId.isValid(documentId)) {
      throw new Error(`Invalid linked documentId at index ${idx}`);
    }
    return { documentType, documentNo, documentId };
  });
}

export async function listCommunicationThreads(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.partyType) filter.partyType = String(req.query.partyType).trim().toUpperCase();
    if (req.query.party) {
      const q = String(req.query.party).trim();
      filter.$or = [{ partyName: new RegExp(q, "i") }, { partyEmail: new RegExp(q, "i") }];
    }
    if (req.query.documentNo) {
      filter["linkedDocuments.documentNo"] = new RegExp(String(req.query.documentNo).trim(), "i");
    }
    if (req.query.relatedModule) filter.relatedModule = String(req.query.relatedModule).trim();
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [{ partyName: new RegExp(q, "i") }, { partyEmail: new RegExp(q, "i") }, { subject: new RegExp(q, "i") }, { threadNo: new RegExp(q, "i") }],
        },
      ];
      delete filter.$or;
    }
    const [items, total] = await Promise.all([
      CommunicationThread.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      CommunicationThread.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getCommunicationThread(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await CommunicationThread.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    const messages = await CommunicationMessage.find(withCompany(req, { threadId: row._id }))
      .sort({ createdAt: 1 })
      .limit(1000)
      .lean();
    res.json({ ...row, messages });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCommunicationThread(req, res) {
  try {
    const threadNo = await nextSequentialNumber(CommunicationThread, "threadNo", `${req.companyCode || "CMP"}-COM`, { companyId: req.companyId });
    const body = req.body || {};
    const linkedDocuments = normalizeLinkedDocuments(body.linkedDocuments);
    const row = await CommunicationThread.create({
      companyId: req.companyId,
      threadNo,
      threadType: String(body.threadType || "CUSTOMER_COMMUNICATION").trim().toUpperCase(),
      partyType: String(body.partyType || "INTERNAL").trim().toUpperCase(),
      partyName: String(body.partyName || "").trim(),
      partyEmail: String(body.partyEmail || "").trim(),
      relatedModule: String(body.relatedModule || "").trim(),
      relatedId: String(body.relatedId || "").trim(),
      linkedDocuments,
      subject: String(body.subject || "").trim(),
      portalReady: Boolean(body.portalReady),
      portalReference: String(body.portalReference || "").trim(),
      tags: Array.isArray(body.tags) ? body.tags : [],
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "DOCUMENTS",
      entityType: "COMMUNICATION_THREAD",
      entityId: row._id,
      documentNo: row.threadNo,
      description: `Communication thread created: ${row.subject || row.threadNo}`,
      metadata: { partyType: row.partyType, partyName: row.partyName, relatedModule: row.relatedModule },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function addCommunicationMessage(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await CommunicationThread.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Thread not found" });
    const body = req.body || {};
    const direction = String(body.direction || "INTERNAL_NOTE").trim().toUpperCase();
    const visibility = String(body.visibility || (row.partyType === "CUSTOMER" ? "CUSTOMER" : row.partyType === "SUPPLIER" ? "SUPPLIER" : "INTERNAL")).trim().toUpperCase();
    const portalVisible = Boolean(body.portalVisible);
    const requiresApproval = direction === "OUTBOUND" && Boolean(body.requireApproval);
    if (requiresApproval) {
      const gate = await ensureApproval(req, {
        module: "DOCUMENTS",
        actionKey: "communication_send",
        documentType: "COMMUNICATION_THREAD",
        documentId: row._id,
        documentNo: row.threadNo,
        amount: 0,
        currency: "USD",
        metadata: { subject: row.subject, partyName: row.partyName, threadNo: row.threadNo },
      });
      if (!gate.approved) {
        row.status = "WAITING_REPLY";
        await row.save();
        return res.status(202).json(approvalRequiredPayload(gate.request));
      }
    }
    const message = await CommunicationMessage.create({
      companyId: req.companyId,
      threadId: row._id,
      sender: String(body.sender || req.user?.email || "").trim(),
      recipient: String(body.recipient || row.partyEmail || "").trim(),
      message: String(body.message || body.body || "").trim(),
      direction,
      channel: String(body.channel || "SYSTEM").trim().toUpperCase(),
      subject: String(body.subject || "").trim(),
      visibility,
      portalVisible,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      sentAt: direction === "OUTBOUND" || direction === "INBOUND" ? new Date() : null,
      createdBy: req.user?.email || "",
    });
    row.messageCount = (Number(row.messageCount) || 0) + 1;
    row.lastMessageAt = message.createdAt;
    row.lastMessageBy = req.user?.email || "";
    row.status = direction === "OUTBOUND" ? "WAITING_REPLY" : "OPEN";
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "DOCUMENTS",
      entityType: "COMMUNICATION_THREAD",
      entityId: row._id,
      documentNo: row.threadNo,
      description: `Communication message added (${direction})`,
      metadata: { direction, channel: message.channel, visibility, portalVisible },
    });
    res.json({ thread: row, message });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function markThreadPortalReady(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await CommunicationThread.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Thread not found" });
    row.portalReady = true;
    row.portalReference = String(req.body?.portalReference || row.portalReference || row.threadNo).trim();
    row.updatedBy = req.user?.email || "";
    await row.save();
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function closeCommunicationThread(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await CommunicationThread.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Thread not found" });
    row.status = "CLOSED";
    row.updatedBy = req.user?.email || "";
    await row.save();
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateCommunicationThreadStatus(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await CommunicationThread.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Thread not found" });
    const status = String(req.body?.status || "").trim().toUpperCase();
    if (!["OPEN", "WAITING_REPLY", "CLOSED"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const allowedTransitions = {
      OPEN: new Set(["WAITING_REPLY"]),
      WAITING_REPLY: new Set(["CLOSED"]),
      CLOSED: new Set(["OPEN"]),
    };
    if (status !== row.status && !allowedTransitions[row.status]?.has(status)) {
      return res.status(400).json({ message: `Invalid status transition ${row.status} -> ${status}` });
    }
    row.status = status;
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "DOCUMENTS",
      entityType: "COMMUNICATION_THREAD",
      entityId: row._id,
      documentNo: row.threadNo,
      description: `Communication thread status set to ${status}`,
      metadata: { status },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createPortalAccessToken(req, res) {
  try {
    const body = req.body || {};
    const partyEmail = String(body.partyEmail || "").trim().toLowerCase();
    if (!partyEmail) return res.status(400).json({ message: "partyEmail required" });
    const rawToken = crypto.randomBytes(24).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
    const doc = await PortalAccessToken.create({
      companyId: req.companyId,
      partyType: String(body.partyType || "CUSTOMER").trim().toUpperCase(),
      partyName: String(body.partyName || "").trim(),
      partyEmail,
      tokenHash,
      scope: Array.isArray(body.scope) && body.scope.length ? body.scope : ["documents:view"],
      portalReference: String(body.portalReference || "").trim(),
      expiresAt,
      createdBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "DOCUMENTS",
      entityType: "PORTAL_ACCESS_TOKEN",
      entityId: doc._id,
      documentNo: doc.portalReference || doc._id,
      description: `Portal access token created for ${partyEmail}`,
      metadata: { partyType: doc.partyType, scope: doc.scope },
    });
    res.status(201).json({
      ...doc.toObject(),
      token: rawToken,
      note: "Store this token securely; only token hash is persisted.",
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function validatePortalAccessToken(req, res) {
  try {
    const rawToken = String(req.query.token || req.body?.token || "").trim();
    const portalReference = String(req.query.portalReference || req.body?.portalReference || "").trim();
    if (!rawToken) return res.status(400).json({ message: "token required" });
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const doc = await PortalAccessToken.findOne(withCompany(req, { tokenHash, status: "ACTIVE" }));
    if (!doc) {
      await PortalAccessLog.create({
        companyId: req.companyId,
        partyType: "CUSTOMER",
        partyEmail: "",
        portalReference,
        action: "TOKEN_VALIDATE",
        status: "DENIED",
        ip: String(req.ip || ""),
        userAgent: String(req.headers["user-agent"] || ""),
      });
      return res.status(403).json({ message: "Invalid token" });
    }
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) {
      doc.status = "EXPIRED";
      await doc.save();
      await PortalAccessLog.create({
        companyId: req.companyId,
        partyType: doc.partyType,
        partyEmail: doc.partyEmail,
        portalReference: doc.portalReference || portalReference,
        action: "TOKEN_VALIDATE",
        status: "EXPIRED",
        tokenId: doc._id,
        ip: String(req.ip || ""),
        userAgent: String(req.headers["user-agent"] || ""),
      });
      return res.status(403).json({ message: "Token expired" });
    }
    doc.lastAccessAt = new Date();
    await doc.save();
    await PortalAccessLog.create({
      companyId: req.companyId,
      partyType: doc.partyType,
      partyEmail: doc.partyEmail,
      portalReference: doc.portalReference || portalReference,
      action: "TOKEN_VALIDATE",
      status: "SUCCESS",
      tokenId: doc._id,
      ip: String(req.ip || ""),
      userAgent: String(req.headers["user-agent"] || ""),
    });
    res.json({
      ok: true,
      partyType: doc.partyType,
      partyName: doc.partyName,
      partyEmail: doc.partyEmail,
      scope: doc.scope,
      portalReference: doc.portalReference,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listPortalDocuments(req, res) {
  try {
    const portalReference = String(req.query.portalReference || "").trim();
    const visibility = String(req.query.visibility || "").trim().toUpperCase();
    if (!portalReference) return res.status(400).json({ message: "portalReference required" });
    const threads = await CommunicationThread.find(
      withCompany(req, { portalReady: true, portalReference })
    )
      .select("_id threadNo subject partyName")
      .lean();
    const threadIds = threads.map((x) => x._id);
    const messageFilter = withCompany(req, { threadId: { $in: threadIds }, portalVisible: true });
    if (visibility) {
      if (!["CUSTOMER", "SUPPLIER", "INTERNAL"].includes(visibility)) {
        return res.status(400).json({ message: "Invalid visibility filter" });
      }
      messageFilter.visibility = visibility;
    }
    const messages = await CommunicationMessage.find(messageFilter).lean();
    const attachments = [];
    for (const msg of messages) {
      for (const a of msg.attachments || []) {
        attachments.push({
          threadId: msg.threadId,
          messageId: msg._id,
          documentId: a.documentId,
          fileName: a.fileName || "",
          visibility: msg.visibility,
        });
      }
    }
    res.json({ threads, messages, attachments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listCommunicationTemplates(req, res) {
  try {
    await ensureDefaultTemplatesSeeded(req);
    const filter = withCompany(req, {});
    if (req.query.active === "true") filter.active = true;
    if (req.query.templateType) filter.templateType = String(req.query.templateType).trim().toUpperCase();
    const items = await CommunicationTemplate.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCommunicationTemplate(req, res) {
  try {
    const body = req.body || {};
    const doc = await CommunicationTemplate.create({
      companyId: req.companyId,
      templateCode: String(body.templateCode || "").trim().toUpperCase(),
      templateName: String(body.templateName || "").trim(),
      templateType: String(body.templateType || "CUSTOM").trim().toUpperCase(),
      subjectTemplate: String(body.subjectTemplate || "").trim(),
      messageTemplate: String(body.messageTemplate || ""),
      channel: String(body.channel || "EMAIL").trim().toUpperCase(),
      portalVisible: Boolean(body.portalVisible),
      active: body.active !== false,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function useCommunicationTemplate(req, res) {
  try {
    const { id } = req.params;
    const tpl = await CommunicationTemplate.findOne(withCompany(req, { _id: id }));
    if (!tpl) return res.status(404).json({ message: "Template not found" });
    let subject = String(tpl.subjectTemplate || "");
    let message = String(tpl.messageTemplate || "");
    const vars = req.body?.variables && typeof req.body.variables === "object" ? req.body.variables : {};
    for (const [k, v] of Object.entries(vars)) {
      const token = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g");
      subject = subject.replace(token, String(v));
      message = message.replace(token, String(v));
    }
    res.json({ subject, message, templateId: tpl._id, templateCode: tpl.templateCode });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listDocumentApprovals(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, {});
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.linkedDocumentType) filter.linkedDocumentType = String(req.query.linkedDocumentType).trim().toUpperCase();
    if (req.query.linkedDocumentNo) filter.linkedDocumentNo = new RegExp(String(req.query.linkedDocumentNo).trim(), "i");
    const [items, total] = await Promise.all([
      DocumentApproval.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DocumentApproval.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createDocumentApproval(req, res) {
  try {
    const body = req.body || {};
    const approvalNo = await nextSequentialNumber(DocumentApproval, "approvalNo", `${req.companyCode || "CMP"}-APR`, { companyId: req.companyId });
    const doc = await DocumentApproval.create({
      companyId: req.companyId,
      approvalNo,
      linkedDocumentType: String(body.linkedDocumentType || "").trim().toUpperCase(),
      linkedDocumentId: String(body.linkedDocumentId || "").trim(),
      linkedDocumentNo: String(body.linkedDocumentNo || "").trim(),
      status: "PENDING",
      approver: String(body.approver || "").trim(),
      remarks: String(body.remarks || "").trim(),
      requestedBy: req.user?.email || "",
      requestedAt: new Date(),
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "DOCUMENTS",
      entityType: "DOCUMENT_APPROVAL",
      entityId: doc._id,
      documentNo: doc.approvalNo,
      description: `Document approval requested for ${doc.linkedDocumentType}`,
      metadata: { linkedDocumentId: doc.linkedDocumentId, linkedDocumentNo: doc.linkedDocumentNo },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function decideDocumentApproval(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await DocumentApproval.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Approval not found" });
    const status = String(req.body?.status || "").trim().toUpperCase();
    if (!["APPROVED", "REJECTED", "CANCELLED"].includes(status)) {
      return res.status(400).json({ message: "Invalid status decision" });
    }
    doc.status = status;
    doc.decidedBy = req.user?.email || "";
    doc.decidedAt = new Date();
    doc.approvalDate = status === "APPROVED" ? new Date() : doc.approvalDate;
    doc.remarks = String(req.body?.remarks || doc.remarks || "").trim();
    await doc.save();
    await writeAudit(req, {
      action: status,
      module: "DOCUMENTS",
      entityType: "DOCUMENT_APPROVAL",
      entityId: doc._id,
      documentNo: doc.approvalNo,
      description: `Document approval ${status.toLowerCase()}`,
      metadata: { linkedDocumentType: doc.linkedDocumentType, linkedDocumentNo: doc.linkedDocumentNo },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function communicationActivityReport(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const items = await CommunicationMessage.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function pendingApprovalsReport(req, res) {
  try {
    const items = await DocumentApproval.find(withCompany(req, { status: "PENDING" }))
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function portalAccessLogReport(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.partyType) filter.partyType = String(req.query.partyType).trim().toUpperCase();
    const items = await PortalAccessLog.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

