import mongoose from "mongoose";
import XLSX from "xlsx";
import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import ItemSupplier from "../models/itemSupplierModel.js";
import StockBalance from "../models/StockBalance.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}

function escRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePaging(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function trim(value) {
  return String(value ?? "").trim();
}

function normalizeUom(value) {
  const upper = trim(value).toUpperCase();
  return UOM_VALUES.includes(upper) ? upper : "PCS";
}

function pick(row, ...keys) {
  for (const key of keys) {
    const out = trim(row[key]);
    if (out) return out;
  }
  return "";
}

function normalizeDimension(value) {
  const raw = trim(value).replace(/\s+/g, " ");
  if (!raw) return "";
  const isValid = /^(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)(\s*mm)?$/i.test(raw);
  if (!isValid) {
    throw new Error("Invalid dimension format");
  }
  return raw.replace(/\s*mm$/i, "").replace(/\s*x\s*/gi, "x");
}

async function ensureItemExists(req, article) {
  const item = await ItemMaster.findOne(withCompany(req, { article })).select("_id article").lean();
  if (!item) throw new Error("Article not found in ItemMaster");
}

function mapMerged(item, technical, suppliers) {
  return {
    ...item,
    technical: technical || null,
    suppliers: suppliers || [],
    dimension: technical?.dimension || "",
  };
}

export async function listItemFacets(req, res) {
  try {
    const [verticals, engines] = await Promise.all([
      ItemMaster.distinct("vertical", withCompany(req, { vertical: { $nin: [null, ""] } })),
      ItemMaster.distinct("engine", withCompany(req, { engine: { $nin: [null, ""] } })),
    ]);
    const norm = (arr) => [...new Set(arr.map((x) => trim(x)).filter(Boolean))].sort();
    res.json({
      verticals: norm(verticals),
      engines: norm(engines),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listItems(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req);
    const filter = withCompany(req);

    const status = trim(req.query.status);
    if (status && ["Active", "Inactive"].includes(status)) filter.status = status;
    const vertical = trim(req.query.vertical);
    if (vertical) filter.vertical = new RegExp(`^${escRe(vertical)}$`, "i");
    const engine = trim(req.query.engine);
    if (engine) filter.engine = new RegExp(`^${escRe(engine)}$`, "i");

    const search = trim(req.query.search);
    if (search) {
      const re = new RegExp(escRe(search), "i");
      const [technicalArticles, supplierArticles] = await Promise.all([
        ItemTechnical.find(
          withCompany(req, {
            $or: [{ spn: re }, { materialCode: re }, { drawingNumber: re }, { dimension: re }],
          })
        )
          .distinct("article"),
        ItemSupplier.find(
          withCompany(req, {
            $or: [{ supplierName: re }, { supplierPartNumber: re }],
          })
        )
          .distinct("article"),
      ]);
      const articleHits = [...new Set([...technicalArticles, ...supplierArticles])];
      filter.$or = [
        { article: re },
        { itemName: re },
        { description: re },
        { engine: re },
        { model: re },
        { config: re },
        ...(articleHits.length ? [{ article: { $in: articleHits } }] : []),
      ];
    }

    const [items, total] = await Promise.all([
      ItemMaster.find(filter).sort({ article: 1 }).skip(skip).limit(limit).lean(),
      ItemMaster.countDocuments(filter),
    ]);

    const articles = items.map((row) => row.article);
    const [technicalRows, supplierRows, stockRows] = await Promise.all([
      ItemTechnical.find(withCompany(req, { article: { $in: articles } })).lean(),
      ItemSupplier.find(withCompany(req, { article: { $in: articles } })).sort({ supplierName: 1 }).lean(),
      StockBalance.find(withCompany(req, { article: { $in: articles } }))
        .select("article onHandQty")
        .lean(),
    ]);
    const technicalByArticle = new Map(technicalRows.map((row) => [row.article, row]));
    const suppliersByArticle = new Map();
    const qtyByArticle = new Map();
    for (const sup of supplierRows) {
      const list = suppliersByArticle.get(sup.article) || [];
      list.push(sup);
      suppliersByArticle.set(sup.article, list);
    }
    for (const stk of stockRows) {
      qtyByArticle.set(stk.article, Number(qtyByArticle.get(stk.article) || 0) + Number(stk.onHandQty || 0));
    }
    const merged = items.map((row) => {
      const technical = technicalByArticle.get(row.article) || null;
      const supplierList = suppliersByArticle.get(row.article) || [];
      return {
        ...row,
        technical,
        dimension: technical?.dimension || "",
        spn: technical?.spn || "",
        materialCode: technical?.materialCode || "",
        drawingNumber: technical?.drawingNumber || "",
        extRemarks: technical?.extRemarks || "",
        internalRemarks: technical?.internalRemarks || "",
        oeMarkings: technical?.oeMarkings || "",
        supplier1: supplierList[0]?.supplierName || "",
        supplier1PartNumber: supplierList[0]?.supplierPartNumber || "",
        supplier2: supplierList[1]?.supplierName || "",
        supplier2PartNumber: supplierList[1]?.supplierPartNumber || "",
        qty: Number(qtyByArticle.get(row.article) || 0),
      };
    });

    res.json({ items: merged, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const item = await ItemMaster.findOne(withCompany(req, { article })).lean();
    if (!item) return res.status(404).json({ message: "Not found" });
    const [technical, suppliers] = await Promise.all([
      ItemTechnical.findOne(withCompany(req, { article })).lean(),
      ItemSupplier.find(withCompany(req, { article })).sort({ supplierName: 1 }).lean(),
    ]);
    res.json(mapMerged(item, technical, suppliers));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createItem(req, res) {
  try {
    const article = trim(req.body.article).toUpperCase();
    const payload = {
      companyId: req.companyId,
      article,
      itemName: trim(req.body.itemName),
      description: trim(req.body.description),
      vertical: trim(req.body.vertical),
      engine: trim(req.body.engine),
      model: trim(req.body.model),
      config: trim(req.body.config),
      uom: normalizeUom(req.body.uom),
      status: trim(req.body.status) === "Inactive" ? "Inactive" : "Active",
    };
    const created = await ItemMaster.create(payload);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const payload = {
      itemName: trim(req.body.itemName),
      description: trim(req.body.description),
      vertical: trim(req.body.vertical),
      engine: trim(req.body.engine),
      model: trim(req.body.model),
      config: trim(req.body.config),
      uom: normalizeUom(req.body.uom),
      status: trim(req.body.status) === "Inactive" ? "Inactive" : "Active",
    };
    const row = await ItemMaster.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      runValidators: true,
    });
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const deleted = await ItemMaster.findOneAndDelete(withCompany(req, { article }));
    if (!deleted) return res.status(404).json({ message: "Not found" });
    await Promise.all([
      ItemTechnical.deleteMany(withCompany(req, { article })),
      ItemSupplier.deleteMany(withCompany(req, { article })),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const payload = {
      companyId: req.companyId,
      article,
      spn: trim(req.body.spn),
      materialCode: trim(req.body.materialCode),
      drawingNumber: trim(req.body.drawingNumber),
      dimension: normalizeDimension(req.body.dimension),
      oeMarkings: trim(req.body.oeMarkings),
      extRemarks: trim(req.body.extRemarks),
      internalRemarks: trim(req.body.internalRemarks),
    };
    const row = await ItemTechnical.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      upsert: true,
      runValidators: true,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const row = await ItemTechnical.findOne(withCompany(req, { article })).lean();
    res.json(row || null);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const payload = {
      spn: trim(req.body.spn),
      materialCode: trim(req.body.materialCode),
      drawingNumber: trim(req.body.drawingNumber),
      dimension: normalizeDimension(req.body.dimension),
      oeMarkings: trim(req.body.oeMarkings),
      extRemarks: trim(req.body.extRemarks),
      internalRemarks: trim(req.body.internalRemarks),
    };
    const row = await ItemTechnical.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      upsert: true,
      runValidators: true,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const row = await ItemSupplier.create({
      companyId: req.companyId,
      article,
      supplierName: trim(req.body.supplierName),
      supplierPartNumber: trim(req.body.supplierPartNumber),
      currency: trim(req.body.currency || "USD").toUpperCase() || "USD",
      price: Number(req.body.price) || 0,
      leadTime: trim(req.body.leadTime),
      remarks: trim(req.body.remarks),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listItemSuppliers(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const rows = await ItemSupplier.find(withCompany(req, { article })).sort({ supplierName: 1 }).lean();
    res.json(rows);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const supplierId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ message: "Invalid supplier id" });
    }
    await ensureItemExists(req, article);
    const row = await ItemSupplier.findOneAndUpdate(
      withCompany(req, { _id: supplierId, article }),
      {
        supplierName: trim(req.body.supplierName),
        supplierPartNumber: trim(req.body.supplierPartNumber),
        currency: trim(req.body.currency || "USD").toUpperCase() || "USD",
        price: Number(req.body.price) || 0,
        leadTime: trim(req.body.leadTime),
        remarks: trim(req.body.remarks),
      },
      { new: true, runValidators: true }
    );
    if (!row) return res.status(404).json({ message: "Supplier row not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const supplierId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ message: "Invalid supplier id" });
    }
    const row = await ItemSupplier.findOneAndDelete(withCompany(req, { _id: supplierId, article }));
    if (!row) return res.status(404).json({ message: "Supplier row not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function importItems(req, res) {
  const result = { total: 0, upsertedItems: 0, upsertedTechnicals: 0, upsertedSuppliers: 0, errors: [] };
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Upload CSV/Excel with file field" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer", raw: false });
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    result.total = rows.length;

    for (let index = 0; index < rows.length; index += 1) {
      const raw = rows[index];
      try {
        const row = Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [trim(k), trim(v)])
        );
        const article = pick(row, "Article", "ARTICLE").toUpperCase();
        if (!article) {
          throw new Error("Article missing");
        }

        const uom = normalizeUom(pick(row, "UOM", "Uom", "uom"));
        const dimension = normalizeDimension(pick(row, "Dimension", "DIMENSION"));

        await ItemMaster.findOneAndUpdate(
          withCompany(req, { article }),
          {
            companyId: req.companyId,
            article,
            itemName: pick(row, "ITEM NAME", "Item Name", "itemName"),
            description: pick(row, "Description", "DESCRIPTION"),
            vertical: pick(row, "Vertical", "VERTICLE"),
            engine: pick(row, "Eng no", "Engine", "ENG NO"),
            model: pick(row, "Model", "MODEL"),
            config: pick(row, "Config", "CONFIG"),
            uom,
            status: "Active",
          },
          { upsert: true, new: true, runValidators: true }
        );
        result.upsertedItems += 1;

        await ItemTechnical.findOneAndUpdate(
          withCompany(req, { article }),
          {
            companyId: req.companyId,
            article,
            spn: pick(row, "SPN"),
            materialCode: pick(row, "Material Code", "Material code"),
            drawingNumber: pick(row, "Drawing Number", "Drawing number"),
            extRemarks: pick(row, "Ext Remarks", "Ext remarks"),
            internalRemarks: pick(row, "Internal Remarks", "Internal remarks"),
            oeMarkings: pick(row, "OE Markings", "OE Markings"),
            dimension,
          },
          { upsert: true, new: true, runValidators: true }
        );
        result.upsertedTechnicals += 1;

        const suppliersFromLegacyCols = [
          {
            supplierName: pick(row, "Supplier 1"),
            supplierPartNumber: pick(row, "Supplier 1 P/N", "Supplier 1 P/N "),
          },
          {
            supplierName: pick(row, "Supplier 2"),
            supplierPartNumber: pick(row, "Supplier 2 P/N", "Supplier 2 P/N "),
          },
        ].filter((sup) => sup.supplierName);

        for (const supplier of suppliersFromLegacyCols) {
          await ItemSupplier.findOneAndUpdate(
            withCompany(req, {
              article,
              supplierName: supplier.supplierName,
              supplierPartNumber: supplier.supplierPartNumber,
            }),
            {
              companyId: req.companyId,
              article,
              supplierName: supplier.supplierName,
              supplierPartNumber: supplier.supplierPartNumber,
              currency: "USD",
              price: 0,
              leadTime: "",
              remarks: "",
            },
            { upsert: true, new: true, runValidators: true }
          );
          result.upsertedSuppliers += 1;
        }
      } catch (rowErr) {
        result.errors.push({ row: index + 2, reason: rowErr.message });
      }
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function exportItems(req, res) {
  try {
    const rows = await ItemMaster.find(withCompany(req)).sort({ article: 1 }).lean();
    const articles = rows.map((row) => row.article);
    const [technicals, suppliers] = await Promise.all([
      ItemTechnical.find(withCompany(req, { article: { $in: articles } })).lean(),
      ItemSupplier.find(withCompany(req, { article: { $in: articles } })).lean(),
    ]);
    const technicalByArticle = new Map(technicals.map((row) => [row.article, row]));
    const suppliersByArticle = new Map();
    for (const row of suppliers) {
      const list = suppliersByArticle.get(row.article) || [];
      list.push(`${row.supplierName}${row.supplierPartNumber ? ` (${row.supplierPartNumber})` : ""}`);
      suppliersByArticle.set(row.article, list);
    }

    const merged = rows.map((item) => {
      const tech = technicalByArticle.get(item.article);
      return {
        Article: item.article,
        "ITEM NAME": item.itemName,
        Description: item.description,
        Vertical: item.vertical,
        "Eng no": item.engine,
        Model: item.model,
        Config: item.config,
        SPN: tech?.spn || "",
        "Material Code": tech?.materialCode || "",
        "Drawing Number": tech?.drawingNumber || "",
        Dimension: tech?.dimension || "",
        "OE Markings": tech?.oeMarkings || "",
        Suppliers: (suppliersByArticle.get(item.article) || []).join("; "),
        Status: item.status,
      };
    });

    res.json({ items: merged });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
