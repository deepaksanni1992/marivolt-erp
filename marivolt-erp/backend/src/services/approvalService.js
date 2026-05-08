/**
 * Approval service — Phase-10.
 *
 * Helpers for creating and resolving approval requests on:
 *   • SALES.invoice_post / SALES.invoice_cancel
 *   • ACCOUNTS.payment_post / ACCOUNTS.payment_cancel
 *   • STORE.adjustment_post
 *   • LOGISTICS.dispatch_close
 *
 * Phase-10.1 only ships the data layer + helper functions. Phase-10.4
 * will wire `requestApproval()` into the relevant controllers so
 * postings block on a PENDING request when a matching ApprovalRule
 * is active. Today they remain unused — controllers continue to
 * post directly.
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

export default { findMatchingRule, requestApproval, decideApproval };
