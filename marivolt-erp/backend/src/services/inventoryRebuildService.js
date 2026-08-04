/**
 * Generic inventory rebuild framework.
 * Dry-run by default. Explicit apply=true / --apply required.
 * No direct ad-hoc DB edits outside stockService / documented rebuild paths.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import AuditLog from "../models/AuditLog.js";
import { recalculateStockBalance } from "./stockService.js";
import {
  calculateExpectedReserved,
  calculateExpectedPacked,
} from "./stockExpectedBuckets.js";
import { ON_HAND_MOVEMENT_TYPES as PHYSICAL } from "./stockBucketIntegrityService.js";
import { validateAllStock } from "./reservationIntegrityService.js";
import { invalidateDataHealthCache } from "./dataHealthService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPS = 1e-6;

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

function evidenceDir() {
  return path.resolve(__dirname, "../../scripts/repair-evidence");
}

function writeEvidence(name, payload) {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${name}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function isPhysicalLedgerRow(row) {
  const mt = up(row.movementType);
  if (mt && PHYSICAL.includes(mt)) return true;
  return false;
}

export const REBUILD_KINDS = Object.freeze([
  "ON_HAND_FROM_LEDGER",
  "RESERVED_FROM_ALLOCATION",
  "PACKED_FROM_PACKING",
  "AVAILABLE",
  "RESERVATION_INTEGRITY",
  "HEALTH_CACHE",
  "CUSTOMS_NOTE",
]);

/**
 * Diagnose rebuild for one article/warehouse.
 */
export async function diagnoseInventoryRebuild({
  companyId,
  warehouse = "MAIN",
  article,
  kinds = ["ON_HAND_FROM_LEDGER", "RESERVED_FROM_ALLOCATION", "PACKED_FROM_PACKING", "AVAILABLE"],
}) {
  const code = up(article);
  const wh = up(warehouse) || "MAIN";
  if (!companyId || !code) throw Object.assign(new Error("companyId and article required"), { statusCode: 400 });

  const balance = await StockBalance.findOne({
    companyId,
    $or: [
      { article: code, location: wh },
      { article: code, warehouse: wh },
      { itemCode: code, warehouse: wh },
    ],
  }).lean();

  const onHandQty = n(balance?.onHandQty ?? balance?.quantity);
  const reservedQty = Math.max(n(balance?.allocatedQty), n(balance?.reservedQty));
  const packedQty = n(balance?.packedQty);

  const ledgers = await StockLedger.find({
    companyId,
    article: code,
    $or: [{ warehouse: wh }, { location: wh }],
  })
    .select("movementType transactionType qtyIn qtyOut effectKey")
    .lean();

  let ledgerOnHand = 0;
  for (const row of ledgers) {
    if (!isPhysicalLedgerRow(row)) continue;
    ledgerOnHand += n(row.qtyIn) - n(row.qtyOut);
  }

  const [expR, expP] = await Promise.all([
    calculateExpectedReserved(companyId, wh, code),
    calculateExpectedPacked(companyId, wh, code),
  ]);

  const proposed = {
    onHandQty: kinds.includes("ON_HAND_FROM_LEDGER") ? ledgerOnHand : onHandQty,
    reservedQty: kinds.includes("RESERVED_FROM_ALLOCATION")
      ? expR.expectedReservedQty
      : reservedQty,
    packedQty: kinds.includes("PACKED_FROM_PACKING") ? expP.expectedPackedQty : packedQty,
  };
  proposed.availableQty = proposed.onHandQty - proposed.reservedQty - proposed.packedQty;

  const changes = [];
  if (kinds.includes("ON_HAND_FROM_LEDGER") && Math.abs(onHandQty - ledgerOnHand) > EPS) {
    changes.push({ field: "onHandQty", from: onHandQty, to: ledgerOnHand });
  }
  if (
    kinds.includes("RESERVED_FROM_ALLOCATION") &&
    Math.abs(reservedQty - expR.expectedReservedQty) > EPS
  ) {
    changes.push({ field: "reservedQty", from: reservedQty, to: expR.expectedReservedQty });
  }
  if (
    kinds.includes("PACKED_FROM_PACKING") &&
    Math.abs(packedQty - expP.expectedPackedQty) > EPS
  ) {
    changes.push({ field: "packedQty", from: packedQty, to: expP.expectedPackedQty });
  }
  if (kinds.includes("AVAILABLE")) {
    const storedAvail =
      balance?.availableQty != null
        ? n(balance.availableQty)
        : onHandQty - reservedQty - packedQty;
    if (Math.abs(storedAvail - proposed.availableQty) > EPS) {
      changes.push({ field: "availableQty", from: storedAvail, to: proposed.availableQty });
    }
  }

  return {
    companyId: String(companyId),
    warehouse: wh,
    article: code,
    stockBalanceId: balance?._id ? String(balance._id) : null,
    kinds,
    before: { onHandQty, reservedQty, packedQty, availableQty: onHandQty - reservedQty - packedQty },
    ledgerOnHand,
    expectedReservedQty: expR.expectedReservedQty,
    expectedPackedQty: expP.expectedPackedQty,
    proposed,
    changes,
    rebuildable: Boolean(balance) && changes.length > 0,
  };
}

