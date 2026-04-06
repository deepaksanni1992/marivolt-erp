import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listSuppliers(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {};
    if (req.query.search) {
      const s = String(req.query.search).trim();
      filter.$or = [
        { name: new RegExp(s, "i") },
        { supplierCode: new RegExp(s, "i") },
        { email: new RegExp(s, "i") },
      ];
    }
    const [items, total] = await Promise.all([
      Supplier.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Supplier.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listSuppliersAll(req, res) {
  try {
    const items = await Supplier.find({})
      .sort({ name: 1 })
      .select("supplierCode name contactName phone email address gstNo panNo")
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
    const row = await Supplier.findById(id).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function nextSupplierCode() {
  const n = await Supplier.countDocuments({});
  return `SUP-${String(n + 1).padStart(4, "0")}`;
}

export async function createSupplier(req, res) {
  try {
    const body = { ...req.body };
    if (body.supplierCode) {
      body.supplierCode = String(body.supplierCode).trim().toUpperCase();
    } else {
      body.supplierCode = await nextSupplierCode();
    }
    const doc = await Supplier.create(body);
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
    const payload = { ...req.body };
    delete payload._id;
    if (payload.supplierCode) {
      payload.supplierCode = String(payload.supplierCode).trim().toUpperCase();
    }
    const doc = await Supplier.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ message: "Not found" });
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
    const row = await Supplier.findByIdAndDelete(id);
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
    let codeSeq = await Supplier.countDocuments({});
    for (let i = 0; i < suppliers.length; i++) {
      const row = suppliers[i];
      try {
        const name = String(row.name || "").trim();
        if (!name) throw new Error("name required");
        let supplierCode = String(row.supplierCode || "").trim().toUpperCase();
        if (!supplierCode) {
          codeSeq += 1;
          supplierCode = `SUP-${String(codeSeq).padStart(4, "0")}`;
        }
        await Supplier.findOneAndUpdate(
          { name },
          {
            $set: {
              supplierCode,
              name,
              contactName: row.contactName ?? "",
              phone: row.phone ?? "",
              email: row.email ?? "",
              address: row.address ?? "",
              gstNo: row.gstNo ?? "",
              panNo: row.panNo ?? "",
              notes: row.notes ?? "",
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
