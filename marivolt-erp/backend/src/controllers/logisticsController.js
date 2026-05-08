import mongoose from "mongoose";
import Shipment from "../models/Shipment.js";
import SalesDispatch from "../models/SalesDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import Rts from "../models/Rts.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizeTrackingStatus(v = "") {
  const s = String(v || "").trim().toLowerCase();
  if (["booked", "picked_up", "customs", "in_transit", "delivered"].includes(s)) return s;
  return "booked";
}

function dispatchQtyTotals(lines = []) {
  const totalQty = (lines || []).reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  const dispatchedQty = (lines || []).reduce((sum, l) => sum + (Number(l.dispatchedQty ?? l.qty) || 0), 0);
  return { totalQty, dispatchedQty, pendingQty: Math.max(0, totalQty - dispatchedQty) };
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
    const [pendingDispatch, inTransit, delayedShipments, delivered, backorders] = await Promise.all([
      Rts.countDocuments(withCompany(req, { status: { $in: ["APPROVED", "CONVERTED_TO_INVOICE"] } })),
      SalesDispatch.countDocuments(withCompany(req, { status: { $in: ["IN_TRANSIT"] } })),
      SalesDispatch.countDocuments(withCompany(req, { status: { $in: ["READY", "DISPATCHED", "IN_TRANSIT"] }, eta: { $lt: todayEnd } })),
      SalesDispatch.countDocuments(withCompany(req, { status: { $in: ["DELIVERED", "CLOSED"] } })),
      SalesInvoice.countDocuments(withCompany(req, { paymentStatus: { $ne: "PAID" }, balanceAmount: { $gt: 0 } })),
    ]);
    res.json({ pendingDispatch, inTransit, delayedShipments, delivered, backorders });
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
    const body = { ...req.body };
    if (!body.shipmentRef) {
      body.shipmentRef = await nextSequentialNumber(
        Shipment,
        "shipmentRef",
        `${req.companyCode || "CMP"}-SH`,
        { companyId: req.companyId }
      );
    }
    body.trackingStatus = normalizeTrackingStatus(body.trackingStatus || body.status);
    body.packages = normalizePackages(body.packages);
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
    const payload = { ...req.body };
    delete payload._id;
    delete payload.shipmentRef;
    if (payload.trackingStatus || payload.status) payload.trackingStatus = normalizeTrackingStatus(payload.trackingStatus || payload.status);
    if (payload.packages) payload.packages = normalizePackages(payload.packages);
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

export async function deleteShipment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Shipment.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
