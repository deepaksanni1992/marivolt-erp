import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

function escCsv(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** columns: { key, header }[] — rows are plain objects */
export function downloadCsv(filename, columns, rows) {
  const header = columns.map((c) => c.header || c.key).join(",");
  const lines = rows.map((row) => columns.map((c) => escCsv(row[c.key])).join(","));
  const blob = new Blob(["\ufeff" + [header, ...lines].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadPdfTable(title, subtitle, columns, rows, fileBaseName) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 30, 30);
  doc.text(title, 14, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  if (subtitle) doc.text(subtitle, 14, 20);
  const head = [columns.map((c) => c.header || c.key)];
  const body = rows.map((row) => columns.map((c) => row[c.key] ?? ""));
  autoTable(doc, {
    startY: subtitle ? 24 : 18,
    head,
    body,
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [28, 28, 28], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [248, 248, 248] },
    margin: { left: 14, right: 14 },
  });
  const name = (fileBaseName || title).replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "");
  doc.save(`${name || "export"}.pdf`);
}
