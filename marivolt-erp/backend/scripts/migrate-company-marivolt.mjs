import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import User from "../src/models/User.js";
import Item from "../src/models/Item.js";
import Supplier from "../src/models/Supplier.js";
import Customer from "../src/models/Customer.js";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import PurchaseReturn from "../src/models/PurchaseReturn.js";
import SalesInvoice from "../src/models/SalesInvoice.js";
import Quotation from "../src/models/Quotation.js";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import Shipment from "../src/models/Shipment.js";
import BOM from "../src/models/BOM.js";
import KittingOrder from "../src/models/KittingOrder.js";
import DeKittingOrder from "../src/models/DeKittingOrder.js";
import StockBalance from "../src/models/StockBalance.js";
import InventoryLedger from "../src/models/InventoryLedger.js";
import ItemMapping from "../src/models/itemMappingModel.js";
import ItemSupplierOffer from "../src/models/supplierModel.js";
import CashBankEntry from "../src/models/CashBankEntry.js";
import GRN from "../src/models/GRN.js";
import SupplierLedgerEntry from "../src/models/SupplierLedgerEntry.js";
import CustomerLedgerEntry from "../src/models/CustomerLedgerEntry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }
  await mongoose.connect(process.env.MONGO_URI);

  const mar = await Company.findOneAndUpdate(
    { code: "MAR" },
    {
      $setOnInsert: {
        name: "Marivolt",
        code: "MAR",
        logoUrl: "/marivolt-logo.png",
        address: "LV09B, Hamriyah freezone phase 2, Sharjah, UAE",
        email: "sales@marivolt.co",
        phone: "+971-543053047",
        currency: "USD",
        isActive: true,
      },
    },
    { new: true, upsert: true }
  );

  const models = [
    Item,
    Supplier,
    Customer,
    PurchaseOrder,
    PurchaseReturn,
    SalesInvoice,
    Quotation,
    PurchaseInvoice,
    Shipment,
    BOM,
    KittingOrder,
    DeKittingOrder,
    StockBalance,
    InventoryLedger,
    ItemMapping,
    ItemSupplierOffer,
    CashBankEntry,
    GRN,
    SupplierLedgerEntry,
    CustomerLedgerEntry,
  ];

  for (const Model of models) {
    const result = await Model.updateMany(
      { $or: [{ companyId: { $exists: false } }, { companyId: null }] },
      { $set: { companyId: mar._id } }
    );
    console.log(`${Model.modelName}: matched=${result.matchedCount} modified=${result.modifiedCount}`);
  }

  const users = await User.find({});
  for (const user of users) {
    if (!Array.isArray(user.allowedCompanies) || !user.allowedCompanies.length) {
      user.allowedCompanies = [mar._id];
    } else if (!user.allowedCompanies.some((x) => String(x) === String(mar._id))) {
      user.allowedCompanies = [...user.allowedCompanies, mar._id];
    }
    if (!user.defaultCompany) user.defaultCompany = mar._id;
    await user.save();
  }
  console.log(`Users updated: ${users.length}`);

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
