/**
 * Settings + Number Series Controller — Phase-10.
 *
 * Generic key/value settings store and CRUD endpoints for the
 * configurable number-series engine.
 */
import Setting from "../models/Setting.js";
import NumberSeriesConfig, {
  NUMBER_SERIES_RESET_CYCLES,
} from "../models/NumberSeriesConfig.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, extra = {}) {
  return { ...extra, companyId: req.companyId };
}

/* ----------------------------------------------------------------- */
/* Generic settings                                                   */
/* ----------------------------------------------------------------- */

export async function listSettings(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.namespace) filter.namespace = String(req.query.namespace).toUpperCase();
    if (req.query.branchId) filter.branchId = req.query.branchId;
    const items = await Setting.find(filter).sort({ namespace: 1, key: 1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function upsertSetting(req, res) {
  try {
    const namespace = String(req.body?.namespace || "").toUpperCase();
    const key = String(req.body?.key || "").trim();
    const value = req.body?.value ?? null;
    const branchId = req.body?.branchId || null;
    const description = req.body?.description ?? "";
    if (!namespace || !key) {
      return res.status(400).json({ message: "namespace and key are required" });
    }
    const filter = { companyId: req.companyId, branchId, namespace, key };
    const doc = await Setting.findOneAndUpdate(
      filter,
      {
        $set: { value, description, updatedBy: req.user?.email || "" },
        $setOnInsert: { ...filter },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: namespace,
      entityId: doc._id,
      documentNo: key,
      description: `${namespace}.${key} updated`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteSetting(req, res) {
  try {
    const doc = await Setting.findOneAndDelete(
      withCompany(req, { _id: req.params.id })
    );
    if (!doc) return res.status(404).json({ message: "Setting not found" });
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: doc.namespace,
      entityId: doc._id,
      documentNo: doc.key,
      description: `${doc.namespace}.${doc.key} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/* ----------------------------------------------------------------- */
/* Number series                                                      */
/* ----------------------------------------------------------------- */

export async function listNumberSeries(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.docKey) filter.docKey = String(req.query.docKey).toUpperCase();
    if (req.query.branchId) filter.branchId = req.query.branchId;
    const items = await NumberSeriesConfig.find(filter).sort({ docKey: 1 }).lean();
    res.json({ items, resetCycles: NUMBER_SERIES_RESET_CYCLES });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function upsertNumberSeries(req, res) {
  try {
    const docKey = String(req.body?.docKey || "").toUpperCase();
    const branchId = req.body?.branchId || null;
    if (!docKey) {
      return res.status(400).json({ message: "docKey is required" });
    }
    const allowed = [
      "description",
      "prefix",
      "suffix",
      "format",
      "padding",
      "startSeq",
      "resetCycle",
      "isActive",
      "notes",
    ];
    const $set = {};
    for (const key of allowed) {
      if (key in (req.body || {})) $set[key] = req.body[key];
    }
    const filter = { companyId: req.companyId, branchId, docKey };
    const doc = await NumberSeriesConfig.findOneAndUpdate(
      filter,
      { $set, $setOnInsert: { ...filter } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await writeAudit(req, {
      action: "UPDATE",
      module: "SETTINGS",
      entityType: "NUMBER_SERIES",
      entityId: doc._id,
      documentNo: docKey,
      description: `Number series ${docKey} updated`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteNumberSeries(req, res) {
  try {
    const doc = await NumberSeriesConfig.findOneAndDelete(
      withCompany(req, { _id: req.params.id })
    );
    if (!doc) return res.status(404).json({ message: "Number series not found" });
    await writeAudit(req, {
      action: "DELETE",
      module: "SETTINGS",
      entityType: "NUMBER_SERIES",
      entityId: doc._id,
      documentNo: doc.docKey,
      description: `Number series ${doc.docKey} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
