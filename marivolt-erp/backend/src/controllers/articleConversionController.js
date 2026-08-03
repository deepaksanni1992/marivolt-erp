import crypto from "crypto";
import mongoose from "mongoose";
import ArticleStockConversion, {
  ARTICLE_CONVERSION_REASON_CODES,
} from "../models/ArticleStockConversion.js";
import ArticleEquivalenceMapping from "../models/ArticleEquivalenceMapping.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockLocation from "../models/StockLocation.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import * as stockService from "../services/stockService.js";
import {
  retargetCustomsLotsForConversion,
  reverseCustomsLotsForConversion,
  selectCustomsLayersForConversion,
} from "../services/articleConversionCustomsService.js";
import { writeAudit } from "../services/auditService.js";
import { nextUniqueSalesDocNumber } from "../utils/salesDocNumber.js";
import { hasPermission } from "../services/roleService.js";
import {
  ARTICLE_CONVERSION_ALREADY_POSTED,
  ARTICLE_CONVERSION_ALREADY_REVERSED,
  ARTICLE_CONVERSION_MAPPING_REQUIRED,
  ARTICLE_CONVERSION_POSTING_CONFLICT,
  ARTICLE_CONVERSION_POST_IN_PROGRESS,
  ARTICLE_CONVERSION_REVERSAL_BLOCKED,
  ARTICLE_CONVERSION_SAME_ARTICLE,
  ARTICLE_CONVERSION_SOURCE_DOCUMENT_TYPE,
  ARTICLE_CONVERSION_STOCK_SHORTAGE,
  ARTICLE_CONVERSION_UOM_MISMATCH,
  articleConversionConflictError,
  buildArticleConversionEffectKey,
  buildArticleConversionReversalEffectKey,
  isArticleConversionEffectDuplicateKeyError,
} from "../utils/articleConversionIdempotency.js";

function t(v) {
  return String(v ?? "").trim();
}
function up(v) {
  return t(v).toUpperCase();
}
function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}

async function nextConversionNo(companyId, companyCode) {
  return nextUniqueSalesDocNumber({
    companyId,
    companyCode,
    docKey: "ARTICLE_STOCK_CONVERSION",
    model: ArticleStockConversion,
    field: "conversionNo",
  });
}

async function findActiveApprovedMapping(companyId, sourceArticle, targetArticle) {
  const now = new Date();
  return ArticleEquivalenceMapping.findOne({
    companyId,
    sourceArticle: up(sourceArticle),
    targetArticle: up(targetArticle),
    isActive: true,
    approvalStatus: "APPROVED",
    $and: [
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: now } }] },
    ],
  }).lean();
}

function respondConflict(res, err) {
  const status = err.statusCode || 409;
  return res.status(status).json({
    message: err.message,
    code: err.code || ARTICLE_CONVERSION_POSTING_CONFLICT,
    article: err.article || err.details?.article || null,
    requestedQty: err.requestedQty ?? err.details?.requestedQty ?? null,
    availableQty: err.availableQty ?? err.details?.availableQty ?? null,
    details: err.details || null,
  });
}

