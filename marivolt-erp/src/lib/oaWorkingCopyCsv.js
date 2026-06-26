import Papa from "papaparse";

const CSV_HEADERS = [
  "includeInOA",
  "article",
  "partNumber",
  "description",
  "uom",
  "quotedQty",
  "orderedQty",
  "quotedPrice",
  "orderedPrice",
  "discount",
  "tax",
  "remarks",
  "material",
  "availability",
];

function normCsvHeader(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/_/g, " ");
}

function compactHeader(s) {
  return normCsvHeader(s).replace(/\s/g, "");
}

function pickCsv(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const keyMap = Object.keys(row).map((k) => ({ raw: k, c: compactHeader(k) }));
  for (const a of aliases) {
    const want = compactHeader(a);
    const hit = keyMap.find((x) => x.c === want);
    if (!hit) continue;
    const v = row[hit.raw];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    return String(v).trim();
  }
  return "";
}

function parseMoneyOrQty(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/,/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseBool(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["false", "0", "no", "n"].includes(s)) return false;
  if (["true", "1", "yes", "y"].includes(s)) return true;
  return true;
}

export const OA_CSV_MAX_BYTES = 2 * 1024 * 1024;
export const OA_CSV_MAX_ROWS = 1000;

export function validateOaCsvFile(file) {
  const errors = [];
  if (!file) return { ok: false, errors: ["No file selected"] };
  if (file.size > OA_CSV_MAX_BYTES) {
    errors.push(`File exceeds maximum size of ${OA_CSV_MAX_BYTES / (1024 * 1024)}MB`);
  }
  const name = String(file.name || "").toLowerCase();
  if (name && !name.endsWith(".csv") && file.type && !file.type.includes("csv") && file.type !== "text/plain") {
    errors.push("Please upload a CSV file");
  }
  return { ok: errors.length === 0, errors };
}

export function oaLineDuplicateKey(line) {
  const art = String(line?.article ?? "")
    .trim()
    .toUpperCase();
  const part = String(line?.partNumber ?? "")
    .trim()
    .toUpperCase();
  return `${art}||${part}`;
}