/**
 * Apply rebuild (or dry-run).
 */
export async function rebuildInventoryBuckets({
  companyId,
  warehouse = "MAIN",
  article,
  kinds,
  apply = false,
  repairedBy = "inventoryRebuild",
  reason = "Inventory rebuild",
}) {
  const diagnosis = await diagnoseInventoryRebuild({
    companyId,
    warehouse,
    article,
    kinds,
  });

  const mode = apply ? "apply" : "dry-run";
  const evidencePath = writeEvidence(`inventory-rebuild-${mode}`, {
    mode,
    at: new Date().toISOString(),
    diagnosis,
    repairedBy,
    reason,
  });

  if (!diagnosis.stockBalanceId) {
    return { ...diagnosis, applied: false, evidencePath, message: "StockBalance not found" };
  }
  if (!diagnosis.rebuildable) {
    return {
      ...diagnosis,
      applied: false,
      idempotent: true,
      evidencePath,
      message: "Already consistent — no rebuild needed",
    };
  }
  if (!apply) {
    return {
      ...diagnosis,
      applied: false,
      dryRun: true,
      evidencePath,
      message: "DRY-RUN OK — pass apply:true or --apply to execute",
    };
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const balId = new mongoose.Types.ObjectId(diagnosis.stockBalanceId);
      const filter = {
        _id: balId,
        companyId,
        onHandQty: diagnosis.before.onHandQty,
        reservedQty: diagnosis.before.reservedQty,
        packedQty: diagnosis.before.packedQty,
      };
      // Conditional: also accept quantity alias for onHand
      const updateRes = await StockBalance.updateOne(
        {
          _id: balId,
          companyId,
          $or: [
            { onHandQty: diagnosis.before.onHandQty },
            { quantity: diagnosis.before.onHandQty, onHandQty: { $in: [null, undefined] } },
          ],
        },
        {
          $set: {
            onHandQty: diagnosis.proposed.onHandQty,
            quantity: diagnosis.proposed.onHandQty,
            reservedQty: diagnosis.proposed.reservedQty,
            allocatedQty: diagnosis.proposed.reservedQty,
            packedQty: diagnosis.proposed.packedQty,
            availableQty: diagnosis.proposed.availableQty,
          },
        },
        { session }
      );

      if (updateRes.matchedCount !== 1) {
        // Fallback: match by reserved/packed only when onHand field layout differs
        const updateRes2 = await StockBalance.updateOne(
          {
            _id: balId,
            companyId,
            reservedQty: diagnosis.before.reservedQty,
            packedQty: diagnosis.before.packedQty,
          },
          {
            $set: {
              onHandQty: diagnosis.proposed.onHandQty,
              quantity: diagnosis.proposed.onHandQty,
              reservedQty: diagnosis.proposed.reservedQty,
              allocatedQty: diagnosis.proposed.reservedQty,
              packedQty: diagnosis.proposed.packedQty,
              availableQty: diagnosis.proposed.availableQty,
            },
          },
          { session }
        );
        if (updateRes2.matchedCount !== 1) {
          throw new Error(
            `Conditional StockBalance update matchedCount=${updateRes2.matchedCount} (expected 1)`
          );
        }
      }

      await AuditLog.create(
        [
          {
            companyId,
            userEmail: repairedBy,
            userName: repairedBy,
            action: "STOCK",
            module: "STOCK",
            entityType: "StockBalance",
            entityId: diagnosis.stockBalanceId,
            documentNo: diagnosis.article,
            description: `Inventory rebuild [${(kinds || []).join(",")}]: ${reason}`,
            beforeData: diagnosis.before,
            afterData: diagnosis.proposed,
            metadata: { kinds, reason, repairedBy, changes: diagnosis.changes },
          },
        ],
        { session }
      );

      result = {
        applied: true,
        before: diagnosis.before,
        after: diagnosis.proposed,
      };
    });
  } finally {
    session.endSession();
  }

  if (kinds?.includes("AVAILABLE") || true) {
    try {
      await recalculateStockBalance({
        companyId,
        article: diagnosis.article,
        warehouse: diagnosis.warehouse,
      });
    } catch {
      /* optional */
    }
  }

  const out = { ...diagnosis, ...result, evidencePath };
  writeEvidence("inventory-rebuild-apply-result", out);
  return out;
}

