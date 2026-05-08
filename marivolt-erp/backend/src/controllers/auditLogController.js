/**
 * Audit log read endpoints. Writes happen via `auditService.js`
 * directly from inside controllers (so the call sites stay close to
 * the actual business event). This module only exposes filtered
 * read access for the frontend Audit Trail viewer.
 */
import AuditLog from "../models/AuditLog.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listAuditLogs(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
    const skip = (page - 1) * limit;

    const filter = withCompany(req);
    if (req.query.module) filter.module = String(req.query.module).trim();
    if (req.query.action) filter.action = String(req.query.action).trim();
    if (req.query.entityType) filter.entityType = String(req.query.entityType).trim();
    if (req.query.documentNo) {
      filter.documentNo = new RegExp(String(req.query.documentNo).trim(), "i");
    }
    if (req.query.userEmail) {
      filter.userEmail = new RegExp(String(req.query.userEmail).trim(), "i");
    }
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) {
        const d = new Date(req.query.to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
          d.setHours(23, 59, 59, 999);
        }
        filter.createdAt.$lte = d;
      }
    }

    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listDocumentAuditTrail(req, res) {
  try {
    const documentNo = String(req.params.documentNo || "").trim();
    if (!documentNo) return res.status(400).json({ message: "documentNo required" });
    const items = await AuditLog.find(withCompany(req, { documentNo }))
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json({ items, documentNo, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
