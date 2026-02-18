/**
 * One-time script: delete staff user(s) from the database.
 * Run from backend folder: node src/deleteStaffUser.js
 * Requires MONGO_URI in .env.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import User from "./models/User.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing in .env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const deleted = await User.deleteMany({ role: "staff" });
  console.log("Deleted staff user(s):", deleted.deletedCount);

  const remaining = await User.find().select("email username role");
  console.log("Remaining users:", remaining.length);
  remaining.forEach((u) => console.log(" -", u.email || u.username, u.role));

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
