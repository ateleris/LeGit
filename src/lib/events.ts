import { listen } from "@tauri-apps/api/event";
import type { ConsoleEventPayload, RepoChangedPayload } from "./types";

/** Tauri event channel used by `console_exec`. Matches the constant in
 *  `src-tauri/src/commands/console.rs`. */
export const CONSOLE_OUTPUT_EVENT = "legit://console-output";

/** Subscribe to console output. Returns an unsubscribe function. */
export async function onConsoleOutput(
  handler: (payload: ConsoleEventPayload) => void
): Promise<() => void> {
  const unlisten = await listen<ConsoleEventPayload>(
    CONSOLE_OUTPUT_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}

/** Tauri event channel for filesystem-watcher refreshes. Matches
 *  `REPO_CHANGED_EVENT` in `src-tauri/src/watcher.rs`. */
export const REPO_CHANGED_EVENT = "legit://repo-changed";

/** Subscribe to repo filesystem-change events. Returns an unsubscribe function. */
export async function onRepoChanged(
  handler: (payload: RepoChangedPayload) => void
): Promise<() => void> {
  const unlisten = await listen<RepoChangedPayload>(
    REPO_CHANGED_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}
