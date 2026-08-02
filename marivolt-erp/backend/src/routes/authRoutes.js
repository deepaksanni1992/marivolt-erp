import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Company from "../models/Company.js";
import { requireAuth, requireCompanyContext, requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/userActivityService.js";
import { authRateLimitersFromEnv } from "../middleware/rateLimit.js";
import {
  assertAssignableCompanies,
  assertAssignableRole,
  pickUserCreateBody,
  resolveCreatePassword,
} from "../utils/authAdminPolicy.js";
import {
  buildOtpAuthUrl,
  buildTotpQrDataUrl,
  clearUserTwoFactorFields,
  encryptTotpSecret,
  generateUserTotpSecret,
  userTwoFactorPublicStatus,
  verifyUserTotpCode,
} from "../services/twoFactorService.js";

const router = express.Router();
const authLimits = authRateLimitersFromEnv();
const adminRoles = ["super_admin", "company_admin", "admin"];

function userAuthPayload(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    username: user.username || "",
    role: user.role,
  };
}

function signToken(user, company, allowedCompanies = []) {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      email: user.email,
      username: String(user.username || "")
        .toLowerCase()
        .trim(),
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

function signTwoFactorTicket(user, { companyId } = {}) {
  return jwt.sign(
    {
      purpose: "2fa_verify",
      id: user._id,
      email: user.email,
      companyId: String(companyId || "").trim(),
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

async function resolveUserCompanies(user) {
  const allowedIds = Array.isArray(user.allowedCompanies)
    ? user.allowedCompanies.map((x) => String(x))
    : [];
  const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
    .select("name code logoUrl currency isActive address email phone trnNo website")
    .sort({ name: 1 })
    .lean();
  return companies;
}

async function pickCompanyForTotpLabel(user) {
  const companies = await resolveUserCompanies(user);
  if (!companies.length) return null;
  if (user.defaultCompany) {
    const match = companies.find((c) => String(c._id) === String(user.defaultCompany));
    if (match) return match;
  }
  return companies[0];
}

async function completeAuthenticatedLogin(req, res, user, { requestedCompanyId } = {}) {
  const companies = await resolveUserCompanies(user);
  if (!companies.length) {
    return res.status(403).json({ message: "No active company access assigned" });
  }

  const companyId = String(requestedCompanyId || "").trim();
  if (companyId) {
    const selected = companies.find((c) => String(c._id) === companyId);
    if (!selected) return res.status(403).json({ message: "Invalid company access" });
    const token = signToken(user, selected, companies);
    await recordLoginSuccess(req, user, selected);
    return res.json({
      token,
      user: userAuthPayload(user),
      company: normalizeCompany(selected),
      companies: companies.map(normalizeCompany),
    });
  }

  if (companies.length === 1) {
    const selected = companies[0];
    const token = signToken(user, selected, companies);
    await recordLoginSuccess(req, user, selected);
    return res.json({
      token,
      user: userAuthPayload(user),
      company: normalizeCompany(selected),
      companies: companies.map(normalizeCompany),
    });
  }

  const defaultCompany = user.defaultCompany
    ? companies.find((c) => String(c._id) === String(user.defaultCompany))
    : null;
  if (defaultCompany) {
    const token = signToken(user, defaultCompany, companies);
    await recordLoginSuccess(req, user, defaultCompany);
    return res.json({
      token,
      user: userAuthPayload(user),
      company: normalizeCompany(defaultCompany),
      companies: companies.map(normalizeCompany),
    });
  }

  const loginTicket = signCompanySelectionTicket(user);
  return res.json({
    requiresCompanySelection: true,
    loginTicket,
    user: userAuthPayload(user),
    companies: companies.map(normalizeCompany),
  });
}

async function recordLoginSuccess(req, user, company, action = "LOGIN_SUCCESS") {
  try {
    user.lastLoginAt = new Date();
    user.lastLoginIp =
      req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      "";
    user.lastLoginAgent = req.headers?.["user-agent"] || "";
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          lastLoginAt: user.lastLoginAt,
          lastLoginIp: user.lastLoginIp,
          lastLoginAgent: user.lastLoginAgent,
        },
      }
    );
  } catch {
    // best-effort metadata; never block login response
  }
  await recordActivity(req, {
    action,
    success: true,
    userId: user._id,
    userEmail: user.email,
    userName: user.name || "",
    companyId: company?._id || null,
    description:
      action === "COMPANY_SWITCH"
        ? `Company switched to ${company?.code || ""}`
        : `Login successful for ${user.email}`,
    metadata: { companyCode: company?.code || "" },
  });
}

function normalizeCompany(company) {
  return {
    id: company._id,
    name: company.name,
    code: company.code,
    logoUrl: company.logoUrl || "",
    currency: company.currency || company.defaultCurrency || "USD",
    isActive: !!company.isActive,
    address: company.address || "",
    email: company.email || "",
    phone: company.phone || "",
    trnNo: company.trnNo || "",
    website: company.website || "",
  };
}

/**
 * S0 — Public registration permanently closed for private ERP.
 * Unauthenticated callers cannot create users, assign roles, or grant companies.
 */
router.post("/register", (_req, res) => {
  return res.status(410).json({
    message: "Registration is disabled. Contact an administrator.",
    code: "REGISTRATION_DISABLED",
  });
});

/**
 * S0 — Admin-only user creation (whitelist body; server-controlled privileged fields).
 * POST /api/auth/users
 */
router.post(
  "/users",
  requireAuth,
  requireCompanyContext,
  requireRole(...adminRoles),
  authLimits.adminUserCreate,
  async (req, res) => {
    try {
      let picked;
      try {
        picked = pickUserCreateBody(req.body || {});
      } catch (policyErr) {
        return res.status(policyErr.statusCode || 400).json({
          message: policyErr.message,
          code: policyErr.code || "USER_CREATE_REJECTED",
        });
      }

      const email = String(picked.email || "")
        .toLowerCase()
        .trim();
      if (!email) return res.status(400).json({ message: "email required" });

      let password;
      let role;
      let companyIds;
      try {
        password = resolveCreatePassword(picked);
        role = assertAssignableRole({
          actorRole: req.user?.role,
          requestedRole: picked.role || "staff",
        });
      } catch (policyErr) {
        return res.status(policyErr.statusCode || 403).json({
          message: policyErr.message,
          code: policyErr.code || "USER_CREATE_REJECTED",
        });
      }

      const actor = await User.findById(req.user.id).select("role allowedCompanies").lean();
      if (!actor) return res.status(401).json({ message: "User not found" });

      const requestedCompanyIds = Array.isArray(picked.companyIds)
        ? picked.companyIds
        : Array.isArray(picked.allowedCompanies)
          ? picked.allowedCompanies
          : [];

      const activeCompanies = await Company.find({ isActive: true }).select("_id").lean();
      const activeCompanyIds = activeCompanies.map((c) => String(c._id));

      try {
        companyIds = assertAssignableCompanies({
          actorRole: actor.role,
          requestedCompanyIds,
          actorAllowedCompanyIds: (actor.allowedCompanies || []).map(String),
          activeCompanyIds,
        });
      } catch (policyErr) {
        return res.status(policyErr.statusCode || 403).json({
          message: policyErr.message,
          code: policyErr.code || "USER_CREATE_REJECTED",
        });
      }

      const exists = await User.findOne({ email });
      if (exists) return res.status(400).json({ message: "Email already exists" });

      const username = picked.username
        ? String(picked.username).toLowerCase().trim()
        : undefined;
      if (username) {
        const usernameTaken = await User.findOne({ username }).select("_id").lean();
        if (usernameTaken) return res.status(400).json({ message: "Username already exists" });
      }

      let defaultCompany = null;
      const defaultCompanyId = String(picked.defaultCompanyId || companyIds[0] || "").trim();
      if (defaultCompanyId && companyIds.includes(defaultCompanyId)) {
        defaultCompany = new mongoose.Types.ObjectId(defaultCompanyId);
      } else if (companyIds[0]) {
        defaultCompany = new mongoose.Types.ObjectId(companyIds[0]);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const isActive = picked.isActive === undefined ? true : Boolean(picked.isActive);

      const user = await User.create({
        name: String(picked.name || "").trim(),
        email,
        username,
        passwordHash,
        role,
        allowedCompanies: companyIds.map((id) => new mongoose.Types.ObjectId(id)),
        defaultCompany,
        isActive,
        // Server-controlled: never accept TOTP / hashes / overrides from client.
        twoFactorEnabled: false,
        permissionOverrides: [],
        roleIds: [],
      });

      await recordActivity(req, {
        action: "USER_CREATE",
        success: true,
        userId: user._id,
        userEmail: user.email,
        userName: user.name || "",
        companyId: req.companyId,
        description: `Admin created user ${user.email}`,
        metadata: {
          createdBy: req.user?.email || "",
          role: user.role,
          companyIds,
          isActive: user.isActive,
        },
      });

      res.status(201).json({
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username || "",
        role: user.role,
        allowedCompanies: companyIds,
        defaultCompany: defaultCompany ? String(defaultCompany) : null,
        isActive: user.isActive,
        createdBy: req.user?.email || "",
      });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

// POST /api/auth/login
router.post("/login", authLimits.login, async (req, res) => {
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
    // Generic failure — do not reveal whether the account exists or is inactive.
    if (!user || user.isActive === false) {
      await recordActivity(req, {
        action: "LOGIN_FAILED",
        success: false,
        userEmail: identifier.toLowerCase(),
        description: `Login failed for ${identifier}`,
      });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await recordActivity(req, {
        action: "LOGIN_FAILED",
        success: false,
        userId: user._id,
        userEmail: user.email,
        userName: user.name || "",
        description: `Login failed for ${user.email}`,
      });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.twoFactorEnabled) {
      const requestedCompanyId = String(req.body?.companyId || "").trim();
      const twoFactorTicket = signTwoFactorTicket(user, { companyId: requestedCompanyId });
      return res.json({
        requires2FA: true,
        twoFactorTicket,
        user: userAuthPayload(user),
      });
    }

    return completeAuthenticatedLogin(req, res, user, {
      requestedCompanyId: req.body?.companyId,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/2fa/verify-login", authLimits.totp, async (req, res) => {
  try {
    const twoFactorTicket = String(req.body?.twoFactorTicket || "").trim();
    const code = String(req.body?.code || "").trim();
    if (!twoFactorTicket || !code) {
      return res.status(400).json({ message: "twoFactorTicket and code required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(twoFactorTicket, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid or expired 2FA ticket" });
    }
    if (decoded?.purpose !== "2fa_verify" || !decoded?.id) {
      return res.status(401).json({ message: "Invalid 2FA ticket" });
    }

    const user = await User.findById(decoded.id).select("+twoFactorSecret");
    if (!user || !user.isActive) {
      return res.status(401).json({ message: "User not found" });
    }
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ message: "Two-factor authentication is not enabled for this user" });
    }

    const valid = verifyUserTotpCode(user.twoFactorSecret, code);
    if (!valid) {
      await recordActivity(req, {
        action: "TWO_FACTOR_VERIFY_FAILED",
        success: false,
        userId: user._id,
        userEmail: user.email,
        userName: user.name || "",
        description: `2FA verification failed for ${user.email}`,
      });
      return res.status(401).json({ message: "Invalid authenticator code" });
    }

    user.twoFactorLastVerifiedAt = new Date();
    await user.save();

    const requestedCompanyId =
      String(req.body?.companyId || "").trim() || String(decoded.companyId || "").trim();
    return completeAuthenticatedLogin(req, res, user, { requestedCompanyId });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get("/2fa/status", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "twoFactorEnabled twoFactorEnabledAt twoFactorLastVerifiedAt"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(userTwoFactorPublicStatus(user));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("+twoFactorSecret name email username");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: "Authenticator is already enabled for your account" });
    }

    const plainSecret = generateUserTotpSecret();
    user.twoFactorSecret = encryptTotpSecret(plainSecret);
    user.twoFactorEnabled = false;
    user.twoFactorEnabledAt = null;
    user.twoFactorLastVerifiedAt = null;
    await user.save();

    const company = await pickCompanyForTotpLabel(user);
    const otpauthUrl = buildOtpAuthUrl(user, plainSecret, company);
    const qrDataUrl = await buildTotpQrDataUrl(otpauthUrl);

    res.json({
      qrDataUrl,
      otpauthUrl,
      account: user.email || user.username || user.name || "",
      company: company ? { name: company.name, code: company.code } : null,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/2fa/confirm", requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!code) return res.status(400).json({ message: "code required" });

    const user = await User.findById(req.user.id).select("+twoFactorSecret");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: "Authenticator is already enabled" });
    }
    if (!user.twoFactorSecret) {
      return res.status(400).json({ message: "Start setup first (Enable Authenticator)" });
    }

    const valid = verifyUserTotpCode(user.twoFactorSecret, code);
    if (!valid) {
      return res.status(401).json({ message: "Invalid authenticator code" });
    }

    user.twoFactorEnabled = true;
    user.twoFactorEnabledAt = new Date();
    user.twoFactorLastVerifiedAt = new Date();
    await user.save();

    await recordActivity(req, {
      action: "TWO_FACTOR_ENABLED",
      success: true,
      userId: user._id,
      userEmail: user.email,
      userName: user.name || "",
      description: `Authenticator enabled for ${user.email}`,
    });

    res.json({ success: true, ...userTwoFactorPublicStatus(user) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/2fa/disable", requireAuth, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const code = String(req.body?.code || "").trim();
    if (!password || !code) {
      return res.status(400).json({ message: "password and code required" });
    }

    const user = await User.findById(req.user.id).select("+passwordHash +twoFactorSecret");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ message: "Authenticator is not enabled" });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const valid = verifyUserTotpCode(user.twoFactorSecret, code);
    if (!valid) {
      return res.status(401).json({ message: "Invalid authenticator code" });
    }

    Object.assign(user, clearUserTwoFactorFields());
    await user.save();

    await recordActivity(req, {
      action: "TWO_FACTOR_DISABLED",
      success: true,
      userId: user._id,
      userEmail: user.email,
      userName: user.name || "",
      description: `Authenticator disabled for ${user.email}`,
    });

    res.json({ success: true, ...userTwoFactorPublicStatus(user) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/select-company", authLimits.selectCompany, async (req, res) => {
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
    if (!user || user.isActive === false) return res.status(401).json({ message: "User not found" });
    const allowedIds = Array.isArray(user.allowedCompanies)
      ? user.allowedCompanies.map((x) => String(x))
      : [];
    if (!allowedIds.includes(companyId)) {
      return res.status(403).json({ message: "Invalid company access" });
    }
    const companies = await Company.find({ _id: { $in: allowedIds }, isActive: true })
      .select("name code logoUrl currency isActive address email phone trnNo")
      .lean();
    const selected = companies.find((c) => String(c._id) === companyId);
    if (!selected) return res.status(403).json({ message: "Company inactive or unavailable" });
    const token = signToken(user, selected, companies);
    await recordLoginSuccess(req, user, selected, "COMPANY_SELECT");
    res.json({
      token,
      user: userAuthPayload(user),
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
      .select("name code logoUrl currency isActive address email phone trnNo")
      .lean();
    const selected = companies.find((c) => String(c._id) === companyId);
    if (!selected) return res.status(403).json({ message: "Company inactive or unavailable" });
    const token = signToken(user, selected, companies);
    const fullUser = await User.findById(user._id);
    if (fullUser) {
      await recordLoginSuccess(req, fullUser, selected, "COMPANY_SWITCH");
    }
    res.json({
      token,
      user: userAuthPayload(user),
      company: normalizeCompany(selected),
      companies: companies.map(normalizeCompany),
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  try {
    await recordActivity(req, {
      action: "LOGOUT",
      success: true,
      userId: req.user?.id,
      userEmail: req.user?.email || "",
      description: "User logged out",
    });
    res.json({ success: true });
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
      .select("name code logoUrl currency isActive address email phone trnNo")
      .sort({ name: 1 })
      .lean();
    res.json({ companies: companies.map(normalizeCompany) });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// GET /api/auth/users — list users (admin only)
router.get("/users", requireAuth, requireCompanyContext, requireRole("super_admin", "company_admin", "admin"), async (req, res) => {
  try {
    const filter =
      String(req.user?.role || "").toLowerCase() === "super_admin"
        ? {}
        : { allowedCompanies: req.companyId };
    const users = await User.find(filter)
      .select(
        "name email username role allowedCompanies defaultCompany createdAt twoFactorEnabled twoFactorEnabledAt"
      )
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
  requireCompanyContext,
  requireRole("super_admin", "company_admin", "admin"),
  async (req, res) => {
  try {
    const targetId = req.params.id;
    const currentId = req.user?.id;
    if (String(targetId) === String(currentId)) {
      return res.status(400).json({ message: "Cannot delete your own account" });
    }
    const filter =
      String(req.user?.role || "").toLowerCase() === "super_admin"
        ? { _id: targetId }
        : { _id: targetId, allowedCompanies: req.companyId };
    const user = await User.findOne(filter);
    if (!user) return res.status(404).json({ message: "User not found" });
    await User.deleteOne(filter);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
  }
);

router.post(
  "/users/:id/reset-2fa",
  requireAuth,
  requireCompanyContext,
  requireRole("super_admin", "company_admin", "admin"),
  async (req, res) => {
    try {
      const targetId = req.params.id;
      const filter =
        String(req.user?.role || "").toLowerCase() === "super_admin"
          ? { _id: targetId }
          : { _id: targetId, allowedCompanies: req.companyId };
      const user = await User.findOne(filter).select("name email twoFactorEnabled");
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!user.twoFactorEnabled) {
        return res.json({ success: true, message: "2FA was not enabled for this user" });
      }

      await User.updateOne({ _id: user._id }, { $set: clearUserTwoFactorFields() });

      await recordActivity(req, {
        action: "TWO_FACTOR_RESET",
        success: true,
        userId: user._id,
        userEmail: user.email,
        userName: user.name || "",
        companyId: req.companyId,
        description: `Admin reset 2FA for ${user.email}`,
        metadata: { resetBy: req.user?.email || "" },
      });

      res.json({ success: true, message: "2FA reset for user" });
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

export default router;
