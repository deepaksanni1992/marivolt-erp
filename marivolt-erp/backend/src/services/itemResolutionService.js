import ItemMaster from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";

function trim(value) {
  return String(value ?? "").trim();
}

function escRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withCompany(companyId, filter = {}) {
  return { companyId, ...filter };
}

export const SCORE_WEIGHTS = Object.freeze({
  ESN_EXACT: 100,
  SPN_EXACT: 80,
  MODEL_EXACT: 50,
  CONFIG_EXACT: 40,
  OEM_REF_EXACT: 30,
  INTERCHANGEABLE_MATCH: 20,
  MATERIAL_CODE_EXACT: 60,
  DRAWING_EXACT: 45,
  SUPPLIER_REF_EXACT: 25,
});

function normalizeInput(input = {}) {
  return {
    article: trim(input.article).toUpperCase(),
    esn: trim(input.esn),
    spn: trim(input.spn),
    materialCode: trim(input.materialCode),
    drawingNumber: trim(input.drawingNumber),
    oemReference: trim(input.oemReference),
    supplierReference: trim(input.supplierReference),
    engineModel: trim(input.engineModel),
    configuration: trim(input.configuration),
    debug: String(input.debug || "").toLowerCase() === "true" || Boolean(input.debug),
  };
}

function scoreCandidate({ input, item, technical, allTechnicals }) {
  let score = 0;
  const reasons = [];
  const breakdown = [];
  const reEq = (x) => new RegExp(`^${escRe(x)}$`, "i");
  if (input.article && item.article === input.article) {
    score += 120;
    reasons.push("Exact article");
    breakdown.push({ key: "ARTICLE_EXACT", points: 120 });
  }
  if (input.esn && technical.esn && reEq(input.esn).test(technical.esn)) {
    score += SCORE_WEIGHTS.ESN_EXACT;
    reasons.push("Exact ESN");
    breakdown.push({ key: "ESN_EXACT", points: SCORE_WEIGHTS.ESN_EXACT });
  }
  if (input.spn && technical.spn && reEq(input.spn).test(technical.spn)) {
    score += SCORE_WEIGHTS.SPN_EXACT;
    reasons.push("Exact SPN");
    breakdown.push({ key: "SPN_EXACT", points: SCORE_WEIGHTS.SPN_EXACT });
  }
  if (input.materialCode && technical.materialCode && reEq(input.materialCode).test(technical.materialCode)) {
    score += SCORE_WEIGHTS.MATERIAL_CODE_EXACT;
    reasons.push("Exact Material Code");
    breakdown.push({ key: "MATERIAL_CODE_EXACT", points: SCORE_WEIGHTS.MATERIAL_CODE_EXACT });
  }
  if (input.oemReference && (technical.oemCrossReferences || []).some((x) => reEq(input.oemReference).test(trim(x.oemPartNumber)))) {
    score += SCORE_WEIGHTS.OEM_REF_EXACT;
    reasons.push("Exact OEM reference");
    breakdown.push({ key: "OEM_REF_EXACT", points: SCORE_WEIGHTS.OEM_REF_EXACT });
  }
  if (
    input.supplierReference &&
    ((technical.supplierReferences || []).some((x) => reEq(input.supplierReference).test(trim(x.supplierPartNumber))) ||
      false)
  ) {
    score += SCORE_WEIGHTS.SUPPLIER_REF_EXACT;
    reasons.push("Exact supplier reference");
    breakdown.push({ key: "SUPPLIER_REF_EXACT", points: SCORE_WEIGHTS.SUPPLIER_REF_EXACT });
  }
  if (input.drawingNumber && technical.drawingNumber && reEq(input.drawingNumber).test(technical.drawingNumber)) {
    score += SCORE_WEIGHTS.DRAWING_EXACT;
    reasons.push("Exact drawing number");
    breakdown.push({ key: "DRAWING_EXACT", points: SCORE_WEIGHTS.DRAWING_EXACT });
  }
  if (input.engineModel && item.model && reEq(input.engineModel).test(item.model)) {
    score += SCORE_WEIGHTS.MODEL_EXACT;
    reasons.push("Exact model");
    breakdown.push({ key: "MODEL_EXACT", points: SCORE_WEIGHTS.MODEL_EXACT });
  }
  if (input.configuration && item.config && reEq(input.configuration).test(item.config)) {
    score += SCORE_WEIGHTS.CONFIG_EXACT;
    reasons.push("Exact config");
    breakdown.push({ key: "CONFIG_EXACT", points: SCORE_WEIGHTS.CONFIG_EXACT });
  }
  if (
    (input.supplierReference || input.materialCode || input.spn || input.esn) &&
    (technical.interchangeableParts || []).length
  ) {
    const interchangeArticles = new Set((technical.interchangeableParts || []).map((x) => trim(x.article).toUpperCase()).filter(Boolean));
    const matchedInterchange = allTechnicals.some((row) => {
      if (!interchangeArticles.has(trim(row.article).toUpperCase())) return false;
      return (
        (input.spn && row.spn && reEq(input.spn).test(row.spn)) ||
        (input.esn && row.esn && reEq(input.esn).test(row.esn)) ||
        (input.materialCode && row.materialCode && reEq(input.materialCode).test(row.materialCode))
      );
    });
    if (matchedInterchange) {
      score += SCORE_WEIGHTS.INTERCHANGEABLE_MATCH;
      reasons.push("Interchangeable mapping matched");
      breakdown.push({ key: "INTERCHANGEABLE_MATCH", points: SCORE_WEIGHTS.INTERCHANGEABLE_MATCH });
    }
  }
  // Priority rule bumpers
  if (input.esn && input.spn && reasons.includes("Exact ESN") && reasons.includes("Exact SPN")) score += 200;
  else if (input.esn && input.materialCode && reasons.includes("Exact ESN") && reasons.includes("Exact Material Code")) score += 170;
  else if (input.esn && input.oemReference && reasons.includes("Exact ESN") && reasons.includes("Exact OEM reference")) score += 160;
  else if (input.engineModel && input.configuration && input.spn && reasons.includes("Exact model") && reasons.includes("Exact config") && reasons.includes("Exact SPN")) score += 130;
  else if (input.engineModel && input.configuration && input.materialCode && reasons.includes("Exact model") && reasons.includes("Exact config") && reasons.includes("Exact Material Code")) score += 115;
  return { score, reasons, breakdown };
}

