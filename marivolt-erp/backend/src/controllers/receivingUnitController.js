import {
  getReceivingUnitByBarcode,
  listReceivingUnitsForAsn,
  planReceivingUnits,
} from "../services/receivingUnitService.js";
import {
  createJobsFromAsn,
  previewJobsFromAsn,
  reprintReceivingUnit,
} from "../services/label/asnLabelService.js";
import { ReceivingUnitError } from "../utils/receivingUnitRules.js";
import { AsnError } from "../utils/asnRules.js";

function sendError(res, err) {
  if (err instanceof ReceivingUnitError || err instanceof AsnError) {
    return res.status(err.status || err.statusCode || 400).json({
      message: err.message,
      code: err.code,
    });
  }
  const status = Number(err?.statusCode || err?.status) || 500;
  return res.status(status).json({ message: err.message || "Receiving Unit request failed", code: err.code });
}

export async function listForAsn(req, res) {
  try {
    const data = await listReceivingUnitsForAsn(req.companyId, req.params.id);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function plan(req, res) {
  try {
    const data = await planReceivingUnits(req, req.params.id, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function preview(req, res) {
  try {
    const data = await previewJobsFromAsn(req, { ...(req.body || {}), asnId: req.params.id });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function print(req, res) {
  try {
    const data = await createJobsFromAsn(req, { ...(req.body || {}), asnId: req.params.id });
    res.status(201).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function reprint(req, res) {
  try {
    const data = await reprintReceivingUnit(req, req.params.id, req.params.ruId, req.body || {});
    res.status(201).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function byBarcode(req, res) {
  try {
    const data = await getReceivingUnitByBarcode(req.companyId, req.params.barcode);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}
