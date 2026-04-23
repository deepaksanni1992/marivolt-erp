import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "./models/Company.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

const COMPANIES = [
  {
    name: "Marivolt",
    code: "MAR",
    logoUrl: "/marivolt-logo.png",
    address: "LV09B, Hamriyah freezone phase 2, Sharjah, UAE",
    email: "sales@marivolt.co",
    phone: "+971-543053047",
    currency: "USD",
    isActive: true,
  },
  {
    name: "Okeanos",
    code: "OKE",
    logoUrl: "",
    address: "",
    email: "",
    phone: "",
    currency: "USD",
    isActive: true,
  },
];

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing in .env");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  for (const c of COMPANIES) {
    await Company.findOneAndUpdate({ code: c.code }, { $set: c }, { upsert: true, new: true });
    console.log(`Upserted company ${c.code}`);
  }
  await mongoose.disconnect();
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
