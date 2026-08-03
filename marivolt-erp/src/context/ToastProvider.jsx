import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";
import {
  registerToastHandler,
  registerConfirmHandler,
  notify,
  confirmDialog,
} from "../lib/notifications.js";
import { safeNotifyText } from "../lib/apiError.js";

const ToastContext = createContext({
  notify,
  confirm: confirmDialog,
});

const TYPE_STYLE = {
  success: {
    wrap: "border-emerald-200 bg-emerald-50 text-emerald-950",
    icon: "text-emerald-600",
    Icon: CheckCircle2,
    label: "Success",
  },
  error: {
    wrap: "border-rose-200 bg-rose-50 text-rose-950",
    icon: "text-rose-600",
    Icon: XCircle,
    label: "Error",
  },
  warning: {
    wrap: "border-amber-200 bg-amber-50 text-amber-950",
    icon: "text-amber-600",
    Icon: AlertTriangle,
    label: "Warning",
  },
  info: {
    wrap: "border-sky-200 bg-sky-50 text-sky-950",
    icon: "text-sky-600",
    Icon: Info,
    label: "Information",
  },
};

const MAX_VISIBLE = 5;

function ToastItem({ toast, onDismiss }) {
  const cfg = TYPE_STYLE[toast.type] || TYPE_STYLE.info;
  const Icon = cfg.Icon;
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return undefined;
    const t = setTimeout(() => setLeaving(true), toast.duration);
    return () => clearTimeout(t);
  }, [toast.duration, toast.id]);

  useEffect(() => {
    if (!leaving) return undefined;
    const t = setTimeout(() => onDismiss(toast.id), 220);
    return () => clearTimeout(t);
  }, [leaving, onDismiss, toast.id]);

  return (
    <div
      role="status"
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={[
        "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg shadow-slate-900/10",
        cfg.wrap,
        leaving ? "erp-toast-out" : "erp-toast-in",
      ].join(" ")}
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.icon}`} aria-hidden />
      <div className="min-w-0 flex-1 break-words">
        {toast.title ? (
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">{toast.title}</p>
        ) : null}
        <p className="text-sm font-medium leading-snug">{toast.message}</p>
        <span className="sr-only">{cfg.label}</span>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-md p-1 opacity-60 hover:bg-black/5 hover:opacity-100"
        aria-label="Dismiss notification"
        onClick={() => setLeaving(true)}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function ToastViewport({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed right-3 top-3 z-[200] flex max-h-[min(100vh-1.5rem,100dvh-1.5rem)] w-[min(100vw-1.5rem,24rem)] flex-col gap-2 overflow-y-auto sm:right-4 sm:top-4"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ConfirmHost({ request, onResolve }) {
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  const resolved = useRef(false);

  const finish = useCallback(
    (value) => {
      if (resolved.current) return;
      resolved.current = true;
      onResolve(Boolean(value));
    },
    [onResolve]
  );

  useEffect(() => {
    if (!request) return undefined;
    resolved.current = false;
    previouslyFocused.current = document.activeElement;

    const node = dialogRef.current;
    const focusables = () => {
      if (!node) return [];
      return Array.from(
        node.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el instanceof HTMLElement && !el.hasAttribute("disabled"));
    };

    const preferred = request.danger
      ? node?.querySelector("[data-confirm-cancel]")
      : node?.querySelector("[data-confirm-ok]");
    (preferred instanceof HTMLElement ? preferred : focusables()[0])?.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      const prev = previouslyFocused.current;
      if (prev instanceof HTMLElement) {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [request, finish]);

  if (!request) return null;
  const {
    title = "Confirm",
    message = "Are you sure?",
    confirmLabel = "Yes",
    cancelLabel = "No",
    danger = false,
  } = request;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Cancel confirmation"
        tabIndex={-1}
        onClick={() => finish(false)}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="erp-confirm-title"
        aria-describedby="erp-confirm-desc"
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/20"
      >
        <h2 id="erp-confirm-title" className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        <p id="erp-confirm-desc" className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
          {message}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-confirm-cancel
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => finish(false)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-confirm-ok
            className={
              danger
                ? "rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                : "rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            }
            onClick={() => finish(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [visible, setVisible] = useState([]);
  const queueRef = useRef([]);
  const [confirmReq, setConfirmReq] = useState(null);
  const confirmResolver = useRef(null);
  const confirmSettled = useRef(false);

  const promoteQueue = useCallback(() => {
    setVisible((prev) => {
      if (prev.length >= MAX_VISIBLE) return prev;
      const next = [...prev];
      while (next.length < MAX_VISIBLE && queueRef.current.length) {
        next.push(queueRef.current.shift());
      }
      return next;
    });
  }, []);

  const dismiss = useCallback(
    (id) => {
      setVisible((prev) => prev.filter((t) => t.id !== id));
      // Promote queued toasts after state flush
      queueMicrotask(() => promoteQueue());
    },
    [promoteQueue]
  );

  useEffect(() => {
    return registerToastHandler((toast) => {
      setVisible((prev) => {
        let working = prev;
        if (toast.replace && toast.dedupeKey) {
          working = prev.filter((t) => t.dedupeKey !== toast.dedupeKey);
          queueRef.current = queueRef.current.filter((t) => t.dedupeKey !== toast.dedupeKey);
        }
        if (working.length < MAX_VISIBLE) {
          return [...working, toast];
        }
        queueRef.current.push(toast);
        if (queueRef.current.length > 40) queueRef.current.shift();
        return working;
      });
    });
  }, []);

  useEffect(() => {
    return registerConfirmHandler((opts) => {
      return new Promise((resolve) => {
        if (confirmResolver.current) {
          confirmResolver.current(false);
        }
        confirmSettled.current = false;
        confirmResolver.current = resolve;
        setConfirmReq(opts || {});
      });
    });
  }, []);

  /**
   * Temporary compatibility shim: leftover window.alert → warning toast.
   * Prefer notify.* at call sites. Installed once per provider mount; cleaned up on unmount.
   * Does not call the native alert recursively.
   */
  useEffect(() => {
    const original = window.alert.bind(window);
    window.alert = (msg) => {
      notify.warning(safeNotifyText(msg, "Alert"), {
        dedupeKey: `alert:${safeNotifyText(msg, "Alert")}`,
        dedupeWindowMs: 2000,
      });
    };
    return () => {
      window.alert = original;
    };
  }, []);

  const resolveConfirm = useCallback((value) => {
    if (confirmSettled.current) return;
    confirmSettled.current = true;
    const resolver = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmReq(null);
    if (resolver) resolver(Boolean(value));
  }, []);

  const value = useMemo(
    () => ({
      notify,
      confirm: confirmDialog,
      success: notify.success,
      error: notify.error,
      warning: notify.warning,
      info: notify.info,
    }),
    []
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={visible} onDismiss={dismiss} />
      <ConfirmHost request={confirmReq} onResolve={resolveConfirm} />
    </ToastContext.Provider>
  );
}

// Companion hook — intentional co-export with ToastProvider
// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastContext);
}

export default ToastProvider;
