import express from "express";
import PurchaseOrder from "../models/PurchaseOrder.js";
import SalesDoc from "../models/SalesDoc.js";
import Shipment from "../models/Shipment.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * GET /api/dashboard/stats
 * Returns: purchaseExpense, salesOrderValue, logisticsExpense, totalProfit, byMonth (last 6 months)
 */
router.get("/stats", async (req, res) => {
  try {
    // Purchase expense: sum grandTotal for non-DRAFT POs
    const purchaseResult = await PurchaseOrder.aggregate([
      { $match: { status: { $ne: "DRAFT" } } },
      { $group: { _id: null, total: { $sum: "$grandTotal" } } },
    ]);
    const purchaseExpense = purchaseResult[0]?.total ?? 0;

    // Sales order value: sum grandTotal for INVOICE documents only
    const salesResult = await SalesDoc.aggregate([
      { $match: { type: "INVOICE" } },
      { $group: { _id: null, total: { $sum: "$grandTotal" } } },
    ]);
    const salesOrderValue = salesResult[0]?.total ?? 0;

    // Logistics expense: sum of all shipment costs (freight + insurance + duty + other)
    const logisticsResult = await Shipment.aggregate([
      {
        $project: {
          total: {
            $add: [
              { $ifNull: ["$freightCost", 0] },
              { $ifNull: ["$insuranceCost", 0] },
              { $ifNull: ["$dutyCost", 0] },
              { $ifNull: ["$otherCharges", 0] },
            ],
          },
        },
      },
      { $group: { _id: null, total: { $sum: "$total" } } },
    ]);
    const logisticsExpense = logisticsResult[0]?.total ?? 0;

    const totalProfit = Number(salesOrderValue) - Number(purchaseExpense) - Number(logisticsExpense);

    // Last 6 months: get start of month for 6 months ago
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const purchaseByMonth = await PurchaseOrder.aggregate([
      { $match: { status: { $ne: "DRAFT" }, createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          total: { $sum: "$grandTotal" },
        },
      },
    ]);

    const salesByMonth = await SalesDoc.aggregate([
      { $match: { type: "INVOICE", createdAt: { $gte: sixMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
          },
          total: { $sum: "$grandTotal" },
        },
      },
    ]);

    const logisticsByMonth = await Shipment.aggregate([
      { $match: { createdAt: { $gte: sixMonthsAgo } } },
      {
        $project: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          total: {
            $add: [
              { $ifNull: ["$freightCost", 0] },
              { $ifNull: ["$insuranceCost", 0] },
              { $ifNull: ["$dutyCost", 0] },
              { $ifNull: ["$otherCharges", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: { year: "$year", month: "$month" },
          total: { $sum: "$total" },
        },
      },
    ]);

    const purchaseMap = new Map(
      purchaseByMonth.map((r) => [`${r._id.year}-${r._id.month}`, r.total])
    );
    const salesMap = new Map(
      salesByMonth.map((r) => [`${r._id.year}-${r._id.month}`, r.total])
    );
    const logisticsMap = new Map(
      logisticsByMonth.map((r) => [`${r._id.year}-${r._id.month}`, r.total])
    );

    const byMonth = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const key = `${year}-${month}`;
      const purchase = purchaseMap.get(key) ?? 0;
      const sales = salesMap.get(key) ?? 0;
      const logistics = logisticsMap.get(key) ?? 0;
      byMonth.push({
        year,
        month,
        monthLabel: `${MONTH_NAMES[d.getMonth()]} ${year}`,
        purchase,
        sales,
        logistics,
        profit: sales - purchase - logistics,
      });
    }

    res.json({
      purchaseExpense,
      salesOrderValue,
      logisticsExpense,
      totalProfit,
      byMonth,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to load dashboard stats" });
  }
});

export default router;
