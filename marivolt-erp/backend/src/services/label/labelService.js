import {
  getLabelSettings,
  verifyBootstrapToken,
  incrementBootstrapUseCount,
} from "./labelSettingsService.js";
import {
  resolvePrinterForJob,
  touchPrinterLastPrint,
} from "./printerManager.js";
import {
  MARIVOLT_STANDARD_TEMPLATE_CODE,
  ensureMarivoltStandardTemplate,
  getStandardTemplate,
} from "./labelTemplateService.js";
import { requeueJob } from "./printQueue.js";
import { auditLabelEvent, auditLabelAdminEvent, recordLabelHistory } from "./labelAudit.js";
import {
  clampStr,
  normalizePrinterNames,
  normalizePrinterStatusList,
  resolveMappedPrinterHealth,
  sanitizeAppVersion,
  HEARTBEAT_LIMITS,
  AGENT_ONLINE_MS,
  isAgentOnline,
} from "./labelRoutingHelpers.js";
import PrinterConfig from "../../models/PrinterConfig.js";
import Warehouse from "../../models/Warehouse.js";
import Branch from "../../models/Branch.js";
import Company from "../../models/Company.js";
import crypto from "crypto";
import bcrypt from "bcrypt";
import mongoose from "mongoose";
import GRN from "../../models/GRN.js";
import PrintAgent from "../../models/PrintAgent.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";
import { buildJobTspl, buildTestLabelTspl } from "./tsplGenerator.js";
import {
  resolveLabelCompanyBranding,
  resolveLabelTestTitle,
} from "./labelCompanyBranding.js";
import {
  distributeByLabelCount,
  validateGrnLabelLinePrintConfig,
  buildGrnLabelConfigFingerprint,
} from "../../utils/grnLabelDistribution.js";

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
  const sourceType = String(job.sourceType || "").toUpperCase();
  if (sourceType && sourceType !== "GRN") return;
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

async function loadLabelCompanyBranding(companyId) {
  const company = await Company.findById(companyId).select("code name shortName").lean();
  return {
    company,
    companyName: resolveLabelCompanyBranding(company),
    testTitle: resolveLabelTestTitle(company),
  };
}

function countRequestedPhysicalLabels(jobLines, copies = 1) {
  const c = Math.max(1, Number(copies) || 1);
  return (jobLines || []).reduce((s, ln) => {
    if (Array.isArray(ln.labelDistribution) && ln.labelDistribution.length > 0) {
      return s + ln.labelDistribution.length * c;
    }
    return s + Math.max(0, Number(ln.labelQty) || 0) * c;
  }, 0);
}

function isAsnLabelJob(job) {
  return String(job?.sourceType || "").toUpperCase() === "ASN";
}

async function assertAsnViewForAsnLabelJob(req, job) {
  if (!isAsnLabelJob(job)) return;
  const { hasPermission, normaliseRoleCode } = await import("../roleService.js");
  const role = normaliseRoleCode(req.user?.role || "");
  if (role === "SUPER_ADMIN") return;
  if (await hasPermission(req, "ASN", "view")) return;
  const err = new Error("Permission denied: ASN.view is required for ASN label jobs");
  err.statusCode = 403;
  err.code = "PERMISSION_DENIED";
  throw err;
}

function tsplOptsForJob(job, { copies, companyName } = {}) {
  if (isAsnLabelJob(job)) {
    return {
      copies: copies ?? job.copies ?? 1,
      companyName,
      barcodeMode: "LABEL_ID",
      faceVariant: "ASN_RU",
    };
  }
  return {
    copies: copies ?? job.copies ?? 1,
    companyName,
    barcodeMode: "ARTICLE",
  };
}

/**
 * Build one GRN job line from GRN item + optional client selection.
 * New fields: qtyPerLabel / labelCount / labelDistribution.
 * Legacy: labelQty alone → unit stickers (Qty:1 × N), unchanged.
 */
