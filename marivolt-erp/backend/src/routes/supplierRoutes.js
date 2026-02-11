import express from "express";
import Supplier from "../models/Supplier.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Create supplier (admin only)
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const { name, contactName, phone, email, address, gstNo, panNo, notes } =
      req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Supplier name is required" });
    }

    const supplier = await Supplier.create({
      name: String(name).trim(),
      contactName: (contactName || "").trim(),
      phone: (phone || "").trim(),
      email: (email || "").trim(),
      address: (address || "").trim(),
      gstNo: (gstNo || "").trim(),
      panNo: (panNo || "").trim(),
      notes: (notes || "").trim(),
    });

    return res.status(201).json(supplier);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// List suppliers
router.get("/", async (req, res) => {
  try {
    const suppliers = await Supplier.find().sort({ createdAt: -1 });
    return res.json(suppliers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// Delete supplier (admin only)
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const deleted = await Supplier.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;
