import crypto from "crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import GRN from "../../models/GRN.js";
import PrintAgent from "../../models/PrintAgent.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";
import { buildJobTspl } from "./tsplGenerator.js";
import { getLabelSettings } from "./labelSettingsService.js";
import { resolvePrinterForJob } from "./printerManager.js";
import {
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  ensureMarivoltStandardTemplate,
  getStandardTemplate,
} from "./labelTemplateService.js";
import { requeueJob } from "./printQueue.js";
import { auditLabelEvent, recordLabelHistory } from "./labelAudit.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function jobNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `LBL${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function mapJobStatusToGrnLabelStatus(status) {
  switch (status) {
    case "PENDING":
    case "LEASED":
      return "QUEUED";
    case "PRINTING":
      return "PRINTING";
    case "COMPLETED":
      return "COMPLETED";
    case "PARTIAL":
      return "PARTIAL";
    case "FAILED":
      return "FAILED";
    case "UNCERTAIN":
      return "UNCERTAIN";
    case "CANCELLED":
      return "NOT_REQUESTED";
    default:
      return "QUEUED";
  }
}

export async function syncGrnLabelStatus(grnId, job) {
  if (!grnId || !job) return;
  await GRN.updateOne(
    { _id: grnId },
    {
      $set: {
        labelStatus: mapJobStatusToGrnLabelStatus(job.status),
        labelLastJobId: job._id,
      },
    }
  );
}

function formatReceivedDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return t(d).slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * Create label print job from a posted GRN. Does not touch stock.
 */
export async function createJobsFromGrn(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled. Enable it in Label Settings.");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }

  const grnNo = upper(body.grnNo);
  if (!grnNo) {
    const err = new Error("grnNo is required");
    err.statusCode = 400;
    throw err;
  }

  const grn = await GRN.findOne({ companyId, grnNo }).lean();
  if (!grn) {
    const err = new Error("GRN not found");
    err.statusCode = 404;
    throw err;
  }
  const st = upper(grn.status);
  if (!["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"].includes(st)) {
    const err = new Error("GRN must be posted before printing labels");
    err.statusCode = 400;
    throw err;
  }

  await ensureMarivoltStandardTemplate();
  const template = await getStandardTemplate();
  const printer = await resolvePrinterForJob(companyId, body.printerCode);
  const copies = Math.max(1, Number(body.copies) || settings.defaultCopies || 1);

  const selection = Array.isArray(body.lines) ? body.lines : null;
  const jobLines = [];
  for (const item of grn.items || []) {
    const article = upper(item.article);
    const poLineId = item.poLineId != null ? String(item.poLineId) : "";
    let labelQty = Number(item.acceptedQty ?? item.receivedQty) || 0;
    let include = true;
    if (selection) {
      const sel = selection.find(
        (s) =>
          (poLineId && String(s.poLineId) === poLineId) ||
          (s.article && upper(s.article) === article)
      );
      if (!sel || sel.print === false) {
        include = false;
      } else if (sel.labelQty != null && sel.labelQty !== "") {
        labelQty = Number(sel.labelQty) || 0;
      }
    }
    if (!include || labelQty <= 0) continue;
    const barcode = encodeBarcodeValue({
      mode: template?.barcodeMode || "ARTICLE",
      article,
    });
    jobLines.push({
      article,
      description: t(item.description),
      spn: t(item.spn || item.partNumber),
      materialCode: t(item.materialCode),
      qty: Number(item.acceptedQty ?? item.receivedQty) || 0,
      uom: t(item.uom) || "PCS",
      poNo: t(item.poNo || grn.poNo),
      grnNo,
      receivedDate: formatReceivedDate(grn.grnDate || grn.postedAt),
      location: t(item.location),
      barcodeValue: barcode.value,
      labelQty,
      poLineId,
    });
  }

  if (!jobLines.length) {
    const err = new Error("No label lines selected for printing");
    err.code = "LABEL_NO_LINES";
    err.statusCode = 400;
    throw err;
  }

  const requestedLabels = jobLines.reduce((s, ln) => s + Math.max(0, Number(ln.labelQty) || 0) * copies, 0);
  if (requestedLabels > settings.maxPerJob) {
    const err = new Error(`Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`);
    err.code = "LABEL_MAX_EXCEEDED";
    err.statusCode = 400;
    throw err;
  }

  const tsplPayload = buildJobTspl(jobLines, {
    copies,
    companyName: "MARIVOLT FZE",
    barcodeMode: template?.barcodeMode || "ARTICLE",
  });

  const job = await LabelPrintJob.create({
    companyId,
    jobNo: jobNo(),
    sourceType: "GRN",
    sourceId: grn._id,
    sourceNo: grnNo,
    warehouseCode: t(printer.warehouseCode),
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: t(printer.windowsPrinterName),
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies,
    requestedLabels,
    printedLabels: 0,
    remainingLabels: requestedLabels,
    lines: jobLines,
    tsplPayload,
    status: "PENDING",
    createdByUserId: req.user?.id || req.user?._id || null,
    createdByName: t(req.user?.name || req.user?.email || ""),
  });

  await syncGrnLabelStatus(grn._id, job);
  await recordLabelHistory({
    jobId: job._id,
    companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    printedQty: 0,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: "ENQUEUE",
  });
  await auditLabelEvent(req, {
    action: "CREATE",
    job,
    description: `Label job ${job.jobNo} queued for GRN ${grnNo}`,
  });

  return job;
}

