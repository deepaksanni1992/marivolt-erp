import {
  matchRfqLines,
  parseRfqFile,
  refreshAvailability,
  createQuotationFromManRfq,
  listManEngineModels,
  getManItemSalesSnapshot,
} from "../services/manRfqService.js";

function sendErr(res, err) {
  const payload = { message: err.message, code: err.code };
  if (err.article) payload.article = err.article;
  if (err.priceCurrency) payload.priceCurrency = err.priceCurrency;
  if (err.quotationCurrency) payload.quotationCurrency = err.quotationCurrency;
  res.status(err.statusCode || 400).json(payload);
}

export async function match(req, res) {
  try {
    let lines = req.body?.lines;
    if (req.file?.buffer) {
      lines = await parseRfqFile(req.file.buffer);
    }
    const result = await matchRfqLines(req, {
      lines: lines || [],
      defaultTier: req.body?.defaultTier,
      headerMode: req.body?.modelMode || req.body?.headerMode || req.body?.header?.modelMode,
      headerModel: req.body?.model || req.body?.headerModel || req.body?.header?.model,
      currency: req.body?.currency || req.body?.header?.currency,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function availability(req, res) {
  try {
    const result = await refreshAvailability(req, req.body?.lines || []);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createQuotation(req, res) {
  try {
    const result = await createQuotationFromManRfq(req, req.body || {});
    res.status(result.reused ? 200 : 201).json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listModels(req, res) {
  try {
    const result = await listManEngineModels(req);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function itemSnapshot(req, res) {
  try {
    const result = await getManItemSalesSnapshot(req, req.params.article);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}
