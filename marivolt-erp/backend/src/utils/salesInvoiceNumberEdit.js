/**
 * P4 — Sales Invoice number edit eligibility (backend authority).
 *
 * Conservative policy (final):
 * - Customer Statement / Customer Ledger display CustomerLedger.documentNo (snapshot).
 * - AR posting is ID-linked for reversal, but renaming would leave statement showing
 *   the old invoice number while SI PDF shows the new one.
 * - Therefore: AR existence BLOCKS rename (do not cascade CustomerLedger.documentNo).
 *
 * Also block: payments, returns, dispatch, CIPL, customs, shipment, cancelled.
 */
import CustomerLedger from "../models/CustomerLedger.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import SalesReturn from "../models/SalesReturn.js";
import SalesDispatch from "../models/SalesDispatch.js";
import StoreDispatch from "../models/StoreDispatch.js";
import Cipl from "../models/Cipl.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import Shipment from "../models/Shipment.js";
import {
  normalizeDocumentStatus,
  normalizePaymentStatus,
  normalizeDispatchStatus,
} from "./salesInvoiceState.js";

function statusError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const NOT_CANCELLED = { status: { $ne: "CANCELLED" } };

function emptySummary(overrides = {}) {
  return {
    arExists: false,
    paymentExists: false,
    salesReturnExists: false,
    salesDispatchExists: false,
    storeDispatchExists: false,
    ciplExists: false,
    customsExists: false,
    shipmentExists: false,
    ...overrides,
  };
}

/**
 * @param {{
 *   companyId: any,
 *   salesInvoice: object,
 *   existsFns?: Record<string, Function>,
 * }} args
 */
export async function evaluateSalesInvoiceNumberEditability({
  companyId,
  salesInvoice,
  existsFns = {},
} = {}) {
  if (!salesInvoice) {
    return {
      allowed: false,
      reason: "Sales Invoice not found.",
      requiresReason: true,
      dependencySummary: emptySummary(),
      numberEditability: { allowed: false, reason: "Sales Invoice not found.", requiresReason: true },
    };
  }

  const documentId = salesInvoice._id;
  const docStatus = normalizeDocumentStatus(
    salesInvoice.documentStatus ||
      (["DRAFT", "CANCELLED"].includes(String(salesInvoice.status || "").toUpperCase())
        ? salesInvoice.status
        : "ISSUED")
  );
  const paymentStatus = normalizePaymentStatus(salesInvoice.paymentStatus);
  const dispatchStatus = normalizeDispatchStatus(salesInvoice.dispatchStatus);
  const received = Math.max(0, Number(salesInvoice.totalReceivedAmount) || 0);

  const summary = emptySummary();

  if (docStatus === "CANCELLED") {
    return finalize(
      false,
      "Sales Invoice number cannot be changed because the invoice is cancelled.",
      summary
    );
  }

  // AR first — CustomerLedger.documentNo is a frozen accounting/statement snapshot.
  const hasAr = existsFns.ar
    ? await existsFns.ar()
    : await CustomerLedger.exists({
        companyId,
        linkedInvoiceId: documentId,
        movementType: "SALES_INVOICE",
        ...NOT_CANCELLED,
      });
  summary.arExists = Boolean(hasAr);
  if (hasAr) {
    return finalize(
      false,
      "Sales Invoice number cannot be changed because an Accounts Receivable entry already exists.",
      summary
    );
  }

  if (paymentStatus !== "UNPAID" || received > 0) {
    summary.paymentExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because payment has already been applied.",
      summary
    );
  }

  const hasPaymentReceipt = existsFns.payment
    ? await existsFns.payment()
    : await PaymentReceipt.exists({
        companyId,
        status: { $ne: "CANCELLED" },
        $or: [
          { salesInvoiceId: documentId },
          { "allocations.targetType": "SALES_INVOICE", "allocations.targetId": documentId },
        ],
      });
  if (hasPaymentReceipt) {
    summary.paymentExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a payment receipt exists.",
      summary
    );
  }

  if (dispatchStatus !== "NOT_DISPATCHED") {
    summary.storeDispatchExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because dispatch has started.",
      summary
    );
  }

  const hasSalesReturn = existsFns.salesReturn
    ? await existsFns.salesReturn()
    : await SalesReturn.exists({ companyId, linkedSalesInvoiceId: documentId, ...NOT_CANCELLED });
  if (hasSalesReturn) {
    summary.salesReturnExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a Sales Return exists.",
      summary
    );
  }

  const hasSalesDispatch = existsFns.salesDispatch
    ? await existsFns.salesDispatch()
    : await SalesDispatch.exists({ companyId, linkedSalesInvoiceId: documentId, ...NOT_CANCELLED });
  if (hasSalesDispatch) {
    summary.salesDispatchExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a Sales Dispatch exists.",
      summary
    );
  }

  const hasStoreDispatch = existsFns.storeDispatch
    ? await existsFns.storeDispatch()
    : await StoreDispatch.exists({ companyId, salesInvoiceId: documentId, ...NOT_CANCELLED });
  if (hasStoreDispatch) {
    summary.storeDispatchExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a Dispatch exists.",
      summary
    );
  }

  const hasCipl = existsFns.cipl
    ? await existsFns.cipl()
    : await Cipl.exists({ companyId, linkedSalesInvoiceId: documentId, ...NOT_CANCELLED });
  if (hasCipl) {
    summary.ciplExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a CIPL document exists.",
      summary
    );
  }

  const hasCustoms = existsFns.customs
    ? await existsFns.customs()
    : await CustomsInvoice.exists({ companyId, salesInvoiceId: documentId });
  if (hasCustoms) {
    summary.customsExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a Customs Invoice exists.",
      summary
    );
  }

  const hasShipment = existsFns.shipment
    ? await existsFns.shipment()
    : await Shipment.exists({
        companyId,
        $or: [
          { linkedSalesInvoiceId: documentId },
          { "linkedSalesInvoices.invoiceId": documentId },
        ],
      });
  if (hasShipment) {
    summary.shipmentExists = true;
    return finalize(
      false,
      "Sales Invoice number cannot be changed because a Shipment exists.",
      summary
    );
  }

  return finalize(true, "", summary);
}

function finalize(allowed, reason, dependencySummary) {
  const numberEditability = {
    allowed,
    reason: allowed ? "" : reason,
    requiresReason: true,
  };
  return {
    allowed,
    reason: numberEditability.reason,
    requiresReason: true,
    dependencySummary,
    numberEditability,
  };
}

export async function assertSalesInvoiceNumberChangeAllowed(args) {
  const result = await evaluateSalesInvoiceNumberEditability(args);
  if (!result.allowed) {
    throw statusError(result.reason || "Sales Invoice number cannot be changed.", 400);
  }
  return result;
}

export async function getSalesInvoiceNumberEditability(args) {
  return evaluateSalesInvoiceNumberEditability(args);
}
