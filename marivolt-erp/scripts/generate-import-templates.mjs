/**
 * Generates Excel (.xlsx) import templates for item-master bulk APIs.
 * Run from repo root: npm run generate:import-templates
 */
import XLSX from "xlsx";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "sample-templates");

mkdirSync(outDir, { recursive: true });

function instructionsSheet(lines) {
  const ws = XLSX.utils.aoa_to_sheet(lines.map((l) => [l]));
  ws["!cols"] = [{ wch: 110 }];
  return ws;
}

function dataSheet(headerRow, dataRows) {
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  ws["!cols"] = headerRow.map(() => ({ wch: 22 }));
  return ws;
}

function writeTemplate(fileName, headerRow, dataRows, instructionLines) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, dataSheet(headerRow, dataRows), "Data");
  XLSX.utils.book_append_sheet(
    wb,
    instructionsSheet(instructionLines),
    "Instructions"
  );
  XLSX.writeFile(wb, path.join(outDir, fileName));
}

const PLACEHOLDER_VERTICAL =
  "PASTE_VERTICAL_OBJECT_ID_24_HEX_CHARS";

// ---- SPN ----
writeTemplate(
  "Import_SPN.xlsx",
  [
    "spn",
    "vertical",
    "partName",
    "description",
    "genericDescription",
    "category",
    "subCategory",
    "uom",
    "status",
    "remarks",
  ],
  [
    [
      "SPN-DEMO-001",
      PLACEHOLDER_VERTICAL,
      "Demo exhaust valve",
      "For W32 family",
      "",
      "Valve",
      "Exhaust",
      "pcs",
      "Active",
      "",
    ],
  ],
  [
    "SPN bulk import — API: POST /api/import/spn",
    "",
    "Workbook: first worksheet must be named «Data» (default when you open this file).",
    "",
    "Required columns: spn, vertical, partName",
    `vertical: MongoDB ObjectId for an existing Vertical (e.g. ${PLACEHOLDER_VERTICAL}).`,
    "Create verticals in the app first, then copy the _id from the browser network response or MongoDB.",
    "",
    "Optional: description, genericDescription, category, subCategory, uom, status (Active | Inactive), remarks",
    "If only one of description / genericDescription is filled, it is copied to the other on save.",
    "",
    "Column headers on row 1 must match exactly (case-sensitive). Extra columns are ignored.",
  ]
);

// ---- Material ----
writeTemplate(
  "Import_Material.xlsx",
  [
    "materialCode",
    "spn",
    "vertical",
    "shortDescription",
    "itemType",
    "unit",
    "status",
    "remarks",
  ],
  [
    [
      "MAT-DEMO-001",
      "SPN-DEMO-001",
      PLACEHOLDER_VERTICAL,
      "Demo material row",
      "OEM",
      "pcs",
      "Active",
      "",
    ],
  ],
  [
    "Material bulk import — API: POST /api/import/materials",
    "",
    "Required: materialCode, spn, vertical, shortDescription, itemType, unit",
    "vertical: must match the vertical of the referenced SPN (same ObjectId as on the SPN record).",
    "itemType must be one of: OEM, Aftermarket, Reconditioned",
    "status: Active | Inactive (optional; defaults Active)",
    "",
    "The SPN value must already exist in SPN master before importing materials.",
  ]
);

// ---- Material compatibility ----
writeTemplate(
  "Import_Material_Compatibility.xlsx",
  [
    "materialCode",
    "brand",
    "engineModel",
    "configuration",
    "cylinderCount",
    "esnFrom",
    "esnTo",
    "remarks",
    "status",
  ],
  [
    [
      "MAT-DEMO-001",
      "Wärtsilä",
      "W32",
      "Inline",
      "6L",
      "",
      "",
      "Example row",
      "Active",
    ],
  ],
  [
    "Material compatibility — API: POST /api/import/material-compat",
    "",
    "Required: materialCode, brand, engineModel, configuration, cylinderCount",
    "materialCode must exist in Material master.",
    "brand: name must match an Active Brand under that material’s vertical (Brand master).",
    "engineModel: must match an Active Engine model under that brand (Engine models master).",
    "Legacy column engineMake is accepted by the API as an alias for brand.",
    "remarks: optional. Legacy applicabilityRemarks is also accepted.",
    "",
    "esnFrom / esnTo: optional numbers; leave blank if not used.",
    "Each row creates a new compatibility record; duplicate keys in DB will fail that row.",
  ]
);

// ---- Article ----
writeTemplate(
  "Import_Article.xlsx",
  [
    "articleNo",
    "materialCode",
    "description",
    "drawingNo",
    "maker",
    "brand",
    "unit",
    "weight",
    "hsnCode",
    "status",
    "remarks",
  ],
  [
    [
      "ART-DEMO-001",
      "MAT-DEMO-001",
      "Demo article description",
      "DWG-001",
      "Wärtsilä",
      "OEM",
      "pcs",
      2.5,
      "84099190",
      "Active",
      "",
    ],
  ],
  [
    "Article bulk import — API: POST /api/import/articles",
    "",
    "Required: articleNo, materialCode, description",
    "materialCode must exist in Material master.",
    "Optional: drawingNo, maker, brand, unit, weight, hsnCode, status, remarks",
    "Upsert: existing articleNo is updated; new articleNo is created.",
  ]
);

// ---- Material supplier ----
writeTemplate(
  "Import_Material_Supplier.xlsx",
  [
    "materialCode",
    "supplierName",
    "supplierArticleNo",
    "supplierDescription",
    "currency",
    "price",
    "leadTimeDays",
    "moq",
    "supplierCountry",
    "preferred",
    "status",
    "remarks",
  ],
  [
    [
      "MAT-DEMO-001",
      "Demo Supplier Ltd",
      "SUP-ART-001",
      "OEM valve",
      "EUR",
      500,
      30,
      2,
      "FI",
      0,
      "Active",
      "",
    ],
  ],
  [
    "Material supplier mapping — API: POST /api/import/material-suppliers",
    "",
    "Required: materialCode, supplierName",
    "materialCode must exist in Material master.",
    "price: use column «price» (API also accepts purchasePrice as alias).",
    "preferred: use 1 = true, 0 = false (or leave blank for false).",
    "Import always creates a new row (no upsert by supplier); avoid duplicate runs.",
    "",
    "Optional: supplierArticleNo, supplierDescription, currency, leadTimeDays, moq, supplierCountry, status, remarks",
  ]
);

// eslint-disable-next-line no-console
console.log("Wrote Excel templates to:", outDir);
