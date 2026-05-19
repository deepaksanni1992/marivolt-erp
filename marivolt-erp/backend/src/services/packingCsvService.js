import mongoose from "mongoose";

export const PACKING_CSV_HEADER =
  "Package No,Package Type,Dimensions,Gross Weight,Net Weight,Article,Description,Part Number,UOM,Qty in Package,Remarks";

function normKey(s) {
  return String(s ?? "").trim().toLowerCase();
}

function t(v) {
  return String(v ?? "").trim();
}

function headerAlias(h) {
  const k = normKey(h).replace(/[\s_]+/g, "");
  const map = {
    packageno: "packageNo",
    packagetype: "packageType",
    dimensions: "dimensions",
    grossweight: "grossWeightKg",
    grosswt: "grossWeightKg",
    netweight: "netWeightKg",
    netwt: "netWeightKg",
    article: "article",
    articleno: "article",
    description: "description",
    partnumber: "partNumber",
    partno: "partNumber",
    spn: "partNumber",
    uom: "uom",
    qtyinpackage: "qty",
    qty: "qty",
    packqty: "qty",
    remarks: "remarks",
  };
  return map[k] || k;
}

export function parsePackingCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { rows: [] };
  const splitLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if (!q && c === ",") {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => String(x).trim());
  };
  const rawHeaders = splitLine(lines[0]);
  const headers = rawHeaders.map(headerAlias);
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const parts = splitLine(lines[li]);
    const o = { _csvLine: li + 1 };
    headers.forEach((h, idx) => {
      o[h] = parts[idx] ?? "";
    });
    rows.push(o);
  }
  return { rows };
}

function findAllocationLine(allocLines, row) {
  const art = normKey(row.article);
  if (art) {
    const hit = allocLines.find((x) => normKey(x.article) === art);
    if (hit) return { line: hit, by: "article" };
  }
  const pn = normKey(row.partNumber);
  if (pn) {
    const hit = allocLines.find((x) => normKey(x.partNumber || x.spn) === pn);
    if (hit) return { line: hit, by: "partNumber" };
  }
  return null;
}

function sumDraftQtyByLine(draftPackages = []) {
  const map = new Map();
  for (const pkg of draftPackages || []) {
    for (const item of pkg.items || []) {
      const k = String(item.allocationLineId || "");
      if (!k) continue;
      map.set(k, (map.get(k) || 0) + (Number(item.qty) || 0));
    }
  }
  return map;
}

/**
 * Validate CSV import and build package structures for the UI.
 * @param {object} opts
 * @param {object} opts.allocation - OrderAllocation doc
 * @param {Map} opts.postedByLine - already posted pack qty per line id
 * @param {Array} opts.draftPackages - current UI packages (excluded from import totals; import replaces them)
 * @param {string} opts.csvText
 */
