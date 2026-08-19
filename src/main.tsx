import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { initWindowFocusTracking } from "./lib/windowFocus";
// Vendor styles first: global.css overrides dockview's theme variables at
// equal specificity, so cascade order decides who wins (cssImportOrder.test.ts).
import "dockview-react/dist/styles/dockview.css";
import "./styles/theme.css";
import "./styles/global.css";

// Suppress the webview's native context menu (Inspect, Save as…) everywhere.
// Our own context menus open from their React onContextMenu handlers, which set
// state independently of the native menu, so blanket-preventing the default here
// leaves only the entries we add. Allow it inside editable fields so text inputs
// keep their cut/copy/paste menu.
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

// Focus comes from Tauri's window events (not the WebView's visibility, which
// misses alt-tab); it gates watcher refetches and drives the focus catch-up.
initWindowFocusTracking();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Re-read git state when the window regains focus, so changes made in a
      // terminal/editor while the app was in the background show up. This is
      // also the catch-up for watcher events gated while unfocused (they only
      // mark queries stale - see useRepoChangeListener); staleTime throttles
      // the rest — only queries older than their staleTime refetch.
      refetchOnWindowFocus: true,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
