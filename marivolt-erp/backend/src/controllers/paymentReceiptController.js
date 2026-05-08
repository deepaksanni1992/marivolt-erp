import mongoose from "mongoose";
import PaymentReceipt from "../models/PaymentReceipt.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import Customer from "../models/Customer.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import CashBankEntry from "../models/CashBankEntry.js";
import JournalEntry from "../models/JournalEntry.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";
import { buildDatedS3Key, getSignedFileUrl, uploadFileToS3 } from "../services/s3UploadService.js";
import { writeAudit } from "../services/auditService.js";
import {
  postPaymentReceiptReceivable,
  reversePaymentReceiptReceivable,
} from "../services/customerReceivableService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PAYMENT_SLIP_FOLDER = String(process.env.AWS_S3_PAYMENT_SLIP_FOLDER || "payment-slips").trim() || "payment-slips";
const CANCEL_ALLOWED_ROLES = new Set(["super_admin", "company_admin", "admin", "accounts_logistics"]);
const OVERRIDE_ALLOWED_ROLES = new Set(["super_admin", "company_admin", "admin"]);
const SOURCE_TYPE = {
  PROFORMA: "PROFORMA_INVOICE",
  SALES: "SALES_INVOICE",
  ADVANCE: "ADVANCE_PAYMENT",
  MULTIPLE: "MULTIPLE_INVOICE",
};

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function roleOf(req) {
  return String(req.user?.role || "").trim().toLowerCase();
}

function canCancel(req) {
  return CANCEL_ALLOWED_ROLES.has(roleOf(req));
}

function canOverrideAmount(req) {
  return OVERRIDE_ALLOWED_ROLES.has(roleOf(req));
}

function sanitizeReference(v = "") {
  return String(v || "").trim();
}

function validateSlipFile(file) {
  if (!file) return null;
  const mime = String(file.mimetype || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error("Unsupported file type. Allowed: PDF, JPG, JPEG, PNG.");
  }
  if (Number(file.size || 0) > MAX_FILE_SIZE) {
    throw new Error("Payment slip exceeds 5 MB.");
  }
}

async function resolveCustomerId(req, customerName = "") {
  const name = String(customerName || "").trim();
  if (!name) return null;
  const customer = await Customer.findOne(withCompany(req, { name: new RegExp(`^${name}$`, "i") }))
    .select("_id")
    .lean();
  return customer?._id || null;
}

async function recalcProformaPaymentState(req, proformaId) {
  const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: proformaId }));
  if (!proforma) throw new Error("Linked proforma not found");

  // Sum across all non-cancelled receipts whose allocations target this proforma.
  // Receipt statuses for active receipts are POSTED, PARTIALLY_ALLOCATED, FULLY_ALLOCATED.
  // We use the allocation amount (not amountReceived) so multi-allocation receipts are handled correctly.
  const postedReceipts = await PaymentReceipt.find(
    withCompany(req, {
      status: { $ne: "CANCELLED" },
      "allocations.targetType": SOURCE_TYPE.PROFORMA,
      "allocations.targetId": proforma._id,
    }),
    { allocations: 1 }
  ).lean();
  let totalReceived = 0;
  for (const r of postedReceipts) {
    for (const a of r.allocations || []) {
      if (
        String(a.targetType || "") === SOURCE_TYPE.PROFORMA &&
        String(a.targetId || "") === String(proforma._id)
      ) {
        totalReceived += Math.max(0, Number(a.allocatedAmount) || 0);
      }
    }
  }
  totalReceived = Math.max(0, totalReceived);
  const grandTotal = Math.max(0, Number(proforma.grandTotal) || 0);
  const balanceAmount = Math.max(0, grandTotal - totalReceived);

  let paymentStatus = "UNPAID";
  if (totalReceived > 0 && totalReceived < grandTotal) paymentStatus = "PARTIALLY_PAID";
  if (totalReceived >= grandTotal && grandTotal > 0) paymentStatus = "PAID";

  proforma.totalReceivedAmount = totalReceived;
  proforma.balanceAmount = balanceAmount;
  proforma.paymentStatus = paymentStatus;

  if (paymentStatus === "PAID") {
    proforma.status = "PAID_PENDING_SHIPMENT";
    proforma.paidAt = new Date();
    proforma.paidBy = req.user?.email || "";
  } else if (String(proforma.status || "").toUpperCase() === "PAID_PENDING_SHIPMENT") {
    // If payments are reversed/cancelled and balance opens, move back to ISSUED.
    proforma.status = "ISSUED";
    proforma.paidAt = null;
    proforma.paidBy = "";
  }

  proforma.updatedBy = req.user?.email || "";
  await proforma.save();
  return proforma;
}

