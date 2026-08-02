/**
 * S0 — Secure user seed (no plaintext passwords in source).
 *
 * Required env:
 *   MONGO_URI
 *   SEED_ADMIN_EMAIL
 *   SEED_ADMIN_PASSWORD
 *   SEED_ADMIN_COMPANY_ID   (active Company ObjectId)
 *
 * Optional:
 *   SEED_ADMIN_NAME        (default: Admin)
 *   SEED_ADMIN_USERNAME
 *   SEED_ADMIN_ROLE        (default: admin; super_admin only if explicitly set)
 *   SEED_ALLOW_PRODUCTION=true   required when NODE_ENV=production
 *   SEED_RESET_PASSWORDS=true    only then may overwrite an existing user's password
 *
 * Run: node src/seedUsers.js
 *
 * IMPORTANT: Previously committed seed credentials must be rotated manually in
 * production. See docs/security-s0-deployment.md.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import User from "./models/User.js";
import Company from "./models/Company.js";
import { USER_ROLES, normalizeRole } from "./utils/authAdminPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 1) return "***";
  return `${s[0]}***${s.slice(at)}`;
}

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing in .env");
    process.exit(1);
  }

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (isProd && String(process.env.SEED_ALLOW_PRODUCTION || "").toLowerCase() !== "true") {
    console.error(
      "Refusing to run seedUsers in production without SEED_ALLOW_PRODUCTION=true"
    );
    process.exit(1);
  }

  const email = requireEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const password = requireEnv("SEED_ADMIN_PASSWORD");
  const companyId = requireEnv("SEED_ADMIN_COMPANY_ID");
  if (password.length < 10) {
    console.error("SEED_ADMIN_PASSWORD must be at least 10 characters");
    process.exit(1);
  }

  const name = String(process.env.SEED_ADMIN_NAME || "Admin").trim() || "Admin";
  const username = String(process.env.SEED_ADMIN_USERNAME || "").toLowerCase().trim() || undefined;
  let role = normalizeRole(process.env.SEED_ADMIN_ROLE || "admin");
  if (!USER_ROLES.includes(role)) {
    console.error("SEED_ADMIN_ROLE is not an allowed role");
    process.exit(1);
  }

  const resetPasswords =
    String(process.env.SEED_RESET_PASSWORDS || "").toLowerCase() === "true";

  await mongoose.connect(process.env.MONGO_URI);

  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    console.error("SEED_ADMIN_COMPANY_ID is not a valid ObjectId");
    process.exit(1);
  }
  const company = await Company.findOne({ _id: companyId, isActive: true }).lean();
  if (!company) {
    console.error("SEED_ADMIN_COMPANY_ID must reference an active company");
    process.exit(1);
  }

  const existing = await User.findOne({
    $or: [{ email }, ...(username ? [{ username }] : [])],
  });

  if (existing) {
    existing.name = name;
    existing.email = email;
    if (username) existing.username = username;
    existing.role = role;
    existing.allowedCompanies = [company._id];
    if (!existing.defaultCompany) existing.defaultCompany = company._id;
    existing.isActive = true;
    if (resetPasswords) {
      existing.passwordHash = await bcrypt.hash(password, 10);
      console.log("Updated (password reset):", maskEmail(email), "role:", role);
    } else {
      console.log(
        "Updated (password unchanged — set SEED_RESET_PASSWORDS=true to reset):",
        maskEmail(email),
        "role:",
        role
      );
    }
    await existing.save();
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({
      username,
      email,
      name,
      passwordHash,
      role,
      allowedCompanies: [company._id],
      defaultCompany: company._id,
      isActive: true,
    });
    console.log("Created:", maskEmail(email), "role:", role);
  }

  const all = await User.find().select("username email role isActive").lean();
  console.log("\nAll users:", all.length);
  all.forEach((u) => console.log(" -", u.username || "-", maskEmail(u.email), u.role, u.isActive ? "active" : "inactive"));

  console.log(
    "\nReminder: rotate any accounts previously seeded with committed credentials. See docs/security-s0-deployment.md"
  );

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
