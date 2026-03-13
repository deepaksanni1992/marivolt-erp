import {
  ENGINE_MAKES,
  ENGINE_MODELS,
  CONFIGURATIONS,
  CYLINDER_COUNTS,
  ITEM_TYPES,
  STATUSES,
} from "../constants/masterValues.js";

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
    throw new Error(
      `${field} must be one of: ${values.join(", ")}`
    );
  }
  return v;
}

export function validateSpnPayload(input) {
  return {
    spn: reqStr(input.spn, "SPN"),
    partName: reqStr(input.partName, "Part name"),
    genericDescription: optStr(input.genericDescription),
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
    shortDescription: reqStr(
      input.shortDescription,
      "Short description"
    ),
    itemType: reqEnum(input.itemType, "Item type", ITEM_TYPES),
    unit: reqStr(input.unit, "Unit"),
    status: input.status ? reqEnum(input.status, "Status", STATUSES) : "Active",
    remarks: optStr(input.remarks),
  };
}

export function validateCompatibilityPayload(input) {
  const base = {
    materialCode: reqStr(input.materialCode, "Material code"),
    engineMake: reqEnum(input.engineMake, "Engine make", ENGINE_MAKES),
    engineModel: reqEnum(input.engineModel, "Engine model", ENGINE_MODELS),
    configuration: reqEnum(
      input.configuration,
      "Configuration",
      CONFIGURATIONS
    ),
    cylinderCount: reqEnum(
      input.cylinderCount,
      "Cylinder count",
      CYLINDER_COUNTS
    ),
    applicabilityRemarks: optStr(input.applicabilityRemarks),
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
  return {
    materialCode: reqStr(input.materialCode, "Material code"),
    supplierName: reqStr(input.supplierName, "Supplier name"),
    supplierArticleNo: optStr(input.supplierArticleNo),
    supplierDescription: optStr(input.supplierDescription),
    currency: optStr(input.currency),
    purchasePrice:
      input.purchasePrice === undefined ||
      input.purchasePrice === null ||
      input.purchasePrice === ""
        ? 0
        : Number(input.purchasePrice),
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