export function parseOaWorkingLinesFromCsvRows(csvRows) {
  const errors = [];
  const out = [];
  if (!Array.isArray(csvRows)) {
    return { lines: [], errors: ["Invalid CSV data"] };
  }
  if (csvRows.length > OA_CSV_MAX_ROWS) {
    return { lines: [], errors: [`CSV exceeds maximum of ${OA_CSV_MAX_ROWS} data rows`] };
  }

  for (let rowIndex = 0; rowIndex < csvRows.length; rowIndex++) {
    const row = csvRows[rowIndex];
    const rowNum = rowIndex + 2;
    if (!row || typeof row !== "object") continue;
    const hasAnyCell = Object.keys(row).some((k) => String(row[k] ?? "").trim() !== "");
    if (!hasAnyCell) continue;

    const article = pickCsv(row, ["article", "item", "item code", "itemcode", "sku"]);
    const description = pickCsv(row, ["description", "desc"]);
    const orderedQtyRaw = pickCsv(row, ["orderedqty", "ordered qty", "qty", "quantity"]);
    const orderedQty = orderedQtyRaw === "" ? NaN : parseMoneyOrQty(orderedQtyRaw);

    if (!article && !description && orderedQtyRaw === "") continue;

    if (!article) {
      errors.push(`Row ${rowNum}: article is required`);
      continue;
    }
    if (!description) {
      errors.push(`Row ${rowNum}: description is required`);
      continue;
    }
    if (orderedQtyRaw !== "" && (!Number.isFinite(orderedQty) || orderedQty < 0)) {
      errors.push(`Row ${rowNum}: invalid ordered quantity`);
      continue;
    }
    if (orderedQtyRaw !== "" && orderedQty === 0) continue;

    const partNumber = pickCsv(row, ["partnumber", "part number", "part no", "partno"]);
    const uom = pickCsv(row, ["uom", "unit"]) || "PCS";
    const quotedQtyRaw = pickCsv(row, ["quotedqty", "quoted qty"]);
    const quotedPriceRaw = pickCsv(row, ["quotedprice", "quoted price"]);
    const orderedPriceRaw = pickCsv(row, ["orderedprice", "ordered price", "price", "unit price"]);
    const quotedQty = quotedQtyRaw === "" ? NaN : parseMoneyOrQty(quotedQtyRaw);
    const quotedPrice = quotedPriceRaw === "" ? NaN : parseMoneyOrQty(quotedPriceRaw);
    const orderedPrice = orderedPriceRaw === "" ? 0 : parseMoneyOrQty(orderedPriceRaw);

    if (quotedQtyRaw !== "" && (!Number.isFinite(quotedQty) || quotedQty < 0)) {
      errors.push(`Row ${rowNum}: invalid quoted quantity`);
      continue;
    }
    if (orderedPriceRaw !== "" && (!Number.isFinite(orderedPrice) || orderedPrice < 0)) {
      errors.push(`Row ${rowNum}: invalid ordered price`);
      continue;
    }

    const includeRaw = pickCsv(row, ["includeinoa", "include in oa", "include"]);
    out.push({
      serialNo: out.length + 1,
      sourceQuotationLineId: "",
      article: article.toUpperCase(),
      partNumber,
      description,
      uom,
      quotedQty: Number.isFinite(quotedQty) ? Math.max(0, quotedQty) : null,
      orderedQty: Number.isFinite(orderedQty) ? Math.max(0, orderedQty) : 1,
      quotedPrice: Number.isFinite(quotedPrice) ? Math.max(0, quotedPrice) : null,
      orderedPrice: Number.isFinite(orderedPrice) ? Math.max(0, orderedPrice) : 0,
      includeInOA: includeRaw === "" ? true : parseBool(includeRaw),
      isNewLine: true,
      discount: Math.max(0, parseMoneyOrQty(pickCsv(row, ["discount"])) || 0),
      tax: Math.max(0, parseMoneyOrQty(pickCsv(row, ["tax"])) || 0),
      remarks: pickCsv(row, ["remarks", "notes"]),
      materialCode: pickCsv(row, ["material", "material code", "materialcode"]),
      availability: pickCsv(row, ["availability", "avail"]),
      supplierInfo: "",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const line of out) {
    const key = oaLineDuplicateKey(line);
    if (seen.has(key)) {
      errors.push(`Duplicate article/part in CSV: ${line.article}`);
      const idx = deduped.findIndex((l) => oaLineDuplicateKey(l) === key);
      if (idx >= 0) deduped[idx] = line;
    } else {
      seen.add(key);
      deduped.push(line);
    }
  }

  return { lines: deduped, errors };
}

export function buildOaWorkingCsvPreview(currentLines, importedLines) {
  const currentByKey = new Map();
  for (const line of currentLines || []) {
    const k = oaLineDuplicateKey(line);
    if (!k.startsWith("||") && k !== "||") currentByKey.set(k, line);
  }
  const importedByKey = new Map();
  for (const line of importedLines || []) {
    importedByKey.set(oaLineDuplicateKey(line), line);
  }

  let updated = 0;
  let added = 0;
  let removed = 0;
  let qtyChanges = 0;
  let priceChanges = 0;
  const details = [];

  for (const [key, imp] of importedByKey) {
    const cur = currentByKey.get(key);
    if (!cur) {
      added += 1;
      details.push({ type: "added", key, article: imp.article });
      continue;
    }
    updated += 1;
    const oq = Number(cur.orderedQty) || 0;
    const nq = Number(imp.orderedQty) || 0;
    const op = Number(cur.orderedPrice) || 0;
    const np = Number(imp.orderedPrice) || 0;
    if (oq !== nq) {
      qtyChanges += 1;
      details.push({ type: "qty", key, from: oq, to: nq });
    }
    if (op !== np) {
      priceChanges += 1;
      details.push({ type: "price", key, from: op, to: np });
    }
  }

  for (const [key] of currentByKey) {
    if (!importedByKey.has(key)) {
      removed += 1;
      details.push({ type: "removed", key });
    }
  }

  return {
    totalLines: importedLines.length,
    updated,
    added,
    removed,
    qtyChanges,
    priceChanges,
    details,
    mergedLines: importedLines.map((l, i) => ({ ...l, serialNo: i + 1 })),
  };
}

export function exportOaWorkingLinesCsv(lines) {
  const data = (lines || []).map((line) => ({
    includeInOA: line.includeInOA !== false ? "true" : "false",
    article: line.article || "",
    partNumber: line.partNumber || "",
    description: line.description || "",
    uom: line.uom || "PCS",
    quotedQty: line.quotedQty != null ? line.quotedQty : "",
    orderedQty: line.orderedQty ?? line.qty ?? "",
    quotedPrice: line.quotedPrice != null ? line.quotedPrice : "",
    orderedPrice: line.orderedPrice ?? line.price ?? "",
    discount: line.discount ?? 0,
    tax: line.tax ?? 0,
    remarks: line.remarks || "",
    material: line.materialCode || line.material || "",
    availability: line.availability || "",
  }));
  const csv = Papa.unparse({ fields: CSV_HEADERS, data });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `oa-working-lines-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseOaWorkingCsvFile(file) {
  const fileCheck = validateOaCsvFile(file);
  if (!fileCheck.ok) {
    return Promise.reject(new Error(fileCheck.errors.join("; ")));
  }

  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      encoding: "UTF-8",
      complete: (results) => {
        try {
          const { lines, errors } = parseOaWorkingLinesFromCsvRows(results.data);
          if (errors.length) {
            reject(new Error(errors.slice(0, 5).join("; ") + (errors.length > 5 ? ` (+${errors.length - 5} more)` : "")));
            return;
          }
          if (!lines.length) {
            reject(new Error("No valid lines found in CSV. Article, description, and positive quantity are required."));
            return;
          }
          resolve(lines);
        } catch (e) {
          reject(e);
        }
      },
      error: (err) => reject(err),
    });
  });
}

export const OA_WORKING_CSV_TEMPLATE = `includeInOA,article,partNumber,description,uom,quotedQty,orderedQty,quotedPrice,orderedPrice,discount,tax,remarks,material,availability
true,51228,034.02.112,Sample spare part,PCS,2,1,25.00,24.00,0,0,Optional note,ABC123,In stock`;
