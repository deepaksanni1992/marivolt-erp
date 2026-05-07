import mongoose from "mongoose";
import PaymentReceipt from "../models/PaymentReceipt.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import Customer from "../models/Customer.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import CashBankEntry from "../models/CashBankEntry.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";
import { buildDatedS3Key, getSignedFileUrl, uploadFileToS3 } from "../services/s3UploadService.js";

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const PAYMENT_SLIP_FOLDER = String(process.env.AWS_S3_PAYMENT_SLIP_FOLDER || "payment-slips").trim() || "payment-slips";
const CANCEL_ALLOWED_ROLES = new Set(["super_admin", "company_admin", "admin", "accounts_logistics"]);
const OVERRIDE_ALLOWED_ROLES = new Set(["super_admin", "company_admin", "admin"]);

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
  const [proforma, sums] = await Promise.all([
    ProformaInvoice.findOne(withCompany(req, { _id: proformaId })),
    PaymentReceipt.aggregate([
      { $match: withCompany(req, { proformaInvoiceId: new mongoose.Types.ObjectId(String(proformaId)), status: "POSTED" }) },
      { $group: { _id: null, total: { $sum: "$amountReceived" } } },
    ]),
  ]);
  if (!proforma) throw new Error("Linked proforma not found");
  const totalReceived = Math.max(0, Number(sums?.[0]?.total) || 0);
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

