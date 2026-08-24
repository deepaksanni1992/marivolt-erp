import PrintAgent from "../models/PrintAgent.js";
import {
  leaseNextJob,
  markJobPrinting,
  applyAgentResult,
  reclaimExpiredLeases,
  releaseLeaseToPending,
} from "../services/label/printQueue.js";
import { recordLabelHistory } from "../services/label/labelAudit.js";
import {
  syncGrnLabelStatus,
  applyAgentHeartbeat,
  touchPrinterLastPrint,
} from "../services/label/labelService.js";

function sendErr(res, err) {
  res.status(err.statusCode || 400).json({
    message: err.message || "Agent request failed",
    code: err.code || undefined,
  });
}

export async function heartbeat(req, res) {
  try {
    const agent = await applyAgentHeartbeat(req.printAgent, req.body || {}, req);
    await reclaimExpiredLeases(agent.companyId);
    res.json({
      ok: true,
      agentId: agent.agentId,
      status: "ONLINE",
      serverTime: new Date().toISOString(),
      warehouseCode: agent.warehouseCode || "",
      availablePrinters: agent.availablePrinters || [],
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function lease(req, res) {
  try {
    const agent = req.printAgent;
    await reclaimExpiredLeases(agent.companyId);
    const job = await leaseNextJob(agent);
    if (!job) {
      return res.json({ job: null });
    }
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: agent.agentId,
      computerName: agent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.remainingLabels,
      status: "LEASED",
      templateCode: job.templateCode,
      event: "LEASE",
    });
    await syncGrnLabelStatus(job.sourceId, job);
    res.json({
      job: {
        id: job._id,
        jobNo: job.jobNo,
        leaseToken: job.leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        windowsPrinterName: job.windowsPrinterName,
        templateCode: job.templateCode,
        requestedLabels: job.remainingLabels,
        payloadMode: job.payloadMode || "SINGLE_RAW",
        tsplPayload:
          job.payloadMode === "RAW_FACE_BATCH" || job.payloadMode === "DRIVER_PAGES"
            ? ""
            : job.tsplPayload,
        rawFacePayloads:
          job.payloadMode === "RAW_FACE_BATCH" ? job.rawFacePayloads || [] : undefined,
        sourceNo: job.sourceNo,
        sourceType: job.sourceType,
      },
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function printing(req, res) {
  try {
    const job = await markJobPrinting(req.params.id, req.printAgent, req.body?.leaseToken);
    await syncGrnLabelStatus(job.sourceId, job);
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: req.printAgent.agentId,
      computerName: req.printAgent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.remainingLabels,
      status: "PRINTING",
      templateCode: job.templateCode,
      event: "PRINTING",
    });
    res.json({ ok: true, status: job.status });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function releaseLease(req, res) {
  try {
    const job = await releaseLeaseToPending(req.params.id, req.printAgent, req.body?.leaseToken);
    await syncGrnLabelStatus(job.sourceId, job);
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: req.printAgent.agentId,
      computerName: req.printAgent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.remainingLabels,
      status: "PENDING",
      templateCode: job.templateCode,
      event: "LEASE_RELEASE",
    });
    res.json({ ok: true, status: job.status });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function result(req, res) {
  try {
    const job = await applyAgentResult(req.params.id, req.printAgent, req.body || {});
    await syncGrnLabelStatus(job.sourceId, job);
    if (String(job.sourceType || "").toUpperCase() === "ASN") {
      const { applyReceivingUnitPrintResult } = await import("../services/label/asnLabelService.js");
      await applyReceivingUnitPrintResult(job);
    }
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: req.printAgent.agentId,
      computerName: req.printAgent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.requestedLabels,
      printedQty: req.body?.printedQty || 0,
      status: job.status,
      templateCode: job.templateCode,
      failureReason: job.lastError || "",
      retryCount: job.retryCount,
      event: "RESULT",
    });
    if (job.status === "COMPLETED" || job.status === "PARTIAL") {
      await touchPrinterLastPrint(job.printerConfigId);
      await PrintAgent.updateOne(
        { _id: req.printAgent._id },
        { $set: { lastHeartbeatAt: new Date(), status: "ONLINE", lastError: "" } }
      );
    } else {
      await PrintAgent.updateOne(
        { _id: req.printAgent._id },
        {
          $set: {
            lastHeartbeatAt: new Date(),
            status: "ONLINE",
            lastError: String(req.body?.error || job.lastError || "").slice(0, 500),
          },
        }
      );
    }
    res.json({
      ok: true,
      status: job.status,
      printedLabels: job.printedLabels,
      remainingLabels: job.remainingLabels,
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function bootstrap(req, res) {
  try {
    if (process.env.NODE_ENV === "production") {
      const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const secure = Boolean(req.secure) || xfProto === "https";
      if (!secure) {
        return res.status(403).json({
          message: "HTTPS required for print agent bootstrap in production",
          code: "AGENT_HTTPS_REQUIRED",
        });
      }
    }
    const { bootstrapRegisterAgent } = await import("../services/label/labelService.js");
    const result = await bootstrapRegisterAgent(req.body || {}, {
      ip: req.ip || req.headers["x-forwarded-for"],
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) {
    sendErr(res, err);
  }
}
