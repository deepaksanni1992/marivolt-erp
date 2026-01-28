import purchaseRoutes from "./routes/purchaseRoutes.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });


import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import itemRoutes from "./routes/itemRoutes.js";
import stockTxnRoutes from "./routes/stockTxnRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import { requireAuth, requireRole } from "./middleware/auth.js";

console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));



const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan("dev"));
app.use("/api/auth", authRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/stock-txns", stockTxnRoutes);
app.use("/api/purchase", purchaseRoutes);



app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Marivoltz API running" });
});

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected");

  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`✅ API listening on ${port}`));
}

start().catch((err) => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});
