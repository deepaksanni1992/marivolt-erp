/**
 * Approval service — Phase-10.
 *
 * Helpers for creating and resolving approval requests on:
 *   • SALES.invoice_post / SALES.invoice_cancel
 *   • ACCOUNTS.payment_post / ACCOUNTS.payment_cancel
 *   • STORE.adjustment_post
 *   • LOGISTICS.dispatch_close
 *
 * Controllers call `ensureApproval(req, payload)` before sensitive
 * actions. It returns:
 *   { approved: true }                           -> proceed
 *   { approved: false, request: ApprovalRequest } -> return 202
 *
 * A caller can retry an action with `approvalRequestId` in the JSON
 * body or `x-approval-request-id` header after an approver marks the
 * request APPROVED.
 */
import ApprovalRule from "../models/ApprovalRule.js";
import ApprovalRequest from "../models/ApprovalRequest.js";

/**
 * Pick the highest-priority matching rule (by amount threshold).
 * Returns null if no matching rule exists, which means the action is
 * automatically allowed.
 */
export async function findMatchingRule({
  companyId,
  module,
  actionKey,
  amount = 0,
  currency = "USD",
} = {}) {
  if (!companyId || !module || !actionKey) return null;
  const rules = await ApprovalRule.find({
    companyId,
    module: String(module).toUpperCase(),
    actionKey: String(actionKey).toLowerCase(),
    isActive: true,
  })
    .sort({ priority: -1, minAmount: -1 })
    .lean();
  for (const rule of rules) {
    const ruleAmount = Number(rule.minAmount || 0);
    const ruleCurrency = String(rule.currency || "").toUpperCase();
    const inputCurrency = String(currency || "").toUpperCase();
    if (ruleAmount > 0 && Number(amount || 0) < ruleAmount) continue;
    if (ruleCurrency && inputCurrency && ruleCurrency !== inputCurrency) continue;
    return rule;
  }
  return null;
}

/**
 * Create an approval request and return the persisted document. The
 * caller should bail out of the underlying business action when the
 * returned request is in PENDING state.
 */
export async function requestApproval(req, payload = {}) {
  const {
    companyId,
    module,
    actionKey,
    documentType = "",
    documentId = null,
    documentNo = "",
    customerName = "",
    amount = 0,
    currency = "USD",
    description = "",
  } = payload;

  const rule = await findMatchingRule({
    companyId,
    module,
    actionKey,
    amount,
    currency,
  });
  if (!rule) return null;

  const existingFilter = {
    companyId,
    module: String(module).toUpperCase(),
    actionKey: String(actionKey).toLowerCase(),
    status: "PENDING",
  };
  if (documentId || documentNo) {
    if (documentId) existingFilter.documentId = documentId;
    else existingFilter.documentNo = documentNo;
    const existing = await ApprovalRequest.findOne(existingFilter).lean();
    if (existing) return existing;
  }

  const doc = await ApprovalRequest.create({
    companyId,
    module: String(module).toUpperCase(),
    actionKey: String(actionKey).toLowerCase(),
    documentType,
    documentId,
    documentNo,
    customerName,
    amount,
    currency,
    description,
    requestedBy: req?.user?.id || null,
    requestedByEmail: req?.user?.email || "",
    requestedByName: req?.user?.name || "",
    status: "PENDING",
    ruleId: rule._id,
    approverRoles: rule.approverRoles || [],
    approverUserIds: rule.approverUserIds || [],
    history: [],
  });
  return doc;
}

function approvalRequestIdFromReq(req) {
  return String(
    req?.body?.approvalRequestId ||
      req?.headers?.["x-approval-request-id"] ||
      ""
  ).trim();
}

export async function ensureApproval(req, payload = {}) {
  const module = String(payload.module || "").toUpperCase();
  const actionKey = String(payload.actionKey || "").toLowerCase();
  const companyId = payload.companyId || req?.companyId;
  const documentId = payload.documentId || null;
  const documentNo = payload.documentNo || "";
  const approvalRequestId = approvalRequestIdFromReq(req);

  if (approvalRequestId) {
    const filter = {
      _id: approvalRequestId,
      companyId,
      module,
      actionKey,
      status: "APPROVED",
    };
    if (documentId) filter.documentId = documentId;
    else if (documentNo) filter.documentNo = documentNo;
    const approved = await ApprovalRequest.findOne(filter).lean();
    if (!approved) {
      const err = new Error("Approval request is not approved for this action.");
      err.code = "APPROVAL_NOT_APPROVED";
      err.status = 409;
      throw err;
    }
    return { approved: true, request: approved };
  }

  const request = await requestApproval(req, { ...payload, companyId });
  if (!request) return { approved: true };
  return { approved: false, request };
}

export function approvalRequiredPayload(request) {
  return {
    message: "Approval required before this action can be completed.",
    code: "APPROVAL_REQUIRED",
    approvalRequest: {
      id: request?._id,
      module: request?.module,
      actionKey: request?.actionKey,
      documentType: request?.documentType || "",
      documentId: request?.documentId || null,
      documentNo: request?.documentNo || "",
      status: request?.status || "PENDING",
    },
  };
}

export async function decideApproval(req, { id, decision, note = "" } = {}) {
  if (!id) throw new Error("decideApproval: id required");
  const allowed = ["APPROVED", "REJECTED", "CANCELLED"];
  const decisionUpper = String(decision || "").toUpperCase();
  if (!allowed.includes(decisionUpper)) {
    throw new Error(`decideApproval: invalid decision ${decision}`);
  }
  const doc = await ApprovalRequest.findOne({ _id: id, companyId: req?.companyId });
  if (!doc) throw new Error("Approval request not found");
  if (doc.status !== "PENDING") throw new Error("Approval already finalised");

  doc.status = decisionUpper;
  doc.history.push({
    actorUserId: req?.user?.id || null,
    actorEmail: req?.user?.email || "",
    actorName: req?.user?.name || "",
    decision: decisionUpper,
    note,
    at: new Date(),
  });
  doc.decidedAt = new Date();
  doc.decidedBy = req?.user?.id || null;
  doc.decidedByEmail = req?.user?.email || "";
  await doc.save();
  return doc;
}

export default { findMatchingRule, requestApproval, ensureApproval, approvalRequiredPayload, decideApproval };
