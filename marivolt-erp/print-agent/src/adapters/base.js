/**
 * Print transport adapter interface.
 * Phase 1: Windows raw spooler. Future: TCP 9100.
 */
export class PrintTransportAdapter {
  /** @returns {Promise<void>} */
  async printRaw(_buffer, _printerName) {
    throw new Error("printRaw not implemented");
  }
}
