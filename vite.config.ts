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
    fs: {
      // The dev server will otherwise serve ANY file under the project root as
      // a static asset — no auth, and it's bound to the tailnet with --host.
      // Verified before this was added: GET /data/operator.json returned the
      // whole store, and GET /Darams-CRM/darams_crm.db returned the CRM's
      // database. Neither .gitignore nor the Dev browser's DENY set applies
      // here; this is a third, separate door. See OPS-022.
      //
      // Production (`npm run serve`) is unaffected — it serves dist/ only.
      deny: [
        "**/data/**", // Operator's own store
        "**/Darams-CRM/**", // a separate project with real client data
        "**/*.db",
        "**/*.sqlite",
        "**/.env",
        "**/.env.*",
      ],
    },
    // Same-origin in dev, so the app can just call /api/* with no CORS.
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        /*
          `xfwd` is load-bearing for authentication, not a nicety.

          The proxy connects to the API over loopback, so without a forwarded
          address the API cannot tell a phone on the tailnet from the machine
          it is running on — every proxied request looks local. `server/auth.mjs`
          treats bare loopback as "sat at the keyboard" and trusts it, so with
          `xfwd` off, port 5173 becomes a complete bypass: anything on the LAN
          that can reach Vite gets the store, because Vite launders its address
          into loopback on the way through.

          With this on, the API sees the real client in X-Forwarded-For and
          holds it to the same rules as any direct peer. Do not remove it.

          `npm run serve` has no proxy at all and is the safer path when away
          from the machine — see the header of server/auth.mjs.
        */
        xfwd: true,
      },
    },
  },
});
