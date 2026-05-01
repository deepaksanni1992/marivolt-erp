export default function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  wide,
  document,
  expanded = false,
  xlarge = false,
  className = "",
}) {
  if (!open) return null;
  const maxW = xlarge
    ? "max-w-[min(98vw,1920px)]"
    : expanded
      ? "max-w-[96vw]"
      : document
        ? "max-w-6xl"
        : wide
          ? "max-w-4xl"
          : "max-w-lg";
  const pad = xlarge ? "p-6 sm:p-8" : document ? "p-5 sm:p-7" : "p-5";
  const frameAlign = expanded || xlarge ? "items-start py-4 sm:py-6" : "items-center";
  const maxH = expanded || xlarge ? "max-h-[95vh]" : "max-h-[90vh]";
  const minH = xlarge ? "min-h-[min(92vh,900px)]" : "";
  return (
    <div className={`fixed inset-0 z-[60] flex justify-center p-3 sm:p-4 ${frameAlign}`}>
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={[
          `relative ${maxH} w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15`,
          minH,
          maxW,
          pad,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className={xlarge ? "mb-6 flex items-start justify-between gap-4 border-b border-slate-200 pb-5" : "mb-4 flex items-start justify-between gap-2"}>
          <div className="min-w-0">
            <h2 className={xlarge ? "text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl" : "text-lg font-semibold"}>{title}</h2>
            {subtitle ? <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-500">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className={
              xlarge
                ? "shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                : "shrink-0 rounded-lg border px-2 py-1 text-sm hover:bg-gray-50"
            }
            onClick={onClose}
          >
            {xlarge ? "Close ✕" : "×"}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
