/**
 * One-time script: set password for a user by username or email.
 * Run from backend:
 *   Linux/Mac: NEW_PASSWORD=yourpass node src/changePassword.js
 *   Windows PowerShell: $env:NEW_PASSWORD="yourpass"; node src/changePassword.js
 * Optional: USERNAME=deepak007 (defaults to deepak007 if not set)
 */
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import User from "./models/User.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const USERNAME = process.env.USERNAME || "deepak007";
const NEW_PASSWORD = process.env.NEW_PASSWORD;

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }
  if (!NEW_PASSWORD || !String(NEW_PASSWORD).trim()) {
    throw new Error("NEW_PASSWORD env variable is required (e.g. NEW_PASSWORD=yourpass node src/changePassword.js)");
  }
  await mongoose.connect(process.env.MONGO_URI);

  const user = await User.findOne({
    $or: [
      { username: USERNAME.toLowerCase() },
      { email: USERNAME.toLowerCase() },
    ],
  });

  if (!user) {
    console.error("User not found:", USERNAME);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(String(NEW_PASSWORD).trim(), 10);
  user.passwordHash = passwordHash;
  await user.save();

  console.log("Password updated for user:", user.username || user.email);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
