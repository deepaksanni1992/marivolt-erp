import mongoose from "mongoose";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import User from "./models/User.js";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  await User.deleteMany({ email: { $in: ["admin@marivoltz.com", "staff@marivoltz.com"] } });

  const adminHash = await bcrypt.hash("admin123", 10);
  const staffHash = await bcrypt.hash("staff123", 10);

  await User.create([
    { name: "Admin", email: "admin@marivoltz.com", passwordHash: adminHash, role: "admin" },
    { name: "Staff", email: "staff@marivoltz.com", passwordHash: staffHash, role: "staff" },
  ]);

  console.log("✅ Seeded users");
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
