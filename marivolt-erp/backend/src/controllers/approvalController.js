/**
 * Approval Controller — Phase-10.
 *
 * CRUD for ApprovalRule + queue/decision endpoints for
 * ApprovalRequest. Phase-10.1 ships the data layer; Phase-10.4 will
 * wire approval gates into the actual postings.
 */
import ApprovalRule from "../models/ApprovalRule.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { decideApproval } from "../services/approvalService.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, extra = {}) {
  return { ...extra, companyId: req.companyId };
}

/* ----------------------------------------------------------------- */
/* ApprovalRule                                                       */
/* ----------------------------------------------------------------- */

export async function listApprovalRules(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.module) filter.module = String(req.query.module).toUpperCase();
    if (req.query.activeOnly === "true") filter.isActive = true;
    const items = await ApprovalRule.find(filter)
      .sort({ module: 1, actionKey: 1, priority: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function upsertApprovalRule(req, res) {
  try {
    const id = req.params.id;
    const allowed = [
      "module",
      "actionKey",
      "description",
      "minAmount",
      "currency",
      "approverRoles",
      "approverUserIds",
      "priority",
      "isActive",
    ];
    const payload = {};
    for (const key of allowed) {
      if (key in (req.body || {})) payload[key] = req.body[key];
    }
    if (payload.module) payload.module = String(payload.module).toUpperCase();
    if (payload.actionKey) payload.actionKey = String(payload.actionKey).toLowerCase();
    if (payload.currency) payload.currency = String(payload.currency).toUpperCase();
    payload.companyId = req.companyId;

    let doc;
    if (id) {
      doc = await ApprovalRule.findOneAndUpdate(
        withCompany(req, { _id: id }),
        payload,
        { new: true }
      );
      if (!doc) return res.status(404).json({ message: "Approval rule not found" });
    } else {
      if (!payload.module || !payload.actionKey) {
        return res
          .status(400)
          .json({ message: "module and actionKey are required" });
      }
      doc = await ApprovalRule.create(payload);
    }
    await writeAudit(req, {
      action: id ? "UPDATE" : "CREATE",
      module: "SETTINGS",
      entityType: "APPROVAL_RULE",
      entityId: doc._id,
      documentNo: `${doc.module}.${doc.actionKey}`,
      description: `Approval rule ${doc.module}.${doc.actionKey} ${id ? "updated" : "created"}`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteApprovalRule(req, res) {
  try {
    const doc = await ApprovalRule.findOneAndDelete(
      withCompany(req, { _id: req.params.id })
    );
    if (!doc) return res.status(404).json({ message: "Approval rule not found" });
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: "APPROVAL_RULE",
      entityId: doc._id,
      documentNo: `${doc.module}.${doc.actionKey}`,
      description: `Approval rule ${doc.module}.${doc.actionKey} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/* ----------------------------------------------------------------- */
/* ApprovalRequest                                                    */
/* ----------------------------------------------------------------- */

export async function listApprovalRequests(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.module) filter.module = String(req.query.module).toUpperCase();
    if (req.query.documentNo) {
      filter.documentNo = new RegExp(String(req.query.documentNo).trim(), "i");
    }
    const items = await ApprovalRequest.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getApprovalRequest(req, res) {
  try {
    const doc = await ApprovalRequest.findOne(
      withCompany(req, { _id: req.params.id })
    ).lean();
    if (!doc) return res.status(404).json({ message: "Approval request not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function decideApprovalRequest(req, res) {
  try {
    const doc = await ApprovalRequest.findOne(
      withCompany(req, { _id: req.params.id })
    );
    if (!doc) return res.status(404).json({ message: "Approval request not found" });
    if (doc.status !== "PENDING") {
      return res.status(409).json({ message: "Approval already finalised" });
    }
    const decision = String(req.body?.decision || "").toUpperCase();
    const note = req.body?.note || "";
    const updated = await decideApproval(req, { id: doc._id, decision, note });
    await writeAudit(req, {
      action: "STATUS_CHANGE",
      module: "SETTINGS",
      entityType: "APPROVAL_REQUEST",
      entityId: updated._id,
      documentNo: updated.documentNo || `${updated.module}.${updated.actionKey}`,
      fromStatus: "PENDING",
      toStatus: updated.status,
      description: `Approval ${updated.status.toLowerCase()} for ${updated.documentNo}`,
      metadata: { note },
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
