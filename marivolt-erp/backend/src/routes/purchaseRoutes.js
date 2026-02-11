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
    const body = req.body || {};

    if (!body.supplierName || !String(body.supplierName).trim()) {
      return res.status(400).json({ message: "Supplier name is required" });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    const poNo =
      body.poNo && String(body.poNo).trim()
        ? String(body.poNo).trim()
        : `PO-${Date.now()}`;

    let intRef = body.intRef && String(body.intRef).trim();
    if (!intRef) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dateKey = `${yy}${mm}${dd}`;

      const lastForDate = await PurchaseOrder.findOne({
        intRef: new RegExp(`^${dateKey}\\.`, "i"),
      }).sort({ intRef: -1 });

      let nextSeq = 1;
      if (lastForDate?.intRef) {
        const parts = String(lastForDate.intRef).split(".");
        const seq = Number(parts[1]);
        if (!Number.isNaN(seq)) nextSeq = seq + 1;
      }
      intRef = `${dateKey}.${String(nextSeq).padStart(2, "0")}`;
    }

    const po = await PurchaseOrder.create({
      ...body,
      poNo,
      intRef,
      supplierName: String(body.supplierName).trim(),
    });
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
