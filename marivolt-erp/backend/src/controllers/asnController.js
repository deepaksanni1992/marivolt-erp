import {
  addAsnAttachment,
  arriveAsn,
  cancelAsn,
  createAsn,
  getAsn,
  getPoAsnAvailability,
  listAsns,
  removeAsnAttachment,
  shipAsn,
  updateAsn,
} from "../services/asnService.js";
import { AsnError } from "../utils/asnRules.js";

function sendError(res, err) {
  if (err instanceof AsnError) {
    return res.status(err.status).json({ message: err.message, code: err.code });
  }
  const status = Number(err?.status) || 500;
  return res.status(status).json({ message: err.message || "ASN request failed" });
}

export async function create(req, res) {
  try {
    const row = await createAsn(req, req.body || {});
    res.status(201).json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function list(req, res) {
  try {
    const data = await listAsns(req.companyId, req.query || {});
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function getById(req, res) {
  try {
    const row = await getAsn(req.companyId, req.params.id);
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function patch(req, res) {
  try {
    const row = await updateAsn(req, req.params.id, req.body || {});
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function ship(req, res) {
  try {
    const row = await shipAsn(req, req.params.id);
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function arrive(req, res) {
  try {
    const row = await arriveAsn(req, req.params.id);
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function cancel(req, res) {
  try {
    const row = await cancelAsn(req, req.params.id, req.body || {});
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function addAttachment(req, res) {
  try {
    const row = await addAsnAttachment(req, req.params.id, req.body || {});
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function removeAttachment(req, res) {
  try {
    const row = await removeAsnAttachment(req, req.params.id, req.params.attachmentId);
    res.json(row);
  } catch (err) {
    sendError(res, err);
  }
}

export async function poAvailability(req, res) {
  try {
    const data = await getPoAsnAvailability(req.companyId, req.params.id);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}
