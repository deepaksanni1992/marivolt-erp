/**
 * Master Data Controller — Phase-10.
 *
 * CRUD endpoints for Company / Branch / Warehouse + lookups used by
 * the Settings UI. Mounted under `/api/admin/*` and protected by
 * `requireErpAccess` + `requirePermission("SETTINGS", action)`.
 */
import Company from "../models/Company.js";
import Branch from "../models/Branch.js";
import Warehouse from "../models/Warehouse.js";
import User from "../models/User.js";
import { writeAudit } from "../services/auditService.js";
import { isAdminRole, isSuperAdminRole } from "../utils/authAdminPolicy.js";

function withCompany(req, extra = {}) {
  return { ...extra, companyId: req.companyId };
}

async function resolveActorAllowedCompanyIds(req) {
  const user = await User.findById(req.user?.id).select("role allowedCompanies").lean();
  if (!user) return { user: null, allowedIds: [] };
  return {
    user,
    allowedIds: (user.allowedCompanies || []).map((x) => String(x)),
  };
}

function assertCompanyMembership(allowedIds, companyId, actorRole) {
  if (isSuperAdminRole(actorRole)) return true;
  return allowedIds.includes(String(companyId));
}

/* ----------------------------------------------------------------- */
/* Company                                                            */
/* ----------------------------------------------------------------- */

/**
 * S0 — List companies:
 * - super_admin: all companies
 * - company_admin / admin: membership only (not global directory)
 * - ordinary users: membership only (UI company switch / read)
 */
