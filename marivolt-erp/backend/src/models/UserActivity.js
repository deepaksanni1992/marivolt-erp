import mongoose from "mongoose";

/**
 * UserActivity — Phase-10.
 *
 * Tracks authentication-level events:
 *   • LOGIN_SUCCESS, LOGIN_FAILED
 *   • LOGOUT
 *   • COMPANY_SELECT, COMPANY_SWITCH
 *   • PASSWORD_CHANGE (future)
 *
 * `AuditLog` already records business actions; this collection is a
 * dedicated lightweight stream so admins can audit failed-login
 * patterns, IP/device usage, and per-user session activity without
 * scanning the much larger AuditLog. It complements (not replaces)
 * the existing audit log.
 */
const activityActions = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
  "COMPANY_SELECT",
  "COMPANY_SWITCH",
  "PASSWORD_CHANGE",
  "PASSWORD_RESET",
  "OTHER",
];

const userActivitySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    userEmail: { type: String, default: "", index: true },
    userName: { type: String, default: "" },
    action: { type: String, enum: activityActions, required: true, index: true },
    success: { type: Boolean, default: true, index: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    device: { type: String, default: "" },
    browser: { type: String, default: "" },
    os: { type: String, default: "" },
    description: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

userActivitySchema.index({ companyId: 1, action: 1, createdAt: -1 });
userActivitySchema.index({ userId: 1, action: 1, createdAt: -1 });
userActivitySchema.index({ userEmail: 1, action: 1, createdAt: -1 });

export const USER_ACTIVITY_ACTIONS = activityActions;
export default mongoose.model("UserActivity", userActivitySchema);
