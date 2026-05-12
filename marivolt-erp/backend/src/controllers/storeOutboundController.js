import mongoose from "mongoose";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import * as stockService from "../services/stockService.js";
import { nextNumber } from "../services/numberSeriesService.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}

async function nextPackingNo(companyId, companyCode) {
  const { number } = await nextNumber({
    companyId,
    companyCode,
    docKey: "STORE_PACKING",
    referenceDate: new Date(),
    branchId: null,
  });
  return number;
}

async function nextDispatchNo(companyId, companyCode) {
  const { number } = await nextNumber({
    companyId,
    companyCode,
    docKey: "STORE_DISPATCH",
    referenceDate: new Date(),
    branchId: null,
  });
  return number;
}

async function sumPostedPackQtyByLine(companyId, allocationId) {
  const packs = await StorePacking.find({
    companyId,
    allocationId,
    status: "POSTED",
  })
    .select("lines")
    .lean();
  const map = new Map();
  for (const p of packs) {
    for (const ln of p.lines || []) {
      if (!ln.allocationLineId) continue;
      const k = String(ln.allocationLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.packQty) || 0));
    }
  }
  return map;
}

async function sumPostedDispatchQtyByPackingLine(companyId, packingId) {
  const rows = await StoreDispatch.find({
    companyId,
    packingId,
    status: "POSTED",
  })
    .select("lines")
    .lean();
  const map = new Map();
  for (const d of rows) {
    for (const ln of d.lines || []) {
      if (!ln.packingLineId) continue;
      const k = String(ln.packingLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.dispatchQty) || 0));
    }
  }
  return map;
}

