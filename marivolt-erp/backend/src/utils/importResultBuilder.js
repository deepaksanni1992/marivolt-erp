export function createEmptyImportResult() {
  return {
    totalRows: 0,
    successRows: 0,
    failedRows: 0,
    duplicateRows: 0,
    rowErrors: [],
  };
}

export function pushRowError(result, index, message) {
  result.failedRows += 1;
  result.rowErrors.push({ index, message });
}

