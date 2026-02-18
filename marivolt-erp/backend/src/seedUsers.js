/**
 * Create login credentials: advitya (admin), himanshu (purchase_sales), kalpesh (accounts_logistics).
 * Run from backend folder: node src/seedUsers.js
 * Requires MONGO_URI in .env.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import User from "./models/User.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const USERS = [
  { username: "advitya", password: "advitya2026", name: "Advitya", role: "admin" },
  { username: "kalpesh", password: "kalpesh13568", name: "Kalpesh", role: "accounts_logistics" },
  { username: "himanshu", password: "himanshu@22348", name: "Himanshu", role: "purchase_sales" },
];

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing in .env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  for (const u of USERS) {
    const email = `${u.username}@marivoltz.com`;
    const existing = await User.findOne({
      $or: [{ username: u.username }, { email }],
    });
    const passwordHash = await bcrypt.hash(u.password, 10);
    if (existing) {
      existing.passwordHash = passwordHash;
      existing.name = u.name;
      existing.role = u.role;
      existing.email = email;
      await existing.save();
      console.log("Updated:", u.username, "role:", u.role);
    } else {
      await User.create({
        username: u.username,
        email,
        name: u.name,
        passwordHash,
        role: u.role,
      });
      console.log("Created:", u.username, "role:", u.role);
    }
  }

  const all = await User.find().select("username email role").lean();
  console.log("\nAll users:", all.length);
  all.forEach((u) => console.log(" -", u.username, u.email, u.role));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