function confidenceFromScore(score) {
  if (score >= 220) return "HIGH";
  if (score >= 120) return "MEDIUM";
  return "LOW";
}

export async function resolveLookup({ companyId, input }) {
  const normalized = normalizeInput(input);
  if (!normalized.esn && !normalized.spn && !normalized.materialCode && !normalized.drawingNumber && !normalized.article && !normalized.oemReference && !normalized.supplierReference) {
    return { matchedArticle: "", confidence: "LOW", matchedReason: "No lookup identifiers provided", alternativeCandidates: [], duplicateWarning: false };
  }
  const technicalFilter = withCompany(companyId, {});
  const or = [];
  if (normalized.esn) or.push({ esn: new RegExp(escRe(normalized.esn), "i") });
  if (normalized.spn) or.push({ spn: new RegExp(escRe(normalized.spn), "i") });
  if (normalized.materialCode) or.push({ materialCode: new RegExp(escRe(normalized.materialCode), "i") });
  if (normalized.drawingNumber) or.push({ drawingNumber: new RegExp(escRe(normalized.drawingNumber), "i") });
  if (normalized.oemReference) or.push({ "oemCrossReferences.oemPartNumber": new RegExp(escRe(normalized.oemReference), "i") });
  if (normalized.supplierReference) or.push({ "supplierReferences.supplierPartNumber": new RegExp(escRe(normalized.supplierReference), "i") });
  if (or.length) technicalFilter.$or = or;
  const technicals = await ItemTechnical.find(or.length ? technicalFilter : withCompany(companyId, {})).lean();
  let candidateArticles = [...new Set(technicals.map((x) => trim(x.article).toUpperCase()).filter(Boolean))];
  if (!candidateArticles.length && normalized.article) candidateArticles = [normalized.article];
  if (!candidateArticles.length) {
    const byModelConfig = await ItemMaster.find(
      withCompany(companyId, {
        ...(normalized.engineModel ? { model: new RegExp(`^${escRe(normalized.engineModel)}$`, "i") } : {}),
        ...(normalized.configuration ? { config: new RegExp(`^${escRe(normalized.configuration)}$`, "i") } : {}),
      })
    )
      .select("article")
      .lean();
    candidateArticles = byModelConfig.map((x) => x.article);
  }
  candidateArticles = [...new Set(candidateArticles)];
  if (!candidateArticles.length) {
    return { matchedArticle: "", confidence: "LOW", matchedReason: "No match found", alternativeCandidates: [], duplicateWarning: false };
  }
  const [items, candidateTechnicals] = await Promise.all([
    ItemMaster.find(withCompany(companyId, { article: { $in: candidateArticles } })).lean(),
    ItemTechnical.find(withCompany(companyId, { article: { $in: candidateArticles } })).lean(),
  ]);
  const itemByArticle = new Map(items.map((x) => [x.article, x]));
  const technicalByArticle = new Map(candidateTechnicals.map((x) => [x.article, x]));
  const scored = candidateArticles
    .map((article) => {
      const item = itemByArticle.get(article);
      if (!item) return null;
      const technical = technicalByArticle.get(article) || {};
      const scoreResult = scoreCandidate({ input: normalized, item, technical, allTechnicals: technicals });
      return {
        article,
        itemName: item.itemName || "",
        score: scoreResult.score,
        reasons: scoreResult.reasons,
        breakdown: scoreResult.breakdown,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.article.localeCompare(b.article));
  const best = scored[0] || null;
  const second = scored[1] || null;
  const duplicateWarning = Boolean(best && second && Math.abs(best.score - second.score) <= 10);
  const confidence = confidenceFromScore(best?.score || 0);
  const response = {
    matchedArticle: best?.article || "",
    confidence,
    matchedReason: best?.reasons?.slice(0, 3).join(" + ") || "No high-confidence matching signals",
    alternativeCandidates: scored.slice(1, 6).map((x) => ({
      article: x.article,
      confidence: confidenceFromScore(x.score),
      score: x.score,
      reason: x.reasons?.slice(0, 2).join(" + ") || "Partial match",
    })),
    duplicateWarning,
  };
  if (normalized.debug) {
    response.debug = {
      input: normalized,
      scoring: scored.map((x) => ({
        article: x.article,
        score: x.score,
        breakdown: x.breakdown,
      })),
    };
  }
  return response;
}

export async function resolveLookupBatch({ companyId, rows }) {
  const out = new Array(rows.length);
  const chunkSize = 20;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const resolvedChunk = await Promise.all(
      chunk.map((payload) => resolveLookup({ companyId, input: payload || {} }))
    );
    for (let j = 0; j < resolvedChunk.length; j += 1) {
      out[i + j] = resolvedChunk[j];
    }
  }
  return out;
}

