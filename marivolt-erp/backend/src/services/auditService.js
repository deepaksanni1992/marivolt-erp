/**
 * Audit Service — Phase-8.
 *
 *  Tiny helper that controllers use to write business-meaningful
 *  events to `AuditLog`. Designed to never throw inside the
 *  controller's request path: any logging failure is swallowed and
 *  console-warned instead of failing the user's transaction.
 *
 *  Common shape:
 *     await writeAudit(req, {
 *       action: "STATUS_CHANGE",
 *       module: "SALES",
 *       entityType: "ORDER_ALLOCATION",
 *       entityId: oa._id,
 *       documentNo: oa.allocationNo,
 *       fromStatus: prev,
 *       toStatus: oa.status,
 *       description: `OA ${oa.allocationNo} cancelled`,
 *       metadata: { reason },
 *     });
 *
 *  When `req` is unavailable (e.g. background job), pass `null`
 *  for the first argument and supply userId/userEmail directly in
 *  the entry payload.
 */
import AuditLog from "../models/AuditLog.js";

function extractRequestMeta(req) {
  if (!req) return {};
  return {
    companyId: req.companyId || null,
    userId: req.user?._id || null,
    userName: req.user?.name || req.user?.fullName || "",
    userEmail: req.user?.email || "",
    ip:
      req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      "",
    userAgent: req.headers?.["user-agent"] || "",
  };
}

/**
 * Best-effort audit log write. Never throws.
 */
export async function writeAudit(req, entry = {}) {
  try {
    const meta = extractRequestMeta(req);
    await AuditLog.create({
      companyId: entry.companyId || meta.companyId || null,
      userId: entry.userId || meta.userId || null,
      userName: entry.userName ?? meta.userName,
      userEmail: entry.userEmail ?? meta.userEmail,
      action: entry.action || "OTHER",
      module: entry.module || "",
      entityType: entry.entityType || "",
      entityId: String(entry.entityId || ""),
      documentNo: entry.documentNo || "",
      description: entry.description || "",
      fromStatus: entry.fromStatus || "",
      toStatus: entry.toStatus || "",
      beforeData: entry.beforeData ?? null,
      afterData: entry.afterData ?? null,
      ip: entry.ip ?? meta.ip,
      userAgent: entry.userAgent ?? meta.userAgent,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    // Logging must never break the user's transaction — surface to
    // server console only.
    console.warn("[audit] failed to persist log entry:", err.message);
  }
}

/**
 * Convenience for status transitions. Wraps `writeAudit` with the
 * STATUS_CHANGE action and pre-fills the from/to fields.
 */
export async function writeStatusChange(req, {
  module,
  entityType,
  entityId,
  documentNo,
  fromStatus,
  toStatus,
  description = "",
  metadata = null,
} = {}) {
  return writeAudit(req, {
    action: "STATUS_CHANGE",
    module,
    entityType,
    entityId,
    documentNo,
    fromStatus,
    toStatus,
    description: description || `${entityType} ${documentNo}: ${fromStatus} → ${toStatus}`,
    metadata,
  });
}

export default { writeAudit, writeStatusChange };
