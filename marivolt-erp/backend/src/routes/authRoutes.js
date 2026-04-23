import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Company from "../models/Company.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

function signToken(user, company, allowedCompanies = []) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      email: user.email,
      companyId: String(company?._id || ""),
      companyCode: String(company?.code || "").toUpperCase(),
      allowedCompanyIds: allowedCompanies.map((c) => String(c._id || c)),
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function signCompanySelectionTicket(user) {
  return jwt.sign(
    { purpose: "company_select", id: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function normalizeCompany(company) {
  return {
    id: company._id,
    name: company.name,
    code: company.code,
    logoUrl: company.logoUrl || "",
    currency: company.currency || "USD",
    isActive: !!company.isActive,
  };
}

// POST /api/auth/register (optional - for now)
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, role, username } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "email & password required" });
    }

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ message: "Email already exists" });

    const passwordHash = await bcrypt.hash(password, 10);

    const allActiveCompanies = await Company.find({ isActive: true }).select("_id").lean();
    const allCompanyIds = allActiveCompanies.map((c) => c._id);
    const user = await User.create({
      name: name || "",
      email: email.toLowerCase().trim(),
      username: username ? String(username).toLowerCase().trim() : undefined,
      passwordHash,
      role: ["admin", "purchase_sales", "accounts_logistics"].includes(role) ? role : "staff",
      allowedCompanies: allCompanyIds,
      defaultCompany: allCompanyIds[0] || null,
    });

    const firstCompany = await Company.findOne({ isActive: true }).sort({ createdAt: 1 }).lean();
    const token = firstCompany ? signToken(user, firstCompany, [firstCompany]) : null;

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      company: firstCompany ? normalizeCompany(firstCompany) : null,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const identifier = String(email || "").trim();
    if (!identifier || !password) {
      return res
        .status(400)
        .json({ message: "username/email & password required" });
    }

    const isEmail = identifier.includes("@");
    let user = null;
    if (isEmail) {
      user = await User.findOne({ email: identifier.toLowerCase() });
    } else {
      user = await User.findOne({ username: identifier.toLowerCase() });
    }

    if (!user) {
      user = await User.findOne({ email: identifier.toLowerCase() });
    }
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const allowedIds = Array.isArray(user.allowedCompanies)
      ? user.allowedCompanies.map((x) => String(x))
      : [];
    const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
      .select("name code logoUrl currency isActive")
      .sort({ name: 1 })
      .lean();
    if (!companies.length) {
      return res.status(403).json({ message: "No active company access assigned" });
    }

    const requestedCompanyId = String(req.body?.companyId || "").trim();
    if (requestedCompanyId) {
      const selected = companies.find((c) => String(c._id) === requestedCompanyId);
      if (!selected) return res.status(403).json({ message: "Invalid company access" });
      const token = signToken(user, selected, companies);
      return res.json({
        token,
        user: { id: user._id, name: user.name, email: user.email, role: user.role },
        company: normalizeCompany(selected),
        companies: companies.map(normalizeCompany),
      });
    }

    if (companies.length === 1) {
      const selected = companies[0];
      const token = signToken(user, selected, companies);
      return res.json({
        token,
        user: { id: user._id, name: user.name, email: user.email, role: user.role },
        company: normalizeCompany(selected),
        companies: companies.map(normalizeCompany),
      });
    }

    const defaultCompany = user.defaultCompany
      ? companies.find((c) => String(c._id) === String(user.defaultCompany))
      : null;
    if (defaultCompany) {
      const token = signToken(user, defaultCompany, companies);
      return res.json({
        token,
        user: { id: user._id, name: user.name, email: user.email, role: user.role },
        company: normalizeCompany(defaultCompany),
        companies: companies.map(normalizeCompany),
      });
    }

    const loginTicket = signCompanySelectionTicket(user);
    return res.json({
      requiresCompanySelection: true,
      loginTicket,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      companies: companies.map(normalizeCompany),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/select-company", async (req, res) => {
  try {
    const loginTicket = String(req.body?.loginTicket || "").trim();
    const companyId = String(req.body?.companyId || "").trim();
    if (!loginTicket || !companyId) {
      return res.status(400).json({ message: "loginTicket and companyId required" });
    }
    const decoded = jwt.verify(loginTicket, process.env.JWT_SECRET);
    if (decoded?.purpose !== "company_select" || !decoded?.id) {
      return res.status(401).json({ message: "Invalid login ticket" });
    }
    const user = await User.findById(decoded.id).lean();
    if (!user) return res.status(401).json({ message: "User not found" });
    const allowedIds = Array.isArray(user.allowedCompanies)
      ? user.allowedCompanies.map((x) => String(x))
      : [];
    if (!allowedIds.includes(companyId)) {
      return res.status(403).json({ message: "Invalid company access" });
    }
    const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
      .select("name code logoUrl currency isActive")
      .lean();
    const selected = companies.find((c) => String(c._id) === companyId);
    if (!selected) return res.status(403).json({ message: "Company inactive or unavailable" });
    const token = signToken(user, selected, companies);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      company: normalizeCompany(selected),
      companies: companies.map(normalizeCompany),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/switch-company", requireAuth, async (req, res) => {
  try {
    const companyId = String(req.body?.companyId || "").trim();
    if (!companyId) return res.status(400).json({ message: "companyId required" });
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(401).json({ message: "User not found" });
    const allowedIds = Array.isArray(user.allowedCompanies)
      ? user.allowedCompanies.map((x) => String(x))
      : [];
    if (!allowedIds.includes(companyId)) {
      return res.status(403).json({ message: "Invalid company access" });
    }
    const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
      .select("name code logoUrl currency isActive")
      .lean();
    const selected = companies.find((c) => String(c._id) === companyId);
    if (!selected) return res.status(403).json({ message: "Company inactive or unavailable" });
    const token = signToken(user, selected, companies);
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
      company: normalizeCompany(selected),
      companies: companies.map(normalizeCompany),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/companies", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(401).json({ message: "User not found" });
    const allowedIds = Array.isArray(user.allowedCompanies)
      ? user.allowedCompanies.map((x) => String(x))
      : [];
    const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
      .select("name code logoUrl currency isActive")
      .sort({ name: 1 })
      .lean();
    res.json({ companies: companies.map(normalizeCompany) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/auth/users — list users (admin only)
router.get("/users", requireAuth, requireRole("super_admin", "company_admin", "admin"), async (req, res) => {
  try {
    const users = await User.find()
      .select("name email username role allowedCompanies defaultCompany createdAt")
      .populate("allowedCompanies", "name code")
      .populate("defaultCompany", "name code")
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/auth/users/:id — delete user (admin only); cannot delete self
router.delete(
  "/users/:id",
  requireAuth,
  requireRole("super_admin", "company_admin", "admin"),
  async (req, res) => {
  try {
    const targetId = req.params.id;
    const currentId = req.user?.id;
    if (String(targetId) === String(currentId)) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }
    const user = await User.findById(targetId);
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.findByIdAndDelete(targetId);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
  }
);

export default router;