export async function listArticleConversions(req, res) {
  try {
    const q = t(req.query.q);
    const status = up(req.query.status);
    const filter = withCompany(req, {});
    if (status) filter.status = status;
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { conversionNo: re },
        { sourceArticle: re },
        { targetArticle: re },
        { remarks: re },
        { reasonCode: re },
        { "lotLayers.grnNo": re },
        { "lotLayers.poNo": re },
        { "lotLayers.boeNumber": re },
        { "lotLayers.blNumber": re },
        { "lotLayers.supplierInvoiceNumber": re },
      ];
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const [items, total] = await Promise.all([
      ArticleStockConversion.find(filter)
        .sort({ conversionDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ArticleStockConversion.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getArticleConversion(req, res) {
  try {
    const idOrNo = t(req.params.id);
    const filter = mongoose.Types.ObjectId.isValid(idOrNo)
      ? withCompany(req, { $or: [{ _id: idOrNo }, { conversionNo: up(idOrNo) }] })
      : withCompany(req, { conversionNo: up(idOrNo) });
    const doc = await ArticleStockConversion.findOne(filter).lean();
    if (!doc) return res.status(404).json({ message: "Conversion not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getConversionArticleContext(req, res) {
  try {
    const article = up(req.query.article);
    const warehouse = up(req.query.warehouse) || "MAIN";
    if (!article) return res.status(400).json({ message: "article required" });
    const item = await ItemMaster.findOne(
      withCompany(req, { $or: [{ article: article }, { itemCode: article }, { articleNumber: article }] })
    ).lean();
    if (!item) return res.status(404).json({ message: `Article ${article} not found` });
    const resolved = item;
    const stock = await stockService.getStockBalance({
      companyId: req.companyId,
      article,
      warehouse,
    });
    const customsLots = await CustomsLotItem.find({
      companyId: req.companyId,
      articleNumber: article,
      qtyAvailable: { $gt: 0 },
      status: { $nin: ["CANCELLED"] },
    })
      .sort({ receivedDate: 1, createdAt: 1 })
      .limit(50)
      .lean();
    res.json({
      article,
      description: resolved?.itemName || resolved?.description || "",
      uom: resolved?.uom || resolved?.unit || "PCS",
      isActive: String(resolved?.status || "Active") !== "Inactive",
      warehouse,
      onHandQty: stock.onHandQty,
      availableQty: stock.availableQty,
      reservedQty: stock.reservedQty,
      packedQty: stock.packedQty,
      unitCost: Number(resolved?.avgCost ?? stock.raw?.avgCost ?? stock.raw?.unitCost ?? 0) || 0,
      currency: stock.raw?.currency || resolved?.currency || "USD",
      customsLots: customsLots.map((c) => ({
        _id: c._id,
        customsLotRef: c.customsLotRef,
        grnNo: c.grnNo,
        boeNumber: c.boeNumber,
        blNumber: c.blNumber,
        qtyAvailable: c.qtyAvailable,
        unitPrice: c.unitPrice,
        currency: c.currency,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createArticleConversionDraft(req, res) {
  try {
    const sourceArticle = up(req.body.sourceArticle);
    const targetArticle = up(req.body.targetArticle);
    const warehouse = up(req.body.warehouse) || "MAIN";
    const sourceQty = Number(req.body.sourceQty) || 0;
    const conversionRatio = Number(req.body.conversionRatio) || 1;
    const targetQty = Number(req.body.targetQty) || sourceQty * conversionRatio;
    const reasonCode = up(req.body.reasonCode).replace(/\s+/g, "_");
    const remarks = t(req.body.remarks);

    if (!sourceArticle || !targetArticle) {
      return res.status(400).json({ message: "Source and target articles are required" });
    }
    if (sourceArticle === targetArticle) {
      return respondConflict(
        res,
        articleConversionConflictError(
          ARTICLE_CONVERSION_SAME_ARTICLE,
          "Source Article and Target Article must be different."
        )
      );
    }
    if (!(sourceQty > 0) || !(targetQty > 0) || !(conversionRatio > 0)) {
      return res.status(400).json({ message: "Quantity and conversion ratio must be greater than zero" });
    }
    if (!remarks) return res.status(400).json({ message: "Detailed remarks are mandatory" });
    if (!ARTICLE_CONVERSION_REASON_CODES.includes(reasonCode)) {
      return res.status(400).json({ message: "Invalid reason code", allowed: ARTICLE_CONVERSION_REASON_CODES });
    }

    const [sourceItem, targetItem] = await Promise.all([
      ItemMaster.findOne(
        withCompany(req, {
          $or: [{ article: sourceArticle }, { itemCode: sourceArticle }],
        })
      ).lean(),
      ItemMaster.findOne(
        withCompany(req, {
          $or: [{ article: targetArticle }, { itemCode: targetArticle }],
        })
      ).lean(),
    ]);
    if (!sourceItem) return res.status(400).json({ message: `Source Article ${sourceArticle} not found` });
    if (!targetItem) return res.status(400).json({ message: `Target Article ${targetArticle} not found` });
    if (String(sourceItem.status) === "Inactive" || String(targetItem.status) === "Inactive") {
      return res.status(400).json({ message: "Source and Target articles must be active" });
    }

    const sourceUom = up(req.body.sourceUom || sourceItem.uom || sourceItem.unit || "PCS");
    const targetUom = up(req.body.targetUom || targetItem.uom || targetItem.unit || "PCS");
    const mapping = await findActiveApprovedMapping(req.companyId, sourceArticle, targetArticle);
    if (sourceUom !== targetUom && !(mapping && Number(mapping.conversionRatio) > 0)) {
      return respondConflict(
        res,
        articleConversionConflictError(
          ARTICLE_CONVERSION_UOM_MISMATCH,
          "Source and Target UOM must match unless an approved conversion ratio mapping exists."
        )
      );
    }

    const loc = await StockLocation.findOne(withCompany(req, { locationCode: warehouse, isActive: true })).lean();
    if (!loc) {
      // Allow MAIN even if locations master incomplete
      if (warehouse !== "MAIN") {
        return res.status(400).json({ message: `Invalid or inactive warehouse ${warehouse}` });
      }
    }

    const stock = await stockService.getStockBalance({
      companyId: req.companyId,
      article: sourceArticle,
      warehouse,
    });
    if (sourceQty > (Number(stock.availableQty) || 0) + 1e-6) {
      return respondConflict(
        res,
        articleConversionConflictError(
          ARTICLE_CONVERSION_STOCK_SHORTAGE,
          `Article conversion cannot be saved because source stock is insufficient.`,
          {
            article: sourceArticle,
            requestedQty: sourceQty,
            availableQty: stock.availableQty,
          }
        )
      );
    }

    const unitCost =
      Number(req.body.sourceUnitCost) ||
      Number(stock.raw?.avgCost ?? stock.raw?.unitCost ?? 0) ||
      0;
    const targetUnitCost = conversionRatio > 0 ? unitCost / conversionRatio : unitCost;
    const sourceStockValue = unitCost * sourceQty;
    const targetStockValue = targetUnitCost * targetQty;
    const exchangeRate = Number(req.body.exchangeRate) || 1;
    const requiresAdminApproval = !mapping;
    const conversionNo =
      up(req.body.conversionNo) || (await nextConversionNo(req.companyId, req.companyCode));

    const doc = await ArticleStockConversion.create({
      companyId: req.companyId,
      branchId: req.body.branchId || null,
      conversionNo,
      conversionDate: req.body.conversionDate || new Date(),
      warehouse,
      sourceLocation: up(req.body.sourceLocation) || warehouse,
      targetLocation: up(req.body.targetLocation) || warehouse,
      sourceArticle,
      sourceDescription: t(req.body.sourceDescription) || sourceItem.itemName || sourceItem.description || "",
      sourceUom,
      targetArticle,
      targetDescription: t(req.body.targetDescription) || targetItem.itemName || targetItem.description || "",
      targetUom,
      sourceQty,
      targetQty,
      conversionRatio,
      reasonCode,
      remarks,
      selectedCustomsLotItemId: req.body.selectedCustomsLotItemId || null,
      sourceUnitCost: unitCost,
      targetUnitCost,
      currency: up(req.body.currency) || stock.raw?.currency || "USD",
      exchangeRate,
      sourceStockValue,
      targetStockValue,
      aedValue: sourceStockValue * exchangeRate,
      equivalenceMappingId: mapping?._id || null,
      mappingApproved: Boolean(mapping),
      requiresAdminApproval,
      approvalStatus: mapping ? "NOT_REQUIRED" : "PENDING",
      attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
      status: "DRAFT",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });

    await writeAudit(req, {
      action: "CREATE",
      module: "STORE",
      entityType: "ARTICLE_STOCK_CONVERSION",
      entityId: doc._id,
      documentNo: doc.conversionNo,
      description: `Article conversion ${doc.conversionNo} draft ${sourceArticle} → ${targetArticle}`,
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Conversion number already exists", code: "DUPLICATE_CONVERSION_NO" });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function approveArticleConversion(req, res) {
  try {
    if (!(await hasPermission(req, "ARTICLE_CONVERSION", "approve")) && !(await hasPermission(req, "ARTICLE_CONVERSION", "admin"))) {
      return res.status(403).json({ message: "Approval permission required" });
    }
    const doc = await ArticleStockConversion.findOne(
      withCompany(req, { _id: req.params.id, status: "DRAFT" })
    );
    if (!doc) return res.status(404).json({ message: "Draft conversion not found" });
    doc.approvalStatus = "APPROVED";
    doc.approvedBy = req.user?.email || "";
    doc.approvedAt = new Date();
    doc.requiresAdminApproval = false;
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeAudit(req, {
      action: "APPROVE",
      module: "STORE",
      entityType: "ARTICLE_STOCK_CONVERSION",
      entityId: doc._id,
      documentNo: doc.conversionNo,
      description: `Article conversion ${doc.conversionNo} approved for unmapped posting`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postArticleConversion(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    let postedDoc = null;
    await session.withTransaction(async () => {
      const id = req.params.id;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw articleConversionConflictError(ARTICLE_CONVERSION_POSTING_CONFLICT, "Invalid conversion id", null, 400);
      }
      const claimed = await ArticleStockConversion.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        { $set: { status: "POSTING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await ArticleStockConversion.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw articleConversionConflictError(ARTICLE_CONVERSION_POSTING_CONFLICT, "Conversion not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "POSTING") {
          throw articleConversionConflictError(ARTICLE_CONVERSION_POST_IN_PROGRESS, "Conversion post already in progress");
        }
        if (st === "POSTED") {
          idempotent = true;
          postedDoc = existing;
          return;
        }
        if (st === "REVERSED" || st === "CANCELLED") {
          throw articleConversionConflictError(
            ARTICLE_CONVERSION_POSTING_CONFLICT,
            `Cannot post conversion in status ${st}`
          );
        }
        throw articleConversionConflictError(
          ARTICLE_CONVERSION_POSTING_CONFLICT,
          `Only DRAFT conversion can be posted (status ${st})`
        );
      }

      // Mapping / approval gate
      const mapping = await findActiveApprovedMapping(
        req.companyId,
        claimed.sourceArticle,
        claimed.targetArticle
      );
      const approved =
        Boolean(mapping) ||
        String(claimed.approvalStatus).toUpperCase() === "APPROVED";
      if (!approved) {
        const canAdmin =
          (await hasPermission(req, "ARTICLE_CONVERSION", "admin")) ||
          (await hasPermission(req, "ARTICLE_CONVERSION", "approve")) ||
          (await hasPermission(req, "ARTICLE_CONVERSION", "post"));
        if (!canAdmin) {
          throw articleConversionConflictError(
            ARTICLE_CONVERSION_MAPPING_REQUIRED,
            "No approved Article equivalence mapping exists. Admin approval is required before posting.",
            { sourceArticle: claimed.sourceArticle, targetArticle: claimed.targetArticle }
          );
        }
        // Admin posting without mapping — do not auto-create mapping
        claimed.approvalStatus = "APPROVED";
        claimed.approvedBy = claimed.approvedBy || req.user?.email || "";
        claimed.approvedAt = claimed.approvedAt || new Date();
        claimed.requiresAdminApproval = false;
      } else if (mapping) {
        claimed.equivalenceMappingId = mapping._id;
        claimed.mappingApproved = true;
        claimed.requiresAdminApproval = false;
        claimed.approvalStatus = "NOT_REQUIRED";
      }

      // Live stock recheck
      const live = await stockService.getStockBalance({
        companyId: req.companyId,
        article: claimed.sourceArticle,
        warehouse: claimed.warehouse,
        session,
      });
      const available = Number(live.availableQty) || 0;
      if (claimed.sourceQty > available + 1e-6) {
        throw articleConversionConflictError(
          ARTICLE_CONVERSION_STOCK_SHORTAGE,
          "Article conversion cannot be posted because source stock is insufficient.",
          {
            article: claimed.sourceArticle,
            requestedQty: claimed.sourceQty,
            availableQty: available,
          }
        );
      }

      const unitCost =
        Number(claimed.sourceUnitCost) ||
        Number(live.raw?.avgCost ?? live.raw?.unitCost ?? 0) ||
        0;
      const postingOperationId = crypto.randomUUID();
      const outEffectKey = buildArticleConversionEffectKey({
        companyId: req.companyId,
        conversionId: claimed._id,
        movementType: "ARTICLE_CONVERSION_OUT",
        warehouse: claimed.warehouse,
        article: claimed.sourceArticle,
      });
      const inEffectKey = buildArticleConversionEffectKey({
        companyId: req.companyId,
        conversionId: claimed._id,
        movementType: "ARTICLE_CONVERSION_IN",
        warehouse: claimed.warehouse,
        article: claimed.targetArticle,
      });

      let customsLayers = [];
      try {
        customsLayers = await selectCustomsLayersForConversion({
          companyId: req.companyId,
          sourceArticle: claimed.sourceArticle,
          qty: claimed.sourceQty,
          selectedCustomsLotItemId: claimed.selectedCustomsLotItemId,
          session,
        });
      } catch (customsErr) {
        // Customs may be disabled / no lots — allow ERP-only conversion when no customs stock exists
        if (customsErr.code === "ARTICLE_CONVERSION_CUSTOMS_SHORTAGE") {
          const anyCustoms = await CustomsLotItem.exists({
            companyId: req.companyId,
            articleNumber: claimed.sourceArticle,
            qtyAvailable: { $gt: 0 },
          }).session(session);
          if (anyCustoms) throw customsErr;
          customsLayers = [];
        } else {
          throw customsErr;
        }
      }

      let lotLayers = [];
      if (customsLayers.length) {
        lotLayers = await retargetCustomsLotsForConversion({
          session,
          companyId: req.companyId,
          companyCode: req.companyCode || "",
          sourceArticle: claimed.sourceArticle,
          targetArticle: claimed.targetArticle,
          targetDescription: claimed.targetDescription,
          conversionNo: claimed.conversionNo,
          conversionDocumentId: claimed._id,
          layers: customsLayers,
          createdBy: req.user?.email || "",
        });
      }

      let ledger;
      try {
        ledger = await stockService.articleConversion({
          session,
          companyId: req.companyId,
          sourceArticle: claimed.sourceArticle,
          targetArticle: claimed.targetArticle,
          warehouse: claimed.warehouse,
          sourceQty: claimed.sourceQty,
          targetQty: claimed.targetQty,
          unitCost,
          currency: claimed.currency,
          referenceType: "ARTICLE_STOCK_CONVERSION",
          referenceNo: claimed.conversionNo,
          remarks: `${claimed.reasonCode}: ${claimed.remarks}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
          transactionDate: claimed.conversionDate,
          sourceDocumentType: ARTICLE_CONVERSION_SOURCE_DOCUMENT_TYPE,
          sourceDocumentId: claimed._id,
          postingOperationId,
          outEffectKey,
          inEffectKey,
          locationFrom: claimed.sourceLocation || claimed.warehouse,
          locationTo: claimed.targetLocation || claimed.warehouse,
        });
      } catch (stockErr) {
        if (isArticleConversionEffectDuplicateKeyError(stockErr)) {
          throw articleConversionConflictError(
            ARTICLE_CONVERSION_ALREADY_POSTED,
            "Conversion stock effect already exists",
            { conversionId: String(claimed._id) }
          );
        }
        if (stockErr.code === ARTICLE_CONVERSION_STOCK_SHORTAGE) {
          throw articleConversionConflictError(
            ARTICLE_CONVERSION_STOCK_SHORTAGE,
            "Article conversion cannot be posted because source stock is insufficient.",
            {
              article: stockErr.article || claimed.sourceArticle,
              requestedQty: stockErr.requestedQty || claimed.sourceQty,
              availableQty: available,
            }
          );
        }
        throw stockErr;
      }

      const ratio = Number(claimed.conversionRatio) || 1;
      claimed.sourceUnitCost = unitCost;
      claimed.targetUnitCost = ratio > 0 ? unitCost / ratio : unitCost;
      claimed.sourceStockValue = unitCost * Number(claimed.sourceQty);
      claimed.targetStockValue = claimed.targetUnitCost * Number(claimed.targetQty);
      claimed.aedValue = claimed.sourceStockValue * (Number(claimed.exchangeRate) || 1);
      claimed.lotLayers = lotLayers;
      claimed.outLedgerId = ledger.out?._id || null;
      claimed.inLedgerId = ledger.in?._id || null;
      claimed.postingOperationId = postingOperationId;
      claimed.status = "POSTED";
      claimed.postedAt = new Date();
      claimed.postedBy = req.user?.email || "";
      claimed.updatedBy = req.user?.email || "";
      await claimed.save({ session });
      postedDoc = claimed;

      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "ARTICLE_STOCK_CONVERSION",
        entityId: claimed._id,
        documentNo: claimed.conversionNo,
        description: `Article conversion ${claimed.conversionNo} posted: ${claimed.sourceArticle} → ${claimed.targetArticle}`,
        metadata: { postingOperationId, sourceQty: claimed.sourceQty, targetQty: claimed.targetQty },
      });
    });

    if (idempotent) {
      return res.status(200).json({
        success: true,
        code: ARTICLE_CONVERSION_ALREADY_POSTED,
        alreadyPosted: true,
        conversion: postedDoc,
      });
    }
    res.json({ success: true, conversion: postedDoc });
  } catch (err) {
    if (
      err?.code === ARTICLE_CONVERSION_STOCK_SHORTAGE ||
      err?.code === ARTICLE_CONVERSION_MAPPING_REQUIRED ||
      err?.code === ARTICLE_CONVERSION_ALREADY_POSTED ||
      err?.code === ARTICLE_CONVERSION_POST_IN_PROGRESS ||
      err?.code === ARTICLE_CONVERSION_POSTING_CONFLICT ||
      err?.code === "ARTICLE_CONVERSION_CUSTOMS_SHORTAGE"
    ) {
      return respondConflict(res, err);
    }
    res.status(400).json({ message: err.message, code: err.code || null });
  } finally {
    session.endSession();
  }
}

export async function reverseArticleConversionDoc(req, res) {
  const session = await mongoose.startSession();
  try {
    const reason = t(req.body?.reason || req.body?.reversalReason);
    if (!reason) return res.status(400).json({ message: "Reversal reason is mandatory" });
    let idempotent = false;
    let docOut = null;
    await session.withTransaction(async () => {
      const id = req.params.id;
      const claimed = await ArticleStockConversion.findOneAndUpdate(
        withCompany(req, { _id: id, status: "POSTED" }),
        { $set: { status: "REVERSING", updatedBy: req.user?.email || "" } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await ArticleStockConversion.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw articleConversionConflictError(ARTICLE_CONVERSION_POSTING_CONFLICT, "Conversion not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "REVERSING") {
          throw articleConversionConflictError(ARTICLE_CONVERSION_POST_IN_PROGRESS, "Reversal already in progress");
        }
        if (st === "REVERSED") {
          idempotent = true;
          docOut = existing;
          return;
        }
        throw articleConversionConflictError(
          ARTICLE_CONVERSION_POSTING_CONFLICT,
          `Only POSTED conversion can be reversed (status ${st})`
        );
      }

      const liveTarget = await stockService.getStockBalance({
        companyId: req.companyId,
        article: claimed.targetArticle,
        warehouse: claimed.warehouse,
        session,
      });
      if (claimed.targetQty > (Number(liveTarget.availableQty) || 0) + 1e-6) {
        throw articleConversionConflictError(
          ARTICLE_CONVERSION_REVERSAL_BLOCKED,
          `Conversion cannot be reversed because Target Article ${claimed.targetArticle} stock is no longer fully available (allocated, packed, or consumed).`,
          {
            article: claimed.targetArticle,
            requestedQty: claimed.targetQty,
            availableQty: liveTarget.availableQty,
          }
        );
      }

      if (claimed.lotLayers?.length) {
        await reverseCustomsLotsForConversion({
          session,
          companyId: req.companyId,
          companyCode: req.companyCode || "",
          conversionNo: claimed.conversionNo,
          conversionDocumentId: claimed._id,
          lotLayers: claimed.lotLayers,
          createdBy: req.user?.email || "",
        });
      }

      const cancellationOperationId = crypto.randomUUID();
      const outEffectKey = buildArticleConversionReversalEffectKey(
        buildArticleConversionEffectKey({
          companyId: req.companyId,
          conversionId: claimed._id,
          movementType: "ARTICLE_CONVERSION_IN",
          warehouse: claimed.warehouse,
          article: claimed.targetArticle,
        })
      );
      const inEffectKey = buildArticleConversionReversalEffectKey(
        buildArticleConversionEffectKey({
          companyId: req.companyId,
          conversionId: claimed._id,
          movementType: "ARTICLE_CONVERSION_OUT",
          warehouse: claimed.warehouse,
          article: claimed.sourceArticle,
        })
      );

      const ledger = await stockService.reverseArticleConversion({
        session,
        companyId: req.companyId,
        sourceArticle: claimed.sourceArticle,
        targetArticle: claimed.targetArticle,
        warehouse: claimed.warehouse,
        sourceQty: claimed.sourceQty,
        targetQty: claimed.targetQty,
        unitCost: claimed.sourceUnitCost,
        currency: claimed.currency,
        referenceType: "ARTICLE_STOCK_CONVERSION",
        referenceNo: claimed.conversionNo,
        remarks: `REVERSAL: ${reason}`,
        createdBy: req.user?.email || "",
        sourceModule: "STORE",
        sourceDocumentType: ARTICLE_CONVERSION_SOURCE_DOCUMENT_TYPE,
        sourceDocumentId: claimed._id,
        cancellationOperationId,
        outEffectKey,
        inEffectKey,
        originalOutEffectKey: buildArticleConversionEffectKey({
          companyId: req.companyId,
          conversionId: claimed._id,
          movementType: "ARTICLE_CONVERSION_IN",
          warehouse: claimed.warehouse,
          article: claimed.targetArticle,
        }),
        originalInEffectKey: buildArticleConversionEffectKey({
          companyId: req.companyId,
          conversionId: claimed._id,
          movementType: "ARTICLE_CONVERSION_OUT",
          warehouse: claimed.warehouse,
          article: claimed.sourceArticle,
        }),
        reversedFromOutLedgerId: claimed.inLedgerId,
        reversedFromInLedgerId: claimed.outLedgerId,
        locationFrom: claimed.targetLocation || claimed.warehouse,
        locationTo: claimed.sourceLocation || claimed.warehouse,
      });

      claimed.status = "REVERSED";
      claimed.reversedAt = new Date();
      claimed.reversedBy = req.user?.email || "";
      claimed.reversalReason = reason;
      claimed.reversalOperationId = cancellationOperationId;
      claimed.reversalOutLedgerId = ledger.out?._id || null;
      claimed.reversalInLedgerId = ledger.in?._id || null;
      claimed.updatedBy = req.user?.email || "";
      await claimed.save({ session });
      docOut = claimed;

      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "ARTICLE_STOCK_CONVERSION",
        entityId: claimed._id,
        documentNo: claimed.conversionNo,
        description: `Article conversion ${claimed.conversionNo} reversed`,
        metadata: { reason, cancellationOperationId },
      });
    });

    if (idempotent) {
      return res.json({ success: true, alreadyReversed: true, code: ARTICLE_CONVERSION_ALREADY_REVERSED, conversion: docOut });
    }
    res.json({ success: true, conversion: docOut });
  } catch (err) {
    if (
      err?.code === ARTICLE_CONVERSION_REVERSAL_BLOCKED ||
      err?.code === ARTICLE_CONVERSION_POSTING_CONFLICT ||
      err?.code === ARTICLE_CONVERSION_POST_IN_PROGRESS ||
      err?.code === ARTICLE_CONVERSION_ALREADY_REVERSED
    ) {
      return respondConflict(res, err);
    }
    res.status(400).json({ message: err.message, code: err.code || null });
  } finally {
    session.endSession();
  }
}

export async function cancelArticleConversionDraft(req, res) {
  try {
    const doc = await ArticleStockConversion.findOneAndUpdate(
      withCompany(req, { _id: req.params.id, status: "DRAFT" }),
      {
        $set: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledBy: req.user?.email || "",
          cancellationReason: t(req.body?.reason),
          updatedBy: req.user?.email || "",
        },
      },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Draft conversion not found or already processed" });
    await writeAudit(req, {
      action: "CANCEL",
      module: "STORE",
      entityType: "ARTICLE_STOCK_CONVERSION",
      entityId: doc._id,
      documentNo: doc.conversionNo,
      description: `Article conversion ${doc.conversionNo} draft cancelled`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/* ---------- Equivalence mapping CRUD ---------- */

export async function listEquivalenceMappings(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.active === "true") filter.isActive = true;
    if (req.query.approvalStatus) filter.approvalStatus = up(req.query.approvalStatus);
    const items = await ArticleEquivalenceMapping.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createEquivalenceMapping(req, res) {
  try {
    const sourceArticle = up(req.body.sourceArticle);
    const targetArticle = up(req.body.targetArticle);
    if (!sourceArticle || !targetArticle || sourceArticle === targetArticle) {
      return res.status(400).json({ message: "Distinct source and target articles required" });
    }
    const row = await ArticleEquivalenceMapping.create({
      companyId: req.companyId,
      sourceArticle,
      targetArticle,
      relationshipType: up(req.body.relationshipType) || "EQUIVALENT",
      conversionRatio: Number(req.body.conversionRatio) || 1,
      effectiveFrom: req.body.effectiveFrom || new Date(),
      effectiveTo: req.body.effectiveTo || null,
      remarks: t(req.body.remarks),
      supportingDocument: t(req.body.supportingDocument),
      approvalStatus: "PENDING",
      isActive: true,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: "An active approved mapping already exists for this source/target pair",
        code: "DUPLICATE_EQUIVALENCE_MAPPING",
      });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function approveEquivalenceMapping(req, res) {
  try {
    if (!(await hasPermission(req, "ARTICLE_CONVERSION", "approve")) && !(await hasPermission(req, "ARTICLE_CONVERSION", "admin"))) {
      return res.status(403).json({ message: "Approval permission required" });
    }
    const row = await ArticleEquivalenceMapping.findOne(withCompany(req, { _id: req.params.id }));
    if (!row) return res.status(404).json({ message: "Mapping not found" });
    row.approvalStatus = "APPROVED";
    row.approvedBy = req.user?.email || "";
    row.approvedAt = new Date();
    row.isActive = true;
    row.updatedBy = req.user?.email || "";
    await row.save();
    res.json(row);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: "An active approved mapping already exists for this source/target pair",
        code: "DUPLICATE_EQUIVALENCE_MAPPING",
      });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function deactivateEquivalenceMapping(req, res) {
  try {
    const row = await ArticleEquivalenceMapping.findOneAndUpdate(
      withCompany(req, { _id: req.params.id }),
      {
        $set: {
          isActive: false,
          approvalStatus: "INACTIVE",
          updatedBy: req.user?.email || "",
        },
      },
      { new: true }
    );
    if (!row) return res.status(404).json({ message: "Mapping not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function articleConversionMeta(req, res) {
  res.json({
    reasonCodes: ARTICLE_CONVERSION_REASON_CODES,
    statuses: ["DRAFT", "POSTED", "REVERSED", "CANCELLED"],
    relationshipTypes: [
      "EQUIVALENT",
      "SUPERSEDED_BY",
      "SUPPLIER_TO_OEM",
      "CUSTOMER_REFERENCE",
      "REPACKED_AS",
      "OTHER",
    ],
  });
}