export async function registerPrintAgent(req, body = {}) {
  const companyId = req.companyId;
  const name = t(body.name) || "Warehouse Print Agent";
  const warehouseCode = upper(body.warehouseCode);
  const agentId = upper(body.agentId) || `AGT${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const secret = crypto.randomBytes(24).toString("base64url");
  const secretHash = await bcrypt.hash(secret, 10);

  const existing = await PrintAgent.findOne({ agentId });
  if (existing) {
    const err = new Error("agentId already exists");
    err.statusCode = 409;
    throw err;
  }

  const agent = await PrintAgent.create({
    companyId,
    agentId,
    name,
    warehouseId: body.warehouseId || null,
    warehouseCode,
    secretHash,
    status: "OFFLINE",
    isActive: true,
    createdBy: t(req.user?.name || req.user?.email || ""),
  });

  return {
    agent: {
      _id: agent._id,
      agentId: agent.agentId,
      name: agent.name,
      warehouseCode: agent.warehouseCode,
      status: agent.status,
    },
    secret,
    message: "Store this secret securely. It will not be shown again.",
  };
}

export async function listAgents(companyId) {
  const agents = await PrintAgent.find({ companyId }).sort({ createdAt: -1 }).lean();
  const now = Date.now();
  return agents.map((a) => {
    const hb = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
    const online = a.status === "ONLINE" && hb && now - hb < 90_000;
    return { ...a, secretHash: undefined, effectiveStatus: online ? "ONLINE" : "OFFLINE" };
  });
}

export async function retryJob(req, jobId) {
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  if (job.status === "UNCERTAIN") {
    const err = new Error("Resolve UNCERTAIN job by confirming printed quantity before retry");
    err.code = "LABEL_UNCERTAIN_CONFIRM_REQUIRED";
    err.statusCode = 400;
    throw err;
  }
  if (!["FAILED", "PARTIAL", "CANCELLED"].includes(job.status)) {
    const err = new Error(`Cannot retry job in status ${job.status}`);
    err.statusCode = 400;
    throw err;
  }
  // Rebuild TSPL for remaining labels only
  const remaining = Math.max(0, Number(job.remainingLabels) || 0);
  if (remaining <= 0 && job.status === "FAILED") {
    job.remainingLabels = Number(job.requestedLabels) || 0;
  }
  const linesForPrint = scaleLinesToRemaining(job.lines, job.remainingLabels, job.copies);
  job.tsplPayload = buildJobTspl(linesForPrint, {
    copies: 1,
    companyName: "MARIVOLT FZE",
    barcodeMode: "ARTICLE",
  });
  job.retryCount = (Number(job.retryCount) || 0) + 1;
  await requeueJob(job);
  await syncGrnLabelStatus(job.sourceId, job);
  await recordLabelHistory({
    jobId: job._id,
    companyId: job.companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: job.remainingLabels,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: req.user?.id || null,
    userName: t(req.user?.name || ""),
    retryCount: job.retryCount,
    event: "RETRY",
  });
  await auditLabelEvent(req, { action: "OTHER", job, description: `Label job ${job.jobNo} retried` });
  return job;
}

function scaleLinesToRemaining(lines, remaining, copies) {
  const copyFactor = Math.max(1, Number(copies) || 1);
  let left = Math.max(0, Number(remaining) || 0);
  const out = [];
  for (const ln of lines || []) {
    if (left <= 0) break;
    const per = Math.max(0, Math.floor(Number(ln.labelQty) || 0)) * copyFactor;
    const take = Math.min(per, left);
    if (take > 0) {
      out.push({ ...ln.toObject?.() ?? ln, labelQty: take });
      left -= take;
    }
  }
  return out;
}

export async function confirmPartial(req, jobId, printedQty) {
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  if (!["PARTIAL", "PRINTING", "LEASED", "UNCERTAIN", "FAILED"].includes(job.status)) {
    const err = new Error(`Cannot confirm partial for status ${job.status}`);
    err.statusCode = 400;
    throw err;
  }
  const qty = Math.max(0, Number(printedQty) || 0);
  const wasRemaining = Number(job.remainingLabels) || Number(job.requestedLabels) || 0;
  job.printedLabels = (Number(job.printedLabels) || 0) + qty;
  job.remainingLabels = Math.max(0, wasRemaining - qty);
  job.status = job.remainingLabels > 0 ? "PARTIAL" : "COMPLETED";
  job.leaseToken = "";
  job.leasedToAgentId = "";
  job.leaseExpiresAt = null;
  await job.save();
  await syncGrnLabelStatus(job.sourceId, job);
  await recordLabelHistory({
    jobId: job._id,
    companyId: job.companyId,
    agentId: job.agentId,
    requestedQty: wasRemaining,
    printedQty: qty,
    status: job.status,
    templateCode: job.templateCode,
    userId: req.user?.id || null,
    userName: t(req.user?.name || ""),
    event: "CONFIRM_PARTIAL",
  });
  if (job.remainingLabels > 0) {
    return retryJob(req, jobId);
  }
  return job;
}

export async function resolveUncertain(req, jobId, printedQty) {
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  if (job.status !== "UNCERTAIN") {
    const err = new Error("Job is not UNCERTAIN");
    err.statusCode = 400;
    throw err;
  }
  return confirmPartial(req, jobId, printedQty);
}

export async function cancelJob(req, jobId) {
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  if (!["PENDING", "LEASED"].includes(job.status)) {
    const err = new Error(`Cannot cancel job in status ${job.status}`);
    err.statusCode = 400;
    throw err;
  }
  job.status = "CANCELLED";
  job.leaseToken = "";
  job.leasedToAgentId = "";
  job.leaseExpiresAt = null;
  await job.save();
  await syncGrnLabelStatus(job.sourceId, job);
  await auditLabelEvent(req, { action: "CANCEL", job, description: `Label job ${job.jobNo} cancelled` });
  return job;
}

export async function reprintJob(req, jobId, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.allowManualReprint) {
    const err = new Error("Manual reprint is disabled");
    err.statusCode = 403;
    throw err;
  }
  const parent = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!parent) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  const reason = t(body.reason);
  if (!reason) {
    const err = new Error("Reprint reason is required");
    err.statusCode = 400;
    throw err;
  }
  const copies = Math.max(1, Number(body.copies) || parent.copies || 1);
  let lines = parent.lines.map((ln) => ({ ...(ln.toObject?.() ?? ln) }));
  if (Array.isArray(body.lines) && body.lines.length) {
    lines = body.lines.map((ln) => ({
      ...ln,
      article: upper(ln.article),
      barcodeValue: encodeBarcodeValue({ mode: "ARTICLE", article: ln.article }).value,
      labelQty: Math.max(1, Number(ln.labelQty) || 1),
    }));
  }
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode || null);
  const requestedLabels = lines.reduce((s, ln) => s + Math.max(0, Number(ln.labelQty) || 0) * copies, 0);
  const tsplPayload = buildJobTspl(lines, { copies, companyName: "MARIVOLT FZE", barcodeMode: "ARTICLE" });
  const job = await LabelPrintJob.create({
    companyId: req.companyId,
    jobNo: jobNo(),
    sourceType: parent.sourceType,
    sourceId: parent.sourceId,
    sourceNo: parent.sourceNo,
    warehouseCode: printer.warehouseCode,
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: printer.windowsPrinterName,
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies,
    requestedLabels,
    printedLabels: 0,
    remainingLabels: requestedLabels,
    lines,
    tsplPayload,
    status: "PENDING",
    isReprint: true,
    reprintReason: reason,
    parentJobId: parent._id,
    createdByUserId: req.user?.id || null,
    createdByName: t(req.user?.name || ""),
  });
  await syncGrnLabelStatus(job.sourceId, job);
  await recordLabelHistory({
    jobId: job._id,
    companyId: job.companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: `REPRINT:${reason}`,
  });
  await auditLabelEvent(req, {
    action: "OTHER",
    job,
    description: `Label reprint ${job.jobNo} reason=${reason}`,
  });
  return job;
}

export async function createStockReprint(req, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }
  if (!settings.allowManualReprint) {
    const err = new Error("Manual reprint is disabled");
    err.statusCode = 403;
    throw err;
  }
  const article = upper(body.article);
  if (!article) {
    const err = new Error("article is required");
    err.statusCode = 400;
    throw err;
  }
  const labelQty = Math.max(1, Number(body.labelQty) || 1);
  const copies = Math.max(1, Number(body.copies) || settings.defaultCopies);
  const reason = t(body.reason) || "Replacement";
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode);
  const line = {
    article,
    description: t(body.description),
    spn: t(body.spn),
    materialCode: t(body.materialCode),
    qty: labelQty,
    uom: t(body.uom) || "PCS",
    poNo: t(body.poNo),
    grnNo: t(body.grnNo),
    receivedDate: t(body.receivedDate),
    location: t(body.location),
    barcodeValue: encodeBarcodeValue({ mode: "ARTICLE", article }).value,
    labelQty,
  };
  const requestedLabels = labelQty * copies;
  const job = await LabelPrintJob.create({
    companyId: req.companyId,
    jobNo: jobNo(),
    sourceType: "STOCK",
    sourceId: null,
    sourceNo: article,
    warehouseCode: printer.warehouseCode,
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: printer.windowsPrinterName,
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies,
    requestedLabels,
    printedLabels: 0,
    remainingLabels: requestedLabels,
    lines: [line],
    tsplPayload: buildJobTspl([line], { copies, companyName: "MARIVOLT FZE" }),
    status: "PENDING",
    isReprint: true,
    reprintReason: reason,
    createdByUserId: req.user?.id || null,
    createdByName: t(req.user?.name || ""),
  });
  await recordLabelHistory({
    jobId: job._id,
    companyId: job.companyId,
    agentId: job.agentId,
    requestedQty: requestedLabels,
    status: "PENDING",
    templateCode: job.templateCode,
    userName: job.createdByName,
    event: `STOCK_REPRINT:${reason}`,
  });
  return job;
}

export { mongoose };
