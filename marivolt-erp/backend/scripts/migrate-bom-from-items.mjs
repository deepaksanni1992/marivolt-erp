/**
 * One-off: copy legacy BOM references from `items` collection into string fields,
 * then remove parentItemId and line itemId from `boms`.
 *
 * Run from backend folder: npm run migrate:bom-from-items
 *
 * Requires: MongoDB still has `items` documents referenced by old BOMs (run before dropping `items`).
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const boms = db.collection("boms");
  const items = db.collection("items");

  let updated = 0;
  const cursor = boms.find({});

  for await (const bom of cursor) {
    const setFields = {};
    const unsetFields = {};
    let touched = false;

    if (bom.parentItemId) {
      const it = await items.findOne({ _id: bom.parentItemId });
      if (it) {
        const mc = String(it.materialCode || it.sku || "").trim();
        if (mc) setFields.parentMaterialCode = mc;
        const art = String(it.article || "").trim();
        if (art && !String(bom.parentArticle || "").trim()) {
          setFields.parentArticle = art;
        }
        if (!String(bom.parentDescription || "").trim() && it.description) {
          setFields.parentDescription = String(it.description);
        }
        if (!String(bom.parentSpn || "").trim() && it.spn) {
          setFields.parentSpn = String(it.spn);
        }
        if (!String(bom.parentName || "").trim() && it.name) {
          setFields.parentName = String(it.name);
        }
        if (!(Number(bom.parentUnitWeight) > 0) && it.unitWeight != null) {
          setFields.parentUnitWeight = Number(it.unitWeight) || 0;
        }
      }
      unsetFields.parentItemId = "";
      touched = true;
    }

    const lines = Array.isArray(bom.lines) ? bom.lines : [];
    const newLines = [];
    let linesTouched = false;

    for (const line of lines) {
      const L = { ...line };
      if (line.itemId) {
        const it = await items.findOne({ _id: line.itemId });
        if (it) {
          const mc = String(it.materialCode || it.sku || "").trim();
          if (mc) L.materialCode = mc;
          const art = String(it.article || "").trim();
          if (art && !String(L.article || "").trim()) L.article = art;
          if (!String(L.description || "").trim() && it.description) {
            L.description = String(it.description);
          }
          if (!String(L.spn || "").trim() && it.spn) L.spn = String(it.spn);
          if (!String(L.name || "").trim() && it.name) L.name = String(it.name);
          if (!(Number(L.unitWeight) > 0) && it.unitWeight != null) {
            L.unitWeight = Number(it.unitWeight) || 0;
          }
        }
        delete L.itemId;
        linesTouched = true;
      }
      newLines.push(L);
    }

    if (linesTouched) {
      setFields.lines = newLines;
      touched = true;
    }

    if (touched) {
      const update = {};
      if (Object.keys(setFields).length) update.$set = setFields;
      if (Object.keys(unsetFields).length) update.$unset = unsetFields;
      await boms.updateOne({ _id: bom._id }, update);
      updated += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`BOM migration: updated ${updated} document(s).`);
  await mongoose.disconnect();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
