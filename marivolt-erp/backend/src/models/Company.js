import mongoose from "mongoose";

/**
 * Company master — Phase-10.
 *
 * Backward compatibility:
 * - All Phase-1..9 fields (`name`, `code`, `logoUrl`, `address`, `email`,
 *   `phone`, `trnNo`, `currency`, `isActive`) remain unchanged.
 * - Phase-10 expansion adds short name, country, registration No,
 *   bank details, default currency / timezone aliases, and active
 *   status alias. Old documents continue to validate because every
 *   new field is optional.
 */
const bankDetailSchema = new mongoose.Schema(
  {
    label: { type: String, default: "", trim: true },
    accountName: { type: String, default: "", trim: true },
    accountNo: { type: String, default: "", trim: true },
    iban: { type: String, default: "", trim: true },
    swift: { type: String, default: "", trim: true },
    bankName: { type: String, default: "", trim: true },
    bankAddress: { type: String, default: "", trim: true },
    branch: { type: String, default: "", trim: true },
    currency: { type: String, default: "", trim: true, uppercase: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true }
);

const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Short name shown on print headers when full name is too long. */
    shortName: { type: String, default: "", trim: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    logoUrl: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    /** Tax registration / TRN shown on Tax invoice shipper block. */
    trnNo: { type: String, default: "", trim: true },
    /** Optional company registration number (CR/SRN/etc.). */
    registrationNo: { type: String, default: "", trim: true },
    /** Default base currency. Old field `currency` is kept for backward compatibility. */
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    defaultCurrency: { type: String, default: "", trim: true, uppercase: true },
    /** IANA timezone, e.g. `Asia/Dubai`. Defaults left empty for backward compatibility. */
    timezone: { type: String, default: "", trim: true },
    /** Multiple bank profiles (used in PI/SI footers, payment receipts). */
    bankDetails: { type: [bankDetailSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

companySchema.index({ name: 1 }, { unique: true });
companySchema.index({ isActive: 1, code: 1 });

export default mongoose.model("Company", companySchema);
