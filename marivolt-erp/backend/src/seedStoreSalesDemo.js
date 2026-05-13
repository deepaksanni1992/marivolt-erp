/**
 * Idempotent demo chain per company (MAR + OKE):
 * PO → posted GRN (stock in) → Order Allocation (reserved) → Store Packing (posted, partial)
 * → Store Dispatch (posted, partial).
 *
 * Run after companies exist: `npm run seed:store-sales-demo` (from backend/).
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "./models/Company.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import GRN from "./models/GRN.js";
import OrderAllocation from "./models/OrderAllocation.js";
import StorePacking from "./models/StorePacking.js";
import StoreDispatch from "./models/StoreDispatch.js";
import StockLocation from "./models/StockLocation.js";
import ItemMaster from "./models/itemMasterModel.js";
import * as stockService from "./services/stockService.js";
import { nextGrnNo } from "./services/grnNumberService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const DEMO_TAG = "ERP_DEMO_SEED_V1";
const ARTICLE = "ART-1001";

function applyReceiveToPoDoc(po, grnItems) {
  const receiveByLineId = new Map();
  for (const line of grnItems || []) {
    if (!line.poLineId) continue;
    const cur = receiveByLineId.get(String(line.poLineId)) || { accepted: 0, rejected: 0 };
    cur.accepted += Number(line.acceptedQty) || 0;
    cur.rejected += Number(line.rejectedQty) || 0;
    receiveByLineId.set(String(line.poLineId), cur);
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
}

async function seedOneCompany(company) {
  const companyId = company._id;
  const code = String(company.code || "").toUpperCase();
  const poNo = `${code}-ERP-DEMO-PO`;
  if (await PurchaseOrder.findOne({ companyId, poNo }).lean()) {
    console.log(`[${code}] Demo already present (PO ${poNo}), skipping.`);
    return;
  }

  await StockLocation.findOneAndUpdate(
    { companyId, locationCode: "MAIN" },
    { $setOnInsert: { companyId, locationCode: "MAIN", locationName: "Main warehouse", status: "Active" } },
    { upsert: true }
  );

  await ItemMaster.findOneAndUpdate(
    { companyId, article: ARTICLE },
    {
      $set: {
        companyId,
        article: ARTICLE,
        itemName: "Demo exhaust valve (seed)",
        description: "ERP store/sales workflow seed",
        uom: "PCS",
        status: "Active",
      },
    },
    { upsert: true }
  );

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const poLineId = new mongoose.Types.ObjectId();
      const [po] = await PurchaseOrder.create(
        [
          {
            companyId,
            branchId: null,
            poNo,
            poNumber: poNo,
            orderDate: new Date(),
            supplierName: "Demo Supplier (seed)",
            currency: "USD",
            status: "SAVED",
            remarks: DEMO_TAG,
            lines: [
              {
                _id: poLineId,
                article: ARTICLE,
                articleNo: ARTICLE,
                itemCode: ARTICLE,
                description: "Demo purchase line",
                orderedQty: 100,
                pendingQty: 100,
                qty: 100,
                uom: "PCS",
                unitPrice: 10,
                currency: "USD",
                receivedQty: 0,
                lineAmount: 1000,
                lineTotal: 1000,
              },
            ],
            subTotal: 1000,
            grandTotal: 1000,
            createdBy: "seed:store-sales-demo",
          },
        ],
        { session }
      );

      const grnNo = await nextGrnNo({ companyId, companyCode: code });
      const grnItems = [
        {
          article: ARTICLE,
          description: "Demo GRN line",
          spn: "SPN-1001",
          materialCode: "MAT-1001",
          orderedQty: 100,
          receivedQty: 80,
          pendingQty: 20,
          acceptedQty: 80,
          rejectedQty: 0,
          cancelledQty: 0,
          unitCost: 10,
          currency: "USD",
          warehouse: "MAIN",
          location: "MAIN",
          poId: po._id,
          poLineId,
          poNo,
        },
      ];

      await stockService.grnReceive({
        session,
        companyId,
        article: ARTICLE,
        warehouse: "MAIN",
        qty: 80,
        referenceType: "GRN",
        referenceNo: grnNo,
        supplierName: "Demo Supplier (seed)",
        remarks: DEMO_TAG,
        createdBy: "seed:store-sales-demo",
        sourceModule: "STORE",
        unitCost: 10,
        currency: "USD",
      });

      applyReceiveToPoDoc(po, grnItems);
      po.updatedBy = "seed:store-sales-demo";
      await po.save({ session });

      await GRN.create(
        [
          {
            companyId,
            branchId: null,
            grnNo,
            grnDate: new Date(),
            poId: po._id,
            poNo,
            supplierName: "Demo Supplier (seed)",
            supplierInvoiceNo: "SEED-INV-1",
            currency: "USD",
            status: "PARTIAL_RECEIVED",
            approvalStatus: "APPROVED",
            remarks: DEMO_TAG,
            items: grnItems,
            postedAt: new Date(),
            createdBy: "seed:store-sales-demo",
            updatedBy: "seed:store-sales-demo",
          },
        ],
        { session }
      );

      const allocLineId = new mongoose.Types.ObjectId();
      const allocationNo = `${code}-ERP-DEMO-ALLOC`;
      const [allocation] = await OrderAllocation.create(
        [
          {
            companyId,
            allocationNo,
            allocationDate: new Date(),
            linkedOANo: `${code}-DEMO-OA`,
            linkedProformaNo: `${code}-DEMO-PI`,
            customerName: "Demo Charterer (seed)",
            warehouse: "MAIN",
            currency: "USD",
            engine: "W32",
            model: "Inline",
            esn: "ESN-SEED-1",
            status: "OPEN",
            remarks: DEMO_TAG,
            lines: [
              {
                _id: allocLineId,
                serialNo: 1,
                article: ARTICLE,
                partNumber: "SPN-1001",
                description: "Exhaust valve",
                qty: 10,
                uom: "PCS",
                price: 100,
                totalPrice: 1000,
                materialCode: "MAT-1001",
              },
            ],
            subTotal: 1000,
            grandTotal: 1000,
            createdBy: "seed:store-sales-demo",
            updatedBy: "seed:store-sales-demo",
          },
        ],
        { session }
      );

      await stockService.allocateStock({
        session,
        companyId,
        article: ARTICLE,
        warehouse: "MAIN",
        qty: 10,
        customerName: allocation.customerName,
        referenceType: "ORDER_ALLOCATION",
        referenceNo: allocationNo,
        remarks: DEMO_TAG,
        createdBy: "seed:store-sales-demo",
        sourceModule: "SALES",
      });

      const packingNo = `${code}-ERP-DEMO-PACK`;
      const packQty = 6;
      await stockService.packFromAllocation({
        session,
        companyId,
        article: ARTICLE,
        warehouse: "MAIN",
        qty: packQty,
        customerName: allocation.customerName,
        referenceType: "STORE_PACKING",
        referenceNo: packingNo,
        remarks: DEMO_TAG,
        createdBy: "seed:store-sales-demo",
        sourceModule: "STORE",
        allocationId: allocation._id,
        transactionDate: new Date(),
      });

      const [packingDoc] = await StorePacking.create(
        [
          {
            companyId,
            branchId: null,
            packingNo,
            packingDate: new Date(),
            warehouse: "MAIN",
            allocationId: allocation._id,
            allocationNo,
            linkedOANo: allocation.linkedOANo,
            linkedProformaNo: allocation.linkedProformaNo,
            customerName: allocation.customerName,
            engine: allocation.engine,
            model: allocation.model,
            esn: allocation.esn,
            currency: "USD",
            remarks: DEMO_TAG,
            status: "POSTED",
            postedAt: new Date(),
            lines: [
              {
                allocationLineId: allocLineId,
                article: ARTICLE,
                description: "Exhaust valve",
                spn: "SPN-1001",
                materialCode: "MAT-1001",
                allocatedQty: 10,
                packQty,
                uom: "PCS",
                packageNo: "PKG-1",
                boxNo: "BOX-1",
              },
            ],
            createdBy: "seed:store-sales-demo",
            updatedBy: "seed:store-sales-demo",
          },
        ],
        { session }
      );

      const dispatchNo = `${code}-ERP-DEMO-DISP`;
      const dispatchQty = 4;
      await stockService.dispatchFromPacked({
        session,
        companyId,
        article: ARTICLE,
        warehouse: "MAIN",
        qty: dispatchQty,
        customerName: allocation.customerName,
        referenceType: "STORE_DISPATCH",
        referenceNo: dispatchNo,
        remarks: DEMO_TAG,
        createdBy: "seed:store-sales-demo",
        sourceModule: "STORE",
        transactionDate: new Date(),
      });

      const packingLineId = packingDoc.lines[0]._id;
      await StoreDispatch.create(
        [
          {
            companyId,
            branchId: null,
            dispatchNo,
            dispatchDate: new Date(),
            warehouse: "MAIN",
            packingId: packingDoc._id,
            packingNo,
            allocationId: allocation._id,
            allocationNo,
            linkedOANo: allocation.linkedOANo,
            linkedProformaNo: allocation.linkedProformaNo,
            customerName: allocation.customerName,
            engine: allocation.engine,
            model: allocation.model,
            esn: allocation.esn,
            courier: "Demo Courier",
            awbNo: "AWB-SEED-001",
            shipmentMode: "AIR",
            currency: "USD",
            remarks: DEMO_TAG,
            status: "POSTED",
            postedAt: new Date(),
            lines: [
              {
                packingLineId,
                article: ARTICLE,
                description: "Exhaust valve",
                spn: "SPN-1001",
                materialCode: "MAT-1001",
                packedQty: packQty,
                dispatchQty,
                uom: "PCS",
              },
            ],
            createdBy: "seed:store-sales-demo",
            updatedBy: "seed:store-sales-demo",
          },
        ],
        { session }
      );
    });
    console.log(`[${code}] Seeded PO / GRN / allocation / packing / dispatch demo.`);
  } finally {
    await session.endSession();
  }
}

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const companies = await Company.find({ code: { $in: ["MAR", "OKE"] } }).lean();
  if (companies.length < 2) {
    console.warn("Expected companies MAR and OKE — run npm run seed:companies first.");
  }
  for (const c of companies) {
    await seedOneCompany(c);
  }
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
