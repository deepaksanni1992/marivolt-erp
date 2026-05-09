import mongoose from "mongoose";
import PurchaseRequisition from "../models/PurchaseRequisition.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizeLines(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      article: String(line.article || line.itemCode || "").trim().toUpperCase(),
      description: String(line.description || "").trim(),
      qty: Number(line.qty) || 0,
      uom: String(line.uom || "PCS").trim().toUpperCase(),
      requiredDate: line.requiredDate ? new Date(line.requiredDate) : null,
      remarks: String(line.remarks || "").trim(),
    }))
    .filter((line) => line.article && line.qty > 0);
}

export async function listPurchaseRequisitions(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.approvalStatus) filter.approvalStatus = String(req.query.approvalStatus).trim().toUpperCase();
    if (req.query.requester) filter.requester = new RegExp(String(req.query.requester).trim(), "i");
    if (req.query.department) filter.department = new RegExp(String(req.query.department).trim(), "i");

    const [items, total] = await Promise.all([
      PurchaseRequisition.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PurchaseRequisition.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await PurchaseRequisition.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseRequisition(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines);
    if (!lines.length) return res.status(400).json({ message: "At least one line is required" });
    const prNo =
      String(body.prNo || "").trim() ||
      (await nextSequentialNumber(PurchaseRequisition, "prNo", "PR", {
        companyId: req.companyId,
        branchId: body.branchId || null,
        docKey: "PURCHASE_REQUISITION",
        companyCode: req.companyCode || "",
      }));
    const doc = await PurchaseRequisition.create({
      companyId: req.companyId,
      branchId: body.branchId || null,
      warehouseId: body.warehouseId || null,
      prNo,
      requester: String(body.requester || req.user?.email || "").trim(),
      department: String(body.department || "").trim(),
      requiredDate: body.requiredDate ? new Date(body.requiredDate) : null,
      remarks: String(body.remarks || "").trim(),
      approvalStatus: "NOT_REQUIRED",
      status: "DRAFT",
      lines,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      description: `PR ${doc.prNo} created`,
      metadata: { lineCount: doc.lines.length },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updatePurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["DRAFT", "REJECTED"].includes(doc.status)) {
      return res.status(409).json({ message: "Only draft/rejected PR can be edited." });
    }
    const body = { ...req.body };
    const lines = body.lines ? normalizeLines(body.lines) : doc.lines;
    if (!lines.length) return res.status(400).json({ message: "At least one line is required" });
    doc.branchId = body.branchId ?? doc.branchId;
    doc.warehouseId = body.warehouseId ?? doc.warehouseId;
    doc.requester = body.requester !== undefined ? String(body.requester || "").trim() : doc.requester;
    doc.department = body.department !== undefined ? String(body.department || "").trim() : doc.department;
    doc.requiredDate = body.requiredDate !== undefined ? (body.requiredDate ? new Date(body.requiredDate) : null) : doc.requiredDate;
    doc.remarks = body.remarks !== undefined ? String(body.remarks || "").trim() : doc.remarks;
    doc.lines = lines;
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      description: `PR ${doc.prNo} updated`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function submitPurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["DRAFT", "REJECTED"].includes(doc.status)) {
      return res.status(409).json({ message: "Only draft/rejected PR can be submitted." });
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "PURCHASE",
      actionKey: "pr_submit",
      documentType: "PURCHASE_REQUISITION",
      documentId: doc._id,
      documentNo: doc.prNo,
      description: `Submit PR ${doc.prNo}`,
    });
    if (!gate.approved) {
      doc.status = "SUBMITTED";
      doc.approvalStatus = "PENDING";
      doc.updatedBy = req.user?.email || "";
      await doc.save();
      await writeStatusChange(req, {
        module: "PURCHASE",
        entityType: "PURCHASE_REQUISITION",
        entityId: doc._id,
        documentNo: doc.prNo,
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
        description: `PR ${doc.prNo} submitted and pending approval`,
      });
      return res.status(202).json(approvalRequiredPayload(gate.request));
    }
    doc.status = "APPROVED";
    doc.approvalStatus = "APPROVED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      fromStatus: "DRAFT",
      toStatus: "APPROVED",
      description: `PR ${doc.prNo} auto-approved on submit`,
    });
    res.json(doc);
  } catch (err) {
    if (err?.code === "APPROVAL_NOT_APPROVED") return res.status(409).json({ message: err.message, code: err.code });
    res.status(400).json({ message: err.message });
  }
}

export async function approvePurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["SUBMITTED", "REJECTED"].includes(doc.status)) return res.status(409).json({ message: "PR is not approvable." });
    const prev = doc.status;
    doc.status = "APPROVED";
    doc.approvalStatus = "APPROVED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      fromStatus: prev,
      toStatus: "APPROVED",
      description: `PR ${doc.prNo} approved`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function rejectPurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (doc.status !== "SUBMITTED") return res.status(409).json({ message: "Only submitted PR can be rejected." });
    doc.status = "REJECTED";
    doc.approvalStatus = "REJECTED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      fromStatus: "SUBMITTED",
      toStatus: "REJECTED",
      description: `PR ${doc.prNo} rejected`,
      metadata: { reason: String(req.body?.reason || "").trim() },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelPurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (["CLOSED", "CANCELLED"].includes(doc.status)) return res.status(409).json({ message: "PR is already finalised." });
    const prev = doc.status;
    doc.status = "CANCELLED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      fromStatus: prev,
      toStatus: "CANCELLED",
      description: `PR ${doc.prNo} cancelled`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function closePurchaseRequisition(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseRequisition.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["APPROVED", "SUBMITTED"].includes(doc.status)) return res.status(409).json({ message: "Only approved/submitted PR can be closed." });
    const prev = doc.status;
    doc.status = "CLOSED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_REQUISITION",
      entityId: doc._id,
      documentNo: doc.prNo,
      fromStatus: prev,
      toStatus: "CLOSED",
      description: `PR ${doc.prNo} closed`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
