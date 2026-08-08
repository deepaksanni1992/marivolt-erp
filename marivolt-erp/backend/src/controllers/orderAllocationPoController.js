import {
  buildOrderAllocationPoEligibility,
  listLinkedPurchaseOrdersForAllocation,
  validatePurchaseOrderAllocationLinks,
} from "../services/orderAllocationPoConversionService.js";
import { getAllocationStockPosition } from "../services/allocationStockPositionService.js";
import { writeAudit } from "../services/auditService.js";

export async function getOrderAllocationPoEligibility(req, res) {
  try {
    const { id } = req.params;
    const data = await buildOrderAllocationPoEligibility(req.companyId, id);
    res.json(data);
  } catch (err) {
    res.status(err.message?.includes("not found") ? 404 : 400).json({ message: err.message });
  }
}

export async function getOrderAllocationStockPosition(req, res) {
  try {
    const { id } = req.params;
    const data = await getAllocationStockPosition(req.companyId, id);
    res.json(data);
  } catch (err) {
    res.status(err.message?.includes("not found") ? 404 : 400).json({ message: err.message });
  }
}

export async function getOrderAllocationLinkedPurchaseOrders(req, res) {
  try {
    const { id } = req.params;
    const data = await listLinkedPurchaseOrdersForAllocation(req.companyId, id);
    res.json(data);
  } catch (err) {
    res.status(err.message?.includes("not found") ? 404 : 400).json({ message: err.message });
  }
}

export async function validatePurchaseOrderFromOrderAllocation(req, res) {
  try {
    const { allocationId, lines } = req.body || {};
    if (!allocationId) {
      return res.status(400).json({ message: "allocationId is required" });
    }
    const result = await validatePurchaseOrderAllocationLinks({
      companyId: req.companyId,
      allocationId,
      lines: lines || [],
      excludePoId: req.body?.excludePoId || null,
    });
    await writeAudit(req, {
      action: "VALIDATE",
      module: "PURCHASE",
      entityType: "ORDER_ALLOCATION",
      entityId: result.allocation?._id,
      documentNo: result.allocation?.allocationNo,
      description: `Convert to PO validation for ${result.allocation?.allocationNo}`,
      metadata: {
        linkedLineCount: result.linkedLines.length,
        lines: result.linkedLines.map((l) => ({
          sourceOrderAllocationLineId: l.sourceOrderAllocationLineId,
          article: l.sourceArticle,
          qty: l.sourceConvertedQty,
        })),
      },
    });
    res.json({ ok: true, linkedLines: result.linkedLines });
  } catch (err) {
    res.status(400).json({ message: err.message, details: err.details || [] });
  }
}

export async function auditConvertToPoInitiated(req, allocation, selectedLines) {
  await writeAudit(req, {
    action: "CONVERT_INITIATED",
    module: "SALES",
    entityType: "ORDER_ALLOCATION",
    entityId: allocation?._id,
    documentNo: allocation?.allocationNo,
    description: `Convert to PO initiated for ${allocation?.allocationNo}`,
    metadata: {
      selectedLines: (selectedLines || []).map((l) => ({
        allocationLineId: l.allocationLineId || l.sourceOrderAllocationLineId,
        article: l.article || l.sourceArticle,
        requestedQty: l.requestedQty || l.sourceRequestedQty,
      })),
    },
  });
}
