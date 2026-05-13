import mongoose from "mongoose";
import Shipment from "../models/Shipment.js";
import ShipmentContainer from "../models/ShipmentContainer.js";
import SalesDispatch from "../models/SalesDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import StoreDispatch from "../models/StoreDispatch.js";
import Rts from "../models/Rts.js";
import OrderAllocation from "../models/OrderAllocation.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { writeAudit } from "../services/auditService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

async function resolveWarehouseScopedLogisticsIds(req, warehouseRaw) {
  const warehouse = String(warehouseRaw || "").trim().toUpperCase();
  if (!warehouse) return null;

  const oaRows = await OrderAllocation.find(withCompany(req, { warehouse }))
    .select("_id")
    .lean();
  const oaIds = oaRows.map((r) => r._id);
  if (!oaIds.length) {
    return { hasFilter: true, invoiceIds: [], rtsIds: [], dispatchIds: [] };
  }

  const [invoices, rtsRows] = await Promise.all([
    SalesInvoice.find(withCompany(req, { linkedOrderAllocationId: { $in: oaIds } }))
      .select("_id")
      .lean(),
    Rts.find(withCompany(req, { linkedOrderAllocationId: { $in: oaIds } }))
      .select("_id")
      .lean(),
  ]);

  const invoiceIds = invoices.map((r) => r._id);
  const rtsIds = rtsRows.map((r) => r._id);
  const dispatchRows = invoiceIds.length
    ? await SalesDispatch.find(withCompany(req, { linkedSalesInvoiceId: { $in: invoiceIds } }))
        .select("_id")
        .lean()
    : [];
  const dispatchIds = dispatchRows.map((r) => r._id);
  return { hasFilter: true, invoiceIds, rtsIds, dispatchIds };
}

function normalizeTrackingStatus(v = "") {
  const s = String(v || "").trim().toLowerCase();
  if (["booked", "picked_up", "customs", "in_transit", "delivered"].includes(s)) return s;
  return "booked";
}

function normalizeShipmentStatus(v = "") {
  const s = String(v || "").trim().toUpperCase();
  if (["PLANNED", "READY", "BOOKED", "PICKED_UP", "CUSTOMS_CLEARANCE", "IN_TRANSIT", "ARRIVED", "DELIVERED", "CLOSED", "CANCELLED"].includes(s)) return s;
  const tracking = normalizeTrackingStatus(v);
  if (tracking === "booked") return "BOOKED";
  if (tracking === "picked_up") return "PICKED_UP";
  if (tracking === "customs") return "CUSTOMS_CLEARANCE";
  if (tracking === "in_transit") return "IN_TRANSIT";
  if (tracking === "delivered") return "DELIVERED";
  return "READY";
}

