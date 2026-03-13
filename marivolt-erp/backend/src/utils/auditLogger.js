import AuditLog from "../models/AuditLog.js";

export async function logAudit({
  req,
  userId,
  userName,
  action,
  entityType,
  entityId,
  description,
  beforeData,
  afterData,
}) {
  try {
    const fromReqUser = req?.user || {};
    const finalUserId = userId || fromReqUser._id || fromReqUser.id;
    const finalUserName = userName || fromReqUser.name || fromReqUser.email;

    if (!finalUserId) {
      return;
    }

    const ip =
      req?.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req?.socket?.remoteAddress ||
      "";

    await AuditLog.create({
      userId: finalUserId,
      userName: finalUserName,
      action,
      entityType,
      entityId: String(entityId || ""),
      description,
      beforeData,
      afterData,
      ip,
    });
  } catch (e) {
    // Do not break main request flow if logging fails
    // eslint-disable-next-line no-console
    console.error("Failed to write audit log:", e.message);
  }
}

