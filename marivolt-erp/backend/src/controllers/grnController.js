import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockLocation from "../models/StockLocation.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import StockLedger from "../models/StockLedger.js";
import Setting from "../models/Setting.js";
import * as stockService from "../services/stockService.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";
import { syncPurchaseOrderApExtensionFields } from "./purchasePoDocumentController.js";
import { nextNumber } from "../services/numberSeriesService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

async function nextGrnNo(companyId, companyCode = "") {
  const { number } = await nextNumber({
    companyId,
    companyCode,
    docKey: "GRN",
    referenceDate: new Date(),
    branchId: null,
  });
  return number;
}

/**
 * Build GRN line items from a PO line selection (Store UI / API).
 * `selections`: { poLineId, grnQty, warehouse?, location?, remarks?, currency? }[]
 * Only lines with grnQty > 0 are included.
 */
async function buildGrnItemsFromPoLineSelection(req, poId, selections = []) {
  const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId }));
  if (!po) throw new Error("Purchase order not found");
  if (String(po.status || "").toUpperCase() === "CANCELLED") {
    throw new Error("Cannot create GRN against a cancelled PO");
  }
  const raw = [];
  for (const row of selections) {
    const poLineId = row.poLineId;
    const grnQty = Number(row.grnQty ?? row.receivedQty);
    if (!mongoose.Types.ObjectId.isValid(String(poLineId))) continue;
    if (!Number.isFinite(grnQty) || grnQty <= 0) continue;
    const poLine = po.lines.id(poLineId);
    if (!poLine) throw new Error(`Invalid PO line: ${poLineId}`);
    const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
    const receivedSoFar = Number(poLine.receivedQty) || 0;
    const cancelled = Number(poLine.cancelledQty) || 0;
    const pending = Math.max(0, Number(poLine.pendingQty ?? Math.max(0, ordered - receivedSoFar - cancelled)) || 0);
    if (grnQty > pending + 1e-6) {
      throw new Error(
        `GRN qty (${grnQty}) exceeds pending (${pending}) for line ${poLine.itemCode || poLine.article || poLineId}`
      );
    }
    const wh = upper(row.warehouse || "MAIN");
    const loc = upper(row.location || row.warehouse || "MAIN");
    raw.push({
      article: String(poLine.itemCode || poLine.article || "").toUpperCase(),
      description: poLine.description || "",
      spn: poLine.partNo || "",
      materialCode: poLine.itemCode || "",
      orderedQty: ordered,
      receivedQty: grnQty,
      pendingQty: pending,
      acceptedQty: grnQty,
      rejectedQty: 0,
      cancelledQty: 0,
      unitCost: Number(poLine.unitPrice) || 0,
      currency: upper(row.currency || po.currency || "USD"),
      warehouse: wh,
      location: loc,
      poLineId,
      poId: po._id,
      poNo: po.poNo || po.poNumber || "",
      remarks: t(row.remarks),
    });
  }
  if (!raw.length) throw new Error("Select at least one PO line with GRN qty greater than zero");
  return { po, items: normalizeItems(raw) };
}

function normalizeItems(items = []) {
  return (items || []).map((r) => {
    const received = Number(r.receivedQty) || 0;
    const rejected = Number(r.rejectedQty) || 0;
    const cancelled = Number(r.cancelledQty) || 0;
    const pendingCap = Number(r.pendingQty ?? r.orderedQty ?? received + rejected + cancelled) || 0;
    if (received < 0 || rejected < 0 || cancelled < 0) {
      throw new Error("Received/Rejected/Cancelled qty cannot be negative");
    }
    if (received + rejected + cancelled > pendingCap) {
      throw new Error("receivedQty + rejectedQty + cancelledQty cannot exceed pendingQty");
    }
    const accepted = Math.max(0, received - rejected);
    const ordered = Number(r.orderedQty ?? pendingCap) || 0;
    const pending = Math.max(0, pendingCap - received - rejected - cancelled);
    return {
      article: upper(r.article),
      description: t(r.description),
      spn: t(r.spn),
      materialCode: t(r.materialCode),
      orderedQty: ordered,
      receivedQty: received,
      pendingQty: Number.isFinite(pending) ? pending : 0,
      acceptedQty: accepted,
      rejectedQty: rejected,
      cancelledQty: cancelled,
      unitCost: Number(r.unitCost) || 0,
      lineAmount: (Number(r.unitCost) || 0) * accepted,
      currency: upper(r.currency || "USD") || "USD",
      exchangeRate: Number(r.exchangeRate) || 1,
      freight: Number(r.freight) || 0,
      customs: Number(r.customs) || 0,
      landedAdjustment: Number(r.landedAdjustment) || 0,
      location: upper(r.location || r.warehouse),
      warehouse: upper(r.warehouse || r.location),
      warehouseId: mongoose.Types.ObjectId.isValid(String(r.warehouseId || "")) ? new mongoose.Types.ObjectId(String(r.warehouseId)) : null,
      batchNo: t(r.batchNo),
      serialNo: t(r.serialNo),
      manufacturingDate: r.manufacturingDate ? new Date(r.manufacturingDate) : null,
      expiryDate: r.expiryDate ? new Date(r.expiryDate) : null,
      poId: mongoose.Types.ObjectId.isValid(String(r.poId || "")) ? new mongoose.Types.ObjectId(String(r.poId)) : null,
      poLineId: mongoose.Types.ObjectId.isValid(String(r.poLineId || "")) ? new mongoose.Types.ObjectId(String(r.poLineId)) : null,
      remarks: t(r.remarks),
      poNo: t(r.poNo),
      recoveryInfo: Array.isArray(r.recoveryInfo)
        ? r.recoveryInfo.map((x) => t(x)).filter(Boolean)
        : [],
    };
  });
}

