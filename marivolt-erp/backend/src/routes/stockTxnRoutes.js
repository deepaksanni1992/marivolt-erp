import express from "express";
import StockTxn from "../models/StockTxn.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Create a txn (IN/OUT). Use either sku or article (for BOM Kitting/De-Kitting).
router.post("/", async (req, res) => {
    try {
  const { sku, article, type, qty, ref, note, supplier } = req.body;
  
      const cleanSku = String(sku ?? "").trim();
      const cleanArticle = String(article ?? "").trim();
      if ((!cleanSku && !cleanArticle) || !type || !qty) {
        return res.status(400).json({ message: "either sku or article, type, and qty are required" });
      }
  
      const cleanType = type;
      const cleanQty = Number(qty);
  
      if (!["IN", "OUT"].includes(cleanType)) {
        return res.status(400).json({ message: "type must be IN or OUT" });
      }
      if (!cleanQty || cleanQty <= 0) {
        return res.status(400).json({ message: "qty must be > 0" });
      }

      const matchBy = cleanArticle ? { article: cleanArticle } : { sku: cleanSku };
  
      // ✅ SERVER SIDE STOCK CHECK (important)
      if (cleanType === "OUT") {
        const summary = await StockTxn.aggregate([
          { $match: matchBy },
          {
            $group: {
              _id: null,
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
        const label = cleanArticle || cleanSku;
        if (currentStock - cleanQty < 0) {
          return res.status(400).json({
            message: `Not enough stock for ${label}. Current: ${currentStock}`,
          });
        }
      }
  
      const txn = await StockTxn.create({
        sku: cleanSku,
        article: cleanArticle,
        type: cleanType,
        qty: cleanQty,
        ref: (ref || "").trim(),
        supplier: (supplier || "").trim(),
        note: (note || "").trim(),
      });
  
      res.json(txn);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });
  

// Get txns (latest first). Optional filter by sku or article
router.get("/", async (req, res) => {
  const { sku, article, type, from, to, supplier } = req.query;
  const filter = {};

  if (sku) filter.sku = String(sku).trim();
  if (article) filter.article = String(article).trim();

  if (type) {
    const cleanType = String(type).toUpperCase().trim();
    if (["IN", "OUT"].includes(cleanType)) {
      filter.type = cleanType;
    }
  }

  if (supplier) {
    filter.supplier = String(supplier).trim();
  }

  if (from || to) {
    filter.createdAt = {};
    if (from) {
      const fromDate = new Date(from);
      if (!Number.isNaN(fromDate.getTime())) {
        filter.createdAt.$gte = fromDate;
      }
    }
    if (to) {
      const toDate = new Date(to);
      if (!Number.isNaN(toDate.getTime())) {
        filter.createdAt.$lte = toDate;
      }
    }
    if (Object.keys(filter.createdAt).length === 0) {
      delete filter.createdAt;
    }
  }

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
