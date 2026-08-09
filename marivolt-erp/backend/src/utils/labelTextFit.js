/**
 * Deterministic text fitting for packing labels (100×50 mm Description row).
 * Pure utility — no I/O.
 */

function t(v) {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Approximate printable character width for TSPL font "0" at multiplier 1.
 * Empirically ~dpi/25.4 * 1.2 dots per char at 203 DPI baseline; callers pass maxWidth in chars or dots.
 * When maxWidthChars is provided we wrap by character count (stable across DPI).
 */
export function wrapWordsToLines(text, maxWidthChars) {
  const raw = t(text);
  if (!raw) return [];
  const max = Math.max(4, Math.floor(Number(maxWidthChars) || 40));
  const words = raw.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) {
      cur = next;
      continue;
    }
    if (cur) lines.push(cur);
    if (w.length <= max) {
      cur = w;
    } else {
      // Hard-break long tokens
      let rest = w;
      while (rest.length > max) {
        lines.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      cur = rest;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Fit wrapped text into a box by reducing font size when needed.
 * Overflow is never silent: `truncated` / `overflow` is true when text cannot fully fit
 * at min font within maxLines (visible lines may include an ellipsis marker).
 *
 * @param {{
 *   text: string,
 *   maxWidthChars?: number,
 *   maxLines?: number,
 *   preferredFontSize?: number,
 *   minFontSize?: number,
 *   lineSpacing?: number,
 * }} opts
 * @returns {{
 *   fontSize: number,
 *   lines: string[],
 *   lineHeight: number,
 *   requiredHeight: number,
 *   truncated: boolean,
 *   overflow: boolean,
 *   fullLineCount: number,
 * }}
 */
export function fitWrappedText({
  text,
  maxWidthChars = 42,
  maxLines = 6,
  preferredFontSize = 7,
  minFontSize = 5,
  lineSpacing = 1.15,
} = {}) {
  const preferred = Math.max(minFontSize, Number(preferredFontSize) || 7);
  const min = Math.max(4, Number(minFontSize) || 5);
  const spacing = Math.max(1, Number(lineSpacing) || 1.15);
  const maxL = Math.max(1, Math.floor(Number(maxLines) || 6));

  let fontSize = preferred;
  let lines = wrapWordsToLines(text, maxWidthChars);
  let truncated = false;

  // Prefer wrapping within 3 lines at preferred size by tightening width slightly when needed.
  if (lines.length > 3 && fontSize >= min) {
    const tighter = Math.max(24, Math.floor(maxWidthChars * 0.92));
    const retry = wrapWordsToLines(text, tighter);
    if (retry.length < lines.length) lines = retry;
  }

  while (lines.length > maxL && fontSize > min) {
    fontSize -= 0.5;
    // Smaller font ≈ more chars per line (rough inverse of size)
    const widthBoost = Math.round(maxWidthChars * (preferred / fontSize));
    lines = wrapWordsToLines(text, widthBoost);
  }

  const fullLineCount = lines.length;
  if (lines.length > maxL) {
    truncated = true;
    lines = lines.slice(0, maxL);
    const last = lines[lines.length - 1] || "";
    if (last.length > 3) {
      lines[lines.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
    }
  }

  const lineHeight = fontSize * spacing;
  const requiredHeight = Math.max(lineHeight, lines.length * lineHeight);

  return {
    fontSize,
    lines,
    lineHeight,
    requiredHeight,
    truncated,
    overflow: truncated,
    fullLineCount,
  };
}

/**
 * Packing-label Description fit using the same constraints as TSPL layout.
 * Callers use this for preview overflow warnings and print confirmation gates.
 */
export function fitPackingDescription(text, opts = {}) {
  const preferredFontSize = Number(opts.preferredFontSize) || 7;
  const minFontSize = Number(opts.minFontSize) || 5;
  const maxWidthChars = Number(opts.maxWidthChars) || 36;
  const maxLines = Number(opts.maxLines) || 5;

  let fit = fitWrappedText({
    text,
    maxWidthChars,
    maxLines,
    preferredFontSize,
    minFontSize,
    lineSpacing: Number(opts.lineSpacing) || 1.2,
  });

  // Mirror TSPL second-pass shrink when the description block would crowd QTY.
  if (opts.availableMaxLines != null && Number(opts.availableMaxLines) < maxLines) {
    const availLines = Math.max(2, Math.floor(Number(opts.availableMaxLines)));
    if (fit.fullLineCount > availLines || fit.truncated) {
      fit = fitWrappedText({
        text,
        maxWidthChars: Math.max(maxWidthChars, 40),
        maxLines: availLines,
        preferredFontSize: Math.min(preferredFontSize, 6),
        minFontSize,
        lineSpacing: 1.1,
      });
    }
  }

  return {
    ...fit,
    descriptionTruncated: fit.truncated === true,
  };
}

/**
 * Format packing label quantity display: "5 of 9"
 */
export function formatPackingQtyDisplay(labelQty, totalQty) {
  const n = Math.max(0, Math.floor(Number(labelQty) || 0));
  const d = Math.max(0, Math.floor(Number(totalQty) || 0));
  return `${n} of ${d}`;
}
