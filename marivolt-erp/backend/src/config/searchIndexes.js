/**
 * Ensures compound indexes used by global search (additive, read-performance only).
 */
import Quotation from "../models/Quotation.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import ItemMaster from "../models/itemMasterModel.js";
import Customer from "../models/Customer.js";
import Supplier from "../models/Supplier.js";
import Document from "../models/Document.js";

const INDEX_SPECS = [
  [Quotation, { companyId: 1, quotationNo: 1 }],
  [Quotation, { companyId: 1, customerName: 1 }],
  [OrderAcknowledgement, { companyId: 1, oaNo: 1 }],
  [OrderAcknowledgement, { companyId: 1, customerName: 1 }],
  [ProformaInvoice, { companyId: 1, proformaNo: 1 }],
  [SalesInvoice, { companyId: 1, invoiceNo: 1 }],
  [SalesInvoice, { companyId: 1, customerName: 1 }],
  [PurchaseOrder, { companyId: 1, poNo: 1 }],
  [PurchaseOrder, { companyId: 1, supplierName: 1 }],
  [GRN, { companyId: 1, grnNo: 1 }],
  [GRN, { companyId: 1, supplierInvoiceNo: 1 }],
  [GRN, { companyId: 1, blAwbNo: 1 }],
  [StorePacking, { companyId: 1, packingNo: 1 }],
  [StoreDispatch, { companyId: 1, dispatchNo: 1 }],
  [CustomsLot, { companyId: 1, blNumber: 1 }],
  [CustomsLot, { companyId: 1, supplierInvoiceNumber: 1 }],
  [CustomsLotItem, { companyId: 1, articleNumber: 1, blNumber: 1 }],
  [CustomsLotItem, { companyId: 1, supplierInvoiceNumber: 1 }],
  [CustomsMovement, { companyId: 1, articleNumber: 1 }],
  [CustomsMovement, { companyId: 1, referenceNumber: 1 }],
  [CustomsInvoice, { companyId: 1, customsInvoiceNumber: 1 }],
  [ItemMaster, { companyId: 1, article: 1 }],
  [ItemMaster, { companyId: 1, partNumber: 1 }],
  [Customer, { companyId: 1, name: 1 }],
  [Supplier, { companyId: 1, supplierName: 1 }],
  [Document, { companyId: 1, fileName: 1 }],
];

export async function ensureSearchIndexes() {
  for (const [model, spec] of INDEX_SPECS) {
    try {
      await model.collection.createIndex(spec, { background: true });
    } catch {
      // Index may already exist with different options — safe to ignore.
    }
  }
}
