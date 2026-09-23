import Modal from "../erp/Modal.jsx";
import {
  DUPLICATE_ARTICLE_BADGE,
  DUPLICATE_ARTICLES_CANCEL_LABEL,
  DUPLICATE_ARTICLES_KEEP_LABEL,
  DUPLICATE_ARTICLES_MODAL_MESSAGE,
  DUPLICATE_ARTICLES_MODAL_TITLE,
  duplicateArticleLineHint,
} from "../../lib/quotationDuplicateLines.js";

function joinList(values) {
  return (values || [])
    .map((v) => (v == null || String(v).trim() === "" ? "—" : String(v).trim()))
    .join("; ");
}

function rowLabel(group) {
  const rows = (group.sourceRowNumbers || []).filter((n) => n != null);
  if (rows.length) return rows.join(", ");
  return (group.occurrences || [])
    .map((o) => o.serialNo)
    .filter(Boolean)
    .join(", ");
}

export function DuplicateArticleBadge({ line, groups, opts }) {
  const hint = duplicateArticleLineHint(line, groups, opts);
  if (!hint) return null;
  return (
    <span
      className="mt-0.5 inline-flex max-w-[11rem] items-center rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900"
      title={hint.detail}
    >
      {DUPLICATE_ARTICLE_BADGE}
    </span>
  );
}

export function DuplicateArticleHintText({ line, groups, opts }) {
  const hint = duplicateArticleLineHint(line, groups, opts);
  if (!hint) return null;
  return <p className="mt-0.5 max-w-[14rem] text-[10px] leading-snug text-amber-800">{hint.detail}</p>;
}

export default function DuplicateArticlesModal({
  open,
  groups = [],
  onKeepAll,
  onCancel,
  keepLabel = DUPLICATE_ARTICLES_KEEP_LABEL,
  cancelLabel = DUPLICATE_ARTICLES_CANCEL_LABEL,
}) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={DUPLICATE_ARTICLES_MODAL_TITLE}
      subtitle={DUPLICATE_ARTICLES_MODAL_MESSAGE}
      wide
    >
      <div className="space-y-4 text-sm text-slate-800">
        <div className="max-h-64 overflow-auto rounded-lg border border-amber-200">
          <table className="w-full text-xs" aria-label="Repeated Articles in the uploaded file">
            <thead className="sticky top-0 bg-amber-50 text-left text-amber-950">
              <tr>
                <th className="px-2 py-2">Rows</th>
                <th className="px-2 py-2">Article</th>
                <th className="px-2 py-2">Part Numbers</th>
                <th className="px-2 py-2">Selected Part Number</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">UOM</th>
                <th className="px-2 py-2">Quantities</th>
                <th className="px-2 py-2 text-right">Total Qty</th>
                <th className="px-2 py-2 text-right">Occurrences</th>
              </tr>
            </thead>
            <tbody>
              {(groups || []).map((g) => (
                <tr key={g.article} className="border-t border-amber-100 align-top">
                  <td className="px-2 py-1.5 font-mono">{rowLabel(g) || "—"}</td>
                  <td className="px-2 py-1.5 font-mono font-semibold">{g.article}</td>
                  <td className="px-2 py-1.5 font-mono">{joinList(g.requestedPartNumbers)}</td>
                  <td className="px-2 py-1.5 font-mono">{joinList(g.selectedPartNumbers)}</td>
                  <td className="px-2 py-1.5">{joinList(g.descriptions)}</td>
                  <td className="px-2 py-1.5">{joinList([...new Set(g.uoms)])}</td>
                  <td className="px-2 py-1.5 tabular-nums">{joinList(g.quantities)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{g.groupedQty}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{g.occurrenceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-600">
          Grouped total quantity is informational only. Each row remains a separate quotation line.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="rounded-xl border px-4 py-2 text-sm" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white"
            onClick={onKeepAll}
            autoFocus
          >
            {keepLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
