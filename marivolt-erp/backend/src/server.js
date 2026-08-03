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
import supplierProformaRoutes from "./routes/supplierProformaRoutes.js";
import quotationRoutes from "./routes/quotationRoutes.js";
import documentSnapshotRoutes from "./routes/documentSnapshotRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import grnRoutes from "./routes/grnRoutes.js";
import stockRoutes from "./routes/stockRoutes.js";
import storeRoutes from "./routes/storeRoutes.js";
import logisticsRoutes from "./routes/logisticsRoutes.js";
import accountsRoutes from "./routes/accountsRoutes.js";
import purchaseInvoicesRoutes from "./routes/purchaseInvoicesRoutes.js";
import supplierPaymentsPublicRoutes from "./routes/supplierPaymentsPublicRoutes.js";
import supplierLedgerPublicRoutes from "./routes/supplierLedgerPublicRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import bomRoutes from "./routes/bomRoutes.js";
import kittingRoutes from "./routes/kittingRoutes.js";
import dekittingRoutes from "./routes/dekittingRoutes.js";
import supplierRoutes from "./routes/supplierRoutes.js";
import purchaseReturnRoutes from "./routes/purchaseReturnRoutes.js";
import documentRoutes from "./routes/documentRoutes.js";
import paymentReceiptRoutes from "./routes/paymentReceiptRoutes.js";
import auditRoutes from "./routes/auditRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import communicationRoutes from "./routes/communicationRoutes.js";
import packingRoutes from "./routes/packingRoutes.js";
import articleConversionRoutes from "./routes/articleConversionRoutes.js";
import dispatchRoutes from "./routes/dispatchRoutes.js";
import reportPdfRoutes from "./routes/reportPdfRoutes.js";
import customsRoutes from "./routes/customsRoutes.js";
import labelRoutes from "./routes/labelRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import traceabilityRoutes from "./routes/traceabilityRoutes.js";
import dataHealthRoutes from "./routes/dataHealthRoutes.js";
import { isCustomsEnabled } from "./config/customsConfig.js";
import { ensureSearchIndexes } from "./config/searchIndexes.js";
import { isS3Configured } from "./config/s3.js";
import { createCorsOriginDelegate } from "./utils/corsAllowlist.js";
import { shutdownBrowser } from "./services/pdfBrowserManager.js";

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

    ensureSearchIndexes().catch((err) => {
      console.warn("Search index ensure skipped:", err?.message || err);
    });

    const app = express();

    // Render / reverse-proxy: trust X-Forwarded-For for rate limiting.
    app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

    const corsOptions = {
      origin: createCorsOriginDelegate(),
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
    app.use("/api/supplier-proformas", supplierProformaRoutes);
    app.use("/api/purchase-returns", purchaseReturnRoutes);
    app.use("/api/quotations", quotationRoutes);
    app.use("/api/document-snapshot", documentSnapshotRoutes);
    app.use("/api/inventory", inventoryRoutes);
    app.use("/api/grn", grnRoutes);
    app.use("/api/stock", stockRoutes);
    app.use("/api/store", storeRoutes);
    app.use("/api/shipments", logisticsRoutes);
    app.use("/api/accounts", accountsRoutes);
    app.use("/api/purchase-invoices", purchaseInvoicesRoutes);
    app.use("/api/supplier-payments", supplierPaymentsPublicRoutes);
    app.use("/api/supplier-ledger", supplierLedgerPublicRoutes);
    app.use("/api/sales", salesRoutes);
    app.use("/api/boms", bomRoutes);
    app.use("/api/kitting", kittingRoutes);
    app.use("/api/dekitting", dekittingRoutes);
    app.use("/api/documents", documentRoutes);
    app.use("/api/payment-receipts", paymentReceiptRoutes);
    app.use("/api/audit-logs", auditRoutes);
    app.use("/api/admin", adminRoutes);
    app.use("/api/analytics", analyticsRoutes);
    app.use("/api/communication", communicationRoutes);
    app.use("/api/packing", packingRoutes);
    app.use("/api/article-conversions", articleConversionRoutes);
    app.use("/api/dispatch", dispatchRoutes);
    app.use("/api/reports", reportPdfRoutes);
    app.use("/api/customs", customsRoutes);
    app.use("/api/labels", labelRoutes);
    app.use("/api/search", searchRoutes);
    app.use("/api/traceability", traceabilityRoutes);
    app.use("/api/data-health", dataHealthRoutes);

    console.log("Customs module:", isCustomsEnabled() ? "enabled (CUSTOMS_ENABLED=true)" : "disabled");

    app.get("/api/health", (req, res) => {
      res.json({ ok: true, message: "Marivoltz API running" });
    });

    app.use((req, res) => {
      res.status(404).json({ message: "Not found" });
    });

    app.listen(PORT, () => {
      console.log(`✅ API listening on port ${PORT}`);
    });

    const gracefulPdfShutdown = () => {
      shutdownBrowser().catch(() => {});
    };
    process.once("SIGTERM", gracefulPdfShutdown);
    process.once("SIGINT", gracefulPdfShutdown);
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
