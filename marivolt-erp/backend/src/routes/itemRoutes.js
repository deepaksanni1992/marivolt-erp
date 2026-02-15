import express from "express";
import Item from "../models/Item.js";
import BOM from "../models/BOM.js";
import StockTxn from "../models/StockTxn.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import SalesDoc from "../models/SalesDoc.js";
import GRN from "../models/GRN.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

/** Returns true if this item is used in any transaction (PO, Quotation, BOM, Stock, GRN). Such items cannot be deleted. */
async function isItemUsedInTransaction(item) {
  if (!item) return false;
  const id = item._id;
  const sku = String(item.sku || "").trim();
  const article = String(item.article || "").trim();

  const [inBom, inStock, inPo, inSales, inGrn] = await Promise.all([
    BOM.exists({
      $or: [{ parentItemId: id }, { "lines.itemId": id }],
    }),
    (sku || article)
      ? StockTxn.exists({
          $or: [...(sku ? [{ sku }] : []), ...(article ? [{ article }] : [])],
        })
      : Promise.resolve(null),
    (article || sku)
      ? PurchaseOrder.exists({
          $or: [
            ...(article ? [{ "items.articleNo": article }] : []),
            ...(sku ? [{ "items.sku": sku }] : []),
          ],
        })
      : Promise.resolve(null),
    (sku || article)
      ? SalesDoc.exists({
          $or: [
            ...(sku ? [{ "items.sku": sku }] : []),
            ...(article ? [{ "items.sku": article }] : []),
            ...(sku ? [{ "packing.packedItems.sku": sku }] : []),
            ...(article ? [{ "packing.packedItems.sku": article }] : []),
          ],
        })
      : Promise.resolve(null),
    (sku || article)
      ? GRN.exists({
          $or: [...(sku ? [{ "items.sku": sku }] : []), ...(article ? [{ "items.sku": article }] : [])],
        })
      : Promise.resolve(null),
  ]);

  return !!(inBom || inStock || inPo || inSales || inGrn);
}

/**
 * CREATE item (ADMIN only)
 * POST /api/items
 */
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const item = await Item.create(req.body);
    return res.status(201).json(item);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * GET all items (any logged-in user)
 * GET /api/items
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const items = await Item.find().sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

/**
 * UPDATE item (ADMIN only)
 * PUT /api/items/:id
 */
router.put("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const updatedItem = await Item.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true } // ✅ return updated doc + validate schema
    );

    if (!updatedItem) {
      return res.status(404).json({ message: "Item not found" });
    }

    return res.json(updatedItem);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

/**
 * DELETE item (ADMIN only). Rejected if item is used in any transaction (PO, Quotation, BOM, Stock, GRN) — such articles are kept permanently.
 */
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    const used = await isItemUsedInTransaction(item);
    if (used) {
      return res.status(403).json({
        message:
          "Cannot delete: this Article is used in transactions (Purchase Order, Quotation, BOM, Stock, or GRN) and must be kept permanently. Only an Admin can modify its other parameters in Item Master.",
      });
    }

    await Item.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

export default router;