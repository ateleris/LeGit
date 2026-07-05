import { listen } from "@tauri-apps/api/event";
import type {
  ConsoleEventPayload,
  GitInvocation,
  RemoteProgressPayload,
  RepoChangedPayload,
} from "./types";

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

/** Tauri event channel for remote transfer progress (fetch/pull/push/clone).
 *  Matches `REMOTE_PROGRESS_EVENT` in `src-tauri/src/lib.rs`. */
export const REMOTE_PROGRESS_EVENT = "legit://remote-progress";

/** Subscribe to remote-progress events. Returns an unsubscribe function. */
export async function onRemoteProgress(
  handler: (payload: RemoteProgressPayload) => void
): Promise<() => void> {
  const unlisten = await listen<RemoteProgressPayload>(
    REMOTE_PROGRESS_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}

/** Tauri event channel asking the UI to show a git credential prompt.
 *  Matches `CREDENTIAL_REQUEST_EVENT` in `src-tauri/src/credentials.rs`. */
export const CREDENTIAL_REQUEST_EVENT = "legit://credential-request";

/** Tauri event channel telling the UI a pending credential prompt is moot
 *  (git went away / timed out). Matches `CREDENTIAL_CLOSED_EVENT`. */
export const CREDENTIAL_CLOSED_EVENT = "legit://credential-closed";

export interface CredentialRequestPayload {
  request_id: string;
  protocol: string;
  host: string;
  /** Username git already knows (from the URL), if any. */
  username: string | null;
}

/** Subscribe to credential-prompt requests. Returns an unsubscribe function. */
export async function onCredentialRequest(
  handler: (payload: CredentialRequestPayload) => void
): Promise<() => void> {
  const unlisten = await listen<CredentialRequestPayload>(
    CREDENTIAL_REQUEST_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}

/** Subscribe to credential-prompt dismissals. Returns an unsubscribe function. */
export async function onCredentialClosed(
  handler: (payload: { request_id: string }) => void
): Promise<() => void> {
  const unlisten = await listen<{ request_id: string }>(
    CREDENTIAL_CLOSED_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}

/** Tauri event channel for the git command log. Matches the event name emitted
 *  by the invocation observer in `src-tauri/src/lib.rs`. */
export const GIT_INVOCATION_EVENT = "git_invocation";

/** Subscribe to git-invocation events. Returns an unsubscribe function. */
export async function onGitInvocation(
  handler: (payload: GitInvocation) => void
): Promise<() => void> {
  const unlisten = await listen<GitInvocation>(
    GIT_INVOCATION_EVENT,
    (event) => handler(event.payload)
  );
  return unlisten;
}
