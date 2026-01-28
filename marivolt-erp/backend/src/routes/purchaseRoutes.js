import express from "express";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import StockTxn from "../models/StockTxn.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

/* CREATE PO */
router.post("/po", async (req, res) => {
  try {
    const po = await PurchaseOrder.create(req.body);
    res.json(po);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* GET ALL PO */
router.get("/po", async (req, res) => {
  const pos = await PurchaseOrder.find().sort({ createdAt: -1 });
  res.json(pos);
});

/* CREATE GRN + AUTO STOCK IN */
router.post("/grn", async (req, res) => {
  try {
    const grn = await GRN.create(req.body);

    // ✅ Create stock transactions
    const txns = [];
    for (const it of grn.items) {
      txns.push({
        sku: it.sku,
        type: "IN",
        qty: it.qty,
        ref: `GRN:${grn.grnNo}`,
        note: `PO:${grn.poNo}`,
      });
    }

    if (txns.length) {
      await StockTxn.insertMany(txns);
    }

    // Update PO status
    if (grn.poNo) {
      await PurchaseOrder.updateOne(
        { poNo: grn.poNo },
        { status: "CLOSED" }
      );
    }

    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* GET ALL GRN */
router.get("/grn", async (req, res) => {
  const grns = await GRN.find().sort({ createdAt: -1 });
  res.json(grns);
});

export default router;