async function recalcSalesInvoicePaymentState(req, salesInvoiceId) {
  const invoice = await SalesInvoice.findOne(withCompany(req, { _id: salesInvoiceId }));
  if (!invoice) return null;
  const postedReceipts = await PaymentReceipt.find(
    withCompany(req, {
      status: { $ne: "CANCELLED" },
      "allocations.targetType": SOURCE_TYPE.SALES,
      "allocations.targetId": invoice._id,
    }),
    { allocations: 1 }
  ).lean();
  let paidAmount = 0;
  for (const r of postedReceipts) {
    for (const a of r.allocations || []) {
      if (String(a.targetType || "") === SOURCE_TYPE.SALES && String(a.targetId || "") === String(invoice._id)) {
        paidAmount += Math.max(0, Number(a.allocatedAmount) || 0);
      }
    }
  }
  paidAmount = Math.max(0, paidAmount);
  const total = Math.max(0, Number(invoice.grandTotal) || 0);
  const balance = Math.max(0, total - paidAmount);

  // Phase-8.2 canonical buckets — written even when the invoice is
  // cancelled so the audit history shows the final state.
  invoice.totalReceivedAmount = paidAmount;
  invoice.balanceAmount = balance;
  let paymentStatus = "UNPAID";
  if (paidAmount > 0 && paidAmount < total) paymentStatus = "PARTIAL";
  if (paidAmount >= total && total > 0) paymentStatus = "PAID";
  invoice.paymentStatus = paymentStatus;

  if (String(invoice.status || "").toUpperCase() !== "CANCELLED") {
    if (paidAmount <= 0) invoice.status = "ISSUED";
    else if (paidAmount < total) invoice.status = "PARTIALLY_PAID";
    else invoice.status = "PAID";
  }
  invoice.updatedBy = req.user?.email || "";
  await invoice.save();
  return { invoice, paidAmount, balance, paymentStatus };
}

async function createJournalForReceipt(req, receipt, { reverseFromId = null } = {}) {
  const entryNo = await nextSalesDocNumber({
    companyId: req.companyId,
    companyCode: req.companyCode,
    docKey: "PAYMENT_RECEIPT",
    referenceDate: receipt.receiptDate || receipt.receivedDate || new Date(),
  });
  const allocated = Math.max(0, Number(receipt.allocatedAmount) || 0);
  const unallocated = Math.max(0, Number(receipt.unallocatedAmount) || 0);
  const lines = [
    {
      accountId: String(receipt.bankCashAccountId || ""),
      accountName: receipt.bankCashAccountName || receipt.accountName || "Cash/Bank",
      debit: Math.max(0, Number(receipt.amountReceived) || 0),
      credit: 0,
    },
    {
      accountId: "ACC_RECEIVABLE",
      accountName: "Accounts Receivable",
      debit: 0,
      credit: allocated,
    },
  ];
  if (unallocated > 0) {
    lines.push({
      accountId: "ACC_CUSTOMER_ADVANCE",
      accountName: "Customer Advance",
      debit: 0,
      credit: unallocated,
    });
  }
  return JournalEntry.create({
    companyId: req.companyId,
    entryNo,
    entryDate: receipt.receiptDate || receipt.receivedDate || new Date(),
    sourceModule: "Accounts",
    sourceType: reverseFromId ? "Payment Receipt Reversal" : "Payment Receipt",
    sourceId: receipt._id,
    referenceNo: receipt.paymentReference || receipt.receiptNo,
    customerId: receipt.customerId || null,
    currency: receipt.currency || "USD",
    narration: reverseFromId
      ? `Reversal of payment receipt ${receipt.receiptNo}`
      : `Payment receipt ${receipt.receiptNo}`,
    lines,
    status: "POSTED",
    reversedFromEntryId: reverseFromId || null,
    createdBy: req.user?.email || "",
    updatedBy: req.user?.email || "",
  });
}

function normalizeAllocations(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => ({
      targetType: String(a?.targetType || "").trim().toUpperCase(),
      targetId: String(a?.targetId || "").trim(),
      allocatedAmount: Number(a?.allocatedAmount) || 0,
    }))
    .filter((a) => ["PROFORMA_INVOICE", "SALES_INVOICE"].includes(a.targetType) && mongoose.Types.ObjectId.isValid(a.targetId) && a.allocatedAmount > 0);
}

