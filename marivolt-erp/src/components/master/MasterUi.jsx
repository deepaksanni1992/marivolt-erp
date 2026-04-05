export function Modal({ open, title, onClose, children, wide }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={[
          "max-h-[90vh] w-full overflow-y-auto rounded-2xl border bg-white p-6 shadow-lg",
          wide ? "max-w-3xl" : "max-w-lg",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function PaginationBar({ page, limit, total, onPageChange }) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / limit));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
      <span>
        Page {page} of {totalPages} ({total ?? 0} rows)
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          className="rounded-xl border px-3 py-1.5 disabled:opacity-40"
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          className="rounded-xl border px-3 py-1.5 disabled:opacity-40"
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function Field({ label, children, className = "" }) {
  return (
    <div className={className}>
      <label className="text-sm text-gray-600">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {message}
    </div>
  );
}