export async function listCompanies(req, res) {
  try {
    const { user, allowedIds } = await resolveActorAllowedCompanyIds(req);
    if (!user) return res.status(401).json({ message: "User not found" });

    const filter = {};
    if (req.query.activeOnly === "true") filter.isActive = true;
    if (!isSuperAdminRole(user.role)) {
      if (!allowedIds.length) return res.json({ items: [] });
      filter._id = { $in: allowedIds };
    }

    const items = await Company.find(filter).sort({ name: 1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getCompany(req, res) {
  try {
    const { user, allowedIds } = await resolveActorAllowedCompanyIds(req);
    if (!user) return res.status(401).json({ message: "User not found" });
    if (!assertCompanyMembership(allowedIds, req.params.id, user.role)) {
      return res.status(403).json({ message: "Forbidden", code: "COMPANY_ACCESS_DENIED" });
    }
    const doc = await Company.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "Company not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createCompany(req, res) {
  try {
    if (!isSuperAdminRole(req.user?.role)) {
      return res.status(403).json({ message: "Forbidden", code: "SUPER_ADMIN_REQUIRED" });
    }
    const payload = sanitiseCompanyPayload(req.body || {});
    if (!payload.name || !payload.code) {
      return res.status(400).json({ message: "Company name and code are required" });
    }
    const exists = await Company.findOne({
      $or: [{ code: payload.code.toUpperCase() }, { name: payload.name }],
    }).lean();
    if (exists) {
      return res.status(409).json({ message: "Company code or name already exists" });
    }
    const doc = await Company.create({ ...payload, code: payload.code.toUpperCase() });
    await writeAudit(req, {
      action: "CREATE",
      module: "SETTINGS",
      entityType: "COMPANY",
      entityId: doc._id,
      documentNo: doc.code,
      description: `Company ${doc.code} created`,
      metadata: { name: doc.name },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateCompany(req, res) {
  try {
    if (!isAdminRole(req.user?.role)) {
      return res.status(403).json({ message: "Forbidden", code: "ADMIN_REQUIRED" });
    }
    const { user, allowedIds } = await resolveActorAllowedCompanyIds(req);
    if (!user) return res.status(401).json({ message: "User not found" });
    if (!assertCompanyMembership(allowedIds, req.params.id, user.role)) {
      return res.status(403).json({
        message: "Cannot update a company outside your permitted companies",
        code: "COMPANY_UPDATE_FORBIDDEN",
      });
    }

    const before = await Company.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ message: "Company not found" });

    // Reject protected / system identity fields if present in body.
    const prohibited = ["_id", "id", "createdAt", "updatedAt", "__v"].filter((k) => k in (req.body || {}));
    if (prohibited.length) {
      return res.status(400).json({
        message: `Protected fields are not allowed: ${prohibited.join(", ")}`,
        code: "PROTECTED_FIELD_REJECTED",
      });
    }

    const payload = sanitiseCompanyPayload(req.body || {});
    // Non-super admins cannot rename company code (identity).
    if (!isSuperAdminRole(user.role) && payload.code && payload.code.toUpperCase() !== String(before.code || "").toUpperCase()) {
      return res.status(403).json({
        message: "Only a super_admin may change company code",
        code: "COMPANY_CODE_CHANGE_FORBIDDEN",
      });
    }
    if (payload.code) payload.code = payload.code.toUpperCase();

    const doc = await Company.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true });
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: "COMPANY",
      entityId: doc._id,
      documentNo: doc.code,
      description: `Company ${doc.code} updated`,
      beforeData: pick(before, ["name", "code", "isActive", "country", "trnNo"]),
      afterData: pick(doc, ["name", "code", "isActive", "country", "trnNo"]),
      metadata: { updatedBy: req.user?.email || "" },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

function sanitiseCompanyPayload(body) {
  const allowed = [
    "name",
    "shortName",
    "code",
    "logoUrl",
    "address",
    "country",
    "email",
    "phone",
    "website",
    "trnNo",
    "registrationNo",
    "currency",
    "defaultCurrency",
    "timezone",
    "bankDetails",
    "isActive",
  ];
  const out = {};
  for (const key of allowed) {
    if (key in body) out[key] = body[key];
  }
  if (Array.isArray(out.bankDetails)) {
    out.bankDetails = out.bankDetails.map((b) => ({
      label: b?.label || "",
      accountName: b?.accountName || "",
      accountNo: b?.accountNo || "",
      iban: b?.iban || "",
      swift: b?.swift || "",
      bankName: b?.bankName || "",
      bankAddress: b?.bankAddress || "",
      branch: b?.branch || "",
      currency: String(b?.currency || "").toUpperCase(),
      isPrimary: !!b?.isPrimary,
    }));
  }
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

/* ----------------------------------------------------------------- */
/* Branch                                                             */
/* ----------------------------------------------------------------- */

export async function listBranches(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.activeOnly === "true") filter.isActive = true;
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).trim(), "i");
      filter.$or = [{ branchCode: re }, { branchName: re }];
    }
    const items = await Branch.find(filter)
      .populate({ path: "warehouses", select: "warehouseCode warehouseName isActive" })
      .sort({ branchName: 1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getBranch(req, res) {
  try {
    const doc = await Branch.findOne(withCompany(req, { _id: req.params.id })).lean();
    if (!doc) return res.status(404).json({ message: "Branch not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createBranch(req, res) {
  try {
    const payload = sanitiseBranchPayload(req.body || {});
    if (!payload.branchCode || !payload.branchName) {
      return res
        .status(400)
        .json({ message: "branchCode and branchName are required" });
    }
    payload.companyId = req.companyId;
    payload.branchCode = payload.branchCode.toUpperCase();
    const exists = await Branch.findOne({
      companyId: req.companyId,
      branchCode: payload.branchCode,
    }).lean();
    if (exists) {
      return res
        .status(409)
        .json({ message: "Branch code already exists for this company" });
    }
    const doc = await Branch.create(payload);
    await writeAudit(req, {
      action: "CREATE",
      module: "SETTINGS",
      entityType: "BRANCH",
      entityId: doc._id,
      documentNo: doc.branchCode,
      description: `Branch ${doc.branchCode} created`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateBranch(req, res) {
  try {
    const before = await Branch.findOne(withCompany(req, { _id: req.params.id })).lean();
    if (!before) return res.status(404).json({ message: "Branch not found" });
    const payload = sanitiseBranchPayload(req.body || {});
    if (payload.branchCode) payload.branchCode = payload.branchCode.toUpperCase();
    const doc = await Branch.findOneAndUpdate(
      withCompany(req, { _id: req.params.id }),
      payload,
      { new: true }
    );
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: "BRANCH",
      entityId: doc._id,
      documentNo: doc.branchCode,
      description: `Branch ${doc.branchCode} updated`,
      beforeData: pick(before, ["branchCode", "branchName", "isActive"]),
      afterData: pick(doc, ["branchCode", "branchName", "isActive"]),
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteBranch(req, res) {
  try {
    const doc = await Branch.findOne(withCompany(req, { _id: req.params.id }));
    if (!doc) return res.status(404).json({ message: "Branch not found" });
    const inUse = await Warehouse.exists({
      companyId: req.companyId,
      branchId: doc._id,
    });
    if (inUse) {
      return res.status(409).json({
        message: "Branch has linked warehouses. Reassign or deactivate them first.",
      });
    }
    await Branch.deleteOne(withCompany(req, { _id: doc._id }));
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: "BRANCH",
      entityId: doc._id,
      documentNo: doc.branchCode,
      description: `Branch ${doc.branchCode} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

function sanitiseBranchPayload(body) {
  const allowed = [
    "branchCode",
    "branchName",
    "address",
    "country",
    "phone",
    "email",
    "trnNo",
    "registrationNo",
    "warehouses",
    "isActive",
  ];
  const out = {};
  for (const key of allowed) {
    if (key in body) out[key] = body[key];
  }
  return out;
}

/* ----------------------------------------------------------------- */
/* Warehouse                                                          */
/* ----------------------------------------------------------------- */

export async function listWarehouses(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.activeOnly === "true") filter.isActive = true;
    if (req.query.branchId) filter.branchId = req.query.branchId;
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).trim(), "i");
      filter.$or = [{ warehouseCode: re }, { warehouseName: re }];
    }
    const items = await Warehouse.find(filter)
      .populate({ path: "branchId", select: "branchCode branchName" })
      .sort({ warehouseName: 1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getWarehouse(req, res) {
  try {
    const doc = await Warehouse.findOne(withCompany(req, { _id: req.params.id })).lean();
    if (!doc) return res.status(404).json({ message: "Warehouse not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createWarehouse(req, res) {
  try {
    const payload = sanitiseWarehousePayload(req.body || {});
    if (!payload.warehouseCode || !payload.warehouseName) {
      return res
        .status(400)
        .json({ message: "warehouseCode and warehouseName are required" });
    }
    payload.companyId = req.companyId;
    payload.warehouseCode = payload.warehouseCode.toUpperCase();
    const exists = await Warehouse.findOne({
      companyId: req.companyId,
      warehouseCode: payload.warehouseCode,
    }).lean();
    if (exists) {
      return res
        .status(409)
        .json({ message: "Warehouse code already exists for this company" });
    }
    if (payload.branchId) {
      const branch = await Branch.findOne({
        companyId: req.companyId,
        _id: payload.branchId,
      }).lean();
      if (!branch) {
        return res
          .status(400)
          .json({ message: "Linked branch does not belong to this company" });
      }
    }
    const doc = await Warehouse.create(payload);
    if (payload.branchId) {
      await Branch.updateOne(
        withCompany(req, { _id: payload.branchId }),
        { $addToSet: { warehouses: doc._id } }
      );
    }
    await writeAudit(req, {
      action: "CREATE",
      module: "SETTINGS",
      entityType: "WAREHOUSE",
      entityId: doc._id,
      documentNo: doc.warehouseCode,
      description: `Warehouse ${doc.warehouseCode} created`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateWarehouse(req, res) {
  try {
    const before = await Warehouse.findOne(
      withCompany(req, { _id: req.params.id })
    ).lean();
    if (!before) return res.status(404).json({ message: "Warehouse not found" });
    const payload = sanitiseWarehousePayload(req.body || {});
    if (payload.warehouseCode) payload.warehouseCode = payload.warehouseCode.toUpperCase();
    const doc = await Warehouse.findOneAndUpdate(
      withCompany(req, { _id: req.params.id }),
      payload,
      { new: true }
    );
    if (payload.branchId && String(payload.branchId) !== String(before.branchId || "")) {
      if (before.branchId) {
        await Branch.updateOne(
          withCompany(req, { _id: before.branchId }),
          { $pull: { warehouses: doc._id } }
        );
      }
      await Branch.updateOne(
        withCompany(req, { _id: payload.branchId }),
        { $addToSet: { warehouses: doc._id } }
      );
    }
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: "WAREHOUSE",
      entityId: doc._id,
      documentNo: doc.warehouseCode,
      description: `Warehouse ${doc.warehouseCode} updated`,
      beforeData: pick(before, ["warehouseCode", "warehouseName", "isActive", "branchId"]),
      afterData: pick(doc, ["warehouseCode", "warehouseName", "isActive", "branchId"]),
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteWarehouse(req, res) {
  try {
    const doc = await Warehouse.findOne(withCompany(req, { _id: req.params.id }));
    if (!doc) return res.status(404).json({ message: "Warehouse not found" });
    await Warehouse.deleteOne(withCompany(req, { _id: doc._id }));
    if (doc.branchId) {
      await Branch.updateOne(
        withCompany(req, { _id: doc.branchId }),
        { $pull: { warehouses: doc._id } }
      );
    }
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: "WAREHOUSE",
      entityId: doc._id,
      documentNo: doc.warehouseCode,
      description: `Warehouse ${doc.warehouseCode} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

function sanitiseWarehousePayload(body) {
  const allowed = [
    "warehouseCode",
    "warehouseName",
    "branchId",
    "defaultLocation",
    "address",
    "country",
    "warehouseType",
    "isActive",
  ];
  const out = {};
  for (const key of allowed) {
    if (key in body) out[key] = body[key];
  }
  if (out.branchId === "") out.branchId = null;
  return out;
}
