import {
  applyImport,
  csvTemplate,
  exportPriceListCsv,
  getPriceListByArticle,
  listPriceList,
  previewImport,
  upsertManualPrice,
} from "../services/manPriceListService.js";

function sendErr(res, err) {
  const body = { message: err.message, code: err.code };
  if (Array.isArray(err.articles)) body.articles = err.articles;
  if (Array.isArray(err.lines)) body.lines = err.lines;
  if (Array.isArray(err.errors)) body.errors = err.errors;
  res.status(err.statusCode || 400).json(body);
}

export async function list(req, res) {
  try {
    const items = await listPriceList(req, {
      q: req.query.q,
      includeInactive: String(req.query.includeInactive || "") === "true",
    });
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getOne(req, res) {
  try {
    const row = await getPriceListByArticle(req, req.params.article, { management: true });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function upsert(req, res) {
  try {
    const row = await upsertManualPrice(req, req.params.article || req.body.article, req.body);
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function template(req, res) {
  const csv = csvTemplate();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="man-price-list-template.csv"');
  res.send(csv);
}

export async function exportCsv(req, res) {
  try {
    const csv = await exportPriceListCsv(req);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="man-price-list.csv"');
    res.send(csv);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function preview(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: "CSV or Excel file is required" });
    }
    const result = await previewImport(req, {
      buffer: req.file.buffer,
      filename: req.file.originalname,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function apply(req, res) {
  try {
    const result = await applyImport(req, req.body?.previewId || req.params.previewId);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}