export function buildPackingImportPreview({ allocation, postedByLine, draftPackages = [], csvText }) {
  const allocLines = allocation?.lines || [];
  const { rows: csvRows } = parsePackingCsv(csvText);
  const preview = [];
  const errors = [];
  const blockingErrors = [];

  if (!csvRows.length) {
    blockingErrors.push({ line: 0, message: "CSV has no data rows." });
    return { preview, errors, blockingErrors, packages: [], canApply: false };
  }

  const pendingByLine = new Map();
  for (const ln of allocLines) {
    const id = String(ln._id);
    const allocated = Number(ln.qty) || 0;
    const posted = postedByLine.get(id) || 0;
    pendingByLine.set(id, Math.max(0, allocated - posted));
  }

  const packagesMap = new Map();
  const importQtyByLine = new Map();

  for (const row of csvRows) {
    const lineNo = row._csvLine;
    const packageNo = t(row.packageNo);
    const articleRaw = t(row.article);
    const partRaw = t(row.partNumber);
    const qtyRaw = row.qty;
    const hasArticleRow = Boolean(articleRaw || partRaw || qtyRaw);

    if (!hasArticleRow) {
      if (!packageNo) continue;
      if (!packagesMap.has(packageNo)) {
        packagesMap.set(packageNo, {
          packageNo,
          packageType: t(row.packageType) || "Carton",
          dimensions: t(row.dimensions),
          grossWeightKg: row.grossWeightKg,
          netWeightKg: row.netWeightKg,
          packageRemarks: t(row.remarks),
          items: [],
        });
      } else {
        const pkg = packagesMap.get(packageNo);
        if (t(row.packageType)) pkg.packageType = t(row.packageType);
        if (t(row.dimensions)) pkg.dimensions = t(row.dimensions);
        if (row.grossWeightKg !== "") pkg.grossWeightKg = row.grossWeightKg;
        if (row.netWeightKg !== "") pkg.netWeightKg = row.netWeightKg;
        if (t(row.remarks)) pkg.packageRemarks = t(row.remarks);
      }
      continue;
    }

    if (!packageNo) {
      const err = { line: lineNo, message: "Package No is required for article rows." };
      errors.push(err);
      blockingErrors.push(err);
      preview.push({
        line: lineNo,
        packageNo: "",
        article: articleRaw,
        description: t(row.description),
        qty: qtyRaw,
        status: "error",
        message: err.message,
      });
      continue;
    }

    const match = findAllocationLine(allocLines, row);
    if (!match) {
      const err = { line: lineNo, message: "Article not found in allocation (match Article or Part Number)." };
      errors.push(err);
      blockingErrors.push(err);
      preview.push({
        line: lineNo,
        packageNo,
        article: articleRaw || partRaw,
        description: t(row.description),
        qty: qtyRaw,
        status: "error",
        message: err.message,
      });
      continue;
    }

    const allocLine = match.line;
    const lineId = String(allocLine._id);
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) {
      const err = { line: lineNo, message: "Qty in Package must be greater than zero." };
      errors.push(err);
      blockingErrors.push(err);
      preview.push({
        line: lineNo,
        packageNo,
        article: allocLine.article,
        description: t(row.description) || allocLine.description || "",
        qty: qtyRaw,
        status: "error",
        message: err.message,
      });
      continue;
    }

    if (!packagesMap.has(packageNo)) {
      packagesMap.set(packageNo, {
        packageNo,
        packageType: t(row.packageType) || "Carton",
        dimensions: t(row.dimensions),
        grossWeightKg: row.grossWeightKg,
        netWeightKg: row.netWeightKg,
        packageRemarks: "",
        items: [],
      });
    }
    const pkg = packagesMap.get(packageNo);
    if (t(row.packageType)) pkg.packageType = t(row.packageType);
    if (t(row.dimensions)) pkg.dimensions = t(row.dimensions);
    if (row.grossWeightKg !== "") pkg.grossWeightKg = row.grossWeightKg;
    if (row.netWeightKg !== "") pkg.netWeightKg = row.netWeightKg;

    const existingItem = pkg.items.find((it) => String(it.allocationLineId) === lineId);
    if (existingItem) {
      existingItem.qty += qty;
    } else {
      pkg.items.push({
        allocationLineId: allocLine._id,
        article: String(allocLine.article || "").trim().toUpperCase(),
        description: t(row.description) || allocLine.description || "",
        spn: t(row.partNumber) || allocLine.partNumber || "",
        materialCode: allocLine.materialCode || "",
        qty,
        uom: t(row.uom) || allocLine.uom || "PCS",
        remarks: t(row.remarks),
      });
    }

    importQtyByLine.set(lineId, (importQtyByLine.get(lineId) || 0) + qty);

    preview.push({
      line: lineNo,
      packageNo,
      article: allocLine.article,
      description: t(row.description) || allocLine.description || "",
      qty,
      status: "ok",
      message: `Matched by ${match.by}`,
    });
  }

  for (const [lineId, importQty] of importQtyByLine.entries()) {
    const pending = pendingByLine.get(lineId) || 0;
    if (importQty > pending + 1e-6) {
      const allocLine = allocLines.find((x) => String(x._id) === lineId);
      const err = {
        line: 0,
        message: `Total packed qty (${importQty}) exceeds balance (${pending}) for ${allocLine?.article || lineId}.`,
      };
      errors.push(err);
      blockingErrors.push(err);
    }
  }

  const packages = Array.from(packagesMap.values());
  for (const pkg of packages) {
    if (!t(pkg.packageNo)) {
      const err = { line: 0, message: "Package No is missing." };
      blockingErrors.push(err);
    }
    if (!pkg.items.length) {
      const err = { line: 0, message: `Package ${pkg.packageNo} has no articles.` };
      blockingErrors.push(err);
    }
    if (!t(pkg.dimensions)) {
      const err = { line: 0, message: `Package ${pkg.packageNo}: Dimensions required.` };
      blockingErrors.push(err);
    }
    const gross = Number(pkg.grossWeightKg);
    const net = Number(pkg.netWeightKg);
    if (!Number.isFinite(gross) || gross <= 0) {
      const err = { line: 0, message: `Package ${pkg.packageNo}: Gross Weight required.` };
      blockingErrors.push(err);
    }
    if (!Number.isFinite(net) || net <= 0) {
      const err = { line: 0, message: `Package ${pkg.packageNo}: Net Weight required.` };
      blockingErrors.push(err);
    }
  }

  void draftPackages;

  const canApply = blockingErrors.length === 0 && packages.length > 0 && packages.every((p) => p.items.length > 0);

  return {
    preview,
    errors,
    blockingErrors,
    packages: canApply ? packages : [],
    canApply,
  };
}

export function validatePackingPackagesForSave(packages = [], allocation, postedByLine) {
  const msgs = [];
  const list = Array.isArray(packages) ? packages : [];
  if (!list.length) {
    msgs.push("At least one package is required.");
    return msgs;
  }
  const allocLines = allocation?.lines || [];
  const draftByLine = sumDraftQtyByLine(list);

  for (const pkg of list) {
    const pno = t(pkg.packageNo);
    if (!pno) msgs.push("Each package must have a Package No.");
    if (!t(pkg.dimensions)) msgs.push(`Package ${pno || "?"}: Dimensions required.`);
    const gross = Number(pkg.grossWeightKg);
    const net = Number(pkg.netWeightKg);
    if (!Number.isFinite(gross) || gross <= 0) msgs.push(`Package ${pno || "?"}: Gross Weight required.`);
    if (!Number.isFinite(net) || net <= 0) msgs.push(`Package ${pno || "?"}: Net Weight required.`);
    const items = (pkg.items || []).filter((it) => Number(it.qty) > 0);
    if (!items.length) msgs.push(`Package ${pno || "?"} is empty — add at least one article.`);
    for (const item of items) {
      const lineId = String(item.allocationLineId || "");
      const match = allocLines.find((x) => String(x._id) === lineId);
      if (!match) {
        msgs.push(`Article ${item.article || "?"} is not on this allocation.`);
        continue;
      }
      if (!mongoose.Types.ObjectId.isValid(lineId)) {
        msgs.push(`Invalid allocation line for ${item.article || "?"}.`);
      }
    }
  }

  for (const ln of allocLines) {
    const lineId = String(ln._id);
    const allocated = Number(ln.qty) || 0;
    const posted = postedByLine.get(lineId) || 0;
    const pending = Math.max(0, allocated - posted);
    const inDraft = draftByLine.get(lineId) || 0;
    if (inDraft > pending + 1e-6) {
      msgs.push(`Pack qty exceeds balance for ${ln.article} (max ${pending}).`);
    }
  }

  return msgs;
}
