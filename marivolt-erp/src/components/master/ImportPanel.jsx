import { useState } from "react";
import { parseSpreadsheetFile } from "../../lib/spreadsheet.js";
import { Field, ErrorBanner } from "./MasterUi.jsx";

export default function ImportPanel({
  title = "Bulk import (.xlsx / .xls / .csv)",
  onImport,
  hint,
}) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);

  async function run(e) {
    e.preventDefault();
    setErr("");
    setResult(null);
    if (!file) {
      setErr("Choose a file first.");
      return;
    }
    setBusy(true);
    try {
      const rows = await parseSpreadsheetFile(file);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("No rows found in the file.");
      }
      const r = await onImport(rows);
      setResult(r);
    } catch (e) {
      setErr(e.message || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-gray-600">{hint}</p>}
      <form onSubmit={run} className="mt-4 space-y-3">
        <Field label="Spreadsheet file">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm"
          />
        </Field>
        {err && <ErrorBanner message={err} />}
        {result && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div>Total rows: {result.totalRows}</div>
            <div>Imported: {result.successRows}</div>
            <div>Duplicates (file / DB): {result.duplicateRows}</div>
            <div>Failed: {result.failedRows}</div>
            {Array.isArray(result.rowErrors) && result.rowErrors.length > 0 && (
              <ul className="mt-2 max-h-32 list-inside list-disc overflow-y-auto text-xs">
                {result.rowErrors.slice(0, 20).map((re, i) => (
                  <li key={i}>
                    Row {re.index + 1}: {re.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? "Importing…" : "Run import"}
        </button>
      </form>
    </div>
  );
}
