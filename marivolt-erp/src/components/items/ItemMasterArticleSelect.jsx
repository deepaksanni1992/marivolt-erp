import { useEffect, useMemo, useRef, useState } from "react";
import { apiGetWithQuery } from "../../lib/api.js";

const NOT_FOUND =
  "Article not found in Item Master. Ask an authorized Admin/Super Admin to create or import it before continuing.";

function labelFor(item) {
  const bits = [
    item.article,
    item.itemName || item.description,
    item.brand || item.engine,
    item.model,
    item.config,
    item.uom,
    item.partNumber || item.spn,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Active, company-scoped Item Master selector. Typed text is never treated as a
 * valid Article until the user picks a search result.
 */
export default function ItemMasterArticleSelect({
  value = "",
  onSelect,
  className = "",
  disabled = false,
  placeholder = "Search Item Master…",
}) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState(Boolean(value));
  const boxRef = useRef(null);

  useEffect(() => {
    setQuery(value || "");
    setPicked(Boolean(value));
  }, [value]);

  useEffect(() => {
    function onDoc(e) {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await apiGetWithQuery("/items", {
          page: 1,
          limit: 20,
          status: "Active",
          search: query || undefined,
        });
        setRows(data.items || []);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query, open]);

  const showHint = useMemo(() => open && !loading && query && !rows.length, [open, loading, query, rows.length]);

  function choose(item) {
    setQuery(item.article);
    setPicked(true);
    setOpen(false);
    onSelect?.(item);
  }

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <input
        className="w-full rounded-xl border border-gray-200 px-2 py-1.5 text-[11px] font-mono focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value.toUpperCase());
          setPicked(false);
          setOpen(true);
          if (!e.target.value) onSelect?.(null);
        }}
        onBlur={() => {
          if (!picked) {
            setQuery(value || "");
          }
        }}
      />
      {open && !disabled ? (
        <div className="absolute z-30 mt-1 max-h-64 w-[min(32rem,70vw)] overflow-auto rounded-xl border bg-white text-left text-xs shadow-lg">
          {loading ? <div className="px-3 py-2 text-slate-500">Searching…</div> : null}
          {showHint ? <div className="px-3 py-2 text-amber-800">{NOT_FOUND}</div> : null}
          {(rows || []).map((item) => (
            <button
              type="button"
              key={item._id || item.article}
              className="block w-full px-3 py-2 text-left hover:bg-slate-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(item)}
            >
              <div className="font-mono font-semibold">{item.article}</div>
              <div className="text-[11px] text-slate-600">{labelFor(item)}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const ITEM_MASTER_NOT_FOUND_MESSAGE = NOT_FOUND;
