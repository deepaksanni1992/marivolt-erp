/** Frontend build commit — injected at Vite build time (no secrets). */

export function getFrontendCommit() {
  const raw =
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_APP_COMMIT) ||
    "";
  return String(raw || "")
    .trim()
    .slice(0, 40);
}

export function shortCommit(sha) {
  const s = String(sha || "").trim();
  if (!s || s === "unknown") return s || "unknown";
  return s.length > 12 ? s.slice(0, 12) : s;
}
