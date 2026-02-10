import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
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

    const user = await User.create({
      name: name || "",
      email: email.toLowerCase().trim(),
      username: username ? String(username).toLowerCase().trim() : undefined,
      passwordHash,
      role: role === "admin" ? "admin" : "staff",
    });

    const token = signToken(user);

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
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

    const token = signToken(user);

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

export default router;
