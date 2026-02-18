import express from "express";
import SalesDoc from "../models/SalesDoc.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Shipment from "../models/Shipment.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireRole("admin", "staff", "accounts_logistics"));

/**
 * GET /api/accounts/summary
 * Linked view: revenue (sales), cost (POs), logistics, receivables, payables, profit
 */
router.get("/summary", async (req, res) => {
  try {
    const [salesAgg, purchaseAgg, logisticsAgg, receivablesAgg, payablesAgg] = await Promise.all([
      SalesDoc.aggregate([
        { $match: {} },
        { $group: { _id: null, total: { $sum: "$grandTotal" }, paid: { $sum: "$paidAmount" } } },
      ]),
      PurchaseOrder.aggregate([
        { $match: { status: { $ne: "DRAFT" } } },
        { $group: { _id: null, total: { $sum: "$grandTotal" }, paid: { $sum: "$paidAmount" } } },
      ]),
      Shipment.aggregate([
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $add: [
                  { $ifNull: ["$freightCost", 0] },
                  { $ifNull: ["$insuranceCost", 0] },
                  { $ifNull: ["$dutyCost", 0] },
                  { $ifNull: ["$otherCharges", 0] },
                ],
              },
            },
          },
        },
      ]),
      SalesDoc.aggregate([
        { $project: { outstanding: { $subtract: ["$grandTotal", { $ifNull: ["$paidAmount", 0] }] } } },
        { $match: { outstanding: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$outstanding" } } },
      ]),
      PurchaseOrder.aggregate([
        { $match: { status: { $ne: "DRAFT" } } },
        { $project: { outstanding: { $subtract: ["$grandTotal", { $ifNull: ["$paidAmount", 0] }] } } },
        { $match: { outstanding: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: "$outstanding" } } },
      ]),
    ]);

    const revenue = salesAgg[0]?.total ?? 0;
    const costOfGoods = purchaseAgg[0]?.total ?? 0;
    const logisticsExpense = logisticsAgg[0]?.total ?? 0;
    const receivables = receivablesAgg[0]?.total ?? 0;
    const payables = payablesAgg[0]?.total ?? 0;
    const salesPaid = salesAgg[0]?.paid ?? 0;
    const purchasePaid = purchaseAgg[0]?.paid ?? 0;
    const grossProfit = Number(revenue) - Number(costOfGoods);
    const totalProfit = Number(revenue) - Number(costOfGoods) - Number(logisticsExpense);

    res.json({
      revenue,
      costOfGoods,
      logisticsExpense,
      grossProfit,
      totalProfit,
      receivables,
      payables,
      salesPaid,
      purchasePaid,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * GET /api/accounts/transactions
 * Combined activity from Sales, Purchase, Logistics (linked)
 */
router.get("/transactions", async (req, res) => {
  try {
    const [salesDocs, pos, shipments] = await Promise.all([
      SalesDoc.find().sort({ createdAt: -1 }).limit(200).lean(),
      PurchaseOrder.find({ status: { $ne: "DRAFT" } }).sort({ createdAt: -1 }).limit(200).lean(),
      Shipment.find().sort({ createdAt: -1 }).limit(200).lean(),
    ]);

    const entries = [];

    salesDocs.forEach((d) => {
      const amount = Number(d.grandTotal) || 0;
      const paid = Number(d.paidAmount) || 0;
      entries.push({
        _id: d._id,
        type: "SALES",
        docType: d.type,
        ref: d.docNo,
        date: d.createdAt,
        customerName: d.customerName,
        amount,
        paid,
        outstanding: amount - paid,
        currency: "USD",
      });
    });

    pos.forEach((d) => {
      const amount = Number(d.grandTotal) || 0;
      const paid = Number(d.paidAmount) || 0;
      entries.push({
        _id: d._id,
        type: "PURCHASE",
        ref: d.poNo,
        date: d.createdAt,
        supplierName: d.supplierName,
        amount,
        paid,
        outstanding: amount - paid,
        currency: d.currency || "USD",
      });
    });

    shipments.forEach((d) => {
      const amount =
        (Number(d.freightCost) || 0) +
        (Number(d.insuranceCost) || 0) +
        (Number(d.dutyCost) || 0) +
        (Number(d.otherCharges) || 0);
      entries.push({
        _id: d._id,
        type: "LOGISTICS",
        ref: d.refNo,
        date: d.createdAt,
        customerName: d.customerName,
        supplierName: d.supplierName,
        docNo: d.docNo,
        amount,
        paid: 0,
        outstanding: amount,
        currency: d.currency || "USD",
      });
    });

    entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(entries.slice(0, 150));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/accounts/sales/:id/payment
 * Record payment against a sales doc (invoice). Body: { amount, date? }
 */
router.post("/sales/:id/payment", async (req, res) => {
  try {
    const doc = await SalesDoc.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Sales document not found" });
    const amount = Number(req.body?.amount) || 0;
    if (amount <= 0) return res.status(400).json({ message: "Amount must be positive" });
    const currentPaid = Number(doc.paidAmount) || 0;
    const newPaid = currentPaid + amount;
    const grandTotal = Number(doc.grandTotal) || 0;
    if (newPaid > grandTotal) {
      return res.status(400).json({ message: "Payment exceeds document total" });
    }
    doc.paidAmount = newPaid;
    if (req.body?.date) doc.paidDate = new Date(req.body.date);
    else if (!doc.paidDate && newPaid >= grandTotal) doc.paidDate = new Date();
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/**
 * POST /api/accounts/purchase/:id/payment
 * Record payment against a PO. Body: { amount, date? }
 */
router.post("/purchase/:id/payment", async (req, res) => {
  try {
    const doc = await PurchaseOrder.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase order not found" });
    const amount = Number(req.body?.amount) || 0;
    if (amount <= 0) return res.status(400).json({ message: "Amount must be positive" });
    const currentPaid = Number(doc.paidAmount) || 0;
    const newPaid = currentPaid + amount;
    const grandTotal = Number(doc.grandTotal) || 0;
    if (newPaid > grandTotal) {
      return res.status(400).json({ message: "Payment exceeds order total" });
    }
    doc.paidAmount = newPaid;
    if (req.body?.date) doc.paidDate = new Date(req.body.date);
    else if (!doc.paidDate && newPaid >= grandTotal) doc.paidDate = new Date();
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
