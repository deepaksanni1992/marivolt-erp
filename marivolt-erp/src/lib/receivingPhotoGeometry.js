/**
 * Pure geometry for receiving inspection photos.
 * Shared by the tablet pipeline and tests. Does not decode pixels.
 */

export const RECEIVING_PHOTO_DEFAULTS = Object.freeze({
  maxLongEdge: 1800,
  jpegQuality: 0.8,
  maxBytes: 5 * 1024 * 1024,
  outputMime: "image/jpeg",
});

export function resizeToMaxLongEdge(width, height, maxEdge = RECEIVING_PHOTO_DEFAULTS.maxLongEdge) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const max = Math.max(1, Number(maxEdge) || RECEIVING_PHOTO_DEFAULTS.maxLongEdge);
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0, scale: 1, resized: false };
  const longEdge = Math.max(w, h);
  if (longEdge <= max) return { width: w, height: h, scale: 1, resized: false };
  const scale = max / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
    resized: true,
  };
}

/** EXIF orientations 5–8 swap displayed width/height. */
export function swapDimensionsForExifOrientation(width, height, orientation) {
  const o = Number(orientation) || 1;
  if (o >= 5 && o <= 8) return { width: Number(height) || 0, height: Number(width) || 0 };
  return { width: Number(width) || 0, height: Number(height) || 0 };
}

/**
 * Read JPEG EXIF orientation (1–8). Returns 1 when missing.
 */
export function readJpegExifOrientation(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xe1) {
      const start = offset + 4;
      const view = bytes.subarray(start, start + size - 2);
      return parseExifOrientation(view) || 1;
    }
    if (marker === 0xda) break;
    offset += 2 + size;
  }
  return 1;
}

function parseExifOrientation(view) {
  if (view.length < 12) return 1;
  const isExif =
    view[0] === 0x45 && view[1] === 0x78 && view[2] === 0x69 && view[3] === 0x66 && view[4] === 0 && view[5] === 0;
  if (!isExif) return 1;
  const tiff = 6;
  const little = view[tiff] === 0x49 && view[tiff + 1] === 0x49;
  const read16 = (i) => (little ? view[i] | (view[i + 1] << 8) : (view[i] << 8) | view[i + 1]);
  const read32 = (i) =>
    little
      ? view[i] | (view[i + 1] << 8) | (view[i + 2] << 16) | (view[i + 3] << 24)
      : (view[i] << 24) | (view[i + 1] << 16) | (view[i + 2] << 8) | view[i + 3];
  const ifd = tiff + read32(tiff + 4);
  if (ifd + 2 > view.length) return 1;
  const entries = read16(ifd);
  for (let e = 0; e < entries; e += 1) {
    const p = ifd + 2 + e * 12;
    if (p + 12 > view.length) break;
    if (read16(p) === 0x0112) return read16(p + 8) || 1;
  }
  return 1;
}

export function chooseReceivingImageDecodeStrategy({
  hasCreateImageBitmap = false,
  orientationOptionThrows = false,
  plainBitmapThrows = false,
} = {}) {
  if (hasCreateImageBitmap && !orientationOptionThrows) return "bitmap-oriented";
  if (hasCreateImageBitmap && !plainBitmapThrows) return "bitmap-plain";
  return "image-exif";
}

export function resolveReceivingPhotoConfig(settings = {}) {
  const maxLongEdge = Number(settings.maxLongEdge) > 0 ? Number(settings.maxLongEdge) : RECEIVING_PHOTO_DEFAULTS.maxLongEdge;
  const jpegQuality = Number(settings.jpegQuality);
  const quality =
    Number.isFinite(jpegQuality) && jpegQuality > 0
      ? Math.min(1, Math.max(0.1, jpegQuality))
      : RECEIVING_PHOTO_DEFAULTS.jpegQuality;
  const maxBytes = Number(settings.maxBytes) > 0 ? Number(settings.maxBytes) : RECEIVING_PHOTO_DEFAULTS.maxBytes;
  return {
    maxLongEdge,
    jpegQuality: quality,
    maxBytes,
    outputMime: settings.outputMime || RECEIVING_PHOTO_DEFAULTS.outputMime,
  };
}
