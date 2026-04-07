import Item from "../models/itemModel.js";
import ItemMapping from "../models/itemMappingModel.js";
import ItemSupplierOffer from "../models/supplierModel.js";
import { parseExcelBufferToRows, rowGet } from "../utils/excelParser.js";

/**
 * @typedef {{ row: number, reason: string }} FailedRow
 * @typedef {{ total: number, inserted: number, failed: FailedRow[] }} ImportSummary
 */

function parsePositiveNumber(raw, fieldLabel) {
  if (raw === "" || raw == null) return { ok: true, value: 0 };
  const n = Number(String(raw).replace(/,/g, "").trim());
  if (Number.isNaN(n) || n < 0) return { ok: false, error: `Invalid ${fieldLabel}` };
  return { ok: true, value: n };
}

/**
 * POST /api/import/items — Excel: Vertical, Brand, Article, ProductName, UOM, UnitWeight, COO
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function importItems(req, res) {
  /** @type {ImportSummary} */
  const summary = { total: 0, inserted: 0, failed: [] };
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Upload an Excel file (field name: file)" });
    }
    const parsed = parseExcelBufferToRows(req.file.buffer);
    summary.total = parsed.length;

    const seenInFile = new Set();

    for (const { rowNumber, data } of parsed) {
      const article = rowGet(data, "Article", "article", "ITEM", "Item Code", "itemCode").toUpperCase();
      if (!article) {
        summary.failed.push({ row: rowNumber, reason: "Missing Article" });
        continue;
      }

      if (seenInFile.has(article)) {
        summary.failed.push({ row: rowNumber, reason: "Duplicate Article in file — skipped" });
        continue;
      }
      seenInFile.add(article);

      const existing = await Item.findOne({ itemCode: article }).select("_id").lean();
      if (existing) {
        summary.failed.push({ row: rowNumber, reason: "Duplicate Article in Item Master — skipped" });
        continue;
      }

      const vertical = rowGet(data, "Vertical", "vertical");
      const brand = rowGet(data, "Brand", "brand");
      const productName = rowGet(data, "ProductName", "Product Name", "productName", "Description");
      const uom = rowGet(data, "UOM", "uom", "Unit") || "PCS";
      const unitWeightRaw = rowGet(data, "UnitWeight", "Unit Weight", "unitWeight", "Weight");
      const w = parsePositiveNumber(unitWeightRaw, "UnitWeight");
      if (!w.ok) {
        summary.failed.push({ row: rowNumber, reason: w.error });
        continue;
      }
      const coo = rowGet(data, "COO", "coo", "Country of Origin", "Country");

      try {
        await Item.create({
          itemCode: article,
          description: productName,
          uom,
          vertical,
          brand,
          weightKg: w.value,
          coo,
          isActive: true,
        });
        summary.inserted += 1;
      } catch (e) {
        const msg = e?.message || "Create failed";
        console.error("[import/items] row", rowNumber, msg);
        summary.failed.push({ row: rowNumber, reason: msg });
      }
    }

    res.json(summary);
  } catch (err) {
    console.error("[import/items]", err);
    res.status(400).json({ message: err.message || "Import failed" });
  }
}

/**
 * POST /api/import/mappings
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function importMappings(req, res) {
  /** @type {ImportSummary} */
  const summary = { total: 0, inserted: 0, failed: [] };
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Upload an Excel file (field name: file)" });
    }
    const parsed = parseExcelBufferToRows(req.file.buffer);
    summary.total = parsed.length;

    for (const { rowNumber, data } of parsed) {
      const article = rowGet(data, "Article", "article").toUpperCase();
      if (!article) {
        summary.failed.push({ row: rowNumber, reason: "Missing Article" });
        continue;
      }

      const item = await Item.findOne({ itemCode: article }).select("_id").lean();
      if (!item) {
        summary.failed.push({ row: rowNumber, reason: "Article not found in Item Master" });
        continue;
      }

      const model = rowGet(data, "Model", "model");
      const esn = rowGet(data, "ESN", "esn");
      const mpn = rowGet(data, "MPN", "mpn");
      const partNumber = rowGet(data, "PartNumber", "Part Number", "partNumber");
      const materialCode = rowGet(data, "MaterialCode", "Material Code", "materialCode");
      const drawingNumber = rowGet(data, "DrawingNumber", "Drawing Number", "drawingNumber");
      const description = rowGet(data, "Description", "description");

      try {
        await ItemMapping.create({
          article,
          model,
          esn,
          mpn,
          partNumber,
          materialCode,
          drawingNumber,
          description,
        });
        summary.inserted += 1;
      } catch (e) {
        const msg = e?.message || "Insert failed";
        console.error("[import/mappings] row", rowNumber, msg);
        summary.failed.push({ row: rowNumber, reason: msg });
      }
    }

    res.json(summary);
  } catch (err) {
    console.error("[import/mappings]", err);
    res.status(400).json({ message: err.message || "Import failed" });
  }
}

/**
 * POST /api/import/suppliers
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function importSuppliers(req, res) {
  /** @type {ImportSummary} */
  const summary = { total: 0, inserted: 0, failed: [] };
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "Upload an Excel file (field name: file)" });
    }
    const parsed = parseExcelBufferToRows(req.file.buffer);
    summary.total = parsed.length;

    for (const { rowNumber, data } of parsed) {
      const article = rowGet(data, "Article", "article").toUpperCase();
      if (!article) {
        summary.failed.push({ row: rowNumber, reason: "Missing Article" });
        continue;
      }

      const item = await Item.findOne({ itemCode: article }).select("_id").lean();
      if (!item) {
        summary.failed.push({ row: rowNumber, reason: "Article not found in Item Master" });
        continue;
      }

      const supplierName = rowGet(data, "SupplierName", "Supplier Name", "supplierName", "Supplier");
      if (!supplierName) {
        summary.failed.push({ row: rowNumber, reason: "Missing SupplierName" });
        continue;
      }

      const supplierPartNumber = rowGet(
        data,
        "SupplierPartNumber",
        "Supplier Part Number",
        "supplierPartNumber",
        "Supplier Part No"
      );
      const unitPriceRaw = rowGet(data, "UnitPrice", "Unit Price", "unitPrice", "Price");
      const p = parsePositiveNumber(unitPriceRaw, "UnitPrice");
      if (!p.ok) {
        summary.failed.push({ row: rowNumber, reason: p.error });
        continue;
      }
      const currency = rowGet(data, "Currency", "currency") || "USD";

      try {
        await ItemSupplierOffer.create({
          article,
          supplierName,
          supplierPartNumber,
          unitPrice: p.value,
          currency,
        });
        summary.inserted += 1;
      } catch (e) {
        const msg = e?.message || "Insert failed";
        console.error("[import/suppliers] row", rowNumber, msg);
        summary.failed.push({ row: rowNumber, reason: msg });
      }
    }

    res.json(summary);
  } catch (err) {
    console.error("[import/suppliers]", err);
    res.status(400).json({ message: err.message || "Import failed" });
  }
}
