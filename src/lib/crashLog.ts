// Forwards uncaught frontend errors into the backend's persistent log file
// (tracing target "frontend"), so webview-side breakage survives a crash the
// same way backend errors do. Fire-and-forget everywhere: a failing forward
// must never cascade (the IPC itself may be what broke), so every call
// swallows its own rejection and the browser console remains the fallback.

import { frontendLog } from "./commands";

function send(message: string) {
  frontendLog("error", message).catch(() => {
    /* logging must never throw - console retains the original error */
  });
}

let installed = false;

/** Install window-level capture (uncaught errors + unhandled rejections). */
export function installCrashLogging() {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    const site = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    const stack = e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : "";
    send(`uncaught error: ${e.message}${site}${stack}`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    const text = r instanceof Error ? (r.stack ?? r.message) : String(r);
    send(`unhandled rejection: ${text}`);
  });
}

/** React ErrorBoundary hook: log a render error with its component stack. */
export function logRenderError(error: Error, componentStack: string | null | undefined) {
  const stack = error.stack ?? `${error.name}: ${error.message}`;
  send(`render error: ${stack}${componentStack ? `\ncomponent stack:${componentStack}` : ""}`);
}
