import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles/theme.css";
import "./styles/global.css";
import "dockview-react/dist/styles/dockview.css";

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Re-read git state when the window regains focus, so changes made in a
      // terminal/editor while the app was in the background show up. staleTime
      // throttles this — only queries older than their staleTime actually refetch.
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
