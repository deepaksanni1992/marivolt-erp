import express from "express";
import BOM from "../models/BOM.js";
import Item from "../models/Item.js";
import StockTxn from "../models/StockTxn.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Helper: get current stock by article (BOM Kitting/De-Kitting use article)
async function getStockByArticle(article) {
  const a = (article ?? "").trim();
  if (!a) return 0;
  const summary = await StockTxn.aggregate([
    { $match: { article: a } },
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
  return summary.length ? summary[0].stock : 0;
}

// List BOMs (optional ?parentItemId=)
router.get("/", async (req, res) => {
  try {
    const { parentItemId } = req.query;
    const filter = {};
    if (parentItemId) filter.parentItemId = parentItemId;
    const list = await BOM.find(filter)
      .populate("parentItemId", "article description spn name unitWeight vendor engine")
      .sort({ updatedAt: -1 })
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get one BOM
router.get("/:id", async (req, res) => {
  try {
    const bom = await BOM.findById(req.params.id)
      .populate("parentItemId", "article description spn name unitWeight")
      .populate("lines.itemId", "article description spn name unitWeight")
      .lean();
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    res.json(bom);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create BOM
router.post("/", async (req, res) => {
  try {
    const { parentItemId, name, lines } = req.body;
    if (!parentItemId || !Array.isArray(lines)) {
      return res.status(400).json({ message: "parentItemId and lines (array) required" });
    }
    const parent = await Item.findById(parentItemId);
    if (!parent) return res.status(404).json({ message: "Parent item not found" });

    const lineDocs = [];
    for (const line of lines) {
      if (!line.itemId || line.qty == null) continue;
      const item = await Item.findById(line.itemId);
      if (!item) continue;
      const q = Number(line.qty) || 0;
      const uwt = Number(item.unitWeight) || 0;
      lineDocs.push({
        itemId: item._id,
        article: item.article ?? "",
        description: item.description ?? "",
        spn: item.spn ?? "",
        name: item.name ?? "",
        unitWeight: uwt,
        qty: q,
      });
    }

    const parentUw = Number(parent.unitWeight) || 0;
    const bom = await BOM.create({
      parentItemId: parent._id,
      parentArticle: parent.article ?? "",
      parentDescription: parent.description ?? "",
      parentSpn: parent.spn ?? "",
      parentName: parent.name ?? "",
      parentUnitWeight: parentUw,
      name: (name || "").trim(),
      lines: lineDocs,
    });
    const populated = await BOM.findById(bom._id)
      .populate("parentItemId", "article description spn name unitWeight")
      .populate("lines.itemId", "article description spn name unitWeight")
      .lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update BOM
router.put("/:id", async (req, res) => {
  try {
    const { parentItemId, name, lines } = req.body;
    const bom = await BOM.findById(req.params.id);
    if (!bom) return res.status(404).json({ message: "BOM not found" });

    if (parentItemId) {
      const parent = await Item.findById(parentItemId);
      if (!parent) return res.status(404).json({ message: "Parent item not found" });
      bom.parentItemId = parent._id;
      bom.parentArticle = parent.article ?? "";
      bom.parentDescription = parent.description ?? "";
      bom.parentSpn = parent.spn ?? "";
      bom.parentName = parent.name ?? "";
      bom.parentUnitWeight = Number(parent.unitWeight) || 0;
    }
    if (name !== undefined) bom.name = (name || "").trim();
    if (Array.isArray(lines)) {
      const lineDocs = [];
      for (const line of lines) {
        if (!line.itemId || line.qty == null) continue;
        const item = await Item.findById(line.itemId);
        if (!item) continue;
        const q = Number(line.qty) || 0;
        const uwt = Number(item.unitWeight) || 0;
        lineDocs.push({
          itemId: item._id,
          article: item.article ?? "",
          description: item.description ?? "",
          spn: item.spn ?? "",
          name: item.name ?? "",
          unitWeight: uwt,
          qty: q,
        });
      }
      bom.lines = lineDocs;
    }
    await bom.save();
    const populated = await BOM.findById(bom._id)
      .populate("parentItemId", "article description spn name unitWeight")
      .populate("lines.itemId", "article description spn name unitWeight")
      .lean();
    res.json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete BOM
router.delete("/:id", async (req, res) => {
  try {
    const bom = await BOM.findByIdAndDelete(req.params.id);
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    res.json({ message: "BOM deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Kitting: consume components (OUT), add parent (IN). Uses article. Body: { qty }
router.post("/:id/kit", async (req, res) => {
  try {
    const qty = Number(req.body.qty);
    if (!qty || qty <= 0) {
      return res.status(400).json({ message: "qty must be a positive number" });
    }
    const bom = await BOM.findById(req.params.id).lean();
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    if (!bom.lines || !bom.lines.length) {
      return res.status(400).json({ message: "BOM has no component lines" });
    }

    const parentArticle = (bom.parentArticle || "").trim();
    if (!parentArticle) {
      return res.status(400).json({ message: "Parent item has no Article; set Article for kitting" });
    }

    // Check component stock by article
    for (const line of bom.lines) {
      const article = (line.article || "").trim();
      if (!article) {
        return res.status(400).json({
          message: `Component "${line.name || line.article}" has no Article; set Article for kitting`,
        });
      }
      const stock = await getStockByArticle(article);
      const required = (line.qty || 0) * qty;
      if (stock < required) {
        return res.status(400).json({
          message: `Not enough stock for ${line.name || article} (Article: ${article}). Required: ${required}, Available: ${stock}`,
        });
      }
    }

    const ref = `KIT-${bom._id}`;
    const note = `Kitting x${qty}`;

    // Create OUT for each component (by article)
    for (const line of bom.lines) {
      const outQty = (line.qty || 0) * qty;
      const article = (line.article || "").trim();
      if (article) {
        await StockTxn.create({
          sku: "",
          article,
          type: "OUT",
          qty: outQty,
          ref,
          note,
        });
      }
    }
    // Create IN for parent (by article)
    await StockTxn.create({
      sku: "",
      article: parentArticle,
      type: "IN",
      qty,
      ref,
      note,
    });

    res.json({
      message: `Kitting completed: ${qty} unit(s)`,
      ref,
      componentOut: bom.lines.map((l) => ({ article: l.article, qty: (l.qty || 0) * qty })),
      parentIn: { article: parentArticle, qty },
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// De-Kitting: reduce parent (OUT), add components (IN). Uses article. Body: { qty }
router.post("/:id/dekit", async (req, res) => {
  try {
    const qty = Number(req.body.qty);
    if (!qty || qty <= 0) {
      return res.status(400).json({ message: "qty must be a positive number" });
    }
    const bom = await BOM.findById(req.params.id).lean();
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    if (!bom.lines || !bom.lines.length) {
      return res.status(400).json({ message: "BOM has no component lines" });
    }

    const parentArticle = (bom.parentArticle || "").trim();
    if (!parentArticle) {
      return res.status(400).json({ message: "Parent item has no Article; set Article for de-kitting" });
    }

    const parentStock = await getStockByArticle(parentArticle);
    if (parentStock < qty) {
      return res.status(400).json({
        message: `Not enough stock for parent (Article: ${parentArticle}). Required: ${qty}, Available: ${parentStock}`,
      });
    }

    const ref = `DEKIT-${bom._id}`;
    const note = `De-kitting x${qty}`;

    // OUT for parent (by article)
    await StockTxn.create({
      sku: "",
      article: parentArticle,
      type: "OUT",
      qty,
      ref,
      note,
    });
    // IN for each component (by article)
    for (const line of bom.lines) {
      const inQty = (line.qty || 0) * qty;
      const article = (line.article || "").trim();
      if (article) {
        await StockTxn.create({
          sku: "",
          article,
          type: "IN",
          qty: inQty,
          ref,
          note,
        });
      }
    }

    res.json({
      message: `De-kitting completed: ${qty} unit(s)`,
      ref,
      parentOut: { article: parentArticle, qty },
      componentIn: bom.lines
        .filter((l) => (l.article || "").trim())
        .map((l) => ({ article: l.article, qty: (l.qty || 0) * qty })),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
