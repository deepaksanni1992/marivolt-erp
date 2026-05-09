import mongoose from "mongoose";

const modelMappingSchema = new mongoose.Schema(
  {
    modelCode: { type: String, default: "", trim: true },
    modelName: { type: String, default: "", trim: true },
    variant: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const configurationMappingSchema = new mongoose.Schema(
  {
    configurationCode: { type: String, default: "", trim: true },
    configurationName: { type: String, default: "", trim: true },
    applicability: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const oemCrossReferenceSchema = new mongoose.Schema(
  {
    oemName: { type: String, default: "", trim: true },
    oemPartNumber: { type: String, default: "", trim: true },
    oemDescription: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const supplierReferenceSchema = new mongoose.Schema(
  {
    supplierName: { type: String, default: "", trim: true },
    supplierPartNumber: { type: String, default: "", trim: true },
    preferred: { type: Boolean, default: false },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const technicalSpecificationSchema = new mongoose.Schema(
  {
    specName: { type: String, default: "", trim: true },
    specValue: { type: String, default: "", trim: true },
    specUnit: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const interchangeablePartSchema = new mongoose.Schema(
  {
    article: { type: String, default: "", trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    interchangeType: {
      type: String,
      enum: ["INTERCHANGEABLE", "SUPERSEDED", "REPLACEMENT"],
      default: "INTERCHANGEABLE",
      trim: true,
    },
    replacementPriority: { type: Number, default: 0, min: 0 },
    replacementNotes: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const itemTechnicalSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    spn: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    drawingNumber: { type: String, default: "", trim: true },
    dimension: { type: String, default: "", trim: true },
    cylinderCount: { type: Number, default: null, min: 0 },
    specDimensions: { type: String, default: "", trim: true },
    specWeight: { type: String, default: "", trim: true },
    specMaterial: { type: String, default: "", trim: true },
    specTolerances: { type: String, default: "", trim: true },
    specMarkings: { type: String, default: "", trim: true },
    revisionNo: { type: String, default: "", trim: true },
    technicalDocuments: {
      type: [
        {
          documentId: { type: mongoose.Schema.Types.ObjectId, default: null },
          fileName: { type: String, default: "", trim: true },
          documentType: { type: String, default: "", trim: true },
          notes: { type: String, default: "", trim: true },
        },
      ],
      default: [],
    },
    oeMarkings: { type: String, default: "", trim: true },
    extRemarks: { type: String, default: "", trim: true },
    internalRemarks: { type: String, default: "", trim: true },
    modelMappings: { type: [modelMappingSchema], default: [] },
    configurationMappings: { type: [configurationMappingSchema], default: [] },
    oemCrossReferences: { type: [oemCrossReferenceSchema], default: [] },
    supplierReferences: { type: [supplierReferenceSchema], default: [] },
    technicalSpecifications: { type: [technicalSpecificationSchema], default: [] },
    interchangeableParts: { type: [interchangeablePartSchema], default: [] },
  },
  { timestamps: true }
);

itemTechnicalSchema.index({ companyId: 1, article: 1 }, { unique: true });
itemTechnicalSchema.index({ companyId: 1, spn: 1, materialCode: 1, drawingNumber: 1 });
itemTechnicalSchema.index({ companyId: 1, esn: 1 });
itemTechnicalSchema.index({ companyId: 1, "modelMappings.modelCode": 1 });
itemTechnicalSchema.index({ companyId: 1, "configurationMappings.configurationCode": 1 });
itemTechnicalSchema.index({ companyId: 1, "oemCrossReferences.oemPartNumber": 1 });
itemTechnicalSchema.index({ companyId: 1, cylinderCount: 1 });
itemTechnicalSchema.index({ companyId: 1, "supplierReferences.supplierPartNumber": 1 });
itemTechnicalSchema.index({ companyId: 1, "interchangeableParts.article": 1 });

export default mongoose.model("ItemTechnical", itemTechnicalSchema);
