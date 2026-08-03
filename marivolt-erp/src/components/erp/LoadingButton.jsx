import { Loader2 } from "lucide-react";

/**
 * Reusable action button with loading spinner + disabled state.
 * Does not change business logic — callers pass loading / loadingText.
 */
export default function LoadingButton({
  type = "button",
  loading = false,
  disabled = false,
  loadingText,
  children,
  className = "",
  variant = "primary",
  onClick,
  "aria-label": ariaLabel,
  ...rest
}) {
  const base =
    "inline-flex min-h-[2.25rem] items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-slate-900 text-white hover:bg-slate-800",
    secondary: "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    success: "bg-emerald-700 text-white hover:bg-emerald-800",
    ghost: "border border-transparent text-slate-700 hover:bg-slate-100",
  };
  const cls = `${base} ${variants[variant] || variants.primary} ${className}`.trim();

  const handleClick = (e) => {
    if (loading || disabled) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-disabled={disabled || loading || undefined}
      aria-label={ariaLabel}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
      <span aria-live={loading ? "polite" : undefined}>{loading ? loadingText || children : children}</span>
    </button>
  );
}
