import express from "express";
import Article from "../models/Article.js";
import Material from "../models/Material.js";
import MaterialSupplier from "../models/MaterialSupplier.js";
import PriceList from "../models/PriceList.js";
import Vertical from "../models/Vertical.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const DEFAULT_MARGIN_UNIT = 0.25;
const DEFAULT_MARGIN_MIN = 0.2;
const DEFAULT_MARGIN_EURO2 = 0.3;

async function buyPriceForMaterial(materialCode) {
  const code = String(materialCode || "").trim();
  if (!code) return 0;
  const preferred = await MaterialSupplier.findOne({
    materialCode: code,
    preferred: true,
    status: "Active",
  })
    .sort({ updatedAt: -1 })
    .lean();
  if (preferred && Number(preferred.price) > 0) return Number(preferred.price) || 0;
  const any = await MaterialSupplier.findOne({ materialCode: code, status: "Active" })
    .sort({ price: 1 })
    .lean();
  return any ? Number(any.price) || 0 : 0;
}

async function setBuyPriceForMaterial(materialCode, buyPrice) {
  const code = String(materialCode || "").trim();
  if (!code) return false;
  const price = Number(buyPrice) || 0;
  let row = await MaterialSupplier.findOne({
    materialCode: code,
    preferred: true,
    status: "Active",
  }).sort({ updatedAt: -1 });
  if (!row) {
    row = await MaterialSupplier.findOne({ materialCode: code, status: "Active" }).sort({
      updatedAt: -1,
    });
  }
  if (row) {
    row.price = price;
    await row.save();
    return true;
  }
  await MaterialSupplier.create({
    materialCode: code,
    supplierName: "Price list",
    price,
    preferred: true,
    status: "Active",
  });
  return true;
}

/**
 * GET /api/price-list
 * Rows from Article Master + Material; buy price from preferred MaterialSupplier (or lowest active price).
 */
