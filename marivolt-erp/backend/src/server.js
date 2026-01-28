import purchaseRoutes from "./routes/purchaseRoutes.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import itemRoutes from "./routes/itemRoutes.js";
import stockTxnRoutes from "./routes/stockTxnRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import { requireAuth, requireRole } from "./middleware/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

    mongoose.set("strictQuery", true);

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
    });

    console.log("✅ MongoDB connected");

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

    app.listen(PORT, () => {
      console.log(`✅ API listening on ${PORT}`);
    });

  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();

