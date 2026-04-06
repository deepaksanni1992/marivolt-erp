import express from "express";
import BOM from "../models/BOM.js";
import Article from "../models/Article.js";
import Material from "../models/Material.js";
import StockTxn from "../models/StockTxn.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

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

async function resolveArticleLine(materialCode, articleNo) {
  const code = String(materialCode ?? "").trim();
  const art = String(articleNo ?? "").trim();
  if (!code || !art) return null;
  const articleDoc = await Article.findOne({
    materialCode: code,
    articleNo: art,
    status: "Active",
  }).lean();
  if (!articleDoc) return null;
  const mat = await Material.findOne({ materialCode: code }).lean();
  return { articleDoc, mat };
}

// List BOMs (optional ?parentMaterialCode=)
router.get("/", async (req, res) => {
  try {
    const { parentMaterialCode } = req.query;
    const filter = {};
    if (parentMaterialCode) {
      filter.parentMaterialCode = String(parentMaterialCode).trim();
    }
    const list = await BOM.find(filter).sort({ updatedAt: -1 }).lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const bom = await BOM.findById(req.params.id).lean();
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    res.json(bom);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { parentMaterialCode, parentArticleNo, name, lines } = req.body;
    const pCode = String(parentMaterialCode ?? "").trim();
    const pArt = String(parentArticleNo ?? "").trim();
    if (!pCode || !pArt || !Array.isArray(lines)) {
      return res
        .status(400)
        .json({ message: "parentMaterialCode, parentArticleNo, and lines (array) required" });
    }

    const parentResolved = await resolveArticleLine(pCode, pArt);
    if (!parentResolved) {
      return res.status(404).json({
        message: "Parent article not found for given materialCode + articleNo (Active)",
      });
    }
    const { articleDoc: parentArticle, mat: parentMat } = parentResolved;
    const parentUw = Number(parentArticle.weight) || 0;

    const lineDocs = [];
    for (const line of lines) {
      if (line.qty == null) continue;
      const code = String(line.materialCode ?? "").trim();
      const artNo = String(line.articleNo ?? line.article ?? "").trim();
      if (!code || !artNo) continue;
      const resolved = await resolveArticleLine(code, artNo);
      if (!resolved) {
        return res.status(400).json({
          message: `Component not found: materialCode=${code}, articleNo=${artNo}`,
        });
      }
      const { articleDoc, mat } = resolved;
      const q = Number(line.qty) || 0;
      if (q <= 0) continue;
      const uwt = Number(articleDoc.weight) || 0;
      lineDocs.push({
        materialCode: code,
        article: artNo,
        description: articleDoc.description ?? "",
        spn: mat?.spn ?? "",
        name: articleDoc.description ?? "",
        unitWeight: uwt,
        qty: q,
      });
    }

    if (!lineDocs.length) {
      return res.status(400).json({ message: "At least one valid component line required" });
    }

    const bom = await BOM.create({
      parentMaterialCode: pCode,
      parentArticle: parentArticle.articleNo ?? "",
      parentDescription: parentArticle.description ?? "",
      parentSpn: parentMat?.spn ?? "",
      parentName: parentArticle.description ?? "",
      parentUnitWeight: parentUw,
      name: (name || "").trim(),
      lines: lineDocs,
    });
    const populated = await BOM.findById(bom._id).lean();
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { parentMaterialCode, parentArticleNo, name, lines } = req.body;
    const bom = await BOM.findById(req.params.id);
    if (!bom) return res.status(404).json({ message: "BOM not found" });

    if (parentMaterialCode != null && parentArticleNo != null) {
      const pCode = String(parentMaterialCode).trim();
      const pArt = String(parentArticleNo).trim();
      if (pCode && pArt) {
        const parentResolved = await resolveArticleLine(pCode, pArt);
        if (!parentResolved) {
          return res.status(404).json({
            message: "Parent article not found for given materialCode + articleNo (Active)",
          });
        }
        const { articleDoc: parentArticle, mat: parentMat } = parentResolved;
        bom.parentMaterialCode = pCode;
        bom.parentArticle = parentArticle.articleNo ?? "";
        bom.parentDescription = parentArticle.description ?? "";
        bom.parentSpn = parentMat?.spn ?? "";
        bom.parentName = parentArticle.description ?? "";
        bom.parentUnitWeight = Number(parentArticle.weight) || 0;
      }
    }

    if (name !== undefined) bom.name = (name || "").trim();

    if (Array.isArray(lines)) {
      const lineDocs = [];
      for (const line of lines) {
        if (line.qty == null) continue;
        const code = String(line.materialCode ?? "").trim();
        const artNo = String(line.articleNo ?? line.article ?? "").trim();
        if (!code || !artNo) continue;
        const resolved = await resolveArticleLine(code, artNo);
        if (!resolved) {
          return res.status(400).json({
            message: `Component not found: materialCode=${code}, articleNo=${artNo}`,
          });
        }
        const { articleDoc, mat } = resolved;
        const q = Number(line.qty) || 0;
        if (q <= 0) continue;
        const uwt = Number(articleDoc.weight) || 0;
        lineDocs.push({
          materialCode: code,
          article: artNo,
          description: articleDoc.description ?? "",
          spn: mat?.spn ?? "",
          name: articleDoc.description ?? "",
          unitWeight: uwt,
          qty: q,
        });
      }
      if (lineDocs.length) bom.lines = lineDocs;
    }

    await bom.save();
    const out = await BOM.findById(bom._id).lean();
    res.json(out);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const bom = await BOM.findByIdAndDelete(req.params.id);
    if (!bom) return res.status(404).json({ message: "BOM not found" });
    res.json({ message: "BOM deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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
      return res.status(400).json({ message: "Parent has no Article; set parent article for kitting" });
    }

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
          materialCode: String(line.materialCode || "").trim(),
        });
      }
    }

    await StockTxn.create({
      sku: "",
      article: parentArticle,
      type: "IN",
      qty,
      ref,
      note,
      materialCode: String(bom.parentMaterialCode || "").trim(),
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
      return res.status(400).json({ message: "Parent has no Article; set parent article for de-kitting" });
    }

    const parentStock = await getStockByArticle(parentArticle);
    if (parentStock < qty) {
      return res.status(400).json({
        message: `Not enough stock for parent (Article: ${parentArticle}). Required: ${qty}, Available: ${parentStock}`,
      });
    }

    const ref = `DEKIT-${bom._id}`;
    const note = `De-kitting x${qty}`;

    await StockTxn.create({
      sku: "",
      article: parentArticle,
      type: "OUT",
      qty,
      ref,
      note,
      materialCode: String(bom.parentMaterialCode || "").trim(),
    });

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
          materialCode: String(line.materialCode || "").trim(),
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
