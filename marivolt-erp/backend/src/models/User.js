import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: [
        "super_admin",
        "company_admin",
        "admin",
        "staff",
        "purchase_sales",
        "accounts_logistics",
      ],
      default: "staff",
    },
    allowedCompanies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true }],
    defaultCompany: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null, index: true },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