router.get("/", async (req, res) => {
  try {
    const articles = await Article.find({ status: "Active" }).sort({ articleNo: 1 }).lean();
    const codes = [...new Set(articles.map((a) => String(a.materialCode || "").trim()).filter(Boolean))];
    const [materials, priceListDocs] = await Promise.all([
      Material.find({ materialCode: { $in: codes } }).lean(),
      PriceList.find(),
    ]);
    const matByCode = new Map(materials.map((m) => [m.materialCode, m]));
    const verticalIds = [...new Set(materials.map((m) => m.vertical).filter(Boolean))];
    const verts = await Vertical.find({ _id: { $in: verticalIds } }).lean();
    const vertById = new Map(verts.map((v) => [String(v._id), v]));
    const byArticle = new Map(priceListDocs.map((p) => [String(p.article).trim(), p]));

    const buyCache = new Map();
    async function buyFor(code) {
      if (buyCache.has(code)) return buyCache.get(code);
      const b = await buyPriceForMaterial(code);
      buyCache.set(code, b);
      return b;
    }

    const rows = [];
    for (const it of articles) {
      const article = String(it.articleNo || "").trim();
      const code = String(it.materialCode || "").trim();
      const mat = matByCode.get(code);
      const vertName = mat?.vertical ? vertById.get(String(mat.vertical))?.name ?? "" : "";
      const buyPrice = code ? await buyFor(code) : 0;
      const pl = byArticle.get(article);
      rows.push({
        _id: it._id,
        article: article || "-",
        materialCode: code,
        verticalName: vertName,
        spn: mat?.spn ?? "",
        description: it.description ?? "",
        buyPrice,
        unitPrice:
          pl?.unitPrice != null ? Number(pl.unitPrice) : round2(buyPrice * (1 + DEFAULT_MARGIN_UNIT)),
        minimumPrice:
          pl?.minimumPrice != null
            ? Number(pl.minimumPrice)
            : round2(buyPrice * (1 + DEFAULT_MARGIN_MIN)),
        euro2Price:
          pl?.euro2Price != null ? Number(pl.euro2Price) : round2(buyPrice * (1 + DEFAULT_MARGIN_EURO2)),
      });
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/price-list
 * Body: { article, unitPrice?, minimumPrice?, euro2Price?, buyPrice? }
 * buyPrice updates MaterialSupplier (preferred or synthetic row) for the article's materialCode.
 */
router.put("/", async (req, res) => {
  try {
    const { article, unitPrice, minimumPrice, euro2Price, buyPrice } = req.body || {};
    const art = String(article ?? "").trim();
    if (!art) return res.status(400).json({ message: "Article is required" });

    const articleDoc = await Article.findOne({ articleNo: art }).lean();
    const materialCode = articleDoc ? String(articleDoc.materialCode || "").trim() : "";

    if (materialCode && buyPrice !== undefined && buyPrice !== null) {
      await setBuyPriceForMaterial(materialCode, buyPrice);
    }

    const setFields = {};
    if (unitPrice !== undefined && unitPrice !== null && unitPrice !== "")
      setFields.unitPrice = Number(unitPrice);
    if (minimumPrice !== undefined && minimumPrice !== null && minimumPrice !== "")
      setFields.minimumPrice = Number(minimumPrice);
    if (euro2Price !== undefined && euro2Price !== null && euro2Price !== "")
      setFields.euro2Price = Number(euro2Price);
    await PriceList.findOneAndUpdate(
      { article: art },
      Object.keys(setFields).length ? { $set: setFields } : {},
      { upsert: true, new: true }
    );

    const priceListDocs = await PriceList.find();
    const byArticle = new Map(priceListDocs.map((p) => [String(p.article).trim(), p]));
    const pl = byArticle.get(art);
    const buy = materialCode ? await buyPriceForMaterial(materialCode) : 0;
    const mat = materialCode ? await Material.findOne({ materialCode }).lean() : null;
    const row = {
      _id: articleDoc?._id,
      article: art,
      materialCode,
      spn: mat?.spn ?? "",
      description: articleDoc?.description ?? "",
      buyPrice: buy,
      unitPrice:
        pl?.unitPrice != null ? Number(pl.unitPrice) : round2(buy * (1 + DEFAULT_MARGIN_UNIT)),
      minimumPrice:
        pl?.minimumPrice != null ? Number(pl.minimumPrice) : round2(buy * (1 + DEFAULT_MARGIN_MIN)),
      euro2Price:
        pl?.euro2Price != null ? Number(pl.euro2Price) : round2(buy * (1 + DEFAULT_MARGIN_EURO2)),
    };
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/import", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let updatedItems = 0;
    let updatedPrices = 0;

    for (const row of rows) {
      const art = String(row?.article ?? "").trim();
      if (!art) continue;

      const articleDoc = await Article.findOne({ articleNo: art }).lean();
      const materialCode = articleDoc ? String(articleDoc.materialCode || "").trim() : "";

      if (
        materialCode &&
        row.buyPrice !== undefined &&
        row.buyPrice !== null &&
        row.buyPrice !== ""
      ) {
        await setBuyPriceForMaterial(materialCode, row.buyPrice);
        updatedItems++;
      }

      const up = numberOrUndefined(row.unitPrice);
      const min = numberOrUndefined(row.minimumPrice);
      const euro2 = numberOrUndefined(row.euro2Price);
      const setFields = {};
      if (up !== undefined) setFields.unitPrice = up;
      if (min !== undefined) setFields.minimumPrice = min;
      if (euro2 !== undefined) setFields.euro2Price = euro2;
      if (Object.keys(setFields).length) {
        await PriceList.findOneAndUpdate({ article: art }, { $set: setFields }, { upsert: true });
        updatedPrices++;
      }
    }

    res.json({ updatedItems, updatedPrices, processed: rows.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function numberOrUndefined(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export default router;
