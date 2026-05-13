import mongoose from "mongoose";
import OrderAllocation from "../models/OrderAllocation.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import * as stockService from "../services/stockService.js";
import Counter from "../models/Counter.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}

const POSTED_PACKING_STATUSES = ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"];
const POSTED_DISPATCH_STATUSES = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];
const DISPATCH_READY_INVOICE_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID"];
const PACKAGE_TYPES = new Set(["CARTON", "PALLET", "WOODEN_BOX", "CRATE", "BUNDLE"]);

function companyCode(v) {
  return String(v || "CMP").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "CMP";
}

function normalizePackageType(v) {
  const raw = t(v || "CARTON").toUpperCase().replace(/[\s-]+/g, "_");
  return PACKAGE_TYPES.has(raw) ? raw : "CARTON";
}

async function nextStoreDocNo(companyId, companyCodeRaw, kind) {
  const code = companyCode(companyCodeRaw);
  const prefix = kind === "PACKING" ? "PK" : "DSP";
  const key = kind === "PACKING" ? `packing:${code}` : `dispatch:${code}`;
  const row = await Counter.findOneAndUpdate(
    { companyId, key },
    {
      $setOnInsert: { companyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  ).lean();
  return `${prefix}-${code}-${String(Number(row.seq) || 0).padStart(4, "0")}`;
}

async function nextPackingNo(companyId, companyCode) {
  return nextStoreDocNo(companyId, companyCode, "PACKING");
}

async function nextDispatchNo(companyId, companyCode) {
  return nextStoreDocNo(companyId, companyCode, "DISPATCH");
}

async function sumPostedPackQtyByLine(companyId, allocationId) {
  const packs = await StorePacking.find({
    companyId,
    allocationId,
    status: { $in: POSTED_PACKING_STATUSES },
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
    status: { $in: POSTED_DISPATCH_STATUSES },
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

async function sumPostedDispatchQtyByInvoiceLine(companyId, salesInvoiceId) {
  const rows = await StoreDispatch.find({
    companyId,
    salesInvoiceId,
    status: { $in: POSTED_DISPATCH_STATUSES },
  })
    .select("lines")
    .lean();
  const map = new Map();
  for (const d of rows) {
    for (const ln of d.lines || []) {
      if (!ln.invoiceLineId) continue;
      const k = String(ln.invoiceLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.dispatchQty) || 0));
    }
  }
  return map;
}

async function sumInvoicedQtyByPackingLine(companyId, packingId) {
  const invoices = await SalesInvoice.find({
    companyId,
    linkedStorePackingId: packingId,
    status: { $ne: "CANCELLED" },
  })
    .select("lines")
    .lean();
  const map = new Map();
  for (const inv of invoices) {
    for (const ln of inv.lines || []) {
      if (!ln.packingLineId) continue;
      const k = String(ln.packingLineId);
      map.set(k, (map.get(k) || 0) + (Number(ln.qty) || 0));
    }
  }
  return map;
}

function normalizePackageItems(bodyItems = [], allocation) {
  const allocLines = allocation.lines || [];
  return (bodyItems || [])
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
        qty: Math.max(0, Number(ln.qty ?? ln.packQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.qty > 0 && ln.allocationLineId);
}

function normalizePackingPackages(bodyPackages = [], allocation) {
  return (bodyPackages || [])
    .map((pkg, idx) => {
      const items = normalizePackageItems(pkg.items || [], allocation);
      return {
        packageNo: t(pkg.packageNo) || `Carton-${idx + 1}`,
        packageType: normalizePackageType(pkg.packageType),
        dimensions: t(pkg.dimensions),
        grossWeightKg: Math.max(0, Number(pkg.grossWeightKg) || 0),
        netWeightKg: Math.max(0, Number(pkg.netWeightKg) || 0),
        packageRemarks: t(pkg.packageRemarks || pkg.remarks),
        marksAndNumbers: t(pkg.marksAndNumbers),
        barcode: t(pkg.barcode),
        qrCode: t(pkg.qrCode),
        items,
      };
    })
    .filter((pkg) => pkg.packageNo && pkg.items.length);
}

function legacyLinesToPackages(bodyLines = [], allocation) {
  const items = normalizePackageItems(bodyLines, allocation);
  if (!items.length) return [];
  return [
    {
      packageNo: "Carton-1",
      packageType: "CARTON",
      dimensions: "",
      grossWeightKg: 0,
      netWeightKg: 0,
      packageRemarks: "",
      marksAndNumbers: "",
      barcode: "",
      qrCode: "",
      items,
    },
  ];
}

function aggregatePackingLines(packages = [], allocation) {
  const allocLines = allocation.lines || [];
  const map = new Map();
  for (const pkg of packages || []) {
    for (const item of pkg.items || []) {
      const lineId = String(item.allocationLineId || "");
      const match = allocLines.find((x) => String(x._id) === lineId);
      if (!match) continue;
      const prev = map.get(lineId) || {
        allocationLineId: item.allocationLineId,
        article: String(item.article || match.article || "").trim().toUpperCase(),
        description: t(item.description || match.description || ""),
        spn: t(item.spn || match.partNumber || ""),
        materialCode: t(item.materialCode || match.materialCode || ""),
        allocatedQty: Number(match.qty) || 0,
        packQty: 0,
        uom: t(item.uom || match.uom || "PCS") || "PCS",
        remarks: "",
      };
      prev.packQty += Number(item.qty) || 0;
      map.set(lineId, prev);
    }
  }
  return Array.from(map.values()).filter((ln) => ln.article && ln.packQty > 0 && ln.allocationLineId);
}

function packageTotals(packages = []) {
  return {
    totalPackages: packages.length,
    totalGrossWeightKg: packages.reduce((sum, pkg) => sum + (Number(pkg.grossWeightKg) || 0), 0),
    totalNetWeightKg: packages.reduce((sum, pkg) => sum + (Number(pkg.netWeightKg) || 0), 0),
  };
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

export async function listPendingPackingAllocations(req, res) {
  try {
    const q = t(req.query.search);
    const filter = withCompany(req, { status: { $nin: ["CANCELLED", "CLOSED"] } });
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ allocationNo: re }, { customerName: re }, { linkedOANo: re }, { linkedProformaNo: re }];
    }
    const allocations = await OrderAllocation.find(filter).sort({ allocationDate: -1 }).limit(200).lean();
    const items = [];
    for (const allocation of allocations) {
      const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
      let allocatedQty = 0;
      let packedQty = 0;
      for (const ln of allocation.lines || []) {
        allocatedQty += Number(ln.qty) || 0;
        packedQty += packedByLine.get(String(ln._id)) || 0;
      }
      const pendingPackQty = Math.max(0, allocatedQty - packedQty);
      if (pendingPackQty <= 0) continue;
      items.push({
        _id: allocation._id,
        allocationNo: allocation.allocationNo,
        linkedOANo: allocation.linkedOANo || "",
        linkedProformaNo: allocation.linkedProformaNo || "",
        customerName: allocation.customerName,
        status: allocation.status,
        warehouse: allocation.warehouse || "MAIN",
        allocatedQty,
        alreadyPackedQty: packedQty,
        pendingPackQty,
      });
    }
    res.json({ items, total: items.length });
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
    const wh = String(allocation.warehouse || "MAIN").toUpperCase();
    const lines = [];
    for (const ln of allocation.lines || []) {
      const stock = await stockService.getStockBalance({
        companyId: req.companyId,
        article: ln.article,
        warehouse: wh,
      });
      const allocatedQty = Number(ln.qty) || 0;
      const alreadyPacked = packedByLine.get(String(ln._id)) || 0;
      lines.push({
        allocationLineId: ln._id,
        article: ln.article,
        description: ln.description || "",
        partNumber: ln.partNumber || "",
        materialCode: ln.materialCode || "",
        location: wh,
        qty: allocatedQty,
        allocatedQty,
        alreadyPacked,
        pendingPack: Math.max(0, allocatedQty - alreadyPacked),
        availableStock: stock.availableQty,
        uom: ln.uom || "PCS",
      });
    }
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
    const packages = normalizePackingPackages(req.body.packages || [], allocation);
    const normalizedPackages = packages.length ? packages : legacyLinesToPackages(req.body.lines || [], allocation);
    const lines = aggregatePackingLines(normalizedPackages, allocation);
    if (!lines.length) return res.status(400).json({ message: "At least one packing line required" });
    const packedByLine = await sumPostedPackQtyByLine(req.companyId, allocation._id);
    for (const ln of lines) {
      const allocLine = (allocation.lines || []).find((x) => String(x._id) === String(ln.allocationLineId));
      const maxQty = Number(allocLine?.qty) || 0;
      const already = packedByLine.get(String(ln.allocationLineId)) || 0;
      if (already + (Number(ln.packQty) || 0) > maxQty) {
        return res.status(400).json({ message: `Pack qty exceeds pending for ${ln.article} (max ${Math.max(0, maxQty - already)})` });
      }
    }
    const totals = packageTotals(normalizedPackages);
    const doc = await StorePacking.create({
      companyId: req.companyId,
      branchId: req.body.branchId || null,
      packingNo,
      packingDate: req.body.packingDate || new Date(),
      warehouse: String(allocation.warehouse || "MAIN").toUpperCase(),
      sourceDocumentType: "ORDER_ALLOCATION",
      sourceDocumentId: allocation._id,
      allocationId: allocation._id,
      allocationNo: allocation.allocationNo,
      linkedOANo: allocation.linkedOANo || "",
      linkedProformaNo: allocation.linkedProformaNo || "",
      customerName: allocation.customerName,
      engine: allocation.engine || "",
      model: allocation.model || "",
      esn: allocation.esn || "",
      currency: String(allocation.currency || "USD").toUpperCase(),
      ...totals,
      marksAndNumbers: t(req.body.marksAndNumbers),
      packages: normalizedPackages,
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
      if (doc.packages?.length) {
        const totals = packageTotals(doc.packages);
        doc.totalPackages = totals.totalPackages;
        doc.totalGrossWeightKg = totals.totalGrossWeightKg;
        doc.totalNetWeightKg = totals.totalNetWeightKg;
      }

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

      const totalAlloc = (allocation.lines || []).reduce((sum, ln) => sum + (Number(ln.qty) || 0), 0);
      const totalPackedBefore = Array.from(packedByLine.values()).reduce((sum, qty) => sum + (Number(qty) || 0), 0);
      const totalPackedNow = (doc.lines || []).reduce((sum, ln) => sum + (Number(ln.packQty) || 0), 0);
      doc.status = totalPackedBefore + totalPackedNow >= totalAlloc - 1e-6 ? "FULLY_PACKED" : "PARTIALLY_PACKED";
      allocation.status = doc.status;
      allocation.updatedBy = req.user?.email || "";
      doc.postedAt = new Date();
      doc.updatedBy = req.user?.email || "";
      await allocation.save({ session });
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
      if (!POSTED_PACKING_STATUSES.includes(doc.status)) throw new Error("Cannot cancel this packing");
      const invoiced = await SalesInvoice.findOne({
        companyId: req.companyId,
        linkedStorePackingId: doc._id,
        status: { $ne: "CANCELLED" },
      })
        .session(session)
        .select("_id invoiceNo")
        .lean();
      if (invoiced) throw new Error(`Cannot cancel packing: sales invoice ${invoiced.invoiceNo} exists`);

      const dispatched = await StoreDispatch.findOne({
        companyId: req.companyId,
        packingId: doc._id,
        status: { $in: POSTED_DISPATCH_STATUSES },
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
      if (doc.salesInvoiceId) {
        const remainingDispatch = await StoreDispatch.findOne({
          companyId: req.companyId,
          salesInvoiceId: doc.salesInvoiceId,
          _id: { $ne: doc._id },
          status: { $in: POSTED_DISPATCH_STATUSES },
        }).session(session);
        await SalesInvoice.findOneAndUpdate(
          withCompany(req, { _id: doc.salesInvoiceId }),
          {
            status: "ISSUED",
            linkedSalesDispatchId: remainingDispatch?._id || null,
            linkedSalesDispatchNo: remainingDispatch?.dispatchNo || "",
            updatedBy: req.user?.email || "",
          },
          { session }
        );
      }
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

export async function listPendingDispatchPackings(req, res) {
  try {
    return listPendingDispatchInvoices(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listPendingDispatchInvoices(req, res) {
  try {
    const q = t(req.query.search);
    const filter = withCompany(req, {
      status: { $in: DISPATCH_READY_INVOICE_STATUSES },
      linkedStorePackingId: { $ne: null },
    });
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [
        { invoiceNo: re },
        { customerName: re },
        { linkedStorePackingNo: re },
        { linkedOrderAllocationNo: re },
        { linkedOANo: re },
        { linkedProformaNo: re },
      ];
    }
    const invoices = await SalesInvoice.find(filter).sort({ invoiceDate: -1 }).limit(200).lean();
    const items = [];
    for (const invoice of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of invoice.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      items.push({
        _id: invoice._id,
        invoiceNo: invoice.invoiceNo,
        packingNo: invoice.linkedStorePackingNo || "",
        allocationNo: invoice.linkedOrderAllocationNo || "",
        linkedQuotationNo: invoice.linkedQuotationNo || "",
        linkedOANo: invoice.linkedOANo || "",
        linkedProformaNo: invoice.linkedProformaNo || "",
        customerName: invoice.customerName,
        status: invoice.status,
        invoiceQty,
        alreadyDispatchedQty: dispatchedQty,
        pendingDispatchQty,
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDispatchFromPacking(req, res) {
  return res.status(400).json({ message: "Dispatch must be created from a posted Sales Invoice, not directly from packing" });
}

export async function getDispatchFromInvoice(req, res) {
  try {
    const invoiceId = req.params.invoiceId;
    if (!mongoose.Types.ObjectId.isValid(invoiceId)) return res.status(400).json({ message: "Invalid invoice id" });
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: invoiceId })).lean();
    if (!invoice) return res.status(404).json({ message: "Sales Invoice not found" });
    if (String(invoice.status || "").toUpperCase() === "CANCELLED") return res.status(400).json({ message: "Cannot dispatch cancelled invoice" });
    if (!DISPATCH_READY_INVOICE_STATUSES.includes(String(invoice.status || "").toUpperCase())) {
      return res.status(400).json({ message: "Dispatch requires a posted Sales Invoice" });
    }
    if (!invoice.linkedStorePackingId) return res.status(400).json({ message: "Cannot dispatch without invoice linked to packing" });
    const packing = await StorePacking.findOne(withCompany(req, { _id: invoice.linkedStorePackingId })).lean();
    if (!packing) return res.status(404).json({ message: "Linked packing not found" });
    const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
    const lines = (invoice.lines || []).map((ln) => {
      const invoiceQty = Number(ln.qty) || 0;
      const out = dispatchedByLine.get(String(ln._id)) || 0;
      return {
        invoiceLineId: ln._id,
        packingLineId: ln.packingLineId || null,
        article: ln.article,
        description: ln.description || "",
        spn: ln.partNumber || "",
        materialCode: ln.materialCode || "",
        invoiceQty,
        dispatchedQty: out,
        pendingDispatch: Math.max(0, invoiceQty - out),
        uom: ln.uom || "PCS",
      };
    });
    res.json({ invoice, packing, lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

function normalizeDispatchLines(bodyLines = [], invoice) {
  const invoiceLines = invoice.lines || [];
  return (bodyLines || [])
    .map((ln) => {
      const invoiceLineId = mongoose.Types.ObjectId.isValid(String(ln.invoiceLineId || ""))
        ? new mongoose.Types.ObjectId(String(ln.invoiceLineId))
        : null;
      const match = invoiceLineId ? invoiceLines.find((x) => String(x._id) === String(invoiceLineId)) : null;
      return {
        invoiceLineId,
        packingLineId: match?.packingLineId || null,
        article: String(ln.article || match?.article || "").trim().toUpperCase(),
        description: t(ln.description || match?.description || ""),
        spn: t(ln.spn || match?.partNumber || ""),
        materialCode: t(ln.materialCode || match?.materialCode || ""),
        invoiceQty: Number(match?.qty) || 0,
        packedQty: Number(match?.qty) || 0,
        dispatchQty: Math.max(0, Number(ln.dispatchQty) || 0),
        uom: t(ln.uom || match?.uom || "PCS") || "PCS",
        remarks: t(ln.remarks),
      };
    })
    .filter((ln) => ln.article && ln.dispatchQty > 0 && ln.invoiceLineId);
}

export async function createStoreDispatchDraft(req, res) {
  try {
    const invoiceId = req.body.salesInvoiceId || req.body.invoiceId;
    if (!mongoose.Types.ObjectId.isValid(String(invoiceId || ""))) {
      return res.status(400).json({ message: "salesInvoiceId required. Dispatch must be created from posted Sales Invoice." });
    }
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: invoiceId }));
    if (!invoice) return res.status(404).json({ message: "Sales Invoice not found" });
    if (String(invoice.status || "").toUpperCase() === "CANCELLED") return res.status(400).json({ message: "Cannot dispatch cancelled invoice" });
    if (!DISPATCH_READY_INVOICE_STATUSES.includes(String(invoice.status || "").toUpperCase())) {
      return res.status(400).json({ message: "Dispatch requires a posted Sales Invoice" });
    }
    if (!invoice.linkedStorePackingId) return res.status(400).json({ message: "Cannot dispatch without invoice linked to packing" });
    const packing = await StorePacking.findOne(withCompany(req, { _id: invoice.linkedStorePackingId }));
    if (!packing) return res.status(404).json({ message: "Linked packing not found" });
    if (!POSTED_PACKING_STATUSES.includes(packing.status)) return res.status(400).json({ message: "Linked packing must be posted" });

    const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
    const linesIn = Array.isArray(req.body.lines) && req.body.lines.length
      ? req.body.lines
      : (invoice.lines || []).map((ln) => {
          const invoiceQty = Number(ln.qty) || 0;
          const out = dispatchedByLine.get(String(ln._id)) || 0;
          return { invoiceLineId: ln._id, article: ln.article, dispatchQty: Math.max(0, invoiceQty - out) };
        });

    const dispatchNo = t(req.body.dispatchNo) || (await nextDispatchNo(req.companyId, req.companyCode));
    const lines = normalizeDispatchLines(linesIn, invoice);
    if (!lines.length) return res.status(400).json({ message: "Nothing to dispatch (all lines complete or empty)" });

    for (const ln of lines) {
      const match = (invoice.lines || []).find((x) => String(x._id) === String(ln.invoiceLineId));
      const invoiceQty = Number(match?.qty) || 0;
      const out = dispatchedByLine.get(String(ln.invoiceLineId)) || 0;
      if (out + ln.dispatchQty > invoiceQty) {
        return res.status(400).json({ message: `Dispatch qty exceeds invoice pending dispatch qty for ${ln.article}` });
      }
    }

    const doc = await StoreDispatch.create({
      companyId: req.companyId,
      branchId: req.body.branchId || packing.branchId || null,
      dispatchNo,
      dispatchDate: req.body.dispatchDate || new Date(),
      warehouse: String(packing.warehouse || "MAIN").toUpperCase(),
      sourceDocumentType: "SALES_INVOICE",
      sourceDocumentId: invoice._id,
      packingId: packing._id,
      packingNo: packing.packingNo,
      salesInvoiceId: invoice._id,
      salesInvoiceNo: invoice.invoiceNo,
      allocationId: packing.allocationId,
      allocationNo: packing.allocationNo,
      linkedQuotationNo: invoice.linkedQuotationNo || "",
      linkedOANo: invoice.linkedOANo || packing.linkedOANo || "",
      linkedProformaNo: invoice.linkedProformaNo || packing.linkedProformaNo || "",
      customerName: invoice.customerName || packing.customerName,
      engine: packing.engine || "",
      model: packing.model || "",
      esn: packing.esn || "",
      transporter: t(req.body.transporter || req.body.courier),
      courier: t(req.body.courier || req.body.transporter),
      awbNo: t(req.body.awbNo || req.body.awbBlLrNo),
      blNo: t(req.body.blNo),
      trackingNo: t(req.body.trackingNo || req.body.awbNo || req.body.awbBlLrNo),
      containerNo: t(req.body.containerNo),
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
      if (!packing || !POSTED_PACKING_STATUSES.includes(packing.status)) throw new Error("Packing invalid");
      const invoice = await SalesInvoice.findOne(withCompany(req, { _id: doc.salesInvoiceId })).session(session);
      if (!invoice) throw new Error("Sales Invoice required before dispatch");
      if (String(invoice.status || "").toUpperCase() === "CANCELLED") throw new Error("Cannot dispatch cancelled invoice");
      if (!DISPATCH_READY_INVOICE_STATUSES.includes(String(invoice.status || "").toUpperCase())) {
        throw new Error("Dispatch requires a posted Sales Invoice");
      }

      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, invoice._id);
      const wh = String(doc.warehouse || packing.warehouse || "MAIN").toUpperCase();

      for (const ln of doc.lines || []) {
        const match = (invoice.lines || []).find((x) => String(x._id) === String(ln.invoiceLineId));
        const invoiceQty = Number(match?.qty) || 0;
        const out = dispatchedByLine.get(String(ln.invoiceLineId)) || 0;
        const dq = Number(ln.dispatchQty) || 0;
        if (out + dq > invoiceQty) throw new Error(`Dispatch qty exceeds invoice pending dispatch qty for ${ln.article}`);
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

      const totalInvoiceQty = (invoice.lines || []).reduce((sum, ln) => sum + (Number(ln.qty) || 0), 0);
      const totalDispatchedBefore = Array.from(dispatchedByLine.values()).reduce((sum, qty) => sum + (Number(qty) || 0), 0);
      const totalDispatchedNow = (doc.lines || []).reduce((sum, ln) => sum + (Number(ln.dispatchQty) || 0), 0);
      doc.status =
        totalDispatchedBefore + totalDispatchedNow >= totalInvoiceQty - 1e-6
          ? "FULLY_DISPATCHED"
          : "PARTIALLY_DISPATCHED";
      invoice.status = doc.status === "FULLY_DISPATCHED" ? "DISPATCHED" : invoice.status;
      invoice.linkedSalesDispatchId = doc._id;
      invoice.linkedSalesDispatchNo = doc.dispatchNo;
      invoice.updatedBy = req.user?.email || "";
      await invoice.save({ session });
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
      if (!POSTED_DISPATCH_STATUSES.includes(doc.status)) throw new Error("Cannot cancel");

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
      StorePacking.find(withCompany(req, { allocationId: { $in: allocIds }, status: { $in: POSTED_PACKING_STATUSES } }))
        .select("packingNo allocationId lines")
        .lean(),
      StoreDispatch.find(withCompany(req, { allocationId: { $in: allocIds }, status: { $in: POSTED_DISPATCH_STATUSES } }))
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
    const posted = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
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
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } }))
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

export async function reportPackedNotInvoiced(req, res) {
  try {
    const packings = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
    const items = [];
    for (const p of packings) {
      const invoicedByLine = await sumInvoicedQtyByPackingLine(req.companyId, p._id);
      let packedQty = 0;
      let invoicedQty = 0;
      for (const ln of p.lines || []) {
        packedQty += Number(ln.packQty) || 0;
        invoicedQty += invoicedByLine.get(String(ln._id)) || 0;
      }
      const pendingInvoiceQty = Math.max(0, packedQty - invoicedQty);
      if (pendingInvoiceQty <= 0) continue;
      items.push({
        packingNo: p.packingNo,
        customerName: p.customerName,
        allocationNo: p.allocationNo,
        oaNo: p.linkedOANo || "",
        piNo: p.linkedProformaNo || "",
        packedQty,
        invoicedQty,
        pendingInvoiceQty,
        invoiceStatus: p.invoiceStatus || "NOT_INVOICED",
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportInvoicedNotDispatched(req, res) {
  try {
    const invoices = await SalesInvoice.find(
      withCompany(req, { linkedStorePackingId: { $ne: null }, status: { $nin: ["DRAFT", "CANCELLED"] } })
    )
      .sort({ invoiceDate: -1 })
      .lean();
    const items = [];
    for (const inv of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, inv._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of inv.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      items.push({
        invoiceNo: inv.invoiceNo,
        packingNo: inv.linkedStorePackingNo || "",
        customerName: inv.customerName,
        allocationNo: inv.linkedOrderAllocationNo || "",
        oaNo: inv.linkedOANo || "",
        piNo: inv.linkedProformaNo || "",
        invoiceQty,
        dispatchedQty,
        pendingDispatchQty,
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportCustomerInvoicePendingDispatch(req, res) {
  try {
    const byCustomer = new Map();
    const invoices = await SalesInvoice.find(
      withCompany(req, { linkedStorePackingId: { $ne: null }, status: { $nin: ["DRAFT", "CANCELLED"] } })
    ).lean();
    for (const inv of invoices) {
      const dispatchedByLine = await sumPostedDispatchQtyByInvoiceLine(req.companyId, inv._id);
      let invoiceQty = 0;
      let dispatchedQty = 0;
      for (const ln of inv.lines || []) {
        invoiceQty += Number(ln.qty) || 0;
        dispatchedQty += dispatchedByLine.get(String(ln._id)) || 0;
      }
      const pendingDispatchQty = Math.max(0, invoiceQty - dispatchedQty);
      if (pendingDispatchQty <= 0) continue;
      const key = inv.customerName || "Unknown";
      const item = byCustomer.get(key) || { customerName: key, invoiceCount: 0, pendingDispatchQty: 0 };
      item.invoiceCount += 1;
      item.pendingDispatchQty += pendingDispatchQty;
      byCustomer.set(key, item);
    }
    res.json({ items: Array.from(byCustomer.values()).sort((a, b) => b.pendingDispatchQty - a.pendingDispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingPacking(req, res) {
  try {
    req.query = { ...(req.query || {}) };
    return listPendingPackingAllocations(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchByCustomer(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byCustomer = new Map();
    for (const d of rows) {
      const key = d.customerName || "Unknown";
      const row = byCustomer.get(key) || { customerName: key, dispatchCount: 0, dispatchQty: 0 };
      row.dispatchCount += 1;
      for (const ln of d.lines || []) row.dispatchQty += Number(ln.dispatchQty) || 0;
      byCustomer.set(key, row);
    }
    res.json({ items: Array.from(byCustomer.values()).sort((a, b) => b.dispatchQty - a.dispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDispatchByArticle(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byArticle = new Map();
    for (const d of rows) {
      for (const ln of d.lines || []) {
        const key = ln.article || "UNKNOWN";
        const row = byArticle.get(key) || { article: key, description: ln.description || "", dispatchQty: 0, dispatchCount: 0 };
        row.dispatchQty += Number(ln.dispatchQty) || 0;
        row.dispatchCount += 1;
        byArticle.set(key, row);
      }
    }
    res.json({ items: Array.from(byArticle.values()).sort((a, b) => b.dispatchQty - a.dispatchQty) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPackingEfficiency(req, res) {
  try {
    const allocations = await OrderAllocation.find(withCompany(req, { status: { $nin: ["CANCELLED"] } })).lean();
    let allocatedQty = 0;
    let packedQty = 0;
    for (const a of allocations) {
      for (const ln of a.lines || []) allocatedQty += Number(ln.qty) || 0;
    }
    const packings = await StorePacking.find(withCompany(req, { status: { $in: POSTED_PACKING_STATUSES } })).lean();
    for (const p of packings) {
      for (const ln of p.lines || []) packedQty += Number(ln.packQty) || 0;
    }
    const efficiencyPct = allocatedQty > 0 ? (packedQty / allocatedQty) * 100 : 0;
    res.json({ allocatedQty, packedQty, pendingQty: Math.max(0, allocatedQty - packedQty), efficiencyPct });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportDailyDispatch(req, res) {
  try {
    const rows = await StoreDispatch.find(withCompany(req, { status: { $in: POSTED_DISPATCH_STATUSES } })).lean();
    const byDate = new Map();
    for (const d of rows) {
      const key = new Date(d.dispatchDate || d.createdAt || Date.now()).toISOString().slice(0, 10);
      const row = byDate.get(key) || { dispatchDate: key, dispatchCount: 0, dispatchQty: 0 };
      row.dispatchCount += 1;
      for (const ln of d.lines || []) row.dispatchQty += Number(ln.dispatchQty) || 0;
      byDate.set(key, row);
    }
    res.json({ items: Array.from(byDate.values()).sort((a, b) => String(b.dispatchDate).localeCompare(String(a.dispatchDate))) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
