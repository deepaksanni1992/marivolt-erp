import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:5000",
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `vite` dev: same-origin `/api/*` → local Express (backend/.env + S3).
    proxy: apiProxy,
  },
  preview: {
    // `vite preview` uses production build but still needs /api → local backend when testing on localhost.
    proxy: apiProxy,
  },
});
