import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// During dev we proxy the backend connector (/app) to the local server so the
// web app talks to the same-origin paths it will use in production.
const SERVER = process.env.SERVER_URL ?? "http://localhost:8080";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/app": { target: SERVER, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
  // Olm is a CommonJS emscripten module; let Vite pre-bundle it.
  optimizeDeps: { include: ["@matrix-org/olm"] },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      workbox: {
        // Never let the SPA fallback swallow the backend connector or socket.
        navigateFallbackDenylist: [/^\/app/],
        globPatterns: ["**/*.{js,css,html,svg,wasm,png}"],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: "FastMessage",
        short_name: "FastMessage",
        description: "Self-hosted, end-to-end-encrypted messaging.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
  ],
});
