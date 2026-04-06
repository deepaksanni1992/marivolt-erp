# Import templates (Excel)

Use these workbooks with **Item Master → Bulk import** in the app (first worksheet **Data** is read).

| File | API |
|------|-----|
| `Import_SPN.xlsx` | `POST /api/import/spn` |
| `Import_Material.xlsx` | `POST /api/import/materials` |
| `Import_Material_Compatibility.xlsx` | `POST /api/import/material-compat` |
| `Import_Article.xlsx` | `POST /api/import/articles` |
| `Import_Material_Supplier.xlsx` | `POST /api/import/material-suppliers` |

## Before you import

1. Create **Verticals**, **Brands**, and **Engine models** (per brand) in the app — there is no bulk import for those.
2. Replace placeholder **`PASTE_VERTICAL_OBJECT_ID_24_HEX_CHARS`** with a real Vertical `_id` (24-character hex string from the API or MongoDB).
3. Import in a sensible order: **SPN → Material → Compatibility / Article / Supplier** (compatibility rows require `engineModel` values that exist under **Engine models** for that brand).

## Regenerate `.xlsx` files

From the `marivolt-erp` folder:

```bash
npm run generate:import-templates
```

## CSV

`MATERIAL_COMPATIBILITY.csv` is a minimal CSV example for compatibility rows; the Excel file is the recommended template.
