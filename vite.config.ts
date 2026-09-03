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
  // NOT "TAURI_": that prefix matches TAURI_SIGNING_PRIVATE_KEY, which
  // release.yml exports into the environment of this very build, and a bare
  // `import.meta.env` reference anywhere would inline it into the bundle.
  // Pinned by viteEnvPrefix.test.ts.
  envPrefix: ["VITE_"],
  build: {
    target: "esnext",
    sourcemap: true,
    // Vite 8 bundles with Rolldown and minifies with Oxc (esbuild is gone);
    // the default minifier is exactly that, so no explicit setting.
    outDir: "dist",
    rollupOptions: {
      output: {
        // Keep function/class names through minification so React component
        // stacks in the persistent crash log (crashLog.ts) show real
        // component names ("at CommitsPanel") instead of mangled ones
        // ("at up") - that log is often the only artifact from a user's
        // machine. Costs a few percent bundle size; irrelevant for a
        // disk-loaded Tauri app.
        keepNames: true,
      },
    },
    // Tauri loads assets from disk — no network latency, so chunk size has no
    // performance impact. Raise the limit (default 1000) above the main
    // chunk's current ~1.4 MB so the irrelevant warning stays silent but a
    // genuine size regression (2 MB+) still surfaces.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    // The wdio E2E suite (e2e/) has its own runner; vitest must not collect it.
    exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
  },
});
