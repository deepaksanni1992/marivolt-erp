import express from "express";
import StockTxn from "../models/StockTxn.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Create a txn (IN/OUT)
router.post("/", async (req, res) => {
    try {
      const { sku, type, qty, ref, note } = req.body;
  
      if (!sku || !type || !qty) {
        return res.status(400).json({ message: "sku, type, qty are required" });
      }
  
      const cleanSku = String(sku).trim();
      const cleanType = type;
      const cleanQty = Number(qty);
  
      if (!["IN", "OUT"].includes(cleanType)) {
        return res.status(400).json({ message: "type must be IN or OUT" });
      }
      if (!cleanQty || cleanQty <= 0) {
        return res.status(400).json({ message: "qty must be > 0" });
      }
  
      // ✅ SERVER SIDE STOCK CHECK (important)
      if (cleanType === "OUT") {
        const summary = await StockTxn.aggregate([
          { $match: { sku: cleanSku } },
          {
            $group: {
              _id: "$sku",
              stock: {
                $sum: {
                  $cond: [
                    { $eq: ["$type", "IN"] },
                    "$qty",
                    { $multiply: ["$qty", -1] },
                  ],
                },
              },
            },
          },
        ]);
  
        const currentStock = summary.length ? summary[0].stock : 0;
  
        if (currentStock - cleanQty < 0) {
          return res.status(400).json({
            message: `Not enough stock for ${cleanSku}. Current: ${currentStock}`,
          });
        }
      }
  
      const txn = await StockTxn.create({
        sku: cleanSku,
        type: cleanType,
        qty: cleanQty,
        ref: (ref || "").trim(),
        note: (note || "").trim(),
      });
  
      res.json(txn);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });
  

// Get txns (latest first). Optional filter by sku
router.get("/", async (req, res) => {
  const { sku } = req.query;
  const filter = sku ? { sku: String(sku).trim() } : {};
  const txns = await StockTxn.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json(txns);
});

// Inventory summary (stock per sku)
router.get("/summary", async (req, res) => {
  const summary = await StockTxn.aggregate([
    {
      $group: {
        _id: "$sku",
        stock: {
          $sum: {
            $cond: [{ $eq: ["$type", "IN"] }, "$qty", { $multiply: ["$qty", -1] }],
          },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // output: [{ sku, stock }]
  res.json(summary.map((x) => ({ sku: x._id, stock: x.stock })));
});

export default router;
