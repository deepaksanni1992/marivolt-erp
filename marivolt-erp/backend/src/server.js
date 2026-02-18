// backend/src/server.js
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
import purchaseRoutes from "./routes/purchaseRoutes.js";
import supplierRoutes from "./routes/supplierRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import bomRoutes from "./routes/bomRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import priceListRoutes from "./routes/priceListRoutes.js";
import logisticsRoutes from "./routes/logisticsRoutes.js";
import accountsRoutes from "./routes/accountsRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend/.env OR project root .env depending on your structure.
// You were using ../.env from backend/src (keep same):
dotenv.config({ path: path.join(__dirname, "../.env") });

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    // ---- DB ----
    mongoose.set("strictQuery", true);

    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing in .env");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
    });

    console.log("✅ MongoDB connected");

    // ---- APP ----
    const app = express();

    // ---- CORS (global fallback for dev) ----
    app.use((req, res, next) => {
      const origin = req.headers.origin || "*";
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
      res.header(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );
      res.header("Access-Control-Allow-Credentials", "true");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });

    // ---- CORS ----
    if (process.env.NODE_ENV !== "production") {
      // Dev: allow any localhost origin and tools like Postman
      app.use(
        cors({
          origin: true,
          credentials: true,
        })
      );
      app.options(/.*/, cors());
    } else {
      const allowedExactOrigins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "https://marivolt-erp.vercel.app",
      ];

      function isAllowedOrigin(origin) {
        if (!origin) return true; // Postman / server-to-server
        if (allowedExactOrigins.includes(origin)) return true;
        if (origin.endsWith(".vercel.app")) return true; // allow Vercel previews
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
        allowedHeaders: ["Content-Type", "Authorization"],
      };

      app.use(cors(corsOptions));
      app.options(/.*/, cors(corsOptions));
    }

    // ---- MIDDLEWARE ----
    app.use(express.json({ limit: "2mb" }));
    app.use(morgan("dev"));

    // ---- ROUTES ----
    app.use("/api/auth", authRoutes);
    app.use("/api/items", itemRoutes);
    app.use("/api/stock-txns", stockTxnRoutes);
    app.use("/api/purchase", purchaseRoutes);
    app.use("/api/suppliers", supplierRoutes);
    app.use("/api/sales", salesRoutes);
    app.use("/api/bom", bomRoutes);
    app.use("/api/dashboard", dashboardRoutes);
    app.use("/api/price-list", priceListRoutes);
    app.use("/api/logistics", logisticsRoutes);
    app.use("/api/accounts", accountsRoutes);

    // ---- HEALTH ----
    app.get("/api/health", (req, res) => {
      res.json({ ok: true, message: "Marivoltz API running" });
    });

    // ---- 404 ----
    app.use((req, res) => {
      res.status(404).json({ message: "Route not found" });
    });

    // ---- ERROR HANDLER ----
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      console.error("❌ Server error:", err);
      res.status(500).json({ message: err.message || "Internal Server Error" });
    });

    // ---- LISTEN ----
    app.listen(PORT, () => {
      console.log(`✅ API listening on ${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();