function buildGrnJobLineFromSelection({
  item = {},
  article,
  poLineId,
  receivedQty,
  sel,
  grnNo,
  poNo,
  receivedDate,
  barcodeMode = "ARTICLE",
  allowLegacyUnitStickers = true,
  locationOverride,
} = {}) {
  const hasNewFields =
    sel &&
    (sel.qtyPerLabel != null ||
      sel.labelQtyPerLabel != null ||
      sel.labelCount != null ||
      sel.noOfLabels != null ||
      (Array.isArray(sel.labelDistribution) && sel.labelDistribution.length > 0));

  let labelDistribution;
  let qtyPerLabel = 0;
  let labelCount = 0;
  let labelQty = 0;

  if (hasNewFields) {
    const qtyPer =
      sel.qtyPerLabel != null && sel.qtyPerLabel !== ""
        ? Number(sel.qtyPerLabel)
        : sel.labelQtyPerLabel != null && sel.labelQtyPerLabel !== ""
          ? Number(sel.labelQtyPerLabel)
          : undefined;
    const countRaw =
      sel.labelCount != null && sel.labelCount !== ""
        ? Number(sel.labelCount)
        : sel.noOfLabels != null && sel.noOfLabels !== ""
          ? Number(sel.noOfLabels)
          : undefined;

    const validated = validateGrnLabelLinePrintConfig({
      print: true,
      article,
      receivedQty,
      qtyPerLabel: Number.isFinite(qtyPer) && qtyPer > 0 ? qtyPer : undefined,
      labelCount: Number.isFinite(countRaw) && countRaw > 0 ? countRaw : undefined,
      labelDistribution: Array.isArray(sel.labelDistribution) ? sel.labelDistribution : undefined,
    });
    if (!validated.ok) {
      const err = new Error(validated.message || `Invalid label config for ${article}`);
      err.code = "LABEL_DISTRIBUTION_INVALID";
      err.statusCode = 400;
      throw err;
    }
    labelDistribution = validated.distribution;
    qtyPerLabel = Number(validated.qtyPerLabel) || qtyPer;
    labelCount = labelDistribution.length;
    labelQty = labelCount;
  } else {
    // Legacy path: labelQty = number of unit stickers
    let legacyQty = receivedQty;
    if (sel && sel.labelQty != null && sel.labelQty !== "") {
      legacyQty = Number(sel.labelQty);
    }
    if (!Number.isFinite(legacyQty) || legacyQty < 0) {
      const err = new Error(`Label Qty must be a non-negative number for ${article || "line"}`);
      err.code = "LABEL_QTY_INVALID";
      err.statusCode = 400;
      throw err;
    }
    legacyQty = Math.floor(legacyQty);
    if (legacyQty <= 0) return null;
    if (legacyQty > receivedQty + 1e-9) {
      const err = new Error(
        `Label Qty (${legacyQty}) cannot exceed received qty (${receivedQty}) for ${article}`
      );
      err.code = "LABEL_QTY_EXCEEDS_RECEIVED";
      err.statusCode = 400;
      throw err;
    }
    if (!allowLegacyUnitStickers) {
      // Compact default: one physical label of the received qty (not one sticker per piece).
      labelDistribution = distributeByLabelCount(receivedQty > 0 ? receivedQty : legacyQty, 1);
      qtyPerLabel = labelDistribution[0] || receivedQty || legacyQty;
      labelCount = labelDistribution.length;
      labelQty = labelCount;
    } else {
      labelQty = legacyQty;
      qtyPerLabel = 1;
      labelCount = legacyQty;
      // omit labelDistribution → TSPL emits Qty:1 × labelQty (legacy)
    }
  }

  const barcode = encodeBarcodeValue({ mode: barcodeMode, article });
  return {
    article,
    description: t(item.description),
    spn: t(item.spn || item.partNumber),
    materialCode: t(item.materialCode),
    qty: receivedQty,
    uom: t(item.uom) || "PCS",
    poNo: t(poNo),
    grnNo: t(grnNo),
    receivedDate: t(receivedDate),
    location: t(locationOverride != null ? locationOverride : item.location),
    barcodeValue: barcode.value,
    labelQty,
    qtyPerLabel,
    labelCount,
    ...(labelDistribution ? { labelDistribution } : {}),
    poLineId,
  };
}

export async function linkPrepostJobsToGrn(companyId, draftRef, grnNo) {
  const ref = upper(draftRef);
  const no = upper(grnNo);
  if (!ref || !no || !companyId) return { modifiedCount: 0 };
  const res = await LabelPrintJob.updateMany(
    {
      companyId,
      sourceType: "GRN_PREPOST",
      draftRef: ref,
      $or: [{ linkedGrnNo: "" }, { linkedGrnNo: null }, { linkedGrnNo: { $exists: false } }],
    },
    { $set: { linkedGrnNo: no } }
  );
  return { modifiedCount: res?.modifiedCount || 0 };
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

  const idempotencyKey = t(body.idempotencyKey).slice(0, 120) || null;
  if (idempotencyKey) {
    const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
    if (existing) return existing;
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
  const warehouseHint =
    upper(body.warehouseCode) ||
    upper(grn.warehouseCode) ||
    upper((grn.items || []).find((it) => it.warehouse)?.warehouse) ||
    "";
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: warehouseHint,
  });
  const copies = Math.max(1, Number(body.copies) || settings.defaultCopies || 1);

  const selection = Array.isArray(body.lines) ? body.lines : null;
  const jobLines = [];
  for (const item of grn.items || []) {
    const article = upper(item.article);
    const poLineId = item.poLineId != null ? String(item.poLineId) : "";
    const receivedQty = Number(item.acceptedQty ?? item.receivedQty) || 0;
    let include = true;
    let sel = null;
    if (selection) {
      sel = selection.find(
        (s) =>
          (poLineId && String(s.poLineId) === poLineId) ||
          (s.article && upper(s.article) === article)
      );
      if (!sel || sel.print === false) include = false;
    }
    if (!include) continue;

    const built = buildGrnJobLineFromSelection({
      item,
      article,
      poLineId,
      receivedQty,
      sel,
      grnNo,
      poNo: t(item.poNo || grn.poNo),
      receivedDate: formatReceivedDate(grn.grnDate || grn.postedAt),
      barcodeMode: template?.barcodeMode || "ARTICLE",
      allowLegacyUnitStickers: true,
    });
    if (!built) continue;
    jobLines.push(built);
  }

  if (!jobLines.length) {
    const err = new Error("No label lines selected for printing");
    err.code = "LABEL_NO_LINES";
    err.statusCode = 400;
    throw err;
  }

  const requestedLabels = countRequestedPhysicalLabels(jobLines, copies);
  if (requestedLabels > settings.maxPerJob) {
    const err = new Error(`Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`);
    err.code = "LABEL_MAX_EXCEEDED";
    err.statusCode = 400;
    throw err;
  }

  const fingerprint =
    t(body.labelConfigFingerprint).slice(0, 500) ||
    buildGrnLabelConfigFingerprint(
      jobLines.map((ln) => ({
        poLineId: ln.poLineId,
        article: ln.article,
        print: true,
        receivedQty: ln.qty,
        qtyPerLabel: ln.qtyPerLabel,
        labelCount: ln.labelCount,
        labelDistribution: ln.labelDistribution,
      }))
    );

  const { companyName } = await loadLabelCompanyBranding(companyId);
  const tsplPayload = buildJobTspl(jobLines, {
    copies,
    companyName,
    barcodeMode: template?.barcodeMode || "ARTICLE",
  });

  let job;
  try {
    job = await LabelPrintJob.create({
      companyId,
      jobNo: jobNo(),
      sourceType: "GRN",
      sourceId: grn._id,
      sourceNo: grnNo,
      draftRef: t(body.draftRef).toUpperCase().slice(0, 80),
      linkedGrnNo: grnNo,
      labelConfigFingerprint: fingerprint,
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
      idempotencyKey,
    });
  } catch (e) {
    if (idempotencyKey && (e?.code === 11000 || String(e?.message || "").includes("duplicate"))) {
      const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
      if (existing) return existing;
    }
    throw e;
  }

  // Link any matching pre-post jobs to this GRN (additive; do not rewrite history).
  if (body.draftRef) {
    await linkPrepostJobsToGrn(companyId, body.draftRef, grnNo);
  }

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

