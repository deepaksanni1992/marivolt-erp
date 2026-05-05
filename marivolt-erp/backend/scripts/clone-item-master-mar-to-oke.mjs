import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import User from "../src/models/User.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import ItemTechnical from "../src/models/itemTechnicalModel.js";
import ItemSupplier from "../src/models/itemSupplierModel.js";

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

  const mar = await Company.findOne({ code: "MAR" }).lean();
  const oke = await Company.findOneAndUpdate(
    { code: "OKE" },
    {
      $setOnInsert: {
        name: "Okeanos",
        code: "OKE",
        logoUrl: "",
        address: "",
        email: "",
        phone: "",
        currency: "USD",
        isActive: true,
      },
    },
    { upsert: true, new: true }
  ).lean();

  if (!mar) {
    throw new Error("Source company MAR not found.");
  }
  if (!oke?._id) {
    throw new Error("Target company OKE not found/created.");
  }

  const [items, technicals, suppliers] = await Promise.all([
    ItemMaster.find({ companyId: mar._id }).lean(),
    ItemTechnical.find({ companyId: mar._id }).lean(),
    ItemSupplier.find({ companyId: mar._id }).lean(),
  ]);

  let itemsUpserted = 0;
  for (const row of items) {
    await ItemMaster.findOneAndUpdate(
      { companyId: oke._id, article: row.article },
      {
        companyId: oke._id,
        article: row.article,
        itemName: row.itemName || "",
        description: row.description || "",
        vertical: row.vertical || "",
        engine: row.engine || "",
        model: row.model || "",
        config: row.config || "",
        uom: row.uom || "PCS",
        status: row.status || "Active",
      },
      { upsert: true, new: true, runValidators: true }
    );
    itemsUpserted += 1;
  }

  let technicalsUpserted = 0;
  for (const row of technicals) {
    await ItemTechnical.findOneAndUpdate(
      { companyId: oke._id, article: row.article },
      {
        companyId: oke._id,
        article: row.article,
        spn: row.spn || "",
        esn: row.esn || "",
        materialCode: row.materialCode || "",
        drawingNumber: row.drawingNumber || "",
        dimension: row.dimension || "",
        oeMarkings: row.oeMarkings || "",
        extRemarks: row.extRemarks || "",
        internalRemarks: row.internalRemarks || "",
      },
      { upsert: true, new: true, runValidators: true }
    );
    technicalsUpserted += 1;
  }

  let suppliersUpserted = 0;
  for (const row of suppliers) {
    await ItemSupplier.findOneAndUpdate(
      {
        companyId: oke._id,
        article: row.article,
        supplierName: row.supplierName || "",
        supplierPartNumber: row.supplierPartNumber || "",
      },
      {
        companyId: oke._id,
        article: row.article,
        supplierName: row.supplierName || "",
        supplierPartNumber: row.supplierPartNumber || "",
        currency: row.currency || "USD",
        price: Number(row.price) || 0,
        leadTime: row.leadTime || "",
        remarks: row.remarks || "",
      },
      { upsert: true, new: true, runValidators: true }
    );
    suppliersUpserted += 1;
  }

  // Give existing users access to OKE as well.
  const users = await User.find({});
  for (const user of users) {
    const allowed = Array.isArray(user.allowedCompanies) ? user.allowedCompanies.map((x) => String(x)) : [];
    if (!allowed.includes(String(oke._id))) {
      user.allowedCompanies = [...(user.allowedCompanies || []), oke._id];
      await user.save();
    }
  }

  console.log(`MAR -> OKE ItemMaster copied. items=${itemsUpserted}, technicals=${technicalsUpserted}, suppliers=${suppliersUpserted}`);
  console.log("Stock balances/ledger/transactions were NOT copied (separate stock kept).");

  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