export async function createPaymentReceipt(req, res) {
  try {
    const receiptDateRaw = String(req.body?.receiptDate || req.body?.receivedDate || "").trim();
    if (!receiptDateRaw) return res.status(400).json({ message: "Receipt date is required." });
    const receiptDate = new Date(receiptDateRaw);
    if (Number.isNaN(receiptDate.getTime())) return res.status(400).json({ message: "Invalid receipt date." });

    const amountReceived = Number(req.body?.amountReceived);
    if (!Number.isFinite(amountReceived) || amountReceived <= 0) {
      return res.status(400).json({ message: "Amount received must be greater than 0." });
    }
    const paymentMode = String(req.body?.paymentMode || "").trim().toUpperCase();
    if (!paymentMode) return res.status(400).json({ message: "Payment mode is required." });
    if (!["BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"].includes(paymentMode)) {
      return res.status(400).json({ message: "Invalid payment mode." });
    }

    const bankCashAccountName = String(req.body?.bankCashAccountName || req.body?.accountName || "").trim();
    if (!bankCashAccountName) {
      return res.status(400).json({ message: "Bank or cash account selection is required." });
    }
    if (paymentMode === "BANK_TRANSFER" && !String(req.body?.paymentReference || "").trim()) {
      return res.status(400).json({ message: "Payment reference is required for bank transfer." });
    }

    validateSlipFile(req.file);

    const sourceTypeRaw = String(req.body?.sourceType || "").trim().toUpperCase();
    let sourceType = sourceTypeRaw;
    if (!["PROFORMA_INVOICE", "SALES_INVOICE", "ADVANCE_PAYMENT", "MULTIPLE_INVOICE"].includes(sourceType)) {
      sourceType = SOURCE_TYPE.ADVANCE;
    }
    const proformaInvoiceId = String(req.body?.proformaInvoiceId || "").trim();
    const salesInvoiceId = String(req.body?.salesInvoiceId || "").trim();
    const allocationsInput = normalizeAllocations(req.body?.allocations || []);

    const paymentReference = sanitizeReference(req.body?.paymentReference);

    const allocations = [];
    let linkedProforma = null;
    let linkedSalesInvoice = null;
    let customerName = String(req.body?.customerName || "").trim();
    let autoBalance = Number.MAX_SAFE_INTEGER;

    if (mongoose.Types.ObjectId.isValid(proformaInvoiceId)) {
      linkedProforma = await ProformaInvoice.findOne(withCompany(req, { _id: proformaInvoiceId }));
      if (linkedProforma && String(linkedProforma.status || "").toUpperCase() !== "CANCELLED") {
        customerName = customerName || linkedProforma.customerName || "";
        // Compute balance fresh from totals so we never rely on a stale persisted balanceAmount
        // (default schema value is 0, which would zero-out auto-allocation on first payment).
        const proformaBalanceLive = Math.max(
          0,
          (Number(linkedProforma.grandTotal) || 0) - (Number(linkedProforma.totalReceivedAmount) || 0)
        );
        autoBalance = Math.min(autoBalance, proformaBalanceLive);
      }
    }
    if (mongoose.Types.ObjectId.isValid(salesInvoiceId)) {
      linkedSalesInvoice = await SalesInvoice.findOne(withCompany(req, { _id: salesInvoiceId }));
      if (linkedSalesInvoice && String(linkedSalesInvoice.status || "").toUpperCase() !== "CANCELLED") {
        customerName = customerName || linkedSalesInvoice.customerName || "";
      }
    }
    if (!customerName) return res.status(400).json({ message: "Customer is required." });
    const resolvedCustomerId = (await resolveCustomerId(req, customerName)) || null;
    if (paymentReference) {
      const dup = await PaymentReceipt.findOne(
        withCompany(req, {
          customerName,
          accountName: bankCashAccountName,
          paymentReference,
          status: { $ne: "CANCELLED" },
        })
      ).lean();
      if (dup) {
        return res.status(400).json({ message: "Duplicate payment reference exists for this customer/account." });
      }
    }

    if (allocationsInput.length) {
      for (const a of allocationsInput) {
        if (a.targetType === SOURCE_TYPE.PROFORMA) {
          const p = await ProformaInvoice.findOne(withCompany(req, { _id: a.targetId }));
          if (!p) return res.status(400).json({ message: `Proforma not found for allocation: ${a.targetId}` });
          allocations.push({
            paymentReceiptId: null,
            customerId: resolvedCustomerId,
            targetType: SOURCE_TYPE.PROFORMA,
            targetId: p._id,
            targetNo: p.proformaNo || "",
            invoiceTotal: Number(p.grandTotal) || 0,
            allocatedAmount: a.allocatedAmount,
            currency: String(req.body?.currency || p.currency || "USD").trim().toUpperCase(),
            allocatedAt: receiptDate,
            allocatedBy: req.user?.email || "",
          });
        } else {
          const s = await SalesInvoice.findOne(withCompany(req, { _id: a.targetId }));
          if (!s) return res.status(400).json({ message: `Sales invoice not found for allocation: ${a.targetId}` });
          allocations.push({
            paymentReceiptId: null,
            customerId: resolvedCustomerId,
            targetType: SOURCE_TYPE.SALES,
            targetId: s._id,
            targetNo: s.invoiceNo || "",
            invoiceTotal: Number(s.grandTotal) || 0,
            allocatedAmount: a.allocatedAmount,
            currency: String(req.body?.currency || s.currency || "USD").trim().toUpperCase(),
            allocatedAt: receiptDate,
            allocatedBy: req.user?.email || "",
          });
        }
      }
    } else if (linkedProforma) {
      const proformaBalanceLive = Math.max(
        0,
        (Number(linkedProforma.grandTotal) || 0) - (Number(linkedProforma.totalReceivedAmount) || 0)
      );
      const cap = proformaBalanceLive > 0 ? proformaBalanceLive : Math.max(0, Number(linkedProforma.grandTotal) || 0);
      const alloc = Math.min(amountReceived, cap);
      if (alloc > 0) {
        allocations.push({
          paymentReceiptId: null,
          customerId: resolvedCustomerId,
          targetType: SOURCE_TYPE.PROFORMA,
          targetId: linkedProforma._id,
          targetNo: linkedProforma.proformaNo || "",
          invoiceTotal: Number(linkedProforma.grandTotal) || 0,
          allocatedAmount: alloc,
          currency: String(req.body?.currency || linkedProforma.currency || "USD").trim().toUpperCase(),
          allocatedAt: receiptDate,
          allocatedBy: req.user?.email || "",
        });
      }
    } else if (linkedSalesInvoice) {
      const alloc = Math.min(amountReceived, Math.max(0, Number(linkedSalesInvoice.grandTotal) || 0));
      if (alloc > 0) {
        allocations.push({
          paymentReceiptId: null,
          customerId: resolvedCustomerId,
          targetType: SOURCE_TYPE.SALES,
          targetId: linkedSalesInvoice._id,
          targetNo: linkedSalesInvoice.invoiceNo || "",
          invoiceTotal: Number(linkedSalesInvoice.grandTotal) || 0,
          allocatedAmount: alloc,
          currency: String(req.body?.currency || linkedSalesInvoice.currency || "USD").trim().toUpperCase(),
          allocatedAt: receiptDate,
          allocatedBy: req.user?.email || "",
        });
      }
    }

    const allocatedAmount = allocations.reduce((a, x) => a + (Number(x.allocatedAmount) || 0), 0);
    if (allocatedAmount - amountReceived > 0.0001) {
      return res.status(400).json({ message: "Allocated amount cannot exceed amount received." });
    }
    if (amountReceived > autoBalance && autoBalance !== Number.MAX_SAFE_INTEGER && !canOverrideAmount(req) && req.body?.adminOverride !== true) {
      return res.status(400).json({ message: "Amount received exceeds balance; admin override required." });
    }

    // Phase-8.2 per-document overpayment guard. We compute the live
    // balance for each allocation target (sum of existing non-cancelled
    // allocations + this new allocation) and reject when any document
    // would be overpaid unless the caller opts in explicitly via
    // `allowOverpayment: true`. Admins can bypass via existing
    // `adminOverride`/role permission, mirroring how the other amount
    // override works above.
    const allowOverpayment =
      req.body?.allowOverpayment === true || req.body?.adminOverride === true || canOverrideAmount(req);
    if (!allowOverpayment && allocations.length) {
      const overpaidDocs = [];
      for (const a of allocations) {
        const targetTotal = Math.max(0, Number(a.invoiceTotal) || 0);
        if (!targetTotal) continue;
        // Sum existing non-cancelled allocations for the same target.
        const agg = await PaymentReceipt.aggregate([
          {
            $match: withCompany(req, {
              status: { $ne: "CANCELLED" },
              "allocations.targetType": a.targetType,
              "allocations.targetId": new mongoose.Types.ObjectId(String(a.targetId)),
            }),
          },
          { $unwind: "$allocations" },
          {
            $match: {
              "allocations.targetType": a.targetType,
              "allocations.targetId": new mongoose.Types.ObjectId(String(a.targetId)),
            },
          },
          { $group: { _id: null, total: { $sum: "$allocations.allocatedAmount" } } },
        ]);
        const existing = Math.max(0, Number(agg[0]?.total || 0));
        const projected = existing + (Number(a.allocatedAmount) || 0);
        if (projected - targetTotal > 0.0001) {
          overpaidDocs.push({
            targetType: a.targetType,
            targetNo: a.targetNo || String(a.targetId),
            invoiceTotal: targetTotal,
            existing,
            attempted: a.allocatedAmount,
            wouldBecome: projected,
            overBy: projected - targetTotal,
          });
        }
      }
      if (overpaidDocs.length) {
        return res.status(409).json({
          message: `Overpayment detected for ${overpaidDocs
            .map((d) => `${d.targetNo} (over by ${d.overBy.toFixed(2)})`)
            .join(", ")}. Resubmit with allowOverpayment:true to confirm.`,
          code: "OVERPAYMENT",
          details: overpaidDocs,
        });
      }
    }

    const unallocatedAmount = Math.max(0, amountReceived - allocatedAmount);
    const resolvedStatus = allocatedAmount <= 0 ? "POSTED" : unallocatedAmount > 0 ? "PARTIALLY_ALLOCATED" : "FULLY_ALLOCATED";
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "payment_post",
      documentType: "PAYMENT_RECEIPT",
      documentNo: "",
      customerName,
      amount: amountReceived,
      currency: String(req.body?.currency || linkedProforma?.currency || linkedSalesInvoice?.currency || "USD").trim().toUpperCase(),
      description: `Post payment receipt for ${customerName}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));

    const receiptNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PAYMENT_RECEIPT",
      referenceDate: receiptDate,
    });

    let attachment = null;
    if (req.file) {
      const key = buildDatedS3Key({
        folderName: PAYMENT_SLIP_FOLDER,
        prefix: receiptNo.replace(/[^\w.\-]+/g, "-"),
        originalFileName: req.file.originalname,
      });
      attachment = await uploadFileToS3(req.file, PAYMENT_SLIP_FOLDER, { key });
    }

    const receipt = await PaymentReceipt.create({
      companyId: req.companyId,
      receiptNo,
      receiptDate,
      sourceType,
      proformaInvoiceId: linkedProforma?._id || null,
      proformaInvoiceNo: linkedProforma?.proformaNo || "",
      salesInvoiceId: linkedSalesInvoice?._id || null,
      salesInvoiceNo: linkedSalesInvoice?.invoiceNo || "",
      customerId: resolvedCustomerId,
      customerName,
      receivedDate: receiptDate,
      amountReceived,
      allocatedAmount,
      unallocatedAmount,
      currency: String(req.body?.currency || linkedProforma?.currency || linkedSalesInvoice?.currency || "USD").trim().toUpperCase(),
      paymentMode,
      bankCashAccountId: mongoose.Types.ObjectId.isValid(String(req.body?.bankCashAccountId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.bankCashAccountId))
        : null,
      bankCashAccountName,
      bankAccountId: mongoose.Types.ObjectId.isValid(String(req.body?.bankAccountId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.bankAccountId))
        : null,
      cashAccountId: mongoose.Types.ObjectId.isValid(String(req.body?.cashAccountId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.cashAccountId))
        : null,
      accountName: bankCashAccountName,
      paymentReference,
      remarks: String(req.body?.remarks || ""),
      attachmentProvider: attachment?.provider || "AWS_S3",
      attachmentBucket: attachment?.bucket || "",
      attachmentKey: attachment?.key || "",
      attachmentOriginalName: attachment?.originalName || "",
      attachmentMimeType: attachment?.mimeType || "",
      attachmentSize: Number(attachment?.size || 0),
      attachmentUploadedAt: attachment?.uploadedAt || null,
      allocations,
      status: resolvedStatus,
      postedBy: req.user?.email || "",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    if (allocations.length) {
      receipt.allocations = receipt.allocations.map((a) => ({ ...a.toObject(), paymentReceiptId: receipt._id }));
      await receipt.save();
    }

    const customerEntry = await CustomerLedgerEntry.create({
      companyId: req.companyId,
      entryDate: receiptDate,
      customerName: customerName || "",
      referenceType: "PAYMENT_RECEIPT",
      referenceNumber: paymentReference || receipt.receiptNo,
      sourceModule: "Accounts",
      sourceType: "Payment Receipt",
      sourceId: receipt._id,
      proformaInvoiceId: linkedProforma?._id || null,
      proformaInvoiceNo: linkedProforma?.proformaNo || "",
      customerId: resolvedCustomerId || null,
      debit: 0,
      credit: amountReceived,
      currency: receipt.currency,
      paymentReference,
      narrative: `Payment receipt ${receipt.receiptNo}`,
      attachmentProvider: "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      createdBy: req.user?.email || "",
    });

    const cashBankEntry = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: receiptDate,
      accountName: bankCashAccountName,
      transactionType: "RECEIPT",
      referenceNumber: paymentReference || receipt.receiptNo,
      sourceModule: "Accounts",
      sourceType: "Payment Receipt",
      sourceId: receipt._id,
      proformaInvoiceId: linkedProforma?._id || null,
      proformaInvoiceNo: linkedProforma?.proformaNo || "",
      customerId: resolvedCustomerId || null,
      currency: receipt.currency,
      partyName: customerName || "",
      amount: amountReceived,
      mode: paymentMode,
      paymentReference,
      attachmentProvider: "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      remarks: receipt.remarks || "",
      createdBy: req.user?.email || "",
    });
    const journal = await createJournalForReceipt(req, receipt);
    const receivableLedger = await postPaymentReceiptReceivable({ req, receipt });

    receipt.linkedCustomerLedgerEntryId = customerEntry._id;
    receipt.linkedCashBankEntryId = cashBankEntry._id;
    receipt.journalEntryId = journal._id;
    await receipt.save();

    let updatedProforma = null;
    if (linkedProforma?._id) updatedProforma = await recalcProformaPaymentState(req, linkedProforma._id);
    if (linkedSalesInvoice?._id) await recalcSalesInvoicePaymentState(req, linkedSalesInvoice._id);
    await writeAudit(req, {
      action: "PAYMENT",
      module: "ACCOUNTS",
      entityType: "PAYMENT_RECEIPT",
      entityId: receipt._id,
      documentNo: receipt.receiptNo,
      toStatus: receipt.status,
      description: `Payment receipt ${receipt.receiptNo} created (${amountReceived} ${receipt.currency || "USD"} from ${customerName || "—"})`,
      metadata: {
        proformaInvoiceNo: linkedProforma?.proformaNo || "",
        salesInvoiceNo: linkedSalesInvoice?.invoiceNo || "",
        attachment: receipt.attachmentKey || "",
        allocationCount: allocations.length,
        allowedOverpayment: !!allowOverpayment,
        paymentMode: receipt.paymentMode || "",
        bankCashAccountName: receipt.bankCashAccountName || receipt.accountName || "",
        customerLedgerId: receivableLedger?._id ? String(receivableLedger._id) : "",
      },
    });
    if (receipt.attachmentKey) {
      await writeAudit(req, {
        action: "ATTACHMENT",
        module: "ACCOUNTS",
        entityType: "PAYMENT_RECEIPT",
        entityId: receipt._id,
        documentNo: receipt.receiptNo,
        description: `Attachment uploaded (${receipt.attachmentOriginalName || receipt.attachmentKey})`,
        metadata: {
          mode: "upload",
          attachmentKey: receipt.attachmentKey,
          mimeType: receipt.attachmentMimeType || "",
          size: receipt.attachmentSize || 0,
        },
      });
    }
    res.status(201).json({ receipt, proforma: updatedProforma, journalEntry: journal });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listPaymentReceipts(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [
        { receiptNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { proformaInvoiceNo: new RegExp(q, "i") },
        { paymentReference: new RegExp(q, "i") },
      ];
    }
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.referenceNo) filter.paymentReference = new RegExp(String(req.query.referenceNo).trim(), "i");
    if (req.query.proformaNo) filter.proformaInvoiceNo = new RegExp(String(req.query.proformaNo).trim(), "i");
    if (req.query.invoiceNo) filter.salesInvoiceNo = new RegExp(String(req.query.invoiceNo).trim(), "i");
    if (req.query.paymentMode) filter.paymentMode = String(req.query.paymentMode).trim().toUpperCase();
    if (req.query.bankCashAccountName) filter.bankCashAccountName = new RegExp(String(req.query.bankCashAccountName).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.fromDate || req.query.toDate) {
      filter.receiptDate = {};
      if (req.query.fromDate) filter.receiptDate.$gte = new Date(String(req.query.fromDate));
      if (req.query.toDate) {
        const d = new Date(String(req.query.toDate));
        d.setHours(23, 59, 59, 999);
        filter.receiptDate.$lte = d;
      }
    }
    const [items, total] = await Promise.all([
      PaymentReceipt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PaymentReceipt.countDocuments(filter),
    ]);
    const summary = items.reduce(
      (acc, r) => {
        acc.totalReceived += Math.max(0, Number(r.amountReceived) || 0);
        acc.totalAllocated += Math.max(0, Number(r.allocatedAmount) || 0);
        acc.totalUnallocated += Math.max(0, Number(r.unallocatedAmount) || 0);
        if (String(r.status || "").toUpperCase() === "CANCELLED") acc.cancelledCount += 1;
        return acc;
      },
      { totalReceived: 0, totalAllocated: 0, totalUnallocated: 0, cancelledCount: 0 }
    );
    res.json({ items, total, page, limit, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPaymentReceipt(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PaymentReceipt.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listPaymentReceiptsByProforma(req, res) {
  try {
    const { proformaInvoiceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(proformaInvoiceId)) return res.status(400).json({ message: "Invalid proformaInvoiceId" });
    const items = await PaymentReceipt.find(withCompany(req, { proformaInvoiceId }))
      .sort({ receivedDate: -1, createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listPaymentReceiptsBySalesInvoice(req, res) {
  try {
    const { salesInvoiceId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(salesInvoiceId)) return res.status(400).json({ message: "Invalid salesInvoiceId" });
    const oid = new mongoose.Types.ObjectId(salesInvoiceId);
    const items = await PaymentReceipt.find(
      withCompany(req, {
        $or: [
          { salesInvoiceId: oid },
          { "allocations.targetType": SOURCE_TYPE.SALES, "allocations.targetId": oid },
        ],
      })
    )
      .sort({ receiptDate: -1, receivedDate: -1, createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPaymentReceiptPrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const receipt = await PaymentReceipt.findOne(withCompany(req, { _id: id })).lean();
    if (!receipt) return res.status(404).json({ message: "Not found" });
    const customer = receipt.customerId
      ? await Customer.findOne(withCompany(req, { _id: receipt.customerId })).lean()
      : null;
    const journal = receipt.journalEntryId
      ? await JournalEntry.findOne(withCompany(req, { _id: receipt.journalEntryId })).lean()
      : null;
    res.json({ receipt, customer, journal });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function cancelPaymentReceipt(req, res) {
  try {
    if (!canCancel(req)) return res.status(403).json({ message: "Only Accounts/Admin users can cancel payment receipts." });
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const reason = String(req.body?.reason || req.body?.cancellationReason || "").trim();
    if (!reason) return res.status(400).json({ message: "cancellationReason is required" });

    const receipt = await PaymentReceipt.findOne(withCompany(req, { _id: id }));
    if (!receipt) return res.status(404).json({ message: "Not found" });
    if (String(receipt.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Payment receipt is already cancelled." });
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "payment_cancel",
      documentType: "PAYMENT_RECEIPT",
      documentId: receipt._id,
      documentNo: receipt.receiptNo,
      customerName: receipt.customerName || "",
      amount: receipt.amountReceived || receipt.paymentAmount || 0,
      currency: receipt.currency || "USD",
      description: `Cancel payment receipt ${receipt.receiptNo}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));

    const reverseCustomer = await CustomerLedgerEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      customerName: receipt.customerName || "",
      referenceType: "PROFORMA_PAYMENT_CANCEL",
      referenceNumber: receipt.paymentReference || receipt.receiptNo,
      sourceModule: "Accounts",
      sourceType: "Payment Receipt Reversal",
      sourceId: receipt._id,
      proformaInvoiceId: receipt.proformaInvoiceId || null,
      proformaInvoiceNo: receipt.proformaInvoiceNo || "",
      customerId: receipt.customerId || null,
      debit: Number(receipt.amountReceived) || 0,
      credit: 0,
      currency: receipt.currency || "USD",
      paymentReference: receipt.paymentReference || "",
      narrative: `Reversal of payment receipt ${receipt.receiptNo}`,
      attachmentProvider: receipt.attachmentProvider || "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      reversedFromEntryId: receipt.linkedCustomerLedgerEntryId || null,
      createdBy: req.user?.email || "",
    });
    const receivableLedger = await reversePaymentReceiptReceivable({ req, receipt, reason });

    const reverseCashBank = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      accountName: receipt.bankCashAccountName || receipt.accountName || "Cash",
      transactionType: "PAYMENT",
      referenceNumber: receipt.paymentReference || receipt.receiptNo,
      sourceModule: "Accounts",
      sourceType: "Payment Receipt Reversal",
      sourceId: receipt._id,
      proformaInvoiceId: receipt.proformaInvoiceId || null,
      proformaInvoiceNo: receipt.proformaInvoiceNo || "",
      customerId: receipt.customerId || null,
      currency: receipt.currency || "USD",
      partyName: receipt.customerName || "",
      amount: Number(receipt.amountReceived) || 0,
      mode: receipt.paymentMode || "",
      paymentReference: receipt.paymentReference || "",
      attachmentProvider: receipt.attachmentProvider || "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      remarks: `Reversal of payment receipt ${receipt.receiptNo}`,
      reversedFromEntryId: receipt.linkedCashBankEntryId || null,
      createdBy: req.user?.email || "",
    });
    if (receipt.journalEntryId) {
      const original = await JournalEntry.findOne(withCompany(req, { _id: receipt.journalEntryId }));
      if (original) {
        original.status = "REVERSED";
        original.updatedBy = req.user?.email || "";
        await original.save();
        const reverseJournal = await createJournalForReceipt(req, receipt, { reverseFromId: original._id });
        reverseJournal.lines = (original.lines || []).map((l) => ({
          accountId: l.accountId || "",
          accountName: l.accountName || "",
          debit: Number(l.credit) || 0,
          credit: Number(l.debit) || 0,
        }));
        await reverseJournal.save();
        original.reversedByEntryId = reverseJournal._id;
        await original.save();
      }
    }

    const prevReceiptStatus = String(receipt.status || "");
    receipt.status = "CANCELLED";
    receipt.cancellationReason = reason;
    receipt.cancelledAt = new Date();
    receipt.cancelledBy = req.user?.email || "";
    receipt.cancelReason = reason;
    receipt.updatedBy = req.user?.email || "";
    receipt.linkedReverseCustomerLedgerEntryId = reverseCustomer._id;
    receipt.linkedReverseCashBankEntryId = reverseCashBank._id;
    await receipt.save();

    const updatedProforma = receipt.proformaInvoiceId ? await recalcProformaPaymentState(req, receipt.proformaInvoiceId) : null;
    if (receipt.salesInvoiceId) await recalcSalesInvoicePaymentState(req, receipt.salesInvoiceId);
    await writeAudit(req, {
      action: "PAYMENT",
      module: "ACCOUNTS",
      entityType: "PAYMENT_RECEIPT",
      entityId: receipt._id,
      documentNo: receipt.receiptNo,
      fromStatus: prevReceiptStatus,
      toStatus: "CANCELLED",
      description: `Payment receipt ${receipt.receiptNo} cancelled (${receipt.amountReceived} ${receipt.currency || "USD"})`,
      metadata: {
        reason,
        reverseCustomerLedgerEntryId: String(reverseCustomer._id),
        reverseCashBankEntryId: String(reverseCashBank._id),
        customerLedgerId: receivableLedger?._id ? String(receivableLedger._id) : "",
      },
    });
    res.json({ receipt, proforma: updatedProforma });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getPaymentReceiptAttachmentUrl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const receipt = await PaymentReceipt.findOne(withCompany(req, { _id: id })).lean();
    if (!receipt) return res.status(404).json({ message: "Not found" });
    if (!receipt.attachmentKey) return res.status(404).json({ message: "No attachment found for this receipt." });

    const inline = String(req.query.inline || "").trim() === "1";
    const safeName = String(receipt.attachmentOriginalName || "payment-slip")
      .replace(/[^\x20-\x7E]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 200);
    const disposition = inline ? `inline; filename="${safeName}"` : `attachment; filename="${safeName}"`;
    const signed = await getSignedFileUrl(receipt.attachmentKey, { expiresIn: 300, contentDisposition: disposition });
    await writeAudit(req, {
      action: "ATTACHMENT",
      module: "ACCOUNTS",
      entityType: "PAYMENT_RECEIPT",
      entityId: receipt._id,
      documentNo: receipt.receiptNo,
      description: `Attachment ${inline ? "previewed" : "downloaded"} (${receipt.attachmentOriginalName || receipt.attachmentKey})`,
      metadata: {
        mode: inline ? "preview" : "download",
        attachmentKey: receipt.attachmentKey,
        mimeType: receipt.attachmentMimeType || "",
      },
    });
    res.json({
      url: signed.url,
      expiresIn: signed.expiresIn,
      fileName: receipt.attachmentOriginalName,
      mimeType: receipt.attachmentMimeType,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Could not generate attachment URL" });
  }
}
