import express from "express";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import StockTxn from "../models/StockTxn.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireRole("admin", "staff", "purchase_sales"));

/* CREATE PO */
router.post("/po", async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.supplierName || !String(body.supplierName).trim()) {
      return res.status(400).json({ message: "Supplier name is required" });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    let intRef = body.intRef && String(body.intRef).trim();
    if (!intRef) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dateKey = `${yy}${mm}${dd}`;

      const lastForDate = await PurchaseOrder.findOne({
        intRef: new RegExp(`^${dateKey}\\.`, "i"),
      }).sort({ intRef: -1 });

      let nextSeq = 1;
      if (lastForDate?.intRef) {
        const parts = String(lastForDate.intRef).split(".");
        const seq = Number(parts[1]);
        if (!Number.isNaN(seq)) nextSeq = seq + 1;
      }
      intRef = `${dateKey}.${String(nextSeq).padStart(2, "0")}`;
    }
    const poNo = intRef;

    const po = await PurchaseOrder.create({
      ...body,
      items: (body.items || []).map((item) => ({
        ...item,
        receivedQty: Number(item.receivedQty) || 0,
      })),
      poNo,
      intRef,
      supplierName: String(body.supplierName).trim(),
    });
    res.json(po);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* GET ALL PO */
router.get("/po", async (req, res) => {
  const pos = await PurchaseOrder.find().sort({ createdAt: -1 });
  res.json(pos);
});

function getNextIntRef(baseIntRef) {
  const match = String(baseIntRef || "").match(/^(.*)R(\d+)$/);
  if (match) {
    const base = match[1];
    const next = Number(match[2]) + 1;
    return `${base}R${next}`;
  }
  return `${String(baseIntRef || "").trim()}R1`;
}

