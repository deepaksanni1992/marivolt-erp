import express from "express";
import Shipment from "../models/Shipment.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function nextRefNo(prefix = "SHP") {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const ts = `${yy}${mm}${dd}-${now.getHours().toString().padStart(2, "0")}${now
    .getMinutes()
    .toString()
    .padStart(2, "0")}${now.getSeconds().toString().padStart(2, "0")}`;
  return `${prefix}-${ts}`;
}

function toDto(doc) {
  const obj = doc.toObject({ virtuals: false });
  const freightCost = Number(obj.freightCost) || 0;
  const insuranceCost = Number(obj.insuranceCost) || 0;
  const dutyCost = Number(obj.dutyCost) || 0;
  const otherCharges = Number(obj.otherCharges) || 0;
  return {
    ...obj,
    totalCost: freightCost + insuranceCost + dutyCost + otherCharges,
  };
}

// GET /api/logistics/shipments
router.get("/shipments", async (req, res) => {
  try {
    const shipments = await Shipment.find().sort({ createdAt: -1 });
    res.json(shipments.map(toDto));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/logistics/shipments
router.post("/shipments", async (req, res) => {
  try {
    const body = req.body || {};
    const direction = body.direction || "EXPORT";
    const mode = body.mode || "SEA";
    if (!body.customerName && !body.supplierName) {
      return res
        .status(400)
        .json({ message: "Customer or Supplier name is required" });
    }
    const refNo = body.refNo || nextRefNo();
    const created = await Shipment.create({
      ...body,
      refNo,
      direction,
      mode,
    });
    res.status(201).json(toDto(created));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/logistics/shipments/:id
router.put("/shipments/:id", async (req, res) => {
  try {
    const updated = await Shipment.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) {
      return res.status(404).json({ message: "Shipment not found" });
    }
    res.json(toDto(updated));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/logistics/shipments/:id
router.delete("/shipments/:id", async (req, res) => {
  try {
    const deleted = await Shipment.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Shipment not found" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;

