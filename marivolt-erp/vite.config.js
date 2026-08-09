import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:5000",
    changeOrigin: true,
  },
};

/** Prefer platform-injected SHA; never hardcode a release commit in source. */
const appCommit = String(
  process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VITE_APP_COMMIT ||
    process.env.COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    ""
)
  .trim()
  .slice(0, 40);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.VITE_APP_COMMIT": JSON.stringify(appCommit),
  },
  server: {
    // `vite` dev: same-origin `/api/*` → local Express (backend/.env + S3).
    proxy: apiProxy,
  },
  preview: {
    // `vite preview` uses production build but still needs /api → local backend when testing on localhost.
    proxy: apiProxy,
  },
});