/* UPDATE PO (REVISION) */
router.put("/po/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    if (!body.supplierName || !String(body.supplierName).trim()) {
      return res.status(400).json({ message: "Supplier name is required" });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    const existing = await PurchaseOrder.findById(id);
    if (!existing) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const incomingItems = Array.isArray(body.items) ? body.items : [];
    const incomingByArticle = new Map(
      incomingItems.map((it) => [String(it.articleNo || "").trim(), it])
    );
    for (const item of existing.items || []) {
      const receivedQty = Number(item.receivedQty) || 0;
      if (receivedQty <= 0) continue;
      const key = String(item.articleNo || "").trim();
      const incoming = incomingByArticle.get(key);
      if (!incoming) {
        return res.status(400).json({
          message: `Cannot remove item ${key || "with received qty"} because GRN exists`,
        });
      }
      const nextQty = Number(incoming.qty) || 0;
      if (nextQty < receivedQty) {
        return res.status(400).json({
          message: `Item ${key || "with received qty"} cannot be less than received qty`,
        });
      }
    }

    let baseIntRef = existing.intRef;
    if (!baseIntRef) {
      baseIntRef = body.intRef && String(body.intRef).trim();
    }
    if (!baseIntRef) {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const dateKey = `${yy}${mm}${dd}`;

      const lastForDate = await PurchaseOrder.findOne({
        intRef: new RegExp(`^${dateKey}\\.`, "i"),
      }).sort({ intRef: -1 });

      let nextSeq = 1;
      if (lastForDate?.intRef) {
        const parts = String(lastForDate.intRef).split(".");
        const seq = Number(parts[1]);
        if (!Number.isNaN(seq)) nextSeq = seq + 1;
      }
      baseIntRef = `${dateKey}.${String(nextSeq).padStart(2, "0")}`;
    }

    const revisedIntRef = getNextIntRef(baseIntRef);
    const updated = await PurchaseOrder.findByIdAndUpdate(
      id,
      {
        ...body,
        items: incomingItems.map((item) => ({
          ...item,
          receivedQty: Number(item.receivedQty) || 0,
        })),
        intRef: revisedIntRef,
        poNo: revisedIntRef,
        supplierName: String(body.supplierName).trim(),
      },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* DELETE PO (DRAFT/SAVED ONLY) */
router.delete("/po/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const po = await PurchaseOrder.findById(id);
    if (!po) {
      return res.status(404).json({ message: "Purchase order not found" });
    }
    if (!["DRAFT", "SAVED"].includes(po.status)) {
      return res
        .status(400)
        .json({ message: "Only DRAFT or SAVED purchase orders can be deleted" });
    }
    await PurchaseOrder.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* CREATE GRN + AUTO STOCK IN */
router.post("/grn", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (!body.poNo && !body.poId) {
      return res.status(400).json({ message: "PO is required for GRN" });
    }
    if (!items.length) {
      return res.status(400).json({ message: "At least one GRN item is required" });
    }

    const po =
      (body.poId && (await PurchaseOrder.findById(body.poId))) ||
      (body.poNo && (await PurchaseOrder.findOne({ poNo: body.poNo })));
    if (!po) {
      return res.status(404).json({ message: "Purchase order not found" });
    }
    if (!["SAVED", "PARTIAL"].includes(po.status)) {
      return res
        .status(400)
        .json({ message: "Only SAVED/PARTIAL purchase orders can receive GRN" });
    }

    const poItemsByArticle = new Map(
      (po.items || []).map((it) => [String(it.articleNo || "").trim(), it])
    );

    const grnItems = items.map((it) => ({
      sku: String(it.sku || it.articleNo || "").trim(),
      name: String(it.name || it.description || "").trim(),
      qty: Number(it.qty) || 0,
      uom: String(it.uom || "").trim(),
      poNo: po.poNo,
    }));

    for (const grnItem of grnItems) {
      if (!grnItem.sku || grnItem.qty <= 0) {
        return res.status(400).json({ message: "Invalid GRN item data" });
      }
      const poItem = poItemsByArticle.get(grnItem.sku);
      if (!poItem) {
        return res
          .status(400)
          .json({ message: `Item ${grnItem.sku} not found in PO` });
      }
      const receivedQty = Number(poItem.receivedQty) || 0;
      const orderedQty = Number(poItem.qty) || 0;
      if (receivedQty + grnItem.qty > orderedQty) {
        return res.status(400).json({
          message: `GRN qty exceeds ordered qty for ${grnItem.sku}`,
        });
      }
    }

    const grn = await GRN.create({
      grnNo: body.grnNo || `GRN-${Date.now()}`,
      supplier: body.supplier || po.supplierName || "",
      poNo: po.poNo,
      items: grnItems,
      note: body.note || "",
      createdBy: body.createdBy || "",
    });

    // ✅ Create stock transactions
    const txns = [];
    for (const it of grn.items) {
      txns.push({
        sku: it.sku,
        type: "IN",
        qty: it.qty,
        ref: `GRN:${grn.grnNo}`,
        note: `PO:${grn.poNo}`,
      });
    }

    if (txns.length) {
      await StockTxn.insertMany(txns);
    }

    // Update PO received qty + status
    const updatedItems = (po.items || []).map((it) => {
      const match = grnItems.find((g) => g.sku === String(it.articleNo || "").trim());
      if (!match) return it;
      const nextReceived = (Number(it.receivedQty) || 0) + match.qty;
      return { ...it.toObject(), receivedQty: nextReceived };
    });
    const allReceived = updatedItems.every(
      (it) => (Number(it.receivedQty) || 0) >= (Number(it.qty) || 0)
    );
    await PurchaseOrder.updateOne(
      { _id: po._id },
      {
        items: updatedItems,
        status: allReceived ? "CLOSED" : "PARTIAL",
      }
    );

    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

/* GET ALL GRN */
router.get("/grn", async (req, res) => {
  const grns = await GRN.find().sort({ createdAt: -1 });
  res.json(grns);
});

export default router;
