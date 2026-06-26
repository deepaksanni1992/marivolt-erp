import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

function userInitials(user) {
  const name = String(user?.name || "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const email = String(user?.email || "").trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return "U";
}

export default function UserMenu() {
  const nav = useNavigate();
  const { auth, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    function onEsc(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  function go(path) {
    setOpen(false);
    nav(path);
  }

  function onLogout() {
    setOpen(false);
    logout();
    nav("/login");
  }

  const user = auth?.user;
  const label = user?.name || user?.email || user?.username || "User";

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700 ring-2 ring-transparent hover:bg-gray-300 focus:outline-none focus:ring-gray-400"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
      >
        {userInitials(user)}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2.5 text-left text-sm text-gray-800 hover:bg-gray-50"
            onClick={() => go("/profile")}
          >
            My Profile
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2.5 text-left text-sm text-gray-800 hover:bg-gray-50"
            onClick={() => go("/profile/security")}
          >
            Security
          </button>
          <div className="my-1 border-t border-gray-100" />
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2.5 text-left text-sm text-gray-800 hover:bg-gray-50"
            onClick={onLogout}
          >
            Logout
          </button>
        </div>
      ) : null}
    </div>
  );
}