export async function createPaymentReceipt(req, res) {
  try {
    const proformaInvoiceId = String(req.body?.proformaInvoiceId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(proformaInvoiceId)) {
      return res.status(400).json({ message: "Valid proformaInvoiceId is required." });
    }
    const receivedDateRaw = String(req.body?.receivedDate || "").trim();
    if (!receivedDateRaw) return res.status(400).json({ message: "Payment received date is required." });
    const receivedDate = new Date(receivedDateRaw);
    if (Number.isNaN(receivedDate.getTime())) return res.status(400).json({ message: "Invalid payment received date." });

    const amountReceived = Number(req.body?.amountReceived);
    if (!Number.isFinite(amountReceived) || amountReceived <= 0) {
      return res.status(400).json({ message: "Amount received must be greater than 0." });
    }
    const paymentMode = String(req.body?.paymentMode || "").trim().toUpperCase();
    if (!paymentMode) return res.status(400).json({ message: "Payment mode is required." });
    if (!["BANK_TRANSFER", "CASH", "CHEQUE", "CARD", "OTHER"].includes(paymentMode)) {
      return res.status(400).json({ message: "Invalid payment mode." });
    }

    const accountName = String(req.body?.accountName || "").trim();
    if (!accountName) {
      return res.status(400).json({ message: "Bank or cash account selection is required." });
    }

    validateSlipFile(req.file);

    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: proformaInvoiceId }));
    if (!proforma) return res.status(404).json({ message: "Proforma invoice not found." });
    if (String(proforma.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot receive payment for cancelled proforma." });
    }

    const postedSum = await PaymentReceipt.aggregate([
      { $match: withCompany(req, { proformaInvoiceId: proforma._id, status: "POSTED" }) },
      { $group: { _id: null, total: { $sum: "$amountReceived" } } },
    ]);
    const alreadyReceived = Math.max(0, Number(postedSum?.[0]?.total) || 0);
    const balanceAmount = Math.max(0, (Number(proforma.grandTotal) || 0) - alreadyReceived);
    if (amountReceived > balanceAmount && !canOverrideAmount(req)) {
      return res.status(400).json({ message: "Amount received cannot exceed balance amount without admin override." });
    }
    if (amountReceived > balanceAmount && canOverrideAmount(req) && req.body?.adminOverride !== true) {
      return res.status(400).json({ message: "Set adminOverride=true to post over-receipt." });
    }

    const paymentReference = sanitizeReference(req.body?.paymentReference);
    if (paymentReference) {
      const dup = await PaymentReceipt.findOne(
        withCompany(req, {
          customerName: proforma.customerName,
          accountName,
          paymentReference,
          status: "POSTED",
        })
      ).lean();
      if (dup) {
        return res.status(400).json({ message: "Duplicate payment reference exists for this customer/account." });
      }
    }

    const receiptNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PAYMENT_RECEIPT",
      referenceDate: receivedDate,
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

    const customerId = await resolveCustomerId(req, proforma.customerName);
    const receipt = await PaymentReceipt.create({
      companyId: req.companyId,
      receiptNo,
      proformaInvoiceId: proforma._id,
      proformaInvoiceNo: proforma.proformaNo || "",
      customerId: customerId || null,
      customerName: proforma.customerName || "",
      receivedDate,
      amountReceived,
      currency: String(req.body?.currency || proforma.currency || "USD").trim().toUpperCase(),
      paymentMode,
      bankAccountId: mongoose.Types.ObjectId.isValid(String(req.body?.bankAccountId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.bankAccountId))
        : null,
      cashAccountId: mongoose.Types.ObjectId.isValid(String(req.body?.cashAccountId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.cashAccountId))
        : null,
      accountName,
      paymentReference,
      remarks: String(req.body?.remarks || ""),
      attachmentProvider: attachment?.provider || "AWS_S3",
      attachmentBucket: attachment?.bucket || "",
      attachmentKey: attachment?.key || "",
      attachmentOriginalName: attachment?.originalName || "",
      attachmentMimeType: attachment?.mimeType || "",
      attachmentSize: Number(attachment?.size || 0),
      attachmentUploadedAt: attachment?.uploadedAt || null,
      status: "POSTED",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });

    const customerEntry = await CustomerLedgerEntry.create({
      companyId: req.companyId,
      entryDate: receivedDate,
      customerName: proforma.customerName || "",
      referenceType: "PROFORMA_PAYMENT",
      referenceNumber: paymentReference || receipt.receiptNo,
      sourceModule: "Sales",
      sourceType: "Proforma Invoice Payment",
      sourceId: receipt._id,
      proformaInvoiceId: proforma._id,
      proformaInvoiceNo: proforma.proformaNo || "",
      customerId: customerId || null,
      debit: 0,
      credit: amountReceived,
      currency: receipt.currency,
      paymentReference,
      narrative: `Payment received against Proforma Invoice No. ${proforma.proformaNo || "-"}`,
      attachmentProvider: "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      createdBy: req.user?.email || "",
    });

    const cashBankEntry = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: receivedDate,
      accountName,
      transactionType: "RECEIPT",
      referenceNumber: paymentReference || receipt.receiptNo,
      sourceModule: "Sales",
      sourceType: "Proforma Invoice Payment",
      sourceId: receipt._id,
      proformaInvoiceId: proforma._id,
      proformaInvoiceNo: proforma.proformaNo || "",
      customerId: customerId || null,
      currency: receipt.currency,
      partyName: proforma.customerName || "",
      amount: amountReceived,
      mode: paymentMode,
      paymentReference,
      attachmentProvider: "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      remarks: receipt.remarks || "",
      createdBy: req.user?.email || "",
    });

    receipt.linkedCustomerLedgerEntryId = customerEntry._id;
    receipt.linkedCashBankEntryId = cashBankEntry._id;
    await receipt.save();

    const updatedProforma = await recalcProformaPaymentState(req, proforma._id);
    res.status(201).json({ receipt, proforma: updatedProforma });
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
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    const [items, total] = await Promise.all([
      PaymentReceipt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PaymentReceipt.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
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

    const reverseCustomer = await CustomerLedgerEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      customerName: receipt.customerName || "",
      referenceType: "PROFORMA_PAYMENT_CANCEL",
      referenceNumber: receipt.paymentReference || receipt.receiptNo,
      sourceModule: "Sales",
      sourceType: "Proforma Invoice Payment Reversal",
      sourceId: receipt._id,
      proformaInvoiceId: receipt.proformaInvoiceId || null,
      proformaInvoiceNo: receipt.proformaInvoiceNo || "",
      customerId: receipt.customerId || null,
      debit: Number(receipt.amountReceived) || 0,
      credit: 0,
      currency: receipt.currency || "USD",
      paymentReference: receipt.paymentReference || "",
      narrative: `Reversal of payment receipt ${receipt.receiptNo} for Proforma ${receipt.proformaInvoiceNo || "-"}`,
      attachmentProvider: receipt.attachmentProvider || "AWS_S3",
      attachmentKey: receipt.attachmentKey || "",
      reversedFromEntryId: receipt.linkedCustomerLedgerEntryId || null,
      createdBy: req.user?.email || "",
    });

    const reverseCashBank = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      accountName: receipt.accountName || "Cash",
      transactionType: "PAYMENT",
      referenceNumber: receipt.paymentReference || receipt.receiptNo,
      sourceModule: "Sales",
      sourceType: "Proforma Invoice Payment Reversal",
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

    receipt.status = "CANCELLED";
    receipt.cancellationReason = reason;
    receipt.cancelledAt = new Date();
    receipt.cancelledBy = req.user?.email || "";
    receipt.updatedBy = req.user?.email || "";
    receipt.linkedReverseCustomerLedgerEntryId = reverseCustomer._id;
    receipt.linkedReverseCashBankEntryId = reverseCashBank._id;
    await receipt.save();

    const updatedProforma = await recalcProformaPaymentState(req, receipt.proformaInvoiceId);
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