function normalizePackingLines(bodyLines = [], allocation) {
  const allocLines = allocation.lines || [];
  return (bodyLines || [])
    .map((ln) => {
      const allocationLineId = mongoose.Types.ObjectId.isValid(String(ln.allocationLineId || ""))
        ? new mongoose.Types.ObjectId(String(ln.allocationLineId))
        : null;
      const match = allocationLineId ? allocLines.find((x) => String(x._id) === String(allocationLineId)) : null;
      const article = String(ln.article || match?.article || "").trim().toUpperCase();
      return {
        allocationLineId,
        article,
        description: t(ln.description || match?.description || ""),
        spn: t(ln.spn || ln.partNumber || match?.partNumber || ""),
        materialCode: t(ln.materialCode || match?.materialCode || ""),
        allocatedQty: Number(match?.qty) || 0,
        packQty: Math.max(0, Number(ln.packQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        packageNo: t(ln.packageNo),
        boxNo: t(ln.boxNo),
        dimensions: t(ln.dimensions),
        grossWeightKg: Number(ln.grossWeightKg) || 0,
        netWeightKg: Number(ln.netWeightKg) || 0,
        volumeM3: Number(ln.volumeM3) || 0,
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.packQty > 0 && ln.allocationLineId);
}

export async function listStorePacking(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.search) {
      const re = new RegExp(t(req.query.search), "i");
      filter.$or = [{ packingNo: re }, { customerName: re }, { allocationNo: re }];
    }
    const [items, total] = await Promise.all([
      StorePacking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StorePacking.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getStorePacking(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await StorePacking.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPackingFromAllocation(req, res) {
  try {
    const allocationId = req.params.allocationId;
    if (!mongoose.Types.ObjectId.isValid(allocationId)) {
      return res.status(400).json({ message: "Invalid allocation id" });
    }
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId })).lean();
    if (!allocation) return res.status(404).json({ message: "Allocation not found" });
    const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
    const lines = (allocation.lines || []).map((ln) => ({
      allocationLineId: ln._id,
      article: ln.article,
      description: ln.description || "",
      partNumber: ln.partNumber || "",
      materialCode: ln.materialCode || "",
      qty: Number(ln.qty) || 0,
      alreadyPacked: packedByLine.get(String(ln._id)) || 0,
      pendingPack: Math.max(0, (Number(ln.qty) || 0) - (packedByLine.get(String(ln._id)) || 0)),
      uom: ln.uom || "PCS",
    }));
    res.json({
      allocation,
      lines,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createStorePackingDraft(req, res) {
  try {
    const allocationId = req.body.allocationId;
    if (!mongoose.Types.ObjectId.isValid(String(allocationId || ""))) {
      return res.status(400).json({ message: "allocationId required" });
    }
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: allocationId }));
    if (!allocation) return res.status(404).json({ message: "Allocation not found" });
    if (String(allocation.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot pack a cancelled allocation" });
    }
    const packingNo = t(req.body.packingNo) || (await nextPackingNo(req.companyId, req.companyCode));
    const lines = normalizePackingLines(req.body.lines || [], allocation);
    if (!lines.length) return res.status(400).json({ message: "At least one packing line required" });
    const doc = await StorePacking.create({
      companyId: req.companyId,
      branchId: req.body.branchId || null,
      packingNo,
      packingDate: req.body.packingDate || new Date(),
      warehouse: String(allocation.warehouse || "MAIN").toUpperCase(),
      allocationId: allocation._id,
      allocationNo: allocation.allocationNo,
      linkedOANo: allocation.linkedOANo || "",
      linkedProformaNo: allocation.linkedProformaNo || "",
      customerName: allocation.customerName,
      engine: allocation.engine || "",
      model: allocation.model || "",
      esn: allocation.esn || "",
      currency: String(allocation.currency || "USD").toUpperCase(),
      lines,
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
      remarks: t(req.body.remarks),
      status: "DRAFT",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "STORE_PACKING",
      entityId: doc._id,
      documentNo: doc.packingNo,
      description: `Packing ${doc.packingNo} draft`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postStorePacking(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const id = req.params.id;
      const doc = await StorePacking.findOne(withCompany(req, { _id: id })).session(session);
      if (!doc) throw new Error("Packing not found");
      if (doc.status !== "DRAFT") throw new Error("Only DRAFT packing can be posted");
      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: doc.allocationId })).session(session);
      if (!allocation) throw new Error("Allocation not found");
      if (String(allocation.status || "").toUpperCase() === "CANCELLED") throw new Error("Allocation cancelled");

      const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
      const wh = String(doc.warehouse || allocation.warehouse || "MAIN").toUpperCase();

      for (const ln of doc.lines || []) {
        const lineId = String(ln.allocationLineId || "");
        const allocLine = (allocation.lines || []).find((x) => String(x._id) === lineId);
        if (!allocLine) throw new Error(`Allocation line missing for ${ln.article}`);
        const maxQty = Number(allocLine.qty) || 0;
        const already = packedByLine.get(lineId) || 0;
        const packQty = Number(ln.packQty) || 0;
        if (packQty <= 0) throw new Error(`Invalid pack qty for ${ln.article}`);
        if (already + packQty > maxQty) {
          throw new Error(`Pack qty exceeds pending for ${ln.article} (max ${maxQty - already})`);
        }
        await stockService.packFromAllocation({
          session,
          companyId: req.companyId,
          article: ln.article,
          warehouse: wh,
          qty: packQty,
          customerName: allocation.customerName || "",
          referenceType: "STORE_PACKING",
          referenceNo: doc.packingNo,
          remarks: `Packing ${doc.packingNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
          allocationId: allocation._id,
          transactionDate: doc.packingDate || new Date(),
        });
      }

      doc.status = "POSTED";
      doc.postedAt = new Date();
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "STORE_PACKING",
        entityId: doc._id,
        documentNo: doc.packingNo,
        description: `Packing ${doc.packingNo} posted`,
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function cancelStorePacking(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const id = req.params.id;
      const doc = await StorePacking.findOne(withCompany(req, { _id: id })).session(session);
      if (!doc) throw new Error("Packing not found");
      if (doc.status === "CANCELLED") throw new Error("Already cancelled");
      if (doc.status === "DRAFT") {
        doc.status = "CANCELLED";
        doc.cancelledAt = new Date();
        doc.cancellationReason = t(req.body?.reason);
        doc.updatedBy = req.user?.email || "";
        await doc.save({ session });
        return;
      }
      if (doc.status !== "POSTED") throw new Error("Cannot cancel this packing");

      const dispatched = await StoreDispatch.findOne({
        companyId: req.companyId,
        packingId: doc._id,
        status: "POSTED",
      })
        .session(session)
        .select("_id")
        .lean();
      if (dispatched) throw new Error("Cannot cancel packing: dispatch already posted");

      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: doc.allocationId })).session(session);
      const wh = String(doc.warehouse || allocation?.warehouse || "MAIN").toUpperCase();

      for (const ln of doc.lines || []) {
        const q = Number(ln.packQty) || 0;
        if (!(q > 0)) continue;
        await stockService.unpackFromPacked({
          session,
          companyId: req.companyId,
          article: ln.article,
          warehouse: wh,
          qty: q,
          customerName: allocation?.customerName || "",
          referenceType: "STORE_PACKING",
          referenceNo: doc.packingNo,
          remarks: `Cancel packing ${doc.packingNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
          allocationId: doc.allocationId,
        });
      }
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancellationReason = t(req.body?.reason);
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "STORE_PACKING",
        entityId: doc._id,
        documentNo: doc.packingNo,
        description: `Packing ${doc.packingNo} cancelled`,
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function listStoreDispatch(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.search) {
      const re = new RegExp(t(req.query.search), "i");
      filter.$or = [{ dispatchNo: re }, { customerName: re }, { packingNo: re }];
    }
    const [items, total] = await Promise.all([
      StoreDispatch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      StoreDispatch.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getStoreDispatch(req, res) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await StoreDispatch.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDispatchFromPacking(req, res) {
  try {
    const packingId = req.params.packingId;
    if (!mongoose.Types.ObjectId.isValid(packingId)) return res.status(400).json({ message: "Invalid packing id" });
    const packing = await StorePacking.findOne(withCompany(req, { _id: packingId })).lean();
    if (!packing) return res.status(404).json({ message: "Packing not found" });
    if (packing.status !== "POSTED") return res.status(400).json({ message: "Packing must be posted" });
    const dispatchedByLine = await sumPostedDispatchQtyByPackingLine(req.companyId, packing._id);
    const lines = (packing.lines || []).map((ln) => {
      const packed = Number(ln.packQty) || 0;
      const out = dispatchedByLine.get(String(ln._id)) || 0;
      return {
        packingLineId: ln._id,
        article: ln.article,
        description: ln.description || "",
        spn: ln.spn || "",
        materialCode: ln.materialCode || "",
        packedQty: packed,
        dispatchedQty: out,
        pendingDispatch: Math.max(0, packed - out),
        uom: ln.uom || "PCS",
      };
    });
    res.json({ packing, lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

function normalizeDispatchLines(bodyLines = [], packing) {
  const packingLines = packing.lines || [];
  return (bodyLines || [])
    .map((ln) => {
      const packingLineId = mongoose.Types.ObjectId.isValid(String(ln.packingLineId || ""))
        ? new mongoose.Types.ObjectId(String(ln.packingLineId))
        : null;
      const match = packingLineId ? packingLines.find((x) => String(x._id) === String(packingLineId)) : null;
      return {
        packingLineId,
        article: String(ln.article || match?.article || "").trim().toUpperCase(),
        description: t(ln.description || match?.description || ""),
        spn: t(ln.spn || match?.spn || ""),
        materialCode: t(ln.materialCode || match?.materialCode || ""),
        packedQty: Number(match?.packQty) || 0,
        dispatchQty: Math.max(0, Number(ln.dispatchQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.dispatchQty > 0 && ln.packingLineId);
}

export async function createStoreDispatchDraft(req, res) {
  try {
    const packingId = req.body.packingId;
    if (!mongoose.Types.ObjectId.isValid(String(packingId || ""))) {
      return res.status(400).json({ message: "packingId required" });
    }
    const packing = await StorePacking.findOne(withCompany(req, { _id: packingId }));
    if (!packing) return res.status(404).json({ message: "Packing not found" });
    if (packing.status !== "POSTED") return res.status(400).json({ message: "Packing must be posted" });

    const dispatchedByLine = await sumPostedDispatchQtyByPackingLine(req.companyId, packing._id);
    const linesIn = Array.isArray(req.body.lines) && req.body.lines.length
      ? req.body.lines
      : (packing.lines || []).map((ln) => {
          const packed = Number(ln.packQty) || 0;
          const out = dispatchedByLine.get(String(ln._id)) || 0;
          return { packingLineId: ln._id, article: ln.article, dispatchQty: Math.max(0, packed - out) };
        });

    const dispatchNo = t(req.body.dispatchNo) || (await nextDispatchNo(req.companyId, req.companyCode));
    const lines = normalizeDispatchLines(linesIn, packing);
    if (!lines.length) return res.status(400).json({ message: "Nothing to dispatch (all lines complete or empty)" });

    for (const ln of lines) {
      const match = (packing.lines || []).find((x) => String(x._id) === String(ln.packingLineId));
      const packed = Number(match?.packQty) || 0;
      const out = dispatchedByLine.get(String(ln.packingLineId)) || 0;
      if (out + ln.dispatchQty > packed) {
        return res.status(400).json({ message: `Dispatch qty exceeds packed for ${ln.article}` });
      }
    }

    const doc = await StoreDispatch.create({
      companyId: req.companyId,
      branchId: req.body.branchId || packing.branchId || null,
      dispatchNo,
      dispatchDate: req.body.dispatchDate || new Date(),
      warehouse: String(packing.warehouse || "MAIN").toUpperCase(),
      packingId: packing._id,
      packingNo: packing.packingNo,
      allocationId: packing.allocationId,
      allocationNo: packing.allocationNo,
      linkedOANo: packing.linkedOANo || "",
      linkedProformaNo: packing.linkedProformaNo || "",
      customerName: packing.customerName,
      engine: packing.engine || "",
      model: packing.model || "",
      esn: packing.esn || "",
      courier: t(req.body.courier),
      awbNo: t(req.body.awbNo || req.body.awbBlLrNo),
      blNo: t(req.body.blNo),
      lrNo: t(req.body.lrNo),
      vehicleNo: t(req.body.vehicleNo),
      driverName: t(req.body.driverName),
      driverPhone: t(req.body.driverPhone),
      deliveryNote: t(req.body.deliveryNote),
      shipmentMode: t(req.body.shipmentMode),
      currency: String(packing.currency || "USD").toUpperCase(),
      lines,
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
      remarks: t(req.body.remarks),
      status: "DRAFT",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "STORE_DISPATCH",
      entityId: doc._id,
      documentNo: doc.dispatchNo,
      description: `Dispatch ${doc.dispatchNo} draft`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postStoreDispatch(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const id = req.params.id;
      const doc = await StoreDispatch.findOne(withCompany(req, { _id: id })).session(session);
      if (!doc) throw new Error("Dispatch not found");
      if (doc.status !== "DRAFT") throw new Error("Only DRAFT dispatch can be posted");
      const packing = await StorePacking.findOne(withCompany(req, { _id: doc.packingId })).session(session);
      if (!packing || packing.status !== "POSTED") throw new Error("Packing invalid");

      const dispatchedByLine = await sumPostedDispatchQtyByPackingLine(req.companyId, packing._id);
      const wh = String(doc.warehouse || packing.warehouse || "MAIN").toUpperCase();

      for (const ln of doc.lines || []) {
        const match = (packing.lines || []).find((x) => String(x._id) === String(ln.packingLineId));
        const packed = Number(match?.packQty) || 0;
        const out = dispatchedByLine.get(String(ln.packingLineId)) || 0;
        const dq = Number(ln.dispatchQty) || 0;
        if (out + dq > packed) throw new Error(`Dispatch qty exceeds packed for ${ln.article}`);
        if (!(dq > 0)) continue;
        await stockService.dispatchFromPacked({
          session,
          companyId: req.companyId,
          article: ln.article,
          warehouse: wh,
          qty: dq,
          customerName: doc.customerName || "",
          referenceType: "STORE_DISPATCH",
          referenceNo: doc.dispatchNo,
          remarks: `Dispatch ${doc.dispatchNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
          transactionDate: doc.dispatchDate || new Date(),
        });
      }

      doc.status = "POSTED";
      doc.postedAt = new Date();
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "STORE_DISPATCH",
        entityId: doc._id,
        documentNo: doc.dispatchNo,
        description: `Dispatch ${doc.dispatchNo} posted`,
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

export async function cancelStoreDispatch(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const id = req.params.id;
      const doc = await StoreDispatch.findOne(withCompany(req, { _id: id })).session(session);
      if (!doc) throw new Error("Dispatch not found");
      if (doc.status === "CANCELLED") throw new Error("Already cancelled");
      if (doc.status === "DRAFT") {
        doc.status = "CANCELLED";
        doc.cancelledAt = new Date();
        doc.cancellationReason = t(req.body?.reason);
        doc.updatedBy = req.user?.email || "";
        await doc.save({ session });
        return;
      }
      if (doc.status !== "POSTED") throw new Error("Cannot cancel");

      const packing = await StorePacking.findOne(withCompany(req, { _id: doc.packingId })).session(session);
      const wh = String(doc.warehouse || packing?.warehouse || "MAIN").toUpperCase();

      for (const ln of doc.lines || []) {
        const q = Number(ln.dispatchQty) || 0;
        if (!(q > 0)) continue;
        await stockService.cancelDispatchFromPacked({
          session,
          companyId: req.companyId,
          article: ln.article,
          warehouse: wh,
          qty: q,
          customerName: doc.customerName || "",
          referenceType: "STORE_DISPATCH",
          referenceNo: doc.dispatchNo,
          remarks: `Cancel dispatch ${doc.dispatchNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
        });
      }
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancellationReason = t(req.body?.reason);
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "STORE_DISPATCH",
        entityId: doc._id,
        documentNo: doc.dispatchNo,
        description: `Dispatch ${doc.dispatchNo} cancelled`,
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    session.endSession();
  }
}

/**
 * Read-only fulfilment status for Sales > Dispatch Status tab.
 */
export async function listDispatchStatus(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.customer) filter.customerName = new RegExp(t(req.query.customer), "i");
    const allocations = await OrderAllocation.find({
      ...filter,
      status: { $nin: ["CANCELLED"] },
    })
      .sort({ allocationDate: -1 })
      .limit(300)
      .lean();

    const allocIds = allocations.map((a) => a._id);
    const [packings, dispatches, invoices] = await Promise.all([
      StorePacking.find(withCompany(req, { allocationId: { $in: allocIds }, status: "POSTED" }))
        .select("packingNo allocationId lines")
        .lean(),
      StoreDispatch.find(withCompany(req, { allocationId: { $in: allocIds }, status: "POSTED" }))
        .select("dispatchNo allocationId packingNo lines")
        .lean(),
      SalesInvoice.find(withCompany(req, { linkedOrderAllocationId: { $in: allocIds }, status: { $ne: "CANCELLED" } }))
        .select("invoiceNo linkedOrderAllocationId lines")
        .lean(),
    ]);

    const packByAlloc = new Map();
    for (const p of packings) {
      const k = String(p.allocationId);
      if (!packByAlloc.has(k)) packByAlloc.set(k, []);
      packByAlloc.get(k).push(p);
    }
    const dispByAlloc = new Map();
    for (const d of dispatches) {
      const k = String(d.allocationId);
      if (!dispByAlloc.has(k)) dispByAlloc.set(k, []);
      dispByAlloc.get(k).push(d);
    }
    const invByAlloc = new Map();
    for (const inv of invoices) {
      const k = String(inv.linkedOrderAllocationId || "");
      if (!k) continue;
      invByAlloc.set(k, inv);
    }

    const rows = [];
    for (const a of allocations) {
      const id = String(a._id);
      let totalAlloc = 0;
      for (const ln of a.lines || []) totalAlloc += Number(ln.qty) || 0;
      let packed = 0;
      for (const p of packByAlloc.get(id) || []) {
        for (const ln of p.lines || []) packed += Number(ln.packQty) || 0;
      }
      let dispatched = 0;
      for (const d of dispByAlloc.get(id) || []) {
        for (const ln of d.lines || []) dispatched += Number(ln.dispatchQty) || 0;
      }
      const inv = invByAlloc.get(id);
      const invoiceNo = inv?.invoiceNo || "";
      const packingNos = [...new Set((packByAlloc.get(id) || []).map((p) => p.packingNo).filter(Boolean))].join(", ");
      const dispatchNos = [...new Set((dispByAlloc.get(id) || []).map((d) => d.dispatchNo).filter(Boolean))].join(", ");
      let dispatchStatus = "Pending Packing";
      if (packed <= 0) dispatchStatus = "Pending Packing";
      else if (dispatched >= packed) dispatchStatus = "Fully Dispatched";
      else if (dispatched > 0) dispatchStatus = "Partially Dispatched";
      else dispatchStatus = "Packed";
      rows.push({
        customerName: a.customerName,
        oaNo: a.linkedOANo || "",
        piNo: a.linkedProformaNo || "",
        allocationNo: a.allocationNo,
        packingNo: packingNos || "—",
        dispatchNo: dispatchNos || "—",
        invoiceNo: invoiceNo || "—",
        packedQty: packed,
        dispatchedQty: dispatched,
        balanceQty: Math.max(0, packed - dispatched),
        allocationQty: totalAlloc,
        dispatchStatus,
        companyId: a.companyId,
      });
    }
    res.json({ items: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackingPendingDispatch(req, res) {
  try {
    const posted = await StorePacking.find(withCompany(req, { status: "POSTED" })).lean();
    const items = [];
    for (const p of posted) {
      const dispatchedByLine = await sumPostedDispatchQtyByPackingLine(req.companyId, p._id);
      let pending = 0;
      for (const ln of p.lines || []) {
        const packed = Number(ln.packQty) || 0;
        const out = dispatchedByLine.get(String(ln._id)) || 0;
        pending += Math.max(0, packed - out);
      }
      if (pending > 0) {
        items.push({
          packingNo: p.packingNo,
          customerName: p.customerName,
          allocationNo: p.allocationNo,
          pendingQty: pending,
        });
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchSummary(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: "POSTED" }))
      .sort({ dispatchDate: -1 })
      .limit(500)
      .lean();
    const items = rows.map((d) => ({
      dispatchNo: d.dispatchNo,
      dispatchDate: d.dispatchDate,
      customerName: d.customerName,
      packingNo: d.packingNo,
      awbNo: d.awbNo,
      courier: d.courier,
      lineCount: (d.lines || []).length,
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
