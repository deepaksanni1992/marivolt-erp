/**
 * P2 safety: block document-number changes that would leave denormalized
 * linked*No snapshots stale on downstream documents.
 *
 * Prefer blocking over cascading renumber (P3 territory).
 */
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import OrderAllocation from "../models/OrderAllocation.js";
import SalesInvoice from "../models/SalesInvoice.js";
import Cipl from "../models/Cipl.js";
import { resolveSalesDocumentType, salesDocumentTypeLabel } from "./salesDocNumber.js";
import { assertOrderAllocationNumberChangeAllowed } from "./orderAllocationNumberEdit.js";

function statusError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const NOT_CANCELLED = { status: { $ne: "CANCELLED" } };

async function anyExists(queries) {
  const results = await Promise.all(queries);
  return results.some(Boolean);
}

/**
 * @param {{
 *   companyId: any,
 *   documentType: string,
 *   documentId: any,
 *   document?: object,
 *   existsFns?: {
 *     oaByQuotation?: Function,
 *     piByQuotation?: Function,
 *     allocByQuotation?: Function,
 *     ciplByQuotation?: Function,
 *     siByQuotation?: Function,
 *     piByOa?: Function,
 *     allocByOa?: Function,
 *     ciplByOa?: Function,
 *     siByOa?: Function,
 *     allocByPi?: Function,
 *     ciplByPi?: Function,
 *     siByPi?: Function,
 *     packing?: Function,
 *     salesInvoice?: Function,
 *     storeDispatch?: Function,
 *     purchaseOrder?: Function,
 *   }
 * }} args
 */
export async function assertSalesDocumentNumberChangeAllowed({
  companyId,
  documentType,
  documentId,
  document = null,
  existsFns = {},
} = {}) {
  const type = resolveSalesDocumentType(documentType);
  if (!type) throw statusError(`Unsupported document type: ${documentType}`);
  if (!companyId || !documentId) throw statusError("companyId and documentId required");

  const label = salesDocumentTypeLabel(type);

  if (type === "ALLOC") {
    const allocation =
      document ||
      (await OrderAllocation.findOne({ companyId, _id: documentId }).lean());
    if (!allocation) throw statusError("Order Allocation not found.", 404);
    await assertOrderAllocationNumberChangeAllowed({
      companyId,
      allocation,
      existsFns,
    });
    return;
  }

  if (type === "OA") {
    const blocked = await anyExists([
      existsFns.piByOa
        ? existsFns.piByOa()
        : ProformaInvoice.exists({ companyId, linkedOAId: documentId, ...NOT_CANCELLED }),
      existsFns.allocByOa
        ? existsFns.allocByOa()
        : OrderAllocation.exists({ companyId, linkedOAId: documentId, ...NOT_CANCELLED }),
      existsFns.ciplByOa
        ? existsFns.ciplByOa()
        : Cipl.exists({ companyId, linkedOAId: documentId, ...NOT_CANCELLED }),
      existsFns.siByOa
        ? existsFns.siByOa()
        : SalesInvoice.exists({ companyId, linkedOAId: documentId, ...NOT_CANCELLED }),
    ]);
    if (blocked) {
      throw statusError(
        "Order Acknowledgement number cannot be changed because downstream documents already reference this OA."
      );
    }
    return;
  }

  if (type === "QT") {
    const blocked = await anyExists([
      existsFns.oaByQuotation
        ? existsFns.oaByQuotation()
        : OrderAcknowledgement.exists({ companyId, linkedQuotationId: documentId, ...NOT_CANCELLED }),
      existsFns.piByQuotation
        ? existsFns.piByQuotation()
        : ProformaInvoice.exists({ companyId, linkedQuotationId: documentId, ...NOT_CANCELLED }),
      existsFns.allocByQuotation
        ? existsFns.allocByQuotation()
        : OrderAllocation.exists({ companyId, linkedQuotationId: documentId, ...NOT_CANCELLED }),
      existsFns.ciplByQuotation
        ? existsFns.ciplByQuotation()
        : Cipl.exists({ companyId, linkedQuotationId: documentId, ...NOT_CANCELLED }),
      existsFns.siByQuotation
        ? existsFns.siByQuotation()
        : SalesInvoice.exists({ companyId, linkedQuotationId: documentId, ...NOT_CANCELLED }),
    ]);
    if (blocked) {
      throw statusError(
        "Quotation number cannot be changed because downstream documents already reference this quotation."
      );
    }
    return;
  }

  if (type === "PI") {
    // Lifecycle: Allocation requires APPROVED/PAID PI; CIPL conversion sets PI APPROVED.
    // Defensive check still covers any unexpected DRAFT-linked snapshots.
    const hasAlloc = existsFns.allocByPi
      ? await existsFns.allocByPi()
      : await OrderAllocation.exists({ companyId, linkedProformaId: documentId, ...NOT_CANCELLED });
    if (hasAlloc) {
      throw statusError(
        "Proforma Invoice number cannot be changed because an Order Allocation already references this Proforma Invoice."
      );
    }
    const blockedOther = await anyExists([
      existsFns.ciplByPi
        ? existsFns.ciplByPi()
        : Cipl.exists({ companyId, linkedProformaId: documentId, ...NOT_CANCELLED }),
      existsFns.siByPi
        ? existsFns.siByPi()
        : SalesInvoice.exists({ companyId, linkedProformaId: documentId, ...NOT_CANCELLED }),
    ]);
    if (blockedOther) {
      throw statusError(
        "Proforma Invoice number cannot be changed because downstream documents already reference this Proforma Invoice."
      );
    }
    return;
  }

  throw statusError(`${label} number changes are not supported in this phase.`);
}
