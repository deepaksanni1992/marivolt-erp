import express from "express";
import Item from "../models/Item.js";
import PriceList from "../models/PriceList.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const DEFAULT_MARGIN_UNIT = 0.25;   // 25%
const DEFAULT_MARGIN_MIN = 0.20;    // 20%
const DEFAULT_MARGIN_EURO2 = 0.30;  // 30%

/**
 * GET /api/price-list
 * Returns merged view: all items with Article, SPN, Description from Item Master,
 * Buy price = Supplier 1 Unit Price, Unit/Minimum/Euro2 from PriceList or default margins.
 */
router.get("/", async (req, res) => {
  try {
    const items = await Item.find().sort({ article: 1 });
    const priceListDocs = await PriceList.find();
    const byArticle = new Map(priceListDocs.map((p) => [String(p.article).trim(), p]));

    const rows = items.map((it) => {
      const article = String(it.article || "").trim();
      const buyPrice = Number(it.supplier1UnitPrice) || 0;
      const pl = byArticle.get(article);
      return {
        _id: it._id,
        article: article || "-",
        spn: it.spn ?? "",
        description: it.description ?? it.name ?? "",
        buyPrice,
        unitPrice: pl?.unitPrice != null ? Number(pl.unitPrice) : round2(buyPrice * (1 + DEFAULT_MARGIN_UNIT)),
        minimumPrice: pl?.minimumPrice != null ? Number(pl.minimumPrice) : round2(buyPrice * (1 + DEFAULT_MARGIN_MIN)),
        euro2Price: pl?.euro2Price != null ? Number(pl.euro2Price) : round2(buyPrice * (1 + DEFAULT_MARGIN_EURO2)),
      };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * PUT /api/price-list
 * Upsert one price list row by article. Body: { article, unitPrice?, minimumPrice?, euro2Price?, buyPrice? }
 * If buyPrice provided, updates Item Master Supplier 1 Unit Price for that article.
 */
router.put("/", async (req, res) => {
  try {
    const { article, unitPrice, minimumPrice, euro2Price, buyPrice } = req.body || {};
    const art = String(article ?? "").trim();
    if (!art) return res.status(400).json({ message: "Article is required" });

    const item = await Item.findOne({ $or: [{ article: art }, { sku: art }] });
    if (item && buyPrice !== undefined && buyPrice !== null) {
      item.supplier1UnitPrice = Number(buyPrice) || 0;
      await item.save();
    }

    const setFields = {};
    if (unitPrice !== undefined && unitPrice !== null && unitPrice !== "") setFields.unitPrice = Number(unitPrice);
    if (minimumPrice !== undefined && minimumPrice !== null && minimumPrice !== "") setFields.minimumPrice = Number(minimumPrice);
    if (euro2Price !== undefined && euro2Price !== null && euro2Price !== "") setFields.euro2Price = Number(euro2Price);
    await PriceList.findOneAndUpdate(
      { article: art },
      Object.keys(setFields).length ? { $set: setFields } : {},
      { upsert: true, new: true }
    );

    const items = await Item.find().sort({ article: 1 });
    const priceListDocs = await PriceList.find();
    const byArticle = new Map(priceListDocs.map((p) => [String(p.article).trim(), p]));
    const it = items.find((i) => String(i.article || "").trim() === art || String(i.sku || "").trim() === art);
    const buy = it ? Number(it.supplier1UnitPrice) || 0 : 0;
    const pl = byArticle.get(art);
    const row = {
      _id: it?._id,
      article: art,
      spn: it?.spn ?? "",
      description: it?.description ?? it?.name ?? "",
      buyPrice: buy,
      unitPrice: pl?.unitPrice != null ? Number(pl.unitPrice) : round2(buy * (1 + DEFAULT_MARGIN_UNIT)),
      minimumPrice: pl?.minimumPrice != null ? Number(pl.minimumPrice) : round2(buy * (1 + DEFAULT_MARGIN_MIN)),
      euro2Price: pl?.euro2Price != null ? Number(pl.euro2Price) : round2(buy * (1 + DEFAULT_MARGIN_EURO2)),
    };
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/price-list/import
 * Body: { rows: [ { article, unitPrice?, minimumPrice?, euro2Price?, buyPrice? }, ... ] }
 * For each row: update Item Master Supplier 1 Unit Price from buyPrice (if provided); upsert PriceList.
 * Item Master "calls" price from price list (buy price is updated from import).
 */
router.post("/import", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let updatedItems = 0;
    let updatedPrices = 0;

    for (const row of rows) {
      const art = String(row?.article ?? "").trim();
      if (!art) continue;

      const item = await Item.findOne({ $or: [{ article: art }, { sku: art }] });
      if (item && (row.buyPrice !== undefined && row.buyPrice !== null && row.buyPrice !== "")) {
        item.supplier1UnitPrice = Number(row.buyPrice) || 0;
        await item.save();
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
          await PriceList.findOneAndUpdate(
            { article: art },
            { $set: setFields },
            { upsert: true }
          );
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
