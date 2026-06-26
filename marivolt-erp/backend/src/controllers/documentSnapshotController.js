import mongoose from "mongoose";
import { getDocumentLinks } from "../services/documentSnapshot/documentChainService.js";
import { copyDocument, getCopyRoute } from "../services/documentSnapshot/documentSnapshotService.js";
import { normalizeDocumentType } from "../services/documentSnapshot/documentTypes.js";

function requireValidObjectId(id, label = "id") {
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    throw new Error(`Invalid ${label}`);
  }
}

/** GET /api/document-snapshot/chain/:documentType/:id */
export async function getDocumentChain(req, res) {
  try {
    const documentType = normalizeDocumentType(req.params.documentType);
    const { id } = req.params;
    requireValidObjectId(id, "document id");
    const result = await getDocumentLinks(req.companyId, documentType, id);
    res.json(result);
  } catch (err) {
    const status =
      err.message === "Document not found" ? 404 : err.message.startsWith("Invalid") ? 400 : 400;
    res.status(status).json({ message: err.message });
  }
}

/** GET /api/document-snapshot/routes */
export async function listSnapshotRoutes(req, res) {
  res.json({
    routes: [
      { sourceType: "QUOTATION", destinationType: "ORDER_ACKNOWLEDGEMENT", status: "active" },
      { sourceType: "ORDER_ACKNOWLEDGEMENT", destinationType: "PROFORMA_INVOICE", status: "planned" },
      { sourceType: "PROFORMA_INVOICE", destinationType: "ORDER_ALLOCATION", status: "planned" },
      { sourceType: "ORDER_ALLOCATION", destinationType: "STORE_PACKING", status: "planned" },
      { sourceType: "STORE_PACKING", destinationType: "SALES_INVOICE", status: "planned" },
    ],
  });
}

/** GET /api/document-snapshot/working-copy/:sourceType/:sourceId/:destinationType */
export async function getWorkingCopy(req, res) {
  try {
    const sourceType = normalizeDocumentType(req.params.sourceType);
    const destinationType = normalizeDocumentType(req.params.destinationType);
    const { sourceId } = req.params;
    requireValidObjectId(sourceId, "source id");
    getCopyRoute(sourceType, destinationType);
    const working = await copyDocument({
      companyId: req.companyId,
      sourceType,
      destinationType,
      sourceId,
      copiedBy: req.user?.email || "",
    });
    res.json(working);
  } catch (err) {
    const status =
      err.message === "Source document not found"
        ? 404
        : err.message.startsWith("Invalid")
          ? 400
          : 400;
    res.status(status).json({ message: err.message });
  }
}
