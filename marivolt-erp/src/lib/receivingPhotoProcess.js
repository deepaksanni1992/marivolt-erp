import {
  chooseReceivingImageDecodeStrategy,
  readJpegExifOrientation,
  resolveReceivingPhotoConfig,
  resizeToMaxLongEdge,
  swapDimensionsForExifOrientation,
} from "./receivingPhotoGeometry.js";

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("Could not compress photo"));
        else resolve(blob);
      },
      mime,
      quality
    );
  });
}

async function blobToArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Decode, honor EXIF orientation, resize long edge, JPEG-compress.
 * Never enlarges. Used on the tablet before S3 upload.
 */
export async function processReceivingPhoto(file, settings = {}) {
  const cfg = resolveReceivingPhotoConfig(settings);
  const input = file instanceof Blob ? file : new Blob([file]);
  const buffer = await blobToArrayBuffer(input);
  const orientation = readJpegExifOrientation(buffer);

  let bitmap = null;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let oriented = false;
  const hasCreateImageBitmap = typeof createImageBitmap === "function";
  let orientationOptionThrows = true;
  let plainBitmapThrows = true;

  if (hasCreateImageBitmap) {
    try {
      bitmap = await createImageBitmap(input, { imageOrientation: "from-image" });
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
      oriented = true;
      orientationOptionThrows = false;
      plainBitmapThrows = false;
    } catch {
      orientationOptionThrows = true;
      try {
        bitmap = await createImageBitmap(input);
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
        oriented = false;
        plainBitmapThrows = false;
      } catch {
        bitmap = null;
        plainBitmapThrows = true;
      }
    }
  }

  const decodePath = chooseReceivingImageDecodeStrategy({
    hasCreateImageBitmap,
    orientationOptionThrows,
    plainBitmapThrows,
  });

  if (!bitmap) {
    const url = URL.createObjectURL(input);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not read photo"));
        el.src = url;
      });
      const swapped = swapDimensionsForExifOrientation(img.naturalWidth, img.naturalHeight, orientation);
      sourceWidth = swapped.width;
      sourceHeight = swapped.height;
      const canvas0 = document.createElement("canvas");
      canvas0.width = sourceWidth;
      canvas0.height = sourceHeight;
      const ctx0 = canvas0.getContext("2d");
      drawOrientedImage(ctx0, img, orientation, img.naturalWidth, img.naturalHeight);
      bitmap = canvas0;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const sized = resizeToMaxLongEdge(sourceWidth, sourceHeight, cfg.maxLongEdge);
  const canvas = document.createElement("canvas");
  canvas.width = sized.width;
  canvas.height = sized.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, sized.width, sized.height);
  if (typeof bitmap.close === "function") bitmap.close();

  let blob = await canvasToBlob(canvas, cfg.outputMime, cfg.jpegQuality);
  let quality = cfg.jpegQuality;
  while (blob.size > cfg.maxBytes && quality > 0.45) {
    quality = Math.max(0.45, quality - 0.1);
    blob = await canvasToBlob(canvas, cfg.outputMime, quality);
  }
  if (blob.size > cfg.maxBytes) {
    const err = new Error(
      `Photo is still too large after compression (${Math.round(blob.size / 1024)} KB). Capture again from a bit further away.`
    );
    err.code = "RECEIVING_PHOTO_TOO_LARGE";
    throw err;
  }

  const previewUrl = URL.createObjectURL(blob);
  return {
    blob,
    previewUrl,
    width: sized.width,
    height: sized.height,
    sizeBytes: blob.size,
    mimeType: blob.type || cfg.outputMime,
    resized: sized.resized,
    orientation,
    oriented,
    jpegQuality: quality,
    decodePath,
  };
}

function drawOrientedImage(ctx, img, orientation, width, height) {
  const o = Number(orientation) || 1;
  switch (o) {
    case 2:
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      break;
    case 3:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 4:
      ctx.translate(0, height);
      ctx.scale(1, -1);
      break;
    case 5:
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(0, -height);
      break;
    case 7:
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(width, -height);
      ctx.scale(-1, 1);
      break;
    case 8:
      ctx.rotate(-0.5 * Math.PI);
      ctx.translate(-width, 0);
      break;
    default:
      break;
  }
  ctx.drawImage(img, 0, 0);
}

export { chooseReceivingImageDecodeStrategy, resolveReceivingPhotoConfig, resizeToMaxLongEdge };
