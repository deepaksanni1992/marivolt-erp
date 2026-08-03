/**
 * Pinned WinSW release for Marivolt Print Agent Windows Service.
 * Update this file only when deliberately moving to a new verified release.
 *
 * Source: https://github.com/winsw/winsw/releases/tag/v2.12.0
 * Asset verified via official browser_download_url (HTTP 200) and local SHA-256.
 * Stable v2.12.0 is preferred over non-existent / alpha WinSW 3.x assets.
 */
export const WINSW_RELEASE = Object.freeze({
  version: "v2.12.0",
  /** Official GitHub release asset name (source filename). */
  assetFileName: "WinSW-x64.exe",
  /**
   * Installed / runtime executable name (must match companion XML basename).
   * WinSW requires exe name == xml name without extension.
   */
  runtimeFileName: "MarivoltPrintAgent.exe",
  downloadUrl: "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
  /** SHA-256 of the official WinSW-x64.exe asset (lowercase hex). */
  sha256: "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da",
  /** Published asset size from GitHub Releases API. */
  expectedBytes: 18243033,
  releasePageUrl: "https://github.com/winsw/winsw/releases/tag/v2.12.0",
  checksumSource:
    "Computed SHA-256 of the official GitHub release asset WinSW-x64.exe from winsw/winsw v2.12.0 after HTTP 200 download (size matched GitHub Releases API: 18243033 bytes).",
});

export function winswDownloadErrorMessage(status) {
  const code = status == null || status === "" ? "unknown" : String(status);
  return (
    `Unable to download the WinSW service wrapper. The configured release URL returned HTTP ${code}. ` +
    `No service was installed. Check internet access or update the pinned WinSW release.`
  );
}