/**
 * Pre-GRN label print — queue only. ZERO stock / PO / GRN / customs side effects.
 * Uses draftRef (GRN-DRAFT-…) as sourceNo; does not allocate a real GRN number.
 */
export async function createJobsFromGrnPrepost(req, body = {}) {
  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled. Enable it in Label Settings.");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }

  const draftRef = upper(body.draftRef || body.draftNo);
  if (!draftRef || !draftRef.startsWith("GRN-DRAFT")) {
    const err = new Error("draftRef is required (GRN-DRAFT-…)");
    err.code = "DRAFT_REF_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const idempotencyKey = t(body.idempotencyKey).slice(0, 120) || null;
  if (idempotencyKey) {
    const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
    if (existing) return existing;
  }

  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  if (!linesIn.length) {
    const err = new Error("No label lines selected for printing");
    err.code = "LABEL_NO_LINES";
    err.statusCode = 400;
    throw err;
  }

  await ensureMarivoltStandardTemplate();
  const template = await getStandardTemplate();
  const warehouseHint = upper(body.warehouseCode) || "";
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: warehouseHint,
  });
  const copies = Math.max(1, Number(body.copies) || settings.defaultCopies || 1);
  const poNo = t(body.poNo);
  const receivedDate = formatReceivedDate(body.receivedDate || new Date());

  const jobLines = [];
  for (const sel of linesIn) {
    if (sel?.print === false) continue;
    const article = upper(sel.article);
    if (!article) {
      const err = new Error("article is required on each print line");
      err.statusCode = 400;
      throw err;
    }
    const receivedQty = Number(sel.receivedQty ?? sel.grnQty) || 0;
    const built = buildGrnJobLineFromSelection({
      item: {
        description: sel.description,
        spn: sel.spn || sel.partNumber,
        materialCode: sel.materialCode,
        uom: sel.uom,
        location: sel.location,
      },
      article,
      poLineId: sel.poLineId != null ? String(sel.poLineId) : "",
      receivedQty,
      sel: {
        ...sel,
        print: true,
        // Force distribution mode for pre-post (no silent legacy unit-only ambiguity when new fields sent)
        qtyPerLabel: sel.qtyPerLabel ?? sel.labelQtyPerLabel,
        labelCount: sel.labelCount ?? sel.noOfLabels,
        labelDistribution: sel.labelDistribution,
        labelQty: sel.labelQty,
      },
      grnNo: draftRef,
      poNo: t(sel.poNo || poNo),
      receivedDate,
      barcodeMode: template?.barcodeMode || "ARTICLE",
      allowLegacyUnitStickers: false,
      locationOverride: sel.location,
    });
    if (built) jobLines.push(built);
  }

  if (!jobLines.length) {
    const err = new Error("No label lines selected for printing");
    err.code = "LABEL_NO_LINES";
    err.statusCode = 400;
    throw err;
  }

  const requestedLabels = countRequestedPhysicalLabels(jobLines, copies);
  if (requestedLabels > settings.maxPerJob) {
    const err = new Error(`Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`);
    err.code = "LABEL_MAX_EXCEEDED";
    err.statusCode = 400;
    throw err;
  }

  const fingerprint =
    t(body.labelConfigFingerprint).slice(0, 500) ||
    buildGrnLabelConfigFingerprint(
      jobLines.map((ln) => ({
        poLineId: ln.poLineId,
        article: ln.article,
        print: true,
        receivedQty: ln.qty,
        qtyPerLabel: ln.qtyPerLabel,
        labelCount: ln.labelCount,
        labelDistribution: ln.labelDistribution,
      }))
    );

  const { companyName } = await loadLabelCompanyBranding(companyId);
  const tsplPayload = buildJobTspl(jobLines, {
    copies,
    companyName,
    barcodeMode: template?.barcodeMode || "ARTICLE",
  });

  let job;
  try {
    job = await LabelPrintJob.create({
      companyId,
      jobNo: jobNo(),
      sourceType: "GRN_PREPOST",
      sourceId: null,
      sourceNo: draftRef,
      draftRef,
      linkedGrnNo: "",
      labelConfigFingerprint: fingerprint,
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
      idempotencyKey,
    });
  } catch (e) {
    if (idempotencyKey && (e?.code === 11000 || String(e?.message || "").includes("duplicate"))) {
      const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
      if (existing) return existing;
    }
    throw e;
  }

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
    event: "ENQUEUE_PREPOST",
  });
  await auditLabelEvent(req, {
    action: "CREATE",
    job,
    description: `Pre-GRN label job ${job.jobNo} queued draft=${draftRef} po=${poNo || "—"}`,
  });

  return job;
}

