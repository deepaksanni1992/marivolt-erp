// backend/src/server.js
import "./loadEnv.js";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";

import authRoutes from "./routes/authRoutes.js";
import itemRoutes from "./routes/itemRoutes.js";
import purchaseRoutes from "./routes/purchaseRoutes.js";
import quotationRoutes from "./routes/quotationRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import grnRoutes from "./routes/grnRoutes.js";
import stockRoutes from "./routes/stockRoutes.js";
import logisticsRoutes from "./routes/logisticsRoutes.js";
import accountsRoutes from "./routes/accountsRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import bomRoutes from "./routes/bomRoutes.js";
import kittingRoutes from "./routes/kittingRoutes.js";
import dekittingRoutes from "./routes/dekittingRoutes.js";
import supplierRoutes from "./routes/supplierRoutes.js";
import purchaseReturnRoutes from "./routes/purchaseReturnRoutes.js";
import documentRoutes from "./routes/documentRoutes.js";
import { isS3Configured } from "./config/s3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;

console.log(
  "Documents / S3:",
  isS3Configured() ? "AWS env present (upload & signed URLs enabled)" : "AWS env missing — set keys in backend/.env",
);

async function startServer() {
  try {
    mongoose.set("strictQuery", true);

    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing in backend/.env");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
    });

    console.log("✅ MongoDB connected");

    const app = express();

    const allowedExactOrigins = [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
    ];

    function isAllowedOrigin(origin) {
      if (!origin) return true;
      if (allowedExactOrigins.includes(origin)) return true;
      if (origin.endsWith(".vercel.app")) return true;
      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return true;
      }
      return false;
    }

    const corsOptions = {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error("Not allowed by CORS: " + origin));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-company-id"],
    };

    app.use(cors(corsOptions));
    app.options(/.*/, cors(corsOptions));

    app.use(express.json({ limit: "2mb" }));
    app.use(morgan("dev"));

    app.use("/api/auth", authRoutes);
    app.use("/api/items", itemRoutes);
    app.use("/api/purchase-orders", purchaseRoutes);
    app.use("/api/suppliers", supplierRoutes);
    app.use("/api/purchase-returns", purchaseReturnRoutes);
    app.use("/api/quotations", quotationRoutes);
    app.use("/api/inventory", inventoryRoutes);
    app.use("/api/grn", grnRoutes);
    app.use("/api/stock", stockRoutes);
    app.use("/api/shipments", logisticsRoutes);
    app.use("/api/accounts", accountsRoutes);
    app.use("/api/sales", salesRoutes);
    app.use("/api/boms", bomRoutes);
    app.use("/api/kitting", kittingRoutes);
    app.use("/api/dekitting", dekittingRoutes);
    app.use("/api/documents", documentRoutes);

    app.get("/api/health", (req, res) => {
      res.json({ ok: true, message: "Marivoltz API running" });
    });

    app.use((req, res) => {
      res.status(404).json({ message: "Not found" });
    });

    app.listen(PORT, () => {
      console.log(`✅ API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
