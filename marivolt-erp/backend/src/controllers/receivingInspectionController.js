import multer from "multer";
import { ReceivingInspectionError } from "../utils/receivingInspectionRules.js";
import { ReceivingDraftGrnError } from "../utils/receivingDraftGrnRules.js";
import { ReceivingUnitError } from "../utils/receivingUnitRules.js";
import { AsnError } from "../utils/asnRules.js";
import {
  completeReceivingSession,
  completeReceivingUnit,
  deleteReceivingPhoto,
  getActiveSessionForAsn,
  getAsnReceivingProgress,
  getReceivingClientSettings,
  getReceivingPhotoUrl,
  getReceivingSession,
  getReceivingSummary,
  saveReceivingDraft,
  scanReceivingBarcode,
  startOrResumeReceivingSession,
  uploadReceivingPhoto,
} from "../services/receivingInspectionService.js";
import {
  generateDraftGrnFromReceivingSession,
  getDraftGrnForReceivingSession,
} from "../services/asnReceivingDraftService.js";

function sendError(res, err) {
  if (
    err instanceof ReceivingInspectionError ||
    err instanceof ReceivingUnitError ||
    err instanceof AsnError ||
    err instanceof ReceivingDraftGrnError
  ) {
    return res.status(err.status || err.statusCode || 400).json({
      message: err.message,
      code: err.code,
    });
  }
  const status = Number(err?.statusCode || err?.status) || 500;
  return res.status(status).json({
    message: err.message || "Receiving request failed",
    code: err.code,
  });
}

export const receivingPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

export function receivingPhotoUploadMiddleware(req, res, next) {
  receivingPhotoUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        message: "Photo exceeds maximum upload size.",
        code: "RECEIVING_PHOTO_TOO_LARGE",
      });
    }
    return res.status(400).json({ message: err.message || "Upload error", code: "RECEIVING_PHOTO_UPLOAD" });
  });
}

export async function settings(req, res) {
  res.json(getReceivingClientSettings());
}

export async function startSession(req, res) {
  try {
    const data = await startOrResumeReceivingSession(req, req.body || {});
    res.status(data.created ? 201 : 200).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function getSession(req, res) {
  try {
    const data = await getReceivingSession(req, req.params.sessionId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function getSessionForAsn(req, res) {
  try {
    const data = await getActiveSessionForAsn(req, req.params.asnId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function scan(req, res) {
  try {
    const data = await scanReceivingBarcode(req, req.params.barcode);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function saveDraft(req, res) {
  try {
    const data = await saveReceivingDraft(req, req.params.sessionId, req.params.ruId, req.body || {});
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function completeUnit(req, res) {
  try {
    const data = await completeReceivingUnit(req, req.params.sessionId, req.params.ruId, req.body || {});
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function uploadPhoto(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded. Use form field name \"file\".", code: "RECEIVING_PHOTO_EMPTY" });
    }
    const data = await uploadReceivingPhoto(
      req,
      req.params.sessionId,
      req.params.ruId,
      req.file,
      req.body || {}
    );
    res.status(data.duplicate ? 200 : 201).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function removePhoto(req, res) {
  try {
    const data = await deleteReceivingPhoto(req, req.params.sessionId, req.params.photoId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function photoUrl(req, res) {
  try {
    const data = await getReceivingPhotoUrl(req, req.params.photoId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function summary(req, res) {
  try {
    const data = await getReceivingSummary(req, req.params.sessionId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function asnProgress(req, res) {
  try {
    const data = await getAsnReceivingProgress(req, req.params.asnId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function completeSession(req, res) {
  try {
    const data = await completeReceivingSession(req, req.params.sessionId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function generateSessionGrn(req, res) {
  try {
    const data = await generateDraftGrnFromReceivingSession(req, req.params.sessionId);
    res.status(data.created ? 201 : 200).json(data);
  } catch (err) {
    sendError(res, err);
  }
}

export async function getSessionGrn(req, res) {
  try {
    const data = await getDraftGrnForReceivingSession(req, req.params.sessionId);
    if (!data.grn) {
      return res.status(404).json({
        message: "No Draft GRN for this receiving session",
        code: "RECEIVING_GRN_NOT_FOUND",
      });
    }
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
}
