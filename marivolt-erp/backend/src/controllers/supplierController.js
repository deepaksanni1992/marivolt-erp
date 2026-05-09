import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";
import { writeAudit } from "../services/auditService.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function listSuppliers(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = withCompany(req);
    if (req.query.search) {
      const s = String(req.query.search).trim();
      filter.$or = [
        { supplierName: new RegExp(s, "i") },
        { name: new RegExp(s, "i") },
        { supplierCode: new RegExp(s, "i") },
        { email: new RegExp(s, "i") },
      ];
    }
    if (req.query.activeStatus === "1") filter.activeStatus = true;
    if (req.query.activeStatus === "0") filter.activeStatus = false;
    const [itemsRaw, total] = await Promise.all([
      Supplier.find(filter).sort({ supplierName: 1, name: 1 }).skip(skip).limit(limit).lean(),
      Supplier.countDocuments(filter),
    ]);
    const items = itemsRaw.map((x) => ({
      ...x,
      supplierName: x.supplierName || x.name || "",
      shortName: x.shortName || "",
      contactPerson: x.contactPerson || x.contactName || "",
      remarks: x.remarks || x.notes || "",
      activeStatus: x.activeStatus !== false,
    }));
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listSuppliersAll(req, res) {
  try {
    const items = await Supplier.find(withCompany(req))
      .sort({ supplierName: 1, name: 1 })
      .select("supplierCode supplierName shortName supplierType contactPerson contactName phone email address vatNo registrationNo paymentTerms currency activeStatus")
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSupplier(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Supplier.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function nextSupplierCode(req) {
  return nextSequentialNumber(Supplier, "supplierCode", `${req.companyCode || "CMP"}-SUP`, {
    companyId: req.companyId,
    docKey: "SUPPLIER",
  });
}

function normalizeSupplierPayload(payload = {}) {
  const supplierName = String(payload.supplierName || payload.name || "").trim();
  const contactPerson = String(payload.contactPerson || payload.contactName || "").trim();
  const remarks = String(payload.remarks || payload.notes || "").trim();
  return {
    supplierName,
    name: supplierName,
    shortName: String(payload.shortName || "").trim(),
    supplierType: String(payload.supplierType || "LOCAL").trim().toUpperCase(),
    country: String(payload.country || "").trim(),
    address: String(payload.address || "").trim(),
    vatNo: String(payload.vatNo ?? payload.gstNo ?? "").trim(),
    registrationNo: String(payload.registrationNo ?? payload.tradeLicenseNo ?? payload.panNo ?? "").trim(),
    tradeLicenseNo: String(payload.tradeLicenseNo ?? payload.registrationNo ?? "").trim(),
    gstNo: String(payload.gstNo ?? payload.vatNo ?? "").trim(),
    panNo: String(payload.panNo ?? payload.registrationNo ?? "").trim(),
    contactPerson,
    contactName: contactPerson,
    phone: String(payload.phone || "").trim(),
    email: String(payload.email || "").trim(),
    paymentTerms: String(payload.paymentTerms || "").trim(),
    currency: String(payload.currency || "USD").trim().toUpperCase(),
    bankDetails: Array.isArray(payload.bankDetails) ? payload.bankDetails : [],
    remarks,
    notes: remarks,
    activeStatus: payload.activeStatus !== false,
  };
}

export async function createSupplier(req, res) {
  try {
    const body = normalizeSupplierPayload(req.body || {});
    if (!body.supplierName) {
      return res.status(400).json({ message: "supplierName is required" });
    }
    if (body.supplierCode) {
      body.supplierCode = String(body.supplierCode).trim().toUpperCase();
    } else {
      body.supplierCode = await nextSupplierCode(req);
    }
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    const doc = await Supplier.create(body);
    await writeAudit(req, {
      action: "CREATE",
      module: "PURCHASE",
      entityType: "SUPPLIER",
      entityId: doc._id,
      documentNo: doc.supplierCode,
      description: `Supplier ${doc.supplierCode} created`,
      metadata: { supplierName: doc.supplierName },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateSupplier(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const payload = normalizeSupplierPayload(req.body || {});
    delete payload._id;
    const before = await Supplier.findOne(withCompany(req, { _id: id })).lean();
    if (!before) return res.status(404).json({ message: "Not found" });
    if (payload.supplierCode) {
      payload.supplierCode = String(payload.supplierCode).trim().toUpperCase();
    } else {
      payload.supplierCode = before.supplierCode;
    }
    const doc = await Supplier.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ message: "Not found" });
    await writeAudit(req, {
      action: "UPDATE",
      module: "PURCHASE",
      entityType: "SUPPLIER",
      entityId: doc._id,
      documentNo: doc.supplierCode,
      description: `Supplier ${doc.supplierCode} updated`,
      beforeData: {
        supplierName: before.supplierName || before.name || "",
        activeStatus: before.activeStatus !== false,
      },
      afterData: {
        supplierName: doc.supplierName || doc.name || "",
        activeStatus: doc.activeStatus !== false,
      },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteSupplier(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Supplier.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function importSuppliers(req, res) {
  try {
    const { suppliers } = req.body;
    if (!Array.isArray(suppliers) || suppliers.length === 0) {
      return res.status(400).json({ message: "suppliers array required" });
    }
    if (suppliers.length > 500) {
      return res.status(400).json({ message: "Maximum 500 rows" });
    }
    let upserted = 0;
    const errors = [];
    let codeSeq = await Supplier.countDocuments(withCompany(req));
    for (let i = 0; i < suppliers.length; i++) {
      const row = suppliers[i];
      try {
        const supplierName = String(row.supplierName || row.name || "").trim();
        if (!supplierName) throw new Error("supplierName required");
        let supplierCode = String(row.supplierCode || "").trim().toUpperCase();
        if (!supplierCode) {
          codeSeq += 1;
          supplierCode = `SUP-${String(codeSeq).padStart(4, "0")}`;
        }
        const normalized = normalizeSupplierPayload({ ...row, supplierName });
        await Supplier.findOneAndUpdate(
          withCompany(req, { supplierName }),
          {
            $set: {
              supplierCode,
              companyId: req.companyId,
              ...normalized,
            },
          },
          { upsert: true, new: true, runValidators: true }
        );
        upserted += 1;
      } catch (e) {
        errors.push({ index: i, message: e.message });
      }
    }
    res.json({ upserted, errors, errorCount: errors.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
