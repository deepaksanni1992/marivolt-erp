import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Vertical from "./models/Vertical.js";
import SPN from "./models/SPN.js";
import Material from "./models/Material.js";
import MaterialCompatibility from "./models/MaterialCompatibility.js";
import Article from "./models/Article.js";
import MaterialSupplier from "./models/MaterialSupplier.js";
import { ensureDefaultBrandsForEveryVertical } from "./utils/ensureDefaultBrands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

async function seed() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const vertical = await Vertical.findOneAndUpdate(
      { name: "Main engines" },
      {
        name: "Main engines",
        status: "Active",
      },
      { upsert: true, new: true }
    );

    const spn = await SPN.findOneAndUpdate(
      { spn: "SPN-1001" },
      {
        spn: "SPN-1001",
        vertical: vertical._id,
        partName: "Exhaust Valve",
        description: "Exhaust valve for Wärtsilä W32",
        genericDescription: "Exhaust valve for Wärtsilä W32",
        category: "Valve",
        subCategory: "Exhaust",
        uom: "pcs",
        status: "Active",
      },
      { upsert: true, new: true }
    );

    const material = await Material.findOneAndUpdate(
      { materialCode: "MAT-1001" },
      {
        materialCode: "MAT-1001",
        spn: spn.spn,
        vertical: vertical._id,
        shortDescription: "Exhaust valve, W32 inline/Vee",
        itemType: "OEM",
        unit: "pcs",
        status: "Active",
      },
      { upsert: true, new: true }
    );

    const compatSamples = [
      {
        materialCode: material.materialCode,
        brand: "Wärtsilä",
        engineModel: "W32",
        configuration: "Inline",
        cylinderCount: "6L",
        remarks: "Common for inline engines",
        status: "Active",
      },
      {
        materialCode: material.materialCode,
        brand: "Wärtsilä",
        engineModel: "W32",
        configuration: "Inline",
        cylinderCount: "7L",
        remarks: "Common for inline engines",
        status: "Active",
      },
      {
        materialCode: material.materialCode,
        brand: "Wärtsilä",
        engineModel: "W32",
        configuration: "Vee",
        cylinderCount: "12V",
        remarks: "Common for vee engines",
        status: "Active",
      },
    ];

    for (const row of compatSamples) {
      await MaterialCompatibility.findOneAndUpdate(
        {
          materialCode: row.materialCode,
          brand: row.brand,
          engineModel: row.engineModel,
          configuration: row.configuration,
          cylinderCount: row.cylinderCount,
          esnFrom: null,
          esnTo: null,
        },
        row,
        { upsert: true, new: true }
      );
    }

    await Article.findOneAndUpdate(
      { articleNo: "ART-1001" },
      {
        articleNo: "ART-1001",
        materialCode: material.materialCode,
        description: "Exhaust valve assembly, W32",
        drawingNo: "DWG-EXH-1001",
        maker: "Wärtsilä",
        brand: "OEM",
        unit: "pcs",
        weight: 2.5,
        hsnCode: "84099190",
        status: "Active",
      },
      { upsert: true, new: true }
    );

    await MaterialSupplier.findOneAndUpdate(
      { materialCode: material.materialCode, supplierName: "Default Supplier" },
      {
        materialCode: material.materialCode,
        supplierName: "Default Supplier",
        supplierArticleNo: "SUP-ART-1001",
        supplierDescription: "Exhaust valve OEM - W32",
        currency: "EUR",
        price: 500,
        leadTimeDays: 30,
        moq: 2,
        supplierCountry: "FI",
        preferred: true,
        status: "Active",
      },
      { upsert: true, new: true }
    );

    await ensureDefaultBrandsForEveryVertical();

    // eslint-disable-next-line no-console
    console.log("Item Master seed completed");
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Item Master seed failed:", err);
  process.exit(1);
});
