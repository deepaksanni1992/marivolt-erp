import { Router } from "express";
import express from "express";
import { requireAuth, requireCompanyContext } from "../middleware/auth.js";
import { postReportPdf } from "../controllers/reportPdfController.js";

const router = Router();

router.post(
  "/pdf",
  express.json({ limit: "12mb" }),
  requireAuth,
  requireCompanyContext,
  postReportPdf,
);

export default router;
