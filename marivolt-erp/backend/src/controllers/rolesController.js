/**
 * Roles + Permissions Controller — Phase-10.
 *
 * Endpoints for managing custom Role documents and viewing the
 * resolved permission matrix for the current user.
 */
import Role, {
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  SYSTEM_ROLE_CODES,
} from "../models/Role.js";
import {
  ROLE_DEFAULTS,
  resolvePermissions,
} from "../services/roleService.js";
import { writeAudit } from "../services/auditService.js";

export async function listRoles(req, res) {
  try {
    const filter = { $or: [{ isSystem: true }, { companyId: req.companyId }] };
    if (req.query.activeOnly === "true") filter.isActive = true;
    const items = await Role.find(filter).sort({ isSystem: -1, code: 1 }).lean();
    res.json({
      items,
      modules: PERMISSION_MODULES,
      actions: PERMISSION_ACTIONS,
      systemRoles: SYSTEM_ROLE_CODES,
      defaults: ROLE_DEFAULTS,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getRole(req, res) {
  try {
    const doc = await Role.findOne({
      _id: req.params.id,
      $or: [{ isSystem: true }, { companyId: req.companyId }],
    }).lean();
    if (!doc) return res.status(404).json({ message: "Role not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createRole(req, res) {
  try {
    const payload = sanitisePayload(req.body || {});
    if (!payload.code || !payload.name) {
      return res.status(400).json({ message: "code and name are required" });
    }
    payload.code = payload.code.toUpperCase();
    payload.companyId = req.companyId;
    payload.isSystem = false;
    const exists = await Role.findOne({
      companyId: req.companyId,
      code: payload.code,
    }).lean();
    if (exists) {
      return res.status(409).json({ message: "Role code already exists" });
    }
    const doc = await Role.create(payload);
    await writeAudit(req, {
      action: "CREATE",
      module: "SETTINGS",
      entityType: "ROLE",
      entityId: doc._id,
      documentNo: doc.code,
      description: `Role ${doc.code} created`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateRole(req, res) {
  try {
    const filter = {
      _id: req.params.id,
      $or: [{ isSystem: false, companyId: req.companyId }],
    };
    const before = await Role.findOne(filter).lean();
    if (!before) {
      return res
        .status(404)
        .json({ message: "Role not found or system role cannot be edited" });
    }
    const payload = sanitisePayload(req.body || {});
    if (payload.code) payload.code = payload.code.toUpperCase();
    delete payload.isSystem;
    const doc = await Role.findOneAndUpdate(filter, payload, { new: true });
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: "ROLE",
      entityId: doc._id,
      documentNo: doc.code,
      description: `Role ${doc.code} updated`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteRole(req, res) {
  try {
    const filter = { _id: req.params.id, isSystem: false, companyId: req.companyId };
    const doc = await Role.findOne(filter);
    if (!doc) {
      return res
        .status(404)
        .json({ message: "Role not found or cannot be deleted" });
    }
    await Role.deleteOne({ _id: doc._id });
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: "ROLE",
      entityId: doc._id,
      documentNo: doc.code,
      description: `Role ${doc.code} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getMyPermissions(req, res) {
  try {
    const matrix = await resolvePermissions(req);
    res.json({
      modules: PERMISSION_MODULES,
      actions: PERMISSION_ACTIONS,
      matrix,
      role: req.user?.role || "",
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

function sanitisePayload(body) {
  const allowed = ["code", "name", "description", "permissions", "isActive"];
  const out = {};
  for (const key of allowed) {
    if (key in body) out[key] = body[key];
  }
  if (Array.isArray(out.permissions)) {
    out.permissions = out.permissions
      .filter((p) => p?.module)
      .map((p) => ({
        module: String(p.module).toUpperCase(),
        actions: Array.isArray(p.actions)
          ? p.actions
              .map((a) => String(a).toLowerCase())
              .filter((a) => PERMISSION_ACTIONS.includes(a))
          : [],
      }));
  }
  return out;
}
