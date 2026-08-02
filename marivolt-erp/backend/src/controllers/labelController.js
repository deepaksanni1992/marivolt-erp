import LabelPrintJob from "../models/LabelPrintJob.js";
import LabelPrintHistory from "../models/LabelPrintHistory.js";
import * as labelService from "../services/label/labelService.js";
import * as labelSettings from "../services/label/labelSettingsService.js";
import * as printerManager from "../services/label/printerManager.js";
import * as templateService from "../services/label/labelTemplateService.js";
import { getFixedLabelSize } from "../services/label/tsplGenerator.js";
import { recordLabelHistory } from "../services/label/labelAudit.js";
import { syncGrnLabelStatus } from "../services/label/labelService.js";

function sendErr(res, err) {
  const status = err.statusCode || 400;
  res.status(status).json({
    message: err.message || "Label request failed",
    code: err.code || undefined,
  });
}

export async function getSettings(req, res) {
  try {
    const settings = await labelSettings.getLabelSettings(req.companyId);
    res.json({ ...settings, labelSize: getFixedLabelSize(), template: "MARIVOLT STANDARD LABEL" });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function putSettings(req, res) {
  try {
    const settings = await labelSettings.upsertLabelSettings(
      req.companyId,
      req.body || {},
      req.user?.name || req.user?.email || ""
    );
    res.json(settings);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listPrinters(req, res) {
  try {
    const rows = await printerManager.listPrinters(req.companyId);
    res.json({ items: rows });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function upsertPrinter(req, res) {
  try {
    const row = await printerManager.upsertPrinter(
      req.companyId,
      req.body || {},
      req.user?.name || ""
    );
    res.status(201).json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listTemplates(req, res) {
  try {
    const items = await templateService.listTemplates();
    res.json({ items, labelSize: getFixedLabelSize() });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function registerAgent(req, res) {
  try {
    const result = await labelService.registerPrintAgent(req, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listAgents(req, res) {
  try {
    const items = await labelService.listAgents(req.companyId);
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromGrn(req, res) {
  try {
    const job = await labelService.createJobsFromGrn(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listJobs(req, res) {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.sourceNo) filter.sourceNo = String(req.query.sourceNo).toUpperCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = await LabelPrintJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-tsplPayload")
      .lean();
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getJob(req, res) {
  try {
    const job = await LabelPrintJob.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json(job);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewJob(req, res) {
  try {
    const job = await LabelPrintJob.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json({
      jobNo: job.jobNo,
      templateCode: job.templateCode,
      labelSize: getFixedLabelSize(),
      lines: job.lines,
      requestedLabels: job.requestedLabels,
      status: job.status,
      tsplLength: (job.tsplPayload || "").length,
      tsplPreview: String(job.tsplPayload || "").slice(0, 2000),
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function retryJob(req, res) {
  try {
    const job = await labelService.retryJob(req, req.params.id);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function confirmPartial(req, res) {
  try {
    const job = await labelService.confirmPartial(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function resolveUncertain(req, res) {
  try {
    const job = await labelService.resolveUncertain(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function cancelJob(req, res) {
  try {
    const job = await labelService.cancelJob(req, req.params.id);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function reprintJob(req, res) {
  try {
    const job = await labelService.reprintJob(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function stockReprint(req, res) {
  try {
    const job = await labelService.createStockReprint(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function jobHistory(req, res) {
  try {
    const items = await LabelPrintHistory.find({
      companyId: req.companyId,
      jobId: req.params.id,
    })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export { recordLabelHistory, syncGrnLabelStatus };
