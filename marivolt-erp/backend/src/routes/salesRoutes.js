import express from "express";
import Customer from "../models/Customer.js";
import SalesDoc from "../models/SalesDoc.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function getDocNo(prefix) {
  return `${prefix}-${Date.now()}`;
}

function calcTotals(items) {
  const subTotal = items.reduce((sum, it) => sum + (Number(it.total) || 0), 0);
  return { subTotal, grandTotal: subTotal };
}

function normalizeItems(items) {
  return items.map((it) => {
    const qty = Number(it.qty) || 0;
    const unitPrice = Number(it.unitPrice) || 0;
    return {
      sku: String(it.sku || "").trim(),
      description: String(it.description || "").trim(),
      spn: String(it.spn || "").trim(),
      uom: String(it.uom || "").trim(),
      qty,
      unitPrice,
      total: qty * unitPrice,
      unitWeight: Number(it.unitWeight) || 0,
      oeRemarks: String(it.oeRemarks || "").trim(),
      availability: String(it.availability || "").trim(),
      materialCode: String(it.materialCode || "").trim(),
    };
  });
}

/* CUSTOMER MASTER */
router.post("/customers", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    const customer = await Customer.create({
      name: String(body.name).trim(),
      contactName: body.contactName || "",
      phone: body.phone || "",
      email: body.email || "",
      address: body.address || "",
      paymentTerms: body.paymentTerms || "CREDIT",
      notes: body.notes || "",
    });
    res.json(customer);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/customers", async (req, res) => {
  const customers = await Customer.find().sort({ createdAt: -1 });
  res.json(customers);
});

router.delete("/customers/:id", async (req, res) => {
  try {
    await Customer.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* SALES DOC LIST */
router.get("/docs", async (req, res) => {
  const { type } = req.query;
  const filter = type ? { type } : {};
  const docs = await SalesDoc.find(filter).sort({ createdAt: -1 });
  res.json(docs);
});

/* CREATE QUOTATION */
router.post("/quotation", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!body.customerName || !String(body.customerName).trim()) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    if (!items.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }
    const normalized = normalizeItems(items);
    const totals = calcTotals(normalized);
    const status =
      body.status === "FINAL" || body.status === "DRAFT"
        ? body.status
        : "DRAFT";
    const doc = await SalesDoc.create({
      type: "QUOTATION",
      docNo: getDocNo("QTN"),
      status,
      customerId: body.customerId || undefined,
      customerName: String(body.customerName).trim(),
      paymentTerms: body.paymentTerms || "CREDIT",
      items: normalized,
      notes: body.notes || "",
      ...totals,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* UPDATE QUOTATION STATUS (DRAFT / FINAL) */
router.put("/docs/:id", async (req, res) => {
  try {
    const doc = await SalesDoc.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Doc not found" });
    if (doc.type !== "QUOTATION") {
      return res.status(400).json({ message: "Only quotation status can be updated" });
    }
    const { status } = req.body || {};
    if (status !== "DRAFT" && status !== "FINAL") {
      return res.status(400).json({ message: "Status must be DRAFT or FINAL" });
    }
    doc.status = status;
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* CONVERT DOC */
router.post("/convert/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { targetType } = req.body || {};
    const doc = await SalesDoc.findById(id);
    if (!doc) return res.status(404).json({ message: "Doc not found" });

    const paymentTerms = doc.paymentTerms || "CREDIT";
    const allowed =
      (doc.type === "QUOTATION" && targetType === "ORDER_CONFIRMATION") ||
      (doc.type === "ORDER_CONFIRMATION" &&
        targetType === "PROFORMA_INVOICE" &&
        paymentTerms === "ADVANCE") ||
      (doc.type === "ORDER_CONFIRMATION" &&
        targetType === "PTG" &&
        paymentTerms === "CREDIT") ||
      (doc.type === "PROFORMA_INVOICE" && targetType === "PTG") ||
      (doc.type === "PTG" && targetType === "INVOICE" && doc.status === "COMPLETED") ||
      (doc.type === "INVOICE" && targetType === "CIPL");

    if (!allowed) {
      return res.status(400).json({ message: "Conversion not allowed" });
    }

    // If a quotation is converted to Order Confirmation, mark it as converted
    if (doc.type === "QUOTATION" && targetType === "ORDER_CONFIRMATION") {
      doc.status = "CONVERTED";
      await doc.save();
    }

    const prefixMap = {
      ORDER_CONFIRMATION: "OC",
      PROFORMA_INVOICE: "PI",
      PTG: "PTG",
      INVOICE: "INV",
      CIPL: "CIPL",
    };
    const next = await SalesDoc.create({
      type: targetType,
      docNo: getDocNo(prefixMap[targetType] || "DOC"),
      status: "OPEN",
      refDocId: doc._id,
      customerId: doc.customerId,
      customerName: doc.customerName,
      paymentTerms,
      items: doc.items,
      notes: doc.notes,
      subTotal: doc.subTotal,
      grandTotal: doc.grandTotal,
      packing:
        targetType === "PTG"
          ? { dimensions: "", weight: "", notes: "", packedItems: [] }
          : doc.packing,
    });
    res.json(next);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* UPDATE PTG */
router.put("/ptg/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const doc = await SalesDoc.findById(id);
    if (!doc) return res.status(404).json({ message: "PTG not found" });
    if (doc.type !== "PTG") {
      return res.status(400).json({ message: "Not a PTG document" });
    }
    const packedItems = Array.isArray(body.packedItems)
      ? body.packedItems.map((it) => ({
          sku: String(it.sku || "").trim(),
          qty: Number(it.qty) || 0,
        }))
      : [];
    const updated = await SalesDoc.findByIdAndUpdate(
      id,
      {
        packing: {
          dimensions: body.dimensions || "",
          weight: body.weight || "",
          notes: body.notes || "",
          packedItems,
        },
        status: "COMPLETED",
      },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
