/**
 * ASN_RECEIVING Draft GRN post-readiness — single canonical evaluation.
 * Frontend disable is UX only; POST revalidates inside the transaction.
 *
 * Weight separation:
 * - Actual Unit Weight = ReceivingSessionUnit.actualUnitWeightKg → GRN line / CustomsLotItem
 * - Customs Declared Weight = CustomsBoe.grossWeightKg / netWeightKg (BOE header totals;
 *   both mandatory > 0 and net ≤ gross; never unit weight / never customsUnitValue inputs)
 */
import { roundAsnQty } from "./receivingInspectionRules.js";
import { isAsnReceivingGrn, resolveUnitWeightFromReceivingSources } from "./receivingDraftGrnRules.js";
import {
  resolveAsnSupplierInvoices,
  resolveAsnLineCountryOfOrigin,
  normalizeBoeNumber,
  findAsnLineForGrnItem,
} from "./asnCustomsFieldOwnership.js";
import { assertAsnReceivingPutawayLocation } from "./asnReceivingPutaway.js";

function t(v) {
  return String(v ?? "").trim();
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function blocker(code, message, meta = {}) {
  return { code, message, ...meta };
}

/**
 * Resolve unit weight for one GRN line from receiving sources + session units.
 * Different RU weights → weighted average (not a conflict).
 * Missing weight on an accepted source → missing.
 */
export function resolveReceivingUnitWeightForGrnLine(line, sessionUnitsById = new Map()) {
  const sources = (line?.receivingSources || []).map((src) => {
    const unit =
      sessionUnitsById.get(String(src.receivingSessionUnitId)) ||
      sessionUnitsById.get(String(src.receivingUnitId));
    const fromSrc = num(src.actualUnitWeightKg);
    const fromUnit = num(unit?.actualUnitWeightKg);
    return {
      ...src,
      actualUnitWeightKg: fromSrc ?? fromUnit ?? null,
    };
  });
  const resolved = resolveUnitWeightFromReceivingSources(sources);
  if (resolved.ok && resolved.unitWeightKg > 0) return resolved;
  if (resolved.missing) return resolved;
  const fallback = num(line?.customsCapture?.unitWeightKg);
  if (fallback != null && fallback > 0) {
    return { ok: true, unitWeightKg: fallback, conflict: false, missing: false, contributions: [] };
  }
  return { ok: false, unitWeightKg: 0, conflict: false, missing: true, contributions: resolved.contributions || [] };
}

/**
 * Pure readiness evaluation for an ASN_RECEIVING Draft GRN.
 *
 * @param {object} args
 * @param {Map|object[]} [args.stockLocations] Active StockLocation rows or Map by locationCode
 */
export function evaluateAsnReceivingPostReadiness({
  grn,
  asn = null,
  session = null,
  parentBoe = null,
  sessionUnits = [],
  stockLocations = [],
} = {}) {
  const blockers = [];
  if (!grn) {
    return { postReady: false, blockers: [blocker("GRN_MISSING", "Draft GRN is required")] };
  }
  if (!isAsnReceivingGrn(grn)) {
    return {
      postReady: false,
      blockers: [blocker("NOT_ASN_RECEIVING", "Post readiness applies only to ASN_RECEIVING Draft GRNs")],
    };
  }
  if (String(grn.status || "").toUpperCase() !== "DRAFT") {
    blockers.push(blocker("GRN_NOT_DRAFT", `GRN status is ${grn.status || "unknown"}; only DRAFT can post`));
  }
  if (session && String(session.status || "").toUpperCase() !== "COMPLETED") {
    blockers.push(blocker("RECEIVING_SESSION_NOT_COMPLETE", "Receiving session must be completed"));
  }

  const unitsArr = Array.isArray(sessionUnits)
    ? sessionUnits
    : sessionUnits instanceof Map
      ? [...sessionUnits.values()]
      : [];
  const unitsById = new Map();
  for (const u of unitsArr) {
    if (u?._id) unitsById.set(String(u._id), u);
    if (u?.receivingUnitId) unitsById.set(String(u.receivingUnitId), u);
  }

  const locMap =
    stockLocations instanceof Map
      ? stockLocations
      : new Map(
          (Array.isArray(stockLocations) ? stockLocations : []).map((l) => [
            String(l.locationCode || "").trim().toUpperCase(),
            l,
          ]),
        );

  const items = (grn.items || []).filter((ln) => (Number(ln.acceptedQty ?? ln.receivedQty) || 0) > 0);
  const firstCapture = items.map((ln) => ln.customsCapture).find(Boolean) || {};
  const boeMode = String(firstCapture.boeMode || "").toUpperCase();
  const hasParent = Boolean(parentBoe);

  // --- ASN ownership ---
  if (asn) {
    const invoices = resolveAsnSupplierInvoices(asn);
    if (!invoices.length || !t(invoices[0].invoiceNumber)) {
      blockers.push(blocker("ASN_SUPPLIER_INVOICE_REQUIRED", "ASN supplier invoice number is required"));
    } else if (!invoices[0].invoiceDate) {
      blockers.push(blocker("ASN_SUPPLIER_INVOICE_DATE_REQUIRED", "ASN supplier invoice date is required"));
    }
    for (const ln of items) {
      const asnLine = findAsnLineForGrnItem(asn, ln);
      const hs = t(asnLine?.hsCode || "");
      const coo = resolveAsnLineCountryOfOrigin(asnLine, asn);
      const article = t(ln.article) || "—";
      if (!hs) {
        blockers.push(
          blocker("ASN_HS_CODE_REQUIRED", `HS Code missing on ASN for Article ${article}`, {
            article,
            asnLineId: String(ln.asnLineId || ""),
          }),
        );
      }
      if (!coo) {
        blockers.push(
          blocker("ASN_COO_REQUIRED", `Country of Origin missing on ASN for Article ${article}`, {
            article,
            asnLineId: String(ln.asnLineId || ""),
          }),
        );
      }
    }
  } else {
    blockers.push(blocker("ASN_REQUIRED", "ASN is required for ASN_RECEIVING posting"));
  }

  // --- GRN line physical putaway + actual unit weight ---
  for (const ln of items) {
    const article = t(ln.article) || "—";
    const warehouse = t(ln.warehouse) || "MAIN";
    const putaway = assertAsnReceivingPutawayLocation(ln.location, {
      warehouse,
      stockLocationsByCode: locMap,
    });
    if (!putaway.ok) {
      blockers.push(blocker(putaway.code, `${putaway.message} (Article ${article})`, { article }));
    }
    const weightRes = resolveReceivingUnitWeightForGrnLine(ln, unitsById);
    if (weightRes.missing || !(weightRes.unitWeightKg > 0)) {
      const captureW = num(ln.customsCapture?.unitWeightKg);
      if (!(captureW > 0)) {
        blockers.push(
          blocker(
            "RECEIVING_UNIT_WEIGHT_REQUIRED",
            `Actual Unit Weight missing for Article ${article}`,
            { article },
          ),
        );
      }
    }
  }

  // --- BOE declaration ---
  const boeNumber = hasParent
    ? parentBoe.boeNumber
    : firstCapture.boeNumber || grn.customsDocRef || "";
  const boeDate = hasParent ? parentBoe.boeDate : firstCapture.boeDate;
  const declaredQty = hasParent
    ? Number(parentBoe.boeDeclaredQty) || 0
    : Number(firstCapture.boeDeclaredQty) || 0;
  const declaredValue = hasParent
    ? Number(parentBoe.boeDeclaredValue) || 0
    : Number(firstCapture.boeDeclaredValue) || 0;
  const currency = hasParent
    ? parentBoe.customsCurrency
    : firstCapture.customsCurrency || firstCapture.currency || "";
  const fx = hasParent
    ? Number(parentBoe.exchangeRateToAED) || 0
    : Number(firstCapture.exchangeRateToAED) || 0;
  const uom = hasParent
    ? parentBoe.customsUom || "PCS"
    : firstCapture.customsUom || "PCS";
  const gross = hasParent
    ? Number(parentBoe.grossWeightKg) || 0
    : Number(firstCapture.grossWeightKg) || 0;
  const net = hasParent
    ? Number(parentBoe.netWeightKg) || 0
    : Number(firstCapture.netWeightKg) || 0;

  if (!normalizeBoeNumber(boeNumber) && !t(firstCapture.customsBoeId) && !t(firstCapture.customsBoeRef)) {
    blockers.push(blocker("BOE_NUMBER_REQUIRED", "BOE Number is required"));
  }
  if (!boeDate) {
    blockers.push(blocker("BOE_DATE_REQUIRED", "BOE Date is required"));
  }
  if (!(declaredQty > 0)) {
    blockers.push(blocker("BOE_DECLARED_QTY_REQUIRED", "Total BOE Declared Qty is required"));
  }
  if (!(declaredValue > 0)) {
    blockers.push(blocker("BOE_DECLARED_VALUE_REQUIRED", "Total BOE Declared Value is required"));
  }
  if (!t(currency)) {
    blockers.push(blocker("BOE_CURRENCY_REQUIRED", "Customs Currency is required"));
  }
  if (!(fx > 0) && t(currency).toUpperCase() !== "AED") {
    blockers.push(blocker("BOE_FX_REQUIRED", "Exchange Rate to AED is required"));
  }
  if (!t(uom)) {
    blockers.push(blocker("BOE_UOM_REQUIRED", "Customs UOM is required"));
  }
  // BOE header declaration totals only — never Actual Unit Weight / never customsUnitValue inputs.
  if (!(gross > 0)) {
    blockers.push(blocker("BOE_GROSS_WEIGHT_REQUIRED", "Customs Declared Gross Weight (KG) is required"));
  }
  if (!(net > 0)) {
    blockers.push(blocker("BOE_NET_WEIGHT_REQUIRED", "Customs Declared Net Weight (KG) is required"));
  }
  if (gross > 0 && net > 0 && net > gross + 1e-9) {
    blockers.push(
      blocker("BOE_NET_WEIGHT_EXCEEDS_GROSS", "Customs Declared Net Weight cannot exceed Gross Weight"),
    );
  }

  if (hasParent && String(parentBoe.status || "").toUpperCase() === "CANCELLED") {
    blockers.push(blocker("CUSTOMS_BOE_CANCELLED", "Selected Customs BOE is CANCELLED"));
  }

  // Remaining-to-link (BOE cap)
  if (hasParent && declaredQty > 0) {
    const linked = Number(parentBoe.linkedCustomsQty) || 0;
    const thisGrn = roundAsnQty(items.reduce((s, ln) => s + (Number(ln.acceptedQty ?? ln.receivedQty) || 0), 0));
    if (linked + thisGrn > declaredQty + 1e-9) {
      blockers.push(
        blocker(
          "BOE_REMAINING_TO_LINK_INSUFFICIENT",
          `BOE remaining to link is insufficient (linked ${linked} + this GRN ${thisGrn} > declared ${declaredQty})`,
          { linked, thisGrn, declaredQty },
        ),
      );
    }
  }

  // Entitlement shortfall already reviewed separately — surface if present on grn
  if (grn.entitlementReview?.entitlementValid === false) {
    blockers.push(
      blocker(
        "GRN_DRAFT_ENTITLEMENT_CHANGED",
        "PO entitlement changed; delete and regenerate Draft GRN before posting",
      ),
    );
  }

  // De-dupe by code+article
  const seen = new Set();
  const unique = [];
  for (const b of blockers) {
    const key = `${b.code}|${b.article || ""}|${b.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(b);
  }

  return {
    postReady: unique.length === 0,
    blockers: unique,
    summary: {
      boeMode: hasParent ? "SELECT" : boeMode || "CREATE",
      boeNumber: t(boeNumber),
      declaredGrossWeightKg: gross,
      declaredNetWeightKg: net,
      customsUnitValue: hasParent
        ? Number(parentBoe.customsUnitValue) || 0
        : Number(firstCapture.customsUnitValue) || 0,
    },
  };
}
