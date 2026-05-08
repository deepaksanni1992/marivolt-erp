/**
 * User Activity Controller — Phase-10.
 *
 * Read-only endpoints for browsing the UserActivity stream from the
 * admin UI. Activity rows are written by `userActivityService` from
 * the auth flow.
 */
import UserActivity, { USER_ACTIVITY_ACTIONS } from "../models/UserActivity.js";

function withCompany(req, extra = {}) {
  return { ...extra, companyId: req.companyId };
}

export async function listUserActivity(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.userEmail) {
      filter.userEmail = new RegExp(String(req.query.userEmail).trim(), "i");
    }
    if (req.query.action) {
      filter.action = String(req.query.action).toUpperCase();
    }
    if (req.query.success === "true") filter.success = true;
    if (req.query.success === "false") filter.success = false;
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) filter.createdAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate) filter.createdAt.$lte = new Date(req.query.toDate);
    }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const items = await UserActivity.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ items, actions: USER_ACTIVITY_ACTIONS });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