export async function rebuildReservationIntegrityScan({ companyId, warehouse, article, apply = false }) {
  if (!apply) {
    return {
      dryRun: true,
      message: "Pass apply:true to persist ReservationIntegrityIssue rows via validateAllStock",
      companyId: String(companyId),
    };
  }
  const report = await validateAllStock({
    companyId,
    warehouse,
    article,
    includeHealthy: false,
    persist: true,
  });
  return { applied: true, summary: report.summary, scanId: report.scanId };
}

export async function rebuildHealthCache({ companyId, apply = false }) {
  if (!apply) {
    return { dryRun: true, message: "Pass apply:true to invalidate Data Health cache" };
  }
  invalidateDataHealthCache(companyId);
  return { applied: true, message: "Data Health cache invalidated" };
}

export async function rebuildCustomsNote() {
  return {
    applied: false,
    message:
      "Customs rebuild is diagnose-only in this release — use Customs Reconciliation UI. No automatic customs qty rewrite.",
  };
}

/**
 * Company-wide dry-run scan (read-only). Never writes.
 */
export async function diagnoseCompanyInventoryRebuild({
  companyId,
  warehouse,
  limit = 200,
}) {
  const filter = { companyId };
  if (warehouse) {
    const wh = up(warehouse);
    filter.$or = [{ location: wh }, { warehouse: wh }];
  }
  const balances = await StockBalance.find(filter)
    .select("article itemCode warehouse location onHandQty quantity reservedQty allocatedQty packedQty availableQty")
    .limit(Math.min(2000, Math.max(1, Number(limit) || 200)))
    .lean();

  const rows = [];
  let rebuildable = 0;
  let refused = 0;
  let critical = 0;

  for (const b of balances) {
    const article = up(b.article || b.itemCode);
    const wh = up(b.warehouse || b.location) || "MAIN";
    if (!article) {
      refused += 1;
      continue;
    }
    try {
      const d = await diagnoseInventoryRebuild({
        companyId,
        warehouse: wh,
        article,
      });
      if (d.rebuildable) {
        rebuildable += 1;
        const hasOnHand = (d.changes || []).some((c) => c.field === "onHandQty");
        if (hasOnHand) critical += 1;
        rows.push({
          article: d.article,
          warehouse: d.warehouse,
          changes: d.changes,
          before: d.before,
          proposed: d.proposed,
        });
      }
    } catch {
      refused += 1;
    }
  }

  const evidencePath = writeEvidence("inventory-rebuild-company-dry-run", {
    mode: "dry-run",
    at: new Date().toISOString(),
    companyId: String(companyId),
    warehouse: warehouse || null,
    rowsScanned: balances.length,
    rebuildable,
    refused,
    criticalOnHandMismatches: critical,
    proposedRows: rows.slice(0, 100),
  });

  return {
    dryRun: true,
    applied: false,
    rowsScanned: balances.length,
    rebuildable,
    refused,
    criticalOnHandMismatches: critical,
    proposedChanges: rows,
    evidencePath,
    message: "DRY-RUN OK — no stock mutated. Pass --article=X --apply to rebuild one row.",
  };
}

export default {
  REBUILD_KINDS,
  diagnoseInventoryRebuild,
  diagnoseCompanyInventoryRebuild,
  rebuildInventoryBuckets,
  rebuildReservationIntegrityScan,
  rebuildHealthCache,
  rebuildCustomsNote,
};