export async function registerPrintAgent(req, body = {}) {
  const companyId = req.companyId;
  const name = clampStr(body.name || body.agentName || "Warehouse Print Agent", 120) || "Warehouse Print Agent";
  const warehouseCode = upper(body.warehouseCode);
  const agentId = upper(body.agentId) || `AGT${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const installationId = clampStr(body.installationId, 80);
  const secret = crypto.randomBytes(24).toString("base64url");
  const secretHash = await bcrypt.hash(secret, 10);

  const existing = await PrintAgent.findOne({ agentId });
  if (existing) {
    const err = new Error("agentId already exists");
    err.statusCode = 409;
    throw err;
  }
  if (installationId) {
    const byInstall = await PrintAgent.findOne({ companyId, installationId }).lean();
    if (byInstall) {
      const err = new Error("An agent is already registered for this installation");
      err.code = "AGENT_INSTALLATION_EXISTS";
      err.statusCode = 409;
      err.existingAgentId = byInstall.agentId;
      throw err;
    }
  }

  let warehouseName = clampStr(body.warehouseName, 120);
  let warehouseId = body.warehouseId || null;
  let branchId = body.branchId || null;
  let branchName = clampStr(body.branchName, 120);
  if (warehouseCode) {
    const wh = await Warehouse.findOne({ companyId, warehouseCode, isActive: true }).lean();
    if (wh) {
      warehouseId = wh._id;
      warehouseName = warehouseName || wh.warehouseName || "";
      if (!branchId && wh.branchId) branchId = wh.branchId;
    }
  }
  if (branchId && !branchName) {
    const br = await Branch.findOne({ _id: branchId, companyId }).lean();
    if (br) branchName = br.branchName || "";
  }

  const agent = await PrintAgent.create({
    companyId,
    agentId,
    installationId,
    name,
    computerName: clampStr(body.computerName, HEARTBEAT_LIMITS.computerName),
    warehouseId,
    warehouseCode,
    warehouseName,
    branchId,
    branchName,
    department: clampStr(body.department, HEARTBEAT_LIMITS.department),
    description: clampStr(body.description, HEARTBEAT_LIMITS.description),
    operatingSystem: clampStr(body.operatingSystem, HEARTBEAT_LIMITS.operatingSystem),
    windowsVersion: clampStr(body.windowsVersion, HEARTBEAT_LIMITS.windowsVersion),
    availablePrinters: normalizePrinterNames(body.availablePrinters || []),
    secretHash,
    status: "OFFLINE",
    isActive: true,
    createdBy: t(req.user?.name || req.user?.email || body.createdBy || ""),
  });

  await auditLabelAdminEvent(req, {
    action: "CREATE",
    entityType: "PrintAgent",
    entityId: agent._id,
    documentNo: agentId,
    description: `Agent Registered: ${agentId} (${name})`,
    metadata: { warehouseCode, computerName: agent.computerName, installationId },
  });

  return {
    agent: sanitizeAgent(agent.toObject ? agent.toObject() : agent),
    secret,
    message: "Store this secret securely. It will not be shown again.",
  };
}

function sanitizeAgent(a) {
  if (!a) return a;
  const { secretHash, ...rest } = a;
  return rest;
}

function effectiveAgentStatus(a, now = Date.now()) {
  if (a.isActive === false) return "DISABLED";
  return isAgentOnline(a, now) ? "ONLINE" : "OFFLINE";
}

export async function listAgents(companyId, query = {}) {
  const filter = { companyId };
  const q = t(query.q || query.search).toLowerCase();
  const warehouseCode = upper(query.warehouseCode || query.warehouse);
  const branch = t(query.branch || query.branchName);
  const status = upper(query.status);
  const printer = t(query.printer);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
  const offset = Math.max(0, Number(query.offset) || 0);

  if (warehouseCode) filter.warehouseCode = warehouseCode;
  if (branch) filter.branchName = new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (status === "DISABLED") filter.isActive = false;
  else if (status === "ONLINE" || status === "OFFLINE") filter.isActive = true;

  let agents = await PrintAgent.find(filter).sort({ createdAt: -1 }).lean();
  const now = Date.now();
  // UTC day boundary — company local TZ is a known Phase-1 limitation
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const agentIds = agents.map((a) => a.agentId);
  const printers = agentIds.length
    ? await PrinterConfig.find({ companyId, agentId: { $in: agentIds } }).lean()
    : [];
  const printersByAgent = new Map();
  for (const p of printers) {
    const list = printersByAgent.get(p.agentId) || [];
    list.push(p);
    printersByAgent.set(p.agentId, list);
  }

  const companyOid = new mongoose.Types.ObjectId(String(companyId));
  let pendingAgg = [];
  let completedAgg = [];
  let failedAgg = [];
  if (agentIds.length) {
    [pendingAgg, completedAgg, failedAgg] = await Promise.all([
      LabelPrintJob.aggregate([
        { $match: { companyId: companyOid, agentId: { $in: agentIds }, status: "PENDING" } },
        { $group: { _id: "$agentId", count: { $sum: 1 } } },
      ]),
      LabelPrintJob.aggregate([
        {
          $match: {
            companyId: companyOid,
            agentId: { $in: agentIds },
            status: "COMPLETED",
            updatedAt: { $gte: startOfDay },
          },
        },
        { $group: { _id: "$agentId", count: { $sum: 1 } } },
      ]),
      LabelPrintJob.aggregate([
        {
          $match: {
            companyId: companyOid,
            agentId: { $in: agentIds },
            status: "FAILED",
            updatedAt: { $gte: startOfDay },
          },
        },
        { $group: { _id: "$agentId", count: { $sum: 1 } } },
      ]),
    ]);
  }
  const pendingMap = Object.fromEntries(pendingAgg.map((r) => [r._id, r.count]));
  const completedMap = Object.fromEntries(completedAgg.map((r) => [r._id, r.count]));
  const failedMap = Object.fromEntries(failedAgg.map((r) => [r._id, r.count]));

  let rows = agents.map((a) => {
    const effectiveStatus = effectiveAgentStatus(a, now);
    const agentPrinters = printersByAgent.get(a.agentId) || [];
    return {
      ...sanitizeAgent(a),
      effectiveStatus,
      printers: agentPrinters.map((p) => {
        const health = resolveMappedPrinterHealth(a, p.windowsPrinterName, {
          agentOnline: effectiveStatus === "ONLINE",
        });
        return {
          code: p.code,
          displayName: p.displayName,
          windowsPrinterName: p.windowsPrinterName,
          isDefault: p.isDefault,
          isWarehouseDefault: p.isWarehouseDefault,
          isActive: p.isActive,
          ...health,
        };
      }),
      pendingJobs: pendingMap[a.agentId] || 0,
      completedToday: completedMap[a.agentId] || 0,
      failedToday: failedMap[a.agentId] || 0,
    };
  });

  if (status === "ONLINE" || status === "OFFLINE") {
    rows = rows.filter((a) => a.effectiveStatus === status);
  }
  if (printer) {
    const needle = printer.toLowerCase();
    rows = rows.filter(
      (a) =>
        (a.printers || []).some(
          (p) =>
            String(p.code).toLowerCase().includes(needle) ||
            String(p.windowsPrinterName).toLowerCase().includes(needle) ||
            String(p.displayName).toLowerCase().includes(needle)
        ) ||
        (a.availablePrinters || []).some((n) => String(n).toLowerCase().includes(needle))
    );
  }
  if (q) {
    rows = rows.filter((a) => {
      const hay = [
        a.agentId,
        a.name,
        a.computerName,
        a.warehouseCode,
        a.warehouseName,
        a.branchName,
        a.department,
        a.description,
        ...(a.printers || []).map((p) => `${p.code} ${p.windowsPrinterName}`),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  const total = rows.length;
  return { items: rows.slice(offset, offset + limit), total, limit, offset, onlineThresholdMs: AGENT_ONLINE_MS };
}

export async function getAgent(companyId, agentId) {
  const id = upper(agentId);
  const { items } = await listAgents(companyId, { limit: 500 });
  const found = items.find((a) => a.agentId === id);
  if (!found) {
    const err = new Error("Print agent not found");
    err.statusCode = 404;
    throw err;
  }
  return found;
}

export async function updatePrintAgent(req, agentId, body = {}) {
  const agent = await PrintAgent.findOne({ companyId: req.companyId, agentId: upper(agentId) });
  if (!agent) {
    const err = new Error("Print agent not found");
    err.statusCode = 404;
    throw err;
  }
  const fields = [
    "name",
    "computerName",
    "department",
    "description",
    "operatingSystem",
    "windowsVersion",
    "warehouseName",
    "branchName",
  ];
  for (const f of fields) {
    if (body[f] != null) agent[f] = t(body[f]);
  }
  if (body.agentName != null) agent.name = t(body.agentName);
  if (body.warehouseCode != null) {
    agent.warehouseCode = upper(body.warehouseCode);
    const wh = await Warehouse.findOne({
      companyId: req.companyId,
      warehouseCode: agent.warehouseCode,
    }).lean();
    if (wh) {
      agent.warehouseId = wh._id;
      agent.warehouseName = wh.warehouseName || agent.warehouseName;
      if (wh.branchId) agent.branchId = wh.branchId;
    }
  }
  if (body.branchId != null) agent.branchId = body.branchId || null;
  if (Array.isArray(body.availablePrinters)) {
    agent.availablePrinters = body.availablePrinters.map((p) => String(p).trim()).filter(Boolean).slice(0, 100);
  }
  await agent.save();
  await auditLabelAdminEvent(req, {
    action: "UPDATE",
    entityType: "PrintAgent",
    entityId: agent._id,
    documentNo: agent.agentId,
    description: `Agent updated: ${agent.agentId}`,
  });
  return sanitizeAgent(agent.toObject());
}

export async function setAgentActive(req, agentId, isActive) {
  const agent = await PrintAgent.findOne({ companyId: req.companyId, agentId: upper(agentId) });
  if (!agent) {
    const err = new Error("Print agent not found");
    err.statusCode = 404;
    throw err;
  }
  agent.isActive = Boolean(isActive);
  if (!isActive) agent.status = "OFFLINE";
  await agent.save();
  await auditLabelAdminEvent(req, {
    action: "UPDATE",
    entityType: "PrintAgent",
    entityId: agent._id,
    documentNo: agent.agentId,
    description: isActive ? `Agent Enabled: ${agent.agentId}` : `Agent Disabled: ${agent.agentId}`,
    metadata: { isActive: Boolean(isActive) },
  });
  return sanitizeAgent(agent.toObject());
}

export async function rotateAgentSecret(req, agentId) {
  const agent = await PrintAgent.findOne({ companyId: req.companyId, agentId: upper(agentId) });
  if (!agent) {
    const err = new Error("Print agent not found");
    err.statusCode = 404;
    throw err;
  }
  const secret = crypto.randomBytes(24).toString("base64url");
  agent.secretHash = await bcrypt.hash(secret, 10);
  await agent.save();
  await auditLabelAdminEvent(req, {
    action: "UPDATE",
    entityType: "PrintAgent",
    entityId: agent._id,
    documentNo: agent.agentId,
    description: `Secret Rotated: ${agent.agentId}`,
  });
  return {
    agentId: agent.agentId,
    secret,
    message: "Store this secret securely. It will not be shown again.",
  };
}

/**
 * First-launch self-registration using company-scoped bootstrap token.
 * Idempotent on companyId + installationId.
 * Does not auto-create PrinterConfig (admin must map printers).
 */
export async function bootstrapRegisterAgent(body = {}, reqMeta = {}) {
  const companyId = body.companyId;
  const bootstrapToken = t(body.bootstrapToken || body.token);
  const installationId = clampStr(body.installationId, 80);
  if (!companyId || !bootstrapToken) {
    const err = new Error("companyId and bootstrapToken are required");
    err.statusCode = 400;
    throw err;
  }
  if (!installationId) {
    const err = new Error("installationId is required for bootstrap");
    err.code = "AGENT_INSTALLATION_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const material = await verifyBootstrapToken(companyId, bootstrapToken);

  // Idempotent: same installation returns existing agent (no new secret)
  const existing = await PrintAgent.findOne({ companyId, installationId }).lean();
  if (existing) {
    await auditLabelAdminEvent(
      { companyId, user: { name: "agent-bootstrap" }, ip: reqMeta.ip },
      {
        action: "OTHER",
        entityType: "PrintAgent",
        entityId: existing._id,
        documentNo: existing.agentId,
        description: `Bootstrap idempotent hit for installation ${installationId}`,
        metadata: { installationId },
      }
    );
    return {
      agent: sanitizeAgent(existing),
      secret: null,
      idempotent: true,
      message: "Agent already registered for this installation. Use existing config secret.",
    };
  }

  let warehouseCode = upper(body.warehouseCode);
  if (material.warehouse) {
    if (warehouseCode && warehouseCode !== material.warehouse) {
      const err = new Error(`Bootstrap token is scoped to warehouse ${material.warehouse}`);
      err.code = "AGENT_BOOTSTRAP_WAREHOUSE_MISMATCH";
      err.statusCode = 403;
      throw err;
    }
    warehouseCode = material.warehouse;
  }

  const fakeReq = {
    companyId,
    user: { name: "agent-bootstrap" },
    ip: reqMeta.ip,
  };
  const result = await registerPrintAgent(fakeReq, {
    name: body.name || body.agentName,
    warehouseCode,
    warehouseName: body.warehouseName,
    branchId: body.branchId,
    branchName: body.branchName,
    department: body.department,
    description: body.description,
    computerName: body.computerName,
    operatingSystem: body.operatingSystem,
    windowsVersion: body.windowsVersion,
    availablePrinters: body.availablePrinters,
    installationId,
    createdBy: "agent-bootstrap",
  });

  await incrementBootstrapUseCount(companyId);
  await auditLabelAdminEvent(fakeReq, {
    action: "CREATE",
    entityType: "PrintAgent",
    entityId: result.agent?._id,
    documentNo: result.agent?.agentId,
    description: `Agent Registered via bootstrap: ${result.agent?.agentId}`,
    metadata: { installationId, warehouseCode },
  });

  return { ...result, idempotent: false };
}

export async function applyAgentHeartbeat(agent, body = {}, req = {}) {
  // Heartbeat may update telemetry only — never company, branch, warehouse, name, isActive
  agent.status = "ONLINE";
  agent.lastHeartbeatAt = new Date();
  agent.lastIp = clampStr(
    req.ip || req.headers?.["x-forwarded-for"] || agent.lastIp || "",
    HEARTBEAT_LIMITS.lastIp
  );
  const computerName = clampStr(body.computerName, HEARTBEAT_LIMITS.computerName);
  const appVersion = sanitizeAppVersion(body.appVersion);
  const operatingSystem = clampStr(body.operatingSystem, HEARTBEAT_LIMITS.operatingSystem);
  const windowsVersion = clampStr(body.windowsVersion, HEARTBEAT_LIMITS.windowsVersion);
  if (computerName) agent.computerName = computerName;
  if (appVersion) agent.appVersion = appVersion;
  if (operatingSystem) agent.operatingSystem = operatingSystem;
  if (windowsVersion) agent.windowsVersion = windowsVersion;
  if (Array.isArray(body.availablePrinters)) {
    agent.availablePrinters = normalizePrinterNames(body.availablePrinters);
  }
  if (Array.isArray(body.printerStatus)) {
    agent.printerStatus = normalizePrinterStatusList(body.printerStatus);
  } else if (body.printer && typeof body.printer === "object") {
    // Single primary printer object from newer agents
    agent.printerStatus = normalizePrinterStatusList([
      {
        name: body.printer.name,
        status: body.printer.status,
        connected: body.printer.connected,
        offline: body.printer.offline,
        paused: body.printer.paused,
        paperOut: body.printer.paperOut,
        queueLength: body.printer.queueLength,
        statusMessage: body.printer.statusMessage,
        lastSeen: body.printer.lastSeen,
        online: body.printer.status === "READY",
      },
    ]);
  }
  // agentStatus from payload is informational only — stored agent.status remains ONLINE on successful heartbeat
  if (body.lastError != null) {
    agent.lastError = clampStr(body.lastError, HEARTBEAT_LIMITS.lastError);
  }
  await agent.save();
  return agent;
}

export async function createTestPrintJob(req, { agentId, printerCode } = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    const err = new Error("Label printing is disabled");
    err.code = "LABEL_DISABLED";
    err.statusCode = 400;
    throw err;
  }
  let printer = null;
  if (printerCode) {
    const { getPrinter } = await import("./printerManager.js");
    printer = await getPrinter(req.companyId, printerCode);
    if (!printer || printer.isActive === false) {
      const err = new Error("Printer not found or disabled");
      err.statusCode = 400;
      throw err;
    }
  } else if (agentId) {
    printer = await PrinterConfig.findOne({
      companyId: req.companyId,
      agentId: upper(agentId),
      isActive: true,
    }).sort({ isDefault: -1, code: 1 });
    if (!printer) {
      const err = new Error("No active printer mapped to this agent");
      err.statusCode = 400;
      throw err;
    }
  } else {
    printer = await resolvePrinterForJob(req.companyId, null);
  }
  const agent = await PrintAgent.findOne({ companyId: req.companyId, agentId: printer.agentId }).lean();
  if (!agent || agent.isActive === false) {
    const err = new Error("Assigned print agent is disabled");
    err.statusCode = 400;
    throw err;
  }
  if (!String(printer.windowsPrinterName || "").trim()) {
    const err = new Error("Printer has no Windows printer name configured");
    err.statusCode = 400;
    throw err;
  }
  const { companyName, testTitle } = await loadLabelCompanyBranding(req.companyId);
  const tsplPayload = buildTestLabelTspl({
    agentId: printer.agentId,
    agentName: agent?.name || printer.agentId,
    printerName: printer.displayName || printer.code,
    windowsPrinterName: printer.windowsPrinterName,
    connectionStatus: effectiveAgentStatus(agent || { isActive: true, status: "OFFLINE" }),
    title: testTitle,
  });
  const job = await LabelPrintJob.create({
    companyId: req.companyId,
    jobNo: jobNo(),
    sourceType: "MANUAL",
    sourceId: null,
    sourceNo: "TEST",
    warehouseCode: printer.warehouseCode || "",
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: printer.windowsPrinterName,
    templateCode: MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies: 1,
    requestedLabels: 1,
    printedLabels: 0,
    remainingLabels: 1,
    lines: [
      {
        article: "TEST",
        description: testTitle,
        qty: 1,
        uom: "PCS",
        labelQty: 1,
        barcodeValue: "TEST",
      },
    ],
    tsplPayload,
    status: "PENDING",
    createdByUserId: req.user?.id || null,
    createdByName: t(req.user?.name || ""),
  });
  await recordLabelHistory({
    jobId: job._id,
    companyId: job.companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: 1,
    status: "PENDING",
    templateCode: job.templateCode,
    userName: job.createdByName,
    event: "TEST_PRINT",
  });
  await auditLabelAdminEvent(req, {
    action: "CREATE",
    entityType: "LabelPrintJob",
    entityId: job._id,
    documentNo: job.jobNo,
    description: `Test Print queued for agent ${job.agentId} / ${job.windowsPrinterName}`,
  });
  return job;
}

export { touchPrinterLastPrint };

export async function retryJob(req, jobId) {
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  await assertAsnViewForAsnLabelJob(req, job);
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
  const { companyName } = await loadLabelCompanyBranding(req.companyId);
  job.tsplPayload = buildJobTspl(linesForPrint, tsplOptsForJob(job, { copies: 1, companyName }));
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

export async function confirmPartial(req, jobId, printedQty, options = {}) {
  const {
    autoRetryRemaining = true,
    requireStatuses = ["PARTIAL", "PRINTING", "LEASED", "UNCERTAIN", "FAILED"],
    historyEvent = "CONFIRM_PARTIAL",
  } = options;
  const job = await LabelPrintJob.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) {
    const err = new Error("Job not found");
    err.statusCode = 404;
    throw err;
  }
  await assertAsnViewForAsnLabelJob(req, job);

  const { planManualPrintedQtyConfirmation, formatUncertainConfirmSuccessMessage } = await import(
    "../../utils/labelConfirmRules.js"
  );
  const planned = planManualPrintedQtyConfirmation({
    status: job.status,
    printedLabels: job.printedLabels,
    remainingLabels: job.remainingLabels,
    requestedLabels: job.requestedLabels,
    confirmedQty: printedQty,
    allowedStatuses: requireStatuses,
  });
  if (!planned.ok) {
    const err = new Error(planned.message);
    err.code = planned.code;
    err.statusCode = 400;
    throw err;
  }

  const $set = {
    printedLabels: planned.nextPrintedLabels,
    remainingLabels: planned.nextRemainingLabels,
    status: planned.nextStatus,
    leaseToken: "",
    leasedToAgentId: "",
    leaseExpiresAt: null,
  };
  if (planned.clearLastError) $set.lastError = "";

  const updated = await LabelPrintJob.findOneAndUpdate(
    {
      _id: job._id,
      companyId: req.companyId,
      status: job.status,
    },
    { $set },
    { new: true }
  );
  if (!updated) {
    const err = new Error(
      "Label job was already confirmed or changed by another request. Refresh the Label Queue and try again."
    );
    err.code = "LABEL_CONFIRM_CONFLICT";
    err.statusCode = 409;
    throw err;
  }

  await syncGrnLabelStatus(updated.sourceId, updated);
  let ruSync = { updated: 0, ruNos: [] };
  if (isAsnLabelJob(updated)) {
    const { applyReceivingUnitPrintResult } = await import("./asnLabelService.js");
    ruSync = await applyReceivingUnitPrintResult(updated);
    ruSync.ruNos = (updated.lines || [])
      .map((ln) => ln.ruNo || ln.labelId)
      .filter(Boolean);
  }
  await recordLabelHistory({
    jobId: updated._id,
    companyId: updated.companyId,
    agentId: updated.agentId,
    requestedQty: planned.wasRemaining,
    printedQty: planned.confirmedQty,
    status: updated.status,
    templateCode: updated.templateCode,
    userId: req.user?.id || null,
    userName: t(req.user?.name || ""),
    event: historyEvent,
    failureReason: `user confirmed printedQty=${planned.confirmedQty}; remaining=${updated.remainingLabels}`,
  });

  const message = formatUncertainConfirmSuccessMessage({
    confirmedQty: planned.confirmedQty,
    ruNos: ruSync.ruNos || [],
    jobStatus: updated.status,
  });

  if (autoRetryRemaining && updated.remainingLabels > 0) {
    const retried = await retryJob(req, jobId);
    return {
      job: retried,
      confirmedQty: planned.confirmedQty,
      receivingUnitNos: ruSync.ruNos || [],
      receivingUnitsPrinted: Number(ruSync.updated) || 0,
      message,
      autoRetriedRemaining: true,
    };
  }
  return {
    job: updated,
    confirmedQty: planned.confirmedQty,
    receivingUnitNos: ruSync.ruNos || [],
    receivingUnitsPrinted: Number(ruSync.updated) || 0,
    message,
    autoRetriedRemaining: false,
  };
}

/**
 * Operator verified physical labels after an UNCERTAIN agent result.
 * Does not enqueue another RAW print — remaining faces need explicit Retry.
 */
export async function resolveUncertain(req, jobId, printedQty) {
  return confirmPartial(req, jobId, printedQty, {
    autoRetryRemaining: false,
    requireStatuses: ["UNCERTAIN"],
    historyEvent: "RESOLVE_UNCERTAIN",
  });
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
  await assertAsnViewForAsnLabelJob(req, parent);
  const reason = t(body.reason);
  if (!reason) {
    const err = new Error("Reprint reason is required");
    err.statusCode = 400;
    throw err;
  }
  const copies = Math.max(1, Number(body.copies) || parent.copies || 1);
  let lines = parent.lines.map((ln) => ({ ...(ln.toObject?.() ?? ln) }));
  if (!isAsnLabelJob(parent) && Array.isArray(body.lines) && body.lines.length) {
    lines = body.lines.map((ln) => ({
      ...ln,
      article: upper(ln.article),
      barcodeValue: encodeBarcodeValue({ mode: "ARTICLE", article: ln.article }).value,
      labelQty: Math.max(1, Number(ln.labelQty) || 1),
    }));
  }
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode || null, {
    warehouseCode: upper(body.warehouseCode) || upper(parent.warehouseCode),
  });
  const requestedLabels = lines.reduce((s, ln) => {
    if (
      parent.sourceType === "PACKING" ||
      parent.sourceType === "CUSTOM_PACKING" ||
      parent.templateCode === "PACKING_STANDARD_100X50"
    ) {
      return s + Math.max(1, Number(ln.lineCopies || copies) || 1);
    }
    if (Array.isArray(ln.labelDistribution) && ln.labelDistribution.length > 0) {
      return s + ln.labelDistribution.length * copies;
    }
    return s + Math.max(0, Number(ln.labelQty) || 0) * copies;
  }, 0);
  const isPacking =
    parent.sourceType === "PACKING" ||
    parent.sourceType === "CUSTOM_PACKING" ||
    String(parent.templateCode || "").includes("PACKING");
  const { buildPackingJobTspl } = await import("./tsplGenerator.js");
  const { PACKING_STANDARD_TEMPLATE_CODE } = await import("./labelTemplateService.js");
  const { companyName } = await loadLabelCompanyBranding(req.companyId);
  const tsplPayload = isPacking
    ? buildPackingJobTspl(
        lines.map((ln) => ({
          ...ln,
          lineCopies: Math.max(1, Number(ln.lineCopies || copies) || 1),
        })),
        {}
      )
    : buildJobTspl(lines, tsplOptsForJob(parent, { copies, companyName }));
  const job = await LabelPrintJob.create({
    companyId: req.companyId,
    jobNo: jobNo(),
    sourceType: parent.sourceType,
    sourceId: parent.sourceId,
    sourceNo: parent.sourceNo,
    draftRef: parent.draftRef || "",
    linkedGrnNo: parent.linkedGrnNo || "",
    labelConfigFingerprint: parent.labelConfigFingerprint || "",
    warehouseCode: printer.warehouseCode,
    printerConfigId: printer._id,
    agentId: upper(printer.agentId),
    windowsPrinterName: printer.windowsPrinterName,
    templateCode: isPacking ? PACKING_STANDARD_TEMPLATE_CODE : MARIVOLT_STANDARD_TEMPLATE_CODE,
    copies: isPacking ? 1 : copies,
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
    packingMode: isPacking ? "REPRINT" : "",
    allocationId: parent.allocationId || null,
    packingId: parent.packingId || null,
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
  const printer = await resolvePrinterForJob(req.companyId, body.printerCode, {
    warehouseCode: upper(body.warehouseCode),
  });
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
  const { companyName } = await loadLabelCompanyBranding(req.companyId);
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
    tsplPayload: buildJobTspl([line], { copies, companyName }),
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
