import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.OPERATOR_PORT ?? "5174";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Pinned. Without strictPort, a stale dev server on 5173 makes Vite fall
    // through to 5174 — the API's port — and it then proxies /api to itself.
    port: 5173,
    strictPort: true,
    // Same-origin in dev, so the app can just call /api/* with no CORS.
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
