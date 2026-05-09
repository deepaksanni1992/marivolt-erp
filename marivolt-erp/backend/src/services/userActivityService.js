/**
 * User activity service — Phase-10.
 *
 * Best-effort writer for the UserActivity collection. Never throws —
 * any failure is console-warned so authentication paths remain
 * resilient.
 */
import UserActivity from "../models/UserActivity.js";

function clientIp(req) {
  if (!req) return "";
  return (
    req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    ""
  );
}

function detectDevice(userAgent = "") {
  const ua = String(userAgent || "").toLowerCase();
  if (/mobile|iphone|android.+mobile/.test(ua)) return "Mobile";
  if (/tablet|ipad/.test(ua)) return "Tablet";
  if (/macintosh|mac os|windows|linux|x11/.test(ua)) return "Desktop";
  return "Unknown";
}

function detectBrowser(userAgent = "") {
  const ua = String(userAgent || "");
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "Other";
}

function detectOs(userAgent = "") {
  const ua = String(userAgent || "");
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Mac OS X/i.test(ua)) return "macOS";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}

export async function recordActivity(req, entry = {}) {
  try {
    const userAgent = entry.userAgent ?? req?.headers?.["user-agent"] ?? "";
    await UserActivity.create({
      companyId: entry.companyId ?? req?.companyId ?? null,
      userId: entry.userId ?? req?.user?.id ?? null,
      userEmail: entry.userEmail ?? req?.user?.email ?? "",
      userName: entry.userName ?? req?.user?.name ?? "",
      action: entry.action || "OTHER",
      success: entry.success !== false,
      ip: entry.ip ?? clientIp(req),
      userAgent,
      device: entry.device ?? detectDevice(userAgent),
      browser: entry.browser ?? detectBrowser(userAgent),
      os: entry.os ?? detectOs(userAgent),
      description: entry.description ?? "",
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    console.warn("[user-activity] failed to persist:", err.message);
  }
}

export default { recordActivity };
