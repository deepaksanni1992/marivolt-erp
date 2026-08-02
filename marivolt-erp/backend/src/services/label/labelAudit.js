import LabelPrintHistory from "../../models/LabelPrintHistory.js";
import { writeAudit } from "../auditService.js";

export async function recordLabelHistory(entry = {}) {
  try {
    await LabelPrintHistory.create({
      jobId: entry.jobId,
      companyId: entry.companyId,
      agentId: entry.agentId || "",
      computerName: entry.computerName || "",
      windowsPrinterName: entry.windowsPrinterName || "",
      requestedQty: entry.requestedQty || 0,
      printedQty: entry.printedQty || 0,
      status: entry.status || "",
      templateCode: entry.templateCode || "",
      userId: entry.userId || null,
      userName: entry.userName || "",
      failureReason: entry.failureReason || "",
      retryCount: entry.retryCount || 0,
      event: entry.event || "",
    });
  } catch {
    // never block printing on history failure
  }
}

export async function auditLabelEvent(req, { action = "OTHER", job, description }) {
  try {
    await writeAudit(req, {
      action,
      module: "LABELS",
      entityType: "LabelPrintJob",
      entityId: job?._id,
      documentNo: job?.jobNo || "",
      description: description || `Label job ${job?.jobNo || ""} ${job?.status || ""}`,
      metadata: {
        sourceNo: job?.sourceNo,
        status: job?.status,
        requestedLabels: job?.requestedLabels,
        printedLabels: job?.printedLabels,
        agentId: job?.agentId,
        templateCode: job?.templateCode,
        retryCount: job?.retryCount,
      },
    });
  } catch {
    // ignore
  }
}
