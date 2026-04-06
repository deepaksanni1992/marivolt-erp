export default function Modal({ open, title, onClose, children, wide, document }) {
  if (!open) return null;
  const maxW = document ? "max-w-6xl" : wide ? "max-w-4xl" : "max-w-lg";
  const pad = document ? "p-5 sm:p-7" : "p-5";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={[
          "relative max-h-[90vh] w-full overflow-y-auto rounded-2xl border bg-white shadow-lg",
          maxW,
          pad,
        ].join(" ")}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            className="rounded-lg border px-2 py-1 text-sm hover:bg-gray-50"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
