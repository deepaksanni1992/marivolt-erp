import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Reusable searchable document selector (server-backed).
 * Does not load full datasets — calls searchFn with { q, page, limit }.
 */
export default function SearchableDocumentSelect({
  value = "",
  selectedLabel = "",
  selectedSecondary = "",
  onChange,
  searchFn,
  placeholder = "Search…",
  emptyMessage = "No matching documents",
  disabled = false,
  readOnly = false,
  debounceMs = 350,
  minQueryLength = 0,
  pageSize = 25,
  className = "",
  "aria-label": ariaLabel = "Search documents",
  renderItem,
}) {
  const listId = useId();
  const rootRef = useRef(null);
  const reqSeq = useRef(0);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), debounceMs);
    return () => clearTimeout(t);
  }, [q, debounceMs]);

  const canSearch = debouncedQ.length >= minQueryLength;

  const fetchPage = useCallback(
    async (nextPage, { append } = { append: false }) => {
      if (!searchFn || !open) return;
      if (!canSearch && debouncedQ.length > 0) return;
      const seq = ++reqSeq.current;
      setLoading(true);
      setError("");
      try {
        const res = await searchFn({
          q: debouncedQ,
          page: nextPage,
          limit: pageSize,
        });
        if (seq !== reqSeq.current) return;
        const nextItems = res?.items || [];
        setItems((prev) => (append ? [...prev, ...nextItems] : nextItems));
        setHasMore(Boolean(res?.hasMore));
        setTotal(Number(res?.total) || nextItems.length);
        setPage(nextPage);
        setHighlight(0);
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(e?.message || String(e));
        if (!append) setItems([]);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [searchFn, open, canSearch, debouncedQ, pageSize]
  );

  useEffect(() => {
    if (!open) return;
    fetchPage(1, { append: false });
  }, [open, debouncedQ, fetchPage]);

  useEffect(() => {
    function onDocClick(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const displaySelected = useMemo(() => {
    if (!value) return "";
    if (selectedLabel) return selectedLabel;
    const hit = items.find((it) => String(it.id || it._id) === String(value));
    return hit?.primaryLabel || hit?.label || String(value);
  }, [value, selectedLabel, items]);

  function selectItem(item) {
    const id = String(item.id || item._id || "");
    if (!id) return;
    onChange?.(id, item);
    setOpen(false);
    setQ("");
  }

  function clearSelection() {
    if (disabled || readOnly) return;
    onChange?.("", null);
    setQ("");
  }

  function onKeyDown(e) {
    if (disabled || readOnly) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[highlight]) selectItem(items[highlight]);
    }
  }

  return (
    <div ref={rootRef} className={`relative w-full min-w-[260px] max-w-xl ${className}`}>
      <div
        className={`flex items-center gap-1 rounded border bg-white px-2 py-1.5 text-sm ${
          disabled || readOnly ? "bg-slate-50 opacity-70" : ""
        }`}
      >
        <input
          type="text"
          className="min-w-0 flex-1 bg-transparent outline-none"
          placeholder={value && !open ? displaySelected || placeholder : placeholder}
          value={open ? q : value ? displaySelected : q}
          disabled={disabled || readOnly}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          role="combobox"
          onFocus={() => {
            if (!disabled && !readOnly) setOpen(true);
          }}
          onChange={(e) => {
            setQ(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {value && !disabled && !readOnly ? (
          <button
            type="button"
            className="rounded px-1 text-xs text-slate-500 hover:bg-slate-100"
            aria-label="Clear selection"
            onClick={clearSelection}
          >
            ✕
          </button>
        ) : null}
        <button
          type="button"
          className="rounded px-1 text-xs text-slate-500 hover:bg-slate-100"
          aria-label={open ? "Close" : "Open"}
          disabled={disabled || readOnly}
          onClick={() => setOpen((o) => !o)}
        >
          ▾
        </button>
      </div>
      {value && selectedSecondary && !open ? (
        <div className="mt-0.5 truncate text-[11px] text-slate-500">{selectedSecondary}</div>
      ) : null}

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute z-40 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg"
        >
          <div className="sticky top-0 border-b bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
            {loading ? "Searching…" : error ? error : total ? `${total} result${total === 1 ? "" : "s"}` : "Type to search"}
          </div>
          {!loading && !error && items.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500">{emptyMessage}</div>
          ) : null}
          {items.map((item, idx) => {
            const id = String(item.id || item._id || idx);
            const active = idx === highlight;
            return (
              <button
                key={id}
                type="button"
                role="option"
                aria-selected={String(value) === id}
                className={`block w-full border-b border-slate-50 px-3 py-2 text-left text-xs hover:bg-slate-50 ${
                  active ? "bg-slate-100" : ""
                }`}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => selectItem(item)}
              >
                {renderItem ? (
                  renderItem(item)
                ) : (
                  <>
                    <div className="font-semibold text-slate-900">
                      <span className="font-mono">{item.primaryLabel || item.label}</span>
                      {item.status ? (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                          {item.status}
                        </span>
                      ) : null}
                    </div>
                    {item.secondaryLabel ? (
                      <div className="mt-0.5 text-[11px] text-slate-600">{item.secondaryLabel}</div>
                    ) : null}
                  </>
                )}
              </button>
            );
          })}
          {hasMore ? (
            <button
              type="button"
              className="w-full px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50"
              disabled={loading}
              onClick={() => fetchPage(page + 1, { append: true })}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
