import mongoose from "mongoose";
import LabelPrintJob from "../models/LabelPrintJob.js";
import LabelPrintHistory from "../models/LabelPrintHistory.js";
import * as labelService from "../services/label/labelService.js";
import * as labelSettings from "../services/label/labelSettingsService.js";
import * as printerManager from "../services/label/printerManager.js";
import * as templateService from "../services/label/labelTemplateService.js";
import { getFixedLabelSize } from "../services/label/tsplGenerator.js";
import { recordLabelHistory } from "../services/label/labelAudit.js";
import { syncGrnLabelStatus } from "../services/label/labelService.js";
import {
  buildLabelPrintJobListFilter,
  parseLabelJobIdList,
  clampLabelJobListLimit,
} from "../services/label/labelJobListQuery.js";

function sendErr(res, err) {
  const status = Number(err.statusCode || err.status) || 400;
  res.status(status).json({
    message: err.message || "Label request failed",
    code: err.code || undefined,
    ...(err.details && typeof err.details === "object" ? { details: err.details } : {}),
    ...(Array.isArray(err.missing) ? { missing: err.missing } : {}),
  });
}

export async function getSettings(req, res) {
  try {
    const settings = await labelSettings.getLabelSettings(req.companyId);
    res.json({
      ...settings,
      agentBootstrapToken: "",
      labelSize: getFixedLabelSize(),
      template: "MARIVOLT STANDARD LABEL",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function putSettings(req, res) {
  try {
    const body = { ...(req.body || {}) };
    const bootstrapKeys = [
      "agentBootstrapToken",
      "agentBootstrapEnabled",
      "agentBootstrapExpiresAt",
      "agentBootstrapWarehouse",
      "agentBootstrapMaxUses",
      "clearBootstrapToken",
    ];
    const touchesBootstrap = bootstrapKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (touchesBootstrap) {
      const { hasPermission, normaliseRoleCode } = await import("../services/roleService.js");
      const role = normaliseRoleCode(req.user?.role || "");
      const ok = role === "SUPER_ADMIN" || (await hasPermission(req, "LABELS", "admin"));
      if (!ok) {
        const err = new Error("LABELS.admin required to manage agent bootstrap settings");
        err.statusCode = 403;
        err.code = "PERMISSION_DENIED";
        throw err;
      }
    }
    const settings = await labelSettings.upsertLabelSettings(
      req.companyId,
      body,
      req.user?.name || req.user?.email || ""
    );
    res.json({
      ...settings,
      agentBootstrapToken: "",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listPrinters(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || "") === "1";
    const rows = await printerManager.listPrinters(req.companyId, { includeInactive });
    // Enrich with queue depth + agent status + physical printer health
    const LabelPrintJob = (await import("../models/LabelPrintJob.js")).default;
    const PrintAgent = (await import("../models/PrintAgent.js")).default;
    const { resolveMappedPrinterHealth } = await import("../services/label/labelRoutingHelpers.js");
    const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))];
    const agents = await PrintAgent.find({ companyId: req.companyId, agentId: { $in: agentIds } }).lean();
    const agentMap = Object.fromEntries(agents.map((a) => [a.agentId, a]));
    const pending = await LabelPrintJob.aggregate([
      {
        $match: {
          companyId: req.companyId,
          printerConfigId: { $in: rows.map((r) => r._id) },
          status: { $in: ["PENDING", "LEASED", "PRINTING"] },
        },
      },
      { $group: { _id: "$printerConfigId", count: { $sum: 1 } } },
    ]);
    const pendingMap = Object.fromEntries(pending.map((p) => [String(p._id), p.count]));
    const items = rows.map((p) => {
      const ag = agentMap[p.agentId];
      const hb = ag?.lastHeartbeatAt ? new Date(ag.lastHeartbeatAt).getTime() : 0;
      const online = ag?.isActive !== false && ag?.status === "ONLINE" && hb && Date.now() - hb < 90_000;
      const agentStatus = ag?.isActive === false ? "DISABLED" : online ? "ONLINE" : "OFFLINE";
      const health = resolveMappedPrinterHealth(ag, p.windowsPrinterName, {
        agentOnline: agentStatus === "ONLINE",
      });
      return {
        ...p,
        currentQueue: pendingMap[String(p._id)] || 0,
        agentName: ag?.name || "",
        agentComputerName: ag?.computerName || "",
        agentStatus,
        ...health,
        spoolerQueueLength: health.printerQueueLength || 0,
      };
    });
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function upsertPrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const { printer, created } = await printerManager.upsertPrinter(
      req.companyId,
      req.body || {},
      req.user?.name || ""
    );
    await auditLabelAdminEvent(req, {
      action: created ? "CREATE" : "UPDATE",
      entityType: "PrinterConfig",
      entityId: printer._id,
      documentNo: printer.code,
      description: created ? `Printer Added: ${printer.code}` : `Printer Changed: ${printer.code}`,
      metadata: { agentId: printer.agentId, windowsPrinterName: printer.windowsPrinterName },
    });
    res.status(created ? 201 : 200).json(printer);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function disablePrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const row = await printerManager.setPrinterActive(req.companyId, req.params.id, false);
    await auditLabelAdminEvent(req, {
      action: "UPDATE",
      entityType: "PrinterConfig",
      entityId: row._id,
      documentNo: row.code,
      description: `Printer Disabled: ${row.code}`,
    });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function enablePrinter(req, res) {
  try {
    const row = await printerManager.setPrinterActive(req.companyId, req.params.id, true);
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function deletePrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const row = await printerManager.deletePrinter(req.companyId, req.params.id);
    await auditLabelAdminEvent(req, {
      action: "DELETE",
      entityType: "PrinterConfig",
      entityId: row._id,
      documentNo: row.code,
      description: `Printer Deleted (soft): ${row.code}`,
    });
    res.json(row);
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
    const result = await labelService.listAgents(req.companyId, req.query || {});
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getAgent(req, res) {
  try {
    const item = await labelService.getAgent(req.companyId, req.params.id);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function updateAgent(req, res) {
  try {
    const item = await labelService.updatePrintAgent(req, req.params.id, req.body || {});
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function disableAgent(req, res) {
  try {
    const item = await labelService.setAgentActive(req, req.params.id, false);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function enableAgent(req, res) {
  try {
    const item = await labelService.setAgentActive(req, req.params.id, true);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function rotateAgentSecret(req, res) {
  try {
    const result = await labelService.rotateAgentSecret(req, req.params.id);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function testPrint(req, res) {
  try {
    const job = await labelService.createTestPrintJob(req, {
      agentId: req.body?.agentId || req.params.agentId,
      printerCode: req.body?.printerCode || req.params.printerCode,
    });
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function testConnection(req, res) {
  try {
    const { resolveMappedPrinterHealth } = await import("../services/label/labelRoutingHelpers.js");
    const agent = await labelService.getAgent(req.companyId, req.params.id);
    const printers = (agent.printers || []).filter((p) => p.isActive !== false);
    const available = new Set((agent.availablePrinters || []).map((n) => String(n).toLowerCase()));
    const agentOnline = agent.effectiveStatus === "ONLINE";
    const mappedChecks = printers.map((p) => {
      const win = String(p.windowsPrinterName || "").trim();
      const health = resolveMappedPrinterHealth(agent, win, { agentOnline });
      return {
        code: p.code,
        windowsPrinterName: win,
        foundOnAgent: win ? available.has(win.toLowerCase()) : false,
        agentStatus: agentOnline ? "ONLINE" : agent.effectiveStatus || "OFFLINE",
        printerStatus: health.printerStatus,
        printerConnected: health.printerConnected,
        printerStatusMessage: health.printerStatusMessage,
        lastPrinterSeen: health.lastPrinterSeen,
        queueLength: health.printerQueueLength,
      };
    });
    const anyReady = mappedChecks.some((m) => m.printerStatus === "READY");
    const anyDisconnected = mappedChecks.some((m) => m.printerStatus === "DISCONNECTED");
    const primaryStatus = mappedChecks[0]?.printerStatus || (agentOnline ? "UNKNOWN" : "UNKNOWN");
    let message;
    if (!agentOnline) {
      message = "Agent offline, printer unknown";
    } else if (anyReady) {
      message = "Agent online, printer ready";
    } else if (anyDisconnected) {
      message = "Agent online, printer disconnected";
    } else if (!printers.length) {
      message = "Agent online; no active printer mappings yet.";
    } else {
      message = `Agent online, printer ${String(primaryStatus).toLowerCase().replace(/_/g, " ")}`;
    }
    res.json({
      ok: agentOnline,
      connected: agentOnline,
      agentAuthenticated: true,
      agentId: agent.agentId,
      agentStatus: agentOnline ? "ONLINE" : agent.effectiveStatus || "OFFLINE",
      printerStatus: primaryStatus,
      effectiveStatus: agent.effectiveStatus,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      lastIp: agent.lastIp,
      appVersion: agent.appVersion,
      computerName: agent.computerName,
      availablePrinters: agent.availablePrinters || [],
      mappedPrinters: mappedChecks,
      mappedWindowsPrinterFound: mappedChecks.some((m) => m.foundOnAgent),
      physicalPrintRequired: false,
      message,
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function linkGrnPrepost(req, res) {
  try {
    const body = req.body || {};
    const result = await labelService.linkPrepostJobsToGrn(
      req.companyId,
      body.draftRef || body.draftNo,
      body.grnNo
    );
    res.json({ success: true, ...result });
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

export async function createFromGrnPrepost(req, res) {
  try {
    const job = await labelService.createJobsFromGrnPrepost(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

/** Preview-only: validates distribution, returns face quantities. No job, no stock. */
export async function previewFromGrnPrepost(req, res) {
  try {
    const body = req.body || {};
    const linesIn = Array.isArray(body.lines) ? body.lines : [];
    const {
      validateGrnLabelLinePrintConfig,
      formatLabelDistribution,
      sumDistribution,
    } = await import("../utils/grnLabelDistribution.js");

    const previewLines = [];
    let totalLabels = 0;
    for (const sel of linesIn) {
      if (sel?.print === false) continue;
      const receivedQty = Number(sel.receivedQty ?? sel.grnQty) || 0;
      const validated = validateGrnLabelLinePrintConfig({
        print: true,
        article: sel.article,
        receivedQty,
        qtyPerLabel: sel.qtyPerLabel ?? sel.labelQtyPerLabel,
        labelCount: sel.labelCount ?? sel.noOfLabels,
        labelDistribution: sel.labelDistribution,
      });
      if (!validated.ok) {
        const err = new Error(validated.message);
        err.statusCode = 400;
        err.code = "LABEL_DISTRIBUTION_INVALID";
        throw err;
      }
      const dist = validated.distribution;
      totalLabels += dist.length;
      previewLines.push({
        article: String(sel.article || "").toUpperCase(),
        poLineId: sel.poLineId != null ? String(sel.poLineId) : "",
        grnQty: receivedQty,
        qtyPerLabel: validated.qtyPerLabel,
        labelCount: dist.length,
        labelDistribution: dist,
        distributionText: formatLabelDistribution(dist),
        labels: dist.map((qty, idx) => ({ index: idx + 1, qty })),
      });
    }
    if (!previewLines.length) {
      const err = new Error("No label lines selected for printing");
      err.statusCode = 400;
      err.code = "LABEL_NO_LINES";
      throw err;
    }
    res.json({
      success: true,
      draftRef: body.draftRef || "",
      poNo: body.poNo || "",
      totalLabels,
      lines: previewLines,
      sumCheck: previewLines.map((ln) => ({
        article: ln.article,
        sum: sumDistribution(ln.labelDistribution),
        grnQty: ln.grnQty,
      })),
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromPacking(req, res) {
  try {
    const { createJobsFromPacking } = await import("../services/label/packingLabelService.js");
    const result = await createJobsFromPacking(req, req.body || {});
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewFromPacking(req, res) {
  try {
    const { previewPackingLabels } = await import("../services/label/packingLabelService.js");
    const preview = await previewPackingLabels(req, req.body || {});
    res.json({ success: true, ...preview });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromCustomPacking(req, res) {
  try {
    const { createJobsFromCustomPacking } = await import(
      "../services/label/customPackingLabelService.js"
    );
    const job = await createJobsFromCustomPacking(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewFromCustomPacking(req, res) {
  try {
    const { previewCustomPackingLabels } = await import(
      "../services/label/customPackingLabelService.js"
    );
    const preview = await previewCustomPackingLabels(req, req.body || {});
    res.json({ success: true, ...preview });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function customPackingRowPrintStatus(req, res) {
  try {
    const { resolveCustomPackingRowPrintStatuses } = await import(
      "../services/label/customPackingLabelService.js"
    );
    const result = await resolveCustomPackingRowPrintStatuses(req, req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function downloadCustomPackingTemplate(req, res) {
  try {
    const { buildCustomPackingTemplateWorkbook } = await import(
      "../services/label/customPackingLabelService.js"
    );
    const buffer = buildCustomPackingTemplateWorkbook();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="custom-packing-label-template.xlsx"'
    );
    res.send(buffer);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function parseCustomPackingImport(req, res) {
  try {
    const {
      parseCustomPackingSpreadsheetBuffer,
      parseCustomPackingSpreadsheetRows,
    } = await import("../services/label/customPackingLabelService.js");
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ message: "Spreadsheet file is required" });
    }
    const rawRows = parseCustomPackingSpreadsheetBuffer(req.file.buffer, req.file.originalname || "");
    const rows = parseCustomPackingSpreadsheetRows(rawRows);
    res.json({ success: true, rows });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromAsn(req, res) {
  try {
    const { createJobsFromAsn } = await import("../services/label/asnLabelService.js");
    const result = await createJobsFromAsn(req, req.body || {});
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewFromAsn(req, res) {
  try {
    const { previewJobsFromAsn } = await import("../services/label/asnLabelService.js");
    const preview = await previewJobsFromAsn(req, req.body || {});
    res.json({ success: true, ...preview });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listJobs(req, res) {
  try {
    const filter = buildLabelPrintJobListFilter(req.companyId, req.query);
    const limit = clampLabelJobListLimit(req.query.limit);
    const select = "-tsplPayload -rawFacePayloads -driverPages";
    const packingIds = parseLabelJobIdList(req.query.packingIds);
    let items;
    if (packingIds.length) {
      const chunks = await Promise.all(
        packingIds.slice(0, 80).map((id) =>
          LabelPrintJob.find({ ...filter, packingId: id })
            .sort({ createdAt: -1 })
            .limit(limit)
            .select(select)
            .lean()
        )
      );
      items = chunks.flat();
    } else {
      items = await LabelPrintJob.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(select)
        .lean();
    }
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getReprintTarget(req, res) {
  try {
    const target = await labelService.resolvePackingReprintTarget(req, req.params.id);
    res.json(target);
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
    const result = await labelService.confirmPartial(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, ...result });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function resolveUncertain(req, res) {
  try {
    const result = await labelService.resolveUncertain(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, ...result });
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
