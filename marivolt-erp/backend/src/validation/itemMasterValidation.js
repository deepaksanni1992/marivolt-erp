import mongoose from "mongoose";
import { ITEM_TYPES, STATUSES } from "../constants/masterValues.js";

function reqStr(value, field) {
  const v = String(value ?? "").trim();
  if (!v) {
    throw new Error(`${field} is required`);
  }
  return v;
}

function optStr(value) {
  return String(value ?? "").trim();
}

function reqEnum(value, field, values) {
  const v = reqStr(value, field);
  if (!values.includes(v)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return v;
}

function reqObjectId(value, field) {
  const v = String(value ?? "").trim();
  if (!v) {
    throw new Error(`${field} is required`);
  }
  if (!mongoose.Types.ObjectId.isValid(v)) {
    throw new Error(`${field} must be a valid id`);
  }
  return v;
}

export function validateVerticalPayload(input) {
  return {
    name: reqStr(input.name, "Vertical name"),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
  };
}

export function validateBrandPayload(input) {
  return {
    name: reqStr(input.name, "Brand name"),
    vertical: reqObjectId(input.vertical, "Vertical"),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
  };
}

export function validateSpnPayload(input) {
  const description = optStr(input.description);
  const genericDescription = optStr(input.genericDescription);
  return {
    spn: reqStr(input.spn, "SPN"),
    vertical: reqObjectId(input.vertical, "Vertical"),
    partName: reqStr(input.partName, "Part name"),
    description: description || genericDescription,
    genericDescription: genericDescription || description,
    category: optStr(input.category),
    subCategory: optStr(input.subCategory),
    uom: optStr(input.uom),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
    remarks: optStr(input.remarks),
  };
}

export function validateMaterialPayload(input) {
  return {
    materialCode: reqStr(input.materialCode, "Material code"),
    spn: reqStr(input.spn, "SPN"),
    vertical: reqObjectId(input.vertical, "Vertical"),
    shortDescription: reqStr(input.shortDescription, "Short description"),
    itemType: reqEnum(input.itemType, "Item type", ITEM_TYPES),
    unit: reqStr(input.unit, "Unit"),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
    remarks: optStr(input.remarks),
  };
}

export function validateCompatibilityPayload(input) {
  const brandSource = input.brand ?? input.engineMake;
  const base = {
    materialCode: reqStr(input.materialCode, "Material code"),
    brand: reqStr(brandSource, "Brand"),
    engineModel: reqStr(input.engineModel, "Engine model"),
    configuration: reqStr(input.configuration, "Configuration"),
    cylinderCount: reqStr(input.cylinderCount, "Cylinder count"),
    remarks: optStr(input.remarks ?? input.applicabilityRemarks),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
  };

  const esnFrom =
    input.esnFrom === undefined || input.esnFrom === null || input.esnFrom === ""
      ? null
      : Number(input.esnFrom);
  const esnTo =
    input.esnTo === undefined || input.esnTo === null || input.esnTo === ""
      ? null
      : Number(input.esnTo);

  if (Number.isNaN(esnFrom) || Number.isNaN(esnTo)) {
    throw new Error("ESN range must be numeric if provided");
  }

  if (esnFrom !== null && esnTo !== null && esnFrom > esnTo) {
    throw new Error("esnFrom cannot be greater than esnTo");
  }

  return {
    ...base,
    esnFrom,
    esnTo,
  };
}

export function validateArticlePayload(input) {
  return {
    articleNo: reqStr(input.articleNo, "Article number"),
    materialCode: reqStr(input.materialCode, "Material code"),
    description: reqStr(input.description, "Description"),
    drawingNo: optStr(input.drawingNo),
    maker: optStr(input.maker),
    brand: optStr(input.brand),
    unit: optStr(input.unit),
    weight:
      input.weight === undefined || input.weight === null || input.weight === ""
        ? 0
        : Number(input.weight),
    hsnCode: optStr(input.hsnCode),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
    remarks: optStr(input.remarks),
  };
}

export function validateMaterialSupplierPayload(input) {
  const priceRaw =
    input.price !== undefined && input.price !== null && input.price !== ""
      ? input.price
      : input.purchasePrice;

  const price =
    priceRaw === undefined || priceRaw === null || priceRaw === ""
      ? 0
      : Number(priceRaw);

  if (Number.isNaN(price)) {
    throw new Error("Price must be a valid number");
  }

  return {
    materialCode: reqStr(input.materialCode, "Material code"),
    supplierName: reqStr(input.supplierName, "Supplier name"),
    supplierArticleNo: optStr(input.supplierArticleNo),
    supplierDescription: optStr(input.supplierDescription),
    currency: optStr(input.currency),
    price,
    leadTimeDays:
      input.leadTimeDays === undefined ||
      input.leadTimeDays === null ||
      input.leadTimeDays === ""
        ? 0
        : Number(input.leadTimeDays),
    moq:
      input.moq === undefined || input.moq === null || input.moq === ""
        ? 0
        : Number(input.moq),
    supplierCountry: optStr(input.supplierCountry),
    preferred: Boolean(input.preferred),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
    remarks: optStr(input.remarks),
  };
}
