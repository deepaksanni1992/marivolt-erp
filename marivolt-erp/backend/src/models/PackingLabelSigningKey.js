import mongoose from "mongoose";

/**
 * Company-scoped HMAC signing keys for MAR1 packing QR tokens.
 *
 * Secret material is stored as exactly one of: AES-256-GCM v1 envelope
 * (encryptedSecret) or environment reference (`env:VAR_NAME`, secretRef).
 * Both or neither is invalid. Never store plaintext secrets.
 * Never return either field through an API. Log keyId only.
 *
 * ACTIVE — exactly one per company; signs and verifies.
 * VERIFY_ONLY — verifies historical labels; cannot sign new labels.
 * REVOKED — verification fails.
 */
export const PACKING_LABEL_SIGNING_KEY_STATUSES = Object.freeze([
  "ACTIVE",
  "VERIFY_ONLY",
  "REVOKED",
]);

export const PACKING_LABEL_SIGNING_KEY_ID_PATTERN = /^K[0-9]{1,2}$/;

const packingLabelSigningKeySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    keyId: { type: String, required: true, trim: true, uppercase: true },
    /**
     * AES-256-GCM envelope `v1:<nonce>.<ciphertext>.<tag>` (base64url parts).
     * Mutually exclusive with secretRef. Excluded from default queries and JSON.
     */
    encryptedSecret: { type: String, default: "", trim: true, select: false },
    /**
     * Optional `env:VAR_NAME` reference. Mutually exclusive with encryptedSecret.
     * Excluded from default queries and JSON. Never log the referenced name.
     */
    secretRef: { type: String, default: "", trim: true, select: false },
    status: {
      type: String,
      enum: PACKING_LABEL_SIGNING_KEY_STATUSES,
      required: true,
      default: "ACTIVE",
      index: true,
    },
    activatedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    createdBy: { type: String, default: "", trim: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, collection: "packingLabelSigningKeys" }
);

packingLabelSigningKeySchema.index({ companyId: 1, keyId: 1 }, { unique: true });
packingLabelSigningKeySchema.index(
  { companyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "ACTIVE" },
  }
);

function secretSourcePresent(value) {
  return String(value || "").trim() !== "";
}

function exactlyOneSecretSource() {
  return secretSourcePresent(this.encryptedSecret) !== secretSourcePresent(this.secretRef);
}

const exactlyOneSecretSourceValidator = {
  validator: exactlyOneSecretSource,
  message: "Packing-label signing key must have exactly one secret source.",
};

packingLabelSigningKeySchema.path("encryptedSecret").validate(exactlyOneSecretSourceValidator);
packingLabelSigningKeySchema.path("secretRef").validate(exactlyOneSecretSourceValidator);

packingLabelSigningKeySchema.pre("validate", function assertExactlyOneSecretSource(next) {
  if (!exactlyOneSecretSource.call(this)) {
    this.invalidate("encryptedSecret", "Packing-label signing key must have exactly one secret source.");
  }
  next();
});

function omitSecretMaterial(_doc, ret) {
  delete ret.encryptedSecret;
  delete ret.secretRef;
  return ret;
}

packingLabelSigningKeySchema.set("toJSON", { transform: omitSecretMaterial });
packingLabelSigningKeySchema.set("toObject", { transform: omitSecretMaterial });

export default mongoose.model("PackingLabelSigningKey", packingLabelSigningKeySchema);
