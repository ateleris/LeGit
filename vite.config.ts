import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri ships a separate dev server; pin the port and disable HMR overlay on
// the default port we configure in `tauri.conf.json`.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Don't reload the frontend on backend rebuilds — Tauri restarts.
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: true,
    // Vite 8 bundles with Rolldown and minifies with Oxc (esbuild is gone);
    // the default minifier is exactly that, so no explicit setting.
    outDir: "dist",
    // Tauri loads assets from disk — no network latency, so chunk size has no
    // performance impact. Raise the limit to silence the irrelevant warning.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    // The wdio E2E suite (e2e/) has its own runner; vitest must not collect it.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