function recalcDelay(payload = {}) {
  const planned = payload.plannedEta || payload.eta || null;
  const actual = payload.actualEta || payload.deliveredAt || null;
  if (!planned) return 0;
  const plannedDate = new Date(planned);
  const compareDate = actual ? new Date(actual) : new Date();
  if (Number.isNaN(plannedDate.getTime()) || Number.isNaN(compareDate.getTime())) return 0;
  const days = Math.floor((compareDate.getTime() - plannedDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

function normalizeExportDocuments(docs = []) {
  const allowed = new Set(["COO", "WEIGHT_LIST", "CONTAINER_LOAD_PLAN", "EXPORT_CHECKLIST", "COMMERCIAL_INVOICE", "PACKING_LIST"]);
  const statuses = new Set(["PENDING", "GENERATED", "UPLOADED"]);
  return Array.isArray(docs)
    ? docs
        .map((d) => {
          const documentType = String(d?.documentType || "").trim().toUpperCase();
          if (!allowed.has(documentType)) return null;
          const status = String(d?.status || "PENDING").trim().toUpperCase();
          return {
            documentType,
            status: statuses.has(status) ? status : "PENDING",
            documentId: mongoose.Types.ObjectId.isValid(String(d?.documentId || "")) ? new mongoose.Types.ObjectId(String(d.documentId)) : null,
            documentNo: String(d?.documentNo || "").trim(),
            fileUrl: String(d?.fileUrl || "").trim(),
            uploadedAt: d?.uploadedAt ? new Date(d.uploadedAt) : null,
            generatedAt: d?.generatedAt ? new Date(d.generatedAt) : null,
            remarks: String(d?.remarks || "").trim(),
          };
        })
        .filter(Boolean)
    : [];
}

function normalizeExpenses(expenses = [], createdBy = "") {
  const allowed = new Set(["freight", "customs", "trucking", "handling", "courier", "insurance"]);
  return Array.isArray(expenses)
    ? expenses
        .map((e) => {
          const expenseType = String(e?.expenseType || "").trim().toLowerCase();
          if (!allowed.has(expenseType)) return null;
          return {
            expenseType,
            amount: Math.max(0, Number(e?.amount) || 0),
            currency: String(e?.currency || "USD").trim().toUpperCase(),
            vendorName: String(e?.vendorName || "").trim(),
            invoiceNo: String(e?.invoiceNo || "").trim(),
            remarks: String(e?.remarks || "").trim(),
            createdBy,
          };
        })
        .filter(Boolean)
    : [];
}

function hydrateShipmentCommercialFields(body = {}, userEmail = "") {
  const payload = { ...body };
  if (payload.status) payload.status = normalizeShipmentStatus(payload.status);
  if (payload.trackingStatus || payload.status) payload.trackingStatus = normalizeTrackingStatus(payload.trackingStatus || payload.status);
  if (payload.packages) payload.packages = normalizePackages(payload.packages);
  if (payload.exportDocuments) payload.exportDocuments = normalizeExportDocuments(payload.exportDocuments);
  if (payload.expenses) payload.expenses = normalizeExpenses(payload.expenses, userEmail);
  if (!payload.plannedEta && payload.eta) payload.plannedEta = payload.eta;
  payload.delayedDays = recalcDelay(payload);
  return payload;
}

function normalizePackages(packages = []) {
  return Array.isArray(packages)
    ? packages
        .map((p, idx) => ({
          packageNo: String(p?.packageNo || idx + 1).trim(),
          packageType: String(p?.packageType || "").trim(),
          weightKg: Math.max(0, Number(p?.weightKg) || 0),
          dimensions: String(p?.dimensions || "").trim(),
          marksAndNumbers: String(p?.marksAndNumbers || p?.remarks || "").trim(),
          remarks: String(p?.remarks || "").trim(),
        }))
        .filter((p) => p.packageNo || p.packageType || p.weightKg || p.dimensions)
    : [];
}

async function enrichDispatchLinks(dispatch) {
  if (!dispatch) return dispatch;
  const [invoice, rts] = await Promise.all([
    dispatch.linkedSalesInvoiceId ? SalesInvoice.findOne({ companyId: dispatch.companyId, _id: dispatch.linkedSalesInvoiceId }).lean() : null,
    dispatch.linkedRtsId ? Rts.findOne({ companyId: dispatch.companyId, _id: dispatch.linkedRtsId }).lean() : null,
  ]);
  return { ...dispatch, linkedInvoice: invoice || null, linkedRts: rts || null };
}

export async function getLogisticsDashboard(req, res) {
  try {
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const scoped = await resolveWarehouseScopedLogisticsIds(req, req.query.warehouse);

    const shipmentBaseFilter = withCompany(req);
    if (scoped?.hasFilter) {
      shipmentBaseFilter.linkedDispatchId = { $in: scoped.dispatchIds };
    }

    const rtsFilter = scoped?.hasFilter
      ? withCompany(req, {
          _id: { $in: scoped.rtsIds },
          status: { $in: ["APPROVED", "CONVERTED_TO_INVOICE"] },
        })
      : withCompany(req, { status: { $in: ["APPROVED", "CONVERTED_TO_INVOICE"] } });

    const backordersFilter = scoped?.hasFilter
      ? withCompany(req, {
          _id: { $in: scoped.invoiceIds },
          paymentStatus: { $ne: "PAID" },
          balanceAmount: { $gt: 0 },
        })
      : withCompany(req, { paymentStatus: { $ne: "PAID" }, balanceAmount: { $gt: 0 } });

    const [pendingDispatch, inTransit, delayedShipments, delivered, backorders, ready, booked, customs] = await Promise.all([
      Rts.countDocuments(rtsFilter),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: { $in: ["IN_TRANSIT"] } }),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: { $nin: ["DELIVERED", "CLOSED", "CANCELLED"] }, plannedEta: { $lt: todayEnd } }),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: { $in: ["DELIVERED", "CLOSED"] } }),
      SalesInvoice.countDocuments(backordersFilter),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: "READY" }),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: "BOOKED" }),
      Shipment.countDocuments({ ...shipmentBaseFilter, status: "CUSTOMS_CLEARANCE" }),
    ]);
    res.json({
      pendingDispatch,
      inTransit,
      delayedShipments,
      delivered,
      backorders,
      ready,
      booked,
      customs,
      warehouse: String(req.query.warehouse || "").trim().toUpperCase(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listDispatches(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.dispatchNo) filter.dispatchNo = new RegExp(String(req.query.dispatchNo).trim(), "i");
    if (req.query.delayedOnly === "1") {
      filter.status = { $in: ["READY", "DISPATCHED", "IN_TRANSIT"] };
      filter.eta = { $lt: new Date() };
    }
    const [items, total] = await Promise.all([
      SalesDispatch.find(filter).sort({ dispatchDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesDispatch.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPackingList(req, res) {
  try {
    const { dispatchId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(dispatchId)) return res.status(400).json({ message: "Invalid dispatchId" });
    const dispatch = await SalesDispatch.findOne(withCompany(req, { _id: dispatchId })).lean();
    if (!dispatch) return res.status(404).json({ message: "Dispatch not found" });
    const enriched = await enrichDispatchLinks(dispatch);
    const packages = normalizePackages(dispatch.packages || []);
    res.json({
      dispatch: enriched,
      packingList: {
        packingListNo: dispatch.packingListNo || `${dispatch.dispatchNo}-PL`,
        customerName: dispatch.customerName || "",
        invoiceNo: dispatch.linkedSalesInvoiceNo || "",
        rtsNo: dispatch.linkedRtsNo || enriched.linkedRts?.rtsNo || "",
        packageCount: packages.length || (dispatch.lines || []).reduce((sum, l) => sum + (Number(l.packageCount) || 0), 0),
        packages,
        lines: (dispatch.lines || []).map((l) => ({
          article: l.article || "",
          description: l.description || "",
          qty: Number(l.qty) || 0,
          uom: l.uom || "PCS",
          weight: Number(l.weightKg || l.totalWeightKg || 0),
          dimensions: l.dimensions || "",
          packageCount: Number(l.packageCount) || 0,
          marksAndNumbers: l.marksAndNumbers || "",
          countryOfOrigin: l.countryOfOrigin || l.coo || "",
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listShipments(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.direction) filter.direction = req.query.direction;
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.awbNo) filter.awbNo = new RegExp(String(req.query.awbNo).trim(), "i");
    if (req.query.blNo) filter.blNo = new RegExp(String(req.query.blNo).trim(), "i");
    if (req.query.delayedOnly === "1") {
      filter.status = { $nin: ["DELIVERED", "CLOSED", "CANCELLED"] };
      filter.plannedEta = { $lt: new Date() };
    }
    if (req.query.shipmentRef) {
      filter.shipmentRef = new RegExp(String(req.query.shipmentRef).trim(), "i");
    }
    const [items, total] = await Promise.all([
      Shipment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Shipment.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getShipment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Shipment.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createShipment(req, res) {
  try {
    const body = hydrateShipmentCommercialFields(req.body || {}, req.user?.email || "");
    if (!body.shipmentRef) {
      body.shipmentRef = await nextSequentialNumber(
        Shipment,
        "shipmentRef",
        `${req.companyCode || "CMP"}-SH`,
        { companyId: req.companyId }
      );
    }
    const doc = await Shipment.create({ ...body, companyId: req.companyId });
    if (doc.linkedDispatchId) {
      await SalesDispatch.findOneAndUpdate(
        withCompany(req, { _id: doc.linkedDispatchId }),
        {
          status: doc.status === "DELIVERED" ? "DELIVERED" : doc.status === "IN_TRANSIT" ? "IN_TRANSIT" : "DISPATCHED",
          awbNo: doc.awbNo || doc.blAwbNo || "",
          blNo: doc.blNo || doc.blAwbNo || "",
          courier: doc.courier || "",
          shippingLine: doc.shippingLine || "",
          vessel: doc.vessel || doc.vesselOrFlight || "",
          voyage: doc.voyage || doc.voyageOrFlightNo || "",
          containerNo: doc.containerNo || "",
          etd: doc.etd || null,
          eta: doc.eta || null,
          trackingUrl: doc.trackingUrl || "",
          trackingStatus: doc.trackingStatus || "booked",
          packages: doc.packages || [],
          updatedBy: req.user?.email || "",
        }
      );
    }
    await writeAudit(req, {
      action: "CREATE",
      module: "LOGISTICS",
      entityType: "SHIPMENT",
      entityId: doc._id,
      documentNo: doc.shipmentRef,
      toStatus: doc.status,
      description: `Shipment ${doc.shipmentRef} created`,
      metadata: { linkedDispatchNo: doc.linkedDispatchNo || "", trackingStatus: doc.trackingStatus || "" },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateShipment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const existing = await Shipment.findOne(withCompany(req, { _id: id }));
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (["DELIVERED", "CLOSED"].includes(String(existing.status || "").toUpperCase())) {
      const nextStatus = req.body?.status ? normalizeShipmentStatus(req.body.status) : "";
      const allowedClose = String(existing.status || "").toUpperCase() === "DELIVERED" && nextStatus === "CLOSED";
      if (!allowedClose) {
        return res.status(409).json({
          message: "Delivered/closed shipments cannot be edited. Use controlled cancellation or close flow.",
          code: "SHIPMENT_LOCKED",
        });
      }
    }
    const payload = hydrateShipmentCommercialFields(req.body || {}, req.user?.email || "");
    delete payload._id;
    delete payload.shipmentRef;
    if (payload.status === "CLOSED") {
      if (String(existing.status || "").toUpperCase() === "CLOSED") {
        return res.status(409).json({ message: "Shipment is already closed.", code: "DUPLICATE_SHIPMENT_CLOSE" });
      }
      if (String(existing.status || "").toUpperCase() !== "DELIVERED") {
        return res.status(409).json({ message: "Shipment must be delivered before closing.", code: "SHIPMENT_NOT_DELIVERED" });
      }
      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "LOGISTICS",
        actionKey: "dispatch_close",
        documentType: "SHIPMENT",
        documentId: existing._id,
        documentNo: existing.shipmentRef,
        customerName: existing.customerName || "",
        amount: Number(existing.freightCost || 0) + Number(existing.customsCost || 0) + Number(existing.truckingCost || 0) + Number(existing.handlingCost || 0) + Number(existing.courierCost || 0),
        currency: existing.currency || "USD",
        description: `Close shipment ${existing.shipmentRef}`,
      });
      if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    }
    const doc = await Shipment.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (doc.linkedDispatchId) {
      await SalesDispatch.findOneAndUpdate(
        withCompany(req, { _id: doc.linkedDispatchId }),
        {
          status: doc.status === "DELIVERED" ? "DELIVERED" : doc.status === "IN_TRANSIT" ? "IN_TRANSIT" : "DISPATCHED",
          awbNo: doc.awbNo || doc.blAwbNo || "",
          blNo: doc.blNo || doc.blAwbNo || "",
          courier: doc.courier || "",
          shippingLine: doc.shippingLine || "",
          vessel: doc.vessel || doc.vesselOrFlight || "",
          voyage: doc.voyage || doc.voyageOrFlightNo || "",
          containerNo: doc.containerNo || "",
          etd: doc.etd || null,
          eta: doc.eta || null,
          trackingUrl: doc.trackingUrl || "",
          trackingStatus: doc.trackingStatus || "booked",
          packages: doc.packages || [],
          updatedBy: req.user?.email || "",
        }
      );
    }
    await writeAudit(req, {
      action: "UPDATE",
      module: "LOGISTICS",
      entityType: "SHIPMENT",
      entityId: doc._id,
      documentNo: doc.shipmentRef,
      toStatus: doc.status,
      description: `Shipment ${doc.shipmentRef} updated`,
      metadata: { trackingStatus: doc.trackingStatus || "", eta: doc.eta || null },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function addTrackingUpdate(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const status = normalizeTrackingStatus(req.body?.status);
    const note = String(req.body?.note || "").trim();
    const doc = await Shipment.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    doc.trackingStatus = status;
    if (status === "in_transit") doc.status = "IN_TRANSIT";
    if (status === "delivered") {
      doc.status = "DELIVERED";
      doc.deliveredAt = new Date();
      doc.deliveredBy = req.user?.email || "";
    }
    doc.trackingUpdates.push({ status, note, updatedAt: new Date(), updatedBy: req.user?.email || "" });
    await doc.save();
    if (doc.linkedDispatchId) {
      await SalesDispatch.findOneAndUpdate(
        withCompany(req, { _id: doc.linkedDispatchId }),
        {
          status: doc.status === "DELIVERED" ? "DELIVERED" : doc.status === "IN_TRANSIT" ? "IN_TRANSIT" : "DISPATCHED",
          trackingStatus: status,
          deliveredAt: doc.deliveredAt || null,
          deliveredBy: doc.deliveredBy || "",
          updatedBy: req.user?.email || "",
          $push: { trackingUpdates: { status, note, updatedAt: new Date(), updatedBy: req.user?.email || "" } },
        }
      );
    }
    await writeAudit(req, {
      action: status === "delivered" ? "STATUS_CHANGE" : "UPDATE",
      module: "LOGISTICS",
      entityType: "SHIPMENT",
      entityId: doc._id,
      documentNo: doc.shipmentRef,
      toStatus: doc.status,
      description: `Shipment ${doc.shipmentRef} tracking updated to ${status}`,
      metadata: { note },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateShipmentDocuments(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Shipment.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (["DELIVERED", "CLOSED"].includes(String(doc.status || "").toUpperCase())) {
      return res.status(409).json({ message: "Delivered/closed shipments cannot be edited.", code: "SHIPMENT_LOCKED" });
    }
    doc.exportDocuments = normalizeExportDocuments(req.body?.exportDocuments || []);
    await doc.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "LOGISTICS",
      entityType: "SHIPMENT",
      entityId: doc._id,
      documentNo: doc.shipmentRef,
      description: `Export documents updated for ${doc.shipmentRef}`,
      metadata: { documentCount: doc.exportDocuments.length },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createContainer(req, res) {
  try {
    const body = { ...req.body };
    const doc = await ShipmentContainer.create({
      companyId: req.companyId,
      shipmentId: mongoose.Types.ObjectId.isValid(String(body.shipmentId || "")) ? new mongoose.Types.ObjectId(String(body.shipmentId)) : null,
      shipmentRef: String(body.shipmentRef || "").trim(),
      containerNo: String(body.containerNo || "").trim(),
      containerType: String(body.containerType || "").trim(),
      sealNo: String(body.sealNo || "").trim(),
      grossWeight: Math.max(0, Number(body.grossWeight) || 0),
      netWeight: Math.max(0, Number(body.netWeight) || 0),
      cbm: Math.max(0, Number(body.cbm) || 0),
      packageCount: Math.max(0, Number(body.packageCount) || 0),
      invoices: Array.isArray(body.invoices) ? body.invoices : [],
      remarks: String(body.remarks || ""),
      createdBy: req.user?.email || "",
    });
    if (doc.shipmentId) {
      await Shipment.findOneAndUpdate(withCompany(req, { _id: doc.shipmentId }), { $addToSet: { containers: doc._id } });
    }
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listContainers(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.shipmentId && mongoose.Types.ObjectId.isValid(String(req.query.shipmentId))) {
      filter.shipmentId = new mongoose.Types.ObjectId(String(req.query.shipmentId));
    }
    if (req.query.containerNo) filter.containerNo = new RegExp(String(req.query.containerNo).trim(), "i");
    const items = await ShipmentContainer.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getCustomerTracking(req, res) {
  try {
    const ref = String(req.params.ref || req.query.ref || "").trim();
    if (!ref) return res.status(400).json({ message: "Shipment ref, AWB, or BL is required." });
    const row = await Shipment.findOne(
      withCompany(req, {
        $or: [{ shipmentRef: ref }, { awbNo: ref }, { blNo: ref }, { blAwbNo: ref }],
      })
    )
      .select("shipmentRef status trackingStatus awbNo blNo blAwbNo eta plannedEta actualEta delayedDays trackingUrl linkedDispatchNo linkedSalesInvoiceNumber exportDocuments trackingUpdates customerName")
      .lean();
    if (!row) return res.status(404).json({ message: "Shipment not found" });
    res.json({
      shipmentRef: row.shipmentRef,
      status: row.status,
      trackingStatus: row.trackingStatus,
      awbNo: row.awbNo || row.blAwbNo || "",
      blNo: row.blNo || row.blAwbNo || "",
      eta: row.eta || row.plannedEta || null,
      actualEta: row.actualEta || null,
      delayedDays: row.delayedDays || 0,
      trackingUrl: row.trackingUrl || "",
      dispatchNo: row.linkedDispatchNo || "",
      invoiceNo: row.linkedSalesInvoiceNumber || "",
      documents: (row.exportDocuments || []).map((d) => ({ documentType: d.documentType, status: d.status })),
      trackingUpdates: row.trackingUpdates || [],
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getShipmentSummaryReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    const items = await Shipment.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDeliveryDelayReport(req, res) {
  try {
    const items = await Shipment.find(
      withCompany(req, {
        $or: [{ delayedDays: { $gt: 0 } }, { status: { $nin: ["DELIVERED", "CLOSED", "CANCELLED"] }, plannedEta: { $lt: new Date() } }],
      })
    )
      .sort({ plannedEta: 1, eta: 1 })
      .lean();
    res.json({ items: items.map((x) => ({ ...x, delayedDays: x.delayedDays || recalcDelay(x) })) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getContainerUtilizationReport(req, res) {
  try {
    const items = await ShipmentContainer.find(withCompany(req, { status: { $ne: "CANCELLED" } })).sort({ createdAt: -1 }).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPendingDispatchReport(req, res) {
  try {
    const items = await SalesDispatch.find(withCompany(req, { status: { $in: ["DRAFT", "READY", "DISPATCHED"] } }))
      .sort({ dispatchDate: -1, createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPhysicalDispatchStatusReport(req, res) {
  try {
    const status = String(req.query.status || "").trim().toUpperCase();
    const filter = withCompany(req, {});
    if (status === "PARTIALLY_DISPATCHED" || status === "FULLY_DISPATCHED") filter.status = status;
    else if (status === "PENDING") filter.status = "DRAFT";
    else filter.status = { $in: ["DRAFT", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED", "POSTED"] };
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    const rows = await StoreDispatch.find(filter).sort({ dispatchDate: -1, createdAt: -1 }).limit(500).lean();
    const items = rows.map((d) => ({
      dispatchNo: d.dispatchNo,
      invoiceNo: d.salesInvoiceNo || "",
      customerName: d.customerName || "",
      packingNo: d.packingNo || "",
      allocationNo: d.allocationNo || "",
      dispatchDate: d.dispatchDate,
      transporter: d.transporter || d.courier || "",
      awbNo: d.awbNo || "",
      trackingNo: d.trackingNo || d.awbNo || "",
      blNo: d.blNo || "",
      status: d.status,
      dispatchQty: (d.lines || []).reduce((sum, line) => sum + (Number(line.dispatchQty) || 0), 0),
    }));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getAwbTrackingReport(req, res) {
  try {
    const rows = await StoreDispatch.find(
      withCompany(req, {
        status: { $in: ["PARTIALLY_DISPATCHED", "FULLY_DISPATCHED", "POSTED"] },
        $or: [{ awbNo: { $ne: "" } }, { trackingNo: { $ne: "" } }],
      })
    )
      .sort({ dispatchDate: -1, createdAt: -1 })
      .limit(500)
      .lean();
    const items = rows.map((d) => ({
      dispatchNo: d.dispatchNo,
      invoiceNo: d.salesInvoiceNo || "",
      customerName: d.customerName || "",
      awbNo: d.awbNo || "",
      trackingNo: d.trackingNo || d.awbNo || "",
      transporter: d.transporter || d.courier || "",
      dispatchDate: d.dispatchDate,
      documentLink: d.attachments?.find?.((attachment) => attachment?.documentId)?.documentId || "",
    }));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function deleteShipment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Shipment.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (["DELIVERED", "CLOSED"].includes(String(row.status || "").toUpperCase())) {
      return res.status(409).json({ message: "Delivered/closed shipments cannot be deleted. Use controlled cancellation.", code: "SHIPMENT_LOCKED" });
    }
    row.status = "CANCELLED";
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "CANCEL",
      module: "LOGISTICS",
      entityType: "SHIPMENT",
      entityId: row._id,
      documentNo: row.shipmentRef,
      toStatus: "CANCELLED",
      description: `Shipment ${row.shipmentRef} cancelled`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