async function findRecoveryNotes({ session, companyId, article, warehouse, qty }) {
  const outstanding = await StockLedger.find({
    companyId,
    movementType: "ALLOCATION",
    article: upper(article),
    warehouse: upper(warehouse),
    availableAfter: { $lt: 0 },
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .session(session)
    .lean();
  let remaining = Number(qty) || 0;
  const notes = [];
  for (const row of outstanding) {
    if (!(remaining > 0)) break;
    const shortage = Math.abs(Number(row.availableAfter) || 0);
    if (!(shortage > 0)) continue;
    const recovered = Math.min(remaining, shortage);
    remaining -= recovered;
    notes.push(
      `Recovered allocation for ${row.customerName || "Customer"} / Ref ${row.referenceNo || row.referenceType || "N/A"} (${recovered})`
    );
  }
  return notes;
}

export async function createGrn(req, res) {
  try {
    if (!req.body.poId || !mongoose.Types.ObjectId.isValid(String(req.body.poId))) {
      return res.status(400).json({ message: "Purchase Order (poId) is required to create a GRN" });
    }
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: req.body.poId })).lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    if (String(po.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot create GRN against a cancelled PO" });
    }
    let items = [];
    if (Array.isArray(req.body.lines) && req.body.lines.length > 0) {
      try {
        const { items: built } = await buildGrnItemsFromPoLineSelection(req, req.body.poId, req.body.lines);
        items = built;
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    } else {
      items = normalizeItems(req.body.items || []);
    }
    if (!items.length) {
      return res.status(400).json({
        message:
          "No GRN lines: send lines[] with { poLineId, grnQty } for each selected line, or a non-empty items[] payload",
      });
    }
    const grnNo = t(req.body.grnNo) || (await nextGrnNo(req.companyId, req.companyCode));
    const doc = await GRN.create({
      companyId: req.companyId,
      branchId: req.body.branchId || po.branchId || null,
      warehouseId: req.body.warehouseId || po.warehouseId || null,
      grnNo,
      poId: req.body.poId || null,
      grnDate: req.body.grnDate || new Date(),
      supplierId: req.body.supplierId || po.supplierId || null,
      supplierName: t(req.body.supplierName) || po.supplierName || "",
      supplierInvoiceNo: t(req.body.supplierInvoiceNo),
      supplierDeliveryNote: t(req.body.supplierDeliveryNote),
      transporter: t(req.body.transporter),
      vehicleDetails: t(req.body.vehicleDetails),
      packingListNo: t(req.body.packingListNo),
      blAwbNo: t(req.body.blAwbNo),
      customsDocRef: t(req.body.customsDocRef),
      poNo: t(req.body.poNo) || po.poNo || po.poNumber || "",
      currency: upper(req.body.currency || po.currency || "USD"),
      exchangeRate: Number(req.body.exchangeRate) || 1,
      freight: Number(req.body.freight) || 0,
      customs: Number(req.body.customs) || 0,
      landedAdjustment: Number(req.body.landedAdjustment) || 0,
      remarks: t(req.body.remarks),
      status: "DRAFT",
      approvalStatus: "NOT_REQUIRED",
      items,
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "GRN",
      entityId: doc._id,
      documentNo: doc.grnNo,
      description: `GRN ${doc.grnNo} created`,
      metadata: { poNo: doc.poNo || "", lineCount: doc.items.length },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listGrn(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = upper(req.query.status);
    if (req.query.search) {
      const re = new RegExp(t(req.query.search), "i");
      filter.$or = [{ grnNo: re }, { supplierName: re }, { supplierInvoiceNo: re }, { poNo: re }];
    }
    const [items, total] = await Promise.all([
      GRN.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GRN.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrn(req, res) {
  try {
    const row = await GRN.findOne(withCompany(req, { grnNo: upper(req.params.grnNo) })).lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    if (row._id) {
      row.attachments = row.attachments || [];
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateGrn(req, res) {
  try {
    const grnNo = upper(req.params.grnNo);
    const grn = await GRN.findOne(withCompany(req, { grnNo }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (grn.status !== "DRAFT") return res.status(400).json({ message: "Only DRAFT GRN can be edited" });
    grn.branchId = req.body.branchId ?? grn.branchId;
    grn.warehouseId = req.body.warehouseId ?? grn.warehouseId;
    grn.grnDate = req.body.grnDate || grn.grnDate;
    grn.supplierId = req.body.supplierId ?? grn.supplierId;
    grn.supplierName = t(req.body.supplierName);
    grn.supplierInvoiceNo = t(req.body.supplierInvoiceNo);
    grn.supplierDeliveryNote = t(req.body.supplierDeliveryNote);
    grn.transporter = t(req.body.transporter);
    grn.vehicleDetails = t(req.body.vehicleDetails);
    grn.packingListNo = t(req.body.packingListNo);
    grn.blAwbNo = t(req.body.blAwbNo);
    grn.customsDocRef = t(req.body.customsDocRef);
    grn.poId = req.body.poId ?? grn.poId;
    grn.poNo = t(req.body.poNo);
    grn.currency = upper(req.body.currency || grn.currency || "USD");
    grn.exchangeRate = Number(req.body.exchangeRate ?? grn.exchangeRate) || 1;
    grn.freight = Number(req.body.freight ?? grn.freight) || 0;
    grn.customs = Number(req.body.customs ?? grn.customs) || 0;
    grn.landedAdjustment = Number(req.body.landedAdjustment ?? grn.landedAdjustment) || 0;
    grn.remarks = t(req.body.remarks);
    const beforeLines = grn.items?.map((x) => ({
      article: x.article,
      receivedQty: x.receivedQty,
      rejectedQty: x.rejectedQty,
      cancelledQty: x.cancelledQty,
      remarks: x.remarks,
    })) || [];
    grn.items = normalizeItems(req.body.items || []);
    if (Array.isArray(req.body.attachments)) grn.attachments = req.body.attachments;
    grn.updatedBy = req.user?.email || "";
    await grn.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "STORE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      description: `GRN ${grn.grnNo} updated`,
      metadata: {
        lineEdit: true,
        beforeLines,
        afterLines: grn.items.map((x) => ({
          article: x.article,
          receivedQty: x.receivedQty,
          rejectedQty: x.rejectedQty,
          cancelledQty: x.cancelledQty,
          remarks: x.remarks,
        })),
      },
    });
    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

async function applyReceiveToPo({ session, req, grn }) {
  if (!grn.poId) return;
  const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
  if (!po) return;
  const receiveByLineId = new Map();
  for (const line of grn.items || []) {
    if (!line.poLineId) continue;
    const current = receiveByLineId.get(String(line.poLineId)) || { accepted: 0, rejected: 0 };
    current.accepted += Number(line.acceptedQty) || 0;
    current.rejected += Number(line.rejectedQty) || 0;
    receiveByLineId.set(String(line.poLineId), current);
  }
  for (const poLine of po.lines || []) {
    const rec = receiveByLineId.get(String(poLine._id));
    if (!rec) continue;
    const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
    const nextReceived = Math.min(ordered, (Number(poLine.receivedQty) || 0) + rec.accepted);
    poLine.receivedQty = nextReceived;
    poLine.rejectedQty = (Number(poLine.rejectedQty) || 0) + rec.rejected;
    poLine.pendingQty = Math.max(0, ordered - nextReceived - (Number(poLine.cancelledQty) || 0));
    poLine.qty = ordered;
    poLine.orderedQty = ordered;
    poLine.lineAmount = ordered * (Number(poLine.unitPrice) || 0);
    poLine.lineTotal = poLine.lineAmount;
  }
  const allReceived = po.lines.length > 0 && po.lines.every((l) => (Number(l.pendingQty) || 0) <= 0);
  const anyReceived = po.lines.some((l) => (Number(l.receivedQty) || 0) > 0);
  if (allReceived) po.status = "RECEIVED";
  else if (anyReceived) po.status = "PARTIAL_RECEIVED";
  await po.save({ session });
}

export async function postGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = upper(req.params.grnNo);
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (grn.status !== "DRAFT") throw new Error("Only DRAFT GRN can be received");
      grn.items = (grn.items || []).filter((x) => Number(x.acceptedQty) > 0.000001);
      if (!(grn.items || []).length) {
        throw new Error("Cannot post GRN with no lines having quantity greater than zero");
      }

      let allowOverPo = false;
      if (grn.poId) {
        const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
        if (po && String(po.status || "").toUpperCase() === "CANCELLED") {
          throw new Error("Cannot post GRN for a cancelled PO");
        }
        const s = await Setting.findOne(
          withCompany(req, { namespace: "OTHER", branchId: null, key: "STORE_ALLOW_GRN_OVER_PO" })
        )
          .session(session)
          .lean();
        allowOverPo = Boolean(s?.value);
        if (po && !allowOverPo) {
          for (const line of grn.items || []) {
            if (!(Number(line.acceptedQty) > 0)) continue;
            const poLine = line.poLineId ? po.lines.id(line.poLineId) : null;
            if (!poLine) continue;
            const pending = Math.max(0, Number(poLine.pendingQty ?? 0));
            const accepted = Number(line.acceptedQty) || 0;
            if (accepted > pending + 1e-6) {
              throw new Error(
                `Received qty exceeds PO balance for ${line.article}. Enable admin override STORE_ALLOW_GRN_OVER_PO or reduce qty.`
              );
            }
          }
        }
      }

      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "STORE",
        actionKey: "grn_receive",
        documentType: "GRN",
        documentId: grn._id,
        documentNo: grn.grnNo,
        description: `Receive GRN ${grn.grnNo}`,
      });
      if (!gate.approved) {
        grn.approvalStatus = "PENDING_RECEIVE";
        grn.updatedBy = req.user?.email || "";
        await grn.save({ session });
        throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
      }

      for (const line of grn.items) {
        const article = upper(line.article);
        const item = await ItemMaster.findOne(withCompany(req, { article })).select("_id").session(session);
        if (!item) throw new Error(`Article not found: ${article}`);
        const wh = upper(line.warehouse || line.location);
        const loc = await StockLocation.findOne(withCompany(req, { locationCode: wh, status: "Active" })).session(session);
        if (!loc) throw new Error(`Invalid location (code): ${wh}`);
        if (Number(line.acceptedQty) > 0) {
          const recoveryInfo = await findRecoveryNotes({
            session,
            companyId: req.companyId,
            article,
            warehouse: wh,
            qty: Number(line.acceptedQty),
          });
          await stockService.grnReceive({
            session,
            companyId: req.companyId,
            article,
            warehouse: wh,
            qty: Number(line.acceptedQty),
            referenceType: "GRN",
            referenceNo: grn.grnNo,
            supplierName: grn.supplierName || "",
            unitCost: Number(line.unitCost) || 0,
            currency: line.currency || "USD",
            batchNo: line.batchNo || "",
            serialNo: line.serialNo || "",
            remarks: line.remarks || "",
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            transactionDate: grn.grnDate,
          });
          line.recoveryInfo = recoveryInfo;
        }
      }
      await applyReceiveToPo({ session, req, grn });
      const hasPending = (grn.items || []).some((x) => Number(x.pendingQty || 0) > 0);
      grn.status = hasPending ? "PARTIAL_RECEIVED" : "RECEIVED";
      grn.approvalStatus = "APPROVED";
      grn.postedAt = new Date();
      grn.updatedBy = req.user?.email || "";
      await grn.save({ session });
      await writeStatusChange(req, {
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `GRN ${grn.grnNo} received`,
      });
      await writeAudit(req, {
        action: "RECEIVE",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "DRAFT",
        toStatus: grn.status,
        description: `GRN ${grn.grnNo} received (${grn.items?.length || 0} lines)`,
        metadata: { supplierName: grn.supplierName || "" },
      });
      await writeAudit(req, {
        action: "PARTIAL_RECEIVE",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        description: `Partial receive on GRN ${grn.grnNo}`,
        metadata: {
          lines: (grn.items || []).map((x) => ({
            article: x.article,
            acceptedQty: x.acceptedQty,
            rejectedQty: x.rejectedQty,
            cancelledQty: x.cancelledQty,
            recoveryInfo: x.recoveryInfo || [],
          })),
        },
      });
    });
    const postedGrn = await GRN.findOne(withCompany(req, { grnNo: upper(req.params.grnNo) }))
      .select("poId")
      .lean();
    if (postedGrn?.poId) {
      await syncPurchaseOrderApExtensionFields(req.companyId, postedGrn.poId);
    }
    res.json({ success: true });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

/** POST /api/grn/id/:id/post — same as posting by grnNo, for clients that hold the Mongo _id. */
export async function postGrnByMongoId(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid GRN id" });
    }
    const row = await GRN.findOne(withCompany(req, { _id: id })).select("grnNo").lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    req.params.grnNo = row.grnNo;
    return postGrn(req, res);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = upper(req.params.grnNo);
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (!["RECEIVED", "PARTIAL_RECEIVED"].includes(grn.status)) throw new Error("Only received GRN can be cancelled");

      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "STORE",
        actionKey: "grn_cancel",
        documentType: "GRN",
        documentId: grn._id,
        documentNo: grn.grnNo,
        description: `Cancel GRN ${grn.grnNo}`,
      });
      if (!gate.approved) {
        grn.approvalStatus = "PENDING_CANCEL";
        grn.updatedBy = req.user?.email || "";
        await grn.save({ session });
        throw Object.assign(new Error("APPROVAL_REQUIRED"), { _approval: approvalRequiredPayload(gate.request) });
      }

      for (const line of grn.items) {
        if (!(Number(line.acceptedQty) > 0)) continue;
        await stockService.cancelGrn({
          session,
          companyId: req.companyId,
          article: upper(line.article),
          warehouse: upper(line.warehouse || line.location),
          qty: Number(line.acceptedQty),
          referenceNo: grn.grnNo,
          supplierName: grn.supplierName || "",
          unitCost: Number(line.unitCost) || 0,
          currency: line.currency || "USD",
          batchNo: line.batchNo || "",
          serialNo: line.serialNo || "",
          remarks: `GRN cancelled: ${grn.grnNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
        });
      }
      if (grn.poId) {
        const po = await PurchaseOrder.findOne(withCompany(req, { _id: grn.poId })).session(session);
        if (po) {
          for (const line of grn.items || []) {
            if (!line.poLineId) continue;
            const poLine = po.lines.id(line.poLineId);
            if (!poLine) continue;
            const ordered = Number(poLine.orderedQty ?? poLine.qty) || 0;
            poLine.receivedQty = Math.max(0, (Number(poLine.receivedQty) || 0) - (Number(line.acceptedQty) || 0));
            poLine.pendingQty = Math.max(0, ordered - poLine.receivedQty - (Number(poLine.cancelledQty) || 0));
          }
          const allReceived = po.lines.length > 0 && po.lines.every((l) => (Number(l.pendingQty) || 0) <= 0);
          const anyReceived = po.lines.some((l) => (Number(l.receivedQty) || 0) > 0);
          po.status = allReceived ? "RECEIVED" : anyReceived ? "PARTIAL_RECEIVED" : "SENT";
          await po.save({ session });
        }
      }
      grn.status = "CANCELLED";
      grn.approvalStatus = "APPROVED";
      grn.cancelledAt = new Date();
      grn.cancellationReason = t(req.body?.reason || req.body?.cancellationReason);
      grn.updatedBy = req.user?.email || "";
      await grn.save({ session });
      await writeStatusChange(req, {
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "RECEIVED",
        toStatus: "CANCELLED",
        description: `GRN ${grn.grnNo} cancelled`,
      });
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "RECEIVED",
        toStatus: "CANCELLED",
        description: `GRN ${grn.grnNo} cancelled — stock reversed`,
        metadata: { supplierName: grn.supplierName || "" },
      });
    });
    res.json({ success: true });
  } catch (err) {
    if (err?._approval) return res.status(202).json(err._approval);
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function closeGrn(req, res) {
  try {
    const grnNo = upper(req.params.grnNo);
    const grn = await GRN.findOne(withCompany(req, { grnNo }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (!["RECEIVED", "PARTIAL_RECEIVED"].includes(grn.status)) {
      return res.status(409).json({ message: "Only received/partial GRN can be closed" });
    }
    const prev = grn.status;
    grn.status = "CLOSED";
    grn.updatedBy = req.user?.email || "";
    await grn.save();
    await writeStatusChange(req, {
      module: "STORE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      fromStatus: prev,
      toStatus: "CLOSED",
      description: `GRN ${grn.grnNo} closed`,
    });
    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getGrnSummaryReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.status) filter.status = upper(req.query.status);
    if (req.query.supplierName) filter.supplierName = new RegExp(t(req.query.supplierName), "i");
    const items = await GRN.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSupplierReceivingReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.supplierName) filter.supplierName = new RegExp(t(req.query.supplierName), "i");
    const items = await GRN.find(filter).sort({ createdAt: -1 }).lean();
    const bySupplier = new Map();
    for (const g of items) {
      const key = g.supplierName || "—";
      if (!bySupplier.has(key)) {
        bySupplier.set(key, { supplierName: key, grnCount: 0, receivedQty: 0, acceptedQty: 0, rejectedQty: 0, amount: 0 });
      }
      const row = bySupplier.get(key);
      row.grnCount += 1;
      for (const line of g.items || []) {
        row.receivedQty += Number(line.receivedQty) || 0;
        row.acceptedQty += Number(line.acceptedQty) || 0;
        row.rejectedQty += Number(line.rejectedQty) || 0;
        row.amount += Number(line.lineAmount || 0);
      }
    }
    res.json({ items: Array.from(bySupplier.values()).sort((a, b) => b.amount - a.amount) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrnFromPo(req, res) {
  try {
    const poId = req.params.poId;
    if (!mongoose.Types.ObjectId.isValid(poId)) return res.status(400).json({ message: "Invalid PO id" });
    await syncPurchaseOrderApExtensionFields(req.companyId, poId);
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId }))
      .select(
        "poNo poNumber orderDate currency supplierName supplierId status lines companyId branchId warehouseId apPaymentStatus supplierDocumentStatus grnReceiptStatus grnProgressStatus"
      )
      .lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    if (String(po.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "PO is cancelled" });
    }
    const lines = (po.lines || []).map((l) => {
      const ordered = Number(l.orderedQty ?? l.qty) || 0;
      const received = Number(l.receivedQty) || 0;
      const cancelled = Number(l.cancelledQty) || 0;
      const pending = Math.max(0, Number(l.pendingQty ?? Math.max(0, ordered - received - cancelled)) || 0);
      return {
        poLineId: l._id,
        poId: po._id,
        poNo: po.poNo || po.poNumber,
        article: String(l.itemCode || l.article || "").toUpperCase(),
        description: l.description || "",
        spn: l.partNo || "",
        materialCode: l.itemCode || "",
        orderedQty: ordered,
        receivedQty: received,
        pendingQty: pending,
        unitCost: Number(l.unitPrice) || 0,
        uom: l.uom || "PCS",
      };
    });
    const header = {
      _id: po._id,
      poNo: po.poNo || po.poNumber,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      currency: po.currency || "USD",
      supplierName: po.supplierName,
      supplierId: po.supplierId,
      branchId: po.branchId || null,
      warehouseId: po.warehouseId || null,
      paymentStatus: po.apPaymentStatus || "NOT_PAID",
      supplierInvoiceStatus: po.supplierDocumentStatus || "NONE",
      grnReceiptStatus: po.grnReceiptStatus || "NOT_RECEIVED",
      grnProgressStatus: po.grnProgressStatus || "NONE",
      poStatus: po.status,
    };
    res.json({
      header,
      lines,
      po,
      supplierName: po.supplierName,
      supplierId: po.supplierId,
      currency: po.currency || "USD",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrnByMongoId(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await GRN.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPendingPoGrnReport(req, res) {
  try {
    const pos = await PurchaseOrder.find(
      withCompany(req, {
        status: { $nin: ["CANCELLED", "CLOSED", "REJECTED"] },
      })
    )
      .sort({ orderDate: -1 })
      .limit(200)
      .lean();
    const items = [];
    for (const po of pos) {
      let pendingLines = 0;
      for (const l of po.lines || []) {
        const p = Number(l.pendingQty ?? 0);
        if (p > 0) pendingLines += 1;
      }
      if (pendingLines > 0) {
        items.push({
          poNo: po.poNo || po.poNumber,
          supplierName: po.supplierName,
          status: po.status,
          pendingLines,
          grandTotal: po.grandTotal,
        });
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